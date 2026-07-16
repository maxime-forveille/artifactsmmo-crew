import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRateLimiter } from '../src/client/rateLimiter.js';

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows the first request through immediately', async () => {
    const limiter = createRateLimiter([{ limit: 3, windowMs: 1_000 }]);

    await limiter.acquire();

    expect(Date.now()).toBe(new Date('2024-01-01T00:00:00.000Z').getTime());
  });

  it("paces subsequent requests at least windowMs/limit apart, even under the window's capacity", async () => {
    // limit 4 per 1s => at least 250ms between each request.
    const limiter = createRateLimiter([{ limit: 4, windowMs: 1_000 }]);
    const onResolved = vi.fn();

    await limiter.acquire();
    void limiter.acquire().then(onResolved);

    await vi.advanceTimersByTimeAsync(249);
    expect(onResolved).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it('never releases more than one queued request at the same instant', async () => {
    // limit 8 per 1s => 125ms spacing. Queue well beyond the window's
    // capacity and check no two requests ever resolve at the same tick.
    const limiter = createRateLimiter([{ limit: 8, windowMs: 1_000 }]);
    const resolvedAt: number[] = [];

    const pending = Array.from({ length: 12 }, () =>
      limiter.acquire().then(() => resolvedAt.push(Date.now())),
    );

    await vi.advanceTimersByTimeAsync(12 * 125);
    await Promise.all(pending);

    const uniqueTimestamps = new Set(resolvedAt);
    expect(uniqueTimestamps.size).toBe(resolvedAt.length);
  });

  it('delays the request that would exceed the window until it clears', async () => {
    const limiter = createRateLimiter([{ limit: 2, windowMs: 1_000 }]);
    const onResolved = vi.fn();

    await limiter.acquire();
    await vi.advanceTimersByTimeAsync(500); // clear the per-request pacing gap
    await limiter.acquire();

    void limiter.acquire().then(onResolved);
    await vi.advanceTimersByTimeAsync(499);
    expect(onResolved).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it('enforces the tightest of several simultaneous windows', async () => {
    const limiter = createRateLimiter([
      { limit: 10, windowMs: 1_000 },
      { limit: 2, windowMs: 60_000 },
    ]);
    const onResolved = vi.fn();

    await limiter.acquire();
    await vi.advanceTimersByTimeAsync(100); // clear the per-request pacing gap
    await limiter.acquire();

    // The per-second window (10) has room, but the per-minute window (2) is full.
    void limiter.acquire().then(onResolved);
    await vi.advanceTimersByTimeAsync(59_899);
    expect(onResolved).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });
});
