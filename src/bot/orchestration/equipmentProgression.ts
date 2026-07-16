import { err, ok, type Result } from "neverthrow";

import type { components } from "../../client/schema.js";
import type { CraftItemActivity, EquipItemActivity } from "../activities/activity.js";
import { EQUIP_SLOT_BY_ITEM_TYPE, equippedItemInSlot } from "../gear.js";
import { heldQuantity } from "../inventory.js";
import type { CrewSnapshot } from "./crewSnapshot.js";
import type { ActivityAssignment, OrchestratorState } from "./orchestratorState.js";

type Item = Readonly<components["schemas"]["ItemSchema"]>;
type EquipmentActivity = CraftItemActivity | EquipItemActivity;

export type EquipmentProgressionPlan = Readonly<{
  activities: readonly ActivityAssignment<EquipmentActivity>[];
  state: OrchestratorState;
}>;

export type PreviousActivityOutcome = Readonly<{
  event: Readonly<{
    goalId: string;
    type: "blocked" | "cancelled" | "completed";
  }>;
}>;

export class EquipmentCharacterNotFoundError extends Error {
  constructor(public readonly characterName: string) {
    super(`Character "${characterName}" does not exist in the Crew Snapshot`);
    this.name = "EquipmentCharacterNotFoundError";
  }
}

export class InvalidEquipmentTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEquipmentTargetError";
  }
}

export type EquipmentProgressionError =
  | EquipmentCharacterNotFoundError
  | InvalidEquipmentTargetError;

const bankQuantity = (snapshot: CrewSnapshot, itemCode: string): number =>
  snapshot.bank
    .filter((item) => item.code === itemCode)
    .reduce((total, item) => total + item.quantity, 0);

const unchangedPlan = (state: OrchestratorState): EquipmentProgressionPlan => ({
  activities: [],
  state,
});

/**
 * Advances one explicit equipment Goal by one bounded step. A blocked step is
 * left idle for the next planner layer to turn into prerequisite Goals.
 */
export const planEquipmentProgression = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  item: Item,
  previousOutcome?: PreviousActivityOutcome,
): Result<EquipmentProgressionPlan, EquipmentProgressionError> => {
  const goal = state.goals[0];

  if (goal === undefined || goal.type !== "equipItem") {
    return ok(unchangedPlan(state));
  }

  if (item.code !== goal.itemCode) {
    return err(
      new InvalidEquipmentTargetError(
        `Resolved item ${item.code} does not match equipment Goal target ${goal.itemCode}`,
      ),
    );
  }

  const slot = EQUIP_SLOT_BY_ITEM_TYPE[item.type];

  if (slot === undefined) {
    return err(
      new InvalidEquipmentTargetError(
        `Item ${item.code} has unsupported equipment type ${item.type}`,
      ),
    );
  }

  const character = snapshot.characters.find((candidate) => candidate.name === goal.characterName);

  if (character === undefined) {
    return err(new EquipmentCharacterNotFoundError(goal.characterName));
  }

  if (equippedItemInSlot(character, slot) === item.code) {
    return ok({
      activities: [],
      state: {
        goals: state.goals.filter((candidate) => candidate.id !== goal.id),
        reservations: state.reservations,
      },
    });
  }

  if (
    state.reservations.some(
      (reservation) =>
        reservation.goalId === goal.id || reservation.characterName === goal.characterName,
    )
  ) {
    return ok(unchangedPlan(state));
  }

  if (previousOutcome?.event.type === "blocked" && previousOutcome.event.goalId === goal.id) {
    return ok(unchangedPlan(state));
  }

  const isHeld = heldQuantity(character, item.code) > 0;
  const isBanked = bankQuantity(snapshot, item.code) > 0;
  const shouldCraft = !isHeld && !isBanked && item.craft?.skill !== undefined;
  const activity: EquipmentActivity = shouldCraft
    ? { itemCode: item.code, quantity: 1, type: "craftItem" }
    : { itemCode: item.code, type: "equipItem" };

  return ok({
    activities: [
      {
        activity,
        characterName: character.name,
        consumes: activity.type === "equipItem" ? [{ itemCode: item.code }] : [],
        goalId: goal.id,
        produces: activity.type === "craftItem" ? [{ itemCode: item.code }] : [],
      },
    ],
    state,
  });
};
