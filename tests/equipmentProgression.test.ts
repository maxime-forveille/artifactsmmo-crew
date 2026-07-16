import { describe, expect, it } from "vitest";

import {
  EquipmentCharacterNotFoundError,
  InvalidEquipmentTargetError,
  planEquipmentProgression,
} from "../src/bot/orchestration/equipmentProgression.js";
import type { CrewSnapshot } from "../src/bot/orchestration/crewSnapshot.js";
import type {
  EquipItemGoal,
  OrchestratorState,
  Reservation,
} from "../src/bot/orchestration/orchestratorState.js";
import type { components } from "../src/client/schema.js";

type Character = components["schemas"]["CharacterSchema"];
type Item = components["schemas"]["ItemSchema"];

const buildGoal = (overrides: Partial<EquipItemGoal> = {}): EquipItemGoal => ({
  characterName: "Stan",
  id: "equip-stan-dagger",
  itemCode: "copper_dagger",
  type: "equipItem",
  ...overrides,
});

const buildCharacter = (overrides: Partial<Character> = {}): Character => ({
  ...({} as Character),
  inventory: [],
  level: 5,
  name: "Stan",
  weapon_slot: "wooden_stick",
  ...overrides,
});

const buildItem = (overrides: Partial<Item> = {}): Item => ({
  ...({} as Item),
  code: "copper_dagger",
  craft: {
    items: [{ code: "copper_bar", quantity: 2 }],
    level: 5,
    quantity: 1,
    skill: "weaponcrafting",
  },
  level: 5,
  type: "weapon",
  ...overrides,
});

const buildSnapshot = (overrides: Partial<CrewSnapshot> = {}): CrewSnapshot => ({
  bank: [],
  capturedAt: "2026-07-16T12:00:00.000Z",
  characters: [buildCharacter()],
  ...overrides,
});

const buildState = (overrides: Partial<OrchestratorState> = {}): OrchestratorState => ({
  goals: [buildGoal()],
  reservations: [],
  ...overrides,
});

const buildReservation = (overrides: Partial<Reservation> = {}): Reservation => ({
  activity: { monsterCode: "yellow_slime", type: "huntMonster" },
  characterName: "Stan",
  consumes: [],
  goalId: "another-goal",
  produces: [],
  ...overrides,
});

