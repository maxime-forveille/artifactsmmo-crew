import { okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  findBestCombatGear,
  findBestGatheringTool,
  findCombatGearUpgrades,
} from '../src/bot/gear.js';
import type { components } from '../src/client/schema.js';

type Character = components['schemas']['CharacterSchema'];
type Item = components['schemas']['ItemSchema'];
type ItemPage = {
  data: Item[];
  page: number;
  pages: number;
  size: number;
  total: number;
};
type Monster = components['schemas']['MonsterSchema'];

const buildItem = (overrides: Partial<Item>): Item => ({
  ...({} as Item),
  ...overrides,
});

const buildItemPage = (data: Item[]): ItemPage => ({
  data,
  page: 1,
  pages: 1,
  size: 100,
  total: data.length,
});

// Full set of combat stats needed by averageDamagePerTurn, all zeroed out by
// default so tests can override just the fields they care about.
const buildCharacter = (overrides: Partial<Character> = {}): Character =>
  ({
    amulet_slot: '',
    attack_air: 0,
    attack_earth: 0,
    attack_fire: 0,
    attack_water: 0,
    body_armor_slot: '',
    boots_slot: '',
    critical_strike: 0,
    dmg: 0,
    dmg_air: 0,
    dmg_earth: 0,
    dmg_fire: 0,
    dmg_water: 0,
    helmet_slot: '',
    hp: 100,
    leg_armor_slot: '',
    level: 1,
    res_air: 0,
    res_earth: 0,
    res_fire: 0,
    res_water: 0,
    ring1_slot: '',
    shield_slot: '',
    weapon_slot: '',
    ...overrides,
  }) as Character;

const buildMonster = (overrides: Partial<Monster> = {}): Monster =>
  ({
    attack_air: 0,
    attack_earth: 0,
    attack_fire: 0,
    attack_water: 0,
    code: 'chicken',
    critical_strike: 0,
    hp: 60,
    level: 1,
    res_air: 0,
    res_earth: 0,
    res_fire: 0,
    res_water: 0,
    ...overrides,
  }) as Monster;

