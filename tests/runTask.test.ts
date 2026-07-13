import { errAsync, okAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runTask } from "../src/bot/tasks/runTask.js";
import { ArtifactsApiError } from "../src/client/index.js";
import type { ArtifactsClient } from "../src/client/index.js";
import type { components } from "../src/client/schema.js";

type CharacterSnapshot = components["schemas"]["CharacterSchema"];
type Cooldown = components["schemas"]["CooldownSchema"];
type Item = components["schemas"]["ItemSchema"];
type Monster = components["schemas"]["MonsterSchema"];
type Resource = components["schemas"]["ResourceSchema"];

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

// Full set of combat stats needed by isSafeToFight, all zeroed out by
// default so tests can override just the fields they care about.
const buildCombatCharacter = (overrides: Partial<CharacterSnapshot> = {}): CharacterSnapshot =>
  buildCharacter({
    attack_air: 0,
    attack_earth: 0,
    attack_fire: 0,
    attack_water: 0,
    critical_strike: 0,
    dmg: 0,
    dmg_air: 0,
    dmg_earth: 0,
    dmg_fire: 0,
    dmg_water: 0,
    hp: 100,
    level: 1,
    res_air: 0,
    res_earth: 0,
    res_fire: 0,
    res_water: 0,
    ...overrides,
  });

const buildResource = (overrides: Partial<Resource> = {}): Resource =>
  ({
    code: "copper_rocks",
    drops: [],
    level: 1,
    name: "Copper Rocks",
    skill: "mining",
    ...overrides,
  }) as Resource;

