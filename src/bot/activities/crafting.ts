import { errAsync, type ResultAsync } from 'neverthrow';

import type { ArtifactsApiError, ArtifactsClient } from '../../client/index.js';
import type { components } from '../../client/schema.js';
import { heldQuantity } from '../inventory.js';
import { craftSkillLevel } from '../progression.js';
import type { CharacterAgent } from '../runtime/characterAgent.js';
import { resolveLocation, type LocationNotFoundError } from '../world.js';

import type { CraftItemActivity } from './activity.js';

type CraftSkill = components['schemas']['CraftSkill'];

export class NotCraftableItemError extends Error {
  constructor(public readonly itemCode: string) {
    super(`Item "${itemCode}" has no crafting recipe`);
    this.name = 'NotCraftableItemError';
  }
}

export class InsufficientCraftingLevelError extends Error {
  constructor(
    public readonly itemCode: string,
    public readonly skill: CraftSkill,
    public readonly requiredLevel: number,
    public readonly currentLevel: number,
  ) {
    super(
      `Crafting "${itemCode}" needs ${skill} level ${requiredLevel}, but the character is only level ${currentLevel}`,
    );
    this.name = 'InsufficientCraftingLevelError';
  }
}

export class InvalidCraftQuantityError extends Error {
  constructor(public readonly quantity: number) {
    super(`Craft quantity must be a positive integer, received ${quantity}`);
    this.name = 'InvalidCraftQuantityError';
  }
}

export type MissingCraftingMaterial = Readonly<{
  availableQuantity: number;
  itemCode: string;
  requiredQuantity: number;
}>;

export class MissingCraftingMaterialsError extends Error {
  constructor(
    public readonly itemCode: string,
    public readonly missingMaterials: readonly MissingCraftingMaterial[],
  ) {
    super(
      `Crafting "${itemCode}" needs materials that are not held by the character`,
    );
    this.name = 'MissingCraftingMaterialsError';
  }
}

export type CraftItemExecutionError =
  | ArtifactsApiError
  | InsufficientCraftingLevelError
  | InvalidCraftQuantityError
  | LocationNotFoundError
  | MissingCraftingMaterialsError
  | NotCraftableItemError;

type CraftingClient = Pick<ArtifactsClient, 'getItem' | 'getMaps'>;
type CraftingAgent = Pick<CharacterAgent, 'craft' | 'getCharacter' | 'moveTo'>;

/**
 * Executes one craft selected by policy. It validates only currently held
 * materials and never withdraws, gathers, hunts, or recursively crafts inputs.
 */
export const runCraftItemActivity = (
  client: CraftingClient,
  agent: CraftingAgent,
  activity: CraftItemActivity,
): ResultAsync<void, CraftItemExecutionError> => {
  if (!Number.isInteger(activity.quantity) || activity.quantity <= 0) {
    return errAsync(new InvalidCraftQuantityError(activity.quantity));
  }

  return client.getItem(activity.itemCode).andThen((response) => {
    const item = response.data;
    const craft = item.craft;

    if (craft === undefined || craft.skill === undefined) {
      return errAsync(new NotCraftableItemError(item.code));
    }

    const craftSkill = craft.skill;
    const requiredLevel = craft.level ?? 0;
    const currentLevel = craftSkillLevel(agent.getCharacter(), craftSkill);

    if (currentLevel < requiredLevel) {
      return errAsync(
        new InsufficientCraftingLevelError(
          item.code,
          craftSkill,
          requiredLevel,
          currentLevel,
        ),
      );
    }

    const missingMaterials = (craft.items ?? [])
      .map((material): MissingCraftingMaterial => {
        const requiredQuantity = material.quantity * activity.quantity;

        return {
          availableQuantity: heldQuantity(agent.getCharacter(), material.code),
          itemCode: material.code,
          requiredQuantity,
        };
      })
      .filter(
        (material) => material.availableQuantity < material.requiredQuantity,
      );

    if (missingMaterials.length > 0) {
      return errAsync(
        new MissingCraftingMaterialsError(item.code, missingMaterials),
      );
    }

    return resolveLocation(client, 'workshop', craftSkill)
      .andThen((workshop) => agent.moveTo(workshop.map_id))
      .andThen(() => agent.craft(item.code, activity.quantity))
      .map(() => undefined);
  });
};
