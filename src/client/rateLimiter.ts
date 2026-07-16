export type RateLimitWindow = {
  readonly limit: number;
  readonly windowMs: number;
};

export type RateLimiter = {
  /** Resolves once it's safe to send a request without exceeding any window. */
  acquire: () => Promise<void>;
};

/**
 * Sliding-window rate limiter enforcing several limits at once (e.g. a
 * per-second, per-minute, and per-hour cap on the same bucket).
 *
 * On top of the sliding window itself, every request is paced at least
 * `windowMs / limit` apart (using whichever window is shortest, since that's
 * the one a burst release is most likely to violate). Without this, once a
 * window fills up, every caller queued behind it wakes up and sends at the
 * exact same instant the window clears - a "thundering herd" release. That's
 * fragile in practice: this limiter records a request as sent the moment it
 * leaves this process, not when the server receives it, so network latency and
 * jitter can spread a locally-synchronized burst unevenly by the time it
 * reaches the server, tipping it over its own window boundary (confirmed live:
 * an un-paced burst of 17 requests produced a synchronized wave of 9 at the 1s
 * mark, 6 of which got a real 429 back). Steady pacing avoids ever releasing
 * more than one request at a time.
 */
export const createRateLimiter = (
  windows: readonly RateLimitWindow[],
): RateLimiter => {
  const timestamps: number[] = [];
  const shortestWindow = windows.reduce((shortest, window) =>
    window.windowMs < shortest.windowMs ? window : shortest,
  );
  const minSpacingMs = shortestWindow.windowMs / shortestWindow.limit;
  let nextSlotAt = 0;

  const msUntilWindowAllows = (now: number): number =>
    windows.reduce((waitMs, window) => {
      const windowStart = now - window.windowMs;
      const inWindow = timestamps.filter(
        (timestamp) => timestamp > windowStart,
      );

      if (inWindow.length < window.limit) {
        return waitMs;
      }

      const oldest = Math.min(...inWindow);
      return Math.max(waitMs, oldest + window.windowMs - now + 1);
    }, 0);

  const prune = (now: number): void => {
    const maxWindowMs = Math.max(...windows.map((window) => window.windowMs));
    const cutoff = now - maxWindowMs;

    while (timestamps.length > 0 && timestamps[0]! <= cutoff) {
      timestamps.shift();
    }
  };

  const acquire = async (): Promise<void> => {
    for (;;) {
      const now = Date.now();
      const waitMs = Math.max(msUntilWindowAllows(now), nextSlotAt - now);

      if (waitMs <= 0) {
        timestamps.push(now);
        prune(now);
        nextSlotAt = now + minSpacingMs;
        return;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  };

  return { acquire };
};
