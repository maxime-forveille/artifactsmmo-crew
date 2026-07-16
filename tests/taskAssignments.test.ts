import { describe, expect, it } from 'vitest';

import { parseTaskAssignments } from '../src/utils/taskAssignments.js';

describe('parseTaskAssignments', () => {
  it('parses each task type into a character/task assignment', () => {
    const assignments = parseTaskAssignments(
      JSON.stringify({
        Butters: { resource: 'copper_rocks', type: 'farm' },
        Cartman: { type: 'autoHunt' },
        Kenny: { monster: 'chicken', type: 'hunt' },
        Kyle: { items: ['copper_ring'], type: 'craftAndEquip' },
        Stan: {
          items: ['wooden_staff'],
          monster: 'yellow_slime',
          type: 'craftAndEquipThenHunt',
        },
      }),
    );

    expect(assignments).toHaveLength(5);
    expect(assignments).toContainEqual({
      character: 'Cartman',
      task: { type: 'autoHunt' },
    });
    expect(assignments).toContainEqual({
      character: 'Butters',
      task: { resource: 'copper_rocks', type: 'farm' },
    });
    expect(assignments).toContainEqual({
      character: 'Kenny',
      task: { monster: 'chicken', type: 'hunt' },
    });
    expect(assignments).toContainEqual({
      character: 'Kyle',
      task: { items: ['copper_ring'], type: 'craftAndEquip' },
    });
    expect(assignments).toContainEqual({
      character: 'Stan',
      task: {
        items: ['wooden_staff'],
        monster: 'yellow_slime',
        type: 'craftAndEquipThenHunt',
      },
    });
  });

  it('throws a readable error for an unknown task type', () => {
    expect(() =>
      parseTaskAssignments(JSON.stringify({ Cartman: { type: 'sleep' } })),
    ).toThrow(/Invalid task assignments/);
  });

  it('throws a readable error when a task is missing a required field', () => {
    expect(() =>
      parseTaskAssignments(JSON.stringify({ Cartman: { type: 'farm' } })),
    ).toThrow(/Invalid task assignments/);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseTaskAssignments('{not json')).toThrow();
  });

  it('returns an empty list for an empty object', () => {
    expect(parseTaskAssignments('{}')).toEqual([]);
  });
});
