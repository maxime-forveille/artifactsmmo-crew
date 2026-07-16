import { describe, expect, it } from 'vitest';

import type { CrewSnapshot } from '../src/bot/orchestration/crewSnapshot.js';
import {
  EquipmentCharacterNotFoundError,
  InvalidEquipmentMaterialSourceError,
  InvalidEquipmentTargetError,
  NoSafeEquipmentMaterialHunterError,
  planEquipmentProgression,
} from '../src/bot/orchestration/equipmentProgression.js';
import type {
  EquipItemGoal,
  OrchestratorState,
  Reservation,
} from '../src/bot/orchestration/orchestratorState.js';
import { NoEligibleGathererError } from '../src/bot/orchestration/resourceReplenishment.js';
import type { components } from '../src/client/schema.js';

type Character = components['schemas']['CharacterSchema'];
type Item = components['schemas']['ItemSchema'];
type Monster = components['schemas']['MonsterSchema'];
type Resource = components['schemas']['ResourceSchema'];

const buildGoal = (overrides: Partial<EquipItemGoal> = {}): EquipItemGoal => ({
  characterName: 'Stan',
  id: 'equip-stan-dagger',
  itemCode: 'copper_dagger',
  type: 'equipItem',
  ...overrides,
});

const buildCharacter = (overrides: Partial<Character> = {}): Character => ({
  ...({} as Character),
  inventory: [],
  level: 5,
  name: 'Stan',
  weapon_slot: 'wooden_stick',
  weaponcrafting_level: 5,
  ...overrides,
});

const buildItem = (overrides: Partial<Item> = {}): Item => ({
  ...({} as Item),
  code: 'copper_dagger',
  craft: {
    items: [{ code: 'copper_bar', quantity: 2 }],
    level: 5,
    quantity: 1,
    skill: 'weaponcrafting',
  },
  level: 5,
  type: 'weapon',
  ...overrides,
});

const buildRawItem = (code: string): Item => {
  const item = buildItem({ code });
  delete item.craft;
  return item;
};

const buildMonster = (overrides: Partial<Monster> = {}): Monster => ({
  ...({} as Monster),
  attack_air: 0,
  attack_earth: 2,
  attack_fire: 0,
  attack_water: 0,
  code: 'yellow_slime',
  critical_strike: 0,
  drops: [
    { code: 'yellow_slimeball', max_quantity: 1, min_quantity: 1, rate: 1 },
  ],
  hp: 20,
  level: 2,
  name: 'Yellow Slime',
  res_air: 0,
  res_earth: 0,
  res_fire: 0,
  res_water: 0,
  ...overrides,
});

const buildResource = (overrides: Partial<Resource> = {}): Resource => ({
  code: 'copper_rocks',
  drops: [{ code: 'copper_ore', max_quantity: 1, min_quantity: 1, rate: 1 }],
  level: 1,
  name: 'Copper Rocks',
  skill: 'mining',
  ...overrides,
});

const buildFighter = (overrides: Partial<Character> = {}): Character =>
  buildCharacter({
    attack_air: 0,
    attack_earth: 10,
    attack_fire: 0,
    attack_water: 0,
    critical_strike: 0,
    hp: 100,
    max_hp: 100,
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
  capturedAt: '2026-07-16T12:00:00.000Z',
  characters: [buildCharacter()],
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
  activity: { monsterCode: 'yellow_slime', type: 'huntMonster' },
  characterName: 'Stan',
  consumes: [],
  goalId: 'another-goal',
  produces: [],
  ...overrides,
});

