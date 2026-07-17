import { describe, expect, it } from 'vitest';

import type { CrewSnapshot } from '../src/bot/orchestration/crewSnapshot.js';
import {
  InvalidMonsterTargetError,
  NoSafeMonsterFighterError,
  planMonsterReplenishment,
  type Monster,
} from '../src/bot/orchestration/monsterReplenishment.js';
import type {
  ActiveGoal,
  OrchestratorState,
  ReplenishBankItemGoal,
  Reservation,
} from '../src/bot/orchestration/orchestratorState.js';
import type { components } from '../src/client/schema.js';

type Character = components['schemas']['CharacterSchema'];

const buildCharacter = (
  name: string,
  overrides: Partial<Character> = {},
): Character => ({
  ...({} as Character),
  attack_air: 0,
  attack_earth: 10,
  attack_fire: 0,
  attack_water: 0,
  critical_strike: 0,
  hp: 100,
  max_hp: 100,
  name,
  res_air: 0,
  res_earth: 0,
  res_fire: 0,
  res_water: 0,
  ...overrides,
});

const buildGoal = (
  overrides: Partial<ReplenishBankItemGoal> = {},
): ActiveGoal & ReplenishBankItemGoal => ({
  id: 'replenish-slime-gel',
  itemCode: 'slime_gel',
  minimumBankQuantity: 50,
  monsterCode: 'yellow_slime',
  origin: 'configured',
  type: 'replenishBankItem',
  ...overrides,
});

const buildMonster = (overrides: Partial<Monster> = {}): Monster => ({
  ...({} as Monster),
  attack_air: 0,
  attack_earth: 1,
  attack_fire: 0,
  attack_water: 0,
  code: 'yellow_slime',
  critical_strike: 0,
  drops: [{ code: 'slime_gel', max_quantity: 1, min_quantity: 1, rate: 1 }],
  hp: 10,
  level: 2,
  name: 'Yellow Slime',
  res_air: 0,
  res_earth: 0,
  res_fire: 0,
  res_water: 0,
  ...overrides,
});

const buildSnapshot = (
  overrides: Partial<CrewSnapshot> = {},
): CrewSnapshot => ({
  bank: [],
  capturedAt: '2026-07-18T12:00:00.000Z',
  characters: [buildCharacter('Cartman'), buildCharacter('Stan')],
  ...overrides,
});

const buildState = (
  overrides: Partial<OrchestratorState> = {},
): OrchestratorState => ({
  goals: [buildGoal()],
  reservations: [],
  ...overrides,
});

const buildReservation = (
  overrides: Partial<Reservation> = {},
): Reservation => ({
  activity: { resourceCode: 'copper_rocks', type: 'farmResource' },
  characterName: 'Cartman',
  consumes: [],
  goalId: 'another-goal',
  produces: [],
  ...overrides,
});

