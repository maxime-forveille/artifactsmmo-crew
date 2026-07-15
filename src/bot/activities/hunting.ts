import { okAsync, type ResultAsync } from "neverthrow";

import type { ArtifactsApiError, ArtifactsClient } from "../../client/index.js";
import { fightSafely } from "../combat.js";
import { logger } from "../../utils/logger.js";
import type { CharacterAgent } from "../runtime/characterAgent.js";
import { isInventoryFull, totalItemCount } from "../inventory.js";
import { type LocationNotFoundError, resolveLocation } from "../world.js";
import { type BankingError, goToBankAndDepositEverything } from "./banking.js";

export type HuntingError = ArtifactsApiError | BankingError | LocationNotFoundError;

type HuntingClient = Pick<ArtifactsClient, "getMaps">;
type HuntingAgent = Pick<
  CharacterAgent,
  "depositItems" | "fight" | "getCharacter" | "moveTo" | "rest"
>;

const fightUntilFull = (
  agent: Pick<HuntingAgent, "fight" | "getCharacter" | "rest">,
): ResultAsync<void, ArtifactsApiError> => {
  const character = agent.getCharacter();

  if (isInventoryFull(character)) {
    logger.info(
      { character: character.name, items: totalItemCount(character) },
      `${character.name}: inventory full, heading to the bank`,
    );
    return okAsync(undefined);
  }

  return fightSafely(agent).andThen(() => fightUntilFull(agent));
};

/**
 * Runs one full hunting cycle for `monsterCode`: move to the monster, fight
 * it repeatedly (resting whenever HP drops below half, to stay safe)
 * until the inventory is full, then move to a bank and deposit everything
 * looted.
 */
export const runHuntingCycle = (
  client: HuntingClient,
  agent: HuntingAgent,
  monsterCode: string,
): ResultAsync<void, HuntingError> => {
  const character = agent.getCharacter();
  logger.info(
    { character: character.name, monster: monsterCode },
    `${character.name}: starting hunting cycle for ${monsterCode}`,
  );

  return resolveLocation(client, "monster", monsterCode)
    .andThen((monsterMap) => agent.moveTo(monsterMap.map_id))
    .andThen(() => fightUntilFull(agent))
    .andThen(() => goToBankAndDepositEverything(client, agent));
};
