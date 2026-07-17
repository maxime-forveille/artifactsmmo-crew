import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import type { CrewSnapshot } from '../src/bot/orchestration/crewSnapshot.js';
import { GoalItemNotResolvedError } from '../src/bot/orchestration/goalActivityPlanner.js';
import type { GoalProposal } from '../src/bot/orchestration/goalPolicy.js';
import { GoalProposalParentNotFoundError } from '../src/bot/orchestration/goalProposalAcceptance.js';
import { createOrchestrator } from '../src/bot/orchestration/orchestrator.js';
import type {
  ActiveGoal,
  OrchestratorState,
} from '../src/bot/orchestration/orchestratorState.js';
import type { WorldKnowledge } from '../src/bot/orchestration/worldKnowledge.js';
import type { components } from '../src/client/schema.js';

type Character = components['schemas']['CharacterSchema'];
type Monster = components['schemas']['MonsterSchema'];
type Resource = components['schemas']['ResourceSchema'];

const buildCharacter = (name: string, level: number): Character => ({
  ...({} as Character),
  attack_air: 0,
  attack_earth: 10,
  attack_fire: 0,
  attack_water: 0,
  critical_strike: 0,
  hp: 100,
  inventory: [],
  level,
  max_hp: 100,
  mining_level: 10,
  name,
  res_air: 0,
  res_earth: 0,
  res_fire: 0,
  res_water: 0,
});

const buildMonster = (): Monster => ({
  ...({} as Monster),
  attack_air: 0,
  attack_earth: 1,
  attack_fire: 0,
  attack_water: 0,
  code: 'yellow_slime',
  critical_strike: 0,
  hp: 10,
  level: 2,
  name: 'Yellow Slime',
  res_air: 0,
  res_earth: 0,
  res_fire: 0,
  res_water: 0,
});

const buildResource = (): Resource => ({
  code: 'copper_rocks',
  drops: [{ code: 'copper_ore', max_quantity: 1, min_quantity: 1, rate: 1 }],
  level: 1,
  name: 'Copper Rocks',
  skill: 'mining',
});

const buildSnapshot = (characters: readonly Character[]): CrewSnapshot => ({
  bank: [],
  capturedAt: '2026-07-17T08:00:00.000Z',
  characters,
});

const buildWorld = (
  overrides: Partial<WorldKnowledge> = {},
): WorldKnowledge => ({
  items: [],
  monsters: [buildMonster()],
  resources: [],
  ...overrides,
});

const emptyState = (): OrchestratorState => ({ goals: [], reservations: [] });
const combatPolicy = { goalRuleOrder: ['combatProgression'] as const };

const combatGoal = (characterName: string, targetLevel: number) => ({
  characterName,
  id: `reachCombatLevel:${characterName}:${targetLevel}`,
  targetLevel,
  type: 'reachCombatLevel' as const,
});

const activeCombatGoal = (
  characterName: string,
  targetLevel: number,
): ActiveGoal => ({
  ...combatGoal(characterName, targetLevel),
  origin: 'autonomous',
  reason: `${characterName} can progress from combat level ${targetLevel - 1} to ${targetLevel}`,
  rule: 'combatProgression',
});

const combatProposal = (
  overrides: Partial<GoalProposal> = {},
): GoalProposal => ({
  configuredRank: 0,
  goal: combatGoal('Stan', 6),
  reason: 'Stan can progress from combat level 5 to 6',
  rule: 'combatProgression',
  ...overrides,
});

