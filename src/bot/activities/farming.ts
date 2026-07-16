import { okAsync, type ResultAsync } from 'neverthrow';

import type { ArtifactsApiError, ArtifactsClient } from '../../client/index.js';
import { logger } from '../../utils/logger.js';
import { isInventoryFull, totalItemCount } from '../inventory.js';
import type { CharacterAgent } from '../runtime/characterAgent.js';
import { type LocationNotFoundError, resolveLocation } from '../world.js';

import { type BankingError, goToBankAndDepositEverything } from './banking.js';

export type FarmingError = ArtifactsApiError | LocationNotFoundError;

type FarmingClient = Pick<ArtifactsClient, 'getMaps'>;
type FarmingAgent = Pick<
  CharacterAgent,
  'depositItems' | 'gather' | 'getCharacter' | 'moveTo'
>;

const gatherUntilFull = (
  agent: Pick<FarmingAgent, 'gather' | 'getCharacter'>,
): ResultAsync<void, FarmingError> => {
  const character = agent.getCharacter();

  if (isInventoryFull(character)) {
    logger.info(
      { character: character.name, items: totalItemCount(character) },
      `${character.name}: inventory full, heading to the bank`,
    );
    return okAsync(undefined);
  }

  return agent.gather().andThen(() => gatherUntilFull(agent));
};

/**
 * Runs one full farming cycle for `resourceCode`: move to the resource, gather
 * until the inventory is full (or an action fails), then move to a bank and
 * deposit everything gathered.
 */
export const runFarmingCycle = (
  client: FarmingClient,
  agent: FarmingAgent,
  resourceCode: string,
): ResultAsync<void, FarmingError | BankingError> => {
  const character = agent.getCharacter();
  logger.info(
    { character: character.name, resource: resourceCode },
    `${character.name}: starting farming cycle for ${resourceCode}`,
  );

  return resolveLocation(client, 'resource', resourceCode)
    .andThen((resourceMap) => agent.moveTo(resourceMap.map_id))
    .andThen(() => gatherUntilFull(agent))
    .andThen(() => goToBankAndDepositEverything(client, agent));
};
