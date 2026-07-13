import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";

import {
  findNextFarmableResource,
  findNextSafeMonster,
  skillLevel,
} from "../src/bot/progression.js";
import { ArtifactsApiError } from "../src/client/index.js";
import type { ArtifactsClient } from "../src/client/index.js";
import type { components } from "../src/client/schema.js";

type Character = components["schemas"]["CharacterSchema"];
type Log = components["schemas"]["LogSchema"];
type LogPage = components["schemas"]["DataPage_LogSchema_"];
type Monster = components["schemas"]["MonsterSchema"];
type MonsterPage = components["schemas"]["StaticDataPage_MonsterSchema_"];
type Resource = components["schemas"]["ResourceSchema"];
type ResourcePage = components["schemas"]["StaticDataPage_ResourceSchema_"];

const buildCharacter = (overrides: Partial<Character> = {}): Character =>
  ({
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
    hp: 150,
    level: 4,
    name: "Cartman",
    res_air: 0,
    res_earth: 0,
    res_fire: 0,
    res_water: 0,
    ...overrides,
  }) as Character;

const buildMonster = (overrides: Partial<Monster> = {}): Monster =>
  ({
    attack_air: 0,
    attack_earth: 0,
    attack_fire: 0,
    attack_water: 4,
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

const buildMonsterPage = (data: Monster[]): MonsterPage => ({
  data,
  page: 1,
  pages: 1,
  size: 50,
  total: data.length,
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

const buildResourcePage = (data: Resource[]): ResourcePage => ({
  data,
  page: 1,
  pages: 1,
  size: 50,
  total: data.length,
});

const buildFightLog = (opponent: string, xp: number, cooldownSeconds: number): Log =>
  ({
    content: { fight: { characters: [{ character_name: "Cartman", xp }], opponent } },
    cooldown: cooldownSeconds,
    type: "fight",
  }) as unknown as Log;

const buildLogPage = (data: Log[]): LogPage => ({
  data,
  page: 1,
  pages: 1,
  size: 100,
  total: data.length,
});

const noLogs = () => okAsync(buildLogPage([]));

describe("findNextSafeMonster", () => {
  it("picks the highest-level monster that's still safe when there's no fight history", async () => {
    const character = buildCharacter();
    const weak = buildMonster({ code: "chicken", hp: 60, level: 1 });
    // Both safe for this character (attack_earth 20, hp 150); the level 2
    // one should win over the level 1 one.
    const safeAndStronger = buildMonster({ code: "yellow_slime", hp: 70, level: 2 });
    const getMonsters = vi.fn(() => okAsync(buildMonsterPage([weak, safeAndStronger])));
    const getCharacterLogs = noLogs;

    const result = await findNextSafeMonster({ getCharacterLogs, getMonsters }, character);

    expect(getMonsters).toHaveBeenCalledWith({ max_level: character.level });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()?.code).toBe("yellow_slime");
  });

  it("prefers the safe monster with the best observed XP/second rate over a higher level one", async () => {
    const character = buildCharacter();
    // Lower level, but the fight history shows it pays off much faster.
    const fastXp = buildMonster({ code: "chicken", hp: 60, level: 1 });
    const slowerButHigherLevel = buildMonster({ code: "yellow_slime", hp: 70, level: 2 });
    const getMonsters = vi.fn(() => okAsync(buildMonsterPage([fastXp, slowerButHigherLevel])));
    const getCharacterLogs = vi.fn(() =>
      okAsync(
        buildLogPage([
          buildFightLog("chicken", 6, 10), // 0.6 xp/s
          buildFightLog("yellow_slime", 11, 46), // ~0.24 xp/s
        ]),
      ),
    );

    const result = await findNextSafeMonster({ getCharacterLogs, getMonsters }, character);

    expect(getCharacterLogs).toHaveBeenCalledWith("Cartman", { size: 100 });
    expect(result._unsafeUnwrap()?.code).toBe("chicken");
  });

  it("falls back to the highest-level heuristic for monsters with no observed rate yet", async () => {
    const character = buildCharacter();
    const weak = buildMonster({ code: "chicken", hp: 60, level: 1 });
    const safeAndStronger = buildMonster({ code: "yellow_slime", hp: 70, level: 2 });
    const getMonsters = vi.fn(() => okAsync(buildMonsterPage([weak, safeAndStronger])));
    // History only covers a monster that isn't even a candidate here.
    const getCharacterLogs = vi.fn(() => okAsync(buildLogPage([buildFightLog("cow", 50, 40)])));

    const result = await findNextSafeMonster({ getCharacterLogs, getMonsters }, character);

    expect(result._unsafeUnwrap()?.code).toBe("yellow_slime");
  });

  it("degrades to the highest-level heuristic when the log lookup fails", async () => {
    const character = buildCharacter();
    const weak = buildMonster({ code: "chicken", hp: 60, level: 1 });
    const safeAndStronger = buildMonster({ code: "yellow_slime", hp: 70, level: 2 });
    const getMonsters = vi.fn(() => okAsync(buildMonsterPage([weak, safeAndStronger])));
    const getCharacterLogs = vi.fn(() => errAsync(new ArtifactsApiError("boom", 500, undefined)));

    const result = await findNextSafeMonster({ getCharacterLogs, getMonsters }, character);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()?.code).toBe("yellow_slime");
  });

  it("skips monsters that aren't safe, even if higher level", async () => {
    const character = buildCharacter();
    const safe = buildMonster({ code: "chicken", hp: 60, level: 1 });
    // Way too tanky/hard-hitting for this character to be worth it.
    const unsafe = buildMonster({
      attack_earth: 100,
      code: "cow",
      hp: 2_000,
      level: 8,
    });
    const getMonsters = vi.fn(() => okAsync(buildMonsterPage([safe, unsafe])));

    const result = await findNextSafeMonster({ getCharacterLogs: noLogs, getMonsters }, character);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()?.code).toBe("chicken");
  });

  it("returns undefined when no monster is safe", async () => {
    const character = buildCharacter({ attack_earth: 1, hp: 10 });
    const unsafe = buildMonster({ attack_earth: 100, code: "cow", hp: 2_000, level: 8 });
    const getMonsters = vi.fn(() => okAsync(buildMonsterPage([unsafe])));

    const result = await findNextSafeMonster({ getCharacterLogs: noLogs, getMonsters }, character);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeUndefined();
  });

  it("propagates a getMonsters failure without swallowing it", async () => {
    const apiError = new ArtifactsApiError("boom", 500, undefined);
    const getMonsters = vi.fn(() => errAsync(apiError));

    const result = await findNextSafeMonster(
      { getCharacterLogs: noLogs, getMonsters } as Pick<
        ArtifactsClient,
        "getCharacterLogs" | "getMonsters"
      >,
      buildCharacter(),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(apiError);
  });
});

describe("skillLevel", () => {
  it("reads the character field matching each gathering skill", () => {
    const character = buildCharacter({
      alchemy_level: 3,
      fishing_level: 2,
      mining_level: 8,
      woodcutting_level: 5,
    });

    expect(skillLevel(character, "mining")).toBe(8);
    expect(skillLevel(character, "woodcutting")).toBe(5);
    expect(skillLevel(character, "fishing")).toBe(2);
    expect(skillLevel(character, "alchemy")).toBe(3);
  });
});

describe("findNextFarmableResource", () => {
  it("picks the highest-level resource at or below the character's skill level", async () => {
    const character = buildCharacter({ mining_level: 8 });
    const low = buildResource({ code: "copper_rocks", level: 1, skill: "mining" });
    const high = buildResource({ code: "iron_rocks", level: 8, skill: "mining" });
    const getResources = vi.fn(() => okAsync(buildResourcePage([low, high])));

    const result = await findNextFarmableResource({ getResources }, character, "mining");

    expect(getResources).toHaveBeenCalledWith({ max_level: 8, skill: "mining" });
    expect(result._unsafeUnwrap()?.code).toBe("iron_rocks");
  });

  it("returns undefined when no resource matches", async () => {
    const character = buildCharacter({ mining_level: 1 });
    const getResources = vi.fn(() => okAsync(buildResourcePage([])));

    const result = await findNextFarmableResource({ getResources }, character, "mining");

    expect(result._unsafeUnwrap()).toBeUndefined();
  });

  it("propagates a getResources failure", async () => {
    const apiError = new ArtifactsApiError("boom", 500, undefined);
    const getResources = vi.fn(() => errAsync(apiError));

    const result = await findNextFarmableResource({ getResources }, buildCharacter(), "mining");

    expect(result._unsafeUnwrapErr()).toBe(apiError);
  });
});
