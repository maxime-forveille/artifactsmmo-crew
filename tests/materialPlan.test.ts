import { errAsync, okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  findCraftableFromBankSurplus,
  materialsNeededFor,
  planProfessionProgress,
} from '../src/bot/materialPlan.js';
import { ArtifactsApiError } from '../src/client/index.js';
import type { components } from '../src/client/schema.js';

type Character = components['schemas']['CharacterSchema'];
type Item = components['schemas']['ItemSchema'];
type ItemResponse = components['schemas']['ItemResponseSchema'];
type Monster = components['schemas']['MonsterSchema'];
type MonsterPage = components['schemas']['StaticDataPage_MonsterSchema_'];
type Resource = components['schemas']['ResourceSchema'];
type ResourcePage = components['schemas']['StaticDataPage_ResourceSchema_'];
type InventorySlot = components['schemas']['InventorySlotSchema'];
type SimpleItem = components['schemas']['SimpleItemSchema'];
type BankItemsPage = components['schemas']['DataPage_SimpleItemSchema_'];

const buildCharacter = (
  inventory: InventorySlot[] = [],
  overrides: Partial<Character> = {},
): Character =>
  ({
    ...({} as Character),
    inventory,
    name: 'Cartman',
    ...overrides,
  }) as Character;

const buildItem = (overrides: Partial<Item>): Item => ({
  ...({} as Item),
  ...overrides,
});
const buildItemResponse = (item: Item): ItemResponse => ({ data: item });

const buildResource = (
  code: string,
  overrides: Partial<Resource> = {},
): Resource => ({ ...({} as Resource), code, ...overrides });
const buildResourcePage = (data: Resource[]): ResourcePage => ({
  data,
  page: 1,
  pages: 1,
  size: 50,
  total: data.length,
});

const buildMonster = (
  code: string,
  overrides: Partial<Monster> = {},
): Monster => ({ ...({} as Monster), code, ...overrides });
const buildMonsterPage = (data: Monster[]): MonsterPage => ({
  data,
  page: 1,
  pages: 1,
  size: 50,
  total: data.length,
});

const buildBankItemsPage = (data: SimpleItem[]): BankItemsPage => ({
  data,
  page: 1,
  pages: 1,
  size: 50,
  total: data.length,
});
const emptyBank = () => vi.fn(() => okAsync(buildBankItemsPage([])));
const noResources = () => vi.fn(() => okAsync(buildResourcePage([])));
const noMonsters = () => vi.fn(() => okAsync(buildMonsterPage([])));

type ItemPage = {
  data: Item[];
  page: number;
  pages: number;
  size: number;
  total: number;
};
const buildItemPage = (data: Item[]): ItemPage => ({
  data,
  page: 1,
  pages: 1,
  size: 100,
  total: data.length,
});

