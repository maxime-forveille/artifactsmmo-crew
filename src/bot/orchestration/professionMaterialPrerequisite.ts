import type { components } from '../../client/schema.js';
import { heldQuantity } from '../inventory.js';
import { craftSkillLevel } from '../progression.js';

import type { CrewSnapshot } from './crewSnapshot.js';
import type { GoalProposal } from './goalPolicy.js';
import type {
  OrchestratorState,
  ProduceItemGoal,
  ReachProfessionLevelGoal,
  ReplenishBankItemGoal,
} from './orchestratorState.js';
import { findBestProfessionRecipe } from './professionProgression.js';
import { reservedBankWithdrawalQuantity } from './reservationIntents.js';
import { findBestGatherer } from './resourceReplenishment.js';
import type { WorldKnowledge } from './worldKnowledge.js';

type Character = CrewSnapshot['characters'][number];
type Item = WorldKnowledge['items'][number];
type Monster = WorldKnowledge['monsters'][number];
type Resource = WorldKnowledge['resources'][number];
type SimpleItem = Readonly<components['schemas']['SimpleItemSchema']>;
type RecipeItem = Item &
  Readonly<{
    craft: NonNullable<Item['craft']> &
      Readonly<{ items: readonly SimpleItem[] }>;
  }>;

type GatherPrerequisite = Readonly<{
  itemCode: string;
  kind: 'gather';
  missingQuantity: number;
  recipe: RecipeItem;
  resource: Resource;
}>;

type MonsterPrerequisite = Readonly<{
  itemCode: string;
  kind: 'monster';
  missingQuantity: number;
  monster: Monster;
  recipe: RecipeItem;
}>;

type CraftPrerequisite = Readonly<{
  itemCode: string;
  kind: 'craft';
  missingQuantity: number;
  producedItem: RecipeItem;
  recipe: RecipeItem;
}>;

type MaterialPrerequisite =
  | CraftPrerequisite
  | GatherPrerequisite
  | MonsterPrerequisite;

export const createReplenishBankItemGoalId = (
  itemCode: string,
  minimumBankQuantity: number,
): string => `replenishBankItem:${itemCode}:${minimumBankQuantity}`;

export const createProduceItemGoalId = (
  itemCode: string,
  minimumBankQuantity: number,
): string => `produceItem:${itemCode}:${minimumBankQuantity}`;

const bankQuantity = (snapshot: CrewSnapshot, itemCode: string): number =>
  snapshot.bank
    .filter((item) => item.code === itemCode)
    .reduce((total, item) => total + item.quantity, 0);

const availableBankQuantity = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  itemCode: string,
): number =>
  Math.max(
    bankQuantity(snapshot, itemCode) -
      reservedBankWithdrawalQuantity(state, itemCode),
    0,
  );

const isEligibleRecipe = (
  item: Item,
  goal: ReachProfessionLevelGoal,
  currentLevel: number,
): item is RecipeItem =>
  item.craft?.skill === goal.skill &&
  (item.craft.level ?? 0) <= currentLevel &&
  item.craft.items !== undefined &&
  item.craft.items.length > 0;

const isDirectlySupported = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  character: Character,
  materials: readonly SimpleItem[],
): boolean =>
  materials.every((material) => {
    const missingQuantity = Math.max(
      material.quantity - heldQuantity(character, material.code),
      0,
    );

    return (
      missingQuantity === 0 ||
      availableBankQuantity(snapshot, state, material.code) >= missingQuantity
    );
  });

const uniqueGatheringSource = (
  knowledge: WorldKnowledge,
  itemCode: string,
): Resource | undefined => {
  const resources = knowledge.resources.filter((resource) =>
    resource.drops.some((drop) => drop.code === itemCode),
  );
  const monsterSourceCount = knowledge.monsters.filter((monster) =>
    monster.drops.some((drop) => drop.code === itemCode),
  ).length;

  return resources.length === 1 && monsterSourceCount === 0
    ? resources[0]
    : undefined;
};

const uniqueMonsterSource = (
  knowledge: WorldKnowledge,
  itemCode: string,
): Monster | undefined => {
  const resourceSourceCount = knowledge.resources.filter((resource) =>
    resource.drops.some((drop) => drop.code === itemCode),
  ).length;
  const monsters = knowledge.monsters.filter((monster) =>
    monster.drops.some((drop) => drop.code === itemCode),
  );

  return monsters.length === 1 && resourceSourceCount === 0
    ? monsters[0]
    : undefined;
};

const isRecipeItem = (item: Item): item is RecipeItem =>
  item.craft?.items !== undefined && item.craft.items.length > 0;

const asRecipeItem = (item: Item): RecipeItem | undefined =>
  isRecipeItem(item) ? item : undefined;

