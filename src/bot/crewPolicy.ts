import type { TaskAssignment } from "../utils/taskAssignments.js";
import type { CrewSnapshot } from "./crewSnapshot.js";
import type { Task } from "./tasks/task.js";

type Character = CrewSnapshot["characters"][number];

export type CrewDecisionContext = Readonly<{
  character: Character;
  snapshot: CrewSnapshot;
}>;

export type CrewPolicy = (context: CrewDecisionContext) => Task;

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
