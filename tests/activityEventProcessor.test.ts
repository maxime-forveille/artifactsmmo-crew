import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import type { CrewSnapshot } from '../src/bot/orchestration/crewSnapshot.js';
import type {
  ActivityAssignment,
  OrchestratorState,
} from '../src/bot/orchestration/orchestratorState.js';
import {
  createActivityEventProcessor,
  type ProcessedActivity,
} from '../src/bot/runtime/activityEventProcessor.js';
import type { ActivityRunOutcome } from '../src/bot/runtime/activityLauncher.js';

class TestActivityError extends Error {}
class TestSnapshotError extends Error {}

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
};

const buildAssignment = (
  characterName: string,
  goalId: string,
): ActivityAssignment => ({
  activity: { resourceCode: 'copper_rocks', type: 'farmResource' },
  characterName,
  consumes: [],
  goalId,
  produces: [{ itemCode: 'copper_ore' }],
});

const buildState = (): OrchestratorState => ({
  goals: [
    {
      id: 'goal-stan',
      itemCode: 'copper_ore',
      minimumBankQuantity: 50,
      type: 'replenishBankItem',
    },
    {
      id: 'goal-kyle',
      itemCode: 'ash_wood',
      minimumBankQuantity: 50,
      type: 'replenishBankItem',
    },
  ],
  reservations: [
    buildAssignment('Stan', 'goal-stan'),
    buildAssignment('Kyle', 'goal-kyle'),
  ],
});

const buildSnapshot = (capturedAt: string): CrewSnapshot => ({
  bank: [],
  capturedAt,
  characters: [],
});

const buildOutcome = (
  characterName: string,
  goalId: string,
  type: 'cancelled' | 'completed' = 'completed',
): ActivityRunOutcome<TestActivityError> => ({
  event: { characterName, goalId, type },
});

const buildBlockedOutcome = (
  characterName: string,
  goalId: string,
  error: TestActivityError,
): ActivityRunOutcome<TestActivityError> => ({
  error,
  event: { characterName, goalId, type: 'blocked' },
});

