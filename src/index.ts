import { runTaskSupervisor } from "./bot/taskSupervisor.js";
import { bot } from "./client/index.js";
import { logger } from "./utils/logger.js";
import { loadTaskAssignments } from "./utils/taskAssignments.js";

// How often tasks.json is re-read for changes (see runTaskSupervisor). A
// reassignment can still take up to one more full task cycle beyond this
// to actually apply - see runForever's doc comment.
const RELOAD_INTERVAL_MS = 10_000;

async function main() {
  logger.info("Artifacts MMO bot starting up");

  await runTaskSupervisor(bot, loadTaskAssignments, RELOAD_INTERVAL_MS);
}

main().catch((error: unknown) => {
  logger.error(error, "Fatal error while running the bot");
  process.exitCode = 1;
});
