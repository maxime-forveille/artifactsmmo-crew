import { errAsync, okAsync, type ResultAsync } from "neverthrow";

import type { ArtifactsClient } from "../../client/index.js";
import type { components } from "../../client/schema.js";
import { logger } from "../../utils/logger.js";
import type { CharacterAgent } from "../characters/characterAgent.js";
import { restIfLow } from "../combat.js";
import {
  findBestCombatGear,
  findBestGatheringTool,
  SUPPORTED_COMBAT_SLOTS,
  type SupportedCombatSlot,
} from "../gear.js";
import { heldQuantity } from "../inventory.js";
import { findCraftableFromBankSurplus, materialsNeededFor } from "../materialPlan.js";
import {
  craftSkillLevel,
  findNextFarmableResource,
  findNextSafeMonster,
  skillLevel,
} from "../progression.js";
import {
  craftAndEquip,
  ensureHeld,
  type EquipmentError,
  InsufficientCraftingLevelError,
} from "../strategies/equipment.js";
import { runFarmingCycle } from "../strategies/farming.js";
import { runHuntingCycle } from "../strategies/hunting.js";
import { runForever } from "./runForever.js";

type CraftSkill = components["schemas"]["CraftSkill"];
type GatheringSkill = components["schemas"]["GatheringSkill"];
type Item = components["schemas"]["ItemSchema"];
type Monster = components["schemas"]["MonsterSchema"];

/**
 * Tracks the exact `{skill, requiredLevel}` pairs a pending gear upgrade
 * is blocked on (see `InsufficientCraftingLevelError`), so `runAutoHuntTask`
 * knows precisely when it's worth re-checking gear again - the moment one
 * of these thresholds is actually reached - instead of on every minor XP
 * tick. Keyed by skill; a skill only ever needs its *lowest* still-blocking
 * required level tracked.
 */
type PendingCraftUnlocks = Map<CraftSkill, number>;

export class NoSafeMonsterFoundError extends Error {
  constructor(level: number) {
    super(`No monster found that's safe to fight at or below level ${level}`);
    this.name = "NoSafeMonsterFoundError";
  }
}

export class NoFarmableResourceFoundError extends Error {
  constructor(skill: GatheringSkill, level: number) {
    super(`No ${skill} resource found at or below level ${level}`);
    this.name = "NoFarmableResourceFoundError";
  }
}

/**
 * Equips `item` immediately if it's completely free right now - already
 * held or banked, nothing left to gather/craft for it (see
 * `materialsNeededFor`). Otherwise logs what's missing and keeps whatever
 * is currently equipped, rather than committing to however much
 * gathering/hunting the upgrade would actually take. This is the cost
 * gate placed in front of every upgrade the bot finds *on its own*
 * (`findBestGatheringTool`/`findBestCombatGear`) - unlike a human
 * explicitly listing an item in a `craftAndEquip` task, which always
 * commits regardless of cost. Failures (checking the cost, or the
 * craft/equip call itself) are logged and swallowed, same as every other
 * auto-equip path - callers can always treat this as succeeding.
 * `context` is only used for logging, to say what the upgrade was for.
 */
const equipIfFree = (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  item: Item,
  context: string,
): ResultAsync<void, never> =>
  materialsNeededFor(client, agent.getCharacter(), item.code, 1)
    .andThen((missing) => {
      if (missing.length > 0) {
        logger.info(
          { character: characterName, item: item.code, missing },
          `${characterName}: found a better ${context} (${item.code}), but it's not free right now - skipping for now`,
        );
        return okAsync(undefined);
      }

      return craftAndEquip(client, agent, item.code);
    })
    .orElse((error) => {
      logger.error(
        error,
        `${characterName}: failed to check/equip ${item.code} for ${context}, continuing with current gear`,
      );
      return okAsync(undefined);
    });

// A filler craft is meant to make *some* progress toward profession XP
// each cycle, not to bulk-produce everything the bank could theoretically
// support - findCraftableFromBankSurplus reports the full theoretical
// amount craftable from the entire bank surplus, which can vastly exceed
// what fits in the character's inventory at once (found live: a bank
// holding enough copper_ore for 156 copper_bar, needing ~10 ore each,
// tried to withdraw ~1,560 copper_ore in one go and failed with
// InventoryFullError/a real 497 - inventory_max_items is nowhere near
// that). Kept deliberately small (not just "whatever fits"): this cap
// only bounds the number of *crafts* attempted, not each recipe's own
// material-to-output ratio (unknown to this caller), so a small number
// leaves headroom for recipes that need several raw materials per unit
// crafted, without needing to know the exact ratio ahead of time. The
// loop naturally chips away at the rest over subsequent cycles.
const MAX_FILLER_CRAFT_BATCH = 5;

