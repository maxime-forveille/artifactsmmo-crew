import { err, ok, type Result } from 'neverthrow';

import { areGoalsEquivalent, type GoalProposal } from './goalPolicy.js';
import type { OrchestratorState } from './orchestratorState.js';

export class GoalProposalParentNotFoundError extends Error {
  constructor(
    public readonly goalId: string,
    public readonly parentGoalId: string,
  ) {
    super(
      `Cannot accept Goal "${goalId}": parent Goal "${parentGoalId}" does not exist`,
    );
    this.name = 'GoalProposalParentNotFoundError';
  }
}

const acceptGoalProposal = (
  state: OrchestratorState,
  proposal: GoalProposal,
): Result<OrchestratorState, GoalProposalParentNotFoundError> => {
  if (state.goals.some((goal) => areGoalsEquivalent(goal, proposal.goal))) {
    return ok(state);
  }

  if (proposal.parentGoalId === undefined) {
    return ok({ ...state, goals: [...state.goals, proposal.goal] });
  }

  const parentIndex = state.goals.findIndex(
    (goal) => goal.id === proposal.parentGoalId,
  );

  if (parentIndex === -1) {
    return err(
      new GoalProposalParentNotFoundError(
        proposal.goal.id,
        proposal.parentGoalId,
      ),
    );
  }

  return ok({
    ...state,
    goals: state.goals.toSpliced(parentIndex, 0, proposal.goal),
  });
};

/** Persists selected Goals while preserving existing priority and parent Goals. */
export const acceptGoalProposals = (
  state: OrchestratorState,
  proposals: readonly GoalProposal[],
): Result<OrchestratorState, GoalProposalParentNotFoundError> =>
  proposals.reduce<Result<OrchestratorState, GoalProposalParentNotFoundError>>(
    (result, proposal) =>
      result.andThen((nextState) => acceptGoalProposal(nextState, proposal)),
    ok(state),
  );
