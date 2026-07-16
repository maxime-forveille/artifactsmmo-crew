import * as v from 'valibot';

import type { components } from '../../client/schema.js';

type GatheringSkill = components['schemas']['GatheringSkill'];

/**
 * What a character should be doing. `farm`, `hunt`, `autoHunt`, and `autoFarm`
 * run forever; `craftAndEquip` works through `items` in order, then stops;
 * `craftAndEquipThenHunt` does the same craftAndEquip pass (a no-op for items
 * already equipped) and then switches to hunting forever - the "get geared up,
 * then go fight" combo. `autoHunt`/`autoFarm` are like `hunt`/`farm`, but
 * re-pick the monster/resource before every cycle instead of using a fixed one
 * (see `findNextSafeMonster` / `findNextFarmableResource`), so a character
 * naturally moves to a better target as it (or its relevant skill) levels up -
 * `autoFarm` still needs `skill` specified since a character has 4 independent
 * gathering skill levels, unlike the single combat level `autoHunt` works from.
 * New task types should be added here first, then handled in `runTask`'s switch
 * (the `never` check there makes an unhandled case a compile error rather than
 * a silent no-op) - and in `taskSchema` below, so `tasks.json` can express it
 * too.
 */
export type Task =
  | { readonly type: 'autoFarm'; readonly skill: GatheringSkill }
  | { readonly type: 'autoHunt' }
  | { readonly type: 'craftAndEquip'; readonly items: readonly string[] }
  | {
      readonly type: 'craftAndEquipThenHunt';
      readonly items: readonly string[];
      readonly monster: string;
    }
  | { readonly type: 'farm'; readonly resource: string }
  | { readonly type: 'hunt'; readonly monster: string };

export type TaskAssignment = Readonly<{ character: string; task: Task }>;

const gatheringSkillSchema = v.picklist([
  'alchemy',
  'fishing',
  'mining',
  'woodcutting',
] as const);

/**
 * Validates the shape of a `Task` read from `tasks.json` (untyped JSON input,
 * unlike the `Task` values built in-code). Kept in sync with `Task` by hand -
 * there's no automated check that the two match, but a mismatch would surface
 * immediately as a type error where `taskSchema`'s inferred output is used as a
 * `Task`.
 */
export const taskSchema = v.variant('type', [
  v.object({ skill: gatheringSkillSchema, type: v.literal('autoFarm') }),
  v.object({ type: v.literal('autoHunt') }),
  v.object({ items: v.array(v.string()), type: v.literal('craftAndEquip') }),
  v.object({
    items: v.array(v.string()),
    monster: v.string(),
    type: v.literal('craftAndEquipThenHunt'),
  }),
  v.object({ resource: v.string(), type: v.literal('farm') }),
  v.object({ monster: v.string(), type: v.literal('hunt') }),
]);

const stringArraysEqual = (
  a: readonly string[],
  b: readonly string[],
): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * Structural equality for two `Task`s - used by `taskSupervisor.ts` to decide
 * whether a character's reloaded `tasks.json` entry actually changed anything,
 * rather than restarting every character on every reload regardless of whether
 * their task is still the same.
 */
export const tasksEqual = (a: Task, b: Task): boolean => {
  if (a.type !== b.type) {
    return false;
  }

  switch (a.type) {
    case 'autoFarm': {
      return b.type === 'autoFarm' && a.skill === b.skill;
    }
    case 'autoHunt': {
      return true;
    }
    case 'craftAndEquip': {
      return b.type === 'craftAndEquip' && stringArraysEqual(a.items, b.items);
    }
    case 'craftAndEquipThenHunt': {
      return (
        b.type === 'craftAndEquipThenHunt' &&
        a.monster === b.monster &&
        stringArraysEqual(a.items, b.items)
      );
    }
    case 'farm': {
      return b.type === 'farm' && a.resource === b.resource;
    }
    case 'hunt': {
      return b.type === 'hunt' && a.monster === b.monster;
    }
    default: {
      const exhaustiveCheck: never = a;
      throw new Error(
        `Unhandled task type: ${JSON.stringify(exhaustiveCheck)}`,
      );
    }
  }
};
