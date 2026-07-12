import { differenceInMilliseconds, parseISO } from "date-fns";

import type { components } from "../client/schema.js";

export type Cooldown = components["schemas"]["CooldownSchema"];

/**
 * Milliseconds remaining until `cooldown` expires, relative to `now`.
 * Never negative: an already-expired cooldown resolves to 0.
 */
export const msUntilCooldownEnds = (cooldown: Cooldown, now: Date = new Date()): number => {
  const expiresAt = parseISO(cooldown.expiration);
  const remainingMs = differenceInMilliseconds(expiresAt, now);

  return Math.max(0, remainingMs);
};

/** Resolves once `cooldown` has expired. Resolves immediately if it already has. */
export const waitForCooldown = async (cooldown: Cooldown): Promise<void> => {
  const delayMs = msUntilCooldownEnds(cooldown);

  if (delayMs === 0) {
    return;
  }

  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};
