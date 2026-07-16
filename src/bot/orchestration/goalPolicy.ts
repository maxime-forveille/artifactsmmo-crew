import type { CrewSnapshot } from './crewSnapshot.js';
import type { Goal, OrchestratorState } from './orchestratorState.js';
import type { WorldKnowledge } from './worldKnowledge.js';

export const GOAL_RULE_NAMES = [
  'equipmentUpgrade',
  'combatProgression',
  'professionProgression',
  'gatheringProgression',
  'bankReplenishment',
  'bankSurplusProcessing',
] as const;

export type GoalRuleName = (typeof GOAL_RULE_NAMES)[number];

export type GoalPolicyContext = Readonly<{
  snapshot: CrewSnapshot;
  state: OrchestratorState;
  world: WorldKnowledge;
}>;

type DiscoveredGoal = Readonly<{
  goal: Goal;
  parentGoalId?: string;
  reason: string;
  utility?: number;
}>;

export type GoalCandidate = Readonly<DiscoveredGoal & { rule: GoalRuleName }>;

export type GoalProposal = Readonly<GoalCandidate & { configuredRank: number }>;

export type GoalRule = (
  context: GoalPolicyContext,
) => readonly DiscoveredGoal[];

export type GoalRuleRegistry = Readonly<
  Partial<Record<GoalRuleName, GoalRule>>
>;

export type GoalPolicyConfig = Readonly<{
  goalRuleOrder: readonly GoalRuleName[];
}>;

export type GoalPolicy = (
  context: GoalPolicyContext,
) => readonly GoalProposal[];

export const discoverGoalCandidates = (
  context: GoalPolicyContext,
  config: GoalPolicyConfig,
  rules: GoalRuleRegistry,
): readonly GoalCandidate[] =>
  config.goalRuleOrder.flatMap((rule) =>
    (rules[rule]?.(context) ?? []).map((candidate) => ({ ...candidate, rule })),
  );

type RankedGoalCandidate = Readonly<GoalCandidate & { configuredRank: number }>;

export const rankGoalCandidates = (
  candidates: readonly GoalCandidate[],
  config: GoalPolicyConfig,
): readonly RankedGoalCandidate[] => {
  const rankByRule = new Map(
    config.goalRuleOrder.map((rule, rank) => [rule, rank]),
  );

  return candidates
    .map((candidate) => ({
      ...candidate,
      configuredRank: rankByRule.get(candidate.rule) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort(
      (left, right) =>
        Number(left.parentGoalId === undefined) -
          Number(right.parentGoalId === undefined) ||
        left.configuredRank - right.configuredRank ||
        (right.utility ?? 0) - (left.utility ?? 0) ||
        left.goal.id.localeCompare(right.goal.id),
    );
};

const characterNameForGoal = (goal: Goal): string | undefined =>
  goal.type === 'equipItem' ? goal.characterName : undefined;

const conflictKeyForGoal = (goal: Goal): string => {
  switch (goal.type) {
    case 'equipItem': {
      return `${goal.type}:${goal.characterName}:${goal.itemCode}`;
    }
    case 'replenishBankItem': {
      return `${goal.type}:${goal.itemCode}`;
    }
    default: {
      const exhaustiveCheck: never = goal;
      return exhaustiveCheck;
    }
  }
};

const goalsConflict = (left: Goal, right: Goal): boolean =>
  left.id === right.id ||
  conflictKeyForGoal(left) === conflictKeyForGoal(right);

export const selectCompatibleGoals = (
  candidates: readonly RankedGoalCandidate[],
  state: OrchestratorState,
): readonly GoalProposal[] => {
  const proposals: GoalProposal[] = [];
  const reservedCharacterNames = new Set(
    state.reservations.map((reservation) => reservation.characterName),
  );

  for (const candidate of candidates) {
    const characterName = characterNameForGoal(candidate.goal);
    const otherActiveGoals = state.goals.filter(
      (goal) => goal.id !== candidate.parentGoalId,
    );

    if (
      otherActiveGoals.some((goal) => goalsConflict(goal, candidate.goal)) ||
      proposals.some((proposal) => goalsConflict(proposal.goal, candidate.goal))
    ) {
      continue;
    }

    if (
      characterName !== undefined &&
      (reservedCharacterNames.has(characterName) ||
        otherActiveGoals.some(
          (goal) => characterNameForGoal(goal) === characterName,
        ) ||
        proposals.some(
          (proposal) => characterNameForGoal(proposal.goal) === characterName,
        ))
    ) {
      continue;
    }

    proposals.push(candidate);
  }

  return proposals;
};

export const createGoalPolicy = (
  config: GoalPolicyConfig,
  rules: GoalRuleRegistry,
): GoalPolicy => {
  const proposeGoals = (context: GoalPolicyContext): readonly GoalProposal[] =>
    selectCompatibleGoals(
      rankGoalCandidates(
        discoverGoalCandidates(context, config, rules),
        config,
      ),
      context.state,
    );

  return proposeGoals;
};
