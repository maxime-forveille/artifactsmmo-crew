import { err, ok, type Result } from 'neverthrow';

import type { components } from '../../client/schema.js';
import type {
  CraftItemActivity,
  DepositItemActivity,
  EquipItemActivity,
  FarmResourceActivity,
  FightMonsterActivity,
  WithdrawItemActivity,
} from '../activities/activity.js';
import { findBestSafeFighter } from '../combat.js';
import { EQUIP_SLOT_BY_ITEM_TYPE, equippedItemInSlot } from '../gear.js';
import { heldQuantity } from '../inventory.js';
import { craftSkillLevel } from '../progression.js';

import type { CrewSnapshot } from './crewSnapshot.js';
import type {
  ActivityAssignment,
  ItemIntent,
  OrchestratorState,
} from './orchestratorState.js';
import {
  isBankWithdrawalReserved,
  isItemProductionReserved,
  reservedBankWithdrawalQuantity,
} from './reservationIntents.js';
import {
  findBestGatherer,
  NoEligibleGathererError,
} from './resourceReplenishment.js';

type Character = Readonly<components['schemas']['CharacterSchema']>;
type CraftSkill = components['schemas']['CraftSkill'];
type Item = Readonly<components['schemas']['ItemSchema']>;
type Monster = Readonly<components['schemas']['MonsterSchema']>;
type Resource = Readonly<components['schemas']['ResourceSchema']>;
type EquipmentActivity =
  | CraftItemActivity
  | DepositItemActivity
  | EquipItemActivity
  | FarmResourceActivity
  | FightMonsterActivity
  | WithdrawItemActivity;

export type EquipmentMaterialSource = Readonly<{
  itemCode: string;
  source:
    | Readonly<{ monster: Monster; type: 'monster' }>
    | Readonly<{ resource: Resource; type: 'gather' }>;
}>;

export type EquipmentProgressionPlan = Readonly<{
  activities: readonly ActivityAssignment<EquipmentActivity>[];
  state: OrchestratorState;
}>;

type PreviousActivityEvent<
  TType extends 'blocked' | 'cancelled' | 'completed',
> = Readonly<{ characterName?: string; goalId: string; type: TType }>;

export type PreviousActivityOutcome =
  | Readonly<{ event: PreviousActivityEvent<'cancelled' | 'completed'> }>
  | Readonly<{ error: Error; event: PreviousActivityEvent<'blocked'> }>;

export class EquipmentCharacterNotFoundError extends Error {
  constructor(public readonly characterName: string) {
    super(`Character "${characterName}" does not exist in the Crew Snapshot`);
    this.name = 'EquipmentCharacterNotFoundError';
  }
}

export class InvalidEquipmentTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEquipmentTargetError';
  }
}

export class InvalidEquipmentMaterialSourceError extends Error {
  constructor(
    public readonly itemCode: string,
    public readonly sourceCode: string,
  ) {
    super(
      `Source ${sourceCode} does not produce equipment material ${itemCode}`,
    );
    this.name = 'InvalidEquipmentMaterialSourceError';
  }
}

export class NoSafeEquipmentMaterialFighterError extends Error {
  constructor(
    public readonly itemCode: string,
    public readonly monsterCode: string,
  ) {
    super(`No character can safely fight ${monsterCode} for ${itemCode}`);
    this.name = 'NoSafeEquipmentMaterialFighterError';
  }
}

export type EquipmentProgressionError =
  | EquipmentCharacterNotFoundError
  | InvalidEquipmentMaterialSourceError
  | InvalidEquipmentTargetError
  | NoEligibleGathererError
  | NoSafeEquipmentMaterialFighterError;

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

const unchangedPlan = (state: OrchestratorState): EquipmentProgressionPlan => ({
  activities: [],
  state,
});

type EquipmentStep = Readonly<{
  activity: EquipmentActivity;
  characterName: string;
  consumes: readonly ItemIntent[];
  produces: readonly ItemIntent[];
}>;

