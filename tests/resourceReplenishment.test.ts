import { describe, expect, it } from "vitest";

import type { CrewSnapshot } from "../src/bot/orchestration/crewSnapshot.js";
import type {
  OrchestratorState,
  ReplenishBankItemGoal,
  Reservation,
} from "../src/bot/orchestration/orchestratorState.js";
import {
  InvalidResourceTargetError,
  NoEligibleGathererError,
  planResourceReplenishment,
  type Resource,
} from "../src/bot/orchestration/resourceReplenishment.js";
import type { components } from "../src/client/schema.js";

type Character = components["schemas"]["CharacterSchema"];

const buildCharacter = (name: string, overrides: Partial<Character> = {}): Character => ({
  ...({} as Character),
  name,
  ...overrides,
});

const buildGoal = (overrides: Partial<ReplenishBankItemGoal> = {}): ReplenishBankItemGoal => ({
  id: "replenish-copper",
  itemCode: "copper_ore",
  minimumBankQuantity: 50,
  type: "replenishBankItem",
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
  characters: [
    buildCharacter("Cartman", { mining_level: 3 }),
    buildCharacter("Stan", { mining_level: 7 }),
  ],
  ...overrides,
});

const buildState = (overrides: Partial<OrchestratorState> = {}): OrchestratorState => ({
  goals: [buildGoal()],
  reservations: [],
  ...overrides,
});

const buildReservation = (overrides: Partial<Reservation> = {}): Reservation => ({
  activity: { monsterCode: "yellow_slime", type: "huntMonster" },
  characterName: "Cartman",
  consumes: [],
  goalId: "combat-progression",
  produces: [],
  ...overrides,
});