const buildMonster = (overrides: Partial<Monster> = {}): Monster =>
  ({
    attack_air: 0,
    attack_earth: 0,
    attack_fire: 0,
    attack_water: 0,
    code: "chicken",
    critical_strike: 0,
    hp: 60,
    level: 1,
    res_air: 0,
    res_earth: 0,
    res_fire: 0,
    res_water: 0,
    ...overrides,
  }) as Monster;

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
    getCharacterLogs: notImplemented,
    getItem: notImplemented,
    getItems: notImplemented,
    getMaps: notImplemented,
    getMonster: notImplemented,
    getMonsters: notImplemented,
    getResource: notImplemented,
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

    it("equips the best gathering tool for the resource before starting to farm", async () => {
      const character = buildCharacter({
        inventory: [{ code: "copper_pickaxe", quantity: 1, slot: 1 }],
        level: 1,
      });
      const pickaxe = buildItem({
        code: "copper_pickaxe",
        effects: [{ code: "mining", description: "", value: -10 }],
        type: "weapon",
      });
      const getResource = vi.fn(() => okAsync({ data: buildResource() }));
      const getItems = vi.fn(() =>
        okAsync({ data: [pickaxe], page: 1, pages: 1, size: 100, total: 1 }),
      );
      const getItem = vi.fn(() => okAsync({ data: pickaxe }));
      const equip = vi.fn(() =>
        okAsync({
          data: { character, cooldown: buildCooldown("2024-01-01T00:00:03.000Z"), items: [] },
        }),
      );
      const apiError = new ArtifactsApiError("boom", 500, undefined);
      const getMaps = vi.fn(() => errAsync(apiError));
      const client = buildFakeClient({
        equip,
        getCharacter: () => okAsync({ data: character }),
        getItem,
        getItems,
        getMaps,
        getResource,
      });

      void runTask(client, "Cartman", { resource: "copper_rocks", type: "farm" });

      await vi.advanceTimersByTimeAsync(0);
      expect(getResource).toHaveBeenCalledWith("copper_rocks");
      expect(getItems).toHaveBeenCalledWith({ max_level: 1, size: 100, type: "weapon" });
      expect(equip).toHaveBeenCalledWith("Cartman", [
        { code: "copper_pickaxe", quantity: 1, slot: "weapon" },
      ]);
      expect(getMaps).toHaveBeenCalledTimes(1);
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

    it("equips the best combat weapon for the monster before starting to hunt", async () => {
      const character = buildCombatCharacter({
        attack_earth: 20,
        inventory: [{ code: "copper_dagger", quantity: 1, slot: 1 }],
        level: 4,
      });
      const monster = buildMonster({ code: "chicken", res_air: 0, res_earth: 0 });
      const dagger = buildItem({
        code: "copper_dagger",
        effects: [{ code: "attack_air", description: "", value: 6 }],
        type: "weapon",
      });
      const getMonster = vi.fn(() => okAsync({ data: monster }));
      const getItems = vi.fn(() =>
        okAsync({ data: [dagger], page: 1, pages: 1, size: 100, total: 1 }),
      );
      const getItem = vi.fn(() => okAsync({ data: dagger }));
      const equip = vi.fn(() =>
        okAsync({
          data: { character, cooldown: buildCooldown("2024-01-01T00:00:03.000Z"), items: [] },
        }),
      );
      const apiError = new ArtifactsApiError("boom", 500, undefined);
      const getMaps = vi.fn(() => errAsync(apiError));
      const client = buildFakeClient({
        equip,
        getCharacter: () => okAsync({ data: character }),
        getItem,
        getItems,
        getMaps,
        getMonster,
      });

      void runTask(client, "Cartman", { monster: "chicken", type: "hunt" });

      await vi.advanceTimersByTimeAsync(0);
      expect(getMonster).toHaveBeenCalledWith("chicken");
      expect(getItems).toHaveBeenCalledWith({ max_level: 4, size: 100, type: "weapon" });
      expect(equip).toHaveBeenCalledWith("Cartman", [
        { code: "copper_dagger", quantity: 1, slot: "weapon" },
      ]);
      expect(getMaps).toHaveBeenCalledTimes(1);
    });
  });

  describe("autoHunt task", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("picks a safe monster via findNextSafeMonster, then hunts it", async () => {
      const character = buildCombatCharacter({
        attack_earth: 20,
        hp: 150,
        level: 4,
        max_hp: 150,
      });
      const monster = buildMonster({ attack_water: 4, code: "chicken", hp: 60, level: 1 });
      const getMonsters = vi.fn(() =>
        okAsync({ data: [monster], page: 1, pages: 1, size: 50, total: 1 }),
      );
      // Let the hunting cycle itself fail so we can reuse the same
      // retry-timing assertions as the other task tests below.
      const apiError = new ArtifactsApiError("boom", 500, undefined);
      const getMaps = vi.fn(() => errAsync(apiError));
      const client = buildFakeClient({
        getCharacter: () => okAsync({ data: character }),
        getMaps,
        getMonsters,
      });

      void runTask(client, "Cartman", { type: "autoHunt" });

      await vi.advanceTimersByTimeAsync(0);
      expect(getMonsters).toHaveBeenCalledWith({ max_level: 4 });
      expect(getMaps).toHaveBeenCalledTimes(1); // resolveLocation("monster", "chicken")

      await vi.advanceTimersByTimeAsync(9_999);
      expect(getMaps).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(getMaps).toHaveBeenCalledTimes(2);
    });

    it("retries after a delay when no monster is currently safe to fight", async () => {
      // Full HP, 0 attack in every element - nothing is safe because it
      // can't deal damage, not because of low HP (see the dedicated resting
      // test below for that case).
      const character = buildCombatCharacter({ hp: 100, level: 4, max_hp: 100 });
      const dangerousMonster = buildMonster({ attack_earth: 50, code: "cow", hp: 2_000, level: 4 });
      const getMonsters = vi.fn(() =>
        okAsync({ data: [dangerousMonster], page: 1, pages: 1, size: 50, total: 1 }),
      );
      const getMaps = vi.fn();
      const client = buildFakeClient({
        getCharacter: () => okAsync({ data: character }),
        getMaps,
        getMonsters,
      });

      void runTask(client, "Cartman", { type: "autoHunt" });

      await vi.advanceTimersByTimeAsync(0);
      expect(getMonsters).toHaveBeenCalledTimes(1);
      expect(getMaps).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(9_999);
      expect(getMonsters).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(getMonsters).toHaveBeenCalledTimes(2);
    });

    it("rests first even when no monster ends up being safe (regression: characters stuck retrying forever at critically low HP)", async () => {
      // At 1/170 HP, isSafeToFight correctly finds nothing safe to fight -
      // but that must not prevent resting: without a rest-first step, a
      // character in this state could never recover (see combat.ts's
      // restIfLow doc comment).
      const character = buildCombatCharacter({ attack_earth: 20, hp: 1, level: 4, max_hp: 170 });
      const anyMonster = buildMonster({ code: "chicken", hp: 60, level: 1 });
      const getMonsters = vi.fn(() =>
        okAsync({ data: [anyMonster], page: 1, pages: 1, size: 50, total: 1 }),
      );
      const rest = vi.fn(() =>
        okAsync({
          data: {
            character: buildCombatCharacter({ attack_earth: 20, hp: 170, level: 4, max_hp: 170 }),
            cooldown: buildCooldown("2024-01-01T00:00:03.000Z"),
            hp_restored: 169,
          },
        }),
      );
      const client = buildFakeClient({
        getCharacter: () => okAsync({ data: character }),
        getMonsters,
        rest,
      });

      void runTask(client, "Cartman", { type: "autoHunt" });

      await vi.advanceTimersByTimeAsync(0);
      expect(rest).toHaveBeenCalledTimes(1);
    });
  });
});
