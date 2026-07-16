import { describe, expect, it } from 'vitest';

import { tasksEqual } from '../src/bot/tasks/task.js';

describe('tasksEqual', () => {
  it('treats two autoHunt tasks as always equal', () => {
    expect(tasksEqual({ type: 'autoHunt' }, { type: 'autoHunt' })).toBe(true);
  });

  it('compares farm tasks by resource', () => {
    expect(
      tasksEqual(
        { resource: 'copper_rocks', type: 'farm' },
        { resource: 'copper_rocks', type: 'farm' },
      ),
    ).toBe(true);
    expect(
      tasksEqual(
        { resource: 'copper_rocks', type: 'farm' },
        { resource: 'ash_wood', type: 'farm' },
      ),
    ).toBe(false);
  });

  it('compares hunt tasks by monster', () => {
    expect(
      tasksEqual(
        { monster: 'chicken', type: 'hunt' },
        { monster: 'chicken', type: 'hunt' },
      ),
    ).toBe(true);
    expect(
      tasksEqual(
        { monster: 'chicken', type: 'hunt' },
        { monster: 'cow', type: 'hunt' },
      ),
    ).toBe(false);
  });

  it('compares craftAndEquip tasks by items, order-sensitively', () => {
    expect(
      tasksEqual(
        { items: ['copper_ring', 'copper_boots'], type: 'craftAndEquip' },
        { items: ['copper_ring', 'copper_boots'], type: 'craftAndEquip' },
      ),
    ).toBe(true);
    expect(
      tasksEqual(
        { items: ['copper_ring', 'copper_boots'], type: 'craftAndEquip' },
        { items: ['copper_boots', 'copper_ring'], type: 'craftAndEquip' },
      ),
    ).toBe(false);
    expect(
      tasksEqual(
        { items: ['copper_ring'], type: 'craftAndEquip' },
        { items: ['copper_ring', 'copper_boots'], type: 'craftAndEquip' },
      ),
    ).toBe(false);
  });

  it('compares craftAndEquipThenHunt tasks by items and monster', () => {
    const base = {
      items: ['wooden_staff'],
      monster: 'yellow_slime',
      type: 'craftAndEquipThenHunt',
    } as const;
    expect(tasksEqual(base, { ...base })).toBe(true);
    expect(tasksEqual(base, { ...base, monster: 'chicken' })).toBe(false);
    expect(tasksEqual(base, { ...base, items: ['wooden_stick'] })).toBe(false);
  });

  it('compares autoFarm tasks by skill', () => {
    expect(
      tasksEqual(
        { skill: 'mining', type: 'autoFarm' },
        { skill: 'mining', type: 'autoFarm' },
      ),
    ).toBe(true);
    expect(
      tasksEqual(
        { skill: 'mining', type: 'autoFarm' },
        { skill: 'fishing', type: 'autoFarm' },
      ),
    ).toBe(false);
  });

  it('treats tasks of different types as unequal', () => {
    expect(
      tasksEqual({ type: 'autoHunt' }, { monster: 'chicken', type: 'hunt' }),
    ).toBe(false);
  });
});
