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
import { materialsNeededFor } from "../materialPlan.js";
import { findNextFarmableResource, findNextSafeMonster, skillLevel } from "../progression.js";
import { craftAndEquip } from "../strategies/equipment.js";
import { runFarmingCycle } from "../strategies/farming.js";
import { runHuntingCycle } from "../strategies/hunting.js";
import { runForever } from "./runForever.js";

type GatheringSkill = components["schemas"]["GatheringSkill"];
type Item = components["schemas"]["ItemSchema"];
type Monster = components["schemas"]["MonsterSchema"];

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
 * Equips the best available item for `slot` when fighting `monster` (see
 * `findBestCombatGear`), if it differs from what's currently equipped and
 * it's free right now (see `equipIfFree`). Same non-blocking failure
 * handling as `equipGatheringToolIfAvailable`.
 */
const equipBestCombatGearIfAvailable = (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  monster: Monster,
  slot: SupportedCombatSlot,
): ResultAsync<void, never> =>
  findBestCombatGear(client, agent.getCharacter(), monster, slot, agent.getCharacter().level)
    .andThen((item) =>
      item === undefined
        ? okAsync(undefined)
        : equipIfFree(client, characterName, agent, item, `${slot} gear for ${monster.code}`),
    )
    .orElse((error) => {
      logger.error(
        error,
        `${characterName}: failed to look up best ${slot} gear for ${monster.code}, continuing with current gear`,
      );
      return okAsync(undefined);
    });

/** `equipBestCombatGearIfAvailable` for every slot in `SUPPORTED_COMBAT_SLOTS`, one after another. */
const equipAllCombatGearIfAvailable = (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  monster: Monster,
): ResultAsync<void, never> =>
  SUPPORTED_COMBAT_SLOTS.reduce<ResultAsync<void, never>>(
    (acc, slot) =>
      acc.andThen(() =>
        equipBestCombatGearIfAvailable(client, characterName, agent, monster, slot),
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
 * re-checked right after the character levels up, not every cycle: their
 * "best" choice changes far less often than the weapon's (which already
 * tracks the current target every cycle), so checking all of them
 * constantly would mean several extra `getItems`/`getItem` calls per
 * cycle for very little benefit most of the time.
 */
export const runAutoHuntTask = (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  signal?: AbortSignal,
): Promise<void> => {
  let lastGearCheckLevel = agent.getCharacter().level;

  return runForever(
    characterName,
    "auto-hunt cycle",
    () =>
      restIfLow(agent).andThen(() =>
        findNextSafeMonster(client, agent.getCharacter()).andThen((monster) => {
          if (monster === undefined) {
            return errAsync(new NoSafeMonsterFoundError(agent.getCharacter().level));
          }

          const leveledUp = agent.getCharacter().level > lastGearCheckLevel;

          if (leveledUp) {
            lastGearCheckLevel = agent.getCharacter().level;
          }

          const equipGear = leveledUp
            ? equipAllCombatGearIfAvailable(client, characterName, agent, monster)
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
