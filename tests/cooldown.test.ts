import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Cooldown, msUntilCooldownEnds, waitForCooldown } from "../src/utils/cooldown.js";

const buildCooldown = (overrides: Partial<Cooldown> = {}): Cooldown => ({
  expiration: "2024-01-01T00:00:12.345Z",
  reason: "movement",
  remaining_seconds: 12,
  started_at: "2024-01-01T00:00:00.000Z",
  total_seconds: 12,
  ...overrides,
});

describe("msUntilCooldownEnds", () => {
  it("returns the remaining milliseconds until expiration", () => {
    const now = new Date("2024-01-01T00:00:00.000Z");
    const cooldown = buildCooldown({ expiration: "2024-01-01T00:00:12.345Z" });

    expect(msUntilCooldownEnds(cooldown, now)).toBe(12_345);
  });

  it("clamps to 0 when the cooldown already expired", () => {
    const now = new Date("2024-01-01T00:00:10.000Z");
    const cooldown = buildCooldown({ expiration: "2024-01-01T00:00:05.000Z" });

    expect(msUntilCooldownEnds(cooldown, now)).toBe(0);
  });

  it("defaults `now` to the current time when not provided", () => {
    const cooldown = buildCooldown({ expiration: new Date(Date.now() + 5_000).toISOString() });

    const remaining = msUntilCooldownEnds(cooldown);

    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5_000);
  });
});

describe("waitForCooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when the cooldown already expired", async () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:10.000Z"));
    const cooldown = buildCooldown({ expiration: "2024-01-01T00:00:05.000Z" });
    const onResolved = vi.fn();

    void waitForCooldown(cooldown).then(onResolved);
    await vi.advanceTimersByTimeAsync(0);

    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("waits until the cooldown expires before resolving", async () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    const cooldown = buildCooldown({ expiration: "2024-01-01T00:00:05.000Z" });
    const onResolved = vi.fn();

    void waitForCooldown(cooldown).then(onResolved);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(onResolved).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });
});
