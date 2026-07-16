import { ResultAsync } from "neverthrow";

import {
  createConfiguredGoalPlanner,
  type ConfiguredGoalPlannerError,
  type ResolvedGoalItem,
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
  ResultAsync.combine([
    resolveConfiguredItems(client, options.config),
    resolveConfiguredResources(client, options.config),
  ]).andThen(([resolvedItems, resolvedResources]) =>
    createCrewRuntime(client, {
      initialState: buildInitialOrchestratorState(options.config),
      plan: createConfiguredGoalPlanner(resolvedItems, resolvedResources),
      reportError: options.reportError,
      waitBeforeRetry: options.waitBeforeRetry,
    }),
  );