// A profession block should trigger one bounded XP action, not one action
// for every recipe the current bank happens to support. Running all recipes
// multiplied bank reads, crafting actions, and cooldowns across all five
// characters, creating real GET rate-limit pressure.
const MAX_FILLER_CRAFT_RECIPES = 1;

/**
 * Crafts a small batch of one item currently craftable from the bank's
 * surplus (see `findCraftableFromBankSurplus`, `MAX_FILLER_CRAFT_BATCH`, and
 * `MAX_FILLER_CRAFT_RECIPES`), purely for the profession XP - used as a filler activity when a
 * specific upgrade is blocked by `InsufficientCraftingLevelError`, so the
 * character makes some progress toward unlocking it instead of just
 * idling on the block. A no-op when nothing is currently craftable from
 * surplus (falls back to hunting as normal; it'll be retried on the next
 * check). Uses `ensureHeld` rather than `craftAndEquip` since filler
 * items aren't necessarily equippable (e.g. cooking output). Failures are
 * logged and swallowed, same as every other auto-equip path.
 */
const craftFromBankSurplus = (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
): ResultAsync<void, never> =>
  findCraftableFromBankSurplus(client, agent.getCharacter())
    .andThen((craftable) =>
      craftable.slice(0, MAX_FILLER_CRAFT_RECIPES).reduce<ResultAsync<void, EquipmentError>>(
        (acc, { craftableQuantity, itemCode }) =>
          acc.andThen(() => {
            const quantity = Math.min(craftableQuantity, MAX_FILLER_CRAFT_BATCH);

            logger.info(
              { character: characterName, item: itemCode, quantity },
              `${characterName}: crafting ${quantity}x ${itemCode} from bank surplus for profession xp`,
            );
            return ensureHeld(
              client,
              agent,
              itemCode,
              heldQuantity(agent.getCharacter(), itemCode) + quantity,
            );
          }),
        okAsync(undefined),
      ),
    )
    .orElse((error) => {
      logger.error(error, `${characterName}: failed to craft from bank surplus, continuing`);
      return okAsync(undefined);
    });

/**
 * Equips `item`, gathering/hunting/crafting whatever materials are still
 * missing along the way (via `craftAndEquip`), as long as every missing
 * material has a *known* source - a gatherable resource or a monster (see
 * `materialsNeededFor`'s `source` classification). Skips only when
 * something needed can't be traced to either at all. Unlike `equipIfFree`,
 * this commits to however much gathering/hunting the upgrade actually
 * takes, so it's only used at infrequent checkpoints (right after a
 * level-up) where paying that cost once in a while is worth it - using it
 * at a checkpoint that fires every cycle (like the per-target weapon
 * check) would mean a costly detour far too often.
 *
 * When blocked by `InsufficientCraftingLevelError` (the crafting-skill
 * level, not a missing material), records the exact `{skill,
 * requiredLevel}` it's waiting on in `pendingCraftUnlocks` - so
 * `runAutoHuntTask` knows precisely when it's worth checking gear again
 * (see `PendingCraftUnlocks`) - and crafts from bank surplus in the
 * meantime (`craftFromBankSurplus`) so the character makes some progress
 * toward that profession level instead of idling on the block.
 *
 * Known v1 simplification: doesn't weigh *how much* is missing before
 * committing (no quantity cap) - a static numeric threshold would be
 * arbitrary without real data to tune it against yet; see the README's
 * "Automated progression decisions" for the planned self-tuned-thresholds
 * follow-up. Failures are logged and swallowed, same as every other
 * auto-equip path.
 */
