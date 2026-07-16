import { err, ok, type Result } from 'neverthrow';

import type {
  ActivityAssignment,
  OrchestratorState,
} from './orchestratorState.js';

export type ActivityTerminalEvent = Readonly<{
  characterName: string;
  goalId: string;
  type: 'blocked' | 'cancelled' | 'completed';
}>;

export class GoalNotFoundError extends Error {
  constructor(public readonly goalId: string) {
    super(`Goal "${goalId}" does not exist`);
    this.name = 'GoalNotFoundError';
  }
}

export class CharacterAlreadyReservedError extends Error {
  constructor(public readonly characterName: string) {
    super(`Character "${characterName}" already has a Reservation`);
    this.name = 'CharacterAlreadyReservedError';
  }
}

export class ReservationNotFoundError extends Error {
  constructor(public readonly characterName: string) {
    super(`Character "${characterName}" has no active Reservation`);
    this.name = 'ReservationNotFoundError';
  }
}

export class ReservationGoalMismatchError extends Error {
  constructor(
    public readonly characterName: string,
    public readonly expectedGoalId: string,
    public readonly receivedGoalId: string,
  ) {
    super(
      `Character "${characterName}" is reserved for Goal "${expectedGoalId}", not "${receivedGoalId}"`,
    );
    this.name = 'ReservationGoalMismatchError';
  }
}

export type StartActivityError =
  | CharacterAlreadyReservedError
  | GoalNotFoundError;
export type FinishActivityError =
  | ReservationGoalMismatchError
  | ReservationNotFoundError;

/** Records an Activity only after the runtime has started it successfully. */
export const reserveStartedActivity = (
  state: OrchestratorState,
  assignment: ActivityAssignment,
): Result<OrchestratorState, StartActivityError> => {
  if (!state.goals.some((goal) => goal.id === assignment.goalId)) {
    return err(new GoalNotFoundError(assignment.goalId));
  }

  if (
    state.reservations.some(
      (reservation) => reservation.characterName === assignment.characterName,
    )
  ) {
    return err(new CharacterAlreadyReservedError(assignment.characterName));
  }

  return ok({
    goals: state.goals,
    reservations: [...state.reservations, assignment],
  });
};

/**
 * Releases a terminal Activity while preserving its Goal for the next snapshot
 * and policy decision. Transient failures do not call this transition.
 */
export const finishActivity = (
  state: OrchestratorState,
  event: ActivityTerminalEvent,
): Result<OrchestratorState, FinishActivityError> => {
  const reservation = state.reservations.find(
    (candidate) => candidate.characterName === event.characterName,
  );

  if (reservation === undefined) {
    return err(new ReservationNotFoundError(event.characterName));
  }

  if (reservation.goalId !== event.goalId) {
    return err(
      new ReservationGoalMismatchError(
        event.characterName,
        reservation.goalId,
        event.goalId,
      ),
    );
  }

  return ok({
    goals: state.goals,
    reservations: state.reservations.filter(
      (candidate) => candidate.characterName !== event.characterName,
    ),
  });
};
