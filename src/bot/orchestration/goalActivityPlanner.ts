import { err, ok, type Result } from 'neverthrow';

import type { components } from '../../client/schema.js';

import {
  planCombatProgression,
  type CombatProgressionError,
} from './combatProgression.js';
import type { CrewSnapshot } from './crewSnapshot.js';
import {
  planEquipmentProgression,
  type EquipmentMaterialSource,
  type EquipmentProgressionError,
  type PreviousActivityOutcome,
} from './equipmentProgression.js';
import {
  planItemProduction,
  type ItemProductionError,
} from './itemProduction.js';
import {
  planMonsterReplenishment,
  type Monster,
  type MonsterReplenishmentError,
} from './monsterReplenishment.js';
import type {
  ActivityAssignment,
  OrchestratorState,
  ReplenishBankItemGoal,
} from './orchestratorState.js';
import {
  planProfessionProgression,
  type ProfessionCharacterNotFoundError,
} from './professionProgression.js';
import { reservedBankWithdrawalQuantity } from './reservationIntents.js';
import {
  planResourceReplenishment,
  type Resource,
  type ResourceReplenishmentError,
} from './resourceReplenishment.js';
import type { WorldKnowledge } from './worldKnowledge.js';

type Item = Readonly<components['schemas']['ItemSchema']>;

type GoalActivityPlan = Readonly<{
  activities: readonly ActivityAssignment[];
  state: OrchestratorState;
}>;

export type EquipmentKnowledge = Readonly<{
  items: readonly Item[];
  sources: readonly EquipmentMaterialSource[];
}>;

export class GoalItemNotResolvedError extends Error {
  constructor(public readonly goalId: string) {
    super(`No item was resolved for Goal "${goalId}"`);
    this.name = 'GoalItemNotResolvedError';
  }
}

export class GoalMonsterNotResolvedError extends Error {
  constructor(public readonly goalId: string) {
    super(`No monster was resolved for Goal "${goalId}"`);
    this.name = 'GoalMonsterNotResolvedError';
  }
}

export class GoalResourceNotResolvedError extends Error {
  constructor(public readonly goalId: string) {
    super(`No resource was resolved for Goal "${goalId}"`);
    this.name = 'GoalResourceNotResolvedError';
  }
}

export type GoalActivityPlannerError =
  | CombatProgressionError
  | EquipmentProgressionError
  | GoalItemNotResolvedError
  | GoalMonsterNotResolvedError
  | GoalResourceNotResolvedError
  | ItemProductionError
  | MonsterReplenishmentError
  | ProfessionCharacterNotFoundError
  | ResourceReplenishmentError;

export type GoalActivityPlanner = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  previousOutcome?: PreviousActivityOutcome,
) => Result<GoalActivityPlan, GoalActivityPlannerError>;

const bankQuantity = (snapshot: CrewSnapshot, itemCode: string): number =>
  snapshot.bank
    .filter((item) => item.code === itemCode)
    .reduce((total, item) => total + item.quantity, 0);

const plannedBankWithdrawalQuantity = (
  activities: readonly ActivityAssignment[],
  itemCode: string,
): number =>
  activities.reduce(
    (total, assignment) =>
      assignment.activity.type === 'withdrawItem' &&
      assignment.activity.itemCode === itemCode
        ? total + assignment.activity.quantity
        : total,
    0,
  );

const isCompletedGoalStillSatisfied = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  activities: readonly ActivityAssignment[],
  goal: OrchestratorState['goals'][number],
): boolean => {
  if (goal.type !== 'replenishBankItem' || goal.origin === 'prerequisite') {
    return true;
  }

  const projectedQuantity = Math.max(
    bankQuantity(snapshot, goal.itemCode) -
      reservedBankWithdrawalQuantity(state, goal.itemCode) -
      plannedBankWithdrawalQuantity(activities, goal.itemCode),
    0,
  );

  return projectedQuantity >= goal.minimumBankQuantity;
};

const findUnique = <T>(values: readonly T[]): T | undefined =>
  values.length === 1 ? values[0] : undefined;

const resolveMonster = (
  knowledge: WorldKnowledge,
  goal: ReplenishBankItemGoal,
): Monster | undefined =>
  goal.monsterCode === undefined
    ? undefined
    : knowledge.monsters.find((monster) => monster.code === goal.monsterCode);

const resolveResource = (
  knowledge: WorldKnowledge,
  goal: ReplenishBankItemGoal,
): Resource | undefined =>
  goal.resourceCode === undefined
    ? findUnique(
        knowledge.resources.filter((resource) =>
          resource.drops.some((drop) => drop.code === goal.itemCode),
        ),
      )
    : knowledge.resources.find(
        (resource) => resource.code === goal.resourceCode,
      );

const resolveMaterialSource = (
  knowledge: WorldKnowledge,
  itemCode: string,
): EquipmentMaterialSource | undefined => {
  const sources: EquipmentMaterialSource[] = [
    ...knowledge.monsters
      .filter((monster) => monster.drops.some((drop) => drop.code === itemCode))
      .map((monster) => ({
        itemCode,
        source: { monster, type: 'monster' as const },
      })),
    ...knowledge.resources
      .filter((resource) =>
        resource.drops.some((drop) => drop.code === itemCode),
      )
      .map((resource) => ({
        itemCode,
        source: { resource, type: 'gather' as const },
      })),
  ];

  return findUnique(sources);
};

