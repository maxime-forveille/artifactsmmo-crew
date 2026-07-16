import { err, ok, okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { GoalNotFoundError } from '../src/bot/orchestration/activityLifecycle.js';
import type { CrewSnapshot } from '../src/bot/orchestration/crewSnapshot.js';
import type {
  ActivityAssignment,
  OrchestratorState,
  ReplenishBankItemGoal,
} from '../src/bot/orchestration/orchestratorState.js';
import type { ExecutableActivity } from '../src/bot/runtime/activityDispatcher.js';
import { launchActivity } from '../src/bot/runtime/activityLauncher.js';
import {
  scheduleActivities,
  type ActivityPlan,
  type ActivityPlanner,
} from '../src/bot/runtime/activityScheduler.js';

class TestActivityError extends Error {}
class TestPlanError extends Error {}

const buildGoal = (id: string, itemCode: string): ReplenishBankItemGoal => ({
  id,
  itemCode,
  minimumBankQuantity: 50,
  type: 'replenishBankItem',
});

const buildAssignment = (
  characterName: string,
  goalId: string,
  resourceCode = 'copper_rocks',
): ActivityAssignment<ExecutableActivity> => ({
  activity: { resourceCode, type: 'farmResource' },
  characterName,
  consumes: [],
  goalId,
  produces: [{ itemCode: 'copper_ore' }],
});

const buildState = (
  overrides: Partial<OrchestratorState> = {},
): OrchestratorState => ({
  goals: [
    buildGoal('goal-copper', 'copper_ore'),
    buildGoal('goal-ash', 'ash_wood'),
  ],
  reservations: [],
  ...overrides,
});

const buildSnapshot = (
  capturedAt = '2026-07-15T12:00:00.000Z',
): CrewSnapshot => ({ bank: [], capturedAt, characters: [] });

const buildStarter = () => {
  const execute = vi.fn(() => okAsync<void, TestActivityError>(undefined));
  const start = vi.fn(
    (
      state: OrchestratorState,
      assignment: ActivityAssignment<ExecutableActivity>,
    ) =>
      launchActivity(state, assignment, {
        classifyFailure: () => 'transient',
        execute,
        waitBeforeRetry: async () => undefined,
      }),
  );

  return { execute, start };
};

const successfulPlanner =
  (activities: ActivityPlan['activities']): ActivityPlanner<TestPlanError> =>
  (_snapshot, state) =>
    ok({ activities, state });

describe('scheduleActivities', () => {
  it('plans from the current snapshot and starts the proposed Activity', async () => {
    const assignment = buildAssignment('Stan', 'goal-copper');
    const snapshot = buildSnapshot();
    const state = buildState();
    const plan = vi.fn(successfulPlanner([assignment]));
    const { execute, start } = buildStarter();

    const result = scheduleActivities(snapshot, state, plan, start);

    expect(result.isOk()).toBe(true);
    const scheduled = result._unsafeUnwrap();
    expect(plan).toHaveBeenCalledWith(snapshot, state);
    expect(start).toHaveBeenCalledWith(state, assignment);
    expect(scheduled.state.reservations).toEqual([assignment]);
    expect(scheduled.running).toHaveLength(1);
    expect((await scheduled.running[0]?.completion)?.event.type).toBe(
      'completed',
    );
    expect(execute).toHaveBeenCalledWith(assignment.activity);
  });

  it('keeps a policy state change when no Activity is proposed', () => {
    const state = buildState();
    const plannedState = { goals: state.goals.slice(1), reservations: [] };
    const plan: ActivityPlanner<TestPlanError> = () =>
      ok({ activities: [], state: plannedState });
    const { start } = buildStarter();

    const result = scheduleActivities(buildSnapshot(), state, plan, start);

    expect(result.isOk() && result.value).toEqual({
      running: [],
      state: plannedState,
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('starts several valid assignments against each preceding Reservation', () => {
    const stan = buildAssignment('Stan', 'goal-copper');
    const kyle = buildAssignment('Kyle', 'goal-ash', 'ash_tree');
    const state = buildState();
    const { start } = buildStarter();

    const result = scheduleActivities(
      buildSnapshot(),
      state,
      successfulPlanner([stan, kyle]),
      start,
    );

    expect(result.isOk() && result.value.state.reservations).toEqual([
      stan,
      kyle,
    ]);
    expect(start).toHaveBeenNthCalledWith(1, state, stan);
    expect(start).toHaveBeenNthCalledWith(
      2,
      { goals: state.goals, reservations: [stan] },
      kyle,
    );
  });

  it('validates the whole plan before starting any Activity', () => {
    const stan = buildAssignment('Stan', 'goal-copper');
    const duplicateStan = buildAssignment('Stan', 'goal-ash', 'ash_tree');
    const { start } = buildStarter();

    const result = scheduleActivities(
      buildSnapshot(),
      buildState(),
      successfulPlanner([stan, duplicateStan]),
      start,
    );

    expect(result.isErr()).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it('returns a start failure without reporting the Activity as running', () => {
    const assignment = buildAssignment('Stan', 'goal-copper');
    const startError = new GoalNotFoundError('goal-copper');
    const start = vi.fn(() => err(startError));

    const result = scheduleActivities(
      buildSnapshot(),
      buildState(),
      successfulPlanner([assignment]),
      start,
    );

    expect(result.isErr() && result.error).toBe(startError);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not start anything when policy fails', () => {
    const planError = new TestPlanError('planning failed');
    const plan: ActivityPlanner<TestPlanError> = () => err(planError);
    const { start } = buildStarter();

    const result = scheduleActivities(
      buildSnapshot(),
      buildState(),
      plan,
      start,
    );

    expect(result.isErr() && result.error).toBe(planError);
    expect(start).not.toHaveBeenCalled();
  });
});
