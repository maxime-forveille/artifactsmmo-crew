import { errAsync, ok, okAsync } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createCharacterAgentFromSnapshotMock, runActivityMock } = vi.hoisted(() => ({
  createCharacterAgentFromSnapshotMock: vi.fn(),
  runActivityMock: vi.fn(),
}));

vi.mock("../src/bot/runtime/characterAgent.js", () => ({
  createCharacterAgentFromSnapshot: createCharacterAgentFromSnapshotMock,
}));

vi.mock("../src/bot/runtime/activityDispatcher.js", () => ({
  runActivity: runActivityMock,
}));

import type { CrewSnapshot } from "../src/bot/orchestration/crewSnapshot.js";
import type {
  ActivityAssignment,
  OrchestratorState,
} from "../src/bot/orchestration/orchestratorState.js";
import type {
  ActivityExecutionError,
  ExecutableActivity,
} from "../src/bot/runtime/activityDispatcher.js";
import type { RollingActivityPlanner } from "../src/bot/runtime/rollingActivityCoordinator.js";
import {
  CharacterAgentNotFoundError,
  classifyActivityExecutionError,
  createCrewRuntime,
  isTransientArtifactsApiError,
} from "../src/bot/runtime/crewRuntime.js";
import { ArtifactsApiError, type ArtifactsClient } from "../src/client/index.js";
import type { components } from "../src/client/schema.js";
import { LocationNotFoundError } from "../src/bot/world.js";

type BankPage = components["schemas"]["DataPage_SimpleItemSchema_"];
type Character = components["schemas"]["CharacterSchema"];

class TestPlanError extends Error {}

const buildCharacter = (name: string): Character => ({ ...({} as Character), name });

const buildBankPage = (): BankPage => ({
  data: [],
  page: 1,
  pages: 1,
  size: 100,
  total: 0,
});

const buildClient = (characters: readonly Character[]) => {
  const getBankItems = vi.fn(() => okAsync(buildBankPage()));
  const getCharacter = vi.fn();
  const getMyCharacters = vi.fn(() => okAsync({ data: [...characters] }));
  const client = { getBankItems, getCharacter, getMyCharacters } as unknown as ArtifactsClient;

  return { client, getBankItems, getCharacter, getMyCharacters };
};

const buildState = (): OrchestratorState => ({
  goals: [
    {
      id: "goal-copper",
      itemCode: "copper_ore",
      minimumBankQuantity: 50,
      type: "replenishBankItem",
    },
  ],
  reservations: [],
});

const buildAssignment = (characterName = "Stan"): ActivityAssignment<ExecutableActivity> => ({
  activity: { resourceCode: "copper_rocks", type: "farmResource" },
  characterName,
  consumes: [],
  goalId: "goal-copper",
  produces: [{ itemCode: "copper_ore" }],
});

const buildOptions = (plan: RollingActivityPlanner<ActivityExecutionError, TestPlanError>) => ({
  initialState: buildState(),
  plan,
  reportError: vi.fn(),
  waitBeforeRetry: vi.fn(async () => undefined),
});

describe("Artifacts API failure classification", () => {
  it.each([0, 408, 425, 429, 500, 503])("treats status %s as transient", (status) => {
    const error = new ArtifactsApiError("temporary", status, {});

    expect(isTransientArtifactsApiError(error)).toBe(true);
    expect(classifyActivityExecutionError(error)).toBe("transient");
  });

  it.each([400, 401, 497])("treats status %s as a domain Blocker", (status) => {
    const error = new ArtifactsApiError("blocked", status, {});

    expect(isTransientArtifactsApiError(error)).toBe(false);
    expect(classifyActivityExecutionError(error)).toBe("blocked");
  });

  it("treats a missing Activity location as a Blocker", () => {
    const error = new LocationNotFoundError("resource", "missing");

    expect(classifyActivityExecutionError(error)).toBe("blocked");
  });
});

