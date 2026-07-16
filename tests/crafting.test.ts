import { errAsync, okAsync, type ResultAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  InsufficientCraftingLevelError,
  InvalidCraftQuantityError,
  MissingCraftingMaterialsError,
  NotCraftableItemError,
  runCraftItemActivity,
} from '../src/bot/activities/crafting.js';
import { LocationNotFoundError } from '../src/bot/world.js';
import { ArtifactsApiError } from '../src/client/index.js';
import type { components } from '../src/client/schema.js';

type Character = components['schemas']['CharacterSchema'];
type Cooldown = components['schemas']['CooldownSchema'];
type Item = components['schemas']['ItemSchema'];
type Map = components['schemas']['MapSchema'];
type MapPage = components['schemas']['StaticDataPage_MapSchema_'];

const WORKSHOP_MAP_ID = 42;

const buildCharacter = (overrides: Partial<Character> = {}): Character => ({
  ...({} as Character),
  inventory: [{ code: 'copper_bar', quantity: 4, slot: 1 }],
  name: 'Stan',
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
  name: 'Copper Dagger',
  ...overrides,
});

const buildMap = (): Map => ({ ...({} as Map), map_id: WORKSHOP_MAP_ID });

const buildMapPage = (data: Map[] = [buildMap()]): MapPage => ({
  data,
  page: 1,
  pages: 1,
  size: 50,
  total: data.length,
});

const buildCooldown = (): Cooldown => ({
  expiration: '2026-07-16T00:00:05.000Z',
  reason: 'crafting',
  remaining_seconds: 5,
  started_at: '2026-07-16T00:00:00.000Z',
  total_seconds: 5,
});

const buildDependencies = (
  character = buildCharacter(),
  item = buildItem(),
  maps = buildMapPage(),
  itemError?: ArtifactsApiError,
) => {
  const craft = vi.fn(() =>
    okAsync({
      character,
      cooldown: buildCooldown(),
      details: { items: [], xp: 10 },
    }),
  );
  const getItem = vi.fn(
    (): ResultAsync<{ data: Item }, ArtifactsApiError> =>
      itemError === undefined ? okAsync({ data: item }) : errAsync(itemError),
  );
  const getMaps = vi.fn(() => okAsync(maps));
  const moveTo = vi.fn(() => okAsync(undefined));

  return {
    agent: { craft, getCharacter: vi.fn(() => character), moveTo },
    client: { getItem, getMaps },
    craft,
    getItem,
    getMaps,
    moveTo,
  };
};

