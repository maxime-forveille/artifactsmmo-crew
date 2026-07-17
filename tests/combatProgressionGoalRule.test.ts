import { describe, expect, it } from 'vitest';

import {
  createReachCombatLevelGoalId,
  proposeCombatProgressionGoals,
} from '../src/bot/orchestration/combatProgressionGoalRule.js';
import type { CrewSnapshot } from '../src/bot/orchestration/crewSnapshot.js';
import type { GoalPolicyContext } from '../src/bot/orchestration/goalPolicy.js';
import type { components } from '../src/client/schema.js';

type Character = components['schemas']['CharacterSchema'];
type Monster = components['schemas']['MonsterSchema'];

const buildCharacter = (name: string, level: number): Character => ({
  ...({} as Character),
  attack_air: 0,
  attack_earth: 10,
  attack_fire: 0,
  attack_water: 0,
  critical_strike: 0,
  hp: 100,
  level,
  max_hp: 100,
  name,
  res_air: 0,
  res_earth: 0,
  res_fire: 0,
  res_water: 0,
});

const buildMonster = (overrides: Partial<Monster> = {}): Monster => ({
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
  ...overrides,
});

const buildContext = (
  characters: readonly Character[],
  monsters: readonly Monster[] = [buildMonster()],
): GoalPolicyContext => ({
  snapshot: {
    bank: [],
    capturedAt: '2026-07-16T12:00:00.000Z',
    characters,
  } satisfies CrewSnapshot,
  state: { goals: [], reservations: [] },
  world: { items: [], monsters, resources: [] },
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

  it('does not propose combat progression without a safe target', () => {
    const character = buildCharacter('Stan', 5);
    const unsafeMonster = buildMonster({
      attack_earth: 100,
      hp: 100,
      level: 5,
    });

    expect(
      proposeCombatProgressionGoals(buildContext([character], [unsafeMonster])),
    ).toEqual([]);
  });
});
