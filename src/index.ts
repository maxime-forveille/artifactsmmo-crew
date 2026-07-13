import { type Task, runTask } from "./bot/tasks/runTask.js";
import { bot } from "./client/index.js";
import { logger } from "./utils/logger.js";

const ASSIGNMENTS: readonly { readonly character: string; readonly task: Task }[] = [
  { character: "Cartman", task: { monster: "chicken", type: "hunt" } },
  { character: "Kyle", task: { monster: "chicken", type: "hunt" } },
  { character: "Kenny", task: { monster: "chicken", type: "hunt" } },
  { character: "Stan", task: { monster: "chicken", type: "hunt" } },
  { character: "Butters", task: { monster: "chicken", type: "hunt" } },
];

async function main() {
  logger.info("Artifacts MMO bot starting up");

  await Promise.all(
    ASSIGNMENTS.map((assignment) => runTask(bot, assignment.character, assignment.task)),
  );
}

main().catch((error: unknown) => {
  logger.error(error, "Fatal error while running the bot");
  process.exitCode = 1;
});