describe("planResourceReplenishment", () => {
  it("proposes one farming Activity for the strongest eligible idle gatherer", () => {
    const snapshot = buildSnapshot();
    const state = buildState();

    const result = planResourceReplenishment(snapshot, state, buildResource());

    expect(result.isOk() && result.value).toEqual({
      activities: [
        {
          activity: { resourceCode: "copper_rocks", type: "farmResource" },
          characterName: "Stan",
          consumes: [],
          goalId: "replenish-copper",
          produces: [{ itemCode: "copper_ore" }],
        },
      ],
      state,
    });
    expect(snapshot).toEqual(buildSnapshot());
    expect(state).toEqual(buildState());
  });

  it("ignores unrelated bank items when evaluating the target", () => {
    const snapshot = buildSnapshot({ bank: [{ code: "iron_ore", quantity: 50 }] });

    const result = planResourceReplenishment(snapshot, buildState(), buildResource());

    expect(result.isOk() && result.value.activities).toHaveLength(1);
  });

  it("removes a satisfied highest-priority Goal without planning another one", () => {
    const nextGoal = buildGoal({ id: "replenish-iron", itemCode: "iron_ore" });
    const state = buildState({ goals: [buildGoal(), nextGoal] });
    const snapshot = buildSnapshot({
      bank: [
        { code: "copper_ore", quantity: 20 },
        { code: "copper_ore", quantity: 30 },
      ],
    });

    const result = planResourceReplenishment(snapshot, state, buildResource());

    expect(result.isOk() && result.value).toEqual({
      activities: [],
      state: {
        goals: [nextGoal],
        reservations: [],
      },
    });
  });

  it("keeps an active Goal reserved even when its target is now satisfied", () => {
    const reservation = buildReservation({
      activity: { resourceCode: "copper_rocks", type: "farmResource" },
      characterName: "Stan",
      goalId: "replenish-copper",
      produces: [{ itemCode: "copper_ore" }],
    });
    const state = buildState({ reservations: [reservation] });
    const snapshot = buildSnapshot({ bank: [{ code: "copper_ore", quantity: 50 }] });

    const result = planResourceReplenishment(snapshot, state, buildResource());

    expect(result.isOk() && result.value).toEqual({ activities: [], state });
  });

  it("does not duplicate work for a Goal that already has a Reservation", () => {
    const reservation = buildReservation({
      activity: { resourceCode: "copper_rocks", type: "farmResource" },
      characterName: "Cartman",
      goalId: "replenish-copper",
      produces: [{ itemCode: "copper_ore" }],
    });
    const state = buildState({ reservations: [reservation] });

    const result = planResourceReplenishment(buildSnapshot(), state, buildResource());

    expect(result.isOk() && result.value).toEqual({ activities: [], state });
  });

  it("excludes characters reserved by other Goals", () => {
    const state = buildState({ reservations: [buildReservation({ characterName: "Stan" })] });

    const result = planResourceReplenishment(buildSnapshot(), state, buildResource());

    expect(result.isOk() && result.value.activities).toEqual([
      {
        activity: { resourceCode: "copper_rocks", type: "farmResource" },
        characterName: "Cartman",
        consumes: [],
        goalId: "replenish-copper",
        produces: [{ itemCode: "copper_ore" }],
      },
    ]);
  });

  it("waits when every eligible gatherer is currently reserved", () => {
    const state = buildState({
      reservations: [
        buildReservation({ characterName: "Cartman" }),
        buildReservation({ characterName: "Stan", goalId: "another-goal" }),
      ],
    });

    const result = planResourceReplenishment(buildSnapshot(), state, buildResource());

    expect(result.isOk() && result.value).toEqual({ activities: [], state });
  });

  it("uses the character name as a deterministic tie-breaker", () => {
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter("Stan", { mining_level: 5 }),
        buildCharacter("Cartman", { mining_level: 5 }),
        buildCharacter("Kyle", { mining_level: 5 }),
      ],
    });

    const result = planResourceReplenishment(snapshot, buildState(), buildResource());

    expect(result.isOk() && result.value.activities[0]?.characterName).toBe("Cartman");
  });

  it("reports when no character has the required gathering level", () => {
    const snapshot = buildSnapshot({
      characters: [buildCharacter("Cartman", { mining_level: 3 })],
    });

    const result = planResourceReplenishment(snapshot, buildState(), buildResource({ level: 5 }));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(
      new NoEligibleGathererError("copper_rocks", "mining", 5),
    );
  });

  it("rejects a non-positive bank target", () => {
    const result = planResourceReplenishment(
      buildSnapshot(),
      buildState({ goals: [buildGoal({ minimumBankQuantity: 0 })] }),
      buildResource(),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(
      new InvalidResourceTargetError("minimumBankQuantity must be greater than zero"),
    );
  });

  it("completes an already satisfied Goal without validating an unused resource", () => {
    const state = buildState();
    const snapshot = buildSnapshot({ bank: [{ code: "copper_ore", quantity: 50 }] });

    const result = planResourceReplenishment(
      snapshot,
      state,
      buildResource({
        drops: [{ code: "iron_ore", max_quantity: 1, min_quantity: 1, rate: 1 }],
      }),
    );

    expect(result.isOk() && result.value).toEqual({
      activities: [],
      state: { goals: [], reservations: [] },
    });
  });

  it("accepts a matching drop among other resource drops", () => {
    const resource = buildResource({
      drops: [
        { code: "iron_ore", max_quantity: 1, min_quantity: 1, rate: 1 },
        { code: "copper_ore", max_quantity: 1, min_quantity: 1, rate: 1 },
      ],
    });

    const result = planResourceReplenishment(buildSnapshot(), buildState(), resource);

    expect(result.isOk() && result.value.activities).toHaveLength(1);
  });

  it("rejects a resource that cannot produce the targeted bank item", () => {
    const result = planResourceReplenishment(
      buildSnapshot(),
      buildState(),
      buildResource({
        drops: [{ code: "iron_ore", max_quantity: 1, min_quantity: 1, rate: 1 }],
      }),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(
      new InvalidResourceTargetError("copper_rocks does not drop copper_ore"),
    );
  });

  it("does nothing when there are no Goals", () => {
    const state = buildState({ goals: [] });

    const result = planResourceReplenishment(buildSnapshot(), state, buildResource());

    expect(result.isOk() && result.value).toEqual({ activities: [], state });
  });
});
