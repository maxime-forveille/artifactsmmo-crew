import * as v from "valibot";

/**
 * What a character should be doing. `farm`, `hunt`, and `autoHunt` run
 * forever; `craftAndEquip` works through `items` in order, then stops;
 * `craftAndEquipThenHunt` does the same craftAndEquip pass (a no-op for
 * items already equipped) and then switches to hunting forever - the
 * "get geared up, then go fight" combo. `autoHunt` is like `hunt`, but
 * re-picks the monster before every cycle instead of using a fixed one
 * (see `findNextSafeMonster`), so a character naturally moves to a better
 * target as it levels up. New task types should be added here first, then
 * handled in `runTask`'s switch (the `never` check there makes an
 * unhandled case a compile error rather than a silent no-op) - and in
 * `taskSchema` below, so `tasks.json` can express it too.
 */
export type Task =
  | { readonly type: "autoHunt" }
  | { readonly type: "craftAndEquip"; readonly items: readonly string[] }
  | {
      readonly type: "craftAndEquipThenHunt";
      readonly items: readonly string[];
      readonly monster: string;
    }
  | { readonly type: "farm"; readonly resource: string }
  | { readonly type: "hunt"; readonly monster: string };

/**
 * Validates the shape of a `Task` read from `tasks.json` (untyped JSON
 * input, unlike the `Task` values built in-code). Kept in sync with `Task`
 * by hand - there's no automated check that the two match, but a mismatch
 * would surface immediately as a type error where `taskSchema`'s inferred
 * output is used as a `Task`.
 */
export const taskSchema = v.variant("type", [
  v.object({ type: v.literal("autoHunt") }),
  v.object({ items: v.array(v.string()), type: v.literal("craftAndEquip") }),
  v.object({
    items: v.array(v.string()),
    monster: v.string(),
    type: v.literal("craftAndEquipThenHunt"),
  }),
  v.object({ resource: v.string(), type: v.literal("farm") }),
  v.object({ monster: v.string(), type: v.literal("hunt") }),
]);

const stringArraysEqual = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * Structural equality for two `Task`s - used by `taskSupervisor.ts` to
 * decide whether a character's reloaded `tasks.json` entry actually
 * changed anything, rather than restarting every character on every
 * reload regardless of whether their task is still the same.
 */
export const tasksEqual = (a: Task, b: Task): boolean => {
  if (a.type !== b.type) {
    return false;
  }

  switch (a.type) {
    case "autoHunt": {
      return true;
    }
    case "craftAndEquip": {
      return b.type === "craftAndEquip" && stringArraysEqual(a.items, b.items);
    }
    case "craftAndEquipThenHunt": {
      return (
        b.type === "craftAndEquipThenHunt" &&
        a.monster === b.monster &&
        stringArraysEqual(a.items, b.items)
      );
    }
    case "farm": {
      return b.type === "farm" && a.resource === b.resource;
    }
    case "hunt": {
      return b.type === "hunt" && a.monster === b.monster;
    }
    default: {
      const exhaustiveCheck: never = a;
      throw new Error(`Unhandled task type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
};
