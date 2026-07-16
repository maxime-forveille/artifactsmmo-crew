import { describe, expect, it } from 'vitest';

import {
  CombatCharacterNotFoundError,
  findBestCombatTarget,
  NoSafeCombatTargetError,
  planCombatProgression,
} from '../src/bot/orchestration/combatProgression.js';
import type { CrewSnapshot } from '../src/bot/orchestration/crewSnapshot.js';
import type {
  OrchestratorState,
  ReachCombatLevelGoal,
  Reservation,
} from '../src/bot/orchestration/orchestratorState.js';
import type { WorldKnowledge } from '../src/bot/orchestration/worldKnowledge.js';
import type { components } from '../src/client/schema.js';

type Character = components['schemas']['CharacterSchema'];
type Monster = components['schemas']['MonsterSchema'];

const buildCharacter = (overrides: Partial<Character> = {}): Character => ({
  ...({} as Character),
  attack_air: 0,
  attack_earth: 10,
  attack_fire: 0,
  attack_water: 0,
  critical_strike: 0,
  hp: 100,
  level: 5,
  max_hp: 100,
  name: 'Stan',
  res_air: 0,
  res_earth: 0,
  res_fire: 0,
  res_water: 0,
  ...overrides,
});

const buildMonster = (overrides: Partial<Monster> = {}): Monster => ({
  ...({} as Monster),
  attack_air: 0,
  attack_earth: 2,
  attack_fire: 0,
  attack_water: 0,
  code: 'yellow_slime',
  critical_strike: 0,
  hp: 20,
  level: 2,
  res_air: 0,
  res_earth: 0,
  res_fire: 0,
  res_water: 0,
  ...overrides,
});

const buildGoal = (
  overrides: Partial<ReachCombatLevelGoal> = {},
): ReachCombatLevelGoal => ({
  characterName: 'Stan',
  id: 'reachCombatLevel:Stan:6',
  targetLevel: 6,
  type: 'reachCombatLevel',
  ...overrides,
});

const buildState = (
  overrides: Partial<OrchestratorState> = {},
): OrchestratorState => ({
  goals: [buildGoal()],
  reservations: [],
  ...overrides,
});

const buildSnapshot = (
  overrides: Partial<CrewSnapshot> = {},
): CrewSnapshot => ({
  bank: [],
  capturedAt: '2026-07-16T12:00:00.000Z',
  characters: [buildCharacter()],
  ...overrides,
});

const buildKnowledge = (
  monsters: readonly Monster[] = [buildMonster()],
): Pick<WorldKnowledge, 'monsters'> => ({ monsters });

const buildReservation = (
  overrides: Partial<Reservation> = {},
): Reservation => ({
  activity: { monsterCode: 'yellow_slime', type: 'fightMonster' },
  characterName: 'Stan',
  consumes: [],
  goalId: 'reachCombatLevel:Stan:6',
  produces: [],
  ...overrides,
});

describe('findBestCombatTarget', () => {
  it('selects the highest-level safe target at or below the character level', () => {
    const character = buildCharacter();
    const monsters = [
      buildMonster({ code: 'too_high', level: 6 }),
      buildMonster({ attack_earth: 100, code: 'unsafe', hp: 100, level: 5 }),
      buildMonster({ code: 'level_two', level: 2 }),
      buildMonster({ code: 'z_level_five', level: 5 }),
      buildMonster({ code: 'a_level_five', level: 5 }),
    ];

    expect(findBestCombatTarget(character, monsters)?.code).toBe(
      'a_level_five',
    );
    expect(monsters.map((monster) => monster.code)).toEqual([
      'too_high',
      'unsafe',
      'level_two',
      'z_level_five',
      'a_level_five',
    ]);
  });

  it('evaluates safety at post-rest HP', () => {
    const character = buildCharacter({ hp: 1 });

    expect(findBestCombatTarget(character, [buildMonster()])?.code).toBe(
      'yellow_slime',
    );
  });

  it('returns undefined when no monster is both eligible and safe', () => {
    expect(
      findBestCombatTarget(buildCharacter(), [
        buildMonster({ attack_earth: 100, hp: 100, level: 5 }),
      ]),
    ).toBeUndefined();
  });
});

