import type { ResultAsync } from "neverthrow";

import type { ArtifactsApiError, ArtifactsClient } from "../client/index.js";
import type { components } from "../client/schema.js";
import { isSafeToFight } from "./combat.js";
import { type ObservedMonsterRates, observedMonsterXpRatesOrEmpty } from "./xpRates.js";

type Character = components["schemas"]["CharacterSchema"];
type GatheringSkill = components["schemas"]["GatheringSkill"];
type Monster = components["schemas"]["MonsterSchema"];
type Resource = components["schemas"]["ResourceSchema"];

type ProgressionClient = Pick<ArtifactsClient, "getCharacterLogs" | "getMonsters">;
type FarmProgressionClient = Pick<ArtifactsClient, "getResources">;

/** `character`'s level in `skill` (e.g. `mining_level` for `"mining"`). */
export const skillLevel = (character: Character, skill: GatheringSkill): number => {
  switch (skill) {
    case "alchemy": {
      return character.alchemy_level;
    }
    case "fishing": {
      return character.fishing_level;
    }
    case "mining": {
      return character.mining_level;
    }
    case "woodcutting": {
      return character.woodcutting_level;
    }
    default: {
      const exhaustiveCheck: never = skill;
      throw new Error(`Unhandled gathering skill: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
};

/** The highest-level item in `items`, or undefined if the list is empty. */
const highestLevel = <T extends { readonly level: number }>(items: readonly T[]): T | undefined =>
  items.reduce<T | undefined>(
    (best, candidate) => (best === undefined || candidate.level > best.level ? candidate : best),
    undefined,
  );

/**
 * The monster in `monsters` with the best observed XP/second rate (see
 * `xpRates.ts`), among those `rates` actually has data for. Returns
 * undefined if none of `monsters` has been fought recently enough to have
 * a rate yet, so callers can fall back to a different heuristic.
 */
const highestObservedRate = (
  monsters: readonly Monster[],
  rates: ObservedMonsterRates,
): Monster | undefined =>
  monsters
    .filter((monster) => rates.has(monster.code))
    .reduce<Monster | undefined>((best, candidate) => {
      if (best === undefined) {
        return candidate;
      }

      return rates.get(candidate.code)! > rates.get(best.code)! ? candidate : best;
    }, undefined);

/**
 * Finds the best monster to hunt next for `character`, among monsters up
 * to their own level that `isSafeToFight` still allows: whichever has the
 * best observed XP/second rate (see `xpRates.ts`) from this character's
 * own recent fight history, or - when none of the safe candidates have
 * been fought recently enough to have a rate yet - the highest-level one,
 * as a reasonable proxy until real data accumulates. Returns `undefined`
 * if nothing qualifies (e.g. even the weakest monster available isn't
 * safe with the character's current gear) - callers should treat that as
 * a signal to look at upgrading equipment instead.
 */
export const findNextSafeMonster = (
  client: ProgressionClient,
  character: Character,
): ResultAsync<Monster | undefined, ArtifactsApiError> =>
  observedMonsterXpRatesOrEmpty(client, character.name).andThen((rates) =>
    client.getMonsters({ max_level: character.level }).map((page) => {
      const safe = page.data.filter((monster) => isSafeToFight(character, monster));

      return highestObservedRate(safe, rates) ?? highestLevel(safe);
    }),
  );

/**
 * Finds the best resource to gather next for `character` in `skill`: the
 * highest-level resource node at or below the character's own level in
 * that skill. Unlike hunting, there's no "safety" concept for gathering -
 * a gather action can't be lost the way a fight can, and `max_level`
 * already keeps every candidate within what the character's skill level
 * allows - so this is just the highest-level match, no extra heuristic
 * needed. Returns `undefined` if no resource for this skill exists at or
 * below the character's level in it (e.g. a fresh level-1 skill with a
 * gap before the next resource tier).
 */
export const findNextFarmableResource = (
  client: FarmProgressionClient,
  character: Character,
  skill: GatheringSkill,
): ResultAsync<Resource | undefined, ArtifactsApiError> =>
  client
    .getResources({ max_level: skillLevel(character, skill), skill })
    .map((page) => highestLevel(page.data));
