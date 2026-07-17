import { err, ok, type Result } from 'neverthrow';

import { proposeCombatProgressionGoals } from './combatProgressionGoalRule.js';
import type { CrewSnapshot } from './crewSnapshot.js';
import type { PreviousActivityOutcome } from './equipmentProgression.js';
import {
  createGoalActivityPlanner,
  type GoalActivityPlanner,
  type GoalActivityPlannerError,
} from './goalActivityPlanner.js';
import {
  createGoalPolicy,
  type GoalPolicy,
  type GoalPolicyConfig,
} from './goalPolicy.js';
import {
  acceptGoalProposals,
  type GoalProposalParentNotFoundError,
} from './goalProposalAcceptance.js';
import type {
  ActivityAssignment,
  OrchestratorState,
} from './orchestratorState.js';
import type { WorldKnowledge } from './worldKnowledge.js';

export type OrchestrationPlan = Readonly<{
  activities: readonly ActivityAssignment[];
  state: OrchestratorState;
}>;

export type OrchestratorError =
  | GoalActivityPlannerError
  | GoalProposalParentNotFoundError;

export type Orchestrator = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  previousOutcome?: PreviousActivityOutcome,
) => Result<OrchestrationPlan, OrchestratorError>;

type OrchestratorDependencies = Readonly<{
  planGoalActivities?: GoalActivityPlanner;
  proposeGoals?: GoalPolicy;
}>;

const createProgressionGoalPolicy = (config: GoalPolicyConfig): GoalPolicy =>
  createGoalPolicy(config, {
    combatProgression: proposeCombatProgressionGoals,
  });

const acceptProposedGoals = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  proposalState: OrchestratorState,
  world: WorldKnowledge,
  proposeGoals: GoalPolicy,
): Result<OrchestratorState, GoalProposalParentNotFoundError> =>
  acceptGoalProposals(
    state,
    proposeGoals({ snapshot, state: proposalState, world }),
  );

const withPlanningReservations = (
  state: OrchestratorState,
  activities: readonly ActivityAssignment[],
): OrchestratorState => ({
  goals: state.goals,
  reservations: [...state.reservations, ...activities],
});

/**
 * Combines autonomous Goal proposal with bounded Activity planning. A second
 * policy pass replaces Goals completed against this Snapshot while treating
 * Activities from the first pass as temporary Reservations.
 */
export const createOrchestrator = (
  world: WorldKnowledge,
  policyConfig?: GoalPolicyConfig,
  dependencies: OrchestratorDependencies = {},
): Orchestrator => {
  const planGoalActivities =
    dependencies.planGoalActivities ?? createGoalActivityPlanner(world);

  if (policyConfig === undefined) {
    return planGoalActivities;
  }

  const proposeGoals =
    dependencies.proposeGoals ?? createProgressionGoalPolicy(policyConfig);

  return (snapshot, state, previousOutcome) => {
    const acceptedBeforePlanning = acceptProposedGoals(
      snapshot,
      state,
      state,
      world,
      proposeGoals,
    );
    if (acceptedBeforePlanning.isErr()) {
      return err(acceptedBeforePlanning.error);
    }

    const firstPlan = planGoalActivities(
      snapshot,
      acceptedBeforePlanning.value,
      previousOutcome,
    );
    if (firstPlan.isErr()) {
      return err(firstPlan.error);
    }

    const planningState = withPlanningReservations(
      firstPlan.value.state,
      firstPlan.value.activities,
    );
    const acceptedAfterPlanning = acceptProposedGoals(
      snapshot,
      firstPlan.value.state,
      planningState,
      world,
      proposeGoals,
    );
    if (acceptedAfterPlanning.isErr()) {
      return err(acceptedAfterPlanning.error);
    }

    if (acceptedAfterPlanning.value === firstPlan.value.state) {
      return ok(firstPlan.value);
    }

    const followUpPlan = planGoalActivities(
      snapshot,
      {
        goals: acceptedAfterPlanning.value.goals,
        reservations: planningState.reservations,
      },
      previousOutcome,
    );
    if (followUpPlan.isErr()) {
      return err(followUpPlan.error);
    }

    return ok({
      activities: [
        ...firstPlan.value.activities,
        ...followUpPlan.value.activities,
      ],
      state: {
        goals: followUpPlan.value.state.goals,
        reservations: firstPlan.value.state.reservations,
      },
    });
  };
};
