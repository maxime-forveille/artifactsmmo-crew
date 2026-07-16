import { okAsync, ResultAsync } from 'neverthrow';

import type { ArtifactsApiError, ArtifactsClient } from '../client/index.js';
import type { components } from '../client/schema.js';

import { combatMargin, type CombatStats } from './combat.js';

type Character = components['schemas']['CharacterSchema'];
type EquipSlot = components['schemas']['ItemSlot'];
type GatheringSkill = components['schemas']['GatheringSkill'];
type Item = components['schemas']['ItemSchema'];
type ItemType = components['schemas']['ItemType'];
type Monster = components['schemas']['MonsterSchema'];

type GearClient = Pick<ArtifactsClient, 'getItems'>;
type CombatGearClient = Pick<ArtifactsClient, 'getItem' | 'getItems'>;

// Only the item types produced by the currently craftable level-1 gear.
// Artifacts/utilities have multiple slots and aren't handled (yet).
export const EQUIP_SLOT_BY_ITEM_TYPE: Partial<Record<string, EquipSlot>> = {
  amulet: 'amulet',
  bag: 'bag',
  body_armor: 'body_armor',
  boots: 'boots',
  helmet: 'helmet',
  leg_armor: 'leg_armor',
  ring: 'ring1',
  rune: 'rune',
  shield: 'shield',
  weapon: 'weapon',
};

// Only the slots `EQUIP_SLOT_BY_ITEM_TYPE` can produce; the rest of the
// `EquipSlot` enum (ring2, artifact1-3, utility1-2) is unused here.
export const SLOT_FIELD: Partial<Record<EquipSlot, keyof Character>> = {
  amulet: 'amulet_slot',
  bag: 'bag_slot',
  body_armor: 'body_armor_slot',
  boots: 'boots_slot',
  helmet: 'helmet_slot',
  leg_armor: 'leg_armor_slot',
  ring1: 'ring1_slot',
  rune: 'rune_slot',
  shield: 'shield_slot',
  weapon: 'weapon_slot',
};

