import { describe, expect, it } from "vitest";

import {
  createConfiguredResourceReplenishmentPlanner,
  GoalResourceNotResolvedError,
} from "../src/bot/orchestration/configuredResourceReplenishment.js";
import type { CrewSnapshot } from "../src/bot/orchestration/crewSnapshot.js";
import type {
  OrchestratorState,
  ReplenishBankItemGoal,
} from "../src/bot/orchestration/orchestratorState.js";
import {
  InvalidResourceTargetError,
  type Resource,
} from "../src/bot/orchestration/resourceReplenishment.js";
import type { components } from "../src/client/schema.js";

type Character = components["schemas"]["CharacterSchema"];

const buildCharacter = (name: string): Character => ({
  ...({} as Character),
  mining_level: 10,
  name,
  woodcutting_level: 10,
});

const buildGoal = (id: string, itemCode: string): ReplenishBankItemGoal => ({
  id,
  itemCode,
  minimumBankQuantity: 50,
  type: "replenishBankItem",
});

const buildResource = (code: string, itemCode: string, skill: Resource["skill"]): Resource => ({
  code,
  drops: [{ code: itemCode, max_quantity: 1, min_quantity: 1, rate: 1 }],
  level: 1,
  name: code,
  skill,
});

const copperGoal = buildGoal("goal-copper", "copper_ore");
const ashGoal = buildGoal("goal-ash", "ash_wood");
const copperResource = buildResource("copper_rocks", "copper_ore", "mining");
const ashResource = buildResource("ash_tree", "ash_wood", "woodcutting");

const buildState = (goals = [copperGoal, ashGoal]): OrchestratorState => ({
  goals,
  reservations: [],
});

const buildSnapshot = (bank: CrewSnapshot["bank"] = []): CrewSnapshot => ({
  bank,
  capturedAt: "2026-07-15T12:00:00.000Z",
  characters: [buildCharacter("Stan")],
});

const buildPlanner = () =>
  createConfiguredResourceReplenishmentPlanner([
    { goalId: copperGoal.id, resource: copperResource },
    { goalId: ashGoal.id, resource: ashResource },
  ]);

describe("createConfiguredResourceReplenishmentPlanner", () => {
  it("uses the resource resolved for the highest-priority Goal", () => {
    const result = buildPlanner()(buildSnapshot(), buildState());

    expect(result.isOk() && result.value.activities).toEqual([
      {
        activity: { resourceCode: "copper_rocks", type: "farmResource" },
        characterName: "Stan",
        consumes: [],
        goalId: "goal-copper",
        produces: [{ itemCode: "copper_ore" }],
      },
    ]);
  });

  it("skips a satisfied Goal and plans the next one from the same snapshot", () => {
    const result = buildPlanner()(
      buildSnapshot([{ code: "copper_ore", quantity: 50 }]),
      buildState(),
    );

    expect(result.isOk() && result.value).toEqual({
      activities: [
        {
          activity: { resourceCode: "ash_tree", type: "farmResource" },
          characterName: "Stan",
          consumes: [],
          goalId: "goal-ash",
          produces: [{ itemCode: "ash_wood" }],
        },
      ],
      state: { goals: [ashGoal], reservations: [] },
    });
  });

  it("uses different idle characters for simultaneous Goals", () => {
    const snapshot = {
      ...buildSnapshot(),
      characters: [buildCharacter("Stan"), buildCharacter("Cartman")],
    };

    const result = buildPlanner()(snapshot, buildState());

    expect(result.isOk() && result.value).toEqual({
      activities: [
        {
          activity: { resourceCode: "copper_rocks", type: "farmResource" },
          characterName: "Cartman",
          consumes: [],
          goalId: "goal-copper",
          produces: [{ itemCode: "copper_ore" }],
        },
        {
          activity: { resourceCode: "ash_tree", type: "farmResource" },
          characterName: "Stan",
          consumes: [],
          goalId: "goal-ash",
          produces: [{ itemCode: "ash_wood" }],
        },
      ],
      state: buildState(),
    });
  });

  it("continues to lower-priority Goals while a higher-priority Goal is reserved", () => {
    const copperReservation = {
      activity: { resourceCode: "copper_rocks", type: "farmResource" as const },
      characterName: "Stan",
      consumes: [],
      goalId: "goal-copper",
      produces: [{ itemCode: "copper_ore" }],
    };
    const state = {
      goals: [copperGoal, ashGoal],
      reservations: [copperReservation],
    };
    const snapshot = {
      ...buildSnapshot(),
      characters: [buildCharacter("Stan"), buildCharacter("Cartman")],
    };

    const result = buildPlanner()(snapshot, state);

    expect(result.isOk() && result.value).toEqual({
      activities: [
        {
          activity: { resourceCode: "ash_tree", type: "farmResource" },
          characterName: "Cartman",
          consumes: [],
          goalId: "goal-ash",
          produces: [{ itemCode: "ash_wood" }],
        },
      ],
      state,
    });
  });

  it("removes every satisfied Goal without proposing work", () => {
    const result = buildPlanner()(
      buildSnapshot([
        { code: "ash_wood", quantity: 50 },
        { code: "copper_ore", quantity: 50 },
      ]),
      buildState(),
    );

    expect(result.isOk() && result.value).toEqual({
      activities: [],
      state: { goals: [], reservations: [] },
    });
  });

  it("does not skip an unsatisfied Goal when no Activity can start yet", () => {
    const reservation = {
      activity: { monsterCode: "yellow_slime", type: "huntMonster" as const },
      characterName: "Stan",
      consumes: [],
      goalId: "another-goal",
      produces: [],
    };
    const state = { goals: [copperGoal], reservations: [reservation] };
    const result = buildPlanner()(buildSnapshot(), state);

    expect(result.isOk() && result.value).toEqual({ activities: [], state });
  });

  it("propagates a resource validation failure", () => {
    const planner = createConfiguredResourceReplenishmentPlanner([
      { goalId: copperGoal.id, resource: ashResource },
    ]);

    const result = planner(buildSnapshot(), buildState([copperGoal]));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(
      new InvalidResourceTargetError("ash_tree does not drop copper_ore"),
    );
  });

  it("returns a typed error when a Goal has no resolved resource", () => {
    const planner = createConfiguredResourceReplenishmentPlanner([]);

    const result = planner(buildSnapshot(), buildState([copperGoal]));

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(GoalResourceNotResolvedError);
    expect(error).toMatchObject({
      goalId: "goal-copper",
      message: 'No resource was resolved for Goal "goal-copper"',
      name: "GoalResourceNotResolvedError",
    });
  });

  it("returns an unchanged empty plan when no Goals remain", () => {
    const state = buildState([]);

    expect(buildPlanner()(buildSnapshot(), state)._unsafeUnwrap()).toEqual({
      activities: [],
      state,
    });
  });
});