describe('runCraftItemActivity', () => {
  it('moves to the recipe workshop and performs the requested craft', async () => {
    const { agent, client, craft, getItem, getMaps, moveTo } =
      buildDependencies();

    const result = await runCraftItemActivity(client, agent, {
      itemCode: 'copper_dagger',
      quantity: 2,
      type: 'craftItem',
    });

    expect(result.isOk()).toBe(true);
    expect(getItem).toHaveBeenCalledWith('copper_dagger');
    expect(getMaps).toHaveBeenCalledWith({
      content_code: 'weaponcrafting',
      content_type: 'workshop',
    });
    expect(moveTo).toHaveBeenCalledWith(WORKSHOP_MAP_ID);
    expect(craft).toHaveBeenCalledWith('copper_dagger', 2);
  });

  it('supports recipes whose omitted level and materials use API defaults', async () => {
    const item = buildItem({ craft: { skill: 'weaponcrafting' } });
    const { agent, client, craft } = buildDependencies(buildCharacter(), item);

    const result = await runCraftItemActivity(client, agent, {
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'craftItem',
    });

    expect(result.isOk()).toBe(true);
    expect(craft).toHaveBeenCalledWith('copper_dagger', 1);
  });

  it('returns a typed Blocker without acquiring missing materials', async () => {
    const character = buildCharacter({
      inventory: [{ code: 'copper_bar', quantity: 3, slot: 1 }],
    });
    const { agent, client, craft, getMaps, moveTo } =
      buildDependencies(character);

    const result = await runCraftItemActivity(client, agent, {
      itemCode: 'copper_dagger',
      quantity: 2,
      type: 'craftItem',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      MissingCraftingMaterialsError,
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      itemCode: 'copper_dagger',
      message:
        'Crafting "copper_dagger" needs materials that are not held by the character',
      missingMaterials: [
        { availableQuantity: 3, itemCode: 'copper_bar', requiredQuantity: 4 },
      ],
      name: 'MissingCraftingMaterialsError',
    });
    expect(getMaps).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
    expect(craft).not.toHaveBeenCalled();
  });

  it('reports the exact profession level preventing the craft', async () => {
    const character = buildCharacter({ weaponcrafting_level: 4 });
    const { agent, client, craft, getMaps } = buildDependencies(character);

    const result = await runCraftItemActivity(client, agent, {
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'craftItem',
    });

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      InsufficientCraftingLevelError,
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      currentLevel: 4,
      itemCode: 'copper_dagger',
      message:
        'Crafting "copper_dagger" needs weaponcrafting level 5, but the character is only level 4',
      name: 'InsufficientCraftingLevelError',
      requiredLevel: 5,
      skill: 'weaponcrafting',
    });
    expect(getMaps).not.toHaveBeenCalled();
    expect(craft).not.toHaveBeenCalled();
  });

  it('rejects an item without a crafting recipe', async () => {
    const item = buildItem();
    delete item.craft;
    const { agent, client, craft, getMaps } = buildDependencies(
      buildCharacter(),
      item,
    );

    const result = await runCraftItemActivity(client, agent, {
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'craftItem',
    });

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(NotCraftableItemError);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      itemCode: 'copper_dagger',
      message: 'Item "copper_dagger" has no crafting recipe',
      name: 'NotCraftableItemError',
    });
    expect(getMaps).not.toHaveBeenCalled();
    expect(craft).not.toHaveBeenCalled();
  });

  it('rejects a crafting definition without a profession', async () => {
    const item = buildItem({ craft: {} });
    const { agent, client, craft, getMaps } = buildDependencies(
      buildCharacter(),
      item,
    );

    const result = await runCraftItemActivity(client, agent, {
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'craftItem',
    });

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(NotCraftableItemError);
    expect(getMaps).not.toHaveBeenCalled();
    expect(craft).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5])(
    'rejects invalid quantity %s before reading the catalog',
    async (quantity) => {
      const { agent, client, getItem } = buildDependencies();

      const result = await runCraftItemActivity(client, agent, {
        itemCode: 'copper_dagger',
        quantity,
        type: 'craftItem',
      });

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        InvalidCraftQuantityError,
      );
      expect(result._unsafeUnwrapErr()).toMatchObject({
        message: `Craft quantity must be a positive integer, received ${quantity}`,
        name: 'InvalidCraftQuantityError',
        quantity,
      });
      expect(getItem).not.toHaveBeenCalled();
    },
  );

  it('returns a missing-workshop Blocker without crafting', async () => {
    const { agent, client, craft, moveTo } = buildDependencies(
      buildCharacter(),
      buildItem(),
      buildMapPage([]),
    );

    const result = await runCraftItemActivity(client, agent, {
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'craftItem',
    });

    expect(result._unsafeUnwrapErr()).toEqual(
      new LocationNotFoundError('workshop', 'weaponcrafting'),
    );
    expect(moveTo).not.toHaveBeenCalled();
    expect(craft).not.toHaveBeenCalled();
  });

  it('propagates an API failure while reading the item', async () => {
    const apiError = new ArtifactsApiError('unavailable', 503, {});
    const { agent, client, craft } = buildDependencies(
      buildCharacter(),
      buildItem(),
      buildMapPage(),
      apiError,
    );

    const result = await runCraftItemActivity(client, agent, {
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'craftItem',
    });

    expect(result._unsafeUnwrapErr()).toBe(apiError);
    expect(craft).not.toHaveBeenCalled();
  });
});