/** The item code currently held in `slot`, or undefined if it's empty. */
export const equippedItemInSlot = (
  character: Character,
  slot: EquipSlot,
): string | undefined => {
  const field = SLOT_FIELD[slot];
  const value = field === undefined ? undefined : character[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/**
 * Equipment slots `findBestCombatGear` knows how to score - the ones whose gear
 * reliably contributes combat-relevant stats (hp, resistances, attack, damage
 * bonuses, crit). `bag` (inventory_space) and `rune`/ artifacts/utilities (no
 * combat stats, or not handled at all - see `EQUIP_SLOT_BY_ITEM_TYPE`) need a
 * different criterion and aren't included here.
 */
export const SUPPORTED_COMBAT_SLOTS = [
  'amulet',
  'body_armor',
  'boots',
  'helmet',
  'leg_armor',
  'ring1',
  'shield',
  'weapon',
] as const;
export type SupportedCombatSlot = (typeof SUPPORTED_COMBAT_SLOTS)[number];

const ITEM_TYPE_BY_EQUIP_SLOT = {
  amulet: 'amulet',
  body_armor: 'body_armor',
  boots: 'boots',
  helmet: 'helmet',
  leg_armor: 'leg_armor',
  ring1: 'ring',
  shield: 'shield',
  weapon: 'weapon',
} satisfies Record<SupportedCombatSlot, ItemType>;

/** The effect value granting `skill` on `item`, or undefined if it has none. */
const gatheringEffectValue = (
  item: Item,
  skill: GatheringSkill,
): number | undefined =>
  item.effects?.find((effect) => effect.code === skill)?.value;

/**
 * Finds the best gathering tool for `skill` (mining/woodcutting/fishing/
 * alchemy) among weapons equippable at `maxLevel` or below. Artifacts MMO
 * models tools as weapons with an effect whose code matches the gathering skill
 * and a negative value (e.g. copper_pickaxe has `{code: "mining", value: -10}`,
 * a 10% gathering cooldown reduction). Picks the item with the largest
 * reduction; returns undefined if no equippable weapon grants one.
 */
export const findBestGatheringTool = (
  client: GearClient,
  skill: GatheringSkill,
  maxLevel: number,
): ResultAsync<Item | undefined, ArtifactsApiError> =>
  client
    .getItems({ max_level: maxLevel, size: 100, type: 'weapon' })
    .map((page) =>
      page.data.reduce<Item | undefined>((best, candidate) => {
        const candidateValue = gatheringEffectValue(candidate, skill);

        if (candidateValue === undefined || candidateValue >= 0) {
          return best;
        }

        const bestValue =
          best === undefined ? undefined : gatheringEffectValue(best, skill);

        return bestValue === undefined || candidateValue < bestValue
          ? candidate
          : best;
      }, undefined),
    );

// Effect codes that map 1:1 onto CombatStats fields - this is how
// Artifacts MMO names equipment effects (e.g. copper_dagger grants
// `{code: "critical_strike", value: 35}`, copper_helmet grants
// `{code: "hp", value: 20}`). Covers every combat-relevant stat any of
// `SUPPORTED_COMBAT_SLOTS` grants, not just weapons - armor mostly
// contributes `hp`/`res_<element>`, weapons mostly `attack_<element>`,
// and rings/amulets/helmets often add `dmg`/`dmg_<element>` on top.
const EQUIPMENT_EFFECT_CODES = [
  'attack_air',
  'attack_earth',
  'attack_fire',
  'attack_water',
  'critical_strike',
  'dmg',
  'dmg_air',
  'dmg_earth',
  'dmg_fire',
  'dmg_water',
  'hp',
  'res_air',
  'res_earth',
  'res_fire',
  'res_water',
] as const;
type EquipmentEffectCode = (typeof EQUIPMENT_EFFECT_CODES)[number];

const isEquipmentEffectCode = (code: string): code is EquipmentEffectCode =>
  (EQUIPMENT_EFFECT_CODES as readonly string[]).includes(code);

/** The subset of `item`'s effects that feed into `combatMargin`. */
const gearContribution = (
  item: Item,
): Partial<Record<EquipmentEffectCode, number>> =>
  Object.fromEntries(
    (item.effects ?? [])
      .filter((effect) => isEquipmentEffectCode(effect.code))
      .map((effect) => [effect.code, effect.value]),
  );

/** `stats` with `contribution` added on top (or removed, when `sign` is -1). */
const withContribution = (
  stats: CombatStats,
  contribution: Partial<Record<EquipmentEffectCode, number>>,
  sign: 1 | -1,
): CombatStats => ({
  attack_air: stats.attack_air + sign * (contribution.attack_air ?? 0),
  attack_earth: stats.attack_earth + sign * (contribution.attack_earth ?? 0),
  attack_fire: stats.attack_fire + sign * (contribution.attack_fire ?? 0),
  attack_water: stats.attack_water + sign * (contribution.attack_water ?? 0),
  critical_strike:
    stats.critical_strike + sign * (contribution.critical_strike ?? 0),
  dmg: (stats.dmg ?? 0) + sign * (contribution.dmg ?? 0),
  dmg_air: (stats.dmg_air ?? 0) + sign * (contribution.dmg_air ?? 0),
  dmg_earth: (stats.dmg_earth ?? 0) + sign * (contribution.dmg_earth ?? 0),
  dmg_fire: (stats.dmg_fire ?? 0) + sign * (contribution.dmg_fire ?? 0),
  dmg_water: (stats.dmg_water ?? 0) + sign * (contribution.dmg_water ?? 0),
  hp: stats.hp + sign * (contribution.hp ?? 0),
  res_air: stats.res_air + sign * (contribution.res_air ?? 0),
  res_earth: stats.res_earth + sign * (contribution.res_earth ?? 0),
  res_fire: stats.res_fire + sign * (contribution.res_fire ?? 0),
  res_water: stats.res_water + sign * (contribution.res_water ?? 0),
});

/**
 * Read-only scan across every `SUPPORTED_COMBAT_SLOTS`: reports which slots
 * have a better item available for `monster`, without equipping (or even
 * crafting) anything - the detect-only counterpart to `findBestCombatGear`,
 * meant for a future decision layer to ask "is there any upgrade at all" before
 * committing to fetching/crafting one (see the README's "Automated progression
 * decisions").
 *
 * A slot is only included when `findBestCombatGear` picks something _different_
 * from what's already equipped there - `findBestCombatGear` can return the
 * currently-equipped item itself (e.g. when nothing beats it), which isn't an
 * upgrade worth reporting.
 *
 * Runs every slot's lookup in parallel (`ResultAsync.combine`): unlike the
 * actual craft/equip pipeline (`taskRunners.ts`'s
 * `equipAllCombatGearIfAvailable`), this never mutates the character, so
 * there's no ordering constraint between slots and no reason to serialize the
 * requests. Kept as a separate function rather than reused by that pipeline:
 * the pipeline recomputes each slot immediately before acting on it, on
 * purpose, since equipping one slot (e.g. a helmet's hp) changes the
 * character's stats and so the ideal pick for slots checked after it - a batch
 * computed once upfront, like this one, would go stale mid-loop.
 */
export const findCombatGearUpgrades = (
  client: CombatGearClient,
  character: Character,
  monster: Monster,
  maxLevel: number,
): ResultAsync<
  readonly { readonly item: Item; readonly slot: SupportedCombatSlot }[],
  ArtifactsApiError
> =>
  ResultAsync.combine(
    SUPPORTED_COMBAT_SLOTS.map((slot) =>
      findBestCombatGear(client, character, monster, slot, maxLevel).map(
        (item) => ({ item, slot }),
      ),
    ),
  ).map((results) =>
    results.filter(
      (result): result is { item: Item; slot: SupportedCombatSlot } =>
        result.item !== undefined &&
        result.item.code !== equippedItemInSlot(character, result.slot),
    ),
  );

/**
 * Finds the best item for `slot` (any of `SUPPORTED_COMBAT_SLOTS`) when
 * fighting `monster`, among items equippable at `maxLevel` or below.
 * Generalizes what used to be weapon-only selection: starts from `character`'s
 * stats with their _currently_ equipped item in `slot` removed (so it's
 * compared on equal footing with every other candidate, not double-counted),
 * adds each candidate's contribution back in, and picks whichever yields the
 * highest `combatMargin` against `monster` - the same continuous safety-margin
 * score `isSafeToFight` uses a threshold on, so armor (hp/resistances) and
 * weapons (attack/dmg/crit) are ranked on one consistent scale instead of
 * needing per-slot ad hoc weights. Returns undefined if the catalog for this
 * slot is empty, or if every candidate would still leave the character unable
 * to deal any damage at all (`combatMargin` of exactly `0`) - equipping such an
 * item would never be worth it regardless of its other stats.
 *
 * Note: this only reasons about stats that feed into the damage model (see
 * `EQUIPMENT_EFFECT_CODES`) - non-combat effects some gear also grants
 * (`wisdom`, `prospecting`, `haste`, ...) aren't weighed at all, a documented
 * simplification like `isSafeToFight`'s ignored initiative.
 */
export const findBestCombatGear = (
  client: CombatGearClient,
  character: Character,
  monster: Monster,
  slot: SupportedCombatSlot,
  maxLevel: number,
): ResultAsync<Item | undefined, ArtifactsApiError> => {
  const currentItemCode = equippedItemInSlot(character, slot);

  const currentItem$: ResultAsync<Item | undefined, ArtifactsApiError> =
    currentItemCode === undefined
      ? okAsync(undefined)
      : client.getItem(currentItemCode).map((response) => response.data);

  return currentItem$.andThen((currentItem) => {
    const baseStats = withContribution(
      character,
      currentItem === undefined ? {} : gearContribution(currentItem),
      -1,
    );

    return client
      .getItems({
        max_level: maxLevel,
        size: 100,
        type: ITEM_TYPE_BY_EQUIP_SLOT[slot],
      })
      .map((page) => {
        const ranked = page.data.map((candidate) => ({
          item: candidate,
          margin: combatMargin(
            withContribution(baseStats, gearContribution(candidate), 1),
            monster,
          ),
        }));

        return ranked.reduce<
          { readonly item: Item; readonly margin: number } | undefined
        >(
          (best, candidate) =>
            candidate.margin > 0 &&
            (best === undefined || candidate.margin > best.margin)
              ? candidate
              : best,
          undefined,
        )?.item;
      });
  });
};
