import { err, ok, type Result } from "neverthrow";

import type { components } from "../../client/schema.js";
import type { ActivityAssignment, OrchestratorState } from "./orchestratorState.js";
import type { CrewSnapshot } from "./crewSnapshot.js";
import {
  planEquipmentProgression,
  type EquipmentProgressionError,
  type PreviousActivityOutcome,
} from "./equipmentProgression.js";
import {
  planResourceReplenishment,
  type Resource,
  type ResourceReplenishmentError,
} from "./resourceReplenishment.js";

type Item = Readonly<components["schemas"]["ItemSchema"]>;

type ConfiguredGoalPlan = Readonly<{
  activities: readonly ActivityAssignment[];
  state: OrchestratorState;
}>;

export type ResolvedGoalItem = Readonly<{
  goalId: string;
  item: Item;
}>;

export type ResolvedGoalResource = Readonly<{
  goalId: string;
  resource: Resource;
}>;

export class GoalItemNotResolvedError extends Error {
  constructor(public readonly goalId: string) {
    super(`No item was resolved for Goal "${goalId}"`);
    this.name = "GoalItemNotResolvedError";
  }
}

export class GoalResourceNotResolvedError extends Error {
  constructor(public readonly goalId: string) {
    super(`No resource was resolved for Goal "${goalId}"`);
    this.name = "GoalResourceNotResolvedError";
  }
}

export type ConfiguredGoalPlannerError =
  | EquipmentProgressionError
  | GoalItemNotResolvedError
  | GoalResourceNotResolvedError
  | ResourceReplenishmentError;

export type ConfiguredGoalPlanner = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  previousOutcome?: PreviousActivityOutcome,
) => Result<ConfiguredGoalPlan, ConfiguredGoalPlannerError>;

/**
 * Plans every configured Goal in global priority order. Proposed assignments
 * act as temporary Reservations while the same decision examines later Goals.
 */
export const createConfiguredGoalPlanner = (
  resolvedItems: readonly ResolvedGoalItem[],
  resolvedResources: readonly ResolvedGoalResource[],
): ConfiguredGoalPlanner => {
  const itemsByGoalId = new Map(resolvedItems.map(({ goalId, item }) => [goalId, item]));
  const resourcesByGoalId = new Map(
    resolvedResources.map(({ goalId, resource }) => [goalId, resource]),
  );

  return (snapshot, state, previousOutcome) => {
    const activities: ActivityAssignment[] = [];
    const completedGoalIds = new Set<string>();
    const planningReservations = [...state.reservations];

    for (const goal of state.goals) {
      const planningState = { goals: [goal], reservations: planningReservations };
      const planned =
        goal.type === "equipItem"
          ? (() => {
              const item = itemsByGoalId.get(goal.id);

              return item === undefined
                ? err(new GoalItemNotResolvedError(goal.id))
                : planEquipmentProgression(snapshot, planningState, item, previousOutcome);
            })()
          : (() => {
              const resource = resourcesByGoalId.get(goal.id);

              return resource === undefined
                ? err(new GoalResourceNotResolvedError(goal.id))
                : planResourceReplenishment(snapshot, planningState, resource);
            })();

      if (planned.isErr()) {
        return err(planned.error);
      }

      if (planned.value.state.goals.length === 0) {
        completedGoalIds.add(goal.id);
      }

      activities.push(...planned.value.activities);
      planningReservations.push(...planned.value.activities);
    }

    return ok({
      activities,
      state: {
        goals: state.goals.filter((goal) => !completedGoalIds.has(goal.id)),
        reservations: state.reservations,
      },
    });
  };
};
