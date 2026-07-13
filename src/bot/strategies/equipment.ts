import { errAsync, okAsync, type ResultAsync } from "neverthrow";

import type { ArtifactsApiError, ArtifactsClient } from "../../client/index.js";
import type { components } from "../../client/schema.js";
import { logger } from "../../utils/logger.js";
import type { CharacterAgent } from "../characters/characterAgent.js";
import { fightSafely } from "../combat.js";
import { heldItems, heldQuantity, isInventoryFull, totalItemCount } from "../inventory.js";
import {
  BANK_CONTENT_CODE,
  findMonsterForDrop,
  findResourceForDrop,
  type LocationNotFoundError,
  type MonsterNotFoundError,
  resolveLocation,
  ResourceNotFoundError,
} from "../world.js";

type CharacterSnapshot = components["schemas"]["CharacterSchema"];
type EquipSlot = components["schemas"]["ItemSlot"];
type Item = components["schemas"]["ItemSchema"];

export class UnsupportedEquipSlotError extends Error {
  constructor(
    public readonly itemCode: string,
    public readonly itemType: string,
  ) {
    super(`Don't know which equipment slot fits item type "${itemType}" (item "${itemCode}")`);
    this.name = "UnsupportedEquipSlotError";
  }
}

export class InventoryFullError extends Error {
  constructor(public readonly itemCode: string) {
    super(`Inventory is full of "${itemCode}" itself, with nothing else to deposit to make room`);
    this.name = "InventoryFullError";
  }
}

export type EquipmentError =
  | ArtifactsApiError
  | InventoryFullError
  | LocationNotFoundError
  | MonsterNotFoundError
  | ResourceNotFoundError
  | UnsupportedEquipSlotError;

type EquipmentClient = Pick<
  ArtifactsClient,
  "getBankItems" | "getItem" | "getMaps" | "getMonsters" | "getResources"
>;
type EquipmentAgent = Pick<
  CharacterAgent,
  | "craft"
  | "depositItems"
  | "equip"
  | "fight"
  | "gather"
  | "getCharacter"
  | "moveTo"
  | "rest"
  | "unequip"
  | "withdrawItems"
>;

// Only the item types produced by the currently craftable level-1 gear.
// Artifacts/utilities have multiple slots and aren't handled (yet).
const EQUIP_SLOT_BY_ITEM_TYPE: Partial<Record<string, EquipSlot>> = {
  amulet: "amulet",
  bag: "bag",
  body_armor: "body_armor",
  boots: "boots",
  helmet: "helmet",
  leg_armor: "leg_armor",
  ring: "ring1",
  rune: "rune",
  shield: "shield",
  weapon: "weapon",
};

// Only the slots `EQUIP_SLOT_BY_ITEM_TYPE` can produce; the rest of the
// `EquipSlot` enum (ring2, artifact1-3, utility1-2) is unused here.
const SLOT_FIELD: Partial<Record<EquipSlot, keyof CharacterSnapshot>> = {
  amulet: "amulet_slot",
  bag: "bag_slot",
  body_armor: "body_armor_slot",
  boots: "boots_slot",
  helmet: "helmet_slot",
  leg_armor: "leg_armor_slot",
  ring1: "ring1_slot",
  rune: "rune_slot",
  shield: "shield_slot",
  weapon: "weapon_slot",
};

