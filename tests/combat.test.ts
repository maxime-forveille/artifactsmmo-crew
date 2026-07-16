import { okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { combatMargin, fightSafely, isSafeToFight } from '../src/bot/combat.js';
import type { components } from '../src/client/schema.js';

type CharacterSnapshot = components['schemas']['CharacterSchema'];
type Cooldown = components['schemas']['CooldownSchema'];
type FightResult = components['schemas']['FightResult'];

const buildCooldown = (): Cooldown => ({
  expiration: '2024-01-01T00:00:05.000Z',
  reason: 'fight',
  remaining_seconds: 5,
  started_at: '2024-01-01T00:00:00.000Z',
  total_seconds: 5,
});

const buildCharacter = (
  overrides: Partial<CharacterSnapshot> = {},
): CharacterSnapshot => ({
  ...({} as CharacterSnapshot),
  hp: 100,
  max_hp: 100,
  name: 'Cartman',
  ...overrides,
});

const buildFightResult = (
  result: FightResult,
  character: CharacterSnapshot,
) => ({
  character,
  characters: [],
  cooldown: buildCooldown(),
  fight: { characters: [], logs: [], opponent: 'chicken', result, turns: 3 },
});

type CombatStats = Parameters<typeof isSafeToFight>[0];

const buildStats = (overrides: Partial<CombatStats> = {}): CombatStats => ({
  attack_air: 0,
  attack_earth: 0,
  attack_fire: 0,
  attack_water: 0,
  critical_strike: 0,
  hp: 100,
  res_air: 0,
  res_earth: 0,
  res_fire: 0,
  res_water: 0,
  ...overrides,
});

describe('isSafeToFight', () => {
  it('is safe when the character kills well before it would die', () => {
    const character = buildStats({ attack_earth: 20, hp: 150 });
    const monster = buildStats({ attack_water: 4, hp: 60 });

    // 60/20 = 3 turns to kill; 150/4 = 37.5 turns to die - comfortably safe.
    expect(isSafeToFight(character, monster)).toBe(true);
  });

  it("is not safe when the character would take too long relative to how fast it'd die", () => {
    const character = buildStats({ attack_earth: 4, hp: 60 });
    const monster = buildStats({ attack_earth: 15, hp: 120, res_earth: 0 });

    // 120/4 = 30 turns to kill; 60/15 = 4 turns to die - way too slow.
    expect(isSafeToFight(character, monster)).toBe(false);
  });

  it('is exactly at the safety boundary when turnsToKill equals half of turnsToDie', () => {
    // turnsToKill = 100/10 = 10; turnsToDie = 100/5 = 20; 10 <= 20/2 (10) - safe.
    const character = buildStats({ attack_earth: 10, hp: 100 });
    const monster = buildStats({ attack_earth: 5, hp: 100 });

    expect(isSafeToFight(character, monster)).toBe(true);
  });

  it('is not safe just past the boundary', () => {
    // turnsToKill = 100/9.9 ≈ 10.1; turnsToDie = 100/5 = 20; 10.1 > 10 - not safe.
    const character = buildStats({ attack_earth: 9.9, hp: 100 });
    const monster = buildStats({ attack_earth: 5, hp: 100 });

    expect(isSafeToFight(character, monster)).toBe(false);
  });

  it("is never safe when the character can't deal any damage (fully resisted)", () => {
    const character = buildStats({ attack_earth: 10, hp: 150 });
    const monster = buildStats({ hp: 60, res_earth: 100 });

    expect(isSafeToFight(character, monster)).toBe(false);
  });

  it("is always safe when the monster can't deal any damage back", () => {
    const character = buildStats({ attack_earth: 1, hp: 10 });
    const monster = buildStats({ hp: 1000 });

    expect(isSafeToFight(character, monster)).toBe(true);
  });

  it('accounts for critical strike as an average damage bonus', () => {
    const monster = buildStats({ attack_water: 5, hp: 150 });
    // 10 atk/turn, no crit: 150/10 = 15 turns to kill; 100/5 = 20 turns to
    // die - 15 > 10 (half of 20), not safe.
    const noCrit = buildStats({ attack_earth: 10, hp: 100 });
    // Same 10 atk, but a 100% crit chance averages 1.5x damage (15/turn):
    // 150/15 = 10 turns to kill - exactly at the safety boundary now.
    const fullCrit = buildStats({
      attack_earth: 10,
      critical_strike: 100,
      hp: 100,
    });

    expect(isSafeToFight(noCrit, monster)).toBe(false);
    expect(isSafeToFight(fullCrit, monster)).toBe(true);
  });

  it("accounts for the character's %damage bonuses (dmg/dmg_<element>), which monsters don't have", () => {
    const monster = buildStats({ attack_water: 4, hp: 200 });
    // 10 atk/turn, no bonus: 200/10 = 20 turns to kill; 100/4 = 25 turns to
    // die - 20 > 12.5 (half of 25), not safe.
    const noBonus = buildStats({ attack_earth: 10, hp: 100 });
    // Same 10 base atk, but a total +100% damage bonus doubles it to 20/turn:
    // 200/20 = 10 turns to kill - now comfortably under the 12.5 threshold.
    const withBonus = buildStats({
      attack_earth: 10,
      dmg: 50,
      dmg_earth: 50,
      hp: 100,
    });

    expect(isSafeToFight(noBonus, monster)).toBe(false);
    expect(isSafeToFight(withBonus, monster)).toBe(true);
  });
});

describe('combatMargin', () => {
  it("is 0 when the character can't deal any damage", () => {
    const character = buildStats({ hp: 150 });
    const monster = buildStats({ attack_earth: 5, hp: 60 });

    expect(combatMargin(character, monster)).toBe(0);
  });

  it('still discriminates by damage output when the monster can never deal damage back', () => {
    // Both candidates are "infinitely safe" in the sense that the monster
    // can never win, but the harder-hitting one should still score higher
    // instead of both collapsing to the same value - see gear.ts, which
    // ranks equipment candidates by this score.
    const monster = buildStats({ hp: 60 });
    const weakAttacker = buildStats({ attack_earth: 1, hp: 100 });
    const strongAttacker = buildStats({ attack_earth: 50, hp: 100 });

    expect(combatMargin(strongAttacker, monster)).toBeGreaterThan(
      combatMargin(weakAttacker, monster),
    );
    expect(combatMargin(weakAttacker, monster)).toBeGreaterThan(1_000);
  });

  it("matches isSafeToFight's threshold at exactly the safety boundary", () => {
    // Same fixture as isSafeToFight's boundary test: turnsToKill (10) is
    // exactly half of turnsToDie (20), so the margin is exactly 2.
    const character = buildStats({ attack_earth: 10, hp: 100 });
    const monster = buildStats({ attack_earth: 5, hp: 100 });

    expect(combatMargin(character, monster)).toBe(2);
    expect(isSafeToFight(character, monster)).toBe(true);
  });
});

describe('fightSafely', () => {
  it('fights immediately without resting when HP is above the safety threshold', async () => {
    const character = buildCharacter({ hp: 80, max_hp: 100 });
    const fight = vi.fn(() => okAsync(buildFightResult('win', character)));
    const rest = vi.fn();

    const result = await fightSafely({
      fight,
      getCharacter: () => character,
      rest,
    });

    expect(rest).not.toHaveBeenCalled();
    expect(fight).toHaveBeenCalledTimes(1);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().fight.result).toBe('win');
  });

  it('rests first when HP drops below half, then fights', async () => {
    const character = buildCharacter({ hp: 40, max_hp: 100 });
    const restedCharacter = buildCharacter({ hp: 100, max_hp: 100 });
    const rest = vi.fn(() =>
      okAsync({
        character: restedCharacter,
        cooldown: buildCooldown(),
        hp_restored: 60,
      }),
    );
    const fight = vi.fn(() =>
      okAsync(buildFightResult('win', restedCharacter)),
    );

    const result = await fightSafely({
      fight,
      getCharacter: () => character,
      rest,
    });

    expect(rest).toHaveBeenCalledTimes(1);
    expect(fight).toHaveBeenCalledTimes(1);
    expect(result.isOk()).toBe(true);
  });

  it('does not fail the result when a fight is lost, just logs it', async () => {
    const character = buildCharacter({ hp: 80, max_hp: 100 });
    const fight = vi.fn(() => okAsync(buildFightResult('loss', character)));
    const rest = vi.fn();

    const result = await fightSafely({
      fight,
      getCharacter: () => character,
      rest,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().fight.result).toBe('loss');
  });
});
