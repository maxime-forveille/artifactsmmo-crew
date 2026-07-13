import { type Task, runTask } from "./bot/tasks/runTask.js";
import { bot } from "./client/index.js";
import { logger } from "./utils/logger.js";

// Craft/equip wooden_staff (a no-op if already equipped), then switch to
// hunting yellow_slime forever.
const TASK: Task = {
  items: ["wooden_staff"],
  monster: "yellow_slime",
  type: "craftAndEquipThenHunt",
};

const ASSIGNMENTS: readonly { readonly character: string; readonly task: Task }[] = [
  { character: "Cartman", task: TASK },
  { character: "Kyle", task: TASK },
  { character: "Kenny", task: TASK },
  { character: "Stan", task: TASK },
  { character: "Butters", task: TASK },
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
