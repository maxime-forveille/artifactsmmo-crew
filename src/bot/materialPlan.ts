import { errAsync, okAsync, type ResultAsync } from "neverthrow";

import type { ArtifactsApiError, ArtifactsClient } from "../client/index.js";
import type { components } from "../client/schema.js";
import { isSafeToFight } from "./combat.js";
import { heldQuantity } from "./inventory.js";
import { craftSkillLevel, skillLevel } from "./progression.js";
import {
  findMonsterForDrop,
  findResourceForDrop,
  MonsterNotFoundError,
  ResourceNotFoundError,
} from "./world.js";

type Character = components["schemas"]["CharacterSchema"];
type CraftSkill = components["schemas"]["CraftSkill"];
type Item = components["schemas"]["ItemSchema"];

type MaterialPlanClient = Pick<
  ArtifactsClient,
  "getBankItems" | "getItem" | "getMonsters" | "getResources"
>;
type CraftableFromSurplusClient = Pick<ArtifactsClient, "getBankItems" | "getItems">;
type ProfessionProgressClient = MaterialPlanClient &
  Pick<ArtifactsClient, "getItems" | "getMonster" | "getResource">;

/** Where a still-missing raw material could come from, if anywhere known. */
export type MaterialSource =
  | { readonly type: "gather"; readonly resourceCode: string }
  | { readonly type: "hunt"; readonly monsterCode: string }
  | { readonly type: "unknown" };

/**
 * A raw material this character doesn't currently have enough of (counting
 * both inventory and bank), and where it could come from. Only leaf
 * (non-craftable) materials show up here - an intermediate item that's
 * itself missing but craftable is represented by its own ingredients
 * instead, same as `ensureHeldItem`'s recursion in `strategies/equipment.ts`.
 */
export type MissingMaterial = {
  readonly itemCode: string;
  readonly missingQuantity: number;
  readonly source: MaterialSource;
};

/** How many units of `itemCode` are sitting in the bank right now. */
const bankQuantity = (
  client: Pick<MaterialPlanClient, "getBankItems">,
  itemCode: string,
): ResultAsync<number, ArtifactsApiError> =>
  client.getBankItems({ item_code: itemCode }).map((page) => page.data[0]?.quantity ?? 0);

/**
 * Classifies a raw (non-craftable) material by where it could be obtained:
 * a gatherable resource node, a monster drop, or - unlike
 * `ensureHeldItem`, which fails outright - `"unknown"` when neither exists,
 * so a decision layer can skip/deprioritize an unobtainable material
 * instead of the whole computation failing. A genuine API error is still
 * propagated, only the "not found" cases are downgraded to `"unknown"`.
 */
const sourceFor = (
  client: Pick<MaterialPlanClient, "getMonsters" | "getResources">,
  itemCode: string,
): ResultAsync<MaterialSource, ArtifactsApiError> =>
  findResourceForDrop(client, itemCode)
    .map((resource): MaterialSource => ({ resourceCode: resource.code, type: "gather" }))
    .orElse((error) =>
      error instanceof ResourceNotFoundError
        ? findMonsterForDrop(client, itemCode)
            .map((monster): MaterialSource => ({ monsterCode: monster.code, type: "hunt" }))
            .orElse((huntError) =>
              huntError instanceof MonsterNotFoundError
                ? okAsync<MaterialSource, ArtifactsApiError>({ type: "unknown" })
                : errAsync(huntError),
            )
        : errAsync(error),
    );

/**
 * Same as `materialsNeededFor`, but for when the item's data has already
 * been fetched (mirrors `ensureHeldItem`'s split in `strategies/equipment.ts`
 * for the same reason: avoid a redundant `getItem` round-trip when a caller
 * already has it, e.g. while recursing into craft materials).
 */