const mergeEquipmentKnowledge = (
  groups: readonly EquipmentKnowledge[],
): EquipmentKnowledge => ({
  items: [
    ...new Map(
      groups.flatMap((group) => group.items).map((item) => [item.code, item]),
    ).values(),
  ],
  sources: [
    ...new Map(
      groups
        .flatMap((group) => group.sources)
        .map((source) => [source.itemCode, source]),
    ).values(),
  ],
});

const resolveMaterialTree = (
  knowledge: WorldKnowledge,
  itemsByCode: ReadonlyMap<string, Item>,
  itemCode: string,
  ancestors: ReadonlySet<string>,
): EquipmentKnowledge => {
  if (ancestors.has(itemCode)) {
    return { items: [], sources: [] };
  }

  const item = itemsByCode.get(itemCode);
  if (item === undefined) {
    return { items: [], sources: [] };
  }

  if (item.craft?.skill === undefined) {
    const source = resolveMaterialSource(knowledge, item.code);
    return { items: [item], sources: source === undefined ? [] : [source] };
  }

  const nextAncestors = new Set([...ancestors, item.code]);
  const materialCodes = [
    ...new Set((item.craft.items ?? []).map((material) => material.code)),
  ];
  const descendants = materialCodes.map((materialCode) =>
    resolveMaterialTree(knowledge, itemsByCode, materialCode, nextAncestors),
  );

  return mergeEquipmentKnowledge([
    { items: [item], sources: [] },
    ...descendants,
  ]);
};

export const resolveEquipmentKnowledge = (
  knowledge: WorldKnowledge,
  item: Item,
): EquipmentKnowledge => {
  const itemsByCode = new Map(
    knowledge.items.map((knownItem) => [knownItem.code, knownItem] as const),
  );
  const materialCodes = [
    ...new Set((item.craft?.items ?? []).map((material) => material.code)),
  ];
  const ancestors = new Set([item.code]);

  return mergeEquipmentKnowledge(
    materialCodes.map((materialCode) =>
      resolveMaterialTree(knowledge, itemsByCode, materialCode, ancestors),
    ),
  );
};

/**
 * Plans every active Goal in global priority order from shared world knowledge.
 * Proposed assignments act as temporary Reservations while the same decision
 * examines later Goals.
 */
export const createGoalActivityPlanner = (
  knowledge: WorldKnowledge,
): GoalActivityPlanner => {
  const itemsByCode = new Map(
    knowledge.items.map((item) => [item.code, item] as const),
  );

  return (snapshot, state, previousOutcome) => {
    const activities: ActivityAssignment[] = [];
    const completedGoalIds = new Set<string>();
    const planningReservations = [...state.reservations];

    for (const goal of state.goals) {
      const planningState = {
        goals: [goal],
        reservations: planningReservations,
      };
      const planned =
        goal.type === 'reachCombatLevel'
          ? planCombatProgression(snapshot, planningState, knowledge)
          : goal.type === 'equipItem'
            ? (() => {
                const item = itemsByCode.get(goal.itemCode);
                if (item === undefined) {
                  return err(new GoalItemNotResolvedError(goal.id));
                }

                const equipmentKnowledge = resolveEquipmentKnowledge(
                  knowledge,
                  item,
                );
                return planEquipmentProgression(
                  snapshot,
                  planningState,
                  item,
                  previousOutcome,
                  equipmentKnowledge.sources,
                  equipmentKnowledge.items,
                );
              })()
            : goal.type === 'reachProfessionLevel'
              ? planProfessionProgression(snapshot, planningState, knowledge)
              : goal.type === 'produceItem'
                ? (() => {
                    const item = itemsByCode.get(goal.itemCode);
                    return item === undefined
                      ? err(new GoalItemNotResolvedError(goal.id))
                      : planItemProduction(snapshot, planningState, item);
                  })()
                : goal.type === 'replenishBankItem'
                  ? (() => {
                      const monster = resolveMonster(knowledge, goal);
                      if (goal.monsterCode !== undefined) {
                        return monster === undefined
                          ? err(new GoalMonsterNotResolvedError(goal.id))
                          : planMonsterReplenishment(
                              snapshot,
                              planningState,
                              monster,
                              state.reservations,
                            );
                      }

                      const resource = resolveResource(knowledge, goal);
                      return resource === undefined
                        ? err(new GoalResourceNotResolvedError(goal.id))
                        : planResourceReplenishment(
                            snapshot,
                            planningState,
                            resource,
                            state.reservations,
                          );
                    })()
                  : ok({ activities: [], state: planningState });

      if (planned.isErr()) {
        return err(planned.error);
      }

      if (planned.value.state.goals.length === 0) {
        completedGoalIds.add(goal.id);
      }

      activities.push(...planned.value.activities);
      planningReservations.push(...planned.value.activities);
    }

    return ok({
      activities,
      state: {
        goals: state.goals.filter(
          (goal) =>
            !completedGoalIds.has(goal.id) ||
            !isCompletedGoalStillSatisfied(snapshot, state, activities, goal),
        ),
        reservations: state.reservations,
      },
    });
  };
};