describe('findBestGatheringTool', () => {
  it('picks the weapon with the largest cooldown reduction for the given skill', async () => {
    const weakPickaxe = buildItem({
      code: 'weak_pickaxe',
      effects: [{ code: 'mining', description: '', value: -5 }],
    });
    const strongPickaxe = buildItem({
      code: 'strong_pickaxe',
      effects: [{ code: 'mining', description: '', value: -20 }],
    });
    const unrelatedWeapon = buildItem({
      code: 'copper_dagger',
      effects: [{ code: 'critical_strike', description: '', value: 35 }],
    });
    const getItems = vi.fn(() =>
      okAsync(buildItemPage([weakPickaxe, unrelatedWeapon, strongPickaxe])),
    );

    const result = await findBestGatheringTool({ getItems }, 'mining', 5);

    expect(getItems).toHaveBeenCalledWith({
      max_level: 5,
      size: 100,
      type: 'weapon',
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()?.code).toBe('strong_pickaxe');
  });

  it('returns undefined when no weapon grants the requested skill', async () => {
    const unrelatedWeapon = buildItem({
      code: 'copper_dagger',
      effects: [{ code: 'critical_strike', description: '', value: 35 }],
    });
    const getItems = vi.fn(() => okAsync(buildItemPage([unrelatedWeapon])));

    const result = await findBestGatheringTool({ getItems }, 'woodcutting', 5);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeUndefined();
  });

  it('ignores a matching effect with a non-negative value', async () => {
    const notActuallyAReduction = buildItem({
      code: 'weird_tool',
      effects: [{ code: 'fishing', description: '', value: 5 }],
    });
    const getItems = vi.fn(() =>
      okAsync(buildItemPage([notActuallyAReduction])),
    );

    const result = await findBestGatheringTool({ getItems }, 'fishing', 5);

    expect(result._unsafeUnwrap()).toBeUndefined();
  });
});

describe('findBestCombatGear', () => {
  describe('weapon slot', () => {
    it("picks the weapon that deals the most damage against the monster's weakest resistance", async () => {
      const character = buildCharacter({ weapon_slot: '' });
      const monster = buildMonster({ res_air: 80, res_earth: 0 });
      const airWeapon = buildItem({
        code: 'air_weapon',
        effects: [{ code: 'attack_air', description: '', value: 20 }],
      });
      const earthWeapon = buildItem({
        code: 'earth_weapon',
        effects: [{ code: 'attack_earth', description: '', value: 20 }],
      });
      const getItems = vi.fn(() =>
        okAsync(buildItemPage([airWeapon, earthWeapon])),
      );
      const getItem = vi.fn();

      const result = await findBestCombatGear(
        { getItem, getItems },
        character,
        monster,
        'weapon',
        5,
      );

      expect(getItem).not.toHaveBeenCalled();
      expect(getItems).toHaveBeenCalledWith({
        max_level: 5,
        size: 100,
        type: 'weapon',
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()?.code).toBe('earth_weapon');
    });

    it("removes the currently equipped weapon's own contribution before comparing candidates", async () => {
      // The character's attack_earth (30) already includes the equipped
      // weak_earth_weapon's +10; findBestCombatGear must not double-count
      // that when it re-adds strong_earth_weapon's own +25.
      const character = buildCharacter({
        attack_earth: 30,
        weapon_slot: 'weak_earth_weapon',
      });
      const monster = buildMonster();
      const equippedWeapon = buildItem({
        code: 'weak_earth_weapon',
        effects: [{ code: 'attack_earth', description: '', value: 10 }],
      });
      const strongerWeapon = buildItem({
        code: 'strong_earth_weapon',
        effects: [{ code: 'attack_earth', description: '', value: 25 }],
      });
      const getItem = vi.fn(() => okAsync({ data: equippedWeapon }));
      const getItems = vi.fn(() =>
        okAsync(buildItemPage([equippedWeapon, strongerWeapon])),
      );

      const result = await findBestCombatGear(
        { getItem, getItems },
        character,
        monster,
        'weapon',
        5,
      );

      expect(getItem).toHaveBeenCalledWith('weak_earth_weapon');
      expect(result._unsafeUnwrap()?.code).toBe('strong_earth_weapon');
    });

    it('returns undefined when nothing found deals any damage', async () => {
      const character = buildCharacter();
      const monster = buildMonster({
        res_air: 100,
        res_earth: 100,
        res_fire: 100,
        res_water: 100,
      });
      const uselessWeapon = buildItem({
        code: 'useless_weapon',
        effects: [{ code: 'attack_fire', description: '', value: 5 }],
      });
      const getItem = vi.fn();
      const getItems = vi.fn(() => okAsync(buildItemPage([uselessWeapon])));

      const result = await findBestCombatGear(
        { getItem, getItems },
        character,
        monster,
        'weapon',
        5,
      );

      expect(result._unsafeUnwrap()).toBeUndefined();
    });

    it('still ranks candidates by damage output when the monster can never deal damage back', async () => {
      // Regression: combatMargin saturates towards "infinitely safe" when
      // the monster can't hit back at all, which must not collapse every
      // candidate to the same score - the harder-hitting one should still
      // win instead of just whichever came first in the list.
      const character = buildCharacter({ attack_earth: 10, weapon_slot: '' });
      const monster = buildMonster(); // 0 attack in every element
      const weakWeapon = buildItem({
        code: 'weak_weapon',
        effects: [{ code: 'attack_earth', description: '', value: 1 }],
      });
      const strongWeapon = buildItem({
        code: 'strong_weapon',
        effects: [{ code: 'attack_earth', description: '', value: 50 }],
      });
      const getItem = vi.fn();
      const getItems = vi.fn(() =>
        okAsync(buildItemPage([weakWeapon, strongWeapon])),
      );

      const result = await findBestCombatGear(
        { getItem, getItems },
        character,
        monster,
        'weapon',
        5,
      );

      expect(result._unsafeUnwrap()?.code).toBe('strong_weapon');
    });
  });

  describe('helmet slot', () => {
    it('picks the helmet with the best hp/damage contribution', async () => {
      const character = buildCharacter({ attack_earth: 10, helmet_slot: '' });
      const monster = buildMonster({ attack_earth: 5 });
      const basicHelmet = buildItem({
        code: 'basic_helmet',
        effects: [{ code: 'hp', description: '', value: 10 }],
      });
      const betterHelmet = buildItem({
        code: 'better_helmet',
        effects: [
          { code: 'hp', description: '', value: 30 },
          { code: 'dmg', description: '', value: 5 },
        ],
      });
      const getItem = vi.fn();
      const getItems = vi.fn(() =>
        okAsync(buildItemPage([basicHelmet, betterHelmet])),
      );

      const result = await findBestCombatGear(
        { getItem, getItems },
        character,
        monster,
        'helmet',
        5,
      );

      expect(getItems).toHaveBeenCalledWith({
        max_level: 5,
        size: 100,
        type: 'helmet',
      });
      expect(result._unsafeUnwrap()?.code).toBe('better_helmet');
    });

    it("removes the currently equipped helmet's own contribution before comparing candidates", async () => {
      const character = buildCharacter({
        attack_earth: 10,
        helmet_slot: 'old_helmet',
        hp: 110,
      });
      const monster = buildMonster({ attack_earth: 5 });
      const oldHelmet = buildItem({
        code: 'old_helmet',
        effects: [{ code: 'hp', description: '', value: 10 }],
      });
      const newHelmet = buildItem({
        code: 'new_helmet',
        effects: [{ code: 'hp', description: '', value: 40 }],
      });
      const getItem = vi.fn(() => okAsync({ data: oldHelmet }));
      const getItems = vi.fn(() =>
        okAsync(buildItemPage([oldHelmet, newHelmet])),
      );

      const result = await findBestCombatGear(
        { getItem, getItems },
        character,
        monster,
        'helmet',
        5,
      );

      expect(getItem).toHaveBeenCalledWith('old_helmet');
      expect(result._unsafeUnwrap()?.code).toBe('new_helmet');
    });
  });

  it('returns undefined when the catalog for the slot is empty', async () => {
    const getItem = vi.fn();
    const getItems = vi.fn(() => okAsync(buildItemPage([])));

    const result = await findBestCombatGear(
      { getItem, getItems },
      buildCharacter({ attack_earth: 10 }),
      buildMonster(),
      'shield',
      5,
    );

    expect(result._unsafeUnwrap()).toBeUndefined();
  });
});

describe('findCombatGearUpgrades', () => {
  it("only reports slots where the best pick differs from what's already equipped", async () => {
    const character = buildCharacter({
      attack_earth: 10,
      helmet_slot: 'basic_helmet',
      weapon_slot: '',
    });
    const monster = buildMonster({ res_earth: 0 });
    const betterWeapon = buildItem({
      code: 'better_weapon',
      effects: [{ code: 'attack_earth', description: '', value: 20 }],
    });
    const basicHelmet = buildItem({
      code: 'basic_helmet',
      effects: [{ code: 'hp', description: '', value: 10 }],
    });

    const getItem = vi.fn((code: string) =>
      code === 'basic_helmet'
        ? okAsync({ data: basicHelmet })
        : okAsync({ data: buildItem({ code }) }),
    );
    const getItems = vi.fn((query?: { type?: string }) => {
      if (query?.type === 'weapon') {
        return okAsync(buildItemPage([betterWeapon]));
      }
      if (query?.type === 'helmet') {
        return okAsync(buildItemPage([basicHelmet]));
      }
      return okAsync(buildItemPage([]));
    });

    const result = await findCombatGearUpgrades(
      { getItem, getItems },
      character,
      monster,
      5,
    );

    expect(result.isOk() && result.value).toEqual([
      { item: betterWeapon, slot: 'weapon' },
    ]);
  });

  it('reports nothing when no slot has a catalog entry that beats the current gear', async () => {
    const character = buildCharacter();
    const monster = buildMonster();
    const getItem = vi.fn();
    const getItems = vi.fn(() => okAsync(buildItemPage([])));

    const result = await findCombatGearUpgrades(
      { getItem, getItems },
      character,
      monster,
      5,
    );

    expect(result.isOk() && result.value).toEqual([]);
  });
});