const materialsNeededForItem = (
  client: MaterialPlanClient,
  character: Character,
  item: Item,
  quantity: number,
): ResultAsync<readonly MissingMaterial[], ArtifactsApiError> => {
  const itemCode = item.code;
  const held = heldQuantity(character, itemCode);

  if (held >= quantity) {
    return okAsync([]);
  }

  return bankQuantity(client, itemCode).andThen((banked) => {
    const stillMissing = quantity - held - banked;

    if (stillMissing <= 0) {
      return okAsync([]);
    }

    if (item.craft?.skill !== undefined) {
      const craftYield = item.craft.quantity ?? 1;
      const craftsNeeded = Math.ceil(stillMissing / craftYield);
      const materials = item.craft.items ?? [];

      return materials.reduce<ResultAsync<readonly MissingMaterial[], ArtifactsApiError>>(
        (acc, material) =>
          acc.andThen((soFar) =>
            materialsNeededFor(
              client,
              character,
              material.code,
              material.quantity * craftsNeeded,
            ).map((subMaterials) => [...soFar, ...subMaterials]),
          ),
        okAsync([]),
      );
    }

    return sourceFor(client, itemCode).map((source) => [
      { itemCode, missingQuantity: stillMissing, source },
    ]);
  });
};

/**
 * Read-only, side-effect-free version of `ensureHeldItem`
 * (`strategies/equipment.ts`): reports what's still missing to reach
 * `quantity` of `itemCode`, recursing into craft materials exactly the same
 * way, but never moves the character, withdraws from the bank, gathers,
 * hunts, or crafts anything. Meant for a future decision layer to compare
 * "how much work is this upgrade" across candidates before committing to
 * one - see the README's "Automated progression decisions" section.
 *
 * Known simplifications versus the real (acting) pipeline:
 *  - Doesn't account for an item already equipped in some slot the way
 *    `reclaimEquippedIfAvailable` does - an equipped copy isn't counted as
 *    "held".
 *  - Each recursive branch checks the bank independently, so if two
 *    different craft branches both need the same shared material, the
 *    bank's current quantity is considered available to both rather than
 *    split between them. The real pipeline doesn't have this issue because
 *    withdrawals happen sequentially and actually deplete the bank. This is
 *    fine for a "how much is missing, roughly" estimate; it isn't safe to
 *    read as several independent guarantees, since acting on all of them at
 *    once could double-count what's actually available.
 */
export const materialsNeededFor = (
  client: MaterialPlanClient,
  character: Character,
  itemCode: string,
  quantity: number,
): ResultAsync<readonly MissingMaterial[], ArtifactsApiError> =>
  heldQuantity(character, itemCode) >= quantity
    ? okAsync([])
    : client
        .getItem(itemCode)
        .andThen((response) => materialsNeededForItem(client, character, response.data, quantity));

/** An item the character could craft right now from what's already held or banked. */
export type CraftableFromSurplus = {
  readonly craftableQuantity: number;
  readonly itemCode: string;
  readonly skill: CraftSkill;
};

export type ProfessionGoal = {
  readonly skill: CraftSkill;
  readonly targetLevel: number;
};

export type ProfessionProgressPlan = {
  readonly craftQuantity: number;
  readonly itemCode: string;
  readonly missingMaterials: readonly MissingMaterial[];
  readonly recipeLevel: number;
  readonly skill: CraftSkill;
  readonly targetLevel: number;
};

/** How many units of `itemCode` are available right now, counting both inventory and bank. */
const availableQuantity = (
  client: Pick<MaterialPlanClient, "getBankItems">,
  character: Character,
  itemCode: string,
): ResultAsync<number, ArtifactsApiError> =>
  bankQuantity(client, itemCode).map((banked) => banked + heldQuantity(character, itemCode));

/**
 * How many times `item` could be crafted right now from what's already
 * held or banked - the smallest ratio of available-to-needed across all
 * of its materials, converted to units crafted via `item.craft.quantity`
 * (the recipe's yield). `0` when any material is entirely unavailable, or
 * when `item` isn't craftable at all (no `craft.items`).
 */
