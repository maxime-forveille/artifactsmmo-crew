import { describe, expect, it, vi } from "vitest";

import {
  continueCombatProgression,
  proposeCrewAssignments,
  type CrewPolicy,
} from "../src/bot/crewPolicy.js";
import type { CrewSnapshot } from "../src/bot/crewSnapshot.js";
import type { components } from "../src/client/schema.js";

type Character = components["schemas"]["CharacterSchema"];

const buildCharacter = (name: string): Character => ({ ...({} as Character), name });

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
