import type { ArtifactsClient } from "../../client/index.js";
import { waitUntil } from "../../utils/cooldown.js";
import { logger } from "../../utils/logger.js";
import type { CharacterAgent } from "../characters/characterAgent.js";
import { createCharacterAgent } from "../characters/characterAgent.js";
import { craftAndEquip } from "../strategies/equipment.js";
import { runFarmingCycle } from "../strategies/farming.js";
import { runHuntingCycle } from "../strategies/hunting.js";

const RETRY_DELAY_MS = 10_000;

/**
 * What a character should be doing. `farm` and `hunt` run forever;
 * `craftAndEquip` works through `items` in order, then stops;
 * `craftAndEquipThenHunt` does the same craftAndEquip pass (a no-op for
 * items already equipped) and then switches to hunting forever - the
 * "get geared up, then go fight" combo. New task types should be added
 * here first, then handled in `runTask`'s switch (the `never` check below
 * makes an unhandled case a compile error rather than a silent no-op).
 */
export type Task =
  | { readonly type: "craftAndEquip"; readonly items: readonly string[] }
  | {
      readonly type: "craftAndEquipThenHunt";
      readonly items: readonly string[];
      readonly monster: string;
    }
  | { readonly type: "farm"; readonly resource: string }
  | { readonly type: "hunt"; readonly monster: string };

const runFarmTask = async (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  resourceCode: string,
): Promise<void> => {
  for (;;) {
    const result = await runFarmingCycle(client, agent, resourceCode);

    await result.match(
      async () => {
        logger.info(
          { character: characterName, resource: resourceCode },
          `${characterName}: farming cycle completed`,
        );
      },
      async (error) => {
        logger.error(error, `${characterName}: farming cycle failed, retrying shortly`);
        await waitUntil(new Date(Date.now() + RETRY_DELAY_MS).toISOString());
      },
    );
  }
};

const runHuntTask = async (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  monsterCode: string,
): Promise<void> => {
  for (;;) {
    const result = await runHuntingCycle(client, agent, monsterCode);

    await result.match(
      async () => {
        logger.info(
          { character: characterName, monster: monsterCode },
          `${characterName}: hunting cycle completed`,
        );
      },
      async (error) => {
        logger.error(error, `${characterName}: hunting cycle failed, retrying shortly`);
        await waitUntil(new Date(Date.now() + RETRY_DELAY_MS).toISOString());
      },
    );
  }
};

/**
 * Crafts and equips each item in `items`, one after another. A failure on
 * one item is logged but doesn't stop the rest of the list (e.g. so a
 * ring recipe hiccup doesn't prevent the character from still getting
 * their boots).
 */
const runCraftAndEquipTask = async (
  client: ArtifactsClient,
  characterName: string,
  agent: CharacterAgent,
  items: readonly string[],
): Promise<void> => {
  for (const itemCode of items) {
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

/**
 * Creates a character agent and runs `task` on it. Agent creation failures
 * are logged, not thrown, so one character failing to start doesn't take
 * down whichever other tasks are running alongside it (see index.ts, which
 * runs one `runTask` per character via `Promise.all`).
 */
export const runTask = async (
  client: ArtifactsClient,
  characterName: string,
  task: Task,
): Promise<void> => {
  const agentResult = await createCharacterAgent(client, characterName);

  await agentResult.match(
    async (agent) => {
      switch (task.type) {
        case "craftAndEquip": {
          await runCraftAndEquipTask(client, characterName, agent, task.items);
          return;
        }
        case "craftAndEquipThenHunt": {
          await runCraftAndEquipTask(client, characterName, agent, task.items);
          await runHuntTask(client, characterName, agent, task.monster);
          return;
        }
        case "farm": {
          await runFarmTask(client, characterName, agent, task.resource);
          return;
        }
        case "hunt": {
          await runHuntTask(client, characterName, agent, task.monster);
          return;
        }
        default: {
          const exhaustiveCheck: never = task;
          throw new Error(`Unhandled task type: ${JSON.stringify(exhaustiveCheck)}`);
        }
      }
    },
    async (error) => {
      logger.error(error, `${characterName}: failed to create character agent`);
    },
  );
};