describe('createActivityEventProcessor', () => {
  it('releases a completed Activity and refreshes the Crew Snapshot', async () => {
    const initialSnapshot = buildSnapshot('2026-07-15T12:00:00.000Z');
    const refreshedSnapshot = buildSnapshot('2026-07-15T12:01:00.000Z');
    const refreshSnapshot = vi.fn(() => okAsync(refreshedSnapshot));
    const processor = createActivityEventProcessor<
      TestActivityError,
      TestSnapshotError
    >(buildState(), initialSnapshot, refreshSnapshot);

    const result = await processor.process(buildOutcome('Stan', 'goal-stan'));

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual<
      ProcessedActivity<TestActivityError>
    >({
      outcome: buildOutcome('Stan', 'goal-stan'),
      snapshot: refreshedSnapshot,
      state: {
        goals: buildState().goals,
        reservations: [buildAssignment('Kyle', 'goal-kyle')],
      },
    });
    expect(processor.getSnapshot()).toBe(refreshedSnapshot);
    expect(processor.getState().goals).toEqual(buildState().goals);
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
  });

  it('preserves Blocker details for the next policy decision', async () => {
    const blocker = new TestActivityError('missing material');
    const outcome = buildBlockedOutcome('Stan', 'goal-stan', blocker);
    const processor = createActivityEventProcessor<
      TestActivityError,
      TestSnapshotError
    >(buildState(), buildSnapshot('2026-07-15T12:00:00.000Z'), () =>
      okAsync(buildSnapshot('2026-07-15T12:01:00.000Z')),
    );

    const result = await processor.process(outcome);

    expect(result.isOk() && result.value.outcome).toBe(outcome);
    expect(result.isOk() && 'error' in result.value.outcome).toBe(true);
    expect(
      result.isOk() &&
        'error' in result.value.outcome &&
        result.value.outcome.error,
    ).toBe(blocker);
    expect(processor.getState().goals).toEqual(buildState().goals);
  });

  it('serializes simultaneous outcomes against the latest state', async () => {
    const firstRefresh = createDeferred<CrewSnapshot>();
    const secondRefresh = createDeferred<CrewSnapshot>();
    const toSnapshotResult = (promise: Promise<CrewSnapshot>) =>
      ResultAsync.fromPromise(
        promise,
        () => new TestSnapshotError('refresh failed'),
      );
    const refreshSnapshot = vi
      .fn<() => ResultAsync<CrewSnapshot, TestSnapshotError>>()
      .mockReturnValueOnce(toSnapshotResult(firstRefresh.promise))
      .mockReturnValueOnce(toSnapshotResult(secondRefresh.promise));
    const processor = createActivityEventProcessor<
      TestActivityError,
      TestSnapshotError
    >(buildState(), buildSnapshot('2026-07-15T12:00:00.000Z'), refreshSnapshot);

    const stanProcessing = processor.process(buildOutcome('Stan', 'goal-stan'));
    const kyleProcessing = processor.process(buildOutcome('Kyle', 'goal-kyle'));

    await Promise.resolve();
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(processor.getState().reservations).toEqual([
      buildAssignment('Kyle', 'goal-kyle'),
    ]);

    firstRefresh.resolve(buildSnapshot('2026-07-15T12:01:00.000Z'));
    await stanProcessing;
    await Promise.resolve();
    expect(refreshSnapshot).toHaveBeenCalledTimes(2);
    expect(processor.getState().reservations).toEqual([]);

    secondRefresh.resolve(buildSnapshot('2026-07-15T12:02:00.000Z'));
    const kyleResult = await kyleProcessing;

    expect(kyleResult.isOk() && kyleResult.value.snapshot.capturedAt).toBe(
      '2026-07-15T12:02:00.000Z',
    );
  });

  it('keeps the released state and previous snapshot when refresh fails', async () => {
    const initialSnapshot = buildSnapshot('2026-07-15T12:00:00.000Z');
    const refreshError = new TestSnapshotError('refresh failed');
    const processor = createActivityEventProcessor<
      TestActivityError,
      TestSnapshotError
    >(buildState(), initialSnapshot, () => errAsync(refreshError));

    const result = await processor.process(buildOutcome('Stan', 'goal-stan'));

    expect(result.isErr() && result.error).toBe(refreshError);
    expect(processor.getState().reservations).toEqual([
      buildAssignment('Kyle', 'goal-kyle'),
    ]);
    expect(processor.getSnapshot()).toBe(initialSnapshot);
  });

  it('rejects an invalid event without refreshing or changing state', async () => {
    const initialState = buildState();
    const refreshSnapshot = vi.fn(() =>
      okAsync(buildSnapshot('2026-07-15T12:01:00.000Z')),
    );
    const processor = createActivityEventProcessor<
      TestActivityError,
      TestSnapshotError
    >(initialState, buildSnapshot('2026-07-15T12:00:00.000Z'), refreshSnapshot);

    const result = await processor.process(
      buildOutcome('Butters', 'goal-stan'),
    );

    expect(result.isErr()).toBe(true);
    expect(processor.getState()).toBe(initialState);
    expect(refreshSnapshot).not.toHaveBeenCalled();
  });

  it('continues processing after an expected event error', async () => {
    const refreshedSnapshot = buildSnapshot('2026-07-15T12:01:00.000Z');
    const processor = createActivityEventProcessor<
      TestActivityError,
      TestSnapshotError
    >(buildState(), buildSnapshot('2026-07-15T12:00:00.000Z'), () =>
      okAsync(refreshedSnapshot),
    );

    await processor.process(buildOutcome('Butters', 'goal-stan'));
    const result = await processor.process(buildOutcome('Stan', 'goal-stan'));

    expect(result.isOk() && result.value.snapshot).toBe(refreshedSnapshot);
    expect(processor.getState().reservations).toEqual([
      buildAssignment('Kyle', 'goal-kyle'),
    ]);
  });
});