const equipWorthwhileUpgrade = (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  item: Item,
  context: string,
  pendingCraftUnlocks: PendingCraftUnlocks,
): ResultAsync<void, never> =>
  materialsNeededFor(client, agent.getCharacter(), item.code, 1)
    .andThen((missing) => {
      const hasUnknownSource = missing.some((material) => material.source.type === "unknown");

      if (hasUnknownSource) {
        logger.info(
          { character: characterName, item: item.code, missing },
          `${characterName}: found a better ${context} (${item.code}), but part of what it needs can't be traced to any resource/monster - skipping`,
        );
        return okAsync(undefined);
      }

      if (missing.length > 0) {
        logger.info(
          { character: characterName, item: item.code, missing },
          `${characterName}: found a better ${context} (${item.code}), going to gather/craft what's missing`,
        );
      }

      return craftAndEquip(client, agent, item.code);
    })
    .orElse((error) => {
      if (error instanceof InsufficientCraftingLevelError) {
        const currentlyTracked = pendingCraftUnlocks.get(error.skill);

        if (currentlyTracked === undefined || error.requiredLevel < currentlyTracked) {
          pendingCraftUnlocks.set(error.skill, error.requiredLevel);
        }

        logger.info(
          {
            character: characterName,
            item: item.code,
            requiredLevel: error.requiredLevel,
            skill: error.skill,
          },
          `${characterName}: ${item.code} needs ${error.skill} level ${error.requiredLevel} - crafting from bank surplus for profession xp in the meantime`,
        );

        return craftFromBankSurplus(client, characterName, agent);
      }

      logger.error(
        error,
        `${characterName}: failed to check/equip ${item.code} for ${context}, continuing with current gear`,
      );
      return okAsync(undefined);
    });

/**
 * Equips the best available gathering tool for `skill` (see
 * `findBestGatheringTool`), if any exists at the character's level and
 * it's free right now (see `equipIfFree`). A no-op when no such tool is
 * found. `resourceCode` is only used for logging, to say what farming was
 * about to start on.
 */
const equipGatheringToolIfAvailable = (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  resourceCode: string,
  skill: GatheringSkill,
): ResultAsync<void, never> =>
  findBestGatheringTool(client, skill, agent.getCharacter().level)
    .andThen((tool) =>
      tool === undefined
        ? okAsync(undefined)
        : equipIfFree(client, characterName, agent, tool, `gathering tool for ${resourceCode}`),
    )
    .orElse((error) => {
      logger.error(
        error,
        `${characterName}: failed to look up a gathering tool for ${resourceCode}, continuing with current gear`,
      );
      return okAsync(undefined);
    });

export const runFarmTask = async (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  resourceCode: string,
  signal?: AbortSignal,
): Promise<void> => {
  await client
    .getResource(resourceCode)
    .andThen((response) =>
      equipGatheringToolIfAvailable(
        client,
        characterName,
        agent,
        resourceCode,
        response.data.skill,
      ),
    )
    .orElse((error) => {
      logger.error(
        error,
        `${characterName}: failed to look up ${resourceCode} for tool selection, continuing with current gear`,
      );
      return okAsync(undefined);
    });

  await runForever(
    characterName,
    "farming cycle",
    () => runFarmingCycle(client, agent, resourceCode),
    signal,
  );
};

/**
 * Same as a fixed `farm`, but re-picks the highest-level resource the
 * character's `skill` level allows before every cycle instead of using a
 * fixed code (see `findNextFarmableResource`), equipping the best
 * gathering tool for that skill each time too. When no resource for this
 * skill is currently within reach (e.g. a fresh skill with a gap before
 * the next tier), that's treated the same as any other cycle failure:
 * logged and retried shortly.
 */
export const runAutoFarmTask = (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  skill: GatheringSkill,
  signal?: AbortSignal,
): Promise<void> =>
  runForever(
    characterName,
    "auto-farm cycle",
    () =>
      findNextFarmableResource(client, agent.getCharacter(), skill).andThen((resource) =>
        resource === undefined
          ? errAsync(
              new NoFarmableResourceFoundError(skill, skillLevel(agent.getCharacter(), skill)),
            )
          : equipGatheringToolIfAvailable(
              client,
              characterName,
              agent,
              resource.code,
              skill,
            ).andThen(() => runFarmingCycle(client, agent, resource.code)),
      ),
    signal,
  );

/**
 * Looks up the best item for `slot` when fighting `monster` (see
 * `findBestCombatGear`), then hands it to `equip` if one was found and it
 * differs from what's currently equipped - `equip` decides whether/how
 * aggressively to commit to it (see `equipIfFree` and
 * `equipWorthwhileUpgrade`). Failures looking up the candidate itself are
 * logged and swallowed, same as every other auto-equip path.
 */
