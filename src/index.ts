import { createCharacterAgent } from "./bot/characters/characterAgent.js";
import { runFarmingCycle } from "./bot/strategies/farming.js";
import { bot } from "./client/index.js";
import { waitUntil } from "./utils/cooldown.js";
import { logger } from "./utils/logger.js";

const RETRY_DELAY_MS = 10_000;

// The 4 level-1 gathering resources, one per character (Butters stays at the
// bank, matching its support/banking role).
const FARMERS: readonly { readonly character: string; readonly resource: string }[] = [
  { character: "Cartman", resource: "copper_rocks" },
  { character: "Stan", resource: "ash_tree" },
  { character: "Kyle", resource: "gudgeon_spot" },
  { character: "Kenny", resource: "sunflower_field" },
];

const runFarmer = async (characterName: string, resourceCode: string): Promise<void> => {
  const agentResult = await createCharacterAgent(bot, characterName);

  await agentResult.match(
    async (agent) => {
      for (;;) {
        const result = await runFarmingCycle(bot, agent, resourceCode);

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
    },
    async (error) => {
      logger.error(error, `${characterName}: failed to create character agent`);
    },
  );
};

async function main() {
  logger.info("Artifacts MMO bot starting up");

  await Promise.all(FARMERS.map((farmer) => runFarmer(farmer.character, farmer.resource)));
}

main().catch((error: unknown) => {
  logger.error(error, "Fatal error while running the bot");
  process.exitCode = 1;
});