const craftableQuantityFor = (
  client: Pick<MaterialPlanClient, "getBankItems">,
  character: Character,
  item: Item,
): ResultAsync<number, ArtifactsApiError> => {
  const materials = item.craft?.items ?? [];

  if (materials.length === 0) {
    return okAsync(0);
  }

  return materials
    .reduce<ResultAsync<number, ArtifactsApiError>>(
      (acc, material) =>
        acc.andThen((craftsPossible) =>
          availableQuantity(client, character, material.code).map((available) =>
            Math.min(craftsPossible, Math.floor(available / material.quantity)),
          ),
        ),
      okAsync(Number.POSITIVE_INFINITY),
    )
    .map((craftsPossible) =>
      Number.isFinite(craftsPossible) ? craftsPossible * (item.craft?.quantity ?? 1) : 0,
    );
};

/**
 * Finds items the character could craft right now from whatever's sitting
 * in the bank (plus inventory), without needing to gather or hunt anything
 * more - the mirror image of `materialsNeededFor` ("what can I make from
 * what's piling up" instead of "what's missing to make this"). Only
 * considers items whose crafting-skill level requirement
 * (`item.craft.level`) the character's own profession level already
 * meets (`craftSkillLevel`, `progression.ts`) - a candidate here is
 * something the character could actually attempt right now, not just
 * something they could theoretically hold the materials for.
 *
 * Starts from the bank's own contents (`getBankItems`, first page only -
 * a bank with more than one page of distinct item codes won't have all of
 * them considered, a known simplification in the same spirit as
 * `resolveLocation`'s "first match" shortcut) and, for each material code
 * found there, looks up which items consume it (`getItems`'s
 * `craft_material` filter - the mirror of `findResourceForDrop`'s `drop`
 * filter). Candidates surfaced by more than one surplus material are
 * deduplicated by item code before being evaluated.
 */
export const findCraftableFromBankSurplus = (
  client: CraftableFromSurplusClient,
  character: Character,
): ResultAsync<readonly CraftableFromSurplus[], ArtifactsApiError> =>
  client.getBankItems({ size: 100 }).andThen((bankPage) => {
    const materialCodes = bankPage.data.map((entry) => entry.code);

    return materialCodes
      .reduce<ResultAsync<Map<string, Item>, ArtifactsApiError>>(
        (acc, materialCode) =>
          acc.andThen((candidates) =>
            client.getItems({ craft_material: materialCode, size: 100 }).map((page) => {
              for (const item of page.data) {
                candidates.set(item.code, item);
              }

              return candidates;
            }),
          ),
        okAsync(new Map<string, Item>()),
      )
      .andThen((candidates) => {
        const eligible = [...candidates.values()]
          .map((item) => ({ item, level: item.craft?.level, skill: item.craft?.skill }))
          .filter(
            (candidate): candidate is { item: Item; level: number; skill: CraftSkill } =>
              candidate.skill !== undefined &&
              candidate.level !== undefined &&
              candidate.level <= craftSkillLevel(character, candidate.skill),
          );

        return eligible.reduce<ResultAsync<readonly CraftableFromSurplus[], ArtifactsApiError>>(
          (acc, { item, skill }) =>
            acc.andThen((soFar) =>
              craftableQuantityFor(client, character, item).map((craftableQuantity) =>
                craftableQuantity > 0
                  ? [...soFar, { craftableQuantity, itemCode: item.code, skill }]
                  : soFar,
              ),
            ),
          okAsync([]),
        );
      });
  });

const materialsNeededForCraft = (
  client: MaterialPlanClient,
  character: Character,
  item: Item,
): ResultAsync<readonly MissingMaterial[], ArtifactsApiError> =>
  (item.craft?.items ?? []).reduce<ResultAsync<readonly MissingMaterial[], ArtifactsApiError>>(
    (acc, material) =>
      acc.andThen((soFar) =>
        materialsNeededFor(client, character, material.code, material.quantity).map(
          (missingMaterials) => [...soFar, ...missingMaterials],
        ),
      ),
    okAsync([]),
  );