const withBestCombatGear = (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  monster: Monster,
  slot: SupportedCombatSlot,
  equip: (item: Item) => ResultAsync<void, never>,
): ResultAsync<void, never> =>
  findBestCombatGear(client, agent.getCharacter(), monster, slot, agent.getCharacter().level)
    .andThen((item) => (item === undefined ? okAsync(undefined) : equip(item)))
    .orElse((error) => {
      logger.error(
        error,
        `${characterName}: failed to look up best ${slot} gear for ${monster.code}, continuing with current gear`,
      );
      return okAsync(undefined);
    });

/**
 * Equips the best available item for `slot` when fighting `monster` if
 * it's free right now (see `equipIfFree`). Used for checkpoints that fire
 * every cycle (the current target's weapon), where committing to a costly
 * detour that often would be too disruptive.
 */
const equipBestCombatGearIfAvailable = (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  monster: Monster,
  slot: SupportedCombatSlot,
): ResultAsync<void, never> =>
  withBestCombatGear(client, characterName, agent, monster, slot, (item) =>
    equipIfFree(client, characterName, agent, item, `${slot} gear for ${monster.code}`),
  );

/**
 * Equips the best available item for `slot` when fighting `monster` as
 * long as its materials all have a known source (see
 * `equipWorthwhileUpgrade`) - a more aggressive commitment than
 * `equipBestCombatGearIfAvailable`, reserved for infrequent checkpoints
 * (see `equipAllCombatGearIfWorthwhile`).
 */
const equipBestCombatGearIfWorthwhile = (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  monster: Monster,
  slot: SupportedCombatSlot,
  pendingCraftUnlocks: PendingCraftUnlocks,
): ResultAsync<void, never> =>
  withBestCombatGear(client, characterName, agent, monster, slot, (item) =>
    equipWorthwhileUpgrade(
      client,
      characterName,
      agent,
      item,
      `${slot} gear for ${monster.code}`,
      pendingCraftUnlocks,
    ),
  );

/**
 * `equipBestCombatGearIfWorthwhile` for every slot in
 * `SUPPORTED_COMBAT_SLOTS`, one after another - used right after a
 * level-up, since re-evaluating every slot happens rarely enough that
 * committing to a worthwhile-but-not-free upgrade along the way is
 * acceptable (unlike the every-cycle weapon check, see
 * `equipBestCombatGearIfAvailable`).
 */
const equipAllCombatGearIfWorthwhile = (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  monster: Monster,
  pendingCraftUnlocks: PendingCraftUnlocks,
): ResultAsync<void, never> =>
  SUPPORTED_COMBAT_SLOTS.reduce<ResultAsync<void, never>>(
    (acc, slot) =>
      acc.andThen(() =>
        equipBestCombatGearIfWorthwhile(
          client,
          characterName,
          agent,
          monster,
          slot,
          pendingCraftUnlocks,
        ),
      ),
    okAsync(undefined),
  );

export const runHuntTask = async (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  monsterCode: string,
  signal?: AbortSignal,
): Promise<void> => {
  await client
    .getMonster(monsterCode)
    .andThen((response) =>
      equipBestCombatGearIfAvailable(client, characterName, agent, response.data, "weapon"),
    )
    .orElse((error) => {
      logger.error(
        error,
        `${characterName}: failed to look up ${monsterCode} for weapon selection, continuing with current gear`,
      );
      return okAsync(undefined);
    });

  await runForever(
    characterName,
    "hunting cycle",
    () => runHuntingCycle(client, agent, monsterCode),
    signal,
  );
};