type ItemProgress =
  | Readonly<{ status: 'step'; step: EquipmentStep }>
  | Readonly<{ status: 'unresolved' | 'waiting' }>;

const reservedCharacterNames = (
  state: OrchestratorState,
): ReadonlySet<string> =>
  new Set(state.reservations.map((reservation) => reservation.characterName));

const acquisitionStepFor = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  itemCode: string,
  resolved: EquipmentMaterialSource,
): Result<EquipmentStep | undefined, EquipmentProgressionError> => {
  if (resolved.source.type === 'gather') {
    const { resource } = resolved.source;

    if (!resource.drops.some((drop) => drop.code === itemCode)) {
      return err(
        new InvalidEquipmentMaterialSourceError(itemCode, resource.code),
      );
    }

    const eligibleGatherer = findBestGatherer(snapshot, resource);

    if (eligibleGatherer === undefined) {
      return err(
        new NoEligibleGathererError(
          resource.code,
          resource.skill,
          resource.level,
        ),
      );
    }

    const gatherer = findBestGatherer(
      snapshot,
      resource,
      reservedCharacterNames(state),
    );

    return ok(
      gatherer === undefined
        ? undefined
        : {
            activity: { resourceCode: resource.code, type: 'farmResource' },
            characterName: gatherer.name,
            consumes: [],
            produces: [{ itemCode }],
          },
    );
  }

  const { monster } = resolved.source;

  if (!monster.drops.some((drop) => drop.code === itemCode)) {
    return err(new InvalidEquipmentMaterialSourceError(itemCode, monster.code));
  }

  const eligibleFighter = findBestSafeFighter(snapshot.characters, monster);

  if (eligibleFighter === undefined) {
    return err(new NoSafeEquipmentMaterialFighterError(itemCode, monster.code));
  }

  const fighter = findBestSafeFighter(
    snapshot.characters,
    monster,
    reservedCharacterNames(state),
  );

  return ok(
    fighter === undefined
      ? undefined
      : {
          activity: { monsterCode: monster.code, type: 'fightMonster' },
          characterName: fighter.name,
          consumes: [],
          produces: [{ itemCode }],
        },
  );
};

const depositStep = (
  characterName: string,
  itemCode: string,
  quantity: number,
): EquipmentStep => ({
  activity: { itemCode, quantity, type: 'depositItem' },
  characterName,
  consumes: [],
  produces: [{ itemCode, quantity }],
});

const withdrawStep = (
  characterName: string,
  itemCode: string,
  quantity: number,
): EquipmentStep => ({
  activity: { itemCode, quantity, type: 'withdrawItem' },
  characterName,
  consumes: [{ itemCode, quantity }],
  produces: [],
});

const craftStep = (
  characterName: string,
  itemCode: string,
  quantity: number,
  producedQuantity: number,
): EquipmentStep => ({
  activity: { itemCode, quantity, type: 'craftItem' },
  characterName,
  consumes: [],
  produces: [{ itemCode, quantity: producedQuantity }],
});

const findBestItemHolder = (
  snapshot: CrewSnapshot,
  itemCode: string,
  consumerName: string,
  excludedCharacterNames: ReadonlySet<string> = new Set(),
): Character | undefined =>
  snapshot.characters
    .filter(
      (character) =>
        character.name !== consumerName &&
        !excludedCharacterNames.has(character.name) &&
        heldQuantity(character, itemCode) > 0,
    )
    .reduce<Character | undefined>((best, character) => {
      if (best === undefined) {
        return character;
      }

      const heldDifference =
        heldQuantity(character, itemCode) - heldQuantity(best, itemCode);

      if (heldDifference !== 0) {
        return heldDifference > 0 ? character : best;
      }

      return character.name.localeCompare(best.name) < 0 ? character : best;
    }, undefined);

