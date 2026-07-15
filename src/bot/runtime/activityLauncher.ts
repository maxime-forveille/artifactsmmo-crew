import type { Result, ResultAsync } from "neverthrow";

import type { ExecutableActivity } from "./activityDispatcher.js";
import {
  reserveStartedActivity,
  type ActivityTerminalEvent,
  type StartActivityError,
} from "../orchestration/activityLifecycle.js";
import type { ActivityAssignment, OrchestratorState } from "../orchestration/orchestratorState.js";

export type ActivityFailureDisposition = "blocked" | "transient";

type ActivityEvent<TType extends ActivityTerminalEvent["type"]> = Readonly<
  ActivityTerminalEvent & { type: TType }
>;

export type ActivityRunOutcome<E extends Error> =
  | Readonly<{ event: ActivityEvent<"cancelled" | "completed"> }>
  | Readonly<{ error: E; event: ActivityEvent<"blocked"> }>;

type ActivityLauncherDependencies<E extends Error> = Readonly<{
  classifyFailure: (error: E) => ActivityFailureDisposition;
  execute: (activity: ExecutableActivity) => ResultAsync<void, E>;
  waitBeforeRetry: () => Promise<void>;
}>;

export type LaunchedActivity<E extends Error> = Readonly<{
  completion: Promise<ActivityRunOutcome<E>>;
  state: OrchestratorState;
}>;

const buildTerminalEvent = <TType extends ActivityTerminalEvent["type"]>(
  assignment: ActivityAssignment<ExecutableActivity>,
  type: TType,
): ActivityEvent<TType> => ({
  characterName: assignment.characterName,
  goalId: assignment.goalId,
  type,
});

const runUntilTerminal = async <E extends Error>(
  assignment: ActivityAssignment<ExecutableActivity>,
  dependencies: ActivityLauncherDependencies<E>,
  signal?: AbortSignal,
): Promise<ActivityRunOutcome<E>> => {
  for (;;) {
    if (signal?.aborted) {
      return { event: buildTerminalEvent(assignment, "cancelled") };
    }

    const result = await dependencies.execute(assignment.activity);

    if (result.isOk()) {
      return { event: buildTerminalEvent(assignment, "completed") };
    }

    if (dependencies.classifyFailure(result.error) === "blocked") {
      return {
        error: result.error,
        event: buildTerminalEvent(assignment, "blocked"),
      };
    }

    await dependencies.waitBeforeRetry();
  }
};

/**
 * Reserves and starts one bounded Activity for an idle character. Transient
 * failures retry the same Activity without releasing its Reservation or
 * invoking policy; terminal outcomes are serialized by the future scheduler.
 */
export const launchActivity = <E extends Error>(
  state: OrchestratorState,
  assignment: ActivityAssignment<ExecutableActivity>,
  dependencies: ActivityLauncherDependencies<E>,
  signal?: AbortSignal,
): Result<LaunchedActivity<E>, StartActivityError> =>
  reserveStartedActivity(state, assignment).map((reservedState) => ({
    completion: runUntilTerminal(assignment, dependencies, signal),
    state: reservedState,
  }));
