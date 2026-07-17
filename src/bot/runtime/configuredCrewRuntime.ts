import { errAsync, okAsync, type ResultAsync } from 'neverthrow';

import type { ArtifactsApiError, ArtifactsClient } from '../../client/index.js';
import {
  buildInitialOrchestratorState,
  type OrchestrationConfig,
} from '../../utils/orchestrationConfig.js';
import {
  createOrchestrator,
  type OrchestratorError,
} from '../orchestration/orchestrator.js';
import {
  durableStateFrom,
  type OrchestratorStateRepository,
  restoreOrchestratorState,
} from '../orchestration/orchestratorStateRepository.js';
import {
  readWorldKnowledge,
  type WorldKnowledge,
} from '../orchestration/worldKnowledge.js';

import {
  createCrewRuntime,
  type CrewRuntimeStartError,
} from './crewRuntime.js';
import type { RollingActivityCoordinator } from './rollingActivityCoordinator.js';

type ConfiguredCrewRuntimeOptions<ERepository extends Error> = Readonly<{
  config: OrchestrationConfig;
  reportError: (error: unknown) => void;
  stateRepository: OrchestratorStateRepository<ERepository>;
  waitBeforeRetry: () => Promise<void>;
}>;

const emptyWorldKnowledge = (): WorldKnowledge => ({
  items: [],
  monsters: [],
  resources: [],
});

const readPlanningKnowledge = (
  client: ArtifactsClient,
  hasActiveGoals: boolean,
): ResultAsync<WorldKnowledge, ArtifactsApiError> =>
  hasActiveGoals ? readWorldKnowledge(client) : okAsync(emptyWorldKnowledge());

/** Resolves shared world knowledge before creating the live crew runtime. */
export const createConfiguredCrewRuntime = <ERepository extends Error>(
  client: ArtifactsClient,
  options: ConfiguredCrewRuntimeOptions<ERepository>,
): ResultAsync<
  RollingActivityCoordinator<
    OrchestratorError | ERepository,
    CrewRuntimeStartError,
    ArtifactsApiError
  >,
  ArtifactsApiError | ERepository
> => {
  const loadedState = options.stateRepository.load();
  if (loadedState.isErr()) {
    return errAsync(loadedState.error);
  }

  const fallbackState = buildInitialOrchestratorState(options.config);
  const initialState = restoreOrchestratorState(
    loadedState.value,
    fallbackState.goals,
  );

  const hasPlanningDemand =
    initialState.goals.length > 0 || options.config.policy !== undefined;

  return readPlanningKnowledge(client, hasPlanningDemand).andThen(
    (worldKnowledge) => {
      const orchestrate = createOrchestrator(
        worldKnowledge,
        options.config.policy,
      );

      return createCrewRuntime(client, {
        initialState,
        plan: (snapshot, state, previousOutcome) =>
          orchestrate(snapshot, state, previousOutcome).andThen((plan) =>
            options.stateRepository
              .save(durableStateFrom(plan.state))
              .map(() => plan),
          ),
        reportError: options.reportError,
        waitBeforeRetry: options.waitBeforeRetry,
      });
    },
  );
};
