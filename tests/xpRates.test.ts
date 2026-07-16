import { errAsync, okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  observedMonsterXpRates,
  observedMonsterXpRatesOrEmpty,
} from '../src/bot/xpRates.js';
import { ArtifactsApiError } from '../src/client/index.js';
import type { components } from '../src/client/schema.js';

type Log = components['schemas']['LogSchema'];
type LogPage = components['schemas']['DataPage_LogSchema_'];

const buildFightLog = (
  characterName: string,
  opponent: string,
  xp: number,
  cooldownSeconds: number,
): Log =>
  ({
    content: {
      fight: { characters: [{ character_name: characterName, xp }], opponent },
    },
    cooldown: cooldownSeconds,
    type: 'fight',
  }) as unknown as Log;

const buildOtherLog = (type: Log['type']): Log =>
  ({ content: {}, cooldown: 5, type }) as Log;

const buildLogPage = (data: Log[]): LogPage => ({
  data,
  page: 1,
  pages: 1,
  size: 100,
  total: data.length,
});

describe('observedMonsterXpRates', () => {
  it('averages xp/second across every fight found against each opponent', async () => {
    const getCharacterLogs = vi.fn(() =>
      okAsync(
        buildLogPage([
          buildFightLog('Cartman', 'chicken', 6, 30),
          buildFightLog('Cartman', 'chicken', 6, 30),
          buildFightLog('Cartman', 'yellow_slime', 11, 46),
        ]),
      ),
    );

    const result = await observedMonsterXpRates(
      { getCharacterLogs },
      'Cartman',
    );

    expect(getCharacterLogs).toHaveBeenCalledWith('Cartman', { size: 100 });
    const rates = result._unsafeUnwrap();
    expect(rates.get('chicken')).toBeCloseTo(12 / 60);
    expect(rates.get('yellow_slime')).toBeCloseTo(11 / 46);
  });

  it("counts a loss's 0 xp as real data instead of discarding it", async () => {
    const getCharacterLogs = vi.fn(() =>
      okAsync(buildLogPage([buildFightLog('Cartman', 'blue_slime', 0, 48)])),
    );

    const result = await observedMonsterXpRates(
      { getCharacterLogs },
      'Cartman',
    );

    expect(result._unsafeUnwrap().get('blue_slime')).toBe(0);
  });

  it('ignores non-fight log entries and fights belonging to another character', async () => {
    const getCharacterLogs = vi.fn(() =>
      okAsync(
        buildLogPage([
          buildOtherLog('gathering'),
          buildOtherLog('movement'),
          buildFightLog('Stan', 'chicken', 6, 30),
        ]),
      ),
    );

    const result = await observedMonsterXpRates(
      { getCharacterLogs },
      'Cartman',
    );

    expect(result._unsafeUnwrap().size).toBe(0);
  });

  it('ignores fight logs whose untyped content is malformed', async () => {
    const malformedLog = {
      content: null,
      cooldown: 30,
      type: 'fight',
    } as unknown as Log;
    const getCharacterLogs = vi.fn(() => okAsync(buildLogPage([malformedLog])));

    const result = await observedMonsterXpRates(
      { getCharacterLogs },
      'Cartman',
    );

    expect(result._unsafeUnwrap().size).toBe(0);
  });

  it("returns an empty map when there's no fight history at all", async () => {
    const getCharacterLogs = vi.fn(() => okAsync(buildLogPage([])));

    const result = await observedMonsterXpRates(
      { getCharacterLogs },
      'Cartman',
    );

    expect(result._unsafeUnwrap().size).toBe(0);
  });

  it('propagates a log-fetch failure', async () => {
    const apiError = new ArtifactsApiError('boom', 500, undefined);
    const getCharacterLogs = vi.fn(() => errAsync(apiError));

    const result = await observedMonsterXpRates(
      { getCharacterLogs },
      'Cartman',
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(apiError);
  });
});

describe('observedMonsterXpRatesOrEmpty', () => {
  it('degrades a log-fetch failure to an empty map instead of propagating it', async () => {
    const getCharacterLogs = vi.fn(() =>
      errAsync(new ArtifactsApiError('boom', 500, undefined)),
    );

    const result = await observedMonsterXpRatesOrEmpty(
      { getCharacterLogs },
      'Cartman',
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().size).toBe(0);
  });
});
