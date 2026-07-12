import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRateLimiter } from "../src/client/rateLimiter.js";

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to the limit without waiting", async () => {
    const limiter = createRateLimiter([{ limit: 3, windowMs: 1_000 }]);

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    // No timer was needed to resolve the 3 calls above; still at t=0.
    expect(Date.now()).toBe(new Date("2024-01-01T00:00:00.000Z").getTime());
  });

  it("delays the request that would exceed the window until it clears", async () => {
    const limiter = createRateLimiter([{ limit: 2, windowMs: 1_000 }]);
    const onResolved = vi.fn();

    await limiter.acquire();
    await limiter.acquire();

    void limiter.acquire().then(onResolved);
    await vi.advanceTimersByTimeAsync(999);
    expect(onResolved).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("enforces the tightest of several simultaneous windows", async () => {
    const limiter = createRateLimiter([
      { limit: 10, windowMs: 1_000 },
      { limit: 2, windowMs: 60_000 },
    ]);
    const onResolved = vi.fn();

    await limiter.acquire();
    await limiter.acquire();

    // The per-second window (10) has room, but the per-minute window (2) is full.
    void limiter.acquire().then(onResolved);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(onResolved).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });
});
