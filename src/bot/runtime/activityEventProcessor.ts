import { err, type Result, type ResultAsync } from 'neverthrow';

import {
  finishActivity,
  type FinishActivityError,
} from '../orchestration/activityLifecycle.js';
import type { CrewSnapshot } from '../orchestration/crewSnapshot.js';
import type { OrchestratorState } from '../orchestration/orchestratorState.js';

import type { ActivityRunOutcome } from './activityLauncher.js';

export type ProcessedActivity<EActivity extends Error> = Readonly<{
  outcome: ActivityRunOutcome<EActivity>;
  snapshot: CrewSnapshot;
  state: OrchestratorState;
}>;

type ActivityEventProcessor<
  EActivity extends Error,
  ESnapshot extends Error,
> = Readonly<{
  getSnapshot: () => CrewSnapshot;
  getState: () => OrchestratorState;
  process: (
    outcome: ActivityRunOutcome<EActivity>,
  ) => Promise<
    Result<ProcessedActivity<EActivity>, ESnapshot | FinishActivityError>
  >;
}>;

/**
 * Serializes terminal Activity outcomes against the latest shared state. Each
 * accepted outcome releases its Reservation before refreshing the Crew
 * Snapshot; refresh failures keep the updated state and the previous snapshot.
 */
export const createActivityEventProcessor = <
  EActivity extends Error,
  ESnapshot extends Error,
>(
  initialState: OrchestratorState,
  initialSnapshot: CrewSnapshot,
  refreshSnapshot: () => ResultAsync<CrewSnapshot, ESnapshot>,
): ActivityEventProcessor<EActivity, ESnapshot> => {
  let snapshot = initialSnapshot;
  let state = initialState;
  let queue: Promise<void> = Promise.resolve();

  const getSnapshot = (): CrewSnapshot => snapshot;
  const getState = (): OrchestratorState => state;

  const process = (
    outcome: ActivityRunOutcome<EActivity>,
  ): Promise<
    Result<ProcessedActivity<EActivity>, ESnapshot | FinishActivityError>
  > => {
    const processing = queue.then(async () => {
      const finished = finishActivity(state, outcome.event);

      if (finished.isErr()) {
        return err(finished.error);
      }

      state = finished.value;

      return (await refreshSnapshot()).map((refreshedSnapshot) => {
        snapshot = refreshedSnapshot;

        return { outcome, snapshot, state };
      });
    });

    queue = processing.then(
      () => undefined,
      () => undefined,
    );

    return processing;
  };

  return { getSnapshot, getState, process };
};
