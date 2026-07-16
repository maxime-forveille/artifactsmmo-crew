import type { GoalRule } from './goalPolicy.js';
import type { ReachCombatLevelGoal } from './orchestratorState.js';

export const createReachCombatLevelGoalId = (
  characterName: string,
  targetLevel: number,
): string => `reachCombatLevel:${characterName}:${targetLevel}`;

const createReachCombatLevelGoal = (
  characterName: string,
  targetLevel: number,
): ReachCombatLevelGoal => ({
  characterName,
  id: createReachCombatLevelGoalId(characterName, targetLevel),
  targetLevel,
  type: 'reachCombatLevel',
});

/** Discovers the next finite combat-level milestone for every character. */
export const proposeCombatProgressionGoals: GoalRule = ({ snapshot }) =>
  snapshot.characters.map((character) => {
    const targetLevel = character.level + 1;

    return {
      goal: createReachCombatLevelGoal(character.name, targetLevel),
      reason: `${character.name} can progress from combat level ${character.level} to ${targetLevel}`,
      utility: 1,
    };
  });