describe("createCrewRuntime", () => {
  beforeEach(() => {
    createCharacterAgentFromSnapshotMock.mockReset();
    createCharacterAgentFromSnapshotMock.mockImplementation((_client, character: Character) => ({
      name: character.name,
    }));
    runActivityMock.mockReset();
    runActivityMock.mockReturnValue(okAsync(undefined));
  });

  it("seeds Character Agents from the initial Crew Snapshot without extra reads", async () => {
    const stan = buildCharacter("Stan");
    const { client, getBankItems, getCharacter, getMyCharacters } = buildClient([stan]);
    const options = buildOptions((_snapshot, state) => ok({ activities: [], state }));

    const result = await createCrewRuntime(client, options);

    expect(result.isOk()).toBe(true);
    expect(createCharacterAgentFromSnapshotMock).toHaveBeenCalledWith(client, stan);
    expect(getCharacter).not.toHaveBeenCalled();
    expect(getMyCharacters).toHaveBeenCalledTimes(1);
    expect(getBankItems).toHaveBeenCalledTimes(1);
    expect(result.isOk() && result.value.getState()).toEqual(buildState());
  });

  it("dispatches a planned Activity through the matching Character Agent", async () => {
    const { client } = buildClient([buildCharacter("Stan")]);
    const assignment = buildAssignment();
    const plan = vi.fn((_snapshot: CrewSnapshot, state: OrchestratorState, outcome?: unknown) =>
      ok({ activities: outcome === undefined ? [assignment] : [], state }),
    );
    const result = await createCrewRuntime(client, buildOptions(plan));
    const runtime = result._unsafeUnwrap();

    const started = runtime.start();
    await runtime.waitForIdle();

    expect(started.isOk()).toBe(true);
    expect(runActivityMock).toHaveBeenCalledWith(client, { name: "Stan" }, assignment.activity);
    expect(plan).toHaveBeenCalledTimes(2);
    expect(runtime.getState().reservations).toEqual([]);
  });

  it("reports and retries a transient Activity execution failure", async () => {
    const { client } = buildClient([buildCharacter("Stan")]);
    const assignment = buildAssignment();
    const apiError = new ArtifactsApiError("unavailable", 503, {});
    runActivityMock.mockReturnValueOnce(errAsync(apiError)).mockReturnValueOnce(okAsync(undefined));
    const plan = vi.fn((_snapshot: CrewSnapshot, state: OrchestratorState, outcome?: unknown) =>
      ok({ activities: outcome === undefined ? [assignment] : [], state }),
    );
    const options = buildOptions(plan);
    const result = await createCrewRuntime(client, options);
    const runtime = result._unsafeUnwrap();

    runtime.start();
    await runtime.waitForIdle();

    expect(runActivityMock).toHaveBeenCalledTimes(2);
    expect(options.reportError).toHaveBeenCalledWith(apiError);
    expect(options.waitBeforeRetry).toHaveBeenCalledTimes(1);
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it("returns a typed error when policy selects a character without an Agent", async () => {
    const { client } = buildClient([buildCharacter("Stan")]);
    const assignment = buildAssignment("Kyle");
    const options = buildOptions((_snapshot, state) => ok({ activities: [assignment], state }));
    const result = await createCrewRuntime(client, options);
    const started = result._unsafeUnwrap().start();

    expect(started.isErr()).toBe(true);
    const error = started._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(CharacterAgentNotFoundError);
    expect(error).toMatchObject({
      characterName: "Kyle",
      message: 'No Character Agent exists for "Kyle"',
      name: "CharacterAgentNotFoundError",
    });
    expect(runActivityMock).not.toHaveBeenCalled();
  });

  it("propagates an initial Crew Snapshot failure", async () => {
    const error = new ArtifactsApiError("unavailable", 503, {});
    const client = {
      getBankItems: vi.fn(() => okAsync(buildBankPage())),
      getMyCharacters: vi.fn(() => errAsync(error)),
    } as unknown as ArtifactsClient;
    const options = buildOptions((_snapshot, state) => ok({ activities: [], state }));

    const result = await createCrewRuntime(client, options);

    expect(result.isErr() && result.error).toBe(error);
    expect(createCharacterAgentFromSnapshotMock).not.toHaveBeenCalled();
  });
});
