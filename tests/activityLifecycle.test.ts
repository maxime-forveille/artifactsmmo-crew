import { describe, expect, it } from 'vitest';

import {
  CharacterAlreadyReservedError,
  finishActivity,
  GoalNotFoundError,
  ReservationGoalMismatchError,
  ReservationNotFoundError,
  reserveStartedActivity,
  type ActivityTerminalEvent,
} from '../src/bot/orchestration/activityLifecycle.js';
import type {
  ActivityAssignment,
  OrchestratorState,
  ReplenishBankItemGoal,
} from '../src/bot/orchestration/orchestratorState.js';

const buildGoal = (
  id: string,
  overrides: Partial<ReplenishBankItemGoal> = {},
): ReplenishBankItemGoal => ({
  id,
  itemCode: 'copper_ore',
  minimumBankQuantity: 50,
  type: 'replenishBankItem',
  ...overrides,
});

const buildAssignment = (
  overrides: Partial<ActivityAssignment> = {},
): ActivityAssignment => ({
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
  goals: [buildGoal('replenish-copper')],
  reservations: [],
  ...overrides,
});

const buildTerminalEvent = (
  overrides: Partial<ActivityTerminalEvent> = {},
): ActivityTerminalEvent => ({
  characterName: 'Stan',
  goalId: 'replenish-copper',
  type: 'completed',
  ...overrides,
});

describe('reserveStartedActivity', () => {
  it('adds a started Activity as a Reservation without mutating the state', () => {
    const assignment = buildAssignment();
    const state = buildState();

    const result = reserveStartedActivity(state, assignment);

    expect(result.isOk() && result.value).toEqual({
      goals: state.goals,
      reservations: [assignment],
    });
    expect(state).toEqual(buildState());
  });

  it('allows different characters to work toward the same crew Goal', () => {
    const existing = buildAssignment({ characterName: 'Stan' });
    const assignment = buildAssignment({ characterName: 'Kyle' });
    const state = buildState({ reservations: [existing] });

    const result = reserveStartedActivity(state, assignment);

    expect(result.isOk() && result.value.reservations).toEqual([
      existing,
      assignment,
    ]);
  });

  it('finds the assignment Goal among several crew Goals', () => {
    const assignment = buildAssignment();
    const state = buildState({
      goals: [buildGoal('another-goal'), buildGoal('replenish-copper')],
    });

    const result = reserveStartedActivity(state, assignment);

    expect(result.isOk() && result.value).toEqual({
      goals: state.goals,
      reservations: [assignment],
    });
  });

  it('rejects an assignment whose exact Goal no longer exists', () => {
    const state = buildState({ goals: [buildGoal('another-goal')] });

    const result = reserveStartedActivity(state, buildAssignment());

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(GoalNotFoundError);
    expect(error).toMatchObject({
      goalId: 'replenish-copper',
      message: 'Goal "replenish-copper" does not exist',
      name: 'GoalNotFoundError',
    });
    expect(state).toEqual(buildState({ goals: [buildGoal('another-goal')] }));
  });

  it('rejects a second Reservation for the same character', () => {
    const existing = buildAssignment();
    const state = buildState({ reservations: [existing] });

    const result = reserveStartedActivity(
      state,
      buildAssignment({ goalId: 'replenish-copper' }),
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(CharacterAlreadyReservedError);
    expect(error).toMatchObject({
      characterName: 'Stan',
      message: 'Character "Stan" already has a Reservation',
      name: 'CharacterAlreadyReservedError',
    });
    expect(state).toEqual(buildState({ reservations: [existing] }));
  });
});

describe('finishActivity', () => {
  it.each(['completed', 'blocked', 'cancelled'] as const)(
    'releases a %s Activity while preserving its Goal',
    (type) => {
      const reservation = buildAssignment();
      const otherReservation = buildAssignment({
        characterName: 'Kyle',
        goalId: 'other-goal',
      });
      const state = buildState({
        goals: [buildGoal('replenish-copper'), buildGoal('other-goal')],
        reservations: [otherReservation, reservation],
      });

      const result = finishActivity(state, buildTerminalEvent({ type }));

      expect(result.isOk() && result.value).toEqual({
        goals: state.goals,
        reservations: [otherReservation],
      });
      expect(state.reservations).toEqual([otherReservation, reservation]);
    },
  );

  it('rejects an event for a character without a Reservation', () => {
    const state = buildState();

    const result = finishActivity(state, buildTerminalEvent());

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(ReservationNotFoundError);
    expect(error).toMatchObject({
      characterName: 'Stan',
      message: 'Character "Stan" has no active Reservation',
      name: 'ReservationNotFoundError',
    });
  });

  it('does not release a Reservation when the event names another Goal', () => {
    const reservation = buildAssignment();
    const state = buildState({ reservations: [reservation] });

    const result = finishActivity(
      state,
      buildTerminalEvent({ goalId: 'another-goal' }),
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(ReservationGoalMismatchError);
    expect(error).toMatchObject({
      characterName: 'Stan',
      expectedGoalId: 'replenish-copper',
      message:
        'Character "Stan" is reserved for Goal "replenish-copper", not "another-goal"',
      name: 'ReservationGoalMismatchError',
      receivedGoalId: 'another-goal',
    });
    expect(state.reservations).toEqual([reservation]);
  });
});