/**
 * Same as a fixed `hunt`, but re-picks the safest, highest-level monster
 * before every cycle instead of using a fixed code (see
 * `findNextSafeMonster`), equipping the best weapon for that monster each
 * time too (see `equipBestCombatGearIfAvailable`) since the target - and
 * so the ideal weapon - can change from one cycle to the next. Rests
 * first, unconditionally, before even looking for a target: `isSafeToFight`
 * can correctly decide nothing is safe to fight at critically low HP, and
 * without this, a character that just barely survived a loss would never
 * get a chance to heal - `restIfLow` only otherwise runs inside the fight
 * loop itself, which this cycle would never reach in that case (regression:
 * characters getting stuck retrying `NoSafeMonsterFoundError` forever at
 * ~1 HP). When nothing is currently safe to fight even after resting,
 * that's treated the same as any other cycle failure: logged and retried
 * shortly.
 *
 * The other 7 combat slots (armor, shield, ring, amulet) are only
 * re-checked on the task's first cycle, right after the character levels
 * up, or the moment a profession level a pending upgrade was blocked on
 * (`InsufficientCraftingLevelError`) actually reaches its required
 * threshold (see `PendingCraftUnlocks`) - not every cycle: their "best"
 * choice changes far less often than the weapon's (which already tracks
 * the current target every cycle), so checking all of them constantly
 * would mean several extra `getItems`/`getItem` calls per cycle for very
 * little benefit most of the time. The first-cycle check matters even
 * for a character who isn't freshly leveling up: without it, whatever
 * level they already happened to be at when this task started would
 * never trigger a future "level increased" comparison, so a fully free
 * upgrade could sit unequipped indefinitely (this happened live). That
 * level-up/first-cycle check (`equipAllCombatGearIfWorthwhile`) also
 * commits to a worthwhile upgrade even when it isn't completely free, as
 * long as every missing material has a known source, and crafts from
 * bank surplus for profession XP when blocked by a crafting-skill level
 * instead - the every-cycle weapon check (`equipBestCombatGearIfAvailable`)
 * stays strictly free-only, since paying a gathering/hunting detour that
 * often would be too disruptive.
 */
export const runAutoHuntTask = (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  signal?: AbortSignal,
): Promise<void> => {
  // undefined means "never checked yet", not "checked at some level" - so
  // the very first cycle always gets the full 8-slot scan too, regardless
  // of what level the character happens to already be at when this task
  // starts (e.g. after a process restart, or a plain task reassignment).
  // Using the character's own current level here instead would silently
  // skip that first scan forever, since a level that was already reached
  // before the task started can't trigger a future "level increased"
  // comparison (regression: found live - a fully free leg armor upgrade
  // sat unequipped indefinitely because the character had already been
  // level 8 since before this check existed).
  let lastGearCheckLevel: number | undefined;
  const pendingCraftUnlocks: PendingCraftUnlocks = new Map();

  return runForever(
    characterName,
    "auto-hunt cycle",
    () =>
      restIfLow(agent).andThen(() =>
        findNextSafeMonster(client, agent.getCharacter()).andThen((monster) => {
          if (monster === undefined) {
            return errAsync(new NoSafeMonsterFoundError(agent.getCharacter().level));
          }

          const currentLevel = agent.getCharacter().level;
          const unlockReached = [...pendingCraftUnlocks].some(
            ([skill, requiredLevel]) =>
              craftSkillLevel(agent.getCharacter(), skill) >= requiredLevel,
          );
          const needsGearCheck =
            lastGearCheckLevel === undefined || currentLevel > lastGearCheckLevel || unlockReached;

          if (needsGearCheck) {
            lastGearCheckLevel = currentLevel;

            for (const [skill, requiredLevel] of pendingCraftUnlocks) {
              if (craftSkillLevel(agent.getCharacter(), skill) >= requiredLevel) {
                pendingCraftUnlocks.delete(skill);
              }
            }
          }

          const equipGear = needsGearCheck
            ? equipAllCombatGearIfWorthwhile(
                client,
                characterName,
                agent,
                monster,
                pendingCraftUnlocks,
              )
            : equipBestCombatGearIfAvailable(client, characterName, agent, monster, "weapon");

          return equipGear.andThen(() => runHuntingCycle(client, agent, monster.code));
        }),
      ),
    signal,
  );
};

/**
 * Crafts and equips each item in `items`, one after another. A failure on
 * one item is logged but doesn't stop the rest of the list (e.g. so a
 * ring recipe hiccup doesn't prevent the character from still getting
 * their boots). Stops early, without starting the next item, once
 * `signal` is aborted.
 */
export const runCraftAndEquipTask = async (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  items: readonly string[],
  signal?: AbortSignal,
): Promise<void> => {
  for (const itemCode of items) {
    if (signal?.aborted) {
      logger.info(
        { character: characterName },
        `${characterName}: craft/equip stopped (reassigned)`,
      );
      return;
    }

    const result = await craftAndEquip(client, agent, itemCode);

    await result.match(
      async () => {
        logger.info(
          { character: characterName, item: itemCode },
          `${characterName}: crafted and equipped ${itemCode}`,
        );
      },
      async (error) => {
        logger.error(error, `${characterName}: failed to craft/equip ${itemCode}, moving on`);
      },
    );
  }
};
