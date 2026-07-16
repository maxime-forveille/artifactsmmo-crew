import { errAsync, okAsync, type ResultAsync } from 'neverthrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { loggerInfoMock } = vi.hoisted(() => ({ loggerInfoMock: vi.fn() }));

vi.mock('../src/utils/logger.js', () => ({ logger: { info: loggerInfoMock } }));

import {
  BankItemUnavailableError,
  goToBankAndDepositEverything,
  InvalidWithdrawQuantityError,
  runWithdrawItemActivity,
  WithdrawInventoryFullError,
} from '../src/bot/activities/banking.js';
import { LocationNotFoundError } from '../src/bot/world.js';
import { ArtifactsApiError } from '../src/client/index.js';
import type { components } from '../src/client/schema.js';

type BankItemTransaction = components['schemas']['BankItemTransactionSchema'];
type BankPage = components['schemas']['DataPage_SimpleItemSchema_'];
type Character = components['schemas']['CharacterSchema'];
type Cooldown = components['schemas']['CooldownSchema'];
type Map = components['schemas']['MapSchema'];
type MapPage = components['schemas']['StaticDataPage_MapSchema_'];

const BANK_MAP_ID = 42;

const buildCharacter = (overrides: Partial<Character> = {}): Character => ({
  ...({} as Character),
  inventory: [],
  inventory_max_items: 20,
  name: 'Stan',
  ...overrides,
});

const buildBankPage = (
  data: BankPage['data'] = [{ code: 'copper_dagger', quantity: 1 }],
): BankPage => ({ data, page: 1, pages: 1, size: 50, total: data.length });

const buildMapPage = (
  data: Map[] = [{ ...({} as Map), map_id: BANK_MAP_ID }],
): MapPage => ({ data, page: 1, pages: 1, size: 50, total: data.length });

const buildCooldown = (): Cooldown => ({
  expiration: '2026-07-16T00:00:05.000Z',
  reason: 'withdraw_item',
  remaining_seconds: 5,
  started_at: '2026-07-16T00:00:00.000Z',
  total_seconds: 5,
});

const buildDependencies = (
  character = buildCharacter(),
  bankPage = buildBankPage(),
  mapPage = buildMapPage(),
  bankError?: ArtifactsApiError,
  withdrawError?: ArtifactsApiError,
) => {
  const getBankItems = vi.fn(
    (): ResultAsync<BankPage, ArtifactsApiError> =>
      bankError === undefined ? okAsync(bankPage) : errAsync(bankError),
  );
  const getMaps = vi.fn(() => okAsync(mapPage));
  const moveTo = vi.fn(() => okAsync(undefined));
  const withdrawItems = vi.fn(
    (): ResultAsync<BankItemTransaction, ArtifactsApiError> =>
      withdrawError === undefined
        ? okAsync({ bank: [], character, cooldown: buildCooldown(), items: [] })
        : errAsync(withdrawError),
  );

  return {
    agent: { getCharacter: vi.fn(() => character), moveTo, withdrawItems },
    client: { getBankItems, getMaps },
    getBankItems,
    getMaps,
    moveTo,
    withdrawItems,
  };
};

afterEach(() => {
  loggerInfoMock.mockClear();
});

describe('goToBankAndDepositEverything', () => {
  it('skips the deposit Action when the inventory is empty', async () => {
    const { client, moveTo } = buildDependencies();
    const depositItems = vi.fn();

    const result = await goToBankAndDepositEverything(client, {
      depositItems,
      getCharacter: () => buildCharacter(),
      moveTo,
    });

    expect(result.isOk()).toBe(true);
    expect(moveTo).toHaveBeenCalledWith(BANK_MAP_ID);
    expect(depositItems).not.toHaveBeenCalled();
    expect(loggerInfoMock).not.toHaveBeenCalled();
  });

  it('deposits every held item and logs the transfer', async () => {
    const character = buildCharacter({
      inventory: [
        { code: 'copper_ore', quantity: 3, slot: 1 },
        { code: 'ash_wood', quantity: 2, slot: 2 },
      ],
    });
    const { client, moveTo } = buildDependencies(character);
    const depositItems = vi.fn(() =>
      okAsync({ bank: [], character, cooldown: buildCooldown(), items: [] }),
    );

    const result = await goToBankAndDepositEverything(client, {
      depositItems,
      getCharacter: () => character,
      moveTo,
    });

    const items = [
      { code: 'copper_ore', quantity: 3 },
      { code: 'ash_wood', quantity: 2 },
    ];
    expect(result.isOk()).toBe(true);
    expect(depositItems).toHaveBeenCalledWith(items);
    expect(loggerInfoMock).toHaveBeenCalledWith(
      { character: 'Stan', items },
      'Stan: depositing 2 item type(s) at the bank',
    );
  });
});

