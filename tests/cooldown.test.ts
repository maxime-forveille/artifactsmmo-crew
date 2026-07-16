import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { msUntilExpiration, waitUntil } from '../src/utils/cooldown.js';

describe('msUntilExpiration', () => {
  it('returns the remaining milliseconds until expiration', () => {
    const now = new Date('2024-01-01T00:00:00.000Z');

    expect(msUntilExpiration('2024-01-01T00:00:12.345Z', now)).toBe(12_345);
  });

  it('clamps to 0 when the timestamp already passed', () => {
    const now = new Date('2024-01-01T00:00:10.000Z');

    expect(msUntilExpiration('2024-01-01T00:00:05.000Z', now)).toBe(0);
  });

  it('defaults `now` to the current time when not provided', () => {
    const expiresAt = new Date(Date.now() + 5_000).toISOString();

    const remaining = msUntilExpiration(expiresAt);

    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5_000);
  });
});

describe('waitUntil', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when the timestamp already passed', async () => {
    vi.setSystemTime(new Date('2024-01-01T00:00:10.000Z'));
    const onResolved = vi.fn();

    void waitUntil('2024-01-01T00:00:05.000Z').then(onResolved);
    await vi.advanceTimersByTimeAsync(0);

    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it('waits until the timestamp passes before resolving', async () => {
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    const onResolved = vi.fn();

    void waitUntil('2024-01-01T00:00:05.000Z').then(onResolved);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(onResolved).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });
});
