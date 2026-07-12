import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";

import { runFarmingCycle } from "../src/bot/strategies/farming.js";
import { LocationNotFoundError } from "../src/bot/world.js";
import { ArtifactsApiError } from "../src/client/index.js";
import type { components } from "../src/client/schema.js";

type CharacterSnapshot = components["schemas"]["CharacterSchema"];
type Map = components["schemas"]["MapSchema"];
type MapPage = components["schemas"]["StaticDataPage_MapSchema_"];
type Cooldown = components["schemas"]["CooldownSchema"];
type MapQuery = { content_code?: string; content_type?: string };

const RESOURCE_MAP_ID = 277;
const BANK_MAP_ID = 334;

const buildCooldown = (): Cooldown => ({
  expiration: "2024-01-01T00:00:05.000Z",
  reason: "gathering",
  remaining_seconds: 5,
  started_at: "2024-01-01T00:00:00.000Z",
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

// Resolves to RESOURCE_MAP_ID or BANK_MAP_ID depending on the requested content type.
const buildGetMaps = () =>
  vi.fn((query: MapQuery = {}) =>
    okAsync(buildPage([buildMap(query.content_type === "bank" ? BANK_MAP_ID : RESOURCE_MAP_ID)])),
  );

const buildCharacter = (overrides: Partial<CharacterSnapshot> = {}): CharacterSnapshot => ({
  ...({} as CharacterSnapshot),
  inventory: [],
  inventory_max_items: 20,
  map_id: 1,
  name: "Cartman",
  ...overrides,
});

describe("runFarmingCycle", () => {
  it("moves to the resource, gathers until full, then moves to the bank and deposits everything", async () => {
    const getMaps = buildGetMaps();
    let character = buildCharacter({ inventory_max_items: 20 });
    const getCharacter = vi.fn(() => character);

    const gather = vi.fn(() => {
      const heldQuantity = character.inventory?.[0]?.quantity ?? 0;
      character = {
        ...character,
        inventory: [{ code: "copper_ore", quantity: heldQuantity + 10, slot: 1 }],
      };
      return okAsync({ character, cooldown: buildCooldown(), details: { items: [], xp: 5 } });
    });

    const moveTo = vi.fn(() => okAsync(undefined));

    const depositItems = vi.fn(() => {
      character = { ...character, inventory: [] };
      return okAsync({ bank: [], character, cooldown: buildCooldown(), items: [] });
    });

    const result = await runFarmingCycle(
      { getMaps },
      { depositItems, gather, getCharacter, moveTo },
      "copper_rocks",
    );

    expect(result.isOk()).toBe(true);
    expect(moveTo).toHaveBeenNthCalledWith(1, RESOURCE_MAP_ID);
    expect(moveTo).toHaveBeenNthCalledWith(2, BANK_MAP_ID);
    // Inventory goes 0 -> 10 -> 20 (full, cap reached exactly on the 2nd gather).
    expect(gather).toHaveBeenCalledTimes(2);
    expect(depositItems).toHaveBeenCalledWith([{ code: "copper_ore", quantity: 20 }]);
  });

  it("skips gathering entirely when the inventory starts already full", async () => {
    const getMaps = buildGetMaps();
    const character = buildCharacter({
      inventory: [{ code: "copper_ore", quantity: 20, slot: 1 }],
      inventory_max_items: 20,
    });
    const getCharacter = vi.fn(() => character);
    const gather = vi.fn();
    const moveTo = vi.fn(() => okAsync(undefined));
    const depositItems = vi.fn(() =>
      okAsync({ bank: [], character, cooldown: buildCooldown(), items: [] }),
    );

    const result = await runFarmingCycle(
      { getMaps },
      { depositItems, gather, getCharacter, moveTo },
      "copper_rocks",
    );

    expect(result.isOk()).toBe(true);
    expect(gather).not.toHaveBeenCalled();
    expect(depositItems).toHaveBeenCalledWith([{ code: "copper_ore", quantity: 20 }]);
  });

  it("propagates a LocationNotFoundError when the resource can't be resolved, without moving", async () => {
    const getMaps = vi.fn(() => okAsync(buildPage([])));
    const moveTo = vi.fn();
    const gather = vi.fn();
    const getCharacter = vi.fn(() => buildCharacter());
    const depositItems = vi.fn();

    const result = await runFarmingCycle(
      { getMaps },
      { depositItems, gather, getCharacter, moveTo },
      "unknown_resource",
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(LocationNotFoundError);
    expect(moveTo).not.toHaveBeenCalled();
  });

  it("propagates a gather failure and does not proceed to the bank", async () => {
    const getMaps = buildGetMaps();
    const character = buildCharacter({ inventory_max_items: 20 });
    const getCharacter = vi.fn(() => character);
    const apiError = new ArtifactsApiError("inventory full", 497, undefined);
    const gather = vi.fn(() => errAsync(apiError));
    const moveTo = vi.fn(() => okAsync(undefined));
    const depositItems = vi.fn();

    const result = await runFarmingCycle(
      { getMaps },
      { depositItems, gather, getCharacter, moveTo },
      "copper_rocks",
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(apiError);
    expect(depositItems).not.toHaveBeenCalled();
    // Only the trip to the resource happened, not the trip to the bank.
    expect(moveTo).toHaveBeenCalledTimes(1);
  });
});
