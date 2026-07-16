import { describe, expect, it } from 'vitest';

import type { GoalProposal } from '../src/bot/orchestration/goalPolicy.js';
import {
  acceptGoalProposals,
  GoalProposalParentNotFoundError,
} from '../src/bot/orchestration/goalProposalAcceptance.js';
import type {
  EquipItemGoal,
  OrchestratorState,
  ReachCombatLevelGoal,
} from '../src/bot/orchestration/orchestratorState.js';

const buildEquipmentGoal = (
  id: string,
  characterName: string,
  itemCode: string,
): EquipItemGoal => ({ characterName, id, itemCode, type: 'equipItem' });

const buildCombatGoal = (
  id: string,
  characterName: string,
  targetLevel: number,
): ReachCombatLevelGoal => ({
  characterName,
  id,
  targetLevel,
  type: 'reachCombatLevel',
});

const buildProposal = (
  goal: GoalProposal['goal'],
  overrides: Partial<GoalProposal> = {},
): GoalProposal => ({
  configuredRank: 1,
  goal,
  reason: 'Progress the crew',
  rule: 'combatProgression',
  ...overrides,
});

const buildState = (
  overrides: Partial<OrchestratorState> = {},
): OrchestratorState => ({ goals: [], reservations: [], ...overrides });

describe('acceptGoalProposals', () => {
  it('appends autonomous Goals in proposal order after active Goals', () => {
    const activeGoal = buildEquipmentGoal(
      'equip-stan',
      'Stan',
      'copper_dagger',
    );
    const firstProposal = buildProposal(
      buildCombatGoal('combat-cartman', 'Cartman', 6),
    );
    const secondProposal = buildProposal(
      buildCombatGoal('combat-kyle', 'Kyle', 7),
    );
    const state = buildState({ goals: [activeGoal] });

    expect(
      acceptGoalProposals(state, [
        firstProposal,
        secondProposal,
      ])._unsafeUnwrap().goals,
    ).toEqual([activeGoal, firstProposal.goal, secondProposal.goal]);
    expect(state.goals).toEqual([activeGoal]);
  });

  it('inserts prerequisites immediately before their preserved parent', () => {
    const earlierGoal = buildEquipmentGoal(
      'equip-cartman',
      'Cartman',
      'copper_helmet',
    );
    const parentGoal = buildEquipmentGoal(
      'equip-stan',
      'Stan',
      'copper_dagger',
    );
    const laterGoal = buildCombatGoal('combat-kyle', 'Kyle', 7);
    const firstPrerequisite = buildProposal(
      buildCombatGoal('combat-stan-6', 'Stan', 6),
      { parentGoalId: parentGoal.id },
    );
    const secondPrerequisite = buildProposal(
      buildCombatGoal('combat-stan-7', 'Stan', 7),
      { parentGoalId: parentGoal.id },
    );
    const state = buildState({ goals: [earlierGoal, parentGoal, laterGoal] });

    expect(
      acceptGoalProposals(state, [firstPrerequisite, secondPrerequisite])
        ._unsafeUnwrap()
        .goals.map((goal) => goal.id),
    ).toEqual([
      'equip-cartman',
      'combat-stan-6',
      'combat-stan-7',
      'equip-stan',
      'combat-kyle',
    ]);
  });

  it('is idempotent for equivalent Goals and preserves the original state', () => {
    const activeGoal = buildCombatGoal('active-id', 'Stan', 6);
    const state = buildState({ goals: [activeGoal] });
    const equivalentProposal = buildProposal(
      buildCombatGoal('different-id', 'Stan', 6),
    );

    const accepted = acceptGoalProposals(state, [equivalentProposal]);

    expect(accepted._unsafeUnwrap()).toBe(state);
  });

  it('returns the original state when there is nothing to accept', () => {
    const state = buildState();

    expect(acceptGoalProposals(state, [])._unsafeUnwrap()).toBe(state);
  });

  it('rejects a prerequisite whose parent Goal is absent', () => {
    const state = buildState();
    const proposal = buildProposal(buildCombatGoal('combat-stan', 'Stan', 6), {
      parentGoalId: 'missing-parent',
    });

    const result = acceptGoalProposals(state, [proposal]);

    expect(result._unsafeUnwrapErr()).toEqual(
      new GoalProposalParentNotFoundError('combat-stan', 'missing-parent'),
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      goalId: 'combat-stan',
      message:
        'Cannot accept Goal "combat-stan": parent Goal "missing-parent" does not exist',
      name: 'GoalProposalParentNotFoundError',
      parentGoalId: 'missing-parent',
    });
    expect(state).toEqual(buildState());
  });
});
