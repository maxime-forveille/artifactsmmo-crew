import { okAsync, type ResultAsync } from "neverthrow";

import type { ArtifactsApiError, ArtifactsClient } from "../../client/index.js";
import type { components } from "../../client/schema.js";
import type { CharacterAgent } from "../characters/characterAgent.js";
import { type LocationNotFoundError, resolveLocation } from "../world.js";

type CharacterSnapshot = components["schemas"]["CharacterSchema"];
type SimpleItem = components["schemas"]["SimpleItemSchema"];

const BANK_CONTENT_CODE = "bank";

export type FarmingError = ArtifactsApiError | LocationNotFoundError;

type FarmingClient = Pick<ArtifactsClient, "getMaps">;
type FarmingAgent = Pick<CharacterAgent, "depositItems" | "gather" | "getCharacter" | "moveTo">;

const totalItemCount = (character: CharacterSnapshot): number =>
  (character.inventory ?? []).reduce((total, slot) => total + slot.quantity, 0);

const isInventoryFull = (character: CharacterSnapshot): boolean =>
  totalItemCount(character) >= character.inventory_max_items;

const heldItems = (character: CharacterSnapshot): SimpleItem[] =>
  (character.inventory ?? [])
    .filter((slot) => slot.code !== "" && slot.quantity > 0)
    .map((slot) => ({ code: slot.code, quantity: slot.quantity }));

const gatherUntilFull = (
  agent: Pick<FarmingAgent, "gather" | "getCharacter">,
): ResultAsync<void, FarmingError> =>
  isInventoryFull(agent.getCharacter())
    ? okAsync(undefined)
    : agent.gather().andThen(() => gatherUntilFull(agent));

const depositEverything = (
  agent: Pick<FarmingAgent, "depositItems" | "getCharacter">,
): ResultAsync<void, FarmingError> => {
  const items = heldItems(agent.getCharacter());

  return items.length === 0 ? okAsync(undefined) : agent.depositItems(items).map(() => undefined);
};

/**
 * Runs one full farming cycle for `resourceCode`: move to the resource,
 * gather until the inventory is full (or an action fails), then move to a
 * bank and deposit everything gathered.
 */
export const runFarmingCycle = (
  client: FarmingClient,
  agent: FarmingAgent,
  resourceCode: string,
): ResultAsync<void, FarmingError> =>
  resolveLocation(client, "resource", resourceCode)
    .andThen((resourceMap) => agent.moveTo(resourceMap.map_id))
    .andThen(() => gatherUntilFull(agent))
    .andThen(() => resolveLocation(client, "bank", BANK_CONTENT_CODE))
    .andThen((bankMap) => agent.moveTo(bankMap.map_id))
    .andThen(() => depositEverything(agent));
