import type { OrchestratorState } from './orchestratorState.js';

export const reservedBankWithdrawalQuantity = (
  state: OrchestratorState,
  itemCode: string,
): number =>
  state.reservations.reduce(
    (total, reservation) =>
      reservation.activity.type === 'withdrawItem' &&
      reservation.activity.itemCode === itemCode
        ? total + reservation.activity.quantity
        : total,
    0,
  );

export const isBankWithdrawalReserved = (
  state: OrchestratorState,
  itemCode: string,
): boolean =>
  state.reservations.some(
    (reservation) =>
      reservation.activity.type === 'withdrawItem' &&
      reservation.activity.itemCode === itemCode,
  );

export const isItemProductionReserved = (
  state: OrchestratorState,
  itemCode: string,
): boolean =>
  state.reservations.some((reservation) =>
    reservation.produces.some((intent) => intent.itemCode === itemCode),
  );