describe('materialsNeededFor', () => {
  it('returns nothing already held in enough quantity, without calling the API', async () => {
    const character = buildCharacter([
      { code: 'ash_wood', quantity: 5, slot: 0 },
    ]);
    const getItem = vi.fn();

    const result = await materialsNeededFor(
      {
        getBankItems: emptyBank(),
        getItem,
        getMonsters: noMonsters(),
        getResources: noResources(),
      },
      character,
      'ash_wood',
      3,
    );

    expect(result.isOk() && result.value).toEqual([]);
    expect(getItem).not.toHaveBeenCalled();
  });

  it("counts the bank towards what's needed, returning nothing missing when it covers the gap", async () => {
    const character = buildCharacter([
      { code: 'ash_wood', quantity: 1, slot: 0 },
    ]);
    const getItem = vi.fn(() =>
      okAsync(buildItemResponse(buildItem({ code: 'ash_wood' }))),
    );
    const getBankItems = vi.fn(() =>
      okAsync(buildBankItemsPage([{ code: 'ash_wood', quantity: 4 }])),
    );

    const result = await materialsNeededFor(
      {
        getBankItems,
        getItem,
        getMonsters: noMonsters(),
        getResources: noResources(),
      },
      character,
      'ash_wood',
      5,
    );

    expect(result.isOk() && result.value).toEqual([]);
  });

  it('reports a missing raw material as gatherable, when a resource drops it', async () => {
    const character = buildCharacter();
    const getItem = vi.fn(() =>
      okAsync(buildItemResponse(buildItem({ code: 'ash_wood' }))),
    );
    const getResources = vi.fn(() =>
      okAsync(buildResourcePage([buildResource('ash_tree')])),
    );

    const result = await materialsNeededFor(
      {
        getBankItems: emptyBank(),
        getItem,
        getMonsters: noMonsters(),
        getResources,
      },
      character,
      'ash_wood',
      3,
    );

    expect(result.isOk() && result.value).toEqual([
      {
        itemCode: 'ash_wood',
        missingQuantity: 3,
        source: { resourceCode: 'ash_tree', type: 'gather' },
      },
    ]);
  });

  it('falls back to a monster drop when no resource produces the raw material', async () => {
    const character = buildCharacter();
    const getItem = vi.fn(() =>
      okAsync(buildItemResponse(buildItem({ code: 'feather' }))),
    );
    const getMonsters = vi.fn(() =>
      okAsync(buildMonsterPage([buildMonster('chicken')])),
    );

    const result = await materialsNeededFor(
      {
        getBankItems: emptyBank(),
        getItem,
        getMonsters,
        getResources: noResources(),
      },
      character,
      'feather',
      2,
    );

    expect(result.isOk() && result.value).toEqual([
      {
        itemCode: 'feather',
        missingQuantity: 2,
        source: { monsterCode: 'chicken', type: 'hunt' },
      },
    ]);
  });

  it('classifies as unknown when neither a resource nor a monster produces the raw material', async () => {
    const character = buildCharacter();
    const getItem = vi.fn(() =>
      okAsync(buildItemResponse(buildItem({ code: 'mystery_shard' }))),
    );

    const result = await materialsNeededFor(
      {
        getBankItems: emptyBank(),
        getItem,
        getMonsters: noMonsters(),
        getResources: noResources(),
      },
      character,
      'mystery_shard',
      1,
    );

    expect(result.isOk() && result.value).toEqual([
      {
        itemCode: 'mystery_shard',
        missingQuantity: 1,
        source: { type: 'unknown' },
      },
    ]);
  });

  it('recurses into craft materials instead of reporting the craftable item itself', async () => {
    const character = buildCharacter();
    const getItem = vi.fn((code: string) => {
      if (code === 'wooden_staff') {
        return okAsync(
          buildItemResponse(
            buildItem({
              code: 'wooden_staff',
              craft: {
                items: [
                  { code: 'ash_wood', quantity: 2 },
                  { code: 'feather', quantity: 1 },
                ],
                level: 1,
                quantity: 1,
                skill: 'weaponcrafting',
              },
              type: 'weapon',
            }),
          ),
        );
      }

      if (code === 'ash_wood') {
        return okAsync(buildItemResponse(buildItem({ code: 'ash_wood' })));
      }

      return okAsync(buildItemResponse(buildItem({ code: 'feather' })));
    });
    const getResources = vi.fn((query?: { drop?: string }) =>
      okAsync(
        buildResourcePage(
          query?.drop === 'ash_wood' ? [buildResource('ash_tree')] : [],
        ),
      ),
    );
    const getMonsters = vi.fn((query?: { drop?: string }) =>
      okAsync(
        buildMonsterPage(
          query?.drop === 'feather' ? [buildMonster('chicken')] : [],
        ),
      ),
    );

    const result = await materialsNeededFor(
      { getBankItems: emptyBank(), getItem, getMonsters, getResources },
      character,
      'wooden_staff',
      2,
    );

    expect(result.isOk() && result.value).toEqual([
      {
        itemCode: 'ash_wood',
        missingQuantity: 4,
        source: { resourceCode: 'ash_tree', type: 'gather' },
      },
      {
        itemCode: 'feather',
        missingQuantity: 2,
        source: { monsterCode: 'chicken', type: 'hunt' },
      },
    ]);
  });

  it("accounts for a recipe's output quantity when calculating required materials", async () => {
    const getItem = vi.fn((code: string) =>
      okAsync(
        buildItemResponse(
          code === 'wooden_staff'
            ? buildItem({
                code,
                craft: {
                  items: [{ code: 'ash_wood', quantity: 2 }],
                  level: 1,
                  quantity: 2,
                  skill: 'weaponcrafting',
                },
              })
            : buildItem({ code }),
        ),
      ),
    );
    const getResources = vi.fn(() =>
      okAsync(buildResourcePage([buildResource('ash_tree')])),
    );

    const result = await materialsNeededFor(
      {
        getBankItems: emptyBank(),
        getItem,
        getMonsters: noMonsters(),
        getResources,
      },
      buildCharacter(),
      'wooden_staff',
      3,
    );

    expect(result.isOk() && result.value).toEqual([
      {
        itemCode: 'ash_wood',
        missingQuantity: 4,
        source: { resourceCode: 'ash_tree', type: 'gather' },
      },
    ]);
  });

  it('propagates a genuine API error instead of downgrading it to unknown', async () => {
    const character = buildCharacter();
    const apiError = new ArtifactsApiError('boom', 500, {});
    const getItem = vi.fn(() =>
      okAsync(buildItemResponse(buildItem({ code: 'ash_wood' }))),
    );
    const getResources = vi.fn(() => errAsync(apiError));
    const getMonsters = noMonsters();

    const result = await materialsNeededFor(
      { getBankItems: emptyBank(), getItem, getMonsters, getResources },
      character,
      'ash_wood',
      1,
    );

    expect(result.isErr() && result.error).toBe(apiError);
    expect(getMonsters).not.toHaveBeenCalled();
  });
});

