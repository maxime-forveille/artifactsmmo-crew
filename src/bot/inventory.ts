import type { components } from '../client/schema.js';

type CharacterSnapshot = components['schemas']['CharacterSchema'];
type SimpleItem = components['schemas']['SimpleItemSchema'];

export const heldQuantity = (
  character: CharacterSnapshot,
  itemCode: string,
): number =>
  (character.inventory ?? [])
    .filter((slot) => slot.code === itemCode)
    .reduce((total, slot) => total + slot.quantity, 0);

export const totalItemCount = (character: CharacterSnapshot): number =>
  (character.inventory ?? []).reduce((total, slot) => total + slot.quantity, 0);

export const isInventoryFull = (character: CharacterSnapshot): boolean =>
  totalItemCount(character) >= character.inventory_max_items;

export const heldItems = (character: CharacterSnapshot): SimpleItem[] =>
  (character.inventory ?? [])
    .filter((slot) => slot.code !== '' && slot.quantity > 0)
    .map((slot) => ({ code: slot.code, quantity: slot.quantity }));
