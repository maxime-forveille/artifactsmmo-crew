import { errAsync, okAsync, type ResultAsync } from 'neverthrow';

import type { ArtifactsApiError, ArtifactsClient } from '../../client/index.js';
import type { components } from '../../client/schema.js';
import { logger } from '../../utils/logger.js';
import { heldItems, totalItemCount } from '../inventory.js';
import type { CharacterAgent } from '../runtime/characterAgent.js';
import {
  BANK_CONTENT_CODE,
  type LocationNotFoundError,
  resolveLocation,
} from '../world.js';

import type { WithdrawItemActivity } from './activity.js';

type SimpleItem = components['schemas']['SimpleItemSchema'];

export class BankItemUnavailableError extends Error {
  constructor(
    public readonly itemCode: string,
    public readonly requestedQuantity: number,
    public readonly availableQuantity: number,
  ) {
    super(
      `Bank holds ${availableQuantity}x ${itemCode}, but ${requestedQuantity}x were requested`,
    );
    this.name = 'BankItemUnavailableError';
  }
}

export class InvalidWithdrawQuantityError extends Error {
  constructor(public readonly quantity: number) {
    super(`Withdraw quantity must be a positive integer, received ${quantity}`);
    this.name = 'InvalidWithdrawQuantityError';
  }
}

export class WithdrawInventoryFullError extends Error {
  constructor(
    public readonly itemCode: string,
    public readonly requestedQuantity: number,
    public readonly availableSpace: number,
  ) {
    super(
      `Inventory has room for ${availableSpace} item(s), but withdrawing ${requestedQuantity}x ${itemCode} was requested`,
    );
    this.name = 'WithdrawInventoryFullError';
  }
}

export type BankingError = ArtifactsApiError | LocationNotFoundError;
export type WithdrawItemError =
  | ArtifactsApiError
  | BankItemUnavailableError
  | InvalidWithdrawQuantityError
  | LocationNotFoundError
  | WithdrawInventoryFullError;

type BankingClient = Pick<ArtifactsClient, 'getMaps'>;
type BankingAgent = Pick<
  CharacterAgent,
  'depositItems' | 'getCharacter' | 'moveTo'
>;
type WithdrawalClient = Pick<ArtifactsClient, 'getBankItems' | 'getMaps'>;
type WithdrawalAgent = Pick<
  CharacterAgent,
  'getCharacter' | 'moveTo' | 'withdrawItems'
>;

const depositEverything = (
  agent: Pick<BankingAgent, 'depositItems' | 'getCharacter'>,
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

const bankQuantity = (page: readonly SimpleItem[], itemCode: string): number =>
  page
    .filter((item) => item.code === itemCode)
    .reduce((total, item) => total + item.quantity, 0);

/**
 * Withdraws one explicit item quantity already observed by policy. It never
 * deposits other inventory contents to make room or chooses another item.
 */
export const runWithdrawItemActivity = (
  client: WithdrawalClient,
  agent: WithdrawalAgent,
  activity: WithdrawItemActivity,
): ResultAsync<void, WithdrawItemError> => {
  if (!Number.isInteger(activity.quantity) || activity.quantity <= 0) {
    return errAsync(new InvalidWithdrawQuantityError(activity.quantity));
  }

  return client
    .getBankItems({ item_code: activity.itemCode })
    .andThen((page) => {
      const availableQuantity = bankQuantity(page.data, activity.itemCode);

      if (availableQuantity < activity.quantity) {
        return errAsync(
          new BankItemUnavailableError(
            activity.itemCode,
            activity.quantity,
            availableQuantity,
          ),
        );
      }

      const character = agent.getCharacter();
      const availableSpace =
        character.inventory_max_items - totalItemCount(character);

      if (availableSpace < activity.quantity) {
        return errAsync(
          new WithdrawInventoryFullError(
            activity.itemCode,
            activity.quantity,
            availableSpace,
          ),
        );
      }

      return resolveLocation(client, 'bank', BANK_CONTENT_CODE)
        .andThen((bankMap) => agent.moveTo(bankMap.map_id))
        .andThen(() =>
          agent.withdrawItems([
            { code: activity.itemCode, quantity: activity.quantity },
          ]),
        )
        .map(() => undefined);
    });
};

/** Moves to a bank and deposits everything currently held. */
export const goToBankAndDepositEverything = (
  client: BankingClient,
  agent: BankingAgent,
): ResultAsync<void, BankingError> =>
  resolveLocation(client, 'bank', BANK_CONTENT_CODE)
    .andThen((bankMap) => agent.moveTo(bankMap.map_id))
    .andThen(() => depositEverything(agent));
