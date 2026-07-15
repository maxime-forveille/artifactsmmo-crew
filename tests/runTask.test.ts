import { errAsync, okAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runTask } from "../src/bot/tasks/runTask.js";
import { ArtifactsApiError } from "../src/client/index.js";
import type { ArtifactsClient } from "../src/client/index.js";
import type { components } from "../src/client/schema.js";

type CharacterSnapshot = components["schemas"]["CharacterSchema"];
type Cooldown = components["schemas"]["CooldownSchema"];
type Item = components["schemas"]["ItemSchema"];
type MapSchema = components["schemas"]["MapSchema"];
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

    it("does not equip a gathering tool that isn't free right now, keeping the current one", async () => {
      const character = buildCharacter({ level: 1 });
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
      const getBankItems = vi.fn(() =>
        okAsync({ data: [], page: 1, pages: 1, size: 50, total: 0 }),
      );
      const getResources = vi.fn(() =>
        okAsync({ data: [], page: 1, pages: 1, size: 50, total: 0 }),
      );
      const getMonsters = vi.fn(() => okAsync({ data: [], page: 1, pages: 1, size: 50, total: 0 }));
      const equip = vi.fn();
      const apiError = new ArtifactsApiError("boom", 500, undefined);
      const getMaps = vi.fn(() => errAsync(apiError));
      const client = buildFakeClient({
        equip,
        getBankItems,
        getCharacter: () => okAsync({ data: character }),
        getItem,
        getItems,
        getMaps,
        getMonsters,
        getResource,
        getResources,
      });

      void runTask(client, "Cartman", { resource: "copper_rocks", type: "farm" });

      await vi.advanceTimersByTimeAsync(0);
      expect(getBankItems).toHaveBeenCalledWith({ item_code: "copper_pickaxe" });
      expect(equip).not.toHaveBeenCalled();
    });
  });

  describe("autoFarm task", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("picks the highest-level resource for the skill, then farms it", async () => {
      const character = buildCharacter({ level: 1, mining_level: 8 });
      const resource = buildResource({ code: "iron_rocks", level: 8, skill: "mining" });
      const getResources = vi.fn(() =>
        okAsync({ data: [resource], page: 1, pages: 1, size: 50, total: 1 }),
      );
      const apiError = new ArtifactsApiError("boom", 500, undefined);
      const getMaps = vi.fn(() => errAsync(apiError));
      const client = buildFakeClient({
        getCharacter: () => okAsync({ data: character }),
        getMaps,
        getResources,
      });

      void runTask(client, "Cartman", { skill: "mining", type: "autoFarm" });

      await vi.advanceTimersByTimeAsync(0);
      expect(getResources).toHaveBeenCalledWith({ max_level: 8, skill: "mining" });
      expect(getMaps).toHaveBeenCalledTimes(1); // resolveLocation("resource", "iron_rocks")

      await vi.advanceTimersByTimeAsync(9_999);
      expect(getMaps).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(getMaps).toHaveBeenCalledTimes(2);
    });

    it("retries after a delay when no resource is currently within reach for the skill", async () => {
      const character = buildCharacter({ level: 1, mining_level: 1 });
      const getResources = vi.fn(() =>
        okAsync({ data: [], page: 1, pages: 1, size: 50, total: 0 }),
      );
      const getMaps = vi.fn();
      const client = buildFakeClient({
        getCharacter: () => okAsync({ data: character }),
        getMaps,
        getResources,
      });

      void runTask(client, "Cartman", { skill: "mining", type: "autoFarm" });

      await vi.advanceTimersByTimeAsync(0);
      expect(getResources).toHaveBeenCalledTimes(1);
      expect(getMaps).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(9_999);
      expect(getResources).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(getResources).toHaveBeenCalledTimes(2);
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

    it("does not equip a better weapon that isn't free right now, keeping the current one", async () => {
      const character = buildCombatCharacter({ attack_earth: 20, level: 4 });
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
      const getBankItems = vi.fn(() =>
        okAsync({ data: [], page: 1, pages: 1, size: 50, total: 0 }),
      );
      const getResources = vi.fn(() =>
        okAsync({ data: [], page: 1, pages: 1, size: 50, total: 0 }),
      );
      const getMonsters = vi.fn(() => okAsync({ data: [], page: 1, pages: 1, size: 50, total: 0 }));
      const equip = vi.fn();
      const apiError = new ArtifactsApiError("boom", 500, undefined);
      const getMaps = vi.fn(() => errAsync(apiError));
      const client = buildFakeClient({
        equip,
        getBankItems,
        getCharacter: () => okAsync({ data: character }),
        getItem,
        getItems,
        getMaps,
        getMonster,
        getMonsters,
        getResources,
      });

      void runTask(client, "Cartman", { monster: "chicken", type: "hunt" });

      await vi.advanceTimersByTimeAsync(0);
      expect(getMonster).toHaveBeenCalledWith("chicken");
      expect(getBankItems).toHaveBeenCalledWith({ item_code: "copper_dagger" });
      expect(equip).not.toHaveBeenCalled();
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

    it("checks every combat slot on the task's first cycle, even without a level-up", async () => {
      // Regression: without a first-cycle check, a character who was
      // already at their current level before this task started (e.g.
      // after a process restart) would never trigger a future "level
      // increased" comparison, so a fully free upgrade could sit
      // unequipped indefinitely - found live.
      const character = buildCombatCharacter({ attack_earth: 20, hp: 170, level: 4, max_hp: 170 });
      const monster = buildMonster({ code: "chicken", hp: 60, level: 1 });
      const getMonsters = vi.fn(() =>
        okAsync({ data: [monster], page: 1, pages: 1, size: 50, total: 1 }),
      );
      const getItems = vi.fn((_query?: { type?: string }) =>
        okAsync({ data: [], page: 1, pages: 1, size: 100, total: 0 }),
      );
      const getMaps = vi.fn(() => errAsync(new ArtifactsApiError("boom", 500, undefined)));
      const client = buildFakeClient({
        getCharacter: () => okAsync({ data: character }),
        getItems,
        getMaps,
        getMonsters,
      });

      void runTask(client, "Cartman", { type: "autoHunt" });

      await vi.advanceTimersByTimeAsync(0);
      const sortStrings = (a: string | undefined, b: string | undefined) =>
        (a ?? "").localeCompare(b ?? "");
      const queriedTypes = getItems.mock.calls.map(([query]) => query?.type).sort(sortStrings);
      expect(queriedTypes).toEqual(
        ["amulet", "body_armor", "boots", "helmet", "leg_armor", "ring", "shield", "weapon"].sort(
          sortStrings,
        ),
      );
    });

    it("only re-checks the weapon slot on a later cycle, once the first-cycle scan already happened", async () => {
      const character = buildCombatCharacter({ attack_earth: 20, hp: 170, level: 4, max_hp: 170 });
      const monster = buildMonster({ code: "chicken", hp: 60, level: 1 });
      const getMonsters = vi.fn(() =>
        okAsync({ data: [monster], page: 1, pages: 1, size: 50, total: 1 }),
      );
      const getItems = vi.fn((_query?: { type?: string }) =>
        okAsync({ data: [], page: 1, pages: 1, size: 100, total: 0 }),
      );
      const getMaps = vi.fn(() => errAsync(new ArtifactsApiError("boom", 500, undefined)));
      const client = buildFakeClient({
        getCharacter: () => okAsync({ data: character }),
        getItems,
        getMaps,
        getMonsters,
      });

      void runTask(client, "Cartman", { type: "autoHunt" });

      // First cycle: the initial full-slot scan (see the test above), then
      // the hunting cycle itself fails (getMaps errors), so runForever waits
      // its retry delay before the second cycle.
      await vi.advanceTimersByTimeAsync(0);
      getItems.mockClear();

      await vi.advanceTimersByTimeAsync(10_000);
      const queriedTypes = getItems.mock.calls.map(([query]) => query?.type);
      expect(queriedTypes).toEqual(["weapon"]);
    });

    it("checks every combat slot right after the character levels up", async () => {
      const character = buildCombatCharacter({ attack_earth: 20, hp: 1, level: 4, max_hp: 170 });
      const monster = buildMonster({ code: "chicken", hp: 60, level: 1 });
      const getMonsters = vi.fn(() =>
        okAsync({ data: [monster], page: 1, pages: 1, size: 50, total: 1 }),
      );
      const rest = vi.fn(() =>
        okAsync({
          data: {
            // Leveled up from resting - a simplification for this test
            // (in the real game, level-ups come from combat/skill XP, not
            // resting). What matters here is only that
            // agent.getCharacter().level increased between checks.
            character: buildCombatCharacter({
              attack_earth: 20,
              hp: 170,
              level: 5,
              max_hp: 170,
            }),
            cooldown: buildCooldown("2024-01-01T00:00:03.000Z"),
            hp_restored: 169,
          },
        }),
      );
      const getItems = vi.fn((_query?: { type?: string }) =>
        okAsync({ data: [], page: 1, pages: 1, size: 100, total: 0 }),
      );
      const getMaps = vi.fn(() => errAsync(new ArtifactsApiError("boom", 500, undefined)));
      const client = buildFakeClient({
        getCharacter: () => okAsync({ data: character }),
        getItems,
        getMaps,
        getMonsters,
        rest,
      });

      void runTask(client, "Cartman", { type: "autoHunt" });

      await vi.advanceTimersByTimeAsync(0);
      const sortStrings = (a: string | undefined, b: string | undefined) =>
        (a ?? "").localeCompare(b ?? "");
      const queriedTypes = getItems.mock.calls.map(([query]) => query?.type).sort(sortStrings);
      expect(queriedTypes).toEqual(
        ["amulet", "body_armor", "boots", "helmet", "leg_armor", "ring", "shield", "weapon"].sort(
          sortStrings,
        ),
      );
    });

    it("equips a worthwhile upgrade at level-up even when it needs gathering first, as long as its material has a known source", async () => {
      const held = new Map<string, number>();
      const buildLeveledCharacter = (): CharacterSnapshot =>
        buildCombatCharacter({
          attack_earth: 20,
          hp: 170,
          inventory: [...held.entries()].map(([code, quantity], index) => ({
            code,
            quantity,
            slot: index,
          })),
          level: 5,
          map_id: 1,
          max_hp: 170,
          weapon_slot: "",
        });
      const monster = buildMonster({ code: "chicken", hp: 60, level: 1 });
      const newWeapon = buildItem({
        code: "new_weapon",
        effects: [{ code: "attack_earth", description: "", value: 30 }],
        type: "weapon",
      });
      const newWeaponResource = buildResource({ code: "new_weapon_node" });
      const getMonsters = vi.fn(() =>
        okAsync({ data: [monster], page: 1, pages: 1, size: 50, total: 1 }),
      );
      // Every mocked action's cooldown expires exactly at (not after) the
      // frozen fake "now" below, so withCooldown's wait resolves
      // immediately for each of the several sequential agent actions this
      // test's full gather-then-equip pipeline needs (move, gather, equip)
      // - unlike other tests here, which only ever reach a single action.
      const rest = vi.fn(() =>
        okAsync({
          data: {
            character: buildLeveledCharacter(),
            cooldown: buildCooldown("2024-01-01T00:00:00.000Z"),
            hp_restored: 169,
          },
        }),
      );
      const getItems = vi.fn((query?: { type?: string }) =>
        okAsync({
          data: query?.type === "weapon" ? [newWeapon] : [],
          page: 1,
          pages: 1,
          size: 100,
          total: query?.type === "weapon" ? 1 : 0,
        }),
      );
      const getItem = vi.fn(() => okAsync({ data: newWeapon }));
      const getBankItems = vi.fn(() =>
        okAsync({ data: [], page: 1, pages: 1, size: 50, total: 0 }),
      );
      const getResources = vi.fn(() =>
        okAsync({ data: [newWeaponResource], page: 1, pages: 1, size: 50, total: 1 }),
      );
      const getMaps = vi.fn((query?: { content_type?: string }) =>
        okAsync({
          data: [{ ...({} as MapSchema), map_id: query?.content_type === "monster" ? 1 : 2 }],
          page: 1,
          pages: 1,
          size: 50,
          total: 1,
        }),
      );
      const moveCharacter = vi.fn(() =>
        okAsync({
          data: {
            character: buildLeveledCharacter(),
            cooldown: buildCooldown("2024-01-01T00:00:00.000Z"),
            destination: { ...({} as MapSchema), map_id: 2 },
            path: [],
          },
        }),
      );
      const gather = vi.fn(() => {
        held.set("new_weapon", (held.get("new_weapon") ?? 0) + 1);
        return okAsync({
          data: {
            character: buildLeveledCharacter(),
            cooldown: buildCooldown("2024-01-01T00:00:00.000Z"),
            details: { items: [], xp: 1 },
          },
        });
      });
      const equip = vi.fn(() =>
        okAsync({
          data: {
            character: buildLeveledCharacter(),
            cooldown: buildCooldown("2024-01-01T00:00:00.000Z"),
            items: [],
          },
        }),
      );
      const client = buildFakeClient({
        equip,
        gather,
        getBankItems,
        getCharacter: () =>
          okAsync({
            data: buildCombatCharacter({
              attack_earth: 20,
              hp: 1,
              level: 4,
              map_id: 1,
              max_hp: 170,
              weapon_slot: "",
            }),
          }),
        getItem,
        getItems,
        getMaps,
        getMonsters,
        getResources,
        moveCharacter,
        rest,
      });

      void runTask(client, "Cartman", { type: "autoHunt" });

      await vi.advanceTimersByTimeAsync(0);
      expect(equip).toHaveBeenCalledWith("Cartman", [
        { code: "new_weapon", quantity: 1, slot: "weapon" },
      ]);
    });

    it("does not equip a worthwhile-looking upgrade at level-up when its material can't be traced to any resource/monster", async () => {
      const character = buildCombatCharacter({
        attack_earth: 20,
        hp: 1,
        level: 4,
        map_id: 1,
        max_hp: 170,
        weapon_slot: "",
      });
      const monster = buildMonster({ code: "chicken", hp: 60, level: 1 });
      const newWeapon = buildItem({
        code: "new_weapon",
        effects: [{ code: "attack_earth", description: "", value: 30 }],
        type: "weapon",
      });
      const getMonsters = vi.fn((query?: { drop?: string }) =>
        okAsync({
          data: query?.drop === undefined ? [monster] : [],
          page: 1,
          pages: 1,
          size: 50,
          total: query?.drop === undefined ? 1 : 0,
        }),
      );
      const rest = vi.fn(() =>
        okAsync({
          data: {
            character: buildCombatCharacter({
              attack_earth: 20,
              hp: 170,
              level: 5,
              map_id: 1,
              max_hp: 170,
              weapon_slot: "",
            }),
            cooldown: buildCooldown("2024-01-01T00:00:03.000Z"),
            hp_restored: 169,
          },
        }),
      );
      const getItems = vi.fn((query?: { type?: string }) =>
        okAsync({
          data: query?.type === "weapon" ? [newWeapon] : [],
          page: 1,
          pages: 1,
          size: 100,
          total: query?.type === "weapon" ? 1 : 0,
        }),
      );
      const getItem = vi.fn(() => okAsync({ data: newWeapon }));
      const getBankItems = vi.fn(() =>
        okAsync({ data: [], page: 1, pages: 1, size: 50, total: 0 }),
      );
      const getResources = vi.fn(() =>
        okAsync({ data: [], page: 1, pages: 1, size: 50, total: 0 }),
      );
      const equip = vi.fn();
      const getMaps = vi.fn(() => errAsync(new ArtifactsApiError("boom", 500, undefined)));
      const client = buildFakeClient({
        equip,
        getBankItems,
        getCharacter: () => okAsync({ data: character }),
        getItem,
        getItems,
        getMaps,
        getMonsters,
        getResources,
        rest,
      });

      void runTask(client, "Cartman", { type: "autoHunt" });

      await vi.advanceTimersByTimeAsync(0);
      expect(getBankItems).toHaveBeenCalledWith({ item_code: "new_weapon" });
      expect(equip).not.toHaveBeenCalled();
    });

    it("re-checks every combat slot once a tracked profession-level block is cleared, even without a character level-up", async () => {
      const monster = buildMonster({ code: "chicken", hp: 60, level: 1 });
      const blockedWeapon = buildItem({
        code: "blocked_weapon",
        craft: {
          items: [{ code: "iron_ore", quantity: 1 }],
          level: 5,
          quantity: 1,
          skill: "weaponcrafting",
        },
        type: "weapon",
      });
      const getMonsters = vi.fn(() =>
        okAsync({ data: [monster], page: 1, pages: 1, size: 50, total: 1 }),
      );
      const getItems = vi.fn((query?: { type?: string }) =>
        okAsync({
          data: query?.type === "weapon" ? [blockedWeapon] : [],
          page: 1,
          pages: 1,
          size: 100,
          total: query?.type === "weapon" ? 1 : 0,
        }),
      );
      const getItem = vi.fn((code: string) =>
        code === "blocked_weapon"
          ? okAsync({ data: blockedWeapon })
          : okAsync({ data: buildItem({ code }) }),
      );
      const getBankItems = vi.fn(() =>
        okAsync({ data: [], page: 1, pages: 1, size: 50, total: 0 }),
      );
      const getResources = vi.fn(() =>
        okAsync({
          data: [buildResource({ code: "iron_rocks" })],
          page: 1,
          pages: 1,
          size: 50,
          total: 1,
        }),
      );
      const getMaps = vi.fn(() => errAsync(new ArtifactsApiError("boom", 500, undefined)));
      let weaponcraftingLevel = 0;
      // Always resolves with hp low enough that restIfLow keeps calling
      // rest() every cycle - deliberately, so this mock's response (and so
      // weaponcraftingLevel) is re-read on cycle 2 too, simulating the
      // profession leveling up "off-screen" between checks.
      const rest = vi.fn(() =>
        okAsync({
          data: {
            character: buildCombatCharacter({
              attack_earth: 20,
              hp: 1,
              level: 4,
              max_hp: 170,
              weapon_slot: "",
              weaponcrafting_level: weaponcraftingLevel,
            }),
            cooldown: buildCooldown("2024-01-01T00:00:00.000Z"),
            hp_restored: 0,
          },
        }),
      );
      const client = buildFakeClient({
        getBankItems,
        getCharacter: () =>
          okAsync({
            data: buildCombatCharacter({
              attack_earth: 20,
              hp: 1,
              level: 4,
              max_hp: 170,
              weapon_slot: "",
              weaponcrafting_level: 0,
            }),
          }),
        getItem,
        getItems,
        getMaps,
        getMonsters,
        getResources,
        rest,
      });

      void runTask(client, "Cartman", { type: "autoHunt" });

      // Cycle 1: first-cycle full scan hits InsufficientCraftingLevelError
      // for the weapon slot (weaponcrafting_level 0 < 5) and records it as a
      // pending unlock. The hunting cycle itself then fails (getMaps
      // errors), so runForever waits its retry delay before cycle 2.
      await vi.advanceTimersByTimeAsync(0);
      const weaponChecksInCycle1 = getItems.mock.calls.filter(([q]) => q?.type === "weapon").length;
      expect(weaponChecksInCycle1).toBe(1);

      getItems.mockClear();
      weaponcraftingLevel = 5; // the character's profession leveled up "off-screen"

      await vi.advanceTimersByTimeAsync(10_000);
      const sortStrings = (a: string | undefined, b: string | undefined) =>
        (a ?? "").localeCompare(b ?? "");
      const queriedTypesCycle2 = getItems.mock.calls.map(([q]) => q?.type).sort(sortStrings);
      expect(queriedTypesCycle2).toEqual(
        ["amulet", "body_armor", "boots", "helmet", "leg_armor", "ring", "shield", "weapon"].sort(
          sortStrings,
        ),
      );
    });

    it("crafts only a small capped batch from bank surplus for profession xp, not the full theoretical amount", async () => {
      const held = new Map<string, number>();
      const buildLeveledCharacter = (): CharacterSnapshot =>
        buildCombatCharacter({
          attack_earth: 20,
          hp: 170,
          inventory: [...held.entries()].map(([code, quantity], index) => ({
            code,
            quantity,
            slot: index,
          })),
          level: 5,
          map_id: 1,
          max_hp: 170,
          mining_level: 5,
          weapon_slot: "",
          weaponcrafting_level: 0,
        });
      const monster = buildMonster({ code: "chicken", hp: 60, level: 1 });
      const blockedWeapon = buildItem({
        code: "blocked_weapon",
        craft: {
          items: [{ code: "iron_ore", quantity: 1 }],
          level: 5,
          quantity: 1,
          skill: "weaponcrafting",
        },
        type: "weapon",
      });
      const copperBar = buildItem({
        code: "copper_bar",
        craft: {
          items: [{ code: "copper_ore", quantity: 10 }],
          level: 1,
          quantity: 1,
          skill: "mining",
        },
        type: "resource",
      });
      const ironBar = buildItem({
        code: "iron_bar",
        craft: {
          items: [{ code: "iron_ore", quantity: 10 }],
          level: 1,
          quantity: 1,
          skill: "mining",
        },
        type: "resource",
      });
      const getMonsters = vi.fn(() =>
        okAsync({ data: [monster], page: 1, pages: 1, size: 50, total: 1 }),
      );
      const rest = vi.fn(() =>
        okAsync({
          data: {
            character: buildLeveledCharacter(),
            cooldown: buildCooldown("2024-01-01T00:00:00.000Z"),
            hp_restored: 169,
          },
        }),
      );
      const getItems = vi.fn((query?: { type?: string }) =>
        okAsync({
          data: query?.type === "weapon" ? [blockedWeapon] : [],
          page: 1,
          pages: 1,
          size: 100,
          total: query?.type === "weapon" ? 1 : 0,
        }),
      );
      const getItem = vi.fn((code: string) => {
        if (code === "copper_bar") {
          return okAsync({ data: copperBar });
        }
        if (code === "iron_bar") {
          return okAsync({ data: ironBar });
        }
        if (code === "blocked_weapon") {
          return okAsync({ data: blockedWeapon });
        }
        // Every other code (iron_ore, copper_ore, ...) is a plain raw
        // material with no craft recipe of its own.
        return okAsync({ data: buildItem({ code }) });
      });
      const getBankItems = vi.fn((query?: { item_code?: string }) => {
        if (query?.item_code === undefined) {
          return okAsync({
            data: [
              { code: "copper_ore", quantity: 1_560 },
              { code: "iron_ore", quantity: 1_560 },
            ],
            page: 1,
            pages: 1,
            size: 100,
            total: 2,
          });
        }
        if (query.item_code === "copper_ore" || query.item_code === "iron_ore") {
          return okAsync({
            data: [{ code: query.item_code, quantity: 1_560 }],
            page: 1,
            pages: 1,
            size: 50,
            total: 1,
          });
        }
        return okAsync({ data: [], page: 1, pages: 1, size: 50, total: 0 });
      });
      const getItemsForSurplus = vi.fn((query?: { craft_material?: string; type?: string }) => {
        if (query?.craft_material === "copper_ore") {
          return okAsync({ data: [copperBar], page: 1, pages: 1, size: 100, total: 1 });
        }
        if (query?.craft_material === "iron_ore") {
          return okAsync({ data: [ironBar], page: 1, pages: 1, size: 100, total: 1 });
        }
        return getItems(query);
      });
      const getResources = vi.fn(() =>
        okAsync({
          data: [buildResource({ code: "iron_rocks" })],
          page: 1,
          pages: 1,
          size: 50,
          total: 1,
        }),
      );
      const getMaps = vi.fn(() =>
        okAsync({
          data: [{ ...({} as MapSchema), map_id: 2 }],
          page: 1,
          pages: 1,
          size: 50,
          total: 1,
        }),
      );
      const moveCharacter = vi.fn(() =>
        okAsync({
          data: {
            character: buildLeveledCharacter(),
            cooldown: buildCooldown("2024-01-01T00:00:00.000Z"),
            destination: { ...({} as MapSchema), map_id: 2 },
            path: [],
          },
        }),
      );
      const withdrawItems = vi.fn((_name: string, items: { code: string; quantity: number }[]) => {
        for (const item of items) {
          held.set(item.code, (held.get(item.code) ?? 0) + item.quantity);
        }
        return okAsync({
          data: {
            bank: [],
            character: buildLeveledCharacter(),
            cooldown: buildCooldown("2024-01-01T00:00:00.000Z"),
            items: [],
          },
        });
      });
      const craft = vi.fn((_name: string, code: string, quantity = 1) => {
        const materialCode = code === "iron_bar" ? "iron_ore" : "copper_ore";
        held.set(materialCode, (held.get(materialCode) ?? 0) - 10 * quantity);
        held.set(code, (held.get(code) ?? 0) + quantity);
        return okAsync({
          data: {
            character: buildLeveledCharacter(),
            cooldown: buildCooldown("2024-01-01T00:00:00.000Z"),
            details: { items: [], xp: 1 },
          },
        });
      });
      const client = buildFakeClient({
        craft,
        getBankItems,
        getCharacter: () =>
          okAsync({
            data: buildCombatCharacter({
              attack_earth: 20,
              hp: 1,
              level: 4,
              map_id: 1,
              max_hp: 170,
              mining_level: 5,
              weapon_slot: "",
              weaponcrafting_level: 0,
            }),
          }),
        getItem,
        getItems: getItemsForSurplus,
        getMaps,
        getMonsters,
        getResources,
        moveCharacter,
        rest,
        withdrawItems,
      });

      void runTask(client, "Cartman", { type: "autoHunt" });

      await vi.advanceTimersByTimeAsync(0);
      expect(craft).toHaveBeenCalledWith("Cartman", "copper_bar", 5);
      expect(craft).not.toHaveBeenCalledWith("Cartman", "copper_bar", 156);
      expect(craft).not.toHaveBeenCalledWith("Cartman", "iron_bar", 5);
    });
  });
});
