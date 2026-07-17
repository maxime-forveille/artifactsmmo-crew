import { okAsync, type ResultAsync } from 'neverthrow';

import type { ArtifactsApiError } from '../client/index.js';
import type { components } from '../client/schema.js';
import { logger } from '../utils/logger.js';

import type { CharacterAgent } from './runtime/characterAgent.js';

type CombatAgent = Pick<CharacterAgent, 'fight' | 'getCharacter' | 'rest'>;
type FightOutcome =
  ReturnType<CombatAgent['fight']> extends ResultAsync<infer T, unknown>
    ? T
    : never;

const ELEMENTS = ['air', 'earth', 'fire', 'water'] as const;
type Element = (typeof ELEMENTS)[number];

// Characters have %damage bonuses (from rings/amulets, typically); monsters
// don't, so these are optional here and simply treated as 0 for monsters.
export type OffensiveStats = {
  readonly [K in `attack_${Element}`]: number;
} & {
  readonly [K in `dmg_${Element}`]?: number;
} & { readonly critical_strike: number; readonly dmg?: number };

export type DefensiveStats = {
  readonly [K in `res_${Element}`]: number;
};

export type CombatStats = DefensiveStats &
  OffensiveStats & { readonly hp: number };

/**
 * Average damage `attacker` deals to `defender` in one turn: per element, their
 * attack stat (boosted by their `dmg`/`dmg_<element>` % bonuses, if any)
 * mitigated by the defender's resistance to that element, summed across all
 * four elements, then scaled up by the attacker's average critical-strike bonus
 * (a `critical_strike`% chance of +50% damage).
 */
export const averageDamagePerTurn = (
  attacker: OffensiveStats,
  defender: DefensiveStats,
): number => {
  const rawDamage = ELEMENTS.reduce((total, element) => {
    const dmgBonus = (attacker.dmg ?? 0) + (attacker[`dmg_${element}`] ?? 0);
    const boostedAttack = attacker[`attack_${element}`] * (1 + dmgBonus / 100);
    const mitigated = boostedAttack * (1 - defender[`res_${element}`] / 100);

    return total + Math.max(0, mitigated);
  }, 0);

  return rawDamage * (1 + (0.5 * attacker.critical_strike) / 100);
};

/**
 * How favorable a fight between `character` and `monster` looks, as a
 * continuous "safety margin" score (not an exact combat simulation), from the
 * same turns-to-kill/turns-to-die estimate `isSafeToFight` checks against a
 * fixed threshold. Higher is better - both more damage output (fewer turns to
 * kill) and more effective HP/resistance (more turns to survive) raise it. `0`
 * when the character can't deal any damage at all (can never win - also the
 * only case where this returns `0`, so `> 0` is a sound "can this even be
 * attempted" check). When the monster can't deal any damage back (can never
 * lose), the usual `turnsToDie / turnsToKill` ratio would be `Infinity`
 * regardless of how much damage the character deals - collapsing every
 * "perfectly safe" candidate to the same value and losing the ability to rank
 * them by how fast the fight ends. Dividing a large finite constant by
 * `turnsToKill` instead keeps the result comfortably above `isSafeToFight`'s
 * threshold while still favoring whichever candidate kills faster. Used to
 * _rank_ candidates (e.g. equipment choices) against the same monster, not just
 * answer yes/no like `isSafeToFight` does.
 */
export const combatMargin = (
  character: CombatStats,
  monster: CombatStats,
): number => {
  const characterDamagePerTurn = averageDamagePerTurn(character, monster);

  if (characterDamagePerTurn <= 0) {
    return 0;
  }

  const monsterDamagePerTurn = averageDamagePerTurn(monster, character);
  const turnsToKill = monster.hp / characterDamagePerTurn;

  if (monsterDamagePerTurn <= 0) {
    return Number.MAX_VALUE / turnsToKill;
  }

  const turnsToDie = character.hp / monsterDamagePerTurn;

  return turnsToDie / turnsToKill;
};

// The margin required by isSafeToFight: killing in at most half the turns
// it'd take to die, to leave room for the variance this model doesn't
// capture (crit streaks, roll luck, ...).
const SAFE_MARGIN = 2;

/**
 * A rough (not an exact combat simulation) heuristic for whether fighting
 * `monster` is worth attempting: requires the character to win comfortably
 * faster than it would lose (see `combatMargin`). Turn order/initiative is
 * deliberately ignored.
 */
export const isSafeToFight = (
  character: CombatStats,
  monster: CombatStats,
): boolean => combatMargin(character, monster) >= SAFE_MARGIN;

type Character = Readonly<components['schemas']['CharacterSchema']>;
type Monster = Readonly<components['schemas']['MonsterSchema']>;

const afterRest = (character: Character): Character => ({
  ...character,
  hp: character.max_hp,
});

/**
 * Chooses the safest available fighter for one known monster. Combat margin is
 * the primary ordering; character name makes equal margins deterministic.
 */
export const findBestSafeFighter = (
  characters: readonly Character[],
  monster: Monster,
  excludedCharacterNames: ReadonlySet<string> = new Set(),
): Character | undefined =>
  characters
    .filter(
      (character) =>
        !excludedCharacterNames.has(character.name) &&
        isSafeToFight(afterRest(character), monster),
    )
    .reduce<Character | undefined>((best, character) => {
      if (best === undefined) {
        return character;
      }

      const marginDifference =
        combatMargin(afterRest(character), monster) -
        combatMargin(afterRest(best), monster);

      if (marginDifference !== 0) {
        return marginDifference > 0 ? character : best;
      }

      return character.name.localeCompare(best.name) < 0 ? character : best;
    }, undefined);

// Rest unless HP is strictly above this fraction of max HP. A fight can
// deal up to roughly this same fraction in damage, so resting only when
// strictly above (not at-or-above) the threshold keeps a fight from ever
// landing exactly on 0 HP - which happened in practice when this was `>=`.
const REST_THRESHOLD_RATIO = 0.5;

/**
 * Rests if HP is at or below half of max HP - a safety net callers should run
 * regardless of whether they've already picked a next fight, so a character
 * that just barely survived a loss always gets a chance to heal back up.
 * `isSafeToFight`-based target selection can otherwise correctly (if
 * unhelpfully) decide that nothing is safe to fight at critically low HP,
 * leaving a character stuck forever if resting only ever happened inside the
 * fight loop itself (see `runAutoHuntTask`).
 */
export const restIfLow = (
  agent: Pick<CombatAgent, 'getCharacter' | 'rest'>,
): ResultAsync<void, ArtifactsApiError> => {
  const character = agent.getCharacter();

  if (character.hp > character.max_hp * REST_THRESHOLD_RATIO) {
    return okAsync(undefined);
  }

  logger.info(
    { character: character.name, hp: character.hp, maxHp: character.max_hp },
    `${character.name}: HP low, resting before continuing to fight`,
  );

  return agent.rest().map(() => undefined);
};

/**
 * Rests first unless HP is strictly above half, then fights once (no
 * participants - solo fights only), logging a warning if the fight is lost.
 * Callers decide what "done" means (inventory full, enough of an item held,
 * ...) and loop accordingly.
 */
export const fightSafely = (
  agent: CombatAgent,
): ResultAsync<FightOutcome, ArtifactsApiError> =>
  restIfLow(agent)
    .andThen(() => agent.fight())
    .map((result) => {
      if (result.fight.result === 'loss') {
        logger.warn(
          {
            character: agent.getCharacter().name,
            opponent: result.fight.opponent,
          },
          `${agent.getCharacter().name}: lost a fight against ${result.fight.opponent}`,
        );
      }

      return result;
    });