describe('runWithdrawItemActivity', () => {
  it('moves to the bank and withdraws the requested item', async () => {
    const { agent, client, getBankItems, getMaps, moveTo, withdrawItems } =
      buildDependencies();

    const result = await runWithdrawItemActivity(client, agent, {
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'withdrawItem',
    });

    expect(result.isOk()).toBe(true);
    expect(getBankItems).toHaveBeenCalledWith({ item_code: 'copper_dagger' });
    expect(getMaps).toHaveBeenCalledWith({
      content_code: 'bank',
      content_type: 'bank',
    });
    expect(moveTo).toHaveBeenCalledWith(BANK_MAP_ID);
    expect(withdrawItems).toHaveBeenCalledWith([
      { code: 'copper_dagger', quantity: 1 },
    ]);
  });

  it('allows a withdrawal that exactly fills the remaining inventory space', async () => {
    const character = buildCharacter({ inventory_max_items: 1 });
    const { agent, client, withdrawItems } = buildDependencies(character);

    const result = await runWithdrawItemActivity(client, agent, {
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'withdrawItem',
    });

    expect(result.isOk()).toBe(true);
    expect(withdrawItems).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5])(
    'rejects invalid quantity %s before reading the bank',
    async (quantity) => {
      const { agent, client, getBankItems } = buildDependencies();

      const result = await runWithdrawItemActivity(client, agent, {
        itemCode: 'copper_dagger',
        quantity,
        type: 'withdrawItem',
      });

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        InvalidWithdrawQuantityError,
      );
      expect(result._unsafeUnwrapErr()).toMatchObject({
        message: `Withdraw quantity must be a positive integer, received ${quantity}`,
        name: 'InvalidWithdrawQuantityError',
        quantity,
      });
      expect(getBankItems).not.toHaveBeenCalled();
    },
  );

  it('returns a typed Blocker when the bank quantity is insufficient', async () => {
    const { agent, client, moveTo, withdrawItems } = buildDependencies(
      buildCharacter(),
      buildBankPage([{ code: 'copper_dagger', quantity: 1 }]),
    );

    const result = await runWithdrawItemActivity(client, agent, {
      itemCode: 'copper_dagger',
      quantity: 2,
      type: 'withdrawItem',
    });

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BankItemUnavailableError);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      availableQuantity: 1,
      itemCode: 'copper_dagger',
      message: 'Bank holds 1x copper_dagger, but 2x were requested',
      name: 'BankItemUnavailableError',
      requestedQuantity: 2,
    });
    expect(moveTo).not.toHaveBeenCalled();
    expect(withdrawItems).not.toHaveBeenCalled();
  });

  it('ignores unrelated bank items when calculating availability', async () => {
    const { agent, client } = buildDependencies(
      buildCharacter(),
      buildBankPage([
        { code: 'iron_ore', quantity: 100 },
        { code: 'copper_dagger', quantity: 1 },
      ]),
    );

    const result = await runWithdrawItemActivity(client, agent, {
      itemCode: 'copper_dagger',
      quantity: 2,
      type: 'withdrawItem',
    });

    expect(result._unsafeUnwrapErr()).toMatchObject({ availableQuantity: 1 });
  });

  it('returns a typed Blocker when the inventory lacks room', async () => {
    const character = buildCharacter({
      inventory: [{ code: 'copper_ore', quantity: 20, slot: 1 }],
      inventory_max_items: 20,
    });
    const { agent, client, moveTo, withdrawItems } =
      buildDependencies(character);

    const result = await runWithdrawItemActivity(client, agent, {
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'withdrawItem',
    });

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      WithdrawInventoryFullError,
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      availableSpace: 0,
      itemCode: 'copper_dagger',
      message:
        'Inventory has room for 0 item(s), but withdrawing 1x copper_dagger was requested',
      name: 'WithdrawInventoryFullError',
      requestedQuantity: 1,
    });
    expect(moveTo).not.toHaveBeenCalled();
    expect(withdrawItems).not.toHaveBeenCalled();
  });

  it('returns a location Blocker when no bank map exists', async () => {
    const { agent, client, moveTo, withdrawItems } = buildDependencies(
      buildCharacter(),
      buildBankPage(),
      buildMapPage([]),
    );

    const result = await runWithdrawItemActivity(client, agent, {
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'withdrawItem',
    });

    expect(result._unsafeUnwrapErr()).toEqual(
      new LocationNotFoundError('bank', 'bank'),
    );
    expect(moveTo).not.toHaveBeenCalled();
    expect(withdrawItems).not.toHaveBeenCalled();
  });

  it('propagates an API failure while reading the bank', async () => {
    const apiError = new ArtifactsApiError('unavailable', 503, {});
    const { agent, client, withdrawItems } = buildDependencies(
      buildCharacter(),
      buildBankPage(),
      buildMapPage(),
      apiError,
    );

    const result = await runWithdrawItemActivity(client, agent, {
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'withdrawItem',
    });

    expect(result._unsafeUnwrapErr()).toBe(apiError);
    expect(withdrawItems).not.toHaveBeenCalled();
  });

  it('propagates a withdrawal Action failure', async () => {
    const apiError = new ArtifactsApiError('conflict', 478, {});
    const { agent, client, withdrawItems } = buildDependencies(
      buildCharacter(),
      buildBankPage(),
      buildMapPage(),
      undefined,
      apiError,
    );

    const result = await runWithdrawItemActivity(client, agent, {
      itemCode: 'copper_dagger',
      quantity: 1,
      type: 'withdrawItem',
    });

    expect(result._unsafeUnwrapErr()).toBe(apiError);
    expect(withdrawItems).toHaveBeenCalledWith([
      { code: 'copper_dagger', quantity: 1 },
    ]);
  });
});