describe('planMonsterReplenishment', () => {
  it('plans one fight for the safest idle character', () => {
    const state = buildState();

    expect(
      planMonsterReplenishment(buildSnapshot(), state, buildMonster()),
    ).toMatchObject({
      value: {
        activities: [
          {
            activity: { monsterCode: 'yellow_slime', type: 'fightMonster' },
            characterName: 'Cartman',
            consumes: [],
            goalId: 'replenish-slime-gel',
            produces: [{ itemCode: 'slime_gel' }],
          },
        ],
        state,
      },
    });
  });

  it('prefers the fighter with the larger combat margin', () => {
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter('Cartman', { attack_earth: 10 }),
        buildCharacter('Stan', { attack_earth: 20 }),
      ],
    });

    const result = planMonsterReplenishment(
      snapshot,
      buildState(),
      buildMonster(),
    );

    expect(result._unsafeUnwrap().activities[0]?.characterName).toBe('Stan');
  });

  it('uses the character name as a deterministic equal-margin tie-breaker', () => {
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter('Stan'),
        buildCharacter('Cartman'),
        buildCharacter('Kyle'),
      ],
    });

    const result = planMonsterReplenishment(
      snapshot,
      buildState(),
      buildMonster(),
    );

    expect(result._unsafeUnwrap().activities[0]?.characterName).toBe('Cartman');
  });

  it('restores a low-HP fighter in the safety calculation', () => {
    const snapshot = buildSnapshot({
      characters: [buildCharacter('Cartman', { hp: 1 })],
    });

    const result = planMonsterReplenishment(
      snapshot,
      buildState(),
      buildMonster(),
    );

    expect(result._unsafeUnwrap().activities).toHaveLength(1);
  });

  it('ignores unrelated bank rows when checking the stock target', () => {
    const result = planMonsterReplenishment(
      buildSnapshot({ bank: [{ code: 'copper_ore', quantity: 50 }] }),
      buildState(),
      buildMonster(),
    );

    expect(result._unsafeUnwrap().activities).toHaveLength(1);
  });

  it('removes a satisfied Goal without validating its monster source', () => {
    const nextGoal = buildGoal({ id: 'next-goal' });
    const state = buildState({ goals: [buildGoal(), nextGoal] });
    const snapshot = buildSnapshot({
      bank: [{ code: 'slime_gel', quantity: 50 }],
    });

    expect(
      planMonsterReplenishment(
        snapshot,
        state,
        buildMonster({ drops: [] }),
      )._unsafeUnwrap(),
    ).toEqual({
      activities: [],
      state: { goals: [nextGoal], reservations: [] },
    });
  });

  it('waits for an active Goal reservation even after the bank target is met', () => {
    const reservation = buildReservation({ goalId: 'replenish-slime-gel' });
    const state = buildState({ reservations: [reservation] });
    const snapshot = buildSnapshot({
      bank: [{ code: 'slime_gel', quantity: 50 }],
    });

    expect(
      planMonsterReplenishment(snapshot, state, buildMonster())._unsafeUnwrap(),
    ).toEqual({ activities: [], state });
  });

  it('waits while another Goal produces the target item', () => {
    const state = buildState({
      reservations: [
        buildReservation({ produces: [{ itemCode: 'slime_gel' }] }),
      ],
    });

    expect(
      planMonsterReplenishment(
        buildSnapshot(),
        state,
        buildMonster(),
      )._unsafeUnwrap(),
    ).toEqual({ activities: [], state });
  });

  it('waits for an active bank withdrawal in the persisted reservation state', () => {
    const state = buildState({
      reservations: [
        buildReservation({
          activity: {
            itemCode: 'slime_gel',
            quantity: 1,
            type: 'withdrawItem',
          },
          consumes: [{ itemCode: 'slime_gel', quantity: 1 }],
        }),
      ],
    });
    const snapshot = buildSnapshot({
      bank: [{ code: 'slime_gel', quantity: 50 }],
    });

    expect(
      planMonsterReplenishment(snapshot, state, buildMonster())._unsafeUnwrap(),
    ).toEqual({ activities: [], state });
  });

  it('can replenish for a withdrawal proposed in this planning decision', () => {
    const reservation = buildReservation({
      activity: { itemCode: 'slime_gel', quantity: 1, type: 'withdrawItem' },
      consumes: [{ itemCode: 'slime_gel', quantity: 1 }],
    });
    const snapshot = buildSnapshot({
      bank: [{ code: 'slime_gel', quantity: 50 }],
    });

    const result = planMonsterReplenishment(
      snapshot,
      buildState({ reservations: [reservation] }),
      buildMonster(),
      [],
    );

    expect(result._unsafeUnwrap().activities).toHaveLength(1);
  });

  it('excludes characters reserved by another Goal', () => {
    const state = buildState({
      reservations: [buildReservation({ characterName: 'Cartman' })],
    });

    const result = planMonsterReplenishment(
      buildSnapshot(),
      state,
      buildMonster(),
    );

    expect(result._unsafeUnwrap().activities[0]?.characterName).toBe('Stan');
  });

  it('waits when every safe fighter is reserved', () => {
    const state = buildState({
      reservations: [
        buildReservation({ characterName: 'Cartman' }),
        buildReservation({ characterName: 'Stan' }),
      ],
    });

    expect(
      planMonsterReplenishment(
        buildSnapshot(),
        state,
        buildMonster(),
      )._unsafeUnwrap(),
    ).toEqual({ activities: [], state });
  });

  it('reports when no character can safely fight the monster', () => {
    const snapshot = buildSnapshot({
      characters: [buildCharacter('Cartman', { attack_earth: 1, hp: 10 })],
    });
    const monster = buildMonster({ attack_earth: 10, hp: 100 });

    const result = planMonsterReplenishment(snapshot, buildState(), monster);

    expect(result._unsafeUnwrapErr()).toEqual(
      new NoSafeMonsterFighterError('slime_gel', 'yellow_slime'),
    );
  });

  it.each([
    {
      expected: new InvalidMonsterTargetError(
        'minimumBankQuantity must be greater than zero',
      ),
      goal: buildGoal({ minimumBankQuantity: 0 }),
      monster: buildMonster(),
    },
    {
      expected: new InvalidMonsterTargetError(
        'yellow_slime does not drop slime_gel',
      ),
      goal: buildGoal(),
      monster: buildMonster({
        drops: [
          { code: 'unrelated_drop', max_quantity: 1, min_quantity: 1, rate: 1 },
        ],
      }),
    },
  ])('validates the Goal and monster source', ({ expected, goal, monster }) => {
    const result = planMonsterReplenishment(
      buildSnapshot(),
      buildState({ goals: [goal] }),
      monster,
    );

    expect(result._unsafeUnwrapErr()).toEqual(expected);
  });

  it('does nothing for another Goal type', () => {
    const state: OrchestratorState = {
      goals: [
        {
          characterName: 'Stan',
          id: 'equip-stan-dagger',
          itemCode: 'copper_dagger',
          origin: 'configured',
          type: 'equipItem',
        },
      ],
      reservations: [],
    };

    expect(
      planMonsterReplenishment(
        buildSnapshot(),
        state,
        buildMonster(),
      )._unsafeUnwrap(),
    ).toEqual({ activities: [], state });
  });
});