describe('createOrchestrator', () => {
  it('keeps autonomous proposal disabled when policy is absent', () => {
    const orchestrate = createOrchestrator(buildWorld());
    const state = emptyState();

    expect(
      orchestrate(
        buildSnapshot([buildCharacter('Stan', 5)]),
        state,
      )._unsafeUnwrap(),
    ).toEqual({ activities: [], state });
  });

  it('proposes autonomous combat Goals and plans their Activities from an empty state', () => {
    const orchestrate = createOrchestrator(buildWorld(), combatPolicy);

    const result = orchestrate(
      buildSnapshot([buildCharacter('Stan', 6), buildCharacter('Cartman', 5)]),
      emptyState(),
    );

    expect(result._unsafeUnwrap()).toEqual({
      activities: [
        {
          activity: { monsterCode: 'yellow_slime', type: 'fightMonster' },
          characterName: 'Cartman',
          consumes: [],
          goalId: 'reachCombatLevel:Cartman:6',
          produces: [],
        },
        {
          activity: { monsterCode: 'yellow_slime', type: 'fightMonster' },
          characterName: 'Stan',
          consumes: [],
          goalId: 'reachCombatLevel:Stan:7',
          produces: [],
        },
      ],
      state: {
        goals: [
          {
            characterName: 'Cartman',
            id: 'reachCombatLevel:Cartman:6',
            origin: 'autonomous',
            reason: 'Cartman can progress from combat level 5 to 6',
            rule: 'combatProgression',
            targetLevel: 6,
            type: 'reachCombatLevel',
          },
          {
            characterName: 'Stan',
            id: 'reachCombatLevel:Stan:7',
            origin: 'autonomous',
            reason: 'Stan can progress from combat level 6 to 7',
            rule: 'combatProgression',
            targetLevel: 7,
            type: 'reachCombatLevel',
          },
        ],
        reservations: [],
      },
    });
  });

  it('does not run a follow-up Activity plan when policy accepts nothing new', () => {
    const planGoalActivities = vi.fn(
      (_snapshot: CrewSnapshot, state: OrchestratorState) =>
        ok({ activities: [], state }),
    );
    const proposeGoals = vi.fn(() => []);
    const orchestrate = createOrchestrator(buildWorld(), combatPolicy, {
      planGoalActivities,
      proposeGoals,
    });

    orchestrate(buildSnapshot([buildCharacter('Stan', 5)]), emptyState());

    expect(proposeGoals).toHaveBeenCalledTimes(2);
    expect(planGoalActivities).toHaveBeenCalledOnce();
  });

  it('propagates failure while accepting initial Goal Proposals', () => {
    const planGoalActivities = vi.fn();
    const proposeGoals = vi.fn(() => [
      combatProposal({ parentGoalId: 'missing-parent' }),
    ]);
    const orchestrate = createOrchestrator(buildWorld(), combatPolicy, {
      planGoalActivities,
      proposeGoals,
    });

    const result = orchestrate(
      buildSnapshot([buildCharacter('Stan', 5)]),
      emptyState(),
    );

    expect(result._unsafeUnwrapErr()).toEqual(
      new GoalProposalParentNotFoundError(
        'reachCombatLevel:Stan:6',
        'missing-parent',
      ),
    );
    expect(planGoalActivities).not.toHaveBeenCalled();
  });

  it('propagates failure from the initial Activity plan', () => {
    const planningError = new GoalItemNotResolvedError('missing-item');
    const orchestrate = createOrchestrator(buildWorld(), combatPolicy, {
      planGoalActivities: () => err(planningError),
      proposeGoals: () => [],
    });

    expect(
      orchestrate(
        buildSnapshot([buildCharacter('Stan', 5)]),
        emptyState(),
      )._unsafeUnwrapErr(),
    ).toBe(planningError);
  });

  it('propagates failure while accepting replacement Goal Proposals', () => {
    const proposeGoals = vi
      .fn<() => readonly GoalProposal[]>()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        combatProposal({ parentGoalId: 'missing-parent' }),
      ]);
    const orchestrate = createOrchestrator(buildWorld(), combatPolicy, {
      planGoalActivities: (_snapshot, state) => ok({ activities: [], state }),
      proposeGoals,
    });

    const result = orchestrate(
      buildSnapshot([buildCharacter('Stan', 5)]),
      emptyState(),
    );

    expect(result._unsafeUnwrapErr()).toEqual(
      new GoalProposalParentNotFoundError(
        'reachCombatLevel:Stan:6',
        'missing-parent',
      ),
    );
  });

  it('propagates failure from the follow-up Activity plan', () => {
    const planningError = new GoalItemNotResolvedError('missing-item');
    const planGoalActivities = vi
      .fn()
      .mockReturnValueOnce(ok({ activities: [], state: emptyState() }))
      .mockReturnValueOnce(err(planningError));
    const proposeGoals = vi
      .fn<() => readonly GoalProposal[]>()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([combatProposal()]);
    const orchestrate = createOrchestrator(buildWorld(), combatPolicy, {
      planGoalActivities,
      proposeGoals,
    });

    expect(
      orchestrate(
        buildSnapshot([buildCharacter('Stan', 5)]),
        emptyState(),
      )._unsafeUnwrapErr(),
    ).toBe(planningError);
    expect(planGoalActivities).toHaveBeenCalledTimes(2);
  });

  it('replaces a completed Goal while respecting Activities planned in the first pass', () => {
    const completedCombatGoal = activeCombatGoal('Stan', 6);
    const resourceGoal: ActiveGoal = {
      id: 'replenishBankItem:copper_ore:50',
      itemCode: 'copper_ore',
      minimumBankQuantity: 50,
      origin: 'configured',
      resourceCode: 'copper_rocks',
      type: 'replenishBankItem',
    };
    const state: OrchestratorState = {
      goals: [completedCombatGoal, resourceGoal],
      reservations: [],
    };
    const orchestrate = createOrchestrator(
      buildWorld({ resources: [buildResource()] }),
      combatPolicy,
    );

    const result = orchestrate(
      buildSnapshot([buildCharacter('Stan', 6), buildCharacter('Cartman', 5)]),
      state,
    );

    expect(result._unsafeUnwrap()).toEqual({
      activities: [
        {
          activity: { resourceCode: 'copper_rocks', type: 'farmResource' },
          characterName: 'Cartman',
          consumes: [],
          goalId: resourceGoal.id,
          produces: [{ itemCode: 'copper_ore' }],
        },
        {
          activity: { monsterCode: 'yellow_slime', type: 'fightMonster' },
          characterName: 'Stan',
          consumes: [],
          goalId: 'reachCombatLevel:Stan:7',
          produces: [],
        },
      ],
      state: {
        goals: [
          resourceGoal,
          activeCombatGoal('Cartman', 6),
          activeCombatGoal('Stan', 7),
        ],
        reservations: [],
      },
    });
  });
});
