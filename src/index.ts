import { existsSync } from "node:fs";

import { createConfiguredCrewRuntime } from "./bot/runtime/configuredCrewRuntime.js";
import { runTaskSupervisor } from "./bot/runtime/taskSupervisor.js";
import { bot } from "./client/index.js";
import { loadOrchestrationConfig } from "./utils/orchestrationConfig.js";
import { logger } from "./utils/logger.js";
import { loadTaskAssignments } from "./utils/taskAssignments.js";

const ORCHESTRATION_CONFIG_PATH = "orchestration.json";
const TASK_RELOAD_INTERVAL_MS = 10_000;
const TRANSIENT_RETRY_DELAY_MS = 10_000;

const waitBeforeRetry = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));

const runConfiguredOrchestration = async (): Promise<void> => {
  logger.info({ path: ORCHESTRATION_CONFIG_PATH }, "Starting configured crew orchestration");

  const created = await createConfiguredCrewRuntime(bot, {
    config: loadOrchestrationConfig(ORCHESTRATION_CONFIG_PATH),
    reportError: (error) => logger.error(error, "Crew runtime failure"),
    waitBeforeRetry,
  });

  if (created.isErr()) {
    throw created.error;
  }

  const started = created.value.start();

  if (started.isErr()) {
    throw started.error;
  }

  await created.value.waitForIdle();
  logger.info("Configured crew Goals are satisfied; runtime is idle");
};

const runConfiguredTasks = (): Promise<void> => {
  logger.info("No orchestration.json found; starting tasks.json Adapter");

  // How often tasks.json is re-read for changes (see runTaskSupervisor). A
  // reassignment can still take up to one more full task cycle beyond this
  // to actually apply - see runForever's doc comment.
  return runTaskSupervisor(bot, loadTaskAssignments, TASK_RELOAD_INTERVAL_MS);
};

const main = async (): Promise<void> => {
  logger.info("Artifacts MMO bot starting up");

  await (existsSync(ORCHESTRATION_CONFIG_PATH)
    ? runConfiguredOrchestration()
    : runConfiguredTasks());
};

main().catch((error: unknown) => {
  logger.error(error, "Fatal error while running the bot");
  process.exitCode = 1;
});
