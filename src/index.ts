import { existsSync } from 'node:fs';

import { createConfiguredCrewRuntime } from './bot/runtime/configuredCrewRuntime.js';
import { runTaskSupervisor } from './bot/runtime/taskSupervisor.js';
import { createArtifactsClient } from './client/index.js';
import { openSqliteDatabase } from './persistence/database.js';
import {
  applyMigrations,
  orchestratorStateMigrations,
} from './persistence/migrations.js';
import { createSqliteOrchestratorStateRepository } from './persistence/sqliteOrchestratorStateRepository.js';
import { logger } from './utils/logger.js';
import { loadOrchestrationConfig } from './utils/orchestrationConfig.js';
import { loadTaskAssignments } from './utils/taskAssignments.js';

const ORCHESTRATION_CONFIG_PATH = 'orchestration.json';
const ORCHESTRATION_DATABASE_PATH = 'artifactsmmo-crew.sqlite';
const TASK_RELOAD_INTERVAL_MS = 10_000;
const TRANSIENT_RETRY_DELAY_MS = 10_000;

const bot = createArtifactsClient();

const waitBeforeRetry = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));

const runConfiguredOrchestration = async (): Promise<void> => {
  logger.info(
    { path: ORCHESTRATION_CONFIG_PATH },
    'Starting configured crew orchestration',
  );

  const openedDatabase = openSqliteDatabase(ORCHESTRATION_DATABASE_PATH);
  if (openedDatabase.isErr()) {
    throw openedDatabase.error;
  }

  const database = openedDatabase.value;

  try {
    const migrated = applyMigrations(database, orchestratorStateMigrations);
    if (migrated.isErr()) {
      throw migrated.error;
    }

    const created = await createConfiguredCrewRuntime(bot, {
      config: loadOrchestrationConfig(ORCHESTRATION_CONFIG_PATH),
      reportError: (error) => logger.error(error, 'Crew runtime failure'),
      stateRepository: createSqliteOrchestratorStateRepository(database),
      waitBeforeRetry,
    });

    if (created.isErr()) {
      throw created.error;
    }

    const started = created.value.start();

    if (started.isErr()) {
      throw started.error;
    }

    const idle = await created.value.waitForIdle();
    if (idle.isErr()) {
      throw idle.error;
    }

    logger.info('Configured crew Goals are satisfied; runtime is idle');
  } finally {
    database.close();
  }
};

const runConfiguredTasks = (): Promise<void> => {
  logger.info('No orchestration.json found; starting tasks.json Adapter');

  // How often tasks.json is re-read for changes (see runTaskSupervisor). A
  // reassignment can still take up to one more full task cycle beyond this
  // to actually apply - see runForever's doc comment.
  return runTaskSupervisor(bot, loadTaskAssignments, TASK_RELOAD_INTERVAL_MS);
};

const main = async (): Promise<void> => {
  logger.info('Artifacts MMO Crew starting up');

  await (existsSync(ORCHESTRATION_CONFIG_PATH)
    ? runConfiguredOrchestration()
    : runConfiguredTasks());
};

main().catch((error: unknown) => {
  logger.error(error, 'Fatal error while running Artifacts MMO Crew');
  process.exitCode = 1;
});