const findMaterialPrerequisite = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  character: Character,
  goal: ReachProfessionLevelGoal,
  knowledge: WorldKnowledge,
): MaterialPrerequisite | undefined => {
  const currentLevel = craftSkillLevel(character, goal.skill);
  const itemsByCode = new Map(
    knowledge.items.map((item) => [item.code, item] as const),
  );
  const recipes = knowledge.items
    .filter((item) => isEligibleRecipe(item, goal, currentLevel))
    .toSorted(
      (left, right) =>
        (right.craft.level ?? 0) - (left.craft.level ?? 0) ||
        left.code.localeCompare(right.code),
    );

  for (const recipe of recipes) {
    for (const material of recipe.craft.items) {
      const missingQuantity = Math.max(
        material.quantity - heldQuantity(character, material.code),
        0,
      );

      if (
        missingQuantity === 0 ||
        availableBankQuantity(snapshot, state, material.code) >= missingQuantity
      ) {
        continue;
      }

      const item = itemsByCode.get(material.code);
      if (item === undefined) {
        continue;
      }

      const producedItem = asRecipeItem(item);
      if (
        producedItem !== undefined &&
        isDirectlySupported(
          snapshot,
          state,
          character,
          producedItem.craft.items,
        )
      ) {
        return {
          itemCode: material.code,
          kind: 'craft',
          missingQuantity,
          producedItem,
          recipe,
        };
      }

      if (item.craft?.skill !== undefined) {
        continue;
      }

      const resource = uniqueGatheringSource(knowledge, material.code);
      if (
        resource !== undefined &&
        findBestGatherer(snapshot, resource) !== undefined
      ) {
        return {
          itemCode: material.code,
          kind: 'gather',
          missingQuantity,
          recipe,
          resource,
        };
      }

      const monster = uniqueMonsterSource(knowledge, material.code);
      if (monster !== undefined) {
        return {
          itemCode: material.code,
          kind: 'monster',
          missingQuantity,
          monster,
          recipe,
        };
      }
    }
  }

  return undefined;
};

const createReplenishmentGoal = (
  itemCode: string,
  minimumBankQuantity: number,
  source: Pick<ReplenishBankItemGoal, 'monsterCode' | 'resourceCode'>,
): ReplenishBankItemGoal => ({
  id: createReplenishBankItemGoalId(itemCode, minimumBankQuantity),
  itemCode,
  minimumBankQuantity,
  ...source,
  type: 'replenishBankItem',
});

const createProductionGoal = (
  itemCode: string,
  minimumBankQuantity: number,
): ProduceItemGoal => ({
  id: createProduceItemGoalId(itemCode, minimumBankQuantity),
  itemCode,
  minimumBankQuantity,
  type: 'produceItem',
});

/**
 * Proposes one raw-material or intermediate-craft prerequisite for a blocked
 * profession Goal.
 */
export const proposeProfessionMaterialPrerequisite = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  knowledge: WorldKnowledge,
): readonly GoalProposal[] => {
  const goal = state.goals.find(
    (candidate): candidate is typeof candidate & ReachProfessionLevelGoal =>
      candidate.type === 'reachProfessionLevel',
  );

  if (goal === undefined) {
    return [];
  }

  const character = snapshot.characters.find(
    (candidate) => candidate.name === goal.characterName,
  );
  if (
    character === undefined ||
    craftSkillLevel(character, goal.skill) >= goal.targetLevel ||
    state.reservations.some(
      (reservation) =>
        reservation.goalId === goal.id ||
        reservation.characterName === goal.characterName,
    ) ||
    findBestProfessionRecipe(snapshot, state, character, goal, knowledge) !==
      undefined
  ) {
    return [];
  }

  const prerequisite = findMaterialPrerequisite(
    snapshot,
    state,
    character,
    goal,
    knowledge,
  );
  if (prerequisite === undefined) {
    return [];
  }

  if (prerequisite.kind === 'craft') {
    return [
      {
        configuredRank: -1,
        goal: createProductionGoal(
          prerequisite.itemCode,
          prerequisite.missingQuantity,
        ),
        parentGoalId: goal.id,
        reason: `${goal.characterName} needs ${prerequisite.missingQuantity}x ${prerequisite.itemCode} crafted to craft ${prerequisite.recipe.code} for ${goal.skill} XP`,
        rule: 'professionProgression',
      },
    ];
  }

  if (prerequisite.kind === 'gather') {
    return [
      {
        configuredRank: -1,
        goal: createReplenishmentGoal(
          prerequisite.itemCode,
          prerequisite.missingQuantity,
          { resourceCode: prerequisite.resource.code },
        ),
        parentGoalId: goal.id,
        reason: `${goal.characterName} needs ${prerequisite.missingQuantity}x ${prerequisite.itemCode} from ${prerequisite.resource.code} to craft ${prerequisite.recipe.code} for ${goal.skill} XP`,
        rule: 'professionProgression',
      },
    ];
  }

  return [
    {
      configuredRank: -1,
      goal: createReplenishmentGoal(
        prerequisite.itemCode,
        prerequisite.missingQuantity,
        { monsterCode: prerequisite.monster.code },
      ),
      parentGoalId: goal.id,
      reason: `${goal.characterName} needs ${prerequisite.missingQuantity}x ${prerequisite.itemCode} from ${prerequisite.monster.code} to craft ${prerequisite.recipe.code} for ${goal.skill} XP`,
      rule: 'professionProgression',
    },
  ];
};
