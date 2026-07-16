import { errAsync, okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { InsufficientCraftingLevelError } from '../src/bot/activities/crafting.js';
import {
  craftAndEquip,
  craftItem,
  UnsafeMonsterError,
} from '../src/bot/activities/equipment.js';
import { UnsupportedEquipSlotError } from '../src/bot/activities/equipping.js';
import { MonsterNotFoundError } from '../src/bot/world.js';
import { ArtifactsApiError } from '../src/client/index.js';
import type { components } from '../src/client/schema.js';

type ItemResponse = components['schemas']['ItemResponseSchema'];
type Item = components['schemas']['ItemSchema'];
type CharacterSnapshot = components['schemas']['CharacterSchema'];
type MapPage = components['schemas']['StaticDataPage_MapSchema_'];
type Map = components['schemas']['MapSchema'];
type ResourcePage = components['schemas']['StaticDataPage_ResourceSchema_'];
type Resource = components['schemas']['ResourceSchema'];
type Cooldown = components['schemas']['CooldownSchema'];

const buildCooldown = (): Cooldown => ({
  expiration: '2024-01-01T00:00:05.000Z',
  reason: 'crafting',
  remaining_seconds: 0,
  started_at: '2024-01-01T00:00:00.000Z',
  total_seconds: 0,
});

const buildMap = (mapId: number): Map => ({ ...({} as Map), map_id: mapId });
const buildMapPage = (data: Map[]): MapPage => ({
  data,
  page: 1,
  pages: 1,
  size: 50,
  total: data.length,
});
const buildResource = (code: string): Resource => ({
  ...({} as Resource),
  code,
});
const buildResourcePage = (data: Resource[]): ResourcePage => ({
  data,
  page: 1,
  pages: 1,
  size: 50,
  total: data.length,
});

type Monster = components['schemas']['MonsterSchema'];
type MonsterPage = components['schemas']['StaticDataPage_MonsterSchema_'];
// Zeroed-out combat stats by default (a harmless target that can't hit
// back), so isSafeToFight's checks don't collapse to NaN just because a
// test only cares about the drop/hunting plumbing, not the fight itself.
const buildMonster = (
  code: string,
  overrides: Partial<Monster> = {},
): Monster =>
  ({
    attack_air: 0,
    attack_earth: 0,
    attack_fire: 0,
    attack_water: 0,
    critical_strike: 0,
    hp: 10,
    res_air: 0,
    res_earth: 0,
    res_fire: 0,
    res_water: 0,
    ...overrides,
    code,
  }) as Monster;
const buildMonsterPage = (data: Monster[]): MonsterPage => ({
  data,
  page: 1,
  pages: 1,
  size: 50,
  total: data.length,
});

type SimpleItem = components['schemas']['SimpleItemSchema'];
type BankItemsPage = components['schemas']['DataPage_SimpleItemSchema_'];
const buildBankItemsPage = (data: SimpleItem[]): BankItemsPage => ({
  data,
  page: 1,
  pages: 1,
  size: 50,
  total: data.length,
});
// Most tests don't care about bank contents - default to an empty bank so
// withdrawFromBankIfAvailable is a no-op unless a test overrides this.
const buildEmptyGetBankItems = () =>
  vi.fn(() => okAsync(buildBankItemsPage([])));

const buildItem = (overrides: Partial<Item>): Item => ({
  ...({} as Item),
  ...overrides,
});

/**
 * A tiny in-memory character whose inventory is mutated by gather/craft, like
 * the real agent would be.
 */
const createFakeCharacterState = (
  inventoryMaxItems = Number.MAX_SAFE_INTEGER,
  overrides: Partial<CharacterSnapshot> = {},
) => {
  const held = new Map<string, number>();

  const getCharacter = (): CharacterSnapshot =>
    ({
      ...({} as CharacterSnapshot),
      attack_air: 0,
      attack_earth: 10,
      attack_fire: 0,
      attack_water: 0,
      critical_strike: 0,
      inventory: [...held.entries()].map(([code, quantity], index) => ({
        code,
        quantity,
        slot: index,
      })),
      hp: 100,
      inventory_max_items: inventoryMaxItems,
      max_hp: 100,
      name: 'Cartman',
      res_air: 0,
      res_earth: 0,
      res_fire: 0,
      res_water: 0,
      ...overrides,
    }) as CharacterSnapshot;

  const add = (code: string, quantity: number) =>
    held.set(code, (held.get(code) ?? 0) + quantity);
  const remove = (code: string, quantity: number) =>
    held.set(code, (held.get(code) ?? 0) - quantity);

  return { add, getCharacter, remove };
};

describe('craftItem', () => {
  it('performs the target craft instead of withdrawing an already-banked output', async () => {
    const state = createFakeCharacterState(Number.MAX_SAFE_INTEGER, {
      weaponcrafting_level: 1,
    });
    state.add('copper_bar', 1);
    const practiceDagger = buildItem({
      code: 'practice_dagger',
      craft: {
        items: [{ code: 'copper_bar', quantity: 1 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const getBankItems = vi.fn(() =>
      okAsync(buildBankItemsPage([{ code: 'practice_dagger', quantity: 10 }])),
    );
    const getItem = vi.fn(() =>
      okAsync({ data: practiceDagger } satisfies ItemResponse),
    );
    const getMaps = vi.fn(() => okAsync(buildMapPage([buildMap(7)])));
    const moveTo = vi.fn(() => okAsync(undefined));
    const craft = vi.fn(() =>
      okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        details: { items: [], xp: 5 },
      }),
    );

    const result = await craftItem(
      {
        getBankItems,
        getItem,
        getMaps,
        getMonsters: vi.fn(),
        getResources: vi.fn(),
      },
      {
        craft,
        depositItems: vi.fn(),
        equip: vi.fn(),
        fight: vi.fn(),
        gather: vi.fn(),
        getCharacter: state.getCharacter,
        moveTo,
        rest: vi.fn(),
        unequip: vi.fn(),
        withdrawItems: vi.fn(),
      },
      'practice_dagger',
      1,
    );

    expect(result.isOk()).toBe(true);
    expect(getBankItems).not.toHaveBeenCalled();
    expect(craft).toHaveBeenCalledWith('practice_dagger', 1);
  });
});

describe('craftAndEquip', () => {
  it('gathers the raw material, crafts the intermediate, crafts the final item, then equips it', async () => {
    const state = createFakeCharacterState();

    const getItem = vi.fn((code: string) => {
      if (code === 'copper_pickaxe') {
        return okAsync({
          data: buildItem({
            code: 'copper_pickaxe',
            craft: {
              items: [{ code: 'copper_bar', quantity: 6 }],
              level: 1,
              quantity: 1,
              skill: 'weaponcrafting',
            },
            type: 'weapon',
          }),
        } satisfies ItemResponse);
      }
      if (code === 'copper_bar') {
        return okAsync({
          data: buildItem({
            code: 'copper_bar',
            craft: {
              items: [{ code: 'copper_ore', quantity: 10 }],
              level: 1,
              quantity: 1,
              skill: 'mining',
            },
            type: 'resource',
          }),
        } satisfies ItemResponse);
      }
      // copper_ore: no craft recipe, a raw resource drop.
      return okAsync({
        data: buildItem({ code: 'copper_ore', type: 'resource' }),
      } satisfies ItemResponse);
    });

    const getMaps = vi.fn((query?: { content_type?: string }) =>
      okAsync(
        buildMapPage([
          buildMap(
            query?.content_type === 'workshop'
              ? 328
              : query?.content_type === 'resource'
                ? 277
                : 0,
          ),
        ]),
      ),
    );
    const getResources = vi.fn(() =>
      okAsync(buildResourcePage([buildResource('copper_rocks')])),
    );

    const moveTo = vi.fn(() => okAsync(undefined));
    const gather = vi.fn(() => {
      state.add('copper_ore', 1);
      return okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        details: { items: [], xp: 5 },
      });
    });
    const craft = vi.fn((code: string, quantity: number = 1) => {
      if (code === 'copper_bar') {
        state.remove('copper_ore', quantity * 10);
        state.add('copper_bar', quantity);
      } else if (code === 'copper_pickaxe') {
        state.remove('copper_bar', quantity * 6);
        state.add('copper_pickaxe', quantity);
      }
      return okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        details: { items: [], xp: 5 },
      });
    });
    const equip = vi.fn(() =>
      okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        items: [],
      }),
    );

    const result = await craftAndEquip(
      {
        getBankItems: buildEmptyGetBankItems(),
        getItem,
        getMaps,
        getMonsters: vi.fn(),
        getResources,
      },
      {
        craft,
        depositItems: vi.fn(),
        equip,
        fight: vi.fn(),
        gather,
        getCharacter: state.getCharacter,
        moveTo,
        rest: vi.fn(),
        unequip: vi.fn(),
        withdrawItems: vi.fn(),
      },
      'copper_pickaxe',
    );

    expect(result.isOk()).toBe(true);
    expect(gather).toHaveBeenCalledTimes(60); // 6 bars x 10 ore each
    expect(craft).toHaveBeenCalledWith('copper_bar', 6);
    expect(craft).toHaveBeenCalledWith('copper_pickaxe', 1);
    expect(equip).toHaveBeenCalledWith([
      { code: 'copper_pickaxe', quantity: 1, slot: 'weapon' },
    ]);
  });

  it('skips crafting and equipping when the target slot is already filled', async () => {
    const getItem = vi.fn(() =>
      okAsync({ data: buildItem({ code: 'copper_ring', type: 'ring' }) }),
    );
    const equip = vi.fn();
    const craft = vi.fn();
    const gather = vi.fn();

    const result = await craftAndEquip(
      {
        getBankItems: buildEmptyGetBankItems(),
        getItem,
        getMaps: vi.fn(),
        getMonsters: vi.fn(),
        getResources: vi.fn(),
      },
      {
        craft,
        depositItems: vi.fn(),
        equip,
        fight: vi.fn(),
        gather,
        getCharacter: () =>
          ({ ring1_slot: 'copper_ring' }) as CharacterSnapshot,
        moveTo: vi.fn(),
        rest: vi.fn(),
        unequip: vi.fn(),
        withdrawItems: vi.fn(),
      },
      'copper_ring',
    );

    expect(result.isOk()).toBe(true);
    expect(craft).not.toHaveBeenCalled();
    expect(gather).not.toHaveBeenCalled();
    expect(equip).not.toHaveBeenCalled();
  });

  it('withdraws a material from the bank instead of gathering it, when available', async () => {
    const state = createFakeCharacterState();
    const bank = new Map<string, number>([['copper_bar', 6]]);

    const getItem = vi.fn((code: string) =>
      code === 'copper_pickaxe'
        ? okAsync({
            data: buildItem({
              code: 'copper_pickaxe',
              craft: {
                items: [{ code: 'copper_bar', quantity: 6 }],
                level: 1,
                quantity: 1,
                skill: 'weaponcrafting',
              },
              type: 'weapon',
            }),
          } satisfies ItemResponse)
        : okAsync({ data: buildItem({ code }) } satisfies ItemResponse),
    );
    const getBankItems = vi.fn((query?: { item_code?: string }) =>
      okAsync(
        buildBankItemsPage(
          query?.item_code !== undefined && bank.has(query.item_code)
            ? [{ code: query.item_code, quantity: bank.get(query.item_code)! }]
            : [],
        ),
      ),
    );
    const getMaps = vi.fn(() => okAsync(buildMapPage([buildMap(328)])));
    const moveTo = vi.fn(() => okAsync(undefined));
    const withdrawItems = vi.fn(
      (items: { code: string; quantity: number }[]) => {
        for (const item of items) {
          bank.set(item.code, (bank.get(item.code) ?? 0) - item.quantity);
          state.add(item.code, item.quantity);
        }
        return okAsync({
          bank: [],
          character: state.getCharacter(),
          cooldown: buildCooldown(),
          items: [],
        });
      },
    );
    const gather = vi.fn();
    const craft = vi.fn((code: string, quantity: number = 1) => {
      state.remove('copper_bar', quantity * 6);
      state.add(code, quantity);
      return okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        details: { items: [], xp: 5 },
      });
    });
    const equip = vi.fn(() =>
      okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        items: [],
      }),
    );

    const result = await craftAndEquip(
      {
        getBankItems,
        getItem,
        getMaps,
        getMonsters: vi.fn(),
        getResources: vi.fn(),
      },
      {
        craft,
        depositItems: vi.fn(),
        equip,
        fight: vi.fn(),
        gather,
        getCharacter: state.getCharacter,
        moveTo,
        rest: vi.fn(),
        unequip: vi.fn(),
        withdrawItems,
      },
      'copper_pickaxe',
    );

    expect(result.isOk()).toBe(true);
    expect(gather).not.toHaveBeenCalled();
    expect(withdrawItems).toHaveBeenCalledWith([
      { code: 'copper_bar', quantity: 6 },
    ]);
    expect(craft).toHaveBeenCalledWith('copper_pickaxe', 1);
    expect(equip).toHaveBeenCalledWith([
      { code: 'copper_pickaxe', quantity: 1, slot: 'weapon' },
    ]);
  });

  it("deposits everything else at the bank first when there isn't room for a withdrawal", async () => {
    const state = createFakeCharacterState(5);
    state.add('junk_item', 4);
    const bank = new Map<string, number>([['copper_bar', 6]]);

    const getItem = vi.fn((code: string) =>
      code === 'copper_pickaxe'
        ? okAsync({
            data: buildItem({
              code: 'copper_pickaxe',
              craft: {
                items: [{ code: 'copper_bar', quantity: 6 }],
                level: 1,
                quantity: 1,
                skill: 'weaponcrafting',
              },
              type: 'weapon',
            }),
          } satisfies ItemResponse)
        : okAsync({ data: buildItem({ code }) } satisfies ItemResponse),
    );
    const getBankItems = vi.fn((query?: { item_code?: string }) =>
      okAsync(
        buildBankItemsPage(
          query?.item_code !== undefined && bank.has(query.item_code)
            ? [{ code: query.item_code, quantity: bank.get(query.item_code)! }]
            : [],
        ),
      ),
    );
    const getMaps = vi.fn(() => okAsync(buildMapPage([buildMap(328)])));
    const moveTo = vi.fn(() => okAsync(undefined));
    const depositItems = vi.fn(
      (items: { code: string; quantity: number }[]) => {
        for (const item of items) {
          state.remove(item.code, item.quantity);
        }
        return okAsync({
          bank: [],
          character: state.getCharacter(),
          cooldown: buildCooldown(),
          items: [],
        });
      },
    );
    const withdrawItems = vi.fn(
      (items: { code: string; quantity: number }[]) => {
        for (const item of items) {
          bank.set(item.code, (bank.get(item.code) ?? 0) - item.quantity);
          state.add(item.code, item.quantity);
        }
        return okAsync({
          bank: [],
          character: state.getCharacter(),
          cooldown: buildCooldown(),
          items: [],
        });
      },
    );
    const craft = vi.fn((code: string, quantity: number = 1) => {
      state.remove('copper_bar', quantity * 6);
      state.add(code, quantity);
      return okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        details: { items: [], xp: 5 },
      });
    });
    const equip = vi.fn(() =>
      okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        items: [],
      }),
    );

    const result = await craftAndEquip(
      {
        getBankItems,
        getItem,
        getMaps,
        getMonsters: vi.fn(),
        getResources: vi.fn(),
      },
      {
        craft,
        depositItems,
        equip,
        fight: vi.fn(),
        gather: vi.fn(),
        getCharacter: state.getCharacter,
        moveTo,
        rest: vi.fn(),
        unequip: vi.fn(),
        withdrawItems,
      },
      'copper_pickaxe',
    );

    expect(result.isOk()).toBe(true);
    expect(depositItems).toHaveBeenCalledWith([
      { code: 'junk_item', quantity: 4 },
    ]);
    expect(withdrawItems).toHaveBeenCalledWith([
      { code: 'copper_bar', quantity: 6 },
    ]);
    expect(craft).toHaveBeenCalledWith('copper_pickaxe', 1);
  });

  it('unequips a different item already in the slot before equipping the target one', async () => {
    const state = createFakeCharacterState();
    state.add('copper_ring', 1);

    const getItem = vi.fn(() =>
      okAsync({ data: buildItem({ code: 'copper_ring', type: 'ring' }) }),
    );
    const equip = vi.fn(() =>
      okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        items: [],
      }),
    );
    const unequip = vi.fn(() =>
      okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        items: [],
      }),
    );

    const result = await craftAndEquip(
      {
        getBankItems: buildEmptyGetBankItems(),
        getItem,
        getMaps: vi.fn(),
        getMonsters: vi.fn(),
        getResources: vi.fn(),
      },
      {
        craft: vi.fn(),
        depositItems: vi.fn(),
        equip,
        fight: vi.fn(),
        gather: vi.fn(),
        getCharacter: () =>
          ({
            ...state.getCharacter(),
            ring1_slot: 'wooden_stick',
          }) as CharacterSnapshot,
        moveTo: vi.fn(),
        rest: vi.fn(),
        unequip,
        withdrawItems: vi.fn(),
      },
      'copper_ring',
    );

    expect(result.isOk()).toBe(true);
    expect(unequip).toHaveBeenCalledWith([{ quantity: 1, slot: 'ring1' }]);
    expect(equip).toHaveBeenCalledWith([
      { code: 'copper_ring', quantity: 1, slot: 'ring1' },
    ]);
  });

  it('unequips a starter item to use it as a crafting material (wooden_staff needs wooden_stick)', async () => {
    const held = new Map<string, number>();
    let weaponSlot = 'wooden_stick';

    const getCharacter = (): CharacterSnapshot =>
      ({
        ...({} as CharacterSnapshot),
        hp: 100,
        inventory: [...held.entries()].map(([code, quantity], index) => ({
          code,
          quantity,
          slot: index,
        })),
        inventory_max_items: Number.MAX_SAFE_INTEGER,
        max_hp: 100,
        name: 'Cartman',
        weapon_slot: weaponSlot,
      }) as CharacterSnapshot;

    const getItem = vi.fn((code: string) =>
      code === 'wooden_staff'
        ? okAsync({
            data: buildItem({
              code: 'wooden_staff',
              craft: {
                items: [
                  { code: 'wooden_stick', quantity: 1 },
                  { code: 'ash_wood', quantity: 4 },
                ],
                level: 1,
                quantity: 1,
                skill: 'weaponcrafting',
              },
              type: 'weapon',
            }),
          } satisfies ItemResponse)
        : okAsync({ data: buildItem({ code }) } satisfies ItemResponse),
    );
    const getMaps = vi.fn((query?: { content_type?: string }) =>
      okAsync(
        buildMapPage([
          buildMap(
            query?.content_type === 'workshop'
              ? 328
              : query?.content_type === 'resource'
                ? 277
                : 0,
          ),
        ]),
      ),
    );
    const getResources = vi.fn(() =>
      okAsync(buildResourcePage([buildResource('ash_tree')])),
    );
    const moveTo = vi.fn(() => okAsync(undefined));
    const unequip = vi.fn((items: { quantity: number; slot: string }[]) => {
      for (const item of items) {
        held.set(weaponSlot, (held.get(weaponSlot) ?? 0) + item.quantity);
      }
      weaponSlot = '';
      return okAsync({
        character: getCharacter(),
        cooldown: buildCooldown(),
        items: [],
      });
    });
    const gather = vi.fn(() => {
      held.set('ash_wood', (held.get('ash_wood') ?? 0) + 1);
      return okAsync({
        character: getCharacter(),
        cooldown: buildCooldown(),
        details: { items: [], xp: 5 },
      });
    });
    const craft = vi.fn((code: string, quantity: number = 1) => {
      held.set('wooden_stick', (held.get('wooden_stick') ?? 0) - quantity);
      held.set('ash_wood', (held.get('ash_wood') ?? 0) - quantity * 4);
      held.set(code, (held.get(code) ?? 0) + quantity);
      return okAsync({
        character: getCharacter(),
        cooldown: buildCooldown(),
        details: { items: [], xp: 5 },
      });
    });
    const equip = vi.fn(() =>
      okAsync({
        character: getCharacter(),
        cooldown: buildCooldown(),
        items: [],
      }),
    );

    const result = await craftAndEquip(
      {
        getBankItems: buildEmptyGetBankItems(),
        getItem,
        getMaps,
        getMonsters: vi.fn(),
        getResources,
      },
      {
        craft,
        depositItems: vi.fn(),
        equip,
        fight: vi.fn(),
        gather,
        getCharacter,
        moveTo,
        rest: vi.fn(),
        unequip,
        withdrawItems: vi.fn(),
      },
      'wooden_staff',
    );

    expect(result.isOk()).toBe(true);
    expect(unequip).toHaveBeenCalledTimes(1);
    expect(unequip).toHaveBeenCalledWith([{ quantity: 1, slot: 'weapon' }]);
    expect(gather).toHaveBeenCalledTimes(4); // 4x ash_wood
    expect(craft).toHaveBeenCalledWith('wooden_staff', 1);
    expect(equip).toHaveBeenCalledWith([
      { code: 'wooden_staff', quantity: 1, slot: 'weapon' },
    ]);
  });

  it('deposits everything except the target item at the bank when the inventory fills up mid-gather, then resumes', async () => {
    const state = createFakeCharacterState(4);
    state.add('junk_item', 3);

    const getItem = vi.fn((code: string) =>
      code === 'test_axe'
        ? okAsync({
            data: buildItem({
              code: 'test_axe',
              craft: {
                items: [{ code: 'test_ore', quantity: 3 }],
                level: 1,
                quantity: 1,
                skill: 'weaponcrafting',
              },
              type: 'weapon',
            }),
          } satisfies ItemResponse)
        : okAsync({ data: buildItem({ code }) } satisfies ItemResponse),
    );
    const getMaps = vi.fn((query?: { content_type?: string }) =>
      okAsync(
        buildMapPage([
          buildMap(
            query?.content_type === 'workshop'
              ? 328
              : query?.content_type === 'resource'
                ? 277
                : 0,
          ),
        ]),
      ),
    );
    const getResources = vi.fn(() =>
      okAsync(buildResourcePage([buildResource('test_ore_rocks')])),
    );

    const moveTo = vi.fn(() => okAsync(undefined));
    const gather = vi.fn(() => {
      state.add('test_ore', 1);
      return okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        details: { items: [], xp: 5 },
      });
    });
    const depositItems = vi.fn(
      (items: { code: string; quantity: number }[]) => {
        for (const item of items) {
          state.remove(item.code, item.quantity);
        }
        return okAsync({
          bank: [],
          character: state.getCharacter(),
          cooldown: buildCooldown(),
          items: [],
        });
      },
    );
    const craft = vi.fn((code: string, quantity: number = 1) => {
      state.remove('test_ore', quantity * 3);
      state.add(code, quantity);
      return okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        details: { items: [], xp: 5 },
      });
    });
    const equip = vi.fn(() =>
      okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        items: [],
      }),
    );

    const result = await craftAndEquip(
      {
        getBankItems: buildEmptyGetBankItems(),
        getItem,
        getMaps,
        getMonsters: vi.fn(),
        getResources,
      },
      {
        craft,
        depositItems,
        equip,
        fight: vi.fn(),
        gather,
        getCharacter: state.getCharacter,
        moveTo,
        rest: vi.fn(),
        unequip: vi.fn(),
        withdrawItems: vi.fn(),
      },
      'test_axe',
    );

    expect(result.isOk()).toBe(true);
    expect(depositItems).toHaveBeenCalledTimes(1);
    expect(depositItems).toHaveBeenCalledWith([
      { code: 'junk_item', quantity: 3 },
    ]);
    expect(gather).toHaveBeenCalledTimes(3);
    expect(craft).toHaveBeenCalledWith('test_axe', 1);
  });

  it('skips gathering/crafting materials already held in sufficient quantity', async () => {
    const state = createFakeCharacterState();
    state.add('copper_bar', 6);

    const getItem = vi.fn((code: string) =>
      code === 'copper_pickaxe'
        ? okAsync({
            data: buildItem({
              code: 'copper_pickaxe',
              craft: {
                items: [{ code: 'copper_bar', quantity: 6 }],
                level: 1,
                quantity: 1,
                skill: 'weaponcrafting',
              },
              type: 'weapon',
            }),
          } satisfies ItemResponse)
        : okAsync({ data: buildItem({ code }) } satisfies ItemResponse),
    );
    const getMaps = vi.fn(() => okAsync(buildMapPage([buildMap(328)])));
    const getResources = vi.fn();
    const moveTo = vi.fn(() => okAsync(undefined));
    const gather = vi.fn();
    const craft = vi.fn((code: string, quantity: number = 1) => {
      state.remove('copper_bar', quantity * 6);
      state.add(code, quantity);
      return okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        details: { items: [], xp: 5 },
      });
    });
    const equip = vi.fn(() =>
      okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        items: [],
      }),
    );

    const result = await craftAndEquip(
      {
        getBankItems: buildEmptyGetBankItems(),
        getItem,
        getMaps,
        getMonsters: vi.fn(),
        getResources,
      },
      {
        craft,
        depositItems: vi.fn(),
        equip,
        fight: vi.fn(),
        gather,
        getCharacter: state.getCharacter,
        moveTo,
        rest: vi.fn(),
        unequip: vi.fn(),
        withdrawItems: vi.fn(),
      },
      'copper_pickaxe',
    );

    expect(result.isOk()).toBe(true);
    expect(gather).not.toHaveBeenCalled();
    expect(getResources).not.toHaveBeenCalled();
    expect(craft).toHaveBeenCalledTimes(1);
    expect(craft).toHaveBeenCalledWith('copper_pickaxe', 1);
  });

  it('returns UnsupportedEquipSlotError for an item type without a known slot', async () => {
    const getItem = vi.fn(() =>
      okAsync({
        data: buildItem({ code: 'strange_artifact', type: 'artifact' }),
      }),
    );
    const equip = vi.fn();

    const result = await craftAndEquip(
      {
        getBankItems: buildEmptyGetBankItems(),
        getItem,
        getMaps: vi.fn(),
        getMonsters: vi.fn(),
        getResources: vi.fn(),
      },
      {
        craft: vi.fn(),
        depositItems: vi.fn(),
        equip,
        fight: vi.fn(),
        gather: vi.fn(),
        getCharacter: () => ({}) as CharacterSnapshot,
        moveTo: vi.fn(),
        rest: vi.fn(),
        unequip: vi.fn(),
        withdrawItems: vi.fn(),
      },
      'strange_artifact',
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(UnsupportedEquipSlotError);
    expect(equip).not.toHaveBeenCalled();
  });

  it("falls back to hunting a monster when a raw material isn't a gatherable resource", async () => {
    const state = createFakeCharacterState();

    const getItem = vi.fn((code: string) =>
      code === 'apprentice_gloves'
        ? okAsync({
            data: buildItem({
              code: 'apprentice_gloves',
              craft: {
                items: [{ code: 'feather', quantity: 3 }],
                level: 1,
                quantity: 1,
                skill: 'weaponcrafting',
              },
              type: 'weapon',
            }),
          } satisfies ItemResponse)
        : okAsync({ data: buildItem({ code }) } satisfies ItemResponse),
    );
    const getMaps = vi.fn((query?: { content_type?: string }) =>
      okAsync(
        buildMapPage([
          buildMap(
            query?.content_type === 'workshop'
              ? 328
              : query?.content_type === 'monster'
                ? 411
                : 0,
          ),
        ]),
      ),
    );
    const getResources = vi.fn(() => okAsync(buildResourcePage([]))); // nothing gathers "feather"
    const getMonsters = vi.fn(() =>
      okAsync(buildMonsterPage([buildMonster('chicken')])),
    );

    const moveTo = vi.fn(() => okAsync(undefined));
    const fight = vi.fn(() => {
      state.add('feather', 1);
      return okAsync({
        character: state.getCharacter(),
        characters: [],
        cooldown: buildCooldown(),
        fight: {
          characters: [],
          logs: [],
          opponent: 'chicken',
          result: 'win' as const,
          turns: 3,
        },
      });
    });
    const equip = vi.fn(() =>
      okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        items: [],
      }),
    );
    const craft = vi.fn((code: string, quantity: number = 1) => {
      state.remove('feather', quantity * 3);
      state.add(code, quantity);
      return okAsync({
        character: state.getCharacter(),
        cooldown: buildCooldown(),
        details: { items: [], xp: 5 },
      });
    });

    const result = await craftAndEquip(
      {
        getBankItems: buildEmptyGetBankItems(),
        getItem,
        getMaps,
        getMonsters,
        getResources,
      },
      {
        craft,
        depositItems: vi.fn(),
        equip,
        fight,
        gather: vi.fn(),
        getCharacter: state.getCharacter,
        moveTo,
        rest: vi.fn(),
        unequip: vi.fn(),
        withdrawItems: vi.fn(),
      },
      'apprentice_gloves',
    );

    expect(result.isOk()).toBe(true);
    expect(getResources).toHaveBeenCalled();
    expect(fight).toHaveBeenCalledTimes(3);
    expect(craft).toHaveBeenCalledWith('apprentice_gloves', 1);
    expect(equip).toHaveBeenCalledWith([
      { code: 'apprentice_gloves', quantity: 1, slot: 'weapon' },
    ]);
  });

  it("refuses to hunt a monster that isn't safe with the character's current gear, instead of fighting it anyway", async () => {
    const state = createFakeCharacterState();

    const getItem = vi.fn((code: string) =>
      code === 'apprentice_gloves'
        ? okAsync({
            data: buildItem({
              code: 'apprentice_gloves',
              craft: {
                items: [{ code: 'feather', quantity: 3 }],
                level: 1,
                quantity: 1,
                skill: 'weaponcrafting',
              },
              type: 'weapon',
            }),
          } satisfies ItemResponse)
        : okAsync({ data: buildItem({ code }) } satisfies ItemResponse),
    );
    const getMaps = vi.fn(() => okAsync(buildMapPage([buildMap(0)])));
    const getResources = vi.fn(() => okAsync(buildResourcePage([]))); // nothing gathers "feather"
    // Deals far more damage than the character (attack_earth: 10) can
    // survive, and has enough hp that the character could never kill it
    // fast enough either - isSafeToFight should refuse this matchup.
    const dangerousMonster = buildMonster('dangerous_chicken', {
      attack_earth: 500,
      hp: 5_000,
    });
    const getMonsters = vi.fn(() =>
      okAsync(buildMonsterPage([dangerousMonster])),
    );

    const moveTo = vi.fn(() => okAsync(undefined));
    const fight = vi.fn();

    const result = await craftAndEquip(
      {
        getBankItems: buildEmptyGetBankItems(),
        getItem,
        getMaps,
        getMonsters,
        getResources,
      },
      {
        craft: vi.fn(),
        depositItems: vi.fn(),
        equip: vi.fn(),
        fight,
        gather: vi.fn(),
        getCharacter: state.getCharacter,
        moveTo,
        rest: vi.fn(),
        unequip: vi.fn(),
        withdrawItems: vi.fn(),
      },
      'apprentice_gloves',
    );

    expect(result.isErr() && result.error).toBeInstanceOf(UnsafeMonsterError);
    expect(moveTo).not.toHaveBeenCalled();
    expect(fight).not.toHaveBeenCalled();
  });

  it("refuses to craft an item the character's profession level isn't high enough for yet", async () => {
    const character = {
      ...({} as CharacterSnapshot),
      inventory: [],
      inventory_max_items: 100,
      name: 'Cartman',
      weaponcrafting_level: 1,
    } as CharacterSnapshot;

    const getItem = vi.fn((code: string) =>
      code === 'apprentice_gloves'
        ? okAsync({
            data: buildItem({
              code: 'apprentice_gloves',
              craft: {
                items: [{ code: 'feather', quantity: 3 }],
                level: 5,
                quantity: 1,
                skill: 'weaponcrafting',
              },
              type: 'weapon',
            }),
          } satisfies ItemResponse)
        : okAsync({ data: buildItem({ code }) } satisfies ItemResponse),
    );
    const getResources = vi.fn();
    const getMonsters = vi.fn();
    const gather = vi.fn();
    const craft = vi.fn();

    const result = await craftAndEquip(
      {
        getBankItems: buildEmptyGetBankItems(),
        getItem,
        getMaps: vi.fn(),
        getMonsters,
        getResources,
      },
      {
        craft,
        depositItems: vi.fn(),
        equip: vi.fn(),
        fight: vi.fn(),
        gather,
        getCharacter: () => character,
        moveTo: vi.fn(),
        rest: vi.fn(),
        unequip: vi.fn(),
        withdrawItems: vi.fn(),
      },
      'apprentice_gloves',
    );

    expect(result.isErr() && result.error).toBeInstanceOf(
      InsufficientCraftingLevelError,
    );
    expect(getResources).not.toHaveBeenCalled();
    expect(getMonsters).not.toHaveBeenCalled();
    expect(gather).not.toHaveBeenCalled();
    expect(craft).not.toHaveBeenCalled();
  });

  it("propagates a MonsterNotFoundError when a raw material can't be gathered or hunted", async () => {
    const state = createFakeCharacterState();

    const getItem = vi.fn((code: string) =>
      code === 'apprentice_gloves'
        ? okAsync({
            data: buildItem({
              code: 'apprentice_gloves',
              craft: {
                items: [{ code: 'feather', quantity: 6 }],
                level: 1,
                quantity: 1,
                skill: 'weaponcrafting',
              },
              type: 'weapon',
            }),
          } satisfies ItemResponse)
        : okAsync({ data: buildItem({ code }) } satisfies ItemResponse),
    );
    const getMaps = vi.fn(() => okAsync(buildMapPage([buildMap(328)])));
    const getResources = vi.fn(() => okAsync(buildResourcePage([]))); // nothing gathers "feather"
    const getMonsters = vi.fn(() => okAsync(buildMonsterPage([]))); // nothing drops "feather" either

    const result = await craftAndEquip(
      {
        getBankItems: buildEmptyGetBankItems(),
        getItem,
        getMaps,
        getMonsters,
        getResources,
      },
      {
        craft: vi.fn(),
        depositItems: vi.fn(),
        equip: vi.fn(),
        fight: vi.fn(),
        gather: vi.fn(),
        getCharacter: state.getCharacter,
        moveTo: vi.fn(() => okAsync(undefined)),
        rest: vi.fn(),
        unequip: vi.fn(),
        withdrawItems: vi.fn(),
      },
      'apprentice_gloves',
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(MonsterNotFoundError);
  });

  it('propagates an ArtifactsApiError from a failed craft call', async () => {
    const state = createFakeCharacterState();
    state.add('copper_bar', 6);
    const apiError = new ArtifactsApiError(
      'not enough materials',
      478,
      undefined,
    );

    const getItem = vi.fn(() =>
      okAsync({
        data: buildItem({
          code: 'copper_pickaxe',
          craft: {
            items: [{ code: 'copper_bar', quantity: 6 }],
            level: 1,
            quantity: 1,
            skill: 'weaponcrafting',
          },
          type: 'weapon',
        }),
      } satisfies ItemResponse),
    );
    const getMaps = vi.fn(() => okAsync(buildMapPage([buildMap(328)])));

    const result = await craftAndEquip(
      {
        getBankItems: buildEmptyGetBankItems(),
        getItem,
        getMaps,
        getMonsters: vi.fn(),
        getResources: vi.fn(),
      },
      {
        craft: vi.fn(() => errAsync(apiError)),
        depositItems: vi.fn(),
        equip: vi.fn(),
        fight: vi.fn(),
        gather: vi.fn(),
        getCharacter: state.getCharacter,
        moveTo: vi.fn(() => okAsync(undefined)),
        rest: vi.fn(),
        unequip: vi.fn(),
        withdrawItems: vi.fn(),
      },
      'copper_pickaxe',
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(apiError);
  });
});
