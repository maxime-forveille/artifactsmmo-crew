import { err, ok, type Result } from "neverthrow";

import type { components } from "../../client/schema.js";
import type { TaskAssignment } from "../../utils/taskAssignments.js";
import type { CrewSnapshot } from "./crewSnapshot.js";
import { skillLevel } from "../progression.js";
import type { Task } from "../tasks/task.js";

type Character = CrewSnapshot["characters"][number];

export type CrewDecisionContext = Readonly<{
  character: Character;
  snapshot: CrewSnapshot;
}>;

export type CrewPolicy = (context: CrewDecisionContext) => Task;

type Resource = Readonly<components["schemas"]["ResourceSchema"]>;

export type ResourceReplenishmentTarget = Readonly<{
  itemCode: string;
  minimumBankQuantity: number;
  resource: Resource;
}>;

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

/**
 * Safe baseline while richer cross-character priorities are still being
 * designed. It preserves the current combat-progression behavior rather than
 * inventing gathering thresholds or bank targets without evidence.
 */
export const continueCombatProgression: CrewPolicy = () => ({ type: "autoHunt" });

/**
 * Applies one pure policy to every character in a shared account snapshot.
 * The policy receives the whole snapshot, so later decisions may coordinate
 * around bank needs and the other characters without changing this producer.
 * No task is started here: the result is only a proposed desired state for
 * the existing task supervisor to consume in a later slice.
 */
export const proposeCrewAssignments = (
  snapshot: CrewSnapshot,
  policy: CrewPolicy = continueCombatProgression,
): readonly TaskAssignment[] =>
  snapshot.characters.map((character) => ({
    character: character.name,
    task: policy({ character, snapshot }),
  }));

const bankQuantity = (snapshot: CrewSnapshot, itemCode: string): number =>
  snapshot.bank
    .filter((item) => item.code === itemCode)
    .reduce((total, item) => total + item.quantity, 0);

const bestGatherer = (snapshot: CrewSnapshot, resource: Resource): Character | undefined =>
  snapshot.characters
    .filter((character) => skillLevel(character, resource.skill) >= resource.level)
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

/**
 * Proposes one temporary fixed-resource farming assignment when the shared
 * bank is below an explicit target. Everyone else keeps the conservative
 * combat-progression baseline. Re-evaluating after a bank deposit naturally
 * returns the selected gatherer to `autoHunt` once the threshold is reached.
 */
export const proposeResourceReplenishment = (
  snapshot: CrewSnapshot,
  target: ResourceReplenishmentTarget,
): Result<readonly TaskAssignment[], ResourceReplenishmentError> => {
  if (target.minimumBankQuantity <= 0) {
    return err(new InvalidResourceTargetError("minimumBankQuantity must be greater than zero"));
  }

  if (!target.resource.drops.some((drop) => drop.code === target.itemCode)) {
    return err(
      new InvalidResourceTargetError(`${target.resource.code} does not drop ${target.itemCode}`),
    );
  }

  if (bankQuantity(snapshot, target.itemCode) >= target.minimumBankQuantity) {
    return ok(proposeCrewAssignments(snapshot));
  }

  const gatherer = bestGatherer(snapshot, target.resource);

  if (gatherer === undefined) {
    return err(
      new NoEligibleGathererError(
        target.resource.code,
        target.resource.skill,
        target.resource.level,
      ),
    );
  }

  return ok(
    proposeCrewAssignments(snapshot, ({ character }) =>
      character.name === gatherer.name
        ? { resource: target.resource.code, type: "farm" }
        : continueCombatProgression({ character, snapshot }),
    ),
  );
};
