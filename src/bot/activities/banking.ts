import { okAsync, type ResultAsync } from "neverthrow";

import type { ArtifactsApiError, ArtifactsClient } from "../../client/index.js";
import { logger } from "../../utils/logger.js";
import type { CharacterAgent } from "../runtime/characterAgent.js";
import { heldItems } from "../inventory.js";
import { BANK_CONTENT_CODE, type LocationNotFoundError, resolveLocation } from "../world.js";

export type BankingError = ArtifactsApiError | LocationNotFoundError;

type BankingClient = Pick<ArtifactsClient, "getMaps">;
type BankingAgent = Pick<CharacterAgent, "depositItems" | "getCharacter" | "moveTo">;

const depositEverything = (
  agent: Pick<BankingAgent, "depositItems" | "getCharacter">,
): ResultAsync<void, ArtifactsApiError> => {
  const character = agent.getCharacter();
  const items = heldItems(character);

  if (items.length === 0) {
    return okAsync(undefined);
  }

  logger.info(
    { character: character.name, items },
    `${character.name}: depositing ${items.length} item type(s) at the bank`,
  );

  return agent.depositItems(items).map(() => undefined);
};

/** Moves to a bank and deposits everything currently held. */
export const goToBankAndDepositEverything = (
  client: BankingClient,
  agent: BankingAgent,
): ResultAsync<void, BankingError> =>
  resolveLocation(client, "bank", BANK_CONTENT_CODE)
    .andThen((bankMap) => agent.moveTo(bankMap.map_id))
    .andThen(() => depositEverything(agent));
