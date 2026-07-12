import { differenceInMilliseconds, parseISO } from "date-fns";

import type { components } from "../client/schema.js";

export type Cooldown = components["schemas"]["CooldownSchema"];

/**
 * Milliseconds remaining until `expiresAt` (an ISO date-time string), relative to `now`.
 * Never negative: an already-past timestamp resolves to 0.
 */
export const msUntilExpiration = (expiresAt: string, now: Date = new Date()): number => {
  const remainingMs = differenceInMilliseconds(parseISO(expiresAt), now);

  return Math.max(0, remainingMs);
};

/** Resolves once `expiresAt` has passed. Resolves immediately if it already has. */
export const waitUntil = async (expiresAt: string): Promise<void> => {
  const delayMs = msUntilExpiration(expiresAt);

  if (delayMs === 0) {
    return;
  }

  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};