describe('planCombatProgression', () => {
  it('proposes one combat Activity for the target character', () => {
    const state = buildState();

    const result = planCombatProgression(
      buildSnapshot({
        characters: [
          buildCharacter({ name: 'Kyle' }),
          buildCharacter({ name: 'Stan' }),
        ],
      }),
      state,
      buildKnowledge(),
    );

    expect(result.isOk() && result.value).toEqual({
      activities: [
        {
          activity: { monsterCode: 'yellow_slime', type: 'fightMonster' },
          characterName: 'Stan',
          consumes: [],
          goalId: 'reachCombatLevel:Stan:6',
          produces: [],
        },
      ],
      state,
    });
  });

  it('completes the Goal once its target level is observed', () => {
    const nextGoal = buildGoal({
      characterName: 'Kyle',
      id: 'reachCombatLevel:Kyle:6',
    });
    const state = buildState({ goals: [buildGoal(), nextGoal] });

    const result = planCombatProgression(
      buildSnapshot({ characters: [buildCharacter({ level: 6 })] }),
      state,
      buildKnowledge(),
    );

    expect(result.isOk() && result.value).toEqual({
      activities: [],
      state: { goals: [nextGoal], reservations: [] },
    });
  });

  it('leaves an empty Goal list unchanged', () => {
    const state = buildState({ goals: [] });

    expect(
      planCombatProgression(
        buildSnapshot(),
        state,
        buildKnowledge(),
      )._unsafeUnwrap(),
    ).toEqual({ activities: [], state });
  });

  it('leaves unrelated Goal types unchanged', () => {
    const state = buildState({
      goals: [
        {
          id: 'replenish-copper',
          itemCode: 'copper_ore',
          minimumBankQuantity: 50,
          type: 'replenishBankItem',
        },
      ],
    });

    expect(
      planCombatProgression(
        buildSnapshot(),
        state,
        buildKnowledge(),
      )._unsafeUnwrap(),
    ).toEqual({ activities: [], state });
  });

  it('waits when the Goal already has a Reservation', () => {
    const state = buildState({
      reservations: [buildReservation({ characterName: 'Kyle' })],
    });

    expect(
      planCombatProgression(
        buildSnapshot(),
        state,
        buildKnowledge(),
      )._unsafeUnwrap(),
    ).toEqual({ activities: [], state });
  });

  it('waits when the target character is reserved by another Goal', () => {
    const state = buildState({
      reservations: [buildReservation({ goalId: 'other-goal' })],
    });

    expect(
      planCombatProgression(
        buildSnapshot(),
        state,
        buildKnowledge(),
      )._unsafeUnwrap(),
    ).toEqual({ activities: [], state });
  });

  it('ignores Reservations for other Goals and characters', () => {
    const state = buildState({
      reservations: [
        buildReservation({ characterName: 'Kyle', goalId: 'other-goal' }),
      ],
    });

    expect(
      planCombatProgression(
        buildSnapshot(),
        state,
        buildKnowledge(),
      )._unsafeUnwrap().activities,
    ).toHaveLength(1);
  });

  it('returns a typed error when the target character is absent', () => {
    const result = planCombatProgression(
      buildSnapshot({ characters: [] }),
      buildState(),
      buildKnowledge(),
    );

    expect(result._unsafeUnwrapErr()).toEqual(
      new CombatCharacterNotFoundError('Stan'),
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      characterName: 'Stan',
      message: 'Character "Stan" does not exist in the Crew Snapshot',
      name: 'CombatCharacterNotFoundError',
    });
  });

  it('returns a typed error when no safe combat target exists', () => {
    const result = planCombatProgression(
      buildSnapshot(),
      buildState(),
      buildKnowledge([buildMonster({ attack_earth: 100, hp: 100, level: 5 })]),
    );

    expect(result._unsafeUnwrapErr()).toEqual(
      new NoSafeCombatTargetError('Stan', 5),
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      characterLevel: 5,
      characterName: 'Stan',
      message: 'No safe combat target exists for Stan at level 5',
      name: 'NoSafeCombatTargetError',
    });
  });
});
