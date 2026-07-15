import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";

import {
  InsufficientEquipmentLevelError,
  MissingEquipmentItemError,
  runEquipItemActivity,
  UnsupportedEquipSlotError,
} from "../src/bot/activities/equipping.js";
import { ArtifactsApiError } from "../src/client/index.js";
import type { components } from "../src/client/schema.js";

type Character = components["schemas"]["CharacterSchema"];
type Cooldown = components["schemas"]["CooldownSchema"];
type Item = components["schemas"]["ItemSchema"];

const buildCharacter = (overrides: Partial<Character> = {}): Character => ({
  ...({} as Character),
  inventory: [{ code: "copper_dagger", quantity: 1, slot: 1 }],
  level: 5,
  name: "Stan",
  weapon_slot: "wooden_stick",
  ...overrides,
});

const buildItem = (overrides: Partial<Item> = {}): Item => ({
  ...({} as Item),
  code: "copper_dagger",
  level: 5,
  name: "Copper Dagger",
  type: "weapon",
  ...overrides,
});

const buildCooldown = (): Cooldown => ({
  expiration: "2026-07-16T00:00:05.000Z",
  reason: "equip",
  remaining_seconds: 5,
  started_at: "2026-07-16T00:00:00.000Z",
  total_seconds: 5,
});

const buildDependencies = (
  character = buildCharacter(),
  item = buildItem(),
  itemError?: ArtifactsApiError,
) => {
  const equip = vi.fn(() => okAsync({ character, cooldown: buildCooldown(), items: [] }));
  const getItem = vi.fn(
    (): ResultAsync<{ data: Item }, ArtifactsApiError> =>
      itemError === undefined ? okAsync({ data: item }) : errAsync(itemError),
  );
  const unequip = vi.fn(() => okAsync({ character, cooldown: buildCooldown(), items: [] }));

  return {
    agent: { equip, getCharacter: vi.fn(() => character), unequip },
    client: { getItem },
    equip,
    getItem,
    unequip,
  };
};

describe("runEquipItemActivity", () => {
  it("unequips the current slot occupant before equipping the held target", async () => {
    const { agent, client, equip, getItem, unequip } = buildDependencies();

    const result = await runEquipItemActivity(client, agent, {
      itemCode: "copper_dagger",
      type: "equipItem",
    });

    expect(result.isOk()).toBe(true);
    expect(getItem).toHaveBeenCalledWith("copper_dagger");
    expect(unequip).toHaveBeenCalledWith([{ quantity: 1, slot: "weapon" }]);
    expect(equip).toHaveBeenCalledWith([{ code: "copper_dagger", quantity: 1, slot: "weapon" }]);
    expect(unequip.mock.invocationCallOrder[0]).toBeLessThan(
      equip.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("equips directly when the target slot is empty", async () => {
    const character = buildCharacter({ weapon_slot: "" });
    const { agent, client, equip, unequip } = buildDependencies(character);

    const result = await runEquipItemActivity(client, agent, {
      itemCode: "copper_dagger",
      type: "equipItem",
    });

    expect(result.isOk()).toBe(true);
    expect(unequip).not.toHaveBeenCalled();
    expect(equip).toHaveBeenCalledOnce();
  });

  it("does nothing when the target is already equipped", async () => {
    const character = buildCharacter({ inventory: [], weapon_slot: "copper_dagger" });
    const { agent, client, equip, unequip } = buildDependencies(character);

    const result = await runEquipItemActivity(client, agent, {
      itemCode: "copper_dagger",
      type: "equipItem",
    });

    expect(result.isOk()).toBe(true);
    expect(unequip).not.toHaveBeenCalled();
    expect(equip).not.toHaveBeenCalled();
  });

  it("returns a typed Blocker when the target is not held", async () => {
    const character = buildCharacter({ inventory: [] });
    const { agent, client, equip, unequip } = buildDependencies(character);

    const result = await runEquipItemActivity(client, agent, {
      itemCode: "copper_dagger",
      type: "equipItem",
    });

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(MissingEquipmentItemError);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      itemCode: "copper_dagger",
      message: 'Item "copper_dagger" is not held by the character',
      name: "MissingEquipmentItemError",
    });
    expect(unequip).not.toHaveBeenCalled();
    expect(equip).not.toHaveBeenCalled();
  });

  it("reports the character level preventing the equip", async () => {
    const character = buildCharacter({ level: 4 });
    const { agent, client, equip, unequip } = buildDependencies(character);

    const result = await runEquipItemActivity(client, agent, {
      itemCode: "copper_dagger",
      type: "equipItem",
    });

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InsufficientEquipmentLevelError);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      currentLevel: 4,
      itemCode: "copper_dagger",
      message:
        'Equipping "copper_dagger" needs character level 5, but the character is only level 4',
      name: "InsufficientEquipmentLevelError",
      requiredLevel: 5,
    });
    expect(unequip).not.toHaveBeenCalled();
    expect(equip).not.toHaveBeenCalled();
  });

  it("rejects an item type without a supported slot", async () => {
    const item = buildItem({ code: "strange_artifact", type: "artifact" });
    const { agent, client, equip, unequip } = buildDependencies(buildCharacter(), item);

    const result = await runEquipItemActivity(client, agent, {
      itemCode: "strange_artifact",
      type: "equipItem",
    });

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(UnsupportedEquipSlotError);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      itemCode: "strange_artifact",
      itemType: "artifact",
      message:
        'Don\'t know which equipment slot fits item type "artifact" (item "strange_artifact")',
      name: "UnsupportedEquipSlotError",
    });
    expect(unequip).not.toHaveBeenCalled();
    expect(equip).not.toHaveBeenCalled();
  });

  it("propagates an item lookup failure without changing equipment", async () => {
    const apiError = new ArtifactsApiError("unavailable", 503, {});
    const { agent, client, equip, unequip } = buildDependencies(
      buildCharacter(),
      buildItem(),
      apiError,
    );

    const result = await runEquipItemActivity(client, agent, {
      itemCode: "copper_dagger",
      type: "equipItem",
    });

    expect(result._unsafeUnwrapErr()).toBe(apiError);
    expect(unequip).not.toHaveBeenCalled();
    expect(equip).not.toHaveBeenCalled();
  });
});
