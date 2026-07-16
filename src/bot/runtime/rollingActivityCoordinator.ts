import { err, ok, ResultAsync, type Result } from 'neverthrow';

import {
  finishActivity,
  type FinishActivityError,
  type StartActivityError,
} from '../orchestration/activityLifecycle.js';
import type { CrewSnapshot } from '../orchestration/crewSnapshot.js';
import type { OrchestratorState } from '../orchestration/orchestratorState.js';

import { createActivityEventProcessor } from './activityEventProcessor.js';
import type {
  ActivityRunOutcome,
  LaunchedActivity,
} from './activityLauncher.js';
import {
  scheduleActivities,
  type ActivityPlan,
  type ActivityStarter,
} from './activityScheduler.js';

export type RollingActivityPlanner<
  EActivity extends Error,
  EPlan extends Error,
> = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  previousOutcome?: ActivityRunOutcome<EActivity>,
) => Result<ActivityPlan, EPlan>;

export class UnexpectedCoordinatorError extends Error {
  constructor(options: ErrorOptions) {
    super('Unexpected rolling coordinator failure', options);
    this.name = 'UnexpectedCoordinatorError';
  }
}

export type RollingActivityCoordinatorError<
  EPlan extends Error,
  ESnapshot extends Error,
  EStart extends Error,
> =
  | EPlan
  | ESnapshot
  | EStart
  | FinishActivityError
  | StartActivityError
  | UnexpectedCoordinatorError;

type RollingActivityCoordinatorDependencies<
  EActivity extends Error,
  EPlan extends Error,
  ESnapshot extends Error,
  EStart extends Error,
> = Readonly<{
  plan: RollingActivityPlanner<EActivity, EPlan>;
  refreshSnapshot: () => ResultAsync<CrewSnapshot, ESnapshot>;
  reportError: (error: unknown) => void;
  shouldRetrySnapshotFailure: (error: ESnapshot) => boolean;
  startActivity: ActivityStarter<EActivity, EStart>;
  waitBeforeSnapshotRetry: () => Promise<void>;
}>;

type ScheduleError<EPlan extends Error, EStart extends Error> =
  | EPlan
  | EStart
  | StartActivityError;

export type RollingActivityCoordinator<
  EPlan extends Error,
  EStart extends Error,
  ESnapshot extends Error,
> = Readonly<{
  getSnapshot: () => CrewSnapshot;
  getState: () => OrchestratorState;
  start: () => Result<void, ScheduleError<EPlan, EStart>>;
  waitForIdle: () => Promise<
    Result<void, RollingActivityCoordinatorError<EPlan, ESnapshot, EStart>>
  >;
}>;

/**
 * Connects planning, launching, terminal-event processing, and snapshot refresh
 * in one rolling queue. Existing Activities continue concurrently, while every
 * terminal event is applied and replanned sequentially against the latest
 * state.
 */
export const createRollingActivityCoordinator = <
  EActivity extends Error,
  EPlan extends Error,
  ESnapshot extends Error,
  EStart extends Error = StartActivityError,
