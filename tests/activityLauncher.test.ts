import { errAsync, okAsync, type ResultAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import type {
  ActivityAssignment,
  OrchestratorState,
} from '../src/bot/orchestration/orchestratorState.js';
import type { ExecutableActivity } from '../src/bot/runtime/activityDispatcher.js';
import {
  launchActivity,
  type ActivityFailureDisposition,
} from '../src/bot/runtime/activityLauncher.js';

class TestActivityError extends Error {
  constructor(public readonly disposition: ActivityFailureDisposition) {
    super(`Activity ${disposition}`);
    this.name = 'TestActivityError';
  }
}

const buildAssignment = (
  overrides: Partial<ActivityAssignment<ExecutableActivity>> = {},
): ActivityAssignment<ExecutableActivity> => ({
  activity: { resourceCode: 'copper_rocks', type: 'farmResource' },
  characterName: 'Stan',
  consumes: [],
  goalId: 'replenish-copper',
  produces: [{ itemCode: 'copper_ore' }],
  ...overrides,
});

const buildState = (
  overrides: Partial<OrchestratorState> = {},
): OrchestratorState => ({
  goals: [
    {
      id: 'replenish-copper',
      itemCode: 'copper_ore',
      minimumBankQuantity: 50,
      origin: 'configured',
      type: 'replenishBankItem',
    },
  ],
  reservations: [],
  ...overrides,
});

const buildDependencies = () => ({
  classifyFailure: vi.fn((error: TestActivityError) => error.disposition),
  execute: vi.fn(
    (_activity: ExecutableActivity): ResultAsync<void, TestActivityError> =>
      okAsync(undefined),
  ),
  waitBeforeRetry: vi.fn(async () => undefined),
});

describe('launchActivity', () => {
  it('reserves an idle character and starts the assigned Activity', async () => {
    const assignment = buildAssignment();
    const dependencies = buildDependencies();
    const state = buildState();

    const result = launchActivity(state, assignment, dependencies);

    expect(result.isOk()).toBe(true);
    const launched = result._unsafeUnwrap();
    expect(launched.assignment).toBe(assignment);
    expect(launched.state).toEqual({
      goals: state.goals,
      reservations: [assignment],
    });
    expect(dependencies.execute).toHaveBeenCalledWith(assignment.activity);
    expect(await launched.completion).toEqual({
      event: {
        characterName: 'Stan',
        goalId: 'replenish-copper',
        type: 'completed',
      },
    });
    expect(state.reservations).toEqual([]);
  });

  it('does not start an Activity when its Goal no longer exists', () => {
    const dependencies = buildDependencies();
    const state = buildState({ goals: [] });

    const result = launchActivity(state, buildAssignment(), dependencies);

    expect(result.isErr()).toBe(true);
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it('does not start a second Activity for an already reserved character', () => {
    const assignment = buildAssignment();
    const dependencies = buildDependencies();
    const state = buildState({ reservations: [assignment] });

    const result = launchActivity(state, assignment, dependencies);

    expect(result.isErr()).toBe(true);
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it('returns a Blocker without retrying the Activity', async () => {
    const blocker = new TestActivityError('blocked');
    const dependencies = buildDependencies();
    dependencies.execute.mockReturnValue(errAsync(blocker));

    const result = launchActivity(
      buildState(),
      buildAssignment(),
      dependencies,
    );
    const outcome = await result._unsafeUnwrap().completion;

    expect(outcome).toEqual({
      error: blocker,
      event: {
        characterName: 'Stan',
        goalId: 'replenish-copper',
        type: 'blocked',
      },
    });
    expect(dependencies.execute).toHaveBeenCalledTimes(1);
    expect(dependencies.waitBeforeRetry).not.toHaveBeenCalled();
  });

  it('retries a Transient Failure without invoking policy again', async () => {
    const transient = new TestActivityError('transient');
    const dependencies = buildDependencies();
    dependencies.execute
      .mockReturnValueOnce(errAsync(transient))
      .mockReturnValueOnce(okAsync(undefined));

    const result = launchActivity(
      buildState(),
      buildAssignment(),
      dependencies,
    );
    const launched = result._unsafeUnwrap();
    const outcome = await launched.completion;

    expect(outcome.event.type).toBe('completed');
    expect(launched.state.reservations).toEqual([buildAssignment()]);
    expect(dependencies.classifyFailure).toHaveBeenCalledWith(transient);
    expect(dependencies.execute).toHaveBeenCalledTimes(2);
    expect(dependencies.waitBeforeRetry).toHaveBeenCalledTimes(1);
  });

  it('emits Cancellation before starting an aborted Activity', async () => {
    const controller = new AbortController();
    const dependencies = buildDependencies();
    controller.abort();

    const result = launchActivity(
      buildState(),
      buildAssignment(),
      dependencies,
      controller.signal,
    );
    const outcome = await result._unsafeUnwrap().completion;

    expect(outcome).toEqual({
      event: {
        characterName: 'Stan',
        goalId: 'replenish-copper',
        type: 'cancelled',
      },
    });
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it('emits Cancellation instead of retrying after an abort', async () => {
    const controller = new AbortController();
    const transient = new TestActivityError('transient');
    const dependencies = buildDependencies();
    dependencies.execute.mockReturnValue(errAsync(transient));
    dependencies.waitBeforeRetry.mockImplementation(async () => {
      controller.abort();
    });

    const result = launchActivity(
      buildState(),
      buildAssignment(),
      dependencies,
      controller.signal,
    );
    const outcome = await result._unsafeUnwrap().completion;

    expect(outcome.event.type).toBe('cancelled');
    expect(dependencies.execute).toHaveBeenCalledTimes(1);
    expect(dependencies.waitBeforeRetry).toHaveBeenCalledTimes(1);
  });
});
