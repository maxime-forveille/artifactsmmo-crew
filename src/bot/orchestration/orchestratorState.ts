import type { components } from '../../client/schema.js';
import type { Activity } from '../activities/activity.js';

import type { GoalRuleName } from './goalRule.js';

export type EquipItemGoal = Readonly<{
  characterName: string;
  id: string;
  itemCode: string;
  type: 'equipItem';
}>;

export type ReachCombatLevelGoal = Readonly<{
  characterName: string;
  id: string;
  targetLevel: number;
  type: 'reachCombatLevel';
}>;

export type ReachProfessionLevelGoal = Readonly<{
  characterName: string;
  id: string;
  skill: components['schemas']['CraftSkill'];
  targetLevel: number;
  type: 'reachProfessionLevel';
}>;

export type ProduceItemGoal = Readonly<{
  id: string;
  itemCode: string;
  minimumBankQuantity: number;
  type: 'produceItem';
}>;

export type ReplenishBankItemGoal = Readonly<{
  id: string;
  itemCode: string;
  minimumBankQuantity: number;
  /** Preferred source when policy has already selected one. */
  monsterCode?: string | undefined;
  /** Preferred source when policy has already selected one. */
  resourceCode?: string | undefined;
  type: 'replenishBankItem';
}>;

export type Goal =
  | EquipItemGoal
  | ProduceItemGoal
  | ReachCombatLevelGoal
  | ReachProfessionLevelGoal
  | ReplenishBankItemGoal;

export type ActiveGoal = Goal &
  Readonly<
    | { origin: 'configured' | 'override' }
    | { origin: 'autonomous'; reason: string; rule: GoalRuleName }
    | {
        origin: 'prerequisite';
        parentGoalId: string;
        reason: string;
        rule: GoalRuleName;
      }
  >;

export type ItemIntent = Readonly<{
  itemCode: string;
  /** Absent when an Activity's bounded output cannot be known in advance. */
  quantity?: number;
}>;

export type ActivityAssignment<TActivity extends Activity = Activity> =
  Readonly<{
    activity: TActivity;
    characterName: string;
    consumes: readonly ItemIntent[];
    goalId: string;
    produces: readonly ItemIntent[];
  }>;

export type Reservation = ActivityAssignment;

export type OrchestratorState = Readonly<{
  /** Goals are ordered from highest to lowest priority. */
  goals: readonly ActiveGoal[];
  reservations: readonly Reservation[];
}>;
