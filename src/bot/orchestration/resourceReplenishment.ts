import { err, ok, type Result } from "neverthrow";

import type { components } from "../../client/schema.js";
import type { CrewSnapshot } from "./crewSnapshot.js";
import type {
  ActivityAssignment,
  OrchestratorState,
  ReplenishBankItemGoal,
} from "./orchestratorState.js";
import { skillLevel } from "../progression.js";

export type Resource = Readonly<components["schemas"]["ResourceSchema"]>;
type Character = CrewSnapshot["characters"][number];

export class InvalidResourceTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidResourceTargetError";
  }
}

export class NoEligibleGathererError extends Error {
  constructor(
    public readonly resourceCode: string,
    public readonly skill: Resource["skill"],
    public readonly requiredLevel: number,
  ) {
    super(`No character can gather ${resourceCode}: ${skill} level ${requiredLevel} is required`);
    this.name = "NoEligibleGathererError";
  }
}

export type ResourceReplenishmentError = InvalidResourceTargetError | NoEligibleGathererError;

export type ResourceReplenishmentPlan = Readonly<{
  activities: readonly ActivityAssignment[];
  state: OrchestratorState;
}>;

const bankQuantity = (snapshot: CrewSnapshot, itemCode: string): number =>
  snapshot.bank
    .filter((item) => item.code === itemCode)
    .reduce((total, item) => total + item.quantity, 0);

export const findBestGatherer = (
  snapshot: CrewSnapshot,
  resource: Resource,
  excludedCharacterNames: ReadonlySet<string> = new Set(),
): Character | undefined =>
  snapshot.characters
    .filter(
      (character) =>
        !excludedCharacterNames.has(character.name) &&
        skillLevel(character, resource.skill) >= resource.level,
    )
    .reduce<Character | undefined>((best, character) => {
      if (best === undefined) {
        return character;
      }

      const level = skillLevel(character, resource.skill);
      const bestLevel = skillLevel(best, resource.skill);

      if (level !== bestLevel) {
        return level > bestLevel ? character : best;
      }

      return character.name.localeCompare(best.name) < 0 ? character : best;
    }, undefined);

const unchangedPlan = (state: OrchestratorState): ResourceReplenishmentPlan => ({
  activities: [],
  state,
});

const validateGoal = (goal: ReplenishBankItemGoal): Result<void, InvalidResourceTargetError> =>
  goal.minimumBankQuantity > 0
    ? ok(undefined)
    : err(new InvalidResourceTargetError("minimumBankQuantity must be greater than zero"));

const validateResource = (
  goal: ReplenishBankItemGoal,
  resource: Resource,
): Result<void, InvalidResourceTargetError> =>
  resource.drops.some((drop) => drop.code === goal.itemCode)
    ? ok(undefined)
    : err(new InvalidResourceTargetError(`${resource.code} does not drop ${goal.itemCode}`));

/**
 * Proposes at most one farming Activity for the highest-priority bank Goal.
 * Existing Reservations remain authoritative until their Activities finish,
 * even when another character has already satisfied the target. The runtime
 * adds a Reservation only after the proposed Activity starts successfully.
 */
export const planResourceReplenishment = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  resource: Resource,
): Result<ResourceReplenishmentPlan, ResourceReplenishmentError> => {
  const goal = state.goals[0];

  if (goal === undefined) {
    return ok(unchangedPlan(state));
  }

  const goalValidation = validateGoal(goal);

  if (goalValidation.isErr()) {
    return err(goalValidation.error);
  }

  if (state.reservations.some((reservation) => reservation.goalId === goal.id)) {
    return ok(unchangedPlan(state));
  }

  if (bankQuantity(snapshot, goal.itemCode) >= goal.minimumBankQuantity) {
    return ok({
      activities: [],
      state: {
        goals: state.goals.slice(1),
        reservations: state.reservations,
      },
    });
  }

  const resourceValidation = validateResource(goal, resource);

  if (resourceValidation.isErr()) {
    return err(resourceValidation.error);
  }

  const eligibleGatherer = findBestGatherer(snapshot, resource);

  if (eligibleGatherer === undefined) {
    return err(new NoEligibleGathererError(resource.code, resource.skill, resource.level));
  }

  const reservedCharacterNames = new Set(
    state.reservations.map((reservation) => reservation.characterName),
  );
  const gatherer = findBestGatherer(snapshot, resource, reservedCharacterNames);

  if (gatherer === undefined) {
    return ok(unchangedPlan(state));
  }

  const activity = {
    resourceCode: resource.code,
    type: "farmResource" as const,
  };
  const assignment = {
    activity,
    characterName: gatherer.name,
    consumes: [],
    goalId: goal.id,
    produces: [{ itemCode: goal.itemCode }],
  };

  return ok({
    activities: [assignment],
    state,
  });
};
