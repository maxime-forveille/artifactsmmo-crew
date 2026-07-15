import { err, type ResultAsync } from "neverthrow";

import { runActivity, type ActivityExecutionError } from "./activityDispatcher.js";
import { launchActivity } from "./activityLauncher.js";
import type { ActivityStarter } from "./activityScheduler.js";
import { createCharacterAgentFromSnapshot, type CharacterAgent } from "./characterAgent.js";
import {
  createRollingActivityCoordinator,
  type RollingActivityCoordinator,
  type RollingActivityPlanner,
} from "./rollingActivityCoordinator.js";
import { ArtifactsApiError, type ArtifactsClient } from "../../client/index.js";
import { readCrewSnapshot } from "../orchestration/crewSnapshot.js";
import type { OrchestratorState } from "../orchestration/orchestratorState.js";
import type { StartActivityError } from "../orchestration/activityLifecycle.js";

export class CharacterAgentNotFoundError extends Error {
  constructor(public readonly characterName: string) {
    super(`No Character Agent exists for "${characterName}"`);
    this.name = "CharacterAgentNotFoundError";
  }
}

export type CrewRuntimeStartError = CharacterAgentNotFoundError | StartActivityError;

type CrewRuntimeOptions<EPlan extends Error> = Readonly<{
  initialState: OrchestratorState;
  plan: RollingActivityPlanner<ActivityExecutionError, EPlan>;
  reportError: (error: unknown) => void;
  waitBeforeRetry: () => Promise<void>;
}>;

export const isTransientArtifactsApiError = (error: ArtifactsApiError): boolean =>
  error.status === 0 ||
  error.status === 408 ||
  error.status === 425 ||
  error.status === 429 ||
  error.status >= 500;

export const classifyActivityExecutionError = (
  error: ActivityExecutionError,
): "blocked" | "transient" =>
  error instanceof ArtifactsApiError && isTransientArtifactsApiError(error)
    ? "transient"
    : "blocked";

const createActivityStarter =
  (
    client: ArtifactsClient,
    agents: ReadonlyMap<string, CharacterAgent>,
    reportError: (error: unknown) => void,
    waitBeforeRetry: () => Promise<void>,
  ): ActivityStarter<ActivityExecutionError, CrewRuntimeStartError> =>
  (state, assignment) => {
    const agent = agents.get(assignment.characterName);

    if (agent === undefined) {
      return err(new CharacterAgentNotFoundError(assignment.characterName));
    }

    return launchActivity(state, assignment, {
      classifyFailure: classifyActivityExecutionError,
      execute: (activity) =>
        runActivity(client, agent, activity).mapErr((error) => {
          reportError(error);
          return error;
        }),
      waitBeforeRetry,
    });
  };

/**
 * Reads the initial Crew Snapshot and wires the pure rolling coordinator to the
 * Artifacts client, Character Agents, bounded dispatcher, and retry semantics.
 * Goals and policy remain explicit inputs rather than runtime-owned constants.
 */
export const createCrewRuntime = <EPlan extends Error>(
  client: ArtifactsClient,
  options: CrewRuntimeOptions<EPlan>,
): ResultAsync<RollingActivityCoordinator<EPlan, CrewRuntimeStartError>, ArtifactsApiError> =>
  readCrewSnapshot(client).map((initialSnapshot) => {
    const agents = new Map(
      initialSnapshot.characters.map((character) => [
        character.name,
        createCharacterAgentFromSnapshot(client, character),
      ]),
    );

    return createRollingActivityCoordinator<
      ActivityExecutionError,
      EPlan,
      ArtifactsApiError,
      CrewRuntimeStartError
    >(options.initialState, initialSnapshot, {
      plan: options.plan,
      refreshSnapshot: () => readCrewSnapshot(client),
      reportError: options.reportError,
      shouldRetrySnapshotFailure: isTransientArtifactsApiError,
      startActivity: createActivityStarter(
        client,
        agents,
        options.reportError,
        options.waitBeforeRetry,
      ),
      waitBeforeSnapshotRetry: options.waitBeforeRetry,
    });
  });
