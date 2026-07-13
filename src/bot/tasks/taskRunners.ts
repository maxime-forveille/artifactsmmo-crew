import { errAsync, okAsync, type ResultAsync } from "neverthrow";

import type { ArtifactsClient } from "../../client/index.js";
import type { components } from "../../client/schema.js";
import { logger } from "../../utils/logger.js";
import type { CharacterAgent } from "../characters/characterAgent.js";
import { restIfLow } from "../combat.js";
import { findBestCombatWeapon, findBestGatheringTool } from "../gear.js";
import { findNextSafeMonster } from "../progression.js";
import { craftAndEquip } from "../strategies/equipment.js";
import { runFarmingCycle } from "../strategies/farming.js";
import { runHuntingCycle } from "../strategies/hunting.js";
import { runForever } from "./runForever.js";

type Monster = components["schemas"]["MonsterSchema"];

export class NoSafeMonsterFoundError extends Error {
  constructor(level: number) {
    super(`No monster found that's safe to fight at or below level ${level}`);
    this.name = "NoSafeMonsterFoundError";
  }
}

/**
 * Equips the best available gathering tool for the skill `resourceCode`
 * requires (see `findBestGatheringTool`), if any exists at the character's
 * level. A no-op when no such tool is found. Failures (e.g. the resource
 * lookup or the craft/equip itself) are logged and swallowed - the
 * character just keeps whatever's currently equipped - so callers can
 * always treat this as succeeding.
 */
const equipGatheringToolIfAvailable = (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  resourceCode: string,
): ResultAsync<void, never> =>
  client
    .getResource(resourceCode)
    .andThen((response) =>
      findBestGatheringTool(client, response.data.skill, agent.getCharacter().level),
    )
    .andThen((tool) =>
      tool === undefined ? okAsync(undefined) : craftAndEquip(client, agent, tool.code),
    )
    .orElse((error) => {
      logger.error(
        error,
        `${characterName}: failed to equip a gathering tool for ${resourceCode}, continuing with current gear`,
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
  await equipGatheringToolIfAvailable(client, characterName, agent, resourceCode);
  await runForever(
    characterName,
    "farming cycle",
    () => runFarmingCycle(client, agent, resourceCode),
    signal,
  );
};

/**
 * Equips the best available weapon for fighting `monster` (see
 * `findBestCombatWeapon`), if it differs from what's currently equipped.
 * Same non-blocking failure handling as `equipGatheringToolIfAvailable`.
 */
const equipCombatWeaponIfAvailable = (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  monster: Monster,
): ResultAsync<void, never> =>
  findBestCombatWeapon(client, agent.getCharacter(), monster, agent.getCharacter().level)
    .andThen((weapon) =>
      weapon === undefined ? okAsync(undefined) : craftAndEquip(client, agent, weapon.code),
    )
    .orElse((error) => {
      logger.error(
        error,
        `${characterName}: failed to equip a combat weapon for ${monster.code}, continuing with current gear`,
      );
      return okAsync(undefined);
    });

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
      equipCombatWeaponIfAvailable(client, characterName, agent, response.data),
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
 * time too (see `equipCombatWeaponIfAvailable`) since the target - and so
 * the ideal weapon - can change from one cycle to the next. Rests first,
 * unconditionally, before even looking for a target: `isSafeToFight` can
 * correctly decide nothing is safe to fight at critically low HP, and
 * without this, a character that just barely survived a loss would never
 * get a chance to heal - `restIfLow` only otherwise runs inside the fight
 * loop itself, which this cycle would never reach in that case (regression:
 * characters getting stuck retrying `NoSafeMonsterFoundError` forever at
 * ~1 HP). When nothing is currently safe to fight even after resting,
 * that's treated the same as any other cycle failure: logged and retried
 * shortly.
 */
export const runAutoHuntTask = (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  signal?: AbortSignal,
): Promise<void> =>
  runForever(
    characterName,
    "auto-hunt cycle",
    () =>
      restIfLow(agent).andThen(() =>
        findNextSafeMonster(client, agent.getCharacter()).andThen((monster) =>
          monster === undefined
            ? errAsync(new NoSafeMonsterFoundError(agent.getCharacter().level))
            : equipCombatWeaponIfAvailable(client, characterName, agent, monster).andThen(() =>
                runHuntingCycle(client, agent, monster.code),
              ),
        ),
      ),
    signal,
  );

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
