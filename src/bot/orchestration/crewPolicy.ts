import { err, ok, type Result } from 'neverthrow';

import type { Task, TaskAssignment } from '../tasks/task.js';

import type { CrewSnapshot } from './crewSnapshot.js';
import {
  findBestGatherer,
  InvalidResourceTargetError,
  NoEligibleGathererError,
  type Resource,
  type ResourceReplenishmentError,
} from './resourceReplenishment.js';

export { InvalidResourceTargetError, NoEligibleGathererError };
export type { ResourceReplenishmentError };

type Character = CrewSnapshot['characters'][number];

export type CrewDecisionContext = Readonly<{
  character: Character;
  snapshot: CrewSnapshot;
}>;

export type CrewPolicy = (context: CrewDecisionContext) => Task;

export type ResourceReplenishmentTarget = Readonly<{
  itemCode: string;
  minimumBankQuantity: number;
  resource: Resource;
}>;

/**
 * Safe baseline while richer cross-character priorities are still being
 * designed. It preserves the current combat-progression behavior rather than
 * inventing gathering thresholds or bank targets without evidence.
 */
export const continueCombatProgression: CrewPolicy = () => ({
  type: 'autoHunt',
});

/**
 * Applies one pure policy to every character in a shared account snapshot. The
 * policy receives the whole snapshot, so later decisions may coordinate around
 * bank needs and the other characters without changing this producer. No task
 * is started here: the result is only a proposed desired state for the existing
 * task supervisor to consume in a later slice.
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

/**
 * Proposes one temporary fixed-resource farming assignment when the shared bank
 * is below an explicit target. Everyone else keeps the conservative
 * combat-progression baseline. Re-evaluating after a bank deposit naturally
 * returns the selected gatherer to `autoHunt` once the threshold is reached.
 */
export const proposeResourceReplenishment = (
  snapshot: CrewSnapshot,
  target: ResourceReplenishmentTarget,
): Result<readonly TaskAssignment[], ResourceReplenishmentError> => {
  if (target.minimumBankQuantity <= 0) {
    return err(
      new InvalidResourceTargetError(
        'minimumBankQuantity must be greater than zero',
      ),
    );
  }

  if (!target.resource.drops.some((drop) => drop.code === target.itemCode)) {
    return err(
      new InvalidResourceTargetError(
        `${target.resource.code} does not drop ${target.itemCode}`,
      ),
    );
  }

  if (bankQuantity(snapshot, target.itemCode) >= target.minimumBankQuantity) {
    return ok(proposeCrewAssignments(snapshot));
  }

  const gatherer = findBestGatherer(snapshot, target.resource);

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
        ? { resource: target.resource.code, type: 'farm' }
        : continueCombatProgression({ character, snapshot }),
    ),
  );
};
