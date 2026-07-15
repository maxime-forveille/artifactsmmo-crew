import { err, ok, type Result } from "neverthrow";

import type { CrewSnapshot } from "./crewSnapshot.js";
import type { OrchestratorState } from "./orchestratorState.js";
import {
  planResourceReplenishment,
  type Resource,
  type ResourceReplenishmentError,
  type ResourceReplenishmentPlan,
} from "./resourceReplenishment.js";

export type ResolvedGoalResource = Readonly<{
  goalId: string;
  resource: Resource;
}>;

export class GoalResourceNotResolvedError extends Error {
  constructor(public readonly goalId: string) {
    super(`No resource was resolved for Goal "${goalId}"`);
    this.name = "GoalResourceNotResolvedError";
  }
}

export type ConfiguredResourceReplenishmentError =
  | GoalResourceNotResolvedError
  | ResourceReplenishmentError;

export type ConfiguredResourceReplenishmentPlanner = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
) => Result<ResourceReplenishmentPlan, ConfiguredResourceReplenishmentError>;

/**
 * Plans configured bank Goals in priority order. Proposed assignments act as
 * temporary Reservations while the same decision examines lower-priority Goals,
 * preventing one idle character from receiving several Activities at once.
 */
export const createConfiguredResourceReplenishmentPlanner = (
  resolvedResources: readonly ResolvedGoalResource[],
): ConfiguredResourceReplenishmentPlanner => {
  const resourcesByGoalId = new Map(
    resolvedResources.map(({ goalId, resource }) => [goalId, resource]),
  );

  return (snapshot, state) => {
    const activities: ResourceReplenishmentPlan["activities"][number][] = [];
    const completedGoalIds = new Set<string>();
    const planningReservations = [...state.reservations];

    for (const goal of state.goals) {
      const resource = resourcesByGoalId.get(goal.id);

      if (resource === undefined) {
        return err(new GoalResourceNotResolvedError(goal.id));
      }

      const planned = planResourceReplenishment(
        snapshot,
        { goals: [goal], reservations: planningReservations },
        resource,
      );

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