describe('planProfessionProgress', () => {
  it('selects a recipe for the exact blocked profession', async () => {
    const character = buildCharacter([], {
      mining_level: 5,
      weaponcrafting_level: 1,
    });
    const woodenStaff = buildItem({
      code: 'wooden_staff',
      craft: {
        items: [{ code: 'ash_wood', quantity: 2 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const unrelatedBar = buildItem({
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_ore', quantity: 2 }],
        level: 1,
        quantity: 1,
        skill: 'mining',
      },
    });
    const getItems = vi.fn(() =>
      okAsync(buildItemPage([unrelatedBar, woodenStaff])),
    );
    const getItem = vi.fn((code: string) =>
      okAsync(buildItemResponse(buildItem({ code }))),
    );
    const getBankItems = vi.fn((query?: { item_code?: string }) =>
      okAsync(
        buildBankItemsPage(
          query?.item_code === undefined || query.item_code === 'ash_wood'
            ? [{ code: 'ash_wood', quantity: 2 }]
            : [],
        ),
      ),
    );

    const result = await planProfessionProgress(
      {
        getBankItems,
        getItem,
        getItems,
        getMonster: vi.fn(),
        getMonsters: noMonsters(),
        getResource: vi.fn(),
        getResources: noResources(),
      },
      character,
      { skill: 'weaponcrafting', targetLevel: 5 },
    );

    expect(getItems).toHaveBeenCalledWith({
      craft_skill: 'weaponcrafting',
      size: 100,
    });
    expect(result.isOk() && result.value).toEqual({
      craftQuantity: 1,
      itemCode: 'wooden_staff',
      missingMaterials: [],
      recipeLevel: 1,
      skill: 'weaponcrafting',
      targetLevel: 5,
    });
  });

  it('rejects a recipe from a different profession even when its materials are free', async () => {
    const unrelatedBar = buildItem({
      code: 'copper_bar',
      craft: {
        items: [{ code: 'copper_ore', quantity: 2 }],
        level: 1,
        quantity: 1,
        skill: 'mining',
      },
    });

    const result = await planProfessionProgress(
      {
        getBankItems: vi.fn(() =>
          okAsync(buildBankItemsPage([{ code: 'copper_ore', quantity: 2 }])),
        ),
        getItem: vi.fn((code: string) =>
          okAsync(buildItemResponse(buildItem({ code }))),
        ),
        getItems: vi.fn(() => okAsync(buildItemPage([unrelatedBar]))),
        getMonster: vi.fn(),
        getMonsters: noMonsters(),
        getResource: vi.fn(),
        getResources: noResources(),
      },
      buildCharacter([], { mining_level: 5, weaponcrafting_level: 1 }),
      { skill: 'weaponcrafting', targetLevel: 5 },
    );

    expect(result.isOk() && result.value).toBeUndefined();
  });

  it("rejects a recipe above the character's current profession level", async () => {
    const futureStaff = buildItem({
      code: 'future_staff',
      craft: {
        items: [{ code: 'ash_wood', quantity: 2 }],
        level: 2,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });

    const result = await planProfessionProgress(
      {
        getBankItems: vi.fn(() =>
          okAsync(buildBankItemsPage([{ code: 'ash_wood', quantity: 2 }])),
        ),
        getItem: vi.fn((code: string) =>
          okAsync(buildItemResponse(buildItem({ code }))),
        ),
        getItems: vi.fn(() => okAsync(buildItemPage([futureStaff]))),
        getMonster: vi.fn(),
        getMonsters: noMonsters(),
        getResource: vi.fn(),
        getResources: noResources(),
      },
      buildCharacter([], { weaponcrafting_level: 1 }),
      { skill: 'weaponcrafting', targetLevel: 5 },
    );

    expect(result.isOk() && result.value).toBeUndefined();
  });

  it('rejects a recipe without crafting materials', async () => {
    const emptyRecipe = buildItem({
      code: 'empty_recipe',
      craft: { items: [], level: 1, quantity: 1, skill: 'weaponcrafting' },
    });

    const result = await planProfessionProgress(
      {
        getBankItems: emptyBank(),
        getItem: vi.fn(),
        getItems: vi.fn(() => okAsync(buildItemPage([emptyRecipe]))),
        getMonster: vi.fn(),
        getMonsters: noMonsters(),
        getResource: vi.fn(),
        getResources: noResources(),
      },
      buildCharacter([], { weaponcrafting_level: 1 }),
      { skill: 'weaponcrafting', targetLevel: 5 },
    );

    expect(result.isOk() && result.value).toBeUndefined();
  });

  it('rejects a recipe with a material that has no known source', async () => {
    const mysteryStaff = buildItem({
      code: 'mystery_staff',
      craft: {
        items: [{ code: 'mystery_shard', quantity: 1 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });

    const result = await planProfessionProgress(
      {
        getBankItems: emptyBank(),
        getItem: vi.fn((code: string) =>
          okAsync(buildItemResponse(buildItem({ code }))),
        ),
        getItems: vi.fn(() => okAsync(buildItemPage([mysteryStaff]))),
        getMonster: vi.fn(),
        getMonsters: noMonsters(),
        getResource: vi.fn(),
        getResources: noResources(),
      },
      buildCharacter([], { weaponcrafting_level: 1 }),
      { skill: 'weaponcrafting', targetLevel: 5 },
    );

    expect(result.isOk() && result.value).toBeUndefined();
  });

  it('does not treat an unrelated bank item as the requested recipe material', async () => {
    const woodenStaff = buildItem({
      code: 'wooden_staff',
      craft: {
        items: [{ code: 'ash_wood', quantity: 2 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const getBankItems = vi.fn(() =>
      okAsync(buildBankItemsPage([{ code: 'copper_ore', quantity: 100 }])),
    );

    const result = await planProfessionProgress(
      {
        getBankItems,
        getItem: vi.fn((code: string) =>
          okAsync(buildItemResponse(buildItem({ code }))),
        ),
        getItems: vi.fn(() => okAsync(buildItemPage([woodenStaff]))),
        getMonster: vi.fn(),
        getMonsters: noMonsters(),
        getResource: vi.fn(),
        getResources: noResources(),
      },
      buildCharacter([], { weaponcrafting_level: 1 }),
      { skill: 'weaponcrafting', targetLevel: 5 },
    );

    expect(getBankItems).toHaveBeenCalledWith({ size: 100 });
    expect(result.isOk() && result.value).toBeUndefined();
  });

  it('rejects recipes with incomplete craft metadata', async () => {
    const noCraft = buildItem({ code: 'raw_item' });
    const noLevel = buildItem({
      code: 'no_level_staff',
      craft: {
        items: [{ code: 'ash_wood', quantity: 1 }],
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });

    const result = await planProfessionProgress(
      {
        getBankItems: vi.fn(() =>
          okAsync(buildBankItemsPage([{ code: 'ash_wood', quantity: 10 }])),
        ),
        getItem: vi.fn(),
        getItems: vi.fn(() => okAsync(buildItemPage([noCraft, noLevel]))),
        getMonster: vi.fn(),
        getMonsters: noMonsters(),
        getResource: vi.fn(),
        getResources: noResources(),
      },
      buildCharacter([], { weaponcrafting_level: 1 }),
      { skill: 'weaponcrafting', targetLevel: 5 },
    );

    expect(result.isOk() && result.value).toBeUndefined();
  });

  it('chooses the eligible recipe with the fewest missing safe materials', async () => {
    const character = buildCharacter([], {
      weaponcrafting_level: 1,
      woodcutting_level: 1,
    });
    const expensive = buildItem({
      code: 'a_expensive_staff',
      craft: {
        items: [{ code: 'ash_wood', quantity: 4 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const cheap = buildItem({
      code: 'z_cheap_staff',
      craft: {
        items: [{ code: 'ash_wood', quantity: 2 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const getBankItems = emptyBank();
    const getItems = vi.fn(() => okAsync(buildItemPage([expensive, cheap])));
    const getItem = vi.fn((code: string) =>
      okAsync(buildItemResponse(buildItem({ code }))),
    );
    const ashTree = buildResource('ash_tree', {
      level: 1,
      skill: 'woodcutting',
    });
    const getResource = vi.fn(() => okAsync({ data: ashTree }));
    const getResources = vi.fn(() => okAsync(buildResourcePage([ashTree])));

    const result = await planProfessionProgress(
      {
        getBankItems,
        getItem,
        getItems,
        getMonster: vi.fn(),
        getMonsters: noMonsters(),
        getResource,
        getResources,
      },
      character,
      { skill: 'weaponcrafting', targetLevel: 5 },
    );

    expect(getBankItems).toHaveBeenCalledTimes(1);
    expect(result.isOk() && result.value?.itemCode).toBe('z_cheap_staff');
    expect(result.isOk() && result.value?.missingMaterials).toEqual([
      {
        itemCode: 'ash_wood',
        missingQuantity: 2,
        source: { resourceCode: 'ash_tree', type: 'gather' },
      },
    ]);
  });

  it('uses recipe level as a tie-breaker when material costs are equal', async () => {
    const lowLevel = buildItem({
      code: 'a_low_level_staff',
      craft: {
        items: [{ code: 'ash_wood', quantity: 1 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const highLevel = buildItem({
      code: 'z_high_level_staff',
      craft: {
        items: [{ code: 'ash_wood', quantity: 1 }],
        level: 2,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });

    const result = await planProfessionProgress(
      {
        getBankItems: vi.fn(() =>
          okAsync(buildBankItemsPage([{ code: 'ash_wood', quantity: 1 }])),
        ),
        getItem: vi.fn((code: string) =>
          okAsync(buildItemResponse(buildItem({ code }))),
        ),
        getItems: vi.fn(() => okAsync(buildItemPage([lowLevel, highLevel]))),
        getMonster: vi.fn(),
        getMonsters: noMonsters(),
        getResource: vi.fn(),
        getResources: noResources(),
      },
      buildCharacter([], { weaponcrafting_level: 2 }),
      { skill: 'weaponcrafting', targetLevel: 5 },
    );

    expect(result.isOk() && result.value?.itemCode).toBe('z_high_level_staff');
  });

  it('uses item code as the final deterministic tie-breaker', async () => {
    const first = buildItem({
      code: 'a_staff',
      craft: {
        items: [{ code: 'ash_wood', quantity: 1 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const second = buildItem({
      code: 'b_staff',
      craft: {
        items: [{ code: 'ash_wood', quantity: 1 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });

    const result = await planProfessionProgress(
      {
        getBankItems: vi.fn(() =>
          okAsync(buildBankItemsPage([{ code: 'ash_wood', quantity: 1 }])),
        ),
        getItem: vi.fn((code: string) =>
          okAsync(buildItemResponse(buildItem({ code }))),
        ),
        getItems: vi.fn(() => okAsync(buildItemPage([second, first]))),
        getMonster: vi.fn(),
        getMonsters: noMonsters(),
        getResource: vi.fn(),
        getResources: noResources(),
      },
      buildCharacter([], { weaponcrafting_level: 1 }),
      { skill: 'weaponcrafting', targetLevel: 5 },
    );

    expect(result.isOk() && result.value?.itemCode).toBe('a_staff');
  });

  it("excludes a recipe whose gathering source is above the character's skill level", async () => {
    const character = buildCharacter([], {
      weaponcrafting_level: 1,
      woodcutting_level: 1,
    });
    const woodenStaff = buildItem({
      code: 'wooden_staff',
      craft: {
        items: [{ code: 'spruce_wood', quantity: 2 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const spruceTree = buildResource('spruce_tree', {
      level: 5,
      skill: 'woodcutting',
    });

    const result = await planProfessionProgress(
      {
        getBankItems: emptyBank(),
        getItem: vi.fn((code: string) =>
          okAsync(buildItemResponse(buildItem({ code }))),
        ),
        getItems: vi.fn(() => okAsync(buildItemPage([woodenStaff]))),
        getMonster: vi.fn(),
        getMonsters: noMonsters(),
        getResource: vi.fn(() => okAsync({ data: spruceTree })),
        getResources: vi.fn(() => okAsync(buildResourcePage([spruceTree]))),
      },
      character,
      { skill: 'weaponcrafting', targetLevel: 5 },
    );

    expect(result.isOk() && result.value).toBeUndefined();
  });

  it('accepts a missing material from a safe monster', async () => {
    const character = buildCharacter([], {
      attack_air: 0,
      attack_earth: 20,
      attack_fire: 0,
      attack_water: 0,
      critical_strike: 0,
      dmg: 0,
      dmg_air: 0,
      dmg_earth: 0,
      dmg_fire: 0,
      dmg_water: 0,
      hp: 100,
      res_air: 0,
      res_earth: 0,
      res_fire: 0,
      res_water: 0,
      weaponcrafting_level: 1,
    });
    const featherStaff = buildItem({
      code: 'feather_staff',
      craft: {
        items: [{ code: 'feather', quantity: 1 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const chicken = buildMonster('chicken', {
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
    });

    const result = await planProfessionProgress(
      {
        getBankItems: emptyBank(),
        getItem: vi.fn((code: string) =>
          okAsync(buildItemResponse(buildItem({ code }))),
        ),
        getItems: vi.fn(() => okAsync(buildItemPage([featherStaff]))),
        getMonster: vi.fn(() => okAsync({ data: chicken })),
        getMonsters: vi.fn(() => okAsync(buildMonsterPage([chicken]))),
        getResource: vi.fn(),
        getResources: noResources(),
      },
      character,
      { skill: 'weaponcrafting', targetLevel: 5 },
    );

    expect(result.isOk() && result.value?.missingMaterials).toEqual([
      {
        itemCode: 'feather',
        missingQuantity: 1,
        source: { monsterCode: 'chicken', type: 'hunt' },
      },
    ]);
  });

  it('rejects a missing material from an unsafe monster', async () => {
    const character = buildCharacter([], {
      attack_air: 0,
      attack_earth: 1,
      attack_fire: 0,
      attack_water: 0,
      critical_strike: 0,
      dmg: 0,
      dmg_air: 0,
      dmg_earth: 0,
      dmg_fire: 0,
      dmg_water: 0,
      hp: 100,
      res_air: 0,
      res_earth: 0,
      res_fire: 0,
      res_water: 0,
      weaponcrafting_level: 1,
    });
    const featherStaff = buildItem({
      code: 'feather_staff',
      craft: {
        items: [{ code: 'feather', quantity: 1 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const dragon = buildMonster('dragon', {
      attack_air: 0,
      attack_earth: 100,
      attack_fire: 0,
      attack_water: 0,
      critical_strike: 0,
      hp: 100,
      res_air: 0,
      res_earth: 0,
      res_fire: 0,
      res_water: 0,
    });

    const result = await planProfessionProgress(
      {
        getBankItems: emptyBank(),
        getItem: vi.fn((code: string) =>
          okAsync(buildItemResponse(buildItem({ code }))),
        ),
        getItems: vi.fn(() => okAsync(buildItemPage([featherStaff]))),
        getMonster: vi.fn(() => okAsync({ data: dragon })),
        getMonsters: vi.fn(() => okAsync(buildMonsterPage([dragon]))),
        getResource: vi.fn(),
        getResources: noResources(),
      },
      character,
      { skill: 'weaponcrafting', targetLevel: 5 },
    );

    expect(result.isOk() && result.value).toBeUndefined();
  });

  it('returns no plan once the target profession level is reached', async () => {
    const getItems = vi.fn();

    const result = await planProfessionProgress(
      {
        getBankItems: emptyBank(),
        getItem: vi.fn(),
        getItems,
        getMonster: vi.fn(),
        getMonsters: noMonsters(),
        getResource: vi.fn(),
        getResources: noResources(),
      },
      buildCharacter([], { weaponcrafting_level: 5 }),
      { skill: 'weaponcrafting', targetLevel: 5 },
    );

    expect(result.isOk() && result.value).toBeUndefined();
    expect(getItems).not.toHaveBeenCalled();
  });
});

describe('findCraftableFromBankSurplus', () => {
  it('returns nothing when the bank is empty, without looking up any recipes', async () => {
    const character = buildCharacter([], { weaponcrafting_level: 1 });
    const getBankItems = emptyBank();
    const getItems = vi.fn();

    const result = await findCraftableFromBankSurplus(
      { getBankItems, getItems },
      character,
    );

    expect(result.isOk() && result.value).toEqual([]);
    expect(getBankItems).toHaveBeenCalledWith({ size: 100 });
    expect(getItems).not.toHaveBeenCalled();
  });

  it("finds an item craftable from a bank surplus material, within the character's profession level", async () => {
    const character = buildCharacter([], { weaponcrafting_level: 1 });
    const woodenStaff = buildItem({
      code: 'wooden_staff',
      craft: {
        items: [{ code: 'ash_wood', quantity: 2 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
      type: 'weapon',
    });
    const getBankItems = vi.fn((query?: { item_code?: string }) =>
      okAsync(
        buildBankItemsPage(
          query?.item_code === undefined || query.item_code === 'ash_wood'
            ? [{ code: 'ash_wood', quantity: 10 }]
            : [],
        ),
      ),
    );
    const getItems = vi.fn(() => okAsync(buildItemPage([woodenStaff])));

    const result = await findCraftableFromBankSurplus(
      { getBankItems, getItems },
      character,
    );

    expect(getItems).toHaveBeenCalledWith({
      craft_material: 'ash_wood',
      size: 100,
    });
    expect(result.isOk() && result.value).toEqual([
      {
        craftableQuantity: 5,
        itemCode: 'wooden_staff',
        skill: 'weaponcrafting',
      },
    ]);
  });

  it("excludes a candidate whose profession level requirement isn't met yet", async () => {
    const character = buildCharacter([], { weaponcrafting_level: 0 });
    const woodenStaff = buildItem({
      code: 'wooden_staff',
      craft: {
        items: [{ code: 'ash_wood', quantity: 2 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
      type: 'weapon',
    });
    const getBankItems = vi.fn((query?: { item_code?: string }) =>
      okAsync(
        buildBankItemsPage(
          query?.item_code === undefined || query.item_code === 'ash_wood'
            ? [{ code: 'ash_wood', quantity: 10 }]
            : [],
        ),
      ),
    );
    const getItems = vi.fn(() => okAsync(buildItemPage([woodenStaff])));

    const result = await findCraftableFromBankSurplus(
      { getBankItems, getItems },
      character,
    );

    expect(result.isOk() && result.value).toEqual([]);
  });

  it('excludes a candidate missing enough of a second required material', async () => {
    const character = buildCharacter([], { weaponcrafting_level: 1 });
    const woodenStaff = buildItem({
      code: 'wooden_staff',
      craft: {
        items: [
          { code: 'ash_wood', quantity: 2 },
          { code: 'feather', quantity: 1 },
        ],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
      type: 'weapon',
    });
    const getBankItems = vi.fn((query?: { item_code?: string }) => {
      if (query?.item_code === undefined) {
        return okAsync(
          buildBankItemsPage([{ code: 'ash_wood', quantity: 10 }]),
        );
      }
      if (query.item_code === 'ash_wood') {
        return okAsync(
          buildBankItemsPage([{ code: 'ash_wood', quantity: 10 }]),
        );
      }
      return okAsync(buildBankItemsPage([]));
    });
    const getItems = vi.fn(() => okAsync(buildItemPage([woodenStaff])));

    const result = await findCraftableFromBankSurplus(
      { getBankItems, getItems },
      character,
    );

    expect(result.isOk() && result.value).toEqual([]);
  });

  it('counts matching materials held in inventory toward craftable quantity', async () => {
    const woodenStaff = buildItem({
      code: 'wooden_staff',
      craft: {
        items: [{ code: 'ash_wood', quantity: 2 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const getBankItems = vi.fn((query?: { item_code?: string }) =>
      okAsync(
        buildBankItemsPage(
          query?.item_code === undefined || query.item_code === 'ash_wood'
            ? [{ code: 'ash_wood', quantity: 2 }]
            : [],
        ),
      ),
    );

    const result = await findCraftableFromBankSurplus(
      {
        getBankItems,
        getItems: vi.fn(() => okAsync(buildItemPage([woodenStaff]))),
      },
      buildCharacter([{ code: 'ash_wood', quantity: 2, slot: 1 }], {
        weaponcrafting_level: 1,
      }),
    );

    expect(result.isOk() && result.value).toEqual([
      {
        craftableQuantity: 2,
        itemCode: 'wooden_staff',
        skill: 'weaponcrafting',
      },
    ]);
  });

  it("applies a recipe's output quantity to the craftable result", async () => {
    const bundle = buildItem({
      code: 'wood_bundle',
      craft: {
        items: [{ code: 'ash_wood', quantity: 2 }],
        level: 1,
        quantity: 2,
        skill: 'woodcutting',
      },
    });
    const getBankItems = vi.fn((query?: { item_code?: string }) =>
      okAsync(
        buildBankItemsPage(
          query?.item_code === undefined || query.item_code === 'ash_wood'
            ? [{ code: 'ash_wood', quantity: 4 }]
            : [],
        ),
      ),
    );

    const result = await findCraftableFromBankSurplus(
      { getBankItems, getItems: vi.fn(() => okAsync(buildItemPage([bundle]))) },
      buildCharacter([], { woodcutting_level: 1 }),
    );

    expect(result.isOk() && result.value).toEqual([
      { craftableQuantity: 4, itemCode: 'wood_bundle', skill: 'woodcutting' },
    ]);
  });

  it('excludes candidates with missing craft metadata', async () => {
    const noCraft = buildItem({ code: 'raw_item' });
    const noSkill = buildItem({
      code: 'no_skill_item',
      craft: {
        items: [{ code: 'ash_wood', quantity: 1 }],
        level: 1,
        quantity: 1,
      },
    });
    const noLevel = buildItem({
      code: 'no_level_item',
      craft: {
        items: [{ code: 'ash_wood', quantity: 1 }],
        quantity: 1,
        skill: 'weaponcrafting',
      },
    });
    const getBankItems = vi.fn((query?: { item_code?: string }) =>
      okAsync(
        buildBankItemsPage(
          query?.item_code === undefined || query.item_code === 'ash_wood'
            ? [{ code: 'ash_wood', quantity: 10 }]
            : [],
        ),
      ),
    );

    const result = await findCraftableFromBankSurplus(
      {
        getBankItems,
        getItems: vi.fn(() =>
          okAsync(buildItemPage([noCraft, noSkill, noLevel])),
        ),
      },
      buildCharacter([], { weaponcrafting_level: 1 }),
    );

    expect(result.isOk() && result.value).toEqual([]);
  });

  it('excludes a candidate without crafting materials', async () => {
    const emptyRecipe = buildItem({
      code: 'empty_recipe',
      craft: { items: [], level: 1, quantity: 1, skill: 'weaponcrafting' },
    });
    const getBankItems = vi.fn((query?: { item_code?: string }) =>
      okAsync(
        buildBankItemsPage(
          query?.item_code === undefined
            ? [{ code: 'ash_wood', quantity: 10 }]
            : [],
        ),
      ),
    );

    const result = await findCraftableFromBankSurplus(
      {
        getBankItems,
        getItems: vi.fn(() => okAsync(buildItemPage([emptyRecipe]))),
      },
      buildCharacter([], { weaponcrafting_level: 1 }),
    );

    expect(result.isOk() && result.value).toEqual([]);
  });

  it('deduplicates a candidate surfaced by more than one surplus material', async () => {
    const character = buildCharacter([], { weaponcrafting_level: 1 });
    const woodenStaff = buildItem({
      code: 'wooden_staff',
      craft: {
        items: [
          { code: 'ash_wood', quantity: 2 },
          { code: 'copper_ore', quantity: 1 },
        ],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting',
      },
      type: 'weapon',
    });
    const getBankItems = vi.fn((query?: { item_code?: string }) => {
      if (query?.item_code === undefined) {
        return okAsync(
          buildBankItemsPage([
            { code: 'ash_wood', quantity: 10 },
            { code: 'copper_ore', quantity: 10 },
          ]),
        );
      }
      return okAsync(
        buildBankItemsPage([{ code: query.item_code, quantity: 10 }]),
      );
    });
    const getItems = vi.fn(() => okAsync(buildItemPage([woodenStaff])));

    const result = await findCraftableFromBankSurplus(
      { getBankItems, getItems },
      character,
    );

    expect(getItems).toHaveBeenCalledTimes(2);
    expect(result.isOk() && result.value).toEqual([
      {
        craftableQuantity: 5,
        itemCode: 'wooden_staff',
        skill: 'weaponcrafting',
      },
    ]);
  });
});
