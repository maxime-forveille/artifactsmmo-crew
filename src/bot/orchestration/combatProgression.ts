import { err, ok, type Result } from 'neverthrow';

import type { FightMonsterActivity } from '../activities/activity.js';
import { isSafeToFight } from '../combat.js';

import type { CrewSnapshot } from './crewSnapshot.js';
import type {
  ActivityAssignment,
  OrchestratorState,
} from './orchestratorState.js';
import type { WorldKnowledge } from './worldKnowledge.js';

type Character = CrewSnapshot['characters'][number];
type Monster = WorldKnowledge['monsters'][number];
type CombatKnowledge = Pick<WorldKnowledge, 'monsters'>;

export class CombatCharacterNotFoundError extends Error {
  constructor(public readonly characterName: string) {
    super(`Character "${characterName}" does not exist in the Crew Snapshot`);
    this.name = 'CombatCharacterNotFoundError';
  }
}

export class NoSafeCombatTargetError extends Error {
  constructor(
    public readonly characterName: string,
    public readonly characterLevel: number,
  ) {
    super(
      `No safe combat target exists for ${characterName} at level ${characterLevel}`,
    );
    this.name = 'NoSafeCombatTargetError';
  }
}

export type CombatProgressionError =
  | CombatCharacterNotFoundError
  | NoSafeCombatTargetError;

export type CombatProgressionPlan = Readonly<{
  activities: readonly ActivityAssignment<FightMonsterActivity>[];
  state: OrchestratorState;
}>;

const afterRest = (character: Character): Character => ({
  ...character,
  hp: character.max_hp,
});

/**
 * Selects the highest-level safe target, with monster code as a stable
 * tie-breaker.
 */
export const findBestCombatTarget = (
  character: Character,
  monsters: readonly Monster[],
): Monster | undefined =>
  monsters
    .filter(
      (monster) =>
        monster.level <= character.level &&
        isSafeToFight(afterRest(character), monster),
    )
    .toSorted(
      (left, right) =>
        right.level - left.level || left.code.localeCompare(right.code),
    )[0];

const unchangedPlan = (state: OrchestratorState): CombatProgressionPlan => ({
  activities: [],
  state,
});

/** Advances one combat-level Goal with at most one selected combat Activity. */
export const planCombatProgression = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  knowledge: CombatKnowledge,
): Result<CombatProgressionPlan, CombatProgressionError> => {
  const goal = state.goals[0];

  if (goal === undefined || goal.type !== 'reachCombatLevel') {
    return ok(unchangedPlan(state));
  }

  const character = snapshot.characters.find(
    (candidate) => candidate.name === goal.characterName,
  );

  if (character === undefined) {
    return err(new CombatCharacterNotFoundError(goal.characterName));
  }

  if (character.level >= goal.targetLevel) {
    return ok({
      activities: [],
      state: {
        goals: state.goals.filter((candidate) => candidate.id !== goal.id),
        reservations: state.reservations,
      },
    });
  }

  if (
    state.reservations.some(
      (reservation) =>
        reservation.goalId === goal.id ||
        reservation.characterName === goal.characterName,
    )
  ) {
    return ok(unchangedPlan(state));
  }

  const monster = findBestCombatTarget(character, knowledge.monsters);

  if (monster === undefined) {
    return err(new NoSafeCombatTargetError(character.name, character.level));
  }

  return ok({
    activities: [
      {
        activity: { monsterCode: monster.code, type: 'fightMonster' },
        characterName: character.name,
        consumes: [],
        goalId: goal.id,
        produces: [],
      },
    ],
    state,
  });
};