describe('planEquipmentProgression', () => {
  it('completes the Goal when the target is already equipped', () => {
    const nextGoal = buildGoal({ characterName: 'Kyle', id: 'next-goal' });
    const state = buildState({ goals: [buildGoal(), nextGoal] });
    const snapshot = buildSnapshot({
      characters: [buildCharacter({ weapon_slot: 'copper_dagger' })],
    });

    const result = planEquipmentProgression(snapshot, state, buildItem());

    expect(result._unsafeUnwrap()).toEqual({
      activities: [],
      state: { goals: [nextGoal], reservations: [] },
    });
  });

  it('equips the target when the character already holds it', () => {
    const state = buildState();
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter({
          inventory: [{ code: 'copper_dagger', quantity: 1, slot: 1 }],
        }),
      ],
    });

    const result = planEquipmentProgression(snapshot, state, buildItem());

    expect(result._unsafeUnwrap()).toEqual({
      activities: [
        {
          activity: { itemCode: 'copper_dagger', type: 'equipItem' },
          characterName: 'Stan',
          consumes: [{ itemCode: 'copper_dagger', quantity: 1 }],
          goalId: 'equip-stan-dagger',
          produces: [],
        },
      ],
      state,
    });
  });

  it('crafts one target when it is absent and craftable', () => {
    const state = buildState();

    const result = planEquipmentProgression(
      buildSnapshot(),
      state,
      buildItem(),
    );

    expect(result._unsafeUnwrap()).toEqual({
      activities: [
        {
          activity: {
            itemCode: 'copper_dagger',
            quantity: 1,
            type: 'craftItem',
          },
          characterName: 'Stan',
          consumes: [],
          goalId: 'equip-stan-dagger',
          produces: [{ itemCode: 'copper_dagger', quantity: 1 }],
        },
      ],
      state,
    });
  });

  it('assigns the target craft to another eligible character', () => {
    const state = buildState();
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter({ weaponcrafting_level: 0 }),
        buildCharacter({
          inventory: [{ code: 'copper_bar', quantity: 2, slot: 1 }],
          name: 'Kyle',
          weaponcrafting_level: 8,
        }),
      ],
    });

    const result = planEquipmentProgression(snapshot, state, buildItem());

    expect(result._unsafeUnwrap().activities[0]).toMatchObject({
      activity: { itemCode: 'copper_dagger', quantity: 1, type: 'craftItem' },
      characterName: 'Kyle',
    });
  });

  it('assigns a target craft to the eligible character with the highest skill', () => {
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter({ weaponcrafting_level: 0 }),
        buildCharacter({ name: 'Kyle', weaponcrafting_level: 6 }),
        buildCharacter({ name: 'Cartman', weaponcrafting_level: 8 }),
      ],
    });
    const item = buildItem({
      craft: { items: [], level: 5, quantity: 1, skill: 'weaponcrafting' },
    });

    const result = planEquipmentProgression(snapshot, buildState(), item);

    expect(result._unsafeUnwrap().activities[0]).toMatchObject({
      activity: { itemCode: 'copper_dagger', quantity: 1, type: 'craftItem' },
      characterName: 'Cartman',
    });
  });

  it('breaks equal crafter skill ties by character name', () => {
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter({ weaponcrafting_level: 0 }),
        buildCharacter({ name: 'Kyle', weaponcrafting_level: 8 }),
        buildCharacter({ name: 'Cartman', weaponcrafting_level: 8 }),
      ],
    });
    const item = buildItem({
      craft: { items: [], level: 5, quantity: 1, skill: 'weaponcrafting' },
    });

    const result = planEquipmentProgression(snapshot, buildState(), item);

    expect(result._unsafeUnwrap().activities[0]).toMatchObject({
      activity: { itemCode: 'copper_dagger', quantity: 1, type: 'craftItem' },
      characterName: 'Cartman',
    });
  });

  it('withdraws a banked target instead of crafting a duplicate', () => {
    const state = buildState();
    const result = planEquipmentProgression(
      buildSnapshot({ bank: [{ code: 'copper_dagger', quantity: 1 }] }),
      state,
      buildItem(),
    );

    expect(result._unsafeUnwrap()).toEqual({
      activities: [
        {
          activity: {
            itemCode: 'copper_dagger',
            quantity: 1,
            type: 'withdrawItem',
          },
          characterName: 'Stan',
          consumes: [{ itemCode: 'copper_dagger', quantity: 1 }],
          goalId: 'equip-stan-dagger',
          produces: [],
        },
      ],
      state,
    });
  });

  it('waits when the observed target is reserved for another withdrawal', () => {
    const state = buildState({
      reservations: [
        buildReservation({
          activity: {
            itemCode: 'copper_dagger',
            quantity: 1,
            type: 'withdrawItem',
          },
          characterName: 'Kyle',
          consumes: [{ itemCode: 'copper_dagger', quantity: 1 }],
        }),
      ],
    });
    const result = planEquipmentProgression(
      buildSnapshot({ bank: [{ code: 'copper_dagger', quantity: 1 }] }),
      state,
      buildItem(),
    );

    expect(result._unsafeUnwrap()).toEqual({ activities: [], state });
  });

  it('withdraws a missing recipe material before crafting the target', () => {
    const state = buildState();
    const result = planEquipmentProgression(
      buildSnapshot({ bank: [{ code: 'copper_bar', quantity: 5 }] }),
      state,
      buildItem(),
    );

    expect(result._unsafeUnwrap()).toEqual({
      activities: [
        {
          activity: {
            itemCode: 'copper_bar',
            quantity: 2,
            type: 'withdrawItem',
          },
          characterName: 'Stan',
          consumes: [{ itemCode: 'copper_bar', quantity: 2 }],
          goalId: 'equip-stan-dagger',
          produces: [],
        },
      ],
      state,
    });
  });

  it('withdraws only the remaining recipe quantity', () => {
    const character = buildCharacter({
      inventory: [{ code: 'copper_bar', quantity: 1, slot: 1 }],
    });
    const result = planEquipmentProgression(
      buildSnapshot({
        bank: [{ code: 'copper_bar', quantity: 5 }],
        characters: [character],
      }),
      buildState(),
      buildItem(),
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: 'copper_bar',
      quantity: 1,
      type: 'withdrawItem',
    });
  });

  it('withdraws only material stock not consumed by another Reservation', () => {
    const state = buildState({
      reservations: [
        buildReservation({
          activity: {
            itemCode: 'copper_bar',
            quantity: 2,
            type: 'withdrawItem',
          },
          characterName: 'Kyle',
          consumes: [{ itemCode: 'copper_bar', quantity: 2 }],
        }),
      ],
    });
    const result = planEquipmentProgression(
      buildSnapshot({ bank: [{ code: 'copper_bar', quantity: 3 }] }),
      state,
      buildItem(),
    );

    expect(result._unsafeUnwrap().activities[0]).toMatchObject({
      activity: { itemCode: 'copper_bar', quantity: 1, type: 'withdrawItem' },
      consumes: [{ itemCode: 'copper_bar', quantity: 1 }],
    });
  });

  it('waits when all observed material stock is reserved for withdrawal', () => {
    const state = buildState({
      reservations: [
        buildReservation({
          activity: {
            itemCode: 'copper_bar',
            quantity: 2,
            type: 'withdrawItem',
          },
          characterName: 'Kyle',
          consumes: [{ itemCode: 'copper_bar', quantity: 2 }],
        }),
      ],
    });
    const result = planEquipmentProgression(
      buildSnapshot({ bank: [{ code: 'copper_bar', quantity: 2 }] }),
      state,
      buildItem(),
    );

    expect(result._unsafeUnwrap()).toEqual({ activities: [], state });
  });

  it('waits when reserved withdrawals exceed the observed material stock', () => {
    const state = buildState({
      reservations: [
        buildReservation({
          activity: {
            itemCode: 'copper_bar',
            quantity: 2,
            type: 'withdrawItem',
          },
          characterName: 'Kyle',
          consumes: [{ itemCode: 'copper_bar', quantity: 2 }],
        }),
      ],
    });
    const result = planEquipmentProgression(
      buildSnapshot({ bank: [{ code: 'copper_bar', quantity: 1 }] }),
      state,
      buildItem(),
    );

    expect(result._unsafeUnwrap()).toEqual({ activities: [], state });
  });

  it('waits for a reserved material withdrawal after bank stock changed', () => {
    const state = buildState({
      reservations: [
        buildReservation({
          activity: {
            itemCode: 'copper_bar',
            quantity: 2,
            type: 'withdrawItem',
          },
          characterName: 'Kyle',
          consumes: [{ itemCode: 'copper_bar', quantity: 2 }],
        }),
      ],
    });

    const result = planEquipmentProgression(
      buildSnapshot(),
      state,
      buildItem(),
    );

    expect(result._unsafeUnwrap()).toEqual({ activities: [], state });
  });

  it('waits while another Reservation produces a missing material', () => {
    const state = buildState({
      reservations: [
        buildReservation({
          characterName: 'Kyle',
          produces: [{ itemCode: 'copper_bar' }],
        }),
      ],
    });
    const copperBar = buildItem({ code: 'copper_bar' });

    const result = planEquipmentProgression(
      buildSnapshot(),
      state,
      buildItem(),
      undefined,
      [],
      [copperBar],
    );

    expect(result._unsafeUnwrap()).toEqual({ activities: [], state });
  });

  it('does not acquire a recipe material already held in full', () => {
    const character = buildCharacter({
      inventory: [{ code: 'copper_bar', quantity: 2, slot: 1 }],
    });
    const result = planEquipmentProgression(
      buildSnapshot({
        bank: [{ code: 'copper_bar', quantity: 5 }],
        characters: [character],
      }),
      buildState(),
      buildItem(),
      undefined,
      [
        {
          itemCode: 'copper_bar',
          source: {
            resource: buildResource({
              drops: [
                {
                  code: 'copper_bar',
                  max_quantity: 1,
                  min_quantity: 1,
                  rate: 1,
                },
              ],
            }),
            type: 'gather',
          },
        },
      ],
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'craftItem',
    });
  });

  it('crafts a recipe that declares no material list', () => {
    const item = buildItem({ craft: { skill: 'weaponcrafting' } });

    const result = planEquipmentProgression(
      buildSnapshot(),
      buildState(),
      item,
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'craftItem',
    });
  });

  it('crafts once every direct recipe material is already held', () => {
    const character = buildCharacter({
      inventory: [{ code: 'copper_bar', quantity: 2, slot: 1 }],
    });
    const result = planEquipmentProgression(
      buildSnapshot({ characters: [character] }),
      buildState(),
      buildItem(),
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'craftItem',
    });
  });

  it('withdraws raw inputs required by a craftable intermediate', () => {
    const target = buildItem({
      craft: {
        items: [{ code: 'copper_bar', quantity: 2 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const copperBar = buildItem({
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const copperOre = buildRawItem('copper_ore');

    const result = planEquipmentProgression(
      buildSnapshot({ bank: [{ code: 'copper_ore', quantity: 10 }] }),
      buildState(),
      target,
      undefined,
      [],
      [copperBar, copperOre],
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: 'copper_ore',
      quantity: 6,
      type: 'withdrawItem',
    });
  });

  it('crafts an intermediate once its recursively required inputs are held', () => {
    const target = buildItem({
      craft: {
        items: [{ code: 'copper_bar', quantity: 2 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const copperBar = buildItem({
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const copperOre = buildRawItem('copper_ore');
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter({
          inventory: [{ code: 'copper_ore', quantity: 6, slot: 1 }],
        }),
      ],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      target,
      undefined,
      [],
      [copperBar, copperOre],
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: 'copper_bar',
      quantity: 2,
      type: 'craftItem',
    });
  });

  it('assigns an intermediate craft to another eligible character', () => {
    const copperBar = buildItem({
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 5,
        quantity: 1,
        skill: 'mining',
      },
    });
    const copperOre = buildRawItem('copper_ore');
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter({ mining_level: 0 }),
        buildCharacter({
          inventory: [{ code: 'copper_ore', quantity: 6, slot: 1 }],
          mining_level: 8,
          name: 'Kyle',
        }),
      ],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      buildItem(),
      undefined,
      [],
      [copperBar, copperOre],
    );

    expect(result._unsafeUnwrap().activities).toEqual([
      {
        activity: { itemCode: 'copper_bar', quantity: 2, type: 'craftItem' },
        characterName: 'Kyle',
        consumes: [],
        goalId: 'equip-stan-dagger',
        produces: [{ itemCode: 'copper_bar', quantity: 2 }],
      },
    ]);
  });

  it('deposits an intermediate held by another character for shared use', () => {
    const copperBar = buildItem({ code: 'copper_bar' });
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter(),
        buildCharacter({
          inventory: [{ code: 'copper_bar', quantity: 2, slot: 1 }],
          name: 'Kyle',
        }),
      ],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      buildItem(),
      undefined,
      [],
      [copperBar],
    );

    expect(result._unsafeUnwrap().activities).toEqual([
      {
        activity: { itemCode: 'copper_bar', quantity: 2, type: 'depositItem' },
        characterName: 'Kyle',
        consumes: [],
        goalId: 'equip-stan-dagger',
        produces: [{ itemCode: 'copper_bar', quantity: 2 }],
      },
    ]);
  });

  it('deposits only the intermediate quantity still missing', () => {
    const target = buildItem({
      craft: {
        items: [{ code: 'copper_bar', quantity: 3 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const copperBar = buildItem({ code: 'copper_bar' });
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter({
          inventory: [{ code: 'copper_bar', quantity: 1, slot: 1 }],
        }),
        buildCharacter({
          inventory: [{ code: 'copper_bar', quantity: 5, slot: 1 }],
          name: 'Kyle',
        }),
      ],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      target,
      undefined,
      [],
      [copperBar],
    );

    expect(result._unsafeUnwrap().activities[0]).toMatchObject({
      activity: { itemCode: 'copper_bar', quantity: 2, type: 'depositItem' },
      characterName: 'Kyle',
    });
  });

  it('deposits an intermediate from the character holding the most', () => {
    const copperBar = buildItem({ code: 'copper_bar' });
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter(),
        buildCharacter({
          inventory: [{ code: 'copper_bar', quantity: 1, slot: 1 }],
          name: 'Kyle',
        }),
        buildCharacter({
          inventory: [{ code: 'copper_bar', quantity: 3, slot: 1 }],
          name: 'Cartman',
        }),
      ],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      buildItem(),
      undefined,
      [],
      [copperBar],
    );

    expect(result._unsafeUnwrap().activities[0]).toMatchObject({
      activity: { itemCode: 'copper_bar', quantity: 2, type: 'depositItem' },
      characterName: 'Cartman',
    });
  });

  it('breaks equal intermediate holder ties by character name', () => {
    const copperBar = buildItem({ code: 'copper_bar' });
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter(),
        buildCharacter({
          inventory: [{ code: 'copper_bar', quantity: 2, slot: 1 }],
          name: 'Kyle',
        }),
        buildCharacter({
          inventory: [{ code: 'copper_bar', quantity: 2, slot: 1 }],
          name: 'Cartman',
        }),
      ],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      buildItem(),
      undefined,
      [],
      [copperBar],
    );

    expect(result._unsafeUnwrap().activities[0]).toMatchObject({
      activity: { itemCode: 'copper_bar', quantity: 2, type: 'depositItem' },
      characterName: 'Cartman',
    });
  });

  it('waits when the only intermediate holder is busy', () => {
    const copperBar = buildItem({ code: 'copper_bar' });
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter(),
        buildCharacter({
          inventory: [{ code: 'copper_bar', quantity: 2, slot: 1 }],
          name: 'Kyle',
        }),
      ],
    });
    const state = buildState({
      reservations: [buildReservation({ characterName: 'Kyle' })],
    });

    const result = planEquipmentProgression(
      snapshot,
      state,
      buildItem(),
      undefined,
      [],
      [copperBar],
    );

    expect(result._unsafeUnwrap()).toEqual({ activities: [], state });
  });

  it('waits when the only eligible intermediate crafter is busy', () => {
    const copperBar = buildItem({
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 5,
        quantity: 1,
        skill: 'mining',
      },
    });
    const copperOre = buildRawItem('copper_ore');
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter({ mining_level: 0 }),
        buildCharacter({ mining_level: 8, name: 'Kyle' }),
      ],
    });
    const state = buildState({
      reservations: [buildReservation({ characterName: 'Kyle' })],
    });

    const result = planEquipmentProgression(
      snapshot,
      state,
      buildItem(),
      undefined,
      [],
      [copperBar, copperOre],
    );

    expect(result._unsafeUnwrap()).toEqual({ activities: [], state });
  });

  it('accounts for held output and recipe yield when crafting an intermediate', () => {
    const target = buildItem({
      craft: {
        items: [{ code: 'copper_bar', quantity: 3 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const copperBar = buildItem({
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 1,
        quantity: 2,
        skill: 'weaponcrafting',
      },
    });
    const copperOre = buildRawItem('copper_ore');
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter({
          inventory: [
            { code: 'copper_bar', quantity: 1, slot: 1 },
            { code: 'copper_ore', quantity: 3, slot: 2 },
          ],
        }),
      ],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      target,
      undefined,
      [],
      [copperBar, copperOre],
    );

    expect(result._unsafeUnwrap().activities[0]).toMatchObject({
      activity: { itemCode: 'copper_bar', quantity: 1, type: 'craftItem' },
      produces: [{ itemCode: 'copper_bar', quantity: 2 }],
    });
  });

  it('crafts the equipment target once its intermediate is held', () => {
    const target = buildItem({
      craft: {
        items: [{ code: 'copper_bar', quantity: 2 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const copperBar = buildItem({
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter({
          inventory: [{ code: 'copper_bar', quantity: 2, slot: 1 }],
        }),
      ],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      target,
      undefined,
      [],
      [copperBar],
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'craftItem',
    });
  });

  it('acquires a recursively missing raw input for an intermediate', () => {
    const target = buildItem({
      craft: {
        items: [{ code: 'copper_bar', quantity: 2 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const copperBar = buildItem({
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const copperOre = buildRawItem('copper_ore');
    const snapshot = buildSnapshot({
      characters: [buildCharacter({ mining_level: 5 })],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      target,
      undefined,
      [
        {
          itemCode: 'copper_ore',
          source: { resource: buildResource(), type: 'gather' },
        },
      ],
      [copperBar, copperOre],
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      resourceCode: 'copper_rocks',
      type: 'farmResource',
    });
  });

  it('exposes an intermediate profession-level Blocker before acquiring inputs', () => {
    const target = buildItem({
      craft: {
        items: [{ code: 'copper_bar', quantity: 2 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const copperBar = buildItem({
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 6,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const copperOre = buildRawItem('copper_ore');

    const result = planEquipmentProgression(
      buildSnapshot(),
      buildState(),
      target,
      undefined,
      [
        {
          itemCode: 'copper_ore',
          source: { resource: buildResource(), type: 'gather' },
        },
      ],
      [copperBar, copperOre],
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: 'copper_bar',
      quantity: 2,
      type: 'craftItem',
    });
  });

  it('waits when a recursively resolved raw source has no idle producer', () => {
    const target = buildItem({
      craft: {
        items: [{ code: 'copper_bar', quantity: 1 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const copperBar = buildItem({
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const copperOre = buildRawItem('copper_ore');
    const reservation = buildReservation({ characterName: 'Cartman' });
    const state = buildState({ reservations: [reservation] });
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter({ mining_level: 0 }),
        buildCharacter({ mining_level: 5, name: 'Cartman' }),
      ],
    });

    const result = planEquipmentProgression(
      snapshot,
      state,
      target,
      undefined,
      [
        {
          itemCode: 'copper_ore',
          source: { resource: buildResource(), type: 'gather' },
        },
      ],
      [copperBar, copperOre],
    );

    expect(result._unsafeUnwrap()).toEqual({ activities: [], state });
  });

  it('propagates an invalid recursively resolved raw source', () => {
    const target = buildItem({
      craft: {
        items: [{ code: 'copper_bar', quantity: 1 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const copperBar = buildItem({
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const copperOre = buildRawItem('copper_ore');
    const resource = buildResource({
      drops: [{ code: 'iron_ore', max_quantity: 1, min_quantity: 1, rate: 1 }],
    });

    const result = planEquipmentProgression(
      buildSnapshot(),
      buildState(),
      target,
      undefined,
      [{ itemCode: 'copper_ore', source: { resource, type: 'gather' } }],
      [copperBar, copperOre],
    );

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      InvalidEquipmentMaterialSourceError,
    );
  });

  it('stops a cyclic intermediate recipe instead of recursing forever', () => {
    const target = buildItem({
      craft: {
        items: [{ code: 'copper_bar', quantity: 1 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const copperBar = buildItem({
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_dagger', quantity: 1 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });

    const result = planEquipmentProgression(
      buildSnapshot(),
      buildState(),
      target,
      undefined,
      [],
      [copperBar],
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'craftItem',
    });
  });

  it('assigns the best eligible gatherer for a missing raw material', () => {
    const item = buildItem({
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter({ mining_level: 1 }),
        buildCharacter({ mining_level: 8, name: 'Cartman' }),
      ],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      item,
      undefined,
      [
        {
          itemCode: 'iron_ore',
          source: {
            resource: buildResource({ code: 'iron_rocks' }),
            type: 'gather',
          },
        },
        {
          itemCode: 'copper_ore',
          source: {
            resource: buildResource({
              drops: [
                {
                  code: 'copper_ore',
                  max_quantity: 1,
                  min_quantity: 1,
                  rate: 1,
                },
                { code: 'stone', max_quantity: 1, min_quantity: 1, rate: 1 },
              ],
            }),
            type: 'gather',
          },
        },
      ],
    );

    expect(result._unsafeUnwrap().activities).toEqual([
      {
        activity: { resourceCode: 'copper_rocks', type: 'farmResource' },
        characterName: 'Cartman',
        consumes: [],
        goalId: 'equip-stan-dagger',
        produces: [{ itemCode: 'copper_ore' }],
      },
    ]);
  });

  it('acquires the first still-missing material in recipe order', () => {
    const item = buildItem({
      craft: {
        items: [
          { code: 'copper_bar', quantity: 2 },
          { code: 'copper_ore', quantity: 3 },
        ],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter({
          inventory: [{ code: 'copper_bar', quantity: 2, slot: 1 }],
          mining_level: 5,
        }),
      ],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      item,
      undefined,
      [
        {
          itemCode: 'copper_ore',
          source: { resource: buildResource(), type: 'gather' },
        },
      ],
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      resourceCode: 'copper_rocks',
      type: 'farmResource',
    });
  });

  it('assigns the safest hunter for a missing raw monster drop', () => {
    const item = buildItem({
      craft: {
        items: [{ code: 'yellow_slimeball', quantity: 2 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const snapshot = buildSnapshot({
      characters: [
        buildFighter({ attack_earth: 5, name: 'Cartman' }),
        buildFighter({ attack_earth: 20, name: 'Stan' }),
      ],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      item,
      undefined,
      [
        {
          itemCode: 'yellow_slimeball',
          source: {
            monster: buildMonster({
              drops: [
                {
                  code: 'yellow_slimeball',
                  max_quantity: 1,
                  min_quantity: 1,
                  rate: 1,
                },
                {
                  code: 'slime_residue',
                  max_quantity: 1,
                  min_quantity: 1,
                  rate: 1,
                },
              ],
            }),
            type: 'hunt',
          },
        },
      ],
    );

    expect(result._unsafeUnwrap().activities).toEqual([
      {
        activity: { monsterCode: 'yellow_slime', type: 'huntMonster' },
        characterName: 'Stan',
        consumes: [],
        goalId: 'equip-stan-dagger',
        produces: [{ itemCode: 'yellow_slimeball' }],
      },
    ]);
  });

  it('keeps an earlier hunter when later candidates have a worse margin', () => {
    const item = buildItem({
      craft: {
        items: [{ code: 'yellow_slimeball', quantity: 2 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const snapshot = buildSnapshot({
      characters: [
        buildFighter({ attack_earth: 20, name: 'Stan' }),
        buildFighter({ attack_earth: 5, name: 'Cartman' }),
      ],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      item,
      undefined,
      [
        {
          itemCode: 'yellow_slimeball',
          source: { monster: buildMonster(), type: 'hunt' },
        },
      ],
    );

    expect(result._unsafeUnwrap().activities[0]?.characterName).toBe('Stan');
  });

  it('breaks equal hunter margins by character name', () => {
    const item = buildItem({
      craft: {
        items: [{ code: 'yellow_slimeball', quantity: 2 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const snapshot = buildSnapshot({
      characters: [
        buildFighter({ name: 'Cartman' }),
        buildFighter({ name: 'Stan' }),
      ],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      item,
      undefined,
      [
        {
          itemCode: 'yellow_slimeball',
          source: { monster: buildMonster(), type: 'hunt' },
        },
      ],
    );

    expect(result._unsafeUnwrap().activities[0]?.characterName).toBe('Cartman');
  });

  it('assesses material hunters at post-rest HP', () => {
    const item = buildItem({
      craft: {
        items: [{ code: 'yellow_slimeball', quantity: 2 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const snapshot = buildSnapshot({
      characters: [buildFighter({ hp: 1, max_hp: 100 })],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      item,
      undefined,
      [
        {
          itemCode: 'yellow_slimeball',
          source: { monster: buildMonster(), type: 'hunt' },
        },
      ],
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      monsterCode: 'yellow_slime',
      type: 'huntMonster',
    });
  });

  it('waits when every eligible material gatherer is already reserved', () => {
    const item = buildItem({
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const reservation = buildReservation({ characterName: 'Cartman' });
    const state = buildState({ reservations: [reservation] });
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter({ mining_level: 0 }),
        buildCharacter({ mining_level: 8, name: 'Cartman' }),
      ],
    });

    const result = planEquipmentProgression(snapshot, state, item, undefined, [
      {
        itemCode: 'copper_ore',
        source: { resource: buildResource(), type: 'gather' },
      },
    ]);

    expect(result._unsafeUnwrap()).toEqual({ activities: [], state });
  });

  it('waits when every safe material hunter is already reserved', () => {
    const item = buildItem({
      craft: {
        items: [{ code: 'yellow_slimeball', quantity: 2 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const reservation = buildReservation({ characterName: 'Cartman' });
    const state = buildState({ reservations: [reservation] });
    const snapshot = buildSnapshot({
      characters: [
        buildFighter({ attack_earth: 0, name: 'Stan' }),
        buildFighter({ attack_earth: 20, name: 'Cartman' }),
      ],
    });

    const result = planEquipmentProgression(snapshot, state, item, undefined, [
      {
        itemCode: 'yellow_slimeball',
        source: { monster: buildMonster(), type: 'hunt' },
      },
    ]);

    expect(result._unsafeUnwrap()).toEqual({ activities: [], state });
  });

  it('rejects a gather material when no character has the required skill', () => {
    const item = buildItem({
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const resource = buildResource({ level: 2 });
    const snapshot = buildSnapshot({
      characters: [buildCharacter({ mining_level: 1 })],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      item,
      undefined,
      [{ itemCode: 'copper_ore', source: { resource, type: 'gather' } }],
    );

    expect(result._unsafeUnwrapErr()).toEqual(
      new NoEligibleGathererError('copper_rocks', 'mining', 2),
    );
  });

  it('rejects a resolved source that does not produce the missing material', () => {
    const item = buildItem({
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const source = buildResource({
      drops: [{ code: 'iron_ore', max_quantity: 1, min_quantity: 1, rate: 1 }],
    });

    const result = planEquipmentProgression(
      buildSnapshot(),
      buildState(),
      item,
      undefined,
      [
        {
          itemCode: 'copper_ore',
          source: { resource: source, type: 'gather' },
        },
      ],
    );

    expect(result._unsafeUnwrapErr()).toMatchObject({
      itemCode: 'copper_ore',
      message:
        'Source copper_rocks does not produce equipment material copper_ore',
      name: 'InvalidEquipmentMaterialSourceError',
      sourceCode: 'copper_rocks',
    });
  });

  it('rejects a resolved monster that does not produce the missing material', () => {
    const item = buildItem({
      craft: {
        items: [{ code: 'yellow_slimeball', quantity: 2 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const monster = buildMonster({
      drops: [{ code: 'wolf_hair', max_quantity: 1, min_quantity: 1, rate: 1 }],
    });

    const result = planEquipmentProgression(
      buildSnapshot(),
      buildState(),
      item,
      undefined,
      [{ itemCode: 'yellow_slimeball', source: { monster, type: 'hunt' } }],
    );

    expect(result._unsafeUnwrapErr()).toEqual(
      new InvalidEquipmentMaterialSourceError(
        'yellow_slimeball',
        'yellow_slime',
      ),
    );
  });

  it('rejects a monster material when no character can hunt it safely', () => {
    const item = buildItem({
      craft: {
        items: [{ code: 'yellow_slimeball', quantity: 2 }],
        level: 5,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const snapshot = buildSnapshot({
      characters: [buildFighter({ attack_earth: 0, hp: 10 })],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      item,
      undefined,
      [
        {
          itemCode: 'yellow_slimeball',
          source: {
            monster: buildMonster({ attack_earth: 20, hp: 200 }),
            type: 'hunt',
          },
        },
      ],
    );

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      NoSafeEquipmentMaterialHunterError,
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      itemCode: 'yellow_slimeball',
      message: 'No character can safely hunt yellow_slime for yellow_slimeball',
      monsterCode: 'yellow_slime',
      name: 'NoSafeEquipmentMaterialHunterError',
    });
  });

  it('does not acquire materials before the target crafting level is reached', () => {
    const item = buildItem({
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 6,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });

    const result = planEquipmentProgression(
      buildSnapshot(),
      buildState(),
      item,
      undefined,
      [
        {
          itemCode: 'copper_ore',
          source: { resource: buildResource(), type: 'gather' },
        },
      ],
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'craftItem',
    });
  });

  it('acquires materials for a recipe whose missing level defaults to zero', () => {
    const item = buildItem({
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter({ mining_level: 1, weaponcrafting_level: 0 }),
      ],
    });

    const result = planEquipmentProgression(
      snapshot,
      buildState(),
      item,
      undefined,
      [
        {
          itemCode: 'copper_ore',
          source: { resource: buildResource(), type: 'gather' },
        },
      ],
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      resourceCode: 'copper_rocks',
      type: 'farmResource',
    });
  });

  it('does not acquire materials for an item without a crafting skill', () => {
    const item = buildItem({
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 0,
        quantity: 1,
      },
    });

    const result = planEquipmentProgression(
      buildSnapshot(),
      buildState(),
      item,
      undefined,
      [
        {
          itemCode: 'copper_ore',
          source: { resource: buildResource(), type: 'gather' },
        },
      ],
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: 'copper_dagger',
      type: 'equipItem',
    });
  });

  it('ignores unrelated bank items when deciding whether to craft', () => {
    const result = planEquipmentProgression(
      buildSnapshot({ bank: [{ code: 'iron_ore', quantity: 100 }] }),
      buildState(),
      buildItem(),
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'craftItem',
    });
  });

  it('uses equip to expose a missing-item Blocker for a non-craftable target', () => {
    const state = buildState();
    const item = buildRawItem('copper_dagger');

    const result = planEquipmentProgression(buildSnapshot(), state, item);

    expect(result._unsafeUnwrap()).toEqual({
      activities: [
        {
          activity: { itemCode: 'copper_dagger', type: 'equipItem' },
          characterName: 'Stan',
          consumes: [{ itemCode: 'copper_dagger', quantity: 1 }],
          goalId: 'equip-stan-dagger',
          produces: [],
        },
      ],
      state,
    });
  });

  it('waits after its previous Activity returned a Blocker', () => {
    const state = buildState();
    const result = planEquipmentProgression(
      buildSnapshot(),
      state,
      buildItem(),
      { event: { goalId: 'equip-stan-dagger', type: 'blocked' } },
    );

    expect(result._unsafeUnwrap()).toEqual({ activities: [], state });
  });

  it('continues when the previous Blocker belongs to another Goal', () => {
    const result = planEquipmentProgression(
      buildSnapshot(),
      buildState(),
      buildItem(),
      { event: { goalId: 'another-goal', type: 'blocked' } },
    );

    expect(result._unsafeUnwrap().activities).toHaveLength(1);
  });

  it('waits while the Goal already has a Reservation', () => {
    const reservation = buildReservation({
      characterName: 'Kyle',
      goalId: 'equip-stan-dagger',
    });
    const state = buildState({ reservations: [reservation] });

    expect(
      planEquipmentProgression(
        buildSnapshot(),
        state,
        buildItem(),
      )._unsafeUnwrap(),
    ).toEqual({ activities: [], state });
  });

  it('waits while the target character works on another Goal', () => {
    const reservation = buildReservation();
    const state = buildState({ reservations: [reservation] });

    expect(
      planEquipmentProgression(
        buildSnapshot(),
        state,
        buildItem(),
      )._unsafeUnwrap(),
    ).toEqual({ activities: [], state });
  });

  it('continues when an unrelated character is reserved for another Goal', () => {
    const reservation = buildReservation({ characterName: 'Kyle' });
    const state = buildState({ reservations: [reservation] });

    expect(
      planEquipmentProgression(
        buildSnapshot(),
        state,
        buildItem(),
      )._unsafeUnwrap().activities,
    ).toHaveLength(1);
  });

  it('returns a typed error when the configured character is absent', () => {
    const result = planEquipmentProgression(
      buildSnapshot({ characters: [buildCharacter({ name: 'Kyle' })] }),
      buildState(),
      buildItem(),
    );

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      EquipmentCharacterNotFoundError,
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      characterName: 'Stan',
      message: 'Character "Stan" does not exist in the Crew Snapshot',
      name: 'EquipmentCharacterNotFoundError',
    });
  });

  it('rejects an item resolved for a different target', () => {
    const result = planEquipmentProgression(
      buildSnapshot(),
      buildState(),
      buildItem({ code: 'wooden_staff' }),
    );

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      InvalidEquipmentTargetError,
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      message:
        'Resolved item wooden_staff does not match equipment Goal target copper_dagger',
      name: 'InvalidEquipmentTargetError',
    });
  });

  it('rejects a target whose item type has no supported slot', () => {
    const result = planEquipmentProgression(
      buildSnapshot(),
      buildState(),
      buildItem({ type: 'artifact' }),
    );

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      InvalidEquipmentTargetError,
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      message: 'Item copper_dagger has unsupported equipment type artifact',
      name: 'InvalidEquipmentTargetError',
    });
  });

  it('does nothing when no Goals remain', () => {
    const state = buildState({ goals: [] });

    expect(
      planEquipmentProgression(
        buildSnapshot(),
        state,
        buildItem(),
      )._unsafeUnwrap(),
    ).toEqual({ activities: [], state });
  });

  it('does nothing when the first Goal is not an equipment Goal', () => {
    const state: OrchestratorState = {
      goals: [
        {
          id: 'replenish-copper',
          itemCode: 'copper_ore',
          minimumBankQuantity: 50,
          type: 'replenishBankItem',
        },
      ],
      reservations: [],
    };

    expect(
      planEquipmentProgression(
        buildSnapshot(),
        state,
        buildItem(),
      )._unsafeUnwrap(),
    ).toEqual({ activities: [], state });
  });
});