describe("planEquipmentProgression", () => {
  it("completes the Goal when the target is already equipped", () => {
    const nextGoal = buildGoal({ characterName: "Kyle", id: "next-goal" });
    const state = buildState({ goals: [buildGoal(), nextGoal] });
    const snapshot = buildSnapshot({
      characters: [buildCharacter({ weapon_slot: "copper_dagger" })],
    });

    const result = planEquipmentProgression(snapshot, state, buildItem());

    expect(result._unsafeUnwrap()).toEqual({
      activities: [],
      state: { goals: [nextGoal], reservations: [] },
    });
  });

  it("equips the target when the character already holds it", () => {
    const state = buildState();
    const snapshot = buildSnapshot({
      characters: [
        buildCharacter({
          inventory: [{ code: "copper_dagger", quantity: 1, slot: 1 }],
        }),
      ],
    });

    const result = planEquipmentProgression(snapshot, state, buildItem());

    expect(result._unsafeUnwrap()).toEqual({
      activities: [
        {
          activity: { itemCode: "copper_dagger", type: "equipItem" },
          characterName: "Stan",
          consumes: [{ itemCode: "copper_dagger" }],
          goalId: "equip-stan-dagger",
          produces: [],
        },
      ],
      state,
    });
  });

  it("crafts one target when it is absent and craftable", () => {
    const state = buildState();

    const result = planEquipmentProgression(buildSnapshot(), state, buildItem());

    expect(result._unsafeUnwrap()).toEqual({
      activities: [
        {
          activity: { itemCode: "copper_dagger", quantity: 1, type: "craftItem" },
          characterName: "Stan",
          consumes: [],
          goalId: "equip-stan-dagger",
          produces: [{ itemCode: "copper_dagger" }],
        },
      ],
      state,
    });
  });

  it("does not craft a duplicate target that is already in the bank", () => {
    const result = planEquipmentProgression(
      buildSnapshot({ bank: [{ code: "copper_dagger", quantity: 1 }] }),
      buildState(),
      buildItem(),
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: "copper_dagger",
      type: "equipItem",
    });
  });

  it("ignores unrelated bank items when deciding whether to craft", () => {
    const result = planEquipmentProgression(
      buildSnapshot({ bank: [{ code: "iron_ore", quantity: 100 }] }),
      buildState(),
      buildItem(),
    );

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: "copper_dagger",
      quantity: 1,
      type: "craftItem",
    });
  });

  it("uses equip to expose a missing-item Blocker for a non-craftable target", () => {
    const item = buildItem();
    delete item.craft;

    const result = planEquipmentProgression(buildSnapshot(), buildState(), item);

    expect(result._unsafeUnwrap().activities[0]?.activity).toEqual({
      itemCode: "copper_dagger",
      type: "equipItem",
    });
  });

  it("waits after its previous Activity returned a Blocker", () => {
    const state = buildState();
    const result = planEquipmentProgression(buildSnapshot(), state, buildItem(), {
      event: { goalId: "equip-stan-dagger", type: "blocked" },
    });

    expect(result._unsafeUnwrap()).toEqual({ activities: [], state });
  });

  it("continues when the previous Blocker belongs to another Goal", () => {
    const result = planEquipmentProgression(buildSnapshot(), buildState(), buildItem(), {
      event: { goalId: "another-goal", type: "blocked" },
    });

    expect(result._unsafeUnwrap().activities).toHaveLength(1);
  });

  it("waits while the Goal already has a Reservation", () => {
    const reservation = buildReservation({
      characterName: "Kyle",
      goalId: "equip-stan-dagger",
    });
    const state = buildState({ reservations: [reservation] });

    expect(planEquipmentProgression(buildSnapshot(), state, buildItem())._unsafeUnwrap()).toEqual({
      activities: [],
      state,
    });
  });

  it("waits while the target character works on another Goal", () => {
    const reservation = buildReservation();
    const state = buildState({ reservations: [reservation] });

    expect(planEquipmentProgression(buildSnapshot(), state, buildItem())._unsafeUnwrap()).toEqual({
      activities: [],
      state,
    });
  });

  it("continues when an unrelated character is reserved for another Goal", () => {
    const reservation = buildReservation({ characterName: "Kyle" });
    const state = buildState({ reservations: [reservation] });

    expect(
      planEquipmentProgression(buildSnapshot(), state, buildItem())._unsafeUnwrap().activities,
    ).toHaveLength(1);
  });

  it("returns a typed error when the configured character is absent", () => {
    const result = planEquipmentProgression(
      buildSnapshot({ characters: [buildCharacter({ name: "Kyle" })] }),
      buildState(),
      buildItem(),
    );

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(EquipmentCharacterNotFoundError);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      characterName: "Stan",
      message: 'Character "Stan" does not exist in the Crew Snapshot',
      name: "EquipmentCharacterNotFoundError",
    });
  });

  it("rejects an item resolved for a different target", () => {
    const result = planEquipmentProgression(
      buildSnapshot(),
      buildState(),
      buildItem({ code: "wooden_staff" }),
    );

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidEquipmentTargetError);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      message: "Resolved item wooden_staff does not match equipment Goal target copper_dagger",
      name: "InvalidEquipmentTargetError",
    });
  });

  it("rejects a target whose item type has no supported slot", () => {
    const result = planEquipmentProgression(
      buildSnapshot(),
      buildState(),
      buildItem({ type: "artifact" }),
    );

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidEquipmentTargetError);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      message: "Item copper_dagger has unsupported equipment type artifact",
      name: "InvalidEquipmentTargetError",
    });
  });

  it("does nothing when no Goals remain", () => {
    const state = buildState({ goals: [] });

    expect(planEquipmentProgression(buildSnapshot(), state, buildItem())._unsafeUnwrap()).toEqual({
      activities: [],
      state,
    });
  });

  it("does nothing when the first Goal is not an equipment Goal", () => {
    const state: OrchestratorState = {
      goals: [
        {
          id: "replenish-copper",
          itemCode: "copper_ore",
          minimumBankQuantity: 50,
          type: "replenishBankItem",
        },
      ],
      reservations: [],
    };

    expect(planEquipmentProgression(buildSnapshot(), state, buildItem())._unsafeUnwrap()).toEqual({
      activities: [],
      state,
    });
  });
});
