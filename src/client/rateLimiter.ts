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
 * per-second, per-minute, and per-hour cap on the same bucket). Every call to
 * `acquire()` waits (if needed) until none of the windows would be exceeded,
 * then records the request.
 */
export const createRateLimiter = (windows: readonly RateLimitWindow[]): RateLimiter => {
  const timestamps: number[] = [];

  const msUntilAllowed = (now: number): number =>
    windows.reduce((waitMs, window) => {
      const windowStart = now - window.windowMs;
      const inWindow = timestamps.filter((timestamp) => timestamp > windowStart);

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
      const waitMs = msUntilAllowed(now);

      if (waitMs <= 0) {
        timestamps.push(now);
        prune(now);
        return;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  };

  return { acquire };
};
