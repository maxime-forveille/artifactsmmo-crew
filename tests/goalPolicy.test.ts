import { describe, expect, it, vi } from 'vitest';

import type { CrewSnapshot } from '../src/bot/orchestration/crewSnapshot.js';
import {
  createGoalPolicy,
  discoverGoalCandidates,
  rankGoalCandidates,
  selectCompatibleGoals,
  type GoalCandidate,
  type GoalPolicyConfig,
  type GoalPolicyContext,
} from '../src/bot/orchestration/goalPolicy.js';
import type {
  EquipItemGoal,
  OrchestratorState,
  ReplenishBankItemGoal,
} from '../src/bot/orchestration/orchestratorState.js';
import type { WorldKnowledge } from '../src/bot/orchestration/worldKnowledge.js';

const buildEquipGoal = (
  id: string,
  characterName: string,
  itemCode: string,
): EquipItemGoal => ({ characterName, id, itemCode, type: 'equipItem' });

const buildReplenishmentGoal = (
  id: string,
  itemCode: string,
): ReplenishBankItemGoal => ({
  id,
  itemCode,
  minimumBankQuantity: 50,
  type: 'replenishBankItem',
});

const buildState = (
  overrides: Partial<OrchestratorState> = {},
): OrchestratorState => ({ goals: [], reservations: [], ...overrides });

const buildContext = (
  state: OrchestratorState = buildState(),
): GoalPolicyContext => ({
  snapshot: {
    bank: [],
    capturedAt: '2026-07-16T12:00:00.000Z',
    characters: [],
  } satisfies CrewSnapshot,
  state,
  world: { items: [], monsters: [], resources: [] } satisfies WorldKnowledge,
});

const buildCandidate = (
  overrides: Partial<GoalCandidate> = {},
): GoalCandidate => ({
  goal: buildEquipGoal('equip-stan', 'Stan', 'copper_dagger'),
  reason: 'Improve Stan combat equipment',
  rule: 'equipmentUpgrade',
  ...overrides,
});

const config: GoalPolicyConfig = {
  goalRuleOrder: ['equipmentUpgrade', 'combatProgression', 'bankReplenishment'],
};

describe('discoverGoalCandidates', () => {
  it('runs configured rules in order and attaches their names', () => {
    const context = buildContext();
    const equipmentUpgrade = vi.fn(() => [
      {
        goal: buildEquipGoal('equip-stan', 'Stan', 'copper_dagger'),
        reason: 'Upgrade weapon',
      },
    ]);
    const bankReplenishment = vi.fn(() => [
      {
        goal: buildReplenishmentGoal('replenish-copper', 'copper_ore'),
        reason: 'Restore bank stock',
        utility: 2,
      },
    ]);

    const candidates = discoverGoalCandidates(context, config, {
      bankReplenishment,
      equipmentUpgrade,
    });

    expect(candidates).toEqual([
      {
        goal: buildEquipGoal('equip-stan', 'Stan', 'copper_dagger'),
        reason: 'Upgrade weapon',
        rule: 'equipmentUpgrade',
      },
      {
        goal: buildReplenishmentGoal('replenish-copper', 'copper_ore'),
        reason: 'Restore bank stock',
        rule: 'bankReplenishment',
        utility: 2,
      },
    ]);
    expect(equipmentUpgrade).toHaveBeenCalledWith(context);
    expect(bankReplenishment).toHaveBeenCalledWith(context);
  });
});

