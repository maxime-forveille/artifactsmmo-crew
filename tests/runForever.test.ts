import { okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { runForever } from '../src/bot/tasks/runForever.js';

describe('runForever', () => {
  it('stops without running a cycle when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const cycle = vi.fn(() => okAsync(undefined));

    await runForever('Cartman', 'test cycle', cycle, controller.signal);

    expect(cycle).not.toHaveBeenCalled();
  });

  it('stops after the current cycle once the signal is aborted mid-run', async () => {
    const controller = new AbortController();
    let calls = 0;
    const cycle = vi.fn(() => {
      calls += 1;

      if (calls === 2) {
        controller.abort();
      }

      return okAsync(undefined);
    });

    await runForever('Cartman', 'test cycle', cycle, controller.signal);

    // Aborted during call #2; the next top-of-loop check stops it there,
    // one cycle later than the abort itself (never mid-cycle).
    expect(cycle).toHaveBeenCalledTimes(2);
  });
});
