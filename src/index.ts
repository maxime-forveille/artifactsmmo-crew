import { runTask } from "./bot/tasks/runTask.js";
import { bot } from "./client/index.js";
import { logger } from "./utils/logger.js";
import { loadTaskAssignments } from "./utils/taskAssignments.js";

async function main() {
  logger.info("Artifacts MMO bot starting up");

  const assignments = loadTaskAssignments();

  await Promise.all(
    assignments.map((assignment) => runTask(bot, assignment.character, assignment.task)),
  );
}

main().catch((error: unknown) => {
  logger.error(error, "Fatal error while running the bot");
  process.exitCode = 1;
});