describe('rankGoalCandidates', () => {
  it('orders prerequisites, configured rules, utility, then stable Goal ids', () => {
    const candidates = [
      buildCandidate({
        goal: buildEquipGoal('equipment-b', 'Butters', 'copper_helmet'),
        utility: 2,
      }),
      buildCandidate({
        goal: buildEquipGoal('equipment-a', 'Cartman', 'copper_helmet'),
        utility: 2,
      }),
      buildCandidate({
        goal: buildReplenishmentGoal('bank', 'copper_ore'),
        rule: 'bankReplenishment',
        utility: 100,
      }),
      buildCandidate({
        goal: buildEquipGoal('prerequisite', 'Kyle', 'copper_pickaxe'),
        parentGoalId: 'blocked-goal',
        rule: 'bankReplenishment',
      }),
      buildCandidate({
        goal: buildEquipGoal('equipment-best', 'Kenny', 'copper_helmet'),
        utility: 3,
      }),
    ];

    const ranked = rankGoalCandidates(candidates, config);

    expect(
      ranked.map(({ configuredRank, goal }) => [goal.id, configuredRank]),
    ).toEqual([
      ['prerequisite', 2],
      ['equipment-best', 0],
      ['equipment-a', 0],
      ['equipment-b', 0],
      ['bank', 2],
    ]);
    expect(candidates).toEqual([
      buildCandidate({
        goal: buildEquipGoal('equipment-b', 'Butters', 'copper_helmet'),
        utility: 2,
      }),
      buildCandidate({
        goal: buildEquipGoal('equipment-a', 'Cartman', 'copper_helmet'),
        utility: 2,
      }),
      buildCandidate({
        goal: buildReplenishmentGoal('bank', 'copper_ore'),
        rule: 'bankReplenishment',
        utility: 100,
      }),
      buildCandidate({
        goal: buildEquipGoal('prerequisite', 'Kyle', 'copper_pickaxe'),
        parentGoalId: 'blocked-goal',
        rule: 'bankReplenishment',
      }),
      buildCandidate({
        goal: buildEquipGoal('equipment-best', 'Kenny', 'copper_helmet'),
        utility: 3,
      }),
    ]);
  });

  it('keeps configured rule order ahead of cross-rule utility', () => {
    const ranked = rankGoalCandidates(
      [
        buildCandidate({
          goal: buildReplenishmentGoal('bank', 'copper_ore'),
          rule: 'bankReplenishment',
          utility: 100,
        }),
        buildCandidate({
          goal: buildEquipGoal('equipment', 'Stan', 'copper_helmet'),
        }),
      ],
      config,
    );

    expect(ranked.map((candidate) => candidate.goal.id)).toEqual([
      'equipment',
      'bank',
    ]);
  });

  it('uses zero utility when no evidence is available', () => {
    const ranked = rankGoalCandidates(
      [
        buildCandidate({
          goal: buildEquipGoal('unknown', 'Stan', 'copper_helmet'),
        }),
        buildCandidate({
          goal: buildEquipGoal('measured', 'Kyle', 'copper_helmet'),
          utility: 1,
        }),
      ],
      config,
    );

    expect(ranked.map((candidate) => candidate.goal.id)).toEqual([
      'measured',
      'unknown',
    ]);
  });

  it('puts candidates from an unconfigured rule last', () => {
    const ranked = rankGoalCandidates(
      [
        buildCandidate({
          goal: buildReplenishmentGoal('unconfigured', 'copper_ore'),
          rule: 'bankReplenishment',
        }),
        buildCandidate({
          goal: buildEquipGoal('configured', 'Stan', 'copper_helmet'),
        }),
      ],
      { goalRuleOrder: ['equipmentUpgrade'] },
    );

    expect(
      ranked.map(({ configuredRank, goal }) => [goal.id, configuredRank]),
    ).toEqual([
      ['configured', 0],
      ['unconfigured', Number.MAX_SAFE_INTEGER],
    ]);
  });
});

