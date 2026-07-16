import { describe, expect, it } from 'vitest';

import type {
  OrchestratorState,
  Reservation,
} from '../src/bot/orchestration/orchestratorState.js';
import {
  isBankWithdrawalReserved,
  reservedBankWithdrawalQuantity,
} from '../src/bot/orchestration/reservationIntents.js';

const buildReservation = (activity: Reservation['activity']): Reservation => ({
  activity,
  characterName: 'Cartman',
  consumes: [],
  goalId: 'equip-cartman',
  produces: [],
});

const buildState = (
  reservations: readonly Reservation[],
): OrchestratorState => ({ goals: [], reservations });

describe('reservedBankWithdrawalQuantity', () => {
  it('sums only matching bank withdrawals', () => {
    const state = buildState([
      buildReservation({ itemCode: 'copper_ore', type: 'equipItem' }),
      buildReservation({
        itemCode: 'iron_ore',
        quantity: 7,
        type: 'withdrawItem',
      }),
      buildReservation({
        itemCode: 'copper_ore',
        quantity: 2,
        type: 'withdrawItem',
      }),
      buildReservation({
        itemCode: 'copper_ore',
        quantity: 3,
        type: 'withdrawItem',
      }),
    ]);

    expect(reservedBankWithdrawalQuantity(state, 'copper_ore')).toBe(5);
  });
});

describe('isBankWithdrawalReserved', () => {
  it('rejects a non-withdrawal Activity for the requested item', () => {
    const state = buildState([
      buildReservation({ itemCode: 'copper_ore', type: 'equipItem' }),
    ]);

    expect(isBankWithdrawalReserved(state, 'copper_ore')).toBe(false);
  });

  it('rejects a withdrawal for another item', () => {
    const state = buildState([
      buildReservation({
        itemCode: 'iron_ore',
        quantity: 1,
        type: 'withdrawItem',
      }),
    ]);

    expect(isBankWithdrawalReserved(state, 'copper_ore')).toBe(false);
  });

  it('accepts a withdrawal for the requested item', () => {
    const state = buildState([
      buildReservation({
        itemCode: 'copper_ore',
        quantity: 1,
        type: 'withdrawItem',
      }),
    ]);

    expect(isBankWithdrawalReserved(state, 'copper_ore')).toBe(true);
  });
});
