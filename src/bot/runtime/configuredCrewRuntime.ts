import { okAsync, ResultAsync } from "neverthrow";

import {
  createConfiguredGoalPlanner,
  type ConfiguredGoalPlannerError,
  type ResolvedGoalItem,
  type ResolvedGoalMaterialItem,
  type ResolvedGoalMaterialSource,
  type ResolvedGoalResource,
} from "../orchestration/configuredGoalPlanner.js";
import { createCrewRuntime, type CrewRuntimeStartError } from "./crewRuntime.js";
import type { RollingActivityCoordinator } from "./rollingActivityCoordinator.js";
import { type ArtifactsApiError, type ArtifactsClient } from "../../client/index.js";
import {
  buildInitialOrchestratorState,
  type OrchestrationConfig,
} from "../../utils/orchestrationConfig.js";

type ConfiguredCrewRuntimeOptions = Readonly<{
  config: OrchestrationConfig;
  reportError: (error: unknown) => void;
  waitBeforeRetry: () => Promise<void>;
}>;

export const resolveConfiguredItems = (
  client: Pick<ArtifactsClient, "getItem">,
  config: OrchestrationConfig,
): ResultAsync<readonly ResolvedGoalItem[], ArtifactsApiError> =>
  ResultAsync.combine(
    config.goals.flatMap((goal) =>
      goal.type === "equipItem"
        ? [
            client.getItem(goal.itemCode).map((response) => ({
              goalId: goal.id,
              item: response.data,
            })),
          ]
        : [],
    ),
  );

type MaterialResolutionClient = Pick<ArtifactsClient, "getItem" | "getMonsters" | "getResources">;

type ResolvedEquipmentMaterials = Readonly<{
  items: readonly ResolvedGoalMaterialItem[];
  sources: readonly ResolvedGoalMaterialSource[];
}>;

const emptyMaterials = (): ResolvedEquipmentMaterials => ({ items: [], sources: [] });

const mergeMaterials = (
  groups: readonly ResolvedEquipmentMaterials[],
): ResolvedEquipmentMaterials => ({
  items: groups.flatMap((group) => group.items),
  sources: groups.flatMap((group) => group.sources),
});

const resolveUniqueMaterialSource = (
  client: Pick<MaterialResolutionClient, "getMonsters" | "getResources">,
  goalId: string,
  itemCode: string,
): ResultAsync<ResolvedGoalMaterialSource | undefined, ArtifactsApiError> =>
  ResultAsync.combine([
    client.getMonsters({ drop: itemCode, size: 100 }),
    client.getResources({ drop: itemCode, size: 100 }),
  ]).map(([monsters, resources]) => {
    if (monsters.data.length + resources.data.length !== 1) {
      return undefined;
    }

    const [monster] = monsters.data;

    if (monster !== undefined) {
      return {
        goalId,
        materialSource: {
          itemCode,
          source: { monster, type: "hunt" },
        },
      };
    }

    const [resource] = resources.data;

    return resource === undefined
      ? undefined
      : {
          goalId,
          materialSource: {
            itemCode,
            source: { resource, type: "gather" },
          },
        };
  });

const resolveMaterialTree = (
  client: MaterialResolutionClient,
  goalId: string,
  itemCode: string,
  ancestors: ReadonlySet<string>,
): ResultAsync<ResolvedEquipmentMaterials, ArtifactsApiError> => {
  if (ancestors.has(itemCode)) {
    return okAsync(emptyMaterials());
  }

  return client.getItem(itemCode).andThen((response) => {
    const item = response.data;
    const resolvedItem = { goalId, item };

    if (item.craft?.skill === undefined) {
      return resolveUniqueMaterialSource(client, goalId, item.code).map((source) => ({
        items: [resolvedItem],
        sources: source === undefined ? [] : [source],
      }));
    }

    const nextAncestors = new Set([...ancestors, item.code]);
    const materialCodes = [...new Set((item.craft.items ?? []).map((material) => material.code))];

    return ResultAsync.combine(
      materialCodes.map((materialCode) =>
        resolveMaterialTree(client, goalId, materialCode, nextAncestors),
      ),
    ).map((children) => {
      const descendants = mergeMaterials(children);
      return {
        items: [resolvedItem, ...descendants.items],
        sources: descendants.sources,
      };
    });
  });
};

const deduplicateMaterials = (
  materials: ResolvedEquipmentMaterials,
): ResolvedEquipmentMaterials => ({
  items: [
    ...new Map(
      materials.items.map((resolved) => [`${resolved.goalId}:${resolved.item.code}`, resolved]),
    ).values(),
  ],
  sources: [
    ...new Map(
      materials.sources.map((resolved) => [
        `${resolved.goalId}:${resolved.materialSource.itemCode}`,
        resolved,
      ]),
    ).values(),
  ],
});

export const resolveEquipmentMaterials = (
  client: MaterialResolutionClient,
  resolvedItems: readonly ResolvedGoalItem[],
): ResultAsync<ResolvedEquipmentMaterials, ArtifactsApiError> =>
  ResultAsync.combine(
    resolvedItems.flatMap(({ goalId, item }) => {
      const materialCodes = [
        ...new Set((item.craft?.items ?? []).map((material) => material.code)),
      ];
      const ancestors = new Set([item.code]);
      return materialCodes.map((itemCode) =>
        resolveMaterialTree(client, goalId, itemCode, ancestors),
      );
    }),
  ).map((groups) => deduplicateMaterials(mergeMaterials(groups)));

export const resolveConfiguredResources = (
  client: Pick<ArtifactsClient, "getResource">,
  config: OrchestrationConfig,
): ResultAsync<readonly ResolvedGoalResource[], ArtifactsApiError> =>
  ResultAsync.combine(
    config.goals.flatMap((goal) =>
      goal.type === "replenishBankItem"
        ? [
            client.getResource(goal.resourceCode).map((response) => ({
              goalId: goal.id,
              resource: response.data,
            })),
          ]
        : [],
    ),
  );

/** Resolves configured catalog targets before creating the live crew runtime. */
export const createConfiguredCrewRuntime = (
  client: ArtifactsClient,
  options: ConfiguredCrewRuntimeOptions,
): ResultAsync<
  RollingActivityCoordinator<ConfiguredGoalPlannerError, CrewRuntimeStartError>,
  ArtifactsApiError
> =>
  resolveConfiguredItems(client, options.config).andThen((resolvedItems) =>
    ResultAsync.combine([
      resolveConfiguredResources(client, options.config),
      resolveEquipmentMaterials(client, resolvedItems),
    ]).andThen(([resolvedResources, resolvedMaterials]) =>
      createCrewRuntime(client, {
        initialState: buildInitialOrchestratorState(options.config),
        plan: createConfiguredGoalPlanner(
          resolvedItems,
          resolvedResources,
          resolvedMaterials.sources,
          resolvedMaterials.items,
        ),
        reportError: options.reportError,
        waitBeforeRetry: options.waitBeforeRetry,
      }),
    ),
  );
