import { err, ok, type Result } from 'neverthrow';

import {
  reserveStartedActivity,
  type StartActivityError,
} from '../orchestration/activityLifecycle.js';
import type { CrewSnapshot } from '../orchestration/crewSnapshot.js';
import type {
  ActivityAssignment,
  OrchestratorState,
} from '../orchestration/orchestratorState.js';

import type { ExecutableActivity } from './activityDispatcher.js';
import type { LaunchedActivity } from './activityLauncher.js';

export type ActivityPlan = Readonly<{
  activities: readonly ActivityAssignment<ExecutableActivity>[];
  state: OrchestratorState;
}>;

export type ActivityPlanner<EPlan extends Error> = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
) => Result<ActivityPlan, EPlan>;

export type ActivityStarter<
  EActivity extends Error,
  EStart extends Error = StartActivityError,
> = (
  state: OrchestratorState,
  assignment: ActivityAssignment<ExecutableActivity>,
) => Result<LaunchedActivity<EActivity>, EStart>;

export type ScheduledActivities<EActivity extends Error> = Readonly<{
  running: readonly LaunchedActivity<EActivity>[];
  state: OrchestratorState;
}>;

const validatePlanStarts = (
  state: OrchestratorState,
  assignments: readonly ActivityAssignment<ExecutableActivity>[],
): Result<OrchestratorState, StartActivityError> =>
  assignments.reduce<Result<OrchestratorState, StartActivityError>>(
    (result, assignment) =>
      result.andThen((nextState) =>
        reserveStartedActivity(nextState, assignment),
      ),
    ok(state),
  );

/**
 * Evaluates policy once against one Crew Snapshot, validates every proposed
 * start, then launches the Activities sequentially against the latest state.
 * Validation prevents a malformed multi-Activity plan from starting only a
 * prefix before discovering a duplicate character or missing Goal.
 */
export const scheduleActivities = <
  EActivity extends Error,
  EPlan extends Error,
  EStart extends Error = StartActivityError,
>(
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  plan: ActivityPlanner<EPlan>,
  start: ActivityStarter<EActivity, EStart>,
): Result<
  ScheduledActivities<EActivity>,
  EPlan | EStart | StartActivityError
> => {
  const planned = plan(snapshot, state);

  if (planned.isErr()) {
    return err(planned.error);
  }

  const validation = validatePlanStarts(
    planned.value.state,
    planned.value.activities,
  );

  if (validation.isErr()) {
    return err(validation.error);
  }

  const running: LaunchedActivity<EActivity>[] = [];
  let nextState = planned.value.state;

  for (const assignment of planned.value.activities) {
    const launched = start(nextState, assignment);

    if (launched.isErr()) {
      return err(launched.error);
    }

    nextState = launched.value.state;
    running.push(launched.value);
  }

  return ok({ running, state: nextState });
};
