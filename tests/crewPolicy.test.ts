import { describe, expect, it, vi } from "vitest";

import {
  continueCombatProgression,
  InvalidResourceTargetError,
  NoEligibleGathererError,
  proposeCrewAssignments,
  proposeResourceReplenishment,
  type CrewPolicy,
} from "../src/bot/orchestration/crewPolicy.js";
import type { CrewSnapshot } from "../src/bot/orchestration/crewSnapshot.js";
import type { components } from "../src/client/schema.js";

type Character = components["schemas"]["CharacterSchema"];
type Resource = components["schemas"]["ResourceSchema"];

const buildCharacter = (name: string, overrides: Partial<Character> = {}): Character => ({
  ...({} as Character),
  name,
  ...overrides,
});

const buildResource = (overrides: Partial<Resource> = {}): Resource => ({
  code: "copper_rocks",
  drops: [
    {
      code: "copper_ore",
      max_quantity: 1,
      min_quantity: 1,
      rate: 1,
    },
  ],
  level: 1,
  name: "Copper Rocks",
  skill: "mining",
  ...overrides,
});

const buildSnapshot = (overrides: Partial<CrewSnapshot> = {}): CrewSnapshot => ({
  bank: [],
  capturedAt: "2026-07-15T12:00:00.000Z",
  characters: [buildCharacter("Cartman"), buildCharacter("Stan")],
  ...overrides,
});

describe("proposeCrewAssignments", () => {
  it("keeps every character progressing through combat by default", () => {
    const result = proposeCrewAssignments(buildSnapshot());

    expect(result).toEqual([
      { character: "Cartman", task: { type: "autoHunt" } },
      { character: "Stan", task: { type: "autoHunt" } },
    ]);
  });

  it("gives the policy both the current character and the shared snapshot", () => {
    const snapshot = buildSnapshot({ bank: [{ code: "copper_ore", quantity: 0 }] });
    const policy: CrewPolicy = ({ character, snapshot: crew }) =>
      character.name === "Stan" && crew.bank[0]?.quantity === 0
        ? { skill: "mining", type: "autoFarm" }
        : { type: "autoHunt" };

    const result = proposeCrewAssignments(snapshot, policy);

    expect(result).toEqual([
      { character: "Cartman", task: { type: "autoHunt" } },
      { character: "Stan", task: { skill: "mining", type: "autoFarm" } },
    ]);
  });

  it("evaluates the policy exactly once per character", () => {
    const policy = vi.fn(continueCombatProgression);

    proposeCrewAssignments(buildSnapshot(), policy);

    expect(policy).toHaveBeenCalledTimes(2);
  });
});

describe("proposeResourceReplenishment", () => {
  it("assigns the strongest eligible gatherer to the exact resource", () => {
    const snapshot = buildSnapshot({
      bank: [
        { code: "copper_ore", quantity: 10 },
        { code: "iron_ore", quantity: 100 },
      ],
      characters: [
        buildCharacter("Cartman", { mining_level: 3 }),
        buildCharacter("Stan", { mining_level: 7 }),
        buildCharacter("Kenny", { mining_level: 4 }),
      ],
    });

    const result = proposeResourceReplenishment(snapshot, {
      itemCode: "copper_ore",
      minimumBankQuantity: 50,
      resource: buildResource({
        drops: [
          { code: "ash_wood", max_quantity: 1, min_quantity: 1, rate: 1 },
          { code: "copper_ore", max_quantity: 1, min_quantity: 1, rate: 1 },
        ],
      }),
    });

    expect(result.isOk() && result.value).toEqual([
      { character: "Cartman", task: { type: "autoHunt" } },
      { character: "Stan", task: { resource: "copper_rocks", type: "farm" } },
      { character: "Kenny", task: { type: "autoHunt" } },
    ]);
  });

  it("returns everyone to combat progression once the bank target is met", () => {
    const snapshot = buildSnapshot({
      bank: [
        { code: "copper_ore", quantity: 20 },
        { code: "copper_ore", quantity: 30 },
      ],
    });

    const result = proposeResourceReplenishment(snapshot, {
      itemCode: "copper_ore",
      minimumBankQuantity: 50,
      resource: buildResource(),
    });

    expect(result.isOk() && result.value).toEqual([
      { character: "Cartman", task: { type: "autoHunt" } },
      { character: "Stan", task: { type: "autoHunt" } },
    ]);
  });

  it("uses the character name as a deterministic tie-breaker", () => {
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter("Stan", { mining_level: 5 }),
        buildCharacter("Cartman", { mining_level: 5 }),
        buildCharacter("Kyle", { mining_level: 5 }),
      ],
    });

    const result = proposeResourceReplenishment(snapshot, {
      itemCode: "copper_ore",
      minimumBankQuantity: 50,
      resource: buildResource(),
    });

    expect(result.isOk() && result.value).toEqual([
      { character: "Stan", task: { type: "autoHunt" } },
      { character: "Cartman", task: { resource: "copper_rocks", type: "farm" } },
      { character: "Kyle", task: { type: "autoHunt" } },
    ]);
  });

  it("allows a character exactly at the resource's required level", () => {
    const snapshot = buildSnapshot({
      characters: [buildCharacter("Cartman", { mining_level: 1 })],
    });

    const result = proposeResourceReplenishment(snapshot, {
      itemCode: "copper_ore",
      minimumBankQuantity: 50,
      resource: buildResource({ level: 1 }),
    });

    expect(result.isOk() && result.value).toEqual([
      { character: "Cartman", task: { resource: "copper_rocks", type: "farm" } },
    ]);
  });

  it("reports when no character has the required gathering level", () => {
    const snapshot = buildSnapshot({
      characters: [buildCharacter("Cartman", { mining_level: 3 })],
    });

    const result = proposeResourceReplenishment(snapshot, {
      itemCode: "copper_ore",
      minimumBankQuantity: 50,
      resource: buildResource({ level: 5 }),
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toEqual(new NoEligibleGathererError("copper_rocks", "mining", 5));
    expect(error.message).toBe("No character can gather copper_rocks: mining level 5 is required");
    expect(error.name).toBe("NoEligibleGathererError");

    if (!(error instanceof NoEligibleGathererError)) {
      throw new Error("Expected NoEligibleGathererError");
    }

    expect(error.requiredLevel).toBe(5);
    expect(error.resourceCode).toBe("copper_rocks");
    expect(error.skill).toBe("mining");
  });

  it("rejects a non-positive bank target", () => {
    const result = proposeResourceReplenishment(buildSnapshot(), {
      itemCode: "copper_ore",
      minimumBankQuantity: 0,
      resource: buildResource(),
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toEqual(
      new InvalidResourceTargetError("minimumBankQuantity must be greater than zero"),
    );
    expect(error.name).toBe("InvalidResourceTargetError");
  });

  it("rejects a resource that cannot produce the targeted bank item", () => {
    const result = proposeResourceReplenishment(buildSnapshot(), {
      itemCode: "iron_ore",
      minimumBankQuantity: 50,
      resource: buildResource(),
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toEqual(new InvalidResourceTargetError("copper_rocks does not drop iron_ore"));
    expect(error.name).toBe("InvalidResourceTargetError");
  });
});
