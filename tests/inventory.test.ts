import { describe, expect, it } from 'vitest';

import {
  heldItems,
  heldQuantity,
  isInventoryFull,
  totalItemCount,
} from '../src/bot/inventory.js';
import type { components } from '../src/client/schema.js';

type Character = components['schemas']['CharacterSchema'];
type InventorySlot = components['schemas']['InventorySlotSchema'];

const buildCharacter = (
  inventory: InventorySlot[] | undefined,
  inventoryMaxItems = 100,
): Character =>
  ({
    ...({} as Character),
    inventory,
    inventory_max_items: inventoryMaxItems,
  }) as Character;

describe('heldQuantity', () => {
  it('sums only slots matching the requested item code', () => {
    const character = buildCharacter([
      { code: 'copper_ore', quantity: 2, slot: 1 },
      { code: 'ash_wood', quantity: 7, slot: 2 },
      { code: 'copper_ore', quantity: 3, slot: 3 },
    ]);

    expect(heldQuantity(character, 'copper_ore')).toBe(5);
    expect(heldQuantity(character, 'iron_ore')).toBe(0);
  });

  it('returns zero when the inventory is absent', () => {
    expect(heldQuantity(buildCharacter(undefined), 'copper_ore')).toBe(0);
  });
});

describe('totalItemCount', () => {
  it('sums every inventory slot quantity', () => {
    const character = buildCharacter([
      { code: 'copper_ore', quantity: 2, slot: 1 },
      { code: 'ash_wood', quantity: 7, slot: 2 },
    ]);

    expect(totalItemCount(character)).toBe(9);
  });

  it('returns zero when the inventory is absent', () => {
    expect(totalItemCount(buildCharacter(undefined))).toBe(0);
  });
});

describe('isInventoryFull', () => {
  it('is false below capacity and true at capacity', () => {
    const inventory = [{ code: 'copper_ore', quantity: 9, slot: 1 }];

    expect(isInventoryFull(buildCharacter(inventory, 10))).toBe(false);
    expect(isInventoryFull(buildCharacter(inventory, 9))).toBe(true);
  });
});

describe('heldItems', () => {
  it('keeps only positive quantities with a non-empty item code', () => {
    const character = buildCharacter([
      { code: '', quantity: 2, slot: 1 },
      { code: 'copper_ore', quantity: 0, slot: 2 },
      { code: 'iron_ore', quantity: -1, slot: 3 },
      { code: 'ash_wood', quantity: 4, slot: 4 },
    ]);

    expect(heldItems(character)).toEqual([{ code: 'ash_wood', quantity: 4 }]);
  });

  it('returns an empty list when the inventory is absent', () => {
    expect(heldItems(buildCharacter(undefined))).toEqual([]);
  });
});
