import type { Activity } from "../activities/activity.js";

export type ReplenishBankItemGoal = Readonly<{
  id: string;
  itemCode: string;
  minimumBankQuantity: number;
  type: "replenishBankItem";
}>;

export type Goal = ReplenishBankItemGoal;

export type ItemIntent = Readonly<{
  itemCode: string;
}>;

export type ActivityAssignment = Readonly<{
  activity: Activity;
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