const hasOnlyEligibleKnownSources = (
  client: Pick<ProfessionProgressClient, "getMonster" | "getResource">,
  character: Character,
  missingMaterials: readonly MissingMaterial[],
): ResultAsync<boolean, ArtifactsApiError> => {
  if (missingMaterials.some((material) => material.source.type === "unknown")) {
    return okAsync(false);
  }

  const resourceCodes = [
    ...new Set(
      missingMaterials.flatMap((material) =>
        material.source.type === "gather" ? [material.source.resourceCode] : [],
      ),
    ),
  ];
  const monsterCodes = [
    ...new Set(
      missingMaterials.flatMap((material) =>
        material.source.type === "hunt" ? [material.source.monsterCode] : [],
      ),
    ),
  ];

  return resourceCodes
    .reduce<ResultAsync<boolean, ArtifactsApiError>>(
      (acc, resourceCode) =>
        acc.andThen((isEligible) =>
          isEligible
            ? client
                .getResource(resourceCode)
                .map(
                  (response) => skillLevel(character, response.data.skill) >= response.data.level,
                )
            : okAsync(false),
        ),
      okAsync(true),
    )
    .andThen((areResourcesEligible) =>
      areResourcesEligible
        ? monsterCodes.reduce<ResultAsync<boolean, ArtifactsApiError>>(
            (acc, monsterCode) =>
              acc.andThen((isSafe) =>
                isSafe
                  ? client
                      .getMonster(monsterCode)
                      .map((response) => isSafeToFight(character, response.data))
                  : okAsync(false),
              ),
            okAsync(true),
          )
        : okAsync(false),
    );
};

const missingMaterialCost = (plan: ProfessionProgressPlan): number =>
  plan.missingMaterials.reduce((total, material) => total + material.missingQuantity, 0);

/**
 * Chooses one bounded craft that progresses `goal.skill`. Recipes requiring a
 * higher profession level are excluded. Recipes fully covered by inventory or
 * bank are preferred; otherwise the cheapest recipe whose missing materials
 * all have known, safe sources wins. Recipe level is only a tie-breaker until
 * observed crafting XP rates exist.
 */
export const planProfessionProgress = (
  client: ProfessionProgressClient,
  character: Character,
  goal: ProfessionGoal,
): ResultAsync<ProfessionProgressPlan | undefined, ArtifactsApiError> => {
  const currentLevel = craftSkillLevel(character, goal.skill);

  if (currentLevel >= goal.targetLevel) {
    return okAsync(undefined);
  }

  return client.getBankItems({ size: 100 }).andThen((bankPage) =>
    client.getItems({ craft_skill: goal.skill, size: 100 }).andThen((page) => {
      const snapshotClient: MaterialPlanClient = {
        getBankItems: (query) => {
          const data =
            query?.item_code === undefined
              ? bankPage.data
              : bankPage.data.filter((item) => item.code === query.item_code);
          return okAsync({ ...bankPage, data, total: data.length });
        },
        getItem: client.getItem,
        getMonsters: client.getMonsters,
        getResources: client.getResources,
      };
      const eligible = page.data.filter(
        (item): item is Item & { craft: NonNullable<Item["craft"]> & { level: number } } =>
          item.craft?.skill === goal.skill &&
          item.craft.level !== undefined &&
          item.craft.level <= currentLevel &&
          (item.craft.items?.length ?? 0) > 0,
      );

      return eligible
        .reduce<ResultAsync<readonly ProfessionProgressPlan[], ArtifactsApiError>>(
          (acc, item) =>
            acc.andThen((plans) =>
              materialsNeededForCraft(snapshotClient, character, item).andThen((missingMaterials) =>
                hasOnlyEligibleKnownSources(client, character, missingMaterials).map((isUsable) =>
                  isUsable
                    ? [
                        ...plans,
                        {
                          craftQuantity: 1,
                          itemCode: item.code,
                          missingMaterials,
                          recipeLevel: item.craft.level,
                          skill: goal.skill,
                          targetLevel: goal.targetLevel,
                        },
                      ]
                    : plans,
                ),
              ),
            ),
          okAsync([]),
        )
        .map(
          (plans) =>
            [...plans].sort((left, right) => {
              const costDifference = missingMaterialCost(left) - missingMaterialCost(right);

              if (costDifference !== 0) {
                return costDifference;
              }

              const levelDifference = right.recipeLevel - left.recipeLevel;
              return levelDifference !== 0
                ? levelDifference
                : left.itemCode.localeCompare(right.itemCode);
            })[0],
        );
    }),
  );
};
