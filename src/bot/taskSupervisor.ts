import type { ArtifactsClient } from "../client/index.js";
import { logger } from "../utils/logger.js";
import type { TaskAssignment } from "../utils/taskAssignments.js";
import { runTask } from "./tasks/runTask.js";
import { tasksEqual, type Task } from "./tasks/task.js";

type RunningCharacter = {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
  readonly task: Task;
};

export type RunningCharacters = Map<string, RunningCharacter>;

const startCharacter = (
  client: ArtifactsClient,
  character: string,
  task: Task,
): RunningCharacter => {
  logger.info({ character, task }, `${character}: starting task`);

  const controller = new AbortController();

  return { controller, promise: runTask(client, character, task, controller.signal), task };
};

/**
 * Brings `running` in line with `assignments`: starts characters newly
 * added to `tasks.json`, stops (aborts, then awaits) characters removed
 * from it, and restarts (aborts the old run, awaits it, then starts fresh)
 * any whose task changed - see `tasksEqual`. Characters whose task is
 * unchanged are left running untouched, so reassigning one character never
 * interrupts the others. Mutates `running` in place.
 */
export const reconcileTasks = async (
  client: ArtifactsClient,
  running: RunningCharacters,
  assignments: readonly TaskAssignment[],
): Promise<void> => {
  const desired = new Map(assignments.map((assignment) => [assignment.character, assignment.task]));

  for (const [character, state] of running) {
    if (!desired.has(character)) {
      logger.info({ character }, `${character}: removed from tasks.json, stopping`);
      state.controller.abort();
      await state.promise;
      running.delete(character);
    }
  }

  for (const [character, task] of desired) {
    const current = running.get(character);

    if (current === undefined) {
      running.set(character, startCharacter(client, character, task));
      continue;
    }

    if (!tasksEqual(current.task, task)) {
      logger.info({ character, task }, `${character}: task changed, reloading`);
      current.controller.abort();
      await current.promise;
      running.set(character, startCharacter(client, character, task));
    }
  }
};

/**
 * Runs `loadAssignments()`'s characters forever, re-reading assignments
 * every `reloadIntervalMs` and reconciling running characters against
 * whatever changed (see `reconcileTasks`) - so editing `tasks.json` doesn't
 * require restarting the process. A failure to load/parse (e.g. a JSON
 * typo mid-edit) is logged and skipped rather than fatal: the bot keeps
 * running the last-known-good assignments until the file is fixed.
 */
export const runTaskSupervisor = async (
  client: ArtifactsClient,
  loadAssignments: () => readonly TaskAssignment[],
  reloadIntervalMs: number,
): Promise<void> => {
  const running: RunningCharacters = new Map();

  await reconcileTasks(client, running, loadAssignments());

  for (;;) {
    await new Promise<void>((resolve) => setTimeout(resolve, reloadIntervalMs));

    try {
      await reconcileTasks(client, running, loadAssignments());
    } catch (error) {
      logger.error(error as Error, "Failed to reload tasks.json, keeping current assignments");
    }
  }
};
