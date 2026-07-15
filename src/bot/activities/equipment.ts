import { errAsync, okAsync, type ResultAsync } from "neverthrow";

import type { ArtifactsApiError, ArtifactsClient } from "../../client/index.js";
import type { components } from "../../client/schema.js";
import { logger } from "../../utils/logger.js";
import type { CharacterAgent } from "../runtime/characterAgent.js";
import { fightSafely, isSafeToFight } from "../combat.js";
import { EQUIP_SLOT_BY_ITEM_TYPE, equippedItemInSlot, SLOT_FIELD } from "../gear.js";
import { heldItems, heldQuantity, isInventoryFull, totalItemCount } from "../inventory.js";
import { craftSkillLevel } from "../progression.js";
import {
  BANK_CONTENT_CODE,
  findMonsterForDrop,
  findResourceForDrop,
  type LocationNotFoundError,
  type MonsterNotFoundError,
  resolveLocation,
  ResourceNotFoundError,
} from "../world.js";

type CraftSkill = components["schemas"]["CraftSkill"];
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

export class UnsafeMonsterError extends Error {
  constructor(
    public readonly itemCode: string,
    public readonly monsterCode: string,
  ) {
    super(
      `Fighting "${monsterCode}" for "${itemCode}" isn't safe with the character's current gear`,
    );
    this.name = "UnsafeMonsterError";
  }
}

export class NotCraftableItemError extends Error {
  constructor(public readonly itemCode: string) {
    super(`Item "${itemCode}" has no crafting recipe`);
    this.name = "NotCraftableItemError";
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
    this.name = "InsufficientCraftingLevelError";
  }
}

export type EquipmentError =
  | ArtifactsApiError
  | InsufficientCraftingLevelError
  | InventoryFullError
  | LocationNotFoundError
  | MonsterNotFoundError
  | NotCraftableItemError
  | ResourceNotFoundError
  | UnsafeMonsterError
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

const craftItemFromDefinition = (
  client: EquipmentClient,
  agent: EquipmentAgent,
  item: Item,
  craftQuantity: number,
): ResultAsync<void, EquipmentError> => {
  const craftSkill = item.craft?.skill;

  if (craftSkill === undefined) {
    return errAsync(new NotCraftableItemError(item.code));
  }

  const currentLevel = craftSkillLevel(agent.getCharacter(), craftSkill);
  const requiredLevel = item.craft?.level ?? 0;

  if (currentLevel < requiredLevel) {
    return errAsync(
      new InsufficientCraftingLevelError(item.code, craftSkill, requiredLevel, currentLevel),
    );
  }

  return (item.craft?.items ?? [])
    .reduce<ResultAsync<void, EquipmentError>>(
      (acc, material) =>
        acc.andThen(() =>
          ensureHeld(client, agent, material.code, material.quantity * craftQuantity),
        ),
      okAsync(undefined),
    )
    .andThen(() => resolveLocation(client, "workshop", craftSkill))
    .andThen((workshopMap) => agent.moveTo(workshopMap.map_id))
    .andThen(() => {
      logger.info(
        { character: agent.getCharacter().name, item: item.code, quantity: craftQuantity },
        `${agent.getCharacter().name}: crafting ${craftQuantity}x ${item.code}`,
      );
      return agent.craft(item.code, craftQuantity);
    })
    .map(() => undefined);
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
        const craftYield = item.craft.quantity ?? 1;
        const craftsNeeded = Math.ceil(stillMissing / craftYield);

        return craftItemFromDefinition(client, agent, item, craftsNeeded);
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
            ? findMonsterForDrop(client, itemCode).andThen((monster) => {
                // Unlike the main autoHunt loop (findNextSafeMonster), this
                // fallback has no other candidate to pick from - the game
                // may only have one monster drop this exact material. So
                // instead of skipping to a safer alternative, an unsafe
                // match is a hard stop: fighting it anyway (fightSafely, via
                // huntUntilHave, has no safety check of its own - it's built
                // for a caller that already picked a safe target) risked
                // sending a character into real fights it could lose badly,
                // found live.
                if (!isSafeToFight(agent.getCharacter(), monster)) {
                  return errAsync(new UnsafeMonsterError(itemCode, monster.code));
                }

                return resolveLocation(client, "monster", monster.code).andThen((monsterMap) =>
                  agent
                    .moveTo(monsterMap.map_id)
                    .andThen(() =>
                      huntUntilHave(client, agent, itemCode, quantity, monsterMap.map_id),
                    ),
                );
              })
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
 *
 * Unlike `craftAndEquip`, this never touches equipment slots - it's the
 * right entry point for crafting an item purely for its own sake (e.g. a
 * cooking recipe crafted only for the profession XP it grants), which
 * `craftAndEquip` can't do since it requires an equip slot to exist for
 * the item's type at all.
 */
export const ensureHeld = (
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
 * Performs exactly `craftQuantity` crafts of `itemCode`, obtaining its
 * materials recursively first. Unlike `ensureHeld`, this never withdraws an
 * already-crafted copy of the target item from the bank: the purpose is to
 * execute the craft action itself and gain profession XP.
 */
export const craftItem = (
  client: EquipmentClient,
  agent: EquipmentAgent,
  itemCode: string,
  craftQuantity: number,
): ResultAsync<void, EquipmentError> =>
  client
    .getItem(itemCode)
    .andThen((response) => craftItemFromDefinition(client, agent, response.data, craftQuantity));

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
