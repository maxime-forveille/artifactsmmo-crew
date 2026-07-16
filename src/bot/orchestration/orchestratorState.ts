import type { Activity } from '../activities/activity.js';

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

export type ReplenishBankItemGoal = Readonly<{
  id: string;
  itemCode: string;
  minimumBankQuantity: number;
  type: 'replenishBankItem';
}>;

export type Goal = EquipItemGoal | ReachCombatLevelGoal | ReplenishBankItemGoal;

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
  goals: readonly Goal[];
  reservations: readonly Reservation[];
}>;
