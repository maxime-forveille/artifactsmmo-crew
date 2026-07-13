import { errAsync, okAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runTask } from "../src/bot/tasks/runTask.js";
import { ArtifactsApiError } from "../src/client/index.js";
import type { ArtifactsClient } from "../src/client/index.js";
import type { components } from "../src/client/schema.js";

type CharacterSnapshot = components["schemas"]["CharacterSchema"];
type Cooldown = components["schemas"]["CooldownSchema"];
type Item = components["schemas"]["ItemSchema"];

const buildItem = (overrides: Partial<Item>): Item => ({
  ...({} as Item),
  ...overrides,
});

const buildCooldown = (expiration: string): Cooldown => ({
  expiration,
  reason: "movement",
  remaining_seconds: 0,
  started_at: "2024-01-01T00:00:00.000Z",
  total_seconds: 0,
});

const buildCharacter = (overrides: Partial<CharacterSnapshot> = {}): CharacterSnapshot => ({
  ...({} as CharacterSnapshot),
  inventory: [],
  inventory_max_items: 100,
  map_id: 1,
  name: "Cartman",
  ...overrides,
});

const notImplemented = () =>
  errAsync(new ArtifactsApiError("not implemented in test", 501, undefined));

const buildFakeClient = (overrides: Partial<ArtifactsClient> = {}): ArtifactsClient =>
  ({
    client: {} as ArtifactsClient["client"],
    craft: notImplemented,
    depositGold: notImplemented,
    depositItems: notImplemented,
    equip: notImplemented,
    fight: notImplemented,
    gather: notImplemented,
    getCharacter: () => okAsync({ data: buildCharacter() }),
    getItem: notImplemented,
    getMaps: notImplemented,
    getMonsters: notImplemented,
    getResources: notImplemented,
    moveCharacter: notImplemented,
    rest: notImplemented,
    withdrawGold: notImplemented,
    withdrawItems: notImplemented,
    ...overrides,
  }) as ArtifactsClient;

describe("runTask", () => {
  it("logs and resolves without throwing when creating the character agent fails", async () => {
    const apiError = new ArtifactsApiError("character not found", 498, undefined);
    const client = buildFakeClient({ getCharacter: () => errAsync(apiError) });

    await expect(
      runTask(client, "Ghost", { items: ["copper_ring"], type: "craftAndEquip" }),
    ).resolves.toBeUndefined();
  });

  it("runs a craftAndEquip task: equips an item already held, without gathering or crafting", async () => {
    const character = buildCharacter({
      inventory: [{ code: "copper_ring", quantity: 1, slot: 1 }],
    });
    const equip = vi.fn(() =>
      okAsync({
        data: { character, cooldown: buildCooldown("2024-01-01T00:00:03.000Z"), items: [] },
      }),
    );
    const getItem = vi.fn(() =>
      okAsync({ data: buildItem({ code: "copper_ring", type: "ring" }) }),
    );
    const client = buildFakeClient({
      equip,
      getCharacter: () => okAsync({ data: character }),
      getItem,
    });

    await runTask(client, "Cartman", { items: ["copper_ring"], type: "craftAndEquip" });

    expect(equip).toHaveBeenCalledWith("Cartman", [
      { code: "copper_ring", quantity: 1, slot: "ring1" },
    ]);
  });

  it("keeps going to the next item in the list when one fails", async () => {
    const character = buildCharacter({
      inventory: [{ code: "copper_ring", quantity: 1, slot: 1 }],
    });
    const getItem = vi.fn((code: string) =>
      code === "broken_item"
        ? okAsync({ data: buildItem({ code: "broken_item", type: "artifact" }) })
        : okAsync({ data: buildItem({ code: "copper_ring", type: "ring" }) }),
    );
    const equip = vi.fn(() =>
      okAsync({
        data: { character, cooldown: buildCooldown("2024-01-01T00:00:03.000Z"), items: [] },
      }),
    );
    const client = buildFakeClient({
      equip,
      getCharacter: () => okAsync({ data: character }),
      getItem,
    });

    await runTask(client, "Cartman", {
      items: ["broken_item", "copper_ring"],
      type: "craftAndEquip",
    });

    expect(equip).toHaveBeenCalledWith("Cartman", [
      { code: "copper_ring", quantity: 1, slot: "ring1" },
    ]);
  });

  describe("craftAndEquipThenHunt task", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("crafts/equips the items, then switches to hunting", async () => {
      const character = buildCharacter({
        inventory: [{ code: "copper_ring", quantity: 1, slot: 1 }],
      });
      const equip = vi.fn(() =>
        okAsync({
          data: { character, cooldown: buildCooldown("2024-01-01T00:00:03.000Z"), items: [] },
        }),
      );
      const getItem = vi.fn(() =>
        okAsync({ data: buildItem({ code: "copper_ring", type: "ring" }) }),
      );
      const apiError = new ArtifactsApiError("boom", 500, undefined);
      const getMaps = vi.fn(() => errAsync(apiError));
      const client = buildFakeClient({
        equip,
        getCharacter: () => okAsync({ data: character }),
        getItem,
        getMaps,
      });

      void runTask(client, "Cartman", {
        items: ["copper_ring"],
        monster: "chicken",
        type: "craftAndEquipThenHunt",
      });

      // Craft/equip phase resolves immediately (item already held), then the
      // hunt phase starts and retries on failure just like a plain "hunt" task.
      await vi.advanceTimersByTimeAsync(0);
      expect(equip).toHaveBeenCalledWith("Cartman", [
        { code: "copper_ring", quantity: 1, slot: "ring1" },
      ]);
      expect(getMaps).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(9_999);
      expect(getMaps).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(getMaps).toHaveBeenCalledTimes(2);
    });
  });

  describe("farm task", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries after a delay when a farming cycle fails", async () => {
      const apiError = new ArtifactsApiError("boom", 500, undefined);
      const getMaps = vi.fn(() => errAsync(apiError));
      const client = buildFakeClient({ getMaps });

      void runTask(client, "Cartman", { resource: "copper_rocks", type: "farm" });

      await vi.advanceTimersByTimeAsync(0);
      expect(getMaps).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(9_999);
      expect(getMaps).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(getMaps).toHaveBeenCalledTimes(2);
    });
  });

  describe("hunt task", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries after a delay when a hunting cycle fails", async () => {
      const apiError = new ArtifactsApiError("boom", 500, undefined);
      const getMaps = vi.fn(() => errAsync(apiError));
      const client = buildFakeClient({ getMaps });

      void runTask(client, "Cartman", { monster: "chicken", type: "hunt" });

      await vi.advanceTimersByTimeAsync(0);
      expect(getMaps).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(9_999);
      expect(getMaps).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(getMaps).toHaveBeenCalledTimes(2);
    });
  });
});
