import { okAsync, type ResultAsync } from 'neverthrow';
import * as v from 'valibot';

import type { ArtifactsApiError, ArtifactsClient } from '../client/index.js';

type LogsClient = Pick<ArtifactsClient, 'getCharacterLogs'>;

const fightLogContentSchema = v.object({
  fight: v.optional(
    v.object({
      characters: v.optional(
        v.array(v.object({ character_name: v.string(), xp: v.number() })),
      ),
      opponent: v.optional(v.string()),
    }),
  ),
});

/** Per-monster-code observed XP-per-second rate. */
export type ObservedMonsterRates = ReadonlyMap<string, number>;

const DEFAULT_SAMPLE_SIZE = 100;

/**
 * Estimates each monster's XP/second rate for `characterName`, from their own
 * recent fight history (`GET /my/logs/{name}`) rather than a guessed formula -
 * the API only reveals a fight's XP after it happens, there's no "XP per
 * monster" field to look up ahead of time. Sums XP and cooldown seconds across
 * every fight found against each opponent in the most recent `sampleSize` log
 * entries (losses count too - 0 XP is real data, not something to discard),
 * then divides. Monsters this character hasn't fought recently are simply
 * absent from the returned map; callers should treat that as "no data yet", not
 * "rate is zero".
 */
export const observedMonsterXpRates = (
  client: LogsClient,
  characterName: string,
  sampleSize: number = DEFAULT_SAMPLE_SIZE,
): ResultAsync<ObservedMonsterRates, ArtifactsApiError> =>
  client.getCharacterLogs(characterName, { size: sampleSize }).map((page) => {
    const totals = new Map<string, { seconds: number; xp: number }>();

    for (const log of page.data) {
      if (log.type !== 'fight') {
        continue;
      }

      const parsedContent = v.safeParse(fightLogContentSchema, log.content);

      if (!parsedContent.success) {
        continue;
      }

      const fight = parsedContent.output.fight;
      const opponent = fight?.opponent;
      const xp = fight?.characters?.find(
        (entry) => entry.character_name === characterName,
      )?.xp;

      if (opponent === undefined || xp === undefined || log.cooldown <= 0) {
        continue;
      }

      const current = totals.get(opponent) ?? { seconds: 0, xp: 0 };
      totals.set(opponent, {
        seconds: current.seconds + log.cooldown,
        xp: current.xp + xp,
      });
    }

    return new Map(
      Array.from(totals, ([code, { seconds, xp }]) => [code, xp / seconds]),
    );
  });

/**
 * Same as `observedMonsterXpRates`, but never fails: a log-fetch error (rate
 * limit, transient API issue, ...) degrades to an empty map instead of blocking
 * whatever decision the rates would have informed. Callers should already have
 * a rate-less fallback (e.g. `findNextSafeMonster`'s highest-level heuristic)
 * for exactly this case.
 */
export const observedMonsterXpRatesOrEmpty = (
  client: LogsClient,
  characterName: string,
  sampleSize?: number,
): ResultAsync<ObservedMonsterRates, never> =>
  observedMonsterXpRates(client, characterName, sampleSize).orElse(() =>
    okAsync(new Map()),
  );