/** The item code currently held in `slot`, or undefined if it's empty. */
const equippedItemInSlot = (character: CharacterSnapshot, slot: EquipSlot): string | undefined => {
  const field = SLOT_FIELD[slot];
  const value = field === undefined ? undefined : character[field];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/**
 * Deposits everything except `itemCode` at the bank. Assumes the character
 * is already there. Fails with `InventoryFullError` if `itemCode` itself is
 * the only thing held (nothing safe to drop).
 */
const depositEverythingExcept = (
  agent: Pick<EquipmentAgent, "depositItems" | "getCharacter">,
  itemCode: string,
): ResultAsync<void, EquipmentError> => {
  const character = agent.getCharacter();
  const itemsToDeposit = heldItems(character).filter((item) => item.code !== itemCode);

  if (itemsToDeposit.length === 0) {
    return errAsync(new InventoryFullError(itemCode));
  }

  logger.info(
    { character: character.name, items: itemsToDeposit },
    `${character.name}: depositing ${itemsToDeposit.length} item type(s) at the bank to make room, keeping ${itemCode}`,
  );

  return agent.depositItems(itemsToDeposit).map(() => undefined);
};

/**
 * Deposits everything except `itemCode` at the bank, then returns to
 * `resourceMapId`, freeing up inventory room without losing progress on the
 * item currently being gathered.
 */
const makeRoomForGathering = (
  client: EquipmentClient,
  agent: Pick<EquipmentAgent, "depositItems" | "getCharacter" | "moveTo">,
  itemCode: string,
  resourceMapId: number,
): ResultAsync<void, EquipmentError> =>
  resolveLocation(client, "bank", BANK_CONTENT_CODE)
    .andThen((bankMap) => agent.moveTo(bankMap.map_id))
    .andThen(() => depositEverythingExcept(agent, itemCode))
    .andThen(() => agent.moveTo(resourceMapId));

const gatherUntilHave = (
  client: EquipmentClient,
  agent: Pick<EquipmentAgent, "depositItems" | "gather" | "getCharacter" | "moveTo">,
  itemCode: string,
  targetQuantity: number,
  resourceMapId: number,
): ResultAsync<void, EquipmentError> => {
  const character = agent.getCharacter();

  if (heldQuantity(character, itemCode) >= targetQuantity) {
    return okAsync(undefined);
  }

  if (isInventoryFull(character)) {
    return makeRoomForGathering(client, agent, itemCode, resourceMapId).andThen(() =>
      gatherUntilHave(client, agent, itemCode, targetQuantity, resourceMapId),
    );
  }

  return agent
    .gather()
    .andThen(() => gatherUntilHave(client, agent, itemCode, targetQuantity, resourceMapId));
};

/** Same as `gatherUntilHave`, but fighting a monster instead of gathering a resource node. */
const huntUntilHave = (
  client: EquipmentClient,
  agent: Pick<EquipmentAgent, "depositItems" | "fight" | "getCharacter" | "moveTo" | "rest">,
  itemCode: string,
  targetQuantity: number,
  monsterMapId: number,
): ResultAsync<void, EquipmentError> => {
  const character = agent.getCharacter();

  if (heldQuantity(character, itemCode) >= targetQuantity) {
    return okAsync(undefined);
  }

  if (isInventoryFull(character)) {
    return makeRoomForGathering(client, agent, itemCode, monsterMapId).andThen(() =>
      huntUntilHave(client, agent, itemCode, targetQuantity, monsterMapId),
    );
  }

  return fightSafely(agent).andThen(() =>
    huntUntilHave(client, agent, itemCode, targetQuantity, monsterMapId),
  );
};

/**
 * Ensures there's room for `incomingQuantity` more units before a withdrawal
 * (the bank/withdraw action fails with a 497 "inventory full" otherwise,
 * same as gathering into a full inventory). Deposits everything except
 * `itemCode` if there isn't enough room; assumes the character is already
 * at the bank.
 */
const ensureRoomFor = (
  agent: Pick<EquipmentAgent, "depositItems" | "getCharacter">,
  itemCode: string,
  incomingQuantity: number,
): ResultAsync<void, EquipmentError> => {
  const character = agent.getCharacter();

  if (totalItemCount(character) + incomingQuantity <= character.inventory_max_items) {
    return okAsync(undefined);
  }

  return depositEverythingExcept(agent, itemCode);
};

/**
 * Withdraws up to `missing` units of `itemCode` from the bank, if any are
 * there. A no-op (no trip made) when the bank has none. Checked before
 * gathering/hunting/crafting anything, since materials (or even the target
 * item itself) may already be banked from earlier activity.
 */
const withdrawFromBankIfAvailable = (
  client: EquipmentClient,
  agent: Pick<EquipmentAgent, "depositItems" | "getCharacter" | "moveTo" | "withdrawItems">,
  itemCode: string,
  missing: number,
): ResultAsync<void, EquipmentError> =>
  client.getBankItems({ item_code: itemCode }).andThen((page) => {
    const [bankItem] = page.data;
    const available = bankItem?.quantity ?? 0;

    if (available <= 0) {
      return okAsync(undefined);
    }

    const toWithdraw = Math.min(available, missing);

    return resolveLocation(client, "bank", BANK_CONTENT_CODE)
      .andThen((bankMap) => agent.moveTo(bankMap.map_id))
      .andThen(() => ensureRoomFor(agent, itemCode, toWithdraw))
      .andThen(() => {
        logger.info(
          { character: agent.getCharacter().name, item: itemCode, quantity: toWithdraw },
          `${agent.getCharacter().name}: withdrawing ${toWithdraw}x ${itemCode} from the bank`,
        );
        return agent.withdrawItems([{ code: itemCode, quantity: toWithdraw }]);
      })
      .map(() => undefined);
  });

/**
 * Unequips `itemCode` from wherever it's currently equipped (if anywhere),
 * moving it into inventory - e.g. the starter weapon `wooden_stick` needs to
 * come off before it can be used as a material for `wooden_staff`. Equipped
 * slots only ever hold 1 unit, so this contributes at most 1 to `held`.
 */
const reclaimEquippedIfAvailable = (
  agent: Pick<EquipmentAgent, "getCharacter" | "unequip">,
  itemCode: string,
): ResultAsync<void, EquipmentError> => {
  const character = agent.getCharacter();
  const slot = (Object.keys(SLOT_FIELD) as EquipSlot[]).find(
    (candidate) => equippedItemInSlot(character, candidate) === itemCode,
  );

  if (slot === undefined) {
    return okAsync(undefined);
  }

  logger.info(
    { character: character.name, item: itemCode, slot },
    `${character.name}: unequipping ${itemCode} from ${slot} to use as a crafting material`,
  );

  return agent.unequip([{ quantity: 1, slot }]).map(() => undefined);
};

/**
 * Same as `ensureHeld`, but for when the item's data has already been
 * fetched (e.g. by the caller, to avoid an extra `getItem` round-trip for
 * the same code).
 */
const ensureHeldItem = (
  client: EquipmentClient,
  agent: EquipmentAgent,
  item: Item,
  quantity: number,
): ResultAsync<void, EquipmentError> => {
  const itemCode = item.code;
  const held = heldQuantity(agent.getCharacter(), itemCode);

  if (held >= quantity) {
    return okAsync(undefined);
  }

  return withdrawFromBankIfAvailable(client, agent, itemCode, quantity - held)
    .andThen(() => reclaimEquippedIfAvailable(agent, itemCode))
    .andThen(() => {
      const stillMissing = quantity - heldQuantity(agent.getCharacter(), itemCode);

      if (stillMissing <= 0) {
        return okAsync(undefined);
      }

      if (item.craft?.skill !== undefined) {
        const craftSkill = item.craft.skill;
        const craftYield = item.craft.quantity ?? 1;
        const craftsNeeded = Math.ceil(stillMissing / craftYield);
        const materials = item.craft.items ?? [];

        return materials
          .reduce<ResultAsync<void, EquipmentError>>(
            (acc, material) =>
              acc.andThen(() =>
                ensureHeld(client, agent, material.code, material.quantity * craftsNeeded),
              ),
            okAsync(undefined),
          )
          .andThen(() => resolveLocation(client, "workshop", craftSkill))
          .andThen((workshopMap) => agent.moveTo(workshopMap.map_id))
          .andThen(() => {
            logger.info(
              { character: agent.getCharacter().name, item: itemCode, quantity: craftsNeeded },
              `${agent.getCharacter().name}: crafting ${craftsNeeded}x ${itemCode}`,
            );
            return agent.craft(itemCode, craftsNeeded);
          })
          .map(() => undefined);
      }

      return findResourceForDrop(client, itemCode)
        .andThen((resource) => resolveLocation(client, "resource", resource.code))
        .andThen((resourceMap) =>
          agent
            .moveTo(resourceMap.map_id)
            .andThen(() => gatherUntilHave(client, agent, itemCode, quantity, resourceMap.map_id)),
        )
        .orElse((error) =>
          error instanceof ResourceNotFoundError
            ? findMonsterForDrop(client, itemCode)
                .andThen((monster) => resolveLocation(client, "monster", monster.code))
                .andThen((monsterMap) =>
                  agent
                    .moveTo(monsterMap.map_id)
                    .andThen(() =>
                      huntUntilHave(client, agent, itemCode, quantity, monsterMap.map_id),
                    ),
                )
            : errAsync(error),
        );
    });
};

/**
 * Makes sure the character holds at least `quantity` of `itemCode`,
 * gathering and/or crafting whatever is missing:
 *  - if the item has a craft recipe, recursively ensures each material
 *    first, then crafts enough copies at the matching workshop.
 *  - otherwise, treats it as a raw resource drop: finds which resource node
 *    produces it, moves there, and gathers until enough is held.
 */
const ensureHeld = (
  client: EquipmentClient,
  agent: EquipmentAgent,
  itemCode: string,
  quantity: number,
): ResultAsync<void, EquipmentError> =>
  heldQuantity(agent.getCharacter(), itemCode) >= quantity
    ? okAsync(undefined)
    : client
        .getItem(itemCode)
        .andThen((response) => ensureHeldItem(client, agent, response.data, quantity));

/**
 * Crafts `itemCode` (gathering/crafting whatever materials are missing
 * along the way) and equips it in the slot matching its item type.
 */
export const craftAndEquip = (
  client: EquipmentClient,
  agent: EquipmentAgent,
  itemCode: string,
): ResultAsync<void, EquipmentError> =>
  client.getItem(itemCode).andThen((response) => {
    const item = response.data;
    const slot = EQUIP_SLOT_BY_ITEM_TYPE[item.type];

    if (slot === undefined) {
      return errAsync(new UnsupportedEquipSlotError(itemCode, item.type));
    }

    if (equippedItemInSlot(agent.getCharacter(), slot) === itemCode) {
      logger.info(
        { character: agent.getCharacter().name, item: itemCode, slot },
        `${agent.getCharacter().name}: ${itemCode} already equipped in ${slot}, skipping`,
      );
      return okAsync(undefined);
    }

    // Re-checked fresh (not captured before ensureHeldItem runs): a material
    // needed to craft `itemCode` may itself have come from unequipping
    // whatever was in this exact slot (e.g. wooden_staff needs the starter
    // wooden_stick, which is usually the equipped weapon).
    return ensureHeldItem(client, agent, item, 1)
      .andThen(() => {
        const stillEquipped = equippedItemInSlot(agent.getCharacter(), slot);

        if (stillEquipped === undefined) {
          return okAsync(undefined);
        }

        logger.info(
          { character: agent.getCharacter().name, item: stillEquipped, slot },
          `${agent.getCharacter().name}: unequipping ${stillEquipped} from ${slot} to make room for ${itemCode}`,
        );
        return agent.unequip([{ quantity: 1, slot }]).map(() => undefined);
      })
      .andThen(() => {
        logger.info(
          { character: agent.getCharacter().name, item: itemCode, slot },
          `${agent.getCharacter().name}: equipping ${itemCode} in ${slot}`,
        );
        return agent.equip([{ code: itemCode, quantity: 1, slot }]).map(() => undefined);
      });
  });