const findBestCrafter = (
  snapshot: CrewSnapshot,
  skill: CraftSkill,
  requiredLevel: number,
  preferredCharacterName: string,
  excludedCharacterNames: ReadonlySet<string> = new Set(),
): Character | undefined => {
  const eligible = snapshot.characters.filter(
    (character) =>
      !excludedCharacterNames.has(character.name) &&
      craftSkillLevel(character, skill) >= requiredLevel,
  );
  const preferred = eligible.find(
    (character) => character.name === preferredCharacterName,
  );

  if (preferred !== undefined) {
    return preferred;
  }

  return eligible.reduce<Character | undefined>((best, character) => {
    if (best === undefined) {
      return character;
    }

    const levelDifference =
      craftSkillLevel(character, skill) - craftSkillLevel(best, skill);

    if (levelDifference !== 0) {
      return levelDifference > 0 ? character : best;
    }

    return character.name.localeCompare(best.name) < 0 ? character : best;
  }, undefined);
};

const planHeldItem = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  character: Character,
  item: Item,
  requiredQuantity: number,
  itemsByCode: ReadonlyMap<string, Item>,
  sourcesByItemCode: ReadonlyMap<string, EquipmentMaterialSource>,
  ancestors: ReadonlySet<string>,
): Result<ItemProgress, EquipmentProgressionError> => {
  if (ancestors.has(item.code)) {
    return ok({ status: 'unresolved' });
  }

  const missingQuantity = requiredQuantity - heldQuantity(character, item.code);
  const craftingSkill = item.craft?.skill;
  const reservedNames = reservedCharacterNames(state);
  const availableHolder = findBestItemHolder(
    snapshot,
    item.code,
    character.name,
    reservedNames,
  );

  if (availableHolder !== undefined) {
    return ok({
      status: 'step',
      step: depositStep(
        availableHolder.name,
        item.code,
        Math.min(missingQuantity, heldQuantity(availableHolder, item.code)),
      ),
    });
  }

  if (findBestItemHolder(snapshot, item.code, character.name) !== undefined) {
    return ok({ status: 'waiting' });
  }

  if (isItemProductionReserved(state, item.code)) {
    return ok({ status: 'waiting' });
  }

  if (craftingSkill === undefined) {
    const resolvedSource = sourcesByItemCode.get(item.code);

    if (resolvedSource === undefined) {
      return ok({ status: 'unresolved' });
    }

    return acquisitionStepFor(snapshot, state, item.code, resolvedSource).map(
      (step) =>
        step === undefined ? { status: 'waiting' } : { status: 'step', step },
    );
  }

  const recipeQuantity = item.craft?.quantity ?? 1;
  const craftQuantity = Math.ceil(missingQuantity / recipeQuantity);
  const producedQuantity = craftQuantity * recipeQuantity;
  const requiredCraftingLevel = item.craft?.level ?? 0;
  const eligibleCrafter = findBestCrafter(
    snapshot,
    craftingSkill,
    requiredCraftingLevel,
    character.name,
  );

  if (eligibleCrafter === undefined) {
    return ok({
      status: 'step',
      step: craftStep(
        character.name,
        item.code,
        craftQuantity,
        producedQuantity,
      ),
    });
  }

  const crafter = findBestCrafter(
    snapshot,
    craftingSkill,
    requiredCraftingLevel,
    character.name,
    reservedNames,
  );

  if (crafter === undefined) {
    return ok({ status: 'waiting' });
  }

  const nextAncestors = new Set([...ancestors, item.code]);

  for (const material of item.craft?.items ?? []) {
    const requiredMaterialQuantity = material.quantity * craftQuantity;
    const missingMaterialQuantity = Math.max(
      requiredMaterialQuantity - heldQuantity(crafter, material.code),
      0,
    );

    if (missingMaterialQuantity === 0) {
      continue;
    }

    const availableMaterialQuantity = availableBankQuantity(
      snapshot,
      state,
      material.code,
    );
    const bankedMaterialQuantity = Math.min(
      missingMaterialQuantity,
      availableMaterialQuantity,
    );

    if (bankedMaterialQuantity > 0) {
      return ok({
        status: 'step',
        step: withdrawStep(crafter.name, material.code, bankedMaterialQuantity),
      });
    }

    if (isBankWithdrawalReserved(state, material.code)) {
      return ok({ status: 'waiting' });
    }

    const materialItem = itemsByCode.get(material.code);

    if (materialItem === undefined) {
      const source = sourcesByItemCode.get(material.code);

      if (source === undefined) {
        return ok({ status: 'unresolved' });
      }

      return acquisitionStepFor(snapshot, state, material.code, source).map(
        (step) =>
          step === undefined ? { status: 'waiting' } : { status: 'step', step },
      );
    }

    const materialProgress = planHeldItem(
      snapshot,
      state,
      crafter,
      materialItem,
      requiredMaterialQuantity,
      itemsByCode,
      sourcesByItemCode,
      nextAncestors,
    );

    if (materialProgress.isErr()) {
      return err(materialProgress.error);
    }

    return ok(materialProgress.value);
  }

  return ok({
    status: 'step',
    step: craftStep(crafter.name, item.code, craftQuantity, producedQuantity),
  });
};

