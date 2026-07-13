import { okAsync, type ResultAsync } from "neverthrow";

import type { ArtifactsApiError } from "../client/index.js";
import { logger } from "../utils/logger.js";
import type { CharacterAgent } from "./characters/characterAgent.js";

type CombatAgent = Pick<CharacterAgent, "fight" | "getCharacter" | "rest">;
type FightOutcome =
  ReturnType<CombatAgent["fight"]> extends ResultAsync<infer T, unknown> ? T : never;

const ELEMENTS = ["air", "earth", "fire", "water"] as const;
type Element = (typeof ELEMENTS)[number];

// Characters have %damage bonuses (from rings/amulets, typically); monsters
// don't, so these are optional here and simply treated as 0 for monsters.
type OffensiveStats = {
  readonly [K in `attack_${Element}`]: number;
} & {
  readonly [K in `dmg_${Element}`]?: number;
} & {
  readonly critical_strike: number;
  readonly dmg?: number;
};

type DefensiveStats = {
  readonly [K in `res_${Element}`]: number;
};

type CombatStats = DefensiveStats & OffensiveStats & { readonly hp: number };

/**
 * Average damage `attacker` deals to `defender` in one turn: per element,
 * their attack stat (boosted by their `dmg`/`dmg_<element>` % bonuses, if
 * any) mitigated by the defender's resistance to that element, summed
 * across all four elements, then scaled up by the attacker's average
 * critical-strike bonus (a `critical_strike`% chance of +50% damage).
 */
const averageDamagePerTurn = (attacker: OffensiveStats, defender: DefensiveStats): number => {
  const rawDamage = ELEMENTS.reduce((total, element) => {
    const dmgBonus = (attacker.dmg ?? 0) + (attacker[`dmg_${element}`] ?? 0);
    const boostedAttack = attacker[`attack_${element}`] * (1 + dmgBonus / 100);
    const mitigated = boostedAttack * (1 - defender[`res_${element}`] / 100);

    return total + Math.max(0, mitigated);
  }, 0);

  return rawDamage * (1 + (0.5 * attacker.critical_strike) / 100);
};

/**
 * A rough (not an exact combat simulation) heuristic for whether fighting
 * `monster` is worth attempting: estimates how many turns each side would
 * need to defeat the other from average damage output, and requires the
 * character to win comfortably faster than it would lose - killing in at
 * most half the turns it'd take to die - to leave margin for the variance
 * this model doesn't capture (crit streaks, roll luck, ...). Turn order/
 * initiative is deliberately ignored.
 */
export const isSafeToFight = (character: CombatStats, monster: CombatStats): boolean => {
  const characterDamagePerTurn = averageDamagePerTurn(character, monster);
  const monsterDamagePerTurn = averageDamagePerTurn(monster, character);

  if (characterDamagePerTurn <= 0) {
    return false;
  }

  if (monsterDamagePerTurn <= 0) {
    return true;
  }

  const turnsToKill = monster.hp / characterDamagePerTurn;
  const turnsToDie = character.hp / monsterDamagePerTurn;

  return turnsToKill <= turnsToDie / 2;
};

// Rest unless HP is strictly above this fraction of max HP. A fight can
// deal up to roughly this same fraction in damage, so resting only when
// strictly above (not at-or-above) the threshold keeps a fight from ever
// landing exactly on 0 HP - which happened in practice when this was `>=`.
const REST_THRESHOLD_RATIO = 0.5;

const restIfLow = (
  agent: Pick<CombatAgent, "getCharacter" | "rest">,
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
 * participants - solo fights only), logging a warning if the fight is
 * lost. Callers decide what "done" means (inventory full, enough of an
 * item held, ...) and loop accordingly.
 */
export const fightSafely = (agent: CombatAgent): ResultAsync<FightOutcome, ArtifactsApiError> =>
  restIfLow(agent)
    .andThen(() => agent.fight())
    .map((result) => {
      if (result.fight.result === "loss") {
        logger.warn(
          { character: agent.getCharacter().name, opponent: result.fight.opponent },
          `${agent.getCharacter().name}: lost a fight against ${result.fight.opponent}`,
        );
      }

      return result;
    });
