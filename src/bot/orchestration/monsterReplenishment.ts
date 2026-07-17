import { err, ok, type Result } from 'neverthrow';

import type { components } from '../../client/schema.js';
import type { FightMonsterActivity } from '../activities/activity.js';
import { findBestSafeFighter } from '../combat.js';

import type { CrewSnapshot } from './crewSnapshot.js';
import type {
  ActivityAssignment,
  OrchestratorState,
  ReplenishBankItemGoal,
} from './orchestratorState.js';
import {
  isBankWithdrawalReserved,
  isItemProductionReserved,
  reservedBankWithdrawalQuantity,
} from './reservationIntents.js';

export type Monster = Readonly<components['schemas']['MonsterSchema']>;

export class InvalidMonsterTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMonsterTargetError';
  }
}

export class NoSafeMonsterFighterError extends Error {
  constructor(
    public readonly itemCode: string,
    public readonly monsterCode: string,
  ) {
    super(`No character can safely fight ${monsterCode} for ${itemCode}`);
    this.name = 'NoSafeMonsterFighterError';
  }
}

export type MonsterReplenishmentError =
  | InvalidMonsterTargetError
  | NoSafeMonsterFighterError;

export type MonsterReplenishmentPlan = Readonly<{
  activities: readonly ActivityAssignment<FightMonsterActivity>[];
  state: OrchestratorState;
}>;

const bankQuantity = (snapshot: CrewSnapshot, itemCode: string): number =>
  snapshot.bank
    .filter((item) => item.code === itemCode)
    .reduce((total, item) => total + item.quantity, 0);

const availableBankQuantity = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  itemCode: string,
): number =>
  Math.max(
    bankQuantity(snapshot, itemCode) -
      reservedBankWithdrawalQuantity(state, itemCode),
    0,
  );

const unchangedPlan = (state: OrchestratorState): MonsterReplenishmentPlan => ({
  activities: [],
  state,
});

const validateGoal = (
  goal: ReplenishBankItemGoal,
): Result<void, InvalidMonsterTargetError> =>
  goal.minimumBankQuantity > 0
    ? ok(undefined)
    : err(
        new InvalidMonsterTargetError(
          'minimumBankQuantity must be greater than zero',
        ),
      );

const validateMonster = (
  goal: ReplenishBankItemGoal,
  monster: Monster,
): Result<void, InvalidMonsterTargetError> =>
  monster.drops.some((drop) => drop.code === goal.itemCode)
    ? ok(undefined)
    : err(
        new InvalidMonsterTargetError(
          `${monster.code} does not drop ${goal.itemCode}`,
        ),
      );

/** Plans one safe combat Activity for a monster-backed bank replenishment Goal. */
export const planMonsterReplenishment = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  monster: Monster,
  activeReservations: readonly ActivityAssignment[] = state.reservations,
): Result<MonsterReplenishmentPlan, MonsterReplenishmentError> => {
  const goal = state.goals[0];

  if (goal === undefined || goal.type !== 'replenishBankItem') {
    return ok(unchangedPlan(state));
  }

  const goalValidation = validateGoal(goal);

  if (goalValidation.isErr()) {
    return err(goalValidation.error);
  }

  if (
    state.reservations.some((reservation) => reservation.goalId === goal.id)
  ) {
    return ok(unchangedPlan(state));
  }

  if (
    availableBankQuantity(snapshot, state, goal.itemCode) >=
    goal.minimumBankQuantity
  ) {
    return ok({
      activities: [],
      state: { goals: state.goals.slice(1), reservations: state.reservations },
    });
  }

  if (isItemProductionReserved(state, goal.itemCode)) {
    return ok(unchangedPlan(state));
  }

  const activeState = { goals: state.goals, reservations: activeReservations };

  if (isBankWithdrawalReserved(activeState, goal.itemCode)) {
    return ok(unchangedPlan(state));
  }

  const monsterValidation = validateMonster(goal, monster);

  if (monsterValidation.isErr()) {
    return err(monsterValidation.error);
  }

  const eligibleFighter = findBestSafeFighter(snapshot.characters, monster);

  if (eligibleFighter === undefined) {
    return err(new NoSafeMonsterFighterError(goal.itemCode, monster.code));
  }

  const reservedCharacterNames = new Set(
    state.reservations.map((reservation) => reservation.characterName),
  );
  const fighter = findBestSafeFighter(
    snapshot.characters,
    monster,
    reservedCharacterNames,
  );

  if (fighter === undefined) {
    return ok(unchangedPlan(state));
  }

  return ok({
    activities: [
      {
        activity: { monsterCode: monster.code, type: 'fightMonster' },
        characterName: fighter.name,
        consumes: [],
        goalId: goal.id,
        produces: [{ itemCode: goal.itemCode }],
      },
    ],
    state,
  });
};