/**
 * Advances one explicit equipment Goal by one bounded step. A blocked step is
 * left idle for the next planner layer to turn into prerequisite Goals.
 */
export const planEquipmentProgression = (
  snapshot: CrewSnapshot,
  state: OrchestratorState,
  item: Item,
  previousOutcome?: PreviousActivityOutcome,
  resolvedSources: readonly EquipmentMaterialSource[] = [],
  resolvedItems: readonly Item[] = [],
): Result<EquipmentProgressionPlan, EquipmentProgressionError> => {
  const goal = state.goals[0];

  if (goal === undefined || goal.type !== 'equipItem') {
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

  const character = snapshot.characters.find(
    (candidate) => candidate.name === goal.characterName,
  );

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
        reservation.goalId === goal.id ||
        reservation.characterName === goal.characterName,
    )
  ) {
    return ok(unchangedPlan(state));
  }

  if (
    previousOutcome?.event.type === 'blocked' &&
    previousOutcome.event.goalId === goal.id
  ) {
    return ok(unchangedPlan(state));
  }

  if (heldQuantity(character, item.code) > 0) {
    return ok({
      activities: [
        {
          activity: { itemCode: item.code, type: 'equipItem' },
          characterName: character.name,
          consumes: [{ itemCode: item.code, quantity: 1 }],
          goalId: goal.id,
          produces: [],
        },
      ],
      state,
    });
  }

  if (availableBankQuantity(snapshot, state, item.code) > 0) {
    return ok({
      activities: [
        {
          activity: { itemCode: item.code, quantity: 1, type: 'withdrawItem' },
          characterName: character.name,
          consumes: [{ itemCode: item.code, quantity: 1 }],
          goalId: goal.id,
          produces: [],
        },
      ],
      state,
    });
  }

  if (isBankWithdrawalReserved(state, item.code)) {
    return ok(unchangedPlan(state));
  }

  if (item.craft?.skill === undefined) {
    const step: EquipmentStep = {
      activity: { itemCode: item.code, type: 'equipItem' },
      characterName: character.name,
      consumes: [{ itemCode: item.code, quantity: 1 }],
      produces: [],
    };

    return ok({ activities: [{ ...step, goalId: goal.id }], state });
  }

  const itemsByCode = new Map(
    [item, ...resolvedItems].map((resolvedItem) => [
      resolvedItem.code,
      resolvedItem,
    ]),
  );
  const sourcesByItemCode = new Map(
    resolvedSources.map((resolvedSource) => [
      resolvedSource.itemCode,
      resolvedSource,
    ]),
  );
  const progress = planHeldItem(
    snapshot,
    state,
    character,
    item,
    1,
    itemsByCode,
    sourcesByItemCode,
    new Set(),
  );

  if (progress.isErr()) {
    return err(progress.error);
  }

  if (progress.value.status === 'waiting') {
    return ok(unchangedPlan(state));
  }

  const step: EquipmentStep =
    progress.value.status === 'step'
      ? progress.value.step
      : craftStep(character.name, item.code, 1, item.craft?.quantity ?? 1);

  return ok({ activities: [{ ...step, goalId: goal.id }], state });
};
