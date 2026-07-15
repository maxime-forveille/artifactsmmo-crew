import type { ResultAsync } from "neverthrow";

/**
 * Wraps `fn` so that, for the lifetime of the returned function, calls with
 * the same arguments (compared via `keyFor`) only ever call `fn` once and
 * share its result - meant for read-only endpoints whose data is static for
 * as long as the bot process runs (item/monster/resource/map catalogs),
 * where re-fetching the exact same query every cycle wastes a real request
 * against the account's hourly rate limit for no benefit (see
 * `client/index.ts`'s rate limiter).
 *
 * Only successful results are cached - a failed attempt (a transient
 * network issue, a rate limit, ...) is evicted immediately so the very
 * next call retries for real, rather than replaying the same failure
 * forever.
 */
export const memoizeAsync = <Args extends readonly unknown[], T, E>(
  fn: (...args: Args) => ResultAsync<T, E>,
  keyFor: (...args: Args) => string,
): ((...args: Args) => ResultAsync<T, E>) => {
  const cache = new Map<string, ResultAsync<T, E>>();

  return (...args: Args): ResultAsync<T, E> => {
    const key = keyFor(...args);
    const cached = cache.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const entry = fn(...args);
    cache.set(key, entry);
    entry.mapErr((error) => {
      cache.delete(key);
      return error;
    });

    return entry;
  };
};

type TtlMemoizedAsync<Args extends readonly unknown[], T, E> = ((
  ...args: Args
) => ResultAsync<T, E>) & {
  clear: () => void;
};

/**
 * Like `memoizeAsync`, but only reuses successful calls for `ttlMs`. It is
 * intended for dynamic GET endpoints whose value can be slightly stale but
 * must not be fetched every task cycle. `clear` is for callers that know an
 * action has changed the remote state before the TTL elapses.
 */
export const memoizeAsyncWithTtl = <Args extends readonly unknown[], T, E>(
  fn: (...args: Args) => ResultAsync<T, E>,
  keyFor: (...args: Args) => string,
  ttlMs: number,
): TtlMemoizedAsync<Args, T, E> => {
  const cache = new Map<string, { expiresAt: number; result: ResultAsync<T, E> }>();

  const memoized = (...args: Args): ResultAsync<T, E> => {
    const key = keyFor(...args);
    const cached = cache.get(key);

    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    const result = fn(...args);
    cache.set(key, { expiresAt: Date.now() + ttlMs, result });
    result.mapErr((error) => {
      if (cache.get(key)?.result === result) {
        cache.delete(key);
      }
      return error;
    });

    return result;
  };

  memoized.clear = () => {
    cache.clear();
  };

  return memoized;
};