describe('selectCompatibleGoals', () => {
  it('keeps prerequisites while rejecting active, reserved, and selected conflicts', () => {
    const parentGoal = buildEquipGoal('blocked-goal', 'Stan', 'copper_dagger');
    const state = buildState({
      goals: [
        parentGoal,
        buildReplenishmentGoal('active-copper', 'copper_ore'),
      ],
      reservations: [
        {
          activity: { monsterCode: 'chicken', type: 'huntMonster' },
          characterName: 'Cartman',
          consumes: [],
          goalId: 'combat-cartman',
          produces: [],
        },
      ],
    });
    const candidates = [
      {
        ...buildCandidate({
          goal: buildEquipGoal('unlock-stan', 'Stan', 'copper_pickaxe'),
          parentGoalId: parentGoal.id,
        }),
        configuredRank: 0,
      },
      {
        ...buildCandidate({
          goal: buildEquipGoal('reserved-cartman', 'Cartman', 'copper_helmet'),
        }),
        configuredRank: 0,
      },
      {
        ...buildCandidate({
          goal: buildReplenishmentGoal('duplicate-copper', 'copper_ore'),
          rule: 'bankReplenishment',
        }),
        configuredRank: 2,
      },
      {
        ...buildCandidate({
          goal: buildEquipGoal('kyle-first', 'Kyle', 'copper_helmet'),
        }),
        configuredRank: 0,
      },
      {
        ...buildCandidate({
          goal: buildEquipGoal('kyle-second', 'Kyle', 'copper_boots'),
        }),
        configuredRank: 0,
      },
      {
        ...buildCandidate({
          goal: buildReplenishmentGoal('replenish-ash', 'ash_wood'),
          rule: 'bankReplenishment',
        }),
        configuredRank: 2,
      },
    ];

    const proposals = selectCompatibleGoals(candidates, state);

    expect(proposals.map((proposal) => proposal.goal.id)).toEqual([
      'unlock-stan',
      'kyle-first',
      'replenish-ash',
    ]);
  });

  it('treats Goal ids as unique across Goal types', () => {
    const state = buildState({
      goals: [buildReplenishmentGoal('shared-id', 'copper_ore')],
    });
    const candidate = {
      ...buildCandidate({
        goal: buildEquipGoal('shared-id', 'Stan', 'copper_dagger'),
      }),
      configuredRank: 0,
    };

    expect(selectCompatibleGoals([candidate], state)).toEqual([]);
  });

  it('distinguishes equipment by character and Goals by type', () => {
    const candidates = [
      {
        ...buildCandidate({
          goal: buildEquipGoal('stan', 'Stan', 'copper_dagger'),
        }),
        configuredRank: 0,
      },
      {
        ...buildCandidate({
          goal: buildEquipGoal('kyle', 'Kyle', 'copper_dagger'),
        }),
        configuredRank: 0,
      },
      {
        ...buildCandidate({
          goal: buildReplenishmentGoal('bank', 'copper_dagger'),
          rule: 'bankReplenishment',
        }),
        configuredRank: 2,
      },
    ];

    expect(
      selectCompatibleGoals(candidates, buildState()).map(
        (proposal) => proposal.goal.id,
      ),
    ).toEqual(['stan', 'kyle', 'bank']);
  });

  it('rejects an equipment Goal equivalent to an active Goal', () => {
    const active = buildEquipGoal('active', 'Stan', 'copper_dagger');
    const candidate = {
      ...buildCandidate({
        goal: buildEquipGoal('duplicate', 'Stan', 'copper_dagger'),
      }),
      configuredRank: 0,
    };

    expect(
      selectCompatibleGoals([candidate], buildState({ goals: [active] })),
    ).toEqual([]);
  });

  it('rejects different equipment Goals for an active character', () => {
    const active = buildEquipGoal('active', 'Stan', 'copper_dagger');
    const candidate = {
      ...buildCandidate({
        goal: buildEquipGoal('different-item', 'Stan', 'copper_helmet'),
      }),
      configuredRank: 0,
    };

    expect(
      selectCompatibleGoals([candidate], buildState({ goals: [active] })),
    ).toEqual([]);
  });

  it('selects only one replenishment Goal for the same bank item', () => {
    const first = {
      ...buildCandidate({
        goal: buildReplenishmentGoal('first', 'copper_ore'),
        rule: 'bankReplenishment' as const,
      }),
      configuredRank: 2,
    };
    const second = {
      ...buildCandidate({
        goal: {
          ...buildReplenishmentGoal('second', 'copper_ore'),
          minimumBankQuantity: 100,
        },
        rule: 'bankReplenishment' as const,
      }),
      configuredRank: 2,
    };

    expect(
      selectCompatibleGoals([first, second], buildState()).map(
        (proposal) => proposal.goal.id,
      ),
    ).toEqual(['first']);
  });
});

describe('createGoalPolicy', () => {
  it('composes discovery, ranking, and compatibility selection', () => {
    const policy = createGoalPolicy(config, {
      bankReplenishment: () => [
        {
          goal: buildReplenishmentGoal('replenish-copper', 'copper_ore'),
          reason: 'Restore stock',
        },
      ],
      equipmentUpgrade: () => [
        {
          goal: buildEquipGoal('equip-stan', 'Stan', 'copper_dagger'),
          reason: 'Upgrade Stan',
        },
      ],
    });

    const proposals = policy(buildContext());

    expect(proposals).toEqual([
      {
        configuredRank: 0,
        goal: buildEquipGoal('equip-stan', 'Stan', 'copper_dagger'),
        reason: 'Upgrade Stan',
        rule: 'equipmentUpgrade',
      },
      {
        configuredRank: 2,
        goal: buildReplenishmentGoal('replenish-copper', 'copper_ore'),
        reason: 'Restore stock',
        rule: 'bankReplenishment',
      },
    ]);
  });
});
