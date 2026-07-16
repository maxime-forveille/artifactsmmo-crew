import { errAsync, okAsync, type ResultAsync } from 'neverthrow';

import type { ArtifactsApiError, ArtifactsClient } from '../../client/index.js';
import { EQUIP_SLOT_BY_ITEM_TYPE, equippedItemInSlot } from '../gear.js';
import { heldQuantity } from '../inventory.js';
import type { CharacterAgent } from '../runtime/characterAgent.js';

import type { EquipItemActivity } from './activity.js';

export class UnsupportedEquipSlotError extends Error {
  constructor(
    public readonly itemCode: string,
    public readonly itemType: string,
  ) {
    super(
      `Don't know which equipment slot fits item type "${itemType}" (item "${itemCode}")`,
    );
    this.name = 'UnsupportedEquipSlotError';
  }
}

export class InsufficientEquipmentLevelError extends Error {
  constructor(
    public readonly itemCode: string,
    public readonly requiredLevel: number,
    public readonly currentLevel: number,
  ) {
    super(
      `Equipping "${itemCode}" needs character level ${requiredLevel}, but the character is only level ${currentLevel}`,
    );
    this.name = 'InsufficientEquipmentLevelError';
  }
}

export class MissingEquipmentItemError extends Error {
  constructor(public readonly itemCode: string) {
    super(`Item "${itemCode}" is not held by the character`);
    this.name = 'MissingEquipmentItemError';
  }
}

export type EquipItemExecutionError =
  | ArtifactsApiError
  | InsufficientEquipmentLevelError
  | MissingEquipmentItemError
  | UnsupportedEquipSlotError;

type EquippingClient = Pick<ArtifactsClient, 'getItem'>;
type EquippingAgent = Pick<
  CharacterAgent,
  'equip' | 'getCharacter' | 'unequip'
>;

/**
 * Equips one policy-selected item already held by the character. It may unequip
 * the current slot occupant, but never retrieves or crafts the target.
 */
export const runEquipItemActivity = (
  client: EquippingClient,
  agent: EquippingAgent,
  activity: EquipItemActivity,
): ResultAsync<void, EquipItemExecutionError> =>
  client.getItem(activity.itemCode).andThen((response) => {
    const item = response.data;
    const slot = EQUIP_SLOT_BY_ITEM_TYPE[item.type];

    if (slot === undefined) {
      return errAsync(new UnsupportedEquipSlotError(item.code, item.type));
    }

    const character = agent.getCharacter();

    if (equippedItemInSlot(character, slot) === item.code) {
      return okAsync(undefined);
    }

    if (character.level < item.level) {
      return errAsync(
        new InsufficientEquipmentLevelError(
          item.code,
          item.level,
          character.level,
        ),
      );
    }

    if (heldQuantity(character, item.code) < 1) {
      return errAsync(new MissingEquipmentItemError(item.code));
    }

    const equippedItem = equippedItemInSlot(character, slot);
    const makeSlotAvailable =
      equippedItem === undefined
        ? okAsync(undefined)
        : agent.unequip([{ quantity: 1, slot }]).map(() => undefined);

    return makeSlotAvailable.andThen(() =>
      agent
        .equip([{ code: item.code, quantity: 1, slot }])
        .map(() => undefined),
    );
  });
