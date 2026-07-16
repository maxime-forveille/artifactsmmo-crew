import { errAsync, okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { runHuntingCycle } from '../src/bot/activities/hunting.js';
import { LocationNotFoundError } from '../src/bot/world.js';
import { ArtifactsApiError } from '../src/client/index.js';
import type { components } from '../src/client/schema.js';

type CharacterSnapshot = components['schemas']['CharacterSchema'];
type Map = components['schemas']['MapSchema'];
type MapPage = components['schemas']['StaticDataPage_MapSchema_'];
type Cooldown = components['schemas']['CooldownSchema'];
type MapQuery = { content_code?: string; content_type?: string };

const MONSTER_MAP_ID = 411;
const BANK_MAP_ID = 334;

const buildCooldown = (): Cooldown => ({
  expiration: '2024-01-01T00:00:05.000Z',
  reason: 'fight',
  remaining_seconds: 5,
  started_at: '2024-01-01T00:00:00.000Z',
  total_seconds: 5,
});

const buildMap = (mapId: number): Map => ({ ...({} as Map), map_id: mapId });

const buildPage = (data: Map[]): MapPage => ({
  data,
  page: 1,
  pages: 1,
  size: 50,
  total: data.length,
});

// Resolves to MONSTER_MAP_ID or BANK_MAP_ID depending on the requested content type.
const buildGetMaps = () =>
  vi.fn((query: MapQuery = {}) =>
    okAsync(
      buildPage([
        buildMap(query.content_type === 'bank' ? BANK_MAP_ID : MONSTER_MAP_ID),
      ]),
    ),
  );

const buildCharacter = (
  overrides: Partial<CharacterSnapshot> = {},
): CharacterSnapshot => ({
  ...({} as CharacterSnapshot),
  hp: 100,
  inventory: [],
  inventory_max_items: 20,
  map_id: 1,
  max_hp: 100,
  name: 'Cartman',
  ...overrides,
});

const buildFightResult = (character: CharacterSnapshot) => ({
  character,
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

describe('runHuntingCycle', () => {
  it('moves to the monster, fights until full, then moves to the bank and deposits everything', async () => {
    const getMaps = buildGetMaps();
    let character = buildCharacter();
    const getCharacter = vi.fn(() => character);

    const fight = vi.fn(() => {
      const heldQuantity = character.inventory?.[0]?.quantity ?? 0;
      character = {
        ...character,
        inventory: [{ code: 'feather', quantity: heldQuantity + 10, slot: 1 }],
      };
      return okAsync(buildFightResult(character));
    });
    const rest = vi.fn();
    const moveTo = vi.fn(() => okAsync(undefined));
    const depositItems = vi.fn(() => {
      character = { ...character, inventory: [] };
      return okAsync({
        bank: [],
        character,
        cooldown: buildCooldown(),
        items: [],
      });
    });

    const result = await runHuntingCycle(
      { getMaps },
      { depositItems, fight, getCharacter, moveTo, rest },
      'chicken',
    );

    expect(result.isOk()).toBe(true);
    expect(moveTo).toHaveBeenNthCalledWith(1, MONSTER_MAP_ID);
    expect(moveTo).toHaveBeenNthCalledWith(2, BANK_MAP_ID);
    // Inventory goes 0 -> 10 -> 20 (full, cap reached exactly on the 2nd fight).
    expect(fight).toHaveBeenCalledTimes(2);
    expect(depositItems).toHaveBeenCalledWith([
      { code: 'feather', quantity: 20 },
    ]);
  });

  it('skips fighting entirely when the inventory starts already full', async () => {
    const getMaps = buildGetMaps();
    const character = buildCharacter({
      inventory: [{ code: 'feather', quantity: 20, slot: 1 }],
    });
    const getCharacter = vi.fn(() => character);
    const fight = vi.fn();
    const rest = vi.fn();
    const moveTo = vi.fn(() => okAsync(undefined));
    const depositItems = vi.fn(() =>
      okAsync({ bank: [], character, cooldown: buildCooldown(), items: [] }),
    );

    const result = await runHuntingCycle(
      { getMaps },
      { depositItems, fight, getCharacter, moveTo, rest },
      'chicken',
    );

    expect(result.isOk()).toBe(true);
    expect(fight).not.toHaveBeenCalled();
    expect(depositItems).toHaveBeenCalledWith([
      { code: 'feather', quantity: 20 },
    ]);
  });

  it("propagates a LocationNotFoundError when the monster can't be resolved, without moving", async () => {
    const getMaps = vi.fn(() => okAsync(buildPage([])));
    const moveTo = vi.fn();
    const fight = vi.fn();
    const rest = vi.fn();
    const getCharacter = vi.fn(() => buildCharacter());
    const depositItems = vi.fn();

    const result = await runHuntingCycle(
      { getMaps },
      { depositItems, fight, getCharacter, moveTo, rest },
      'unknown_monster',
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(LocationNotFoundError);
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('propagates a fight failure and does not proceed to the bank', async () => {
    const getMaps = buildGetMaps();
    const character = buildCharacter();
    const getCharacter = vi.fn(() => character);
    const apiError = new ArtifactsApiError('boom', 500, undefined);
    const fight = vi.fn(() => errAsync(apiError));
    const rest = vi.fn();
    const moveTo = vi.fn(() => okAsync(undefined));
    const depositItems = vi.fn();

    const result = await runHuntingCycle(
      { getMaps },
      { depositItems, fight, getCharacter, moveTo, rest },
      'chicken',
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(apiError);
    expect(depositItems).not.toHaveBeenCalled();
    // Only the trip to the monster happened, not the trip to the bank.
    expect(moveTo).toHaveBeenCalledTimes(1);
  });
});
