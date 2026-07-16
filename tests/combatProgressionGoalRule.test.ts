import { describe, expect, it } from 'vitest';

import {
  createReachCombatLevelGoalId,
  proposeCombatProgressionGoals,
} from '../src/bot/orchestration/combatProgressionGoalRule.js';
import type { CrewSnapshot } from '../src/bot/orchestration/crewSnapshot.js';
import type { GoalPolicyContext } from '../src/bot/orchestration/goalPolicy.js';
import type { components } from '../src/client/schema.js';

type Character = components['schemas']['CharacterSchema'];

const buildCharacter = (name: string, level: number): Character => ({
  ...({} as Character),
  level,
  name,
});

const buildContext = (characters: readonly Character[]): GoalPolicyContext => ({
  snapshot: {
    bank: [],
    capturedAt: '2026-07-16T12:00:00.000Z',
    characters,
  } satisfies CrewSnapshot,
  state: { goals: [], reservations: [] },
  world: { items: [], monsters: [], resources: [] },
});

describe('createReachCombatLevelGoalId', () => {
  it('creates a stable semantic id from the character and target level', () => {
    expect(createReachCombatLevelGoalId('Stan', 7)).toBe(
      'reachCombatLevel:Stan:7',
    );
  });
});

describe('proposeCombatProgressionGoals', () => {
  it('discovers one next-level finite Goal per character', () => {
    const context = buildContext([
      buildCharacter('Cartman', 5),
      buildCharacter('Stan', 6),
    ]);

    expect(proposeCombatProgressionGoals(context)).toEqual([
      {
        goal: {
          characterName: 'Cartman',
          id: 'reachCombatLevel:Cartman:6',
          targetLevel: 6,
          type: 'reachCombatLevel',
        },
        reason: 'Cartman can progress from combat level 5 to 6',
        utility: 1,
      },
      {
        goal: {
          characterName: 'Stan',
          id: 'reachCombatLevel:Stan:7',
          targetLevel: 7,
          type: 'reachCombatLevel',
        },
        reason: 'Stan can progress from combat level 6 to 7',
        utility: 1,
      },
    ]);
  });

  it('discovers no Goal for an empty crew', () => {
    expect(proposeCombatProgressionGoals(buildContext([]))).toEqual([]);
  });
});