>(
  initialState: OrchestratorState,
  initialSnapshot: CrewSnapshot,
  dependencies: RollingActivityCoordinatorDependencies<
    EActivity,
    EPlan,
    ESnapshot,
    EStart
  >,
): RollingActivityCoordinator<EPlan, EStart, ESnapshot> => {
  let pendingEvents = 0;
  let queue: Promise<void> = Promise.resolve();
  let runningActivities = 0;
  let terminalFailure:
    | RollingActivityCoordinatorError<EPlan, ESnapshot, EStart>
    | undefined;
  let snapshot = initialSnapshot;
  let state = initialState;
  const idleWaiters: ((
    result: Result<
      void,
      RollingActivityCoordinatorError<EPlan, ESnapshot, EStart>
    >,
  ) => void)[] = [];

  const getSnapshot = (): CrewSnapshot => snapshot;
  const getState = (): OrchestratorState => state;

  const refreshSnapshotWithRetry = (): ResultAsync<CrewSnapshot, ESnapshot> =>
    ResultAsync.fromSafePromise(
      (async (): Promise<Result<CrewSnapshot, ESnapshot>> => {
        for (;;) {
          const refreshed = await dependencies.refreshSnapshot();

          if (
            refreshed.isOk() ||
            !dependencies.shouldRetrySnapshotFailure(refreshed.error)
          ) {
            return refreshed;
          }

          dependencies.reportError(refreshed.error);
          await dependencies.waitBeforeSnapshotRetry();
        }
      })(),
    ).andThen((result) => result);

  const notifyIfIdle = (): void => {
    if (pendingEvents !== 0 || runningActivities !== 0) {
      return;
    }

    const result =
      terminalFailure === undefined ? ok(undefined) : err(terminalFailure);

    for (const resolve of idleWaiters.splice(0)) {
      resolve(result);
    }
  };

  const waitForIdle = (): Promise<
    Result<void, RollingActivityCoordinatorError<EPlan, ESnapshot, EStart>>
  > => {
    if (pendingEvents === 0 && runningActivities === 0) {
      return Promise.resolve(
        terminalFailure === undefined ? ok(undefined) : err(terminalFailure),
      );
    }

    return new Promise((resolve) => {
      idleWaiters.push(resolve);
    });
  };

  const enqueueEvent = (processEvent: () => Promise<void>): void => {
    pendingEvents += 1;

    queue = queue
      .then(processEvent)
      .catch((cause: unknown) => {
        terminalFailure ??= new UnexpectedCoordinatorError({ cause });
        dependencies.reportError(cause);
      })
      .then(() => {
        pendingEvents -= 1;
        notifyIfIdle();
      });
  };

  const attachCompletion = (launched: LaunchedActivity<EActivity>): void => {
    runningActivities += 1;

    void launched.completion.then(
      (outcome) => {
        runningActivities -= 1;
        enqueueEvent(() => processOutcome(outcome));
      },
      (cause: unknown) => {
        runningActivities -= 1;
        enqueueEvent(async () => {
          const released = finishActivity(state, {
            characterName: launched.assignment.characterName,
            goalId: launched.assignment.goalId,
            type: 'cancelled',
          });

          if (released.isOk()) {
            state = released.value;
          } else {
            dependencies.reportError(released.error);
          }

          throw cause;
        });
      },
    );
  };

  const schedule = (
    previousOutcome?: ActivityRunOutcome<EActivity>,
  ): Result<void, EPlan | EStart | StartActivityError> => {
    const scheduled = scheduleActivities(
      snapshot,
      state,
      (currentSnapshot, currentState) =>
        dependencies.plan(currentSnapshot, currentState, previousOutcome),
      dependencies.startActivity,
    );

    if (scheduled.isErr()) {
      terminalFailure = scheduled.error;
      return err(scheduled.error);
    }

    state = scheduled.value.state;

    for (const launched of scheduled.value.running) {
      attachCompletion(launched);
    }

    return scheduled.map(() => undefined);
  };

  const processOutcome = async (
    outcome: ActivityRunOutcome<EActivity>,
  ): Promise<void> => {
    const processor = createActivityEventProcessor<EActivity, ESnapshot>(
      state,
      snapshot,
      refreshSnapshotWithRetry,
    );
    const processed = await processor.process(outcome).finally(() => {
      state = processor.getState();
      snapshot = processor.getSnapshot();
    });

    if (processed.isErr()) {
      terminalFailure = processed.error;
      dependencies.reportError(processed.error);
      return;
    }

    const scheduled = schedule(processed.value.outcome);

    if (scheduled.isErr()) {
      dependencies.reportError(scheduled.error);
    }
  };

  const start = (): Result<void, EPlan | EStart | StartActivityError> => {
    const result = schedule();
    notifyIfIdle();
    return result;
  };

  return { getSnapshot, getState, start, waitForIdle };
};
