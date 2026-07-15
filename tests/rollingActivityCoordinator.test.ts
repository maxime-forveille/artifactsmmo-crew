import { err, errAsync, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import { describe, expect, it, vi } from "vitest";

import {
  reserveStartedActivity,
  type StartActivityError,
} from "../src/bot/orchestration/activityLifecycle.js";
import type { CrewSnapshot } from "../src/bot/orchestration/crewSnapshot.js";
import type {
  ActivityAssignment,
  OrchestratorState,
  ReplenishBankItemGoal,
} from "../src/bot/orchestration/orchestratorState.js";
import type { ExecutableActivity } from "../src/bot/runtime/activityDispatcher.js";
import type { ActivityRunOutcome, LaunchedActivity } from "../src/bot/runtime/activityLauncher.js";
import type { ActivityPlan } from "../src/bot/runtime/activityScheduler.js";
import {
  createRollingActivityCoordinator,
  type RollingActivityPlanner,
} from "../src/bot/runtime/rollingActivityCoordinator.js";

class TestActivityError extends Error {}
class TestPlanError extends Error {}
class TestSnapshotError extends Error {}

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}>;

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
};

const buildGoal = (id: string, itemCode: string): ReplenishBankItemGoal => ({
  id,
  itemCode,
  minimumBankQuantity: 50,
  type: "replenishBankItem",
});

const buildAssignment = (
  characterName: string,
  goalId: string,
  resourceCode = "copper_rocks",
): ActivityAssignment<ExecutableActivity> => ({
  activity: { resourceCode, type: "farmResource" },
  characterName,
  consumes: [],
  goalId,
  produces: [{ itemCode: "copper_ore" }],
});

const buildState = (): OrchestratorState => ({
  goals: [buildGoal("goal-copper", "copper_ore"), buildGoal("goal-ash", "ash_wood")],
  reservations: [],
});

const buildSnapshot = (capturedAt: string): CrewSnapshot => ({
  bank: [],
  capturedAt,
  characters: [],
});

const completedOutcome = (
  characterName: string,
  goalId: string,
): ActivityRunOutcome<TestActivityError> => ({
  event: { characterName, goalId, type: "completed" },
});

const createStarter = () => {
  const completions = new Map<string, Deferred<ActivityRunOutcome<TestActivityError>>>();
  const startActivity = vi.fn(
    (
      state: OrchestratorState,
      assignment: ActivityAssignment<ExecutableActivity>,
    ): Result<LaunchedActivity<TestActivityError>, StartActivityError> =>
      reserveStartedActivity(state, assignment).map((reservedState) => {
        const completion = createDeferred<ActivityRunOutcome<TestActivityError>>();
        completions.set(assignment.characterName, completion);

        return { completion: completion.promise, state: reservedState };
      }),
  );

  return { completions, startActivity };
};

const unchangedPlan = (state: OrchestratorState): Result<ActivityPlan, TestPlanError> =>
  ok({ activities: [], state });

const noSnapshotRetry = {
  shouldRetrySnapshotFailure: (_error: TestSnapshotError) => false,
  waitBeforeSnapshotRetry: async () => undefined,
};

describe("createRollingActivityCoordinator", () => {
  it("starts the initial policy plan and exposes its Reservations", () => {
    const assignment = buildAssignment("Stan", "goal-copper");
    const initialSnapshot = buildSnapshot("2026-07-15T12:00:00.000Z");
    const initialState = buildState();
    const plan: RollingActivityPlanner<TestActivityError, TestPlanError> = vi.fn(
      (_snapshot, state) => ok({ activities: [assignment], state }),
    );
    const { startActivity } = createStarter();
    const coordinator = createRollingActivityCoordinator(initialState, initialSnapshot, {
      ...noSnapshotRetry,
      plan,
      refreshSnapshot: () => okAsync(initialSnapshot),
      reportError: vi.fn(),
      startActivity,
    });

    const result = coordinator.start();

    expect(result.isOk()).toBe(true);
    expect(plan).toHaveBeenCalledWith(initialSnapshot, initialState, undefined);
    expect(coordinator.getState().reservations).toEqual([assignment]);
    expect(coordinator.getSnapshot()).toBe(initialSnapshot);
  });

  it("refreshes and replans after an Activity completes", async () => {
    const assignment = buildAssignment("Stan", "goal-copper");
    const initialSnapshot = buildSnapshot("2026-07-15T12:00:00.000Z");
    const refreshedSnapshot = buildSnapshot("2026-07-15T12:01:00.000Z");
    const plan = vi.fn<RollingActivityPlanner<TestActivityError, TestPlanError>>(
      (_snapshot, state, previousOutcome) =>
        previousOutcome === undefined
          ? ok({ activities: [assignment], state })
          : unchangedPlan(state),
    );
    const reportError = vi.fn();
    const { completions, startActivity } = createStarter();
    const coordinator = createRollingActivityCoordinator(buildState(), initialSnapshot, {
      ...noSnapshotRetry,
      plan,
      refreshSnapshot: () => okAsync(refreshedSnapshot),
      reportError,
      startActivity,
    });
    coordinator.start();

    const outcome = completedOutcome("Stan", "goal-copper");
    completions.get("Stan")?.resolve(outcome);
    await coordinator.waitForIdle();

    expect(plan).toHaveBeenCalledTimes(2);
    expect(plan).toHaveBeenNthCalledWith(
      2,
      refreshedSnapshot,
      { goals: buildState().goals, reservations: [] },
      outcome,
    );
    expect(coordinator.getState().reservations).toEqual([]);
    expect(coordinator.getSnapshot()).toBe(refreshedSnapshot);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("serializes simultaneous completions before each replan", async () => {
    const stan = buildAssignment("Stan", "goal-copper");
    const kyle = buildAssignment("Kyle", "goal-ash", "ash_tree");
    const initialSnapshot = buildSnapshot("2026-07-15T12:00:00.000Z");
    const firstSnapshot = buildSnapshot("2026-07-15T12:01:00.000Z");
    const secondSnapshot = buildSnapshot("2026-07-15T12:02:00.000Z");
    const plan = vi.fn<RollingActivityPlanner<TestActivityError, TestPlanError>>(
      (_snapshot, state, previousOutcome) =>
        previousOutcome === undefined
          ? ok({ activities: [stan, kyle], state })
          : unchangedPlan(state),
    );
    const refreshSnapshot = vi
      .fn()
      .mockReturnValueOnce(okAsync(firstSnapshot))
      .mockReturnValueOnce(okAsync(secondSnapshot));
    const { completions, startActivity } = createStarter();
    const coordinator = createRollingActivityCoordinator(buildState(), initialSnapshot, {
      ...noSnapshotRetry,
      plan,
      refreshSnapshot,
      reportError: vi.fn(),
      startActivity,
    });
    coordinator.start();

    const stanOutcome = completedOutcome("Stan", "goal-copper");
    const kyleOutcome = completedOutcome("Kyle", "goal-ash");
    completions.get("Stan")?.resolve(stanOutcome);
    completions.get("Kyle")?.resolve(kyleOutcome);
    await coordinator.waitForIdle();

    expect(plan).toHaveBeenNthCalledWith(
      2,
      firstSnapshot,
      { goals: buildState().goals, reservations: [kyle] },
      stanOutcome,
    );
    expect(plan).toHaveBeenNthCalledWith(
      3,
      secondSnapshot,
      { goals: buildState().goals, reservations: [] },
      kyleOutcome,
    );
    expect(coordinator.getState().reservations).toEqual([]);
  });

  it("passes Blocker details to the next policy decision", async () => {
    const assignment = buildAssignment("Stan", "goal-copper");
    const blocker = new TestActivityError("missing material");
    const blockedOutcome: ActivityRunOutcome<TestActivityError> = {
      error: blocker,
      event: { characterName: "Stan", goalId: "goal-copper", type: "blocked" },
    };
    const plan = vi.fn<RollingActivityPlanner<TestActivityError, TestPlanError>>(
      (_snapshot, state, previousOutcome) =>
        previousOutcome === undefined
          ? ok({ activities: [assignment], state })
          : unchangedPlan(state),
    );
    const { completions, startActivity } = createStarter();
    const coordinator = createRollingActivityCoordinator(
      buildState(),
      buildSnapshot("2026-07-15T12:00:00.000Z"),
      {
        ...noSnapshotRetry,
        plan,
        refreshSnapshot: () => okAsync(buildSnapshot("2026-07-15T12:01:00.000Z")),
        reportError: vi.fn(),
        startActivity,
      },
    );
    coordinator.start();

    completions.get("Stan")?.resolve(blockedOutcome);
    await coordinator.waitForIdle();

    expect(plan.mock.calls[1]?.[2]).toBe(blockedOutcome);
    expect("error" in (plan.mock.calls[1]?.[2] ?? {})).toBe(true);
  });

  it("reports a refresh failure after releasing the finished Reservation", async () => {
    const assignment = buildAssignment("Stan", "goal-copper");
    const refreshError = new TestSnapshotError("refresh failed");
    const reportError = vi.fn();
    const plan = vi.fn<RollingActivityPlanner<TestActivityError, TestPlanError>>(
      (_snapshot, state) => ok({ activities: [assignment], state }),
    );
    const { completions, startActivity } = createStarter();
    const coordinator = createRollingActivityCoordinator(
      buildState(),
      buildSnapshot("2026-07-15T12:00:00.000Z"),
      {
        ...noSnapshotRetry,
        plan,
        refreshSnapshot: () => errAsync(refreshError),
        reportError,
        startActivity,
      },
    );
    coordinator.start();

    completions.get("Stan")?.resolve(completedOutcome("Stan", "goal-copper"));
    await coordinator.waitForIdle();

    expect(reportError).toHaveBeenCalledWith(refreshError);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(coordinator.getState().reservations).toEqual([]);
  });

  it("retries a transient snapshot failure before replanning", async () => {
    const assignment = buildAssignment("Stan", "goal-copper");
    const refreshError = new TestSnapshotError("refresh failed");
    const refreshedSnapshot = buildSnapshot("2026-07-15T12:01:00.000Z");
    const refreshSnapshot = vi
      .fn<() => ResultAsync<CrewSnapshot, TestSnapshotError>>()
      .mockReturnValueOnce(errAsync(refreshError))
      .mockReturnValueOnce(okAsync(refreshedSnapshot));
    const reportError = vi.fn();
    const shouldRetrySnapshotFailure = vi.fn(() => true);
    const waitBeforeSnapshotRetry = vi.fn(async () => undefined);
    const plan = vi.fn<RollingActivityPlanner<TestActivityError, TestPlanError>>(
      (_snapshot, state, previousOutcome) =>
        previousOutcome === undefined
          ? ok({ activities: [assignment], state })
          : unchangedPlan(state),
    );
    const { completions, startActivity } = createStarter();
    const coordinator = createRollingActivityCoordinator(
      buildState(),
      buildSnapshot("2026-07-15T12:00:00.000Z"),
      {
        plan,
        refreshSnapshot,
        reportError,
        shouldRetrySnapshotFailure,
        startActivity,
        waitBeforeSnapshotRetry,
      },
    );
    coordinator.start();

    completions.get("Stan")?.resolve(completedOutcome("Stan", "goal-copper"));
    await coordinator.waitForIdle();

    expect(refreshSnapshot).toHaveBeenCalledTimes(2);
    expect(shouldRetrySnapshotFailure).toHaveBeenCalledWith(refreshError);
    expect(waitBeforeSnapshotRetry).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(refreshError);
    expect(plan).toHaveBeenCalledTimes(2);
    expect(coordinator.getSnapshot()).toBe(refreshedSnapshot);
  });

  it("does not report idle while an Activity is still running", async () => {
    const assignment = buildAssignment("Stan", "goal-copper");
    let planCalls = 0;
    const plan: RollingActivityPlanner<TestActivityError, TestPlanError> = (_snapshot, state) => {
      planCalls += 1;
      return planCalls === 1 ? ok({ activities: [assignment], state }) : unchangedPlan(state);
    };
    const { completions, startActivity } = createStarter();
    const coordinator = createRollingActivityCoordinator(
      buildState(),
      buildSnapshot("2026-07-15T12:00:00.000Z"),
      {
        ...noSnapshotRetry,
        plan,
        refreshSnapshot: () => okAsync(buildSnapshot("2026-07-15T12:01:00.000Z")),
        reportError: vi.fn(),
        startActivity,
      },
    );
    coordinator.start();
    let isIdle = false;
    const idle = coordinator.waitForIdle().then(() => {
      isIdle = true;
    });

    coordinator.start();
    await Promise.resolve();

    expect(isIdle).toBe(false);

    completions.get("Stan")?.resolve(completedOutcome("Stan", "goal-copper"));
    await idle;
    expect(isIdle).toBe(true);
  });

  it("does not report idle while a terminal event is refreshing the snapshot", async () => {
    const assignment = buildAssignment("Stan", "goal-copper");
    const refreshedSnapshot = buildSnapshot("2026-07-15T12:01:00.000Z");
    const refresh = createDeferred<CrewSnapshot>();
    const refreshSnapshot = vi.fn(() =>
      ResultAsync.fromPromise(refresh.promise, () => new TestSnapshotError("refresh failed")),
    );
    let planCalls = 0;
    const plan: RollingActivityPlanner<TestActivityError, TestPlanError> = (_snapshot, state) => {
      planCalls += 1;
      return planCalls === 1 ? ok({ activities: [assignment], state }) : unchangedPlan(state);
    };
    const { completions, startActivity } = createStarter();
    const coordinator = createRollingActivityCoordinator(
      buildState(),
      buildSnapshot("2026-07-15T12:00:00.000Z"),
      {
        ...noSnapshotRetry,
        plan,
        refreshSnapshot,
        reportError: vi.fn(),
        startActivity,
      },
    );
    coordinator.start();
    completions.get("Stan")?.resolve(completedOutcome("Stan", "goal-copper"));
    await vi.waitFor(() => expect(refreshSnapshot).toHaveBeenCalledTimes(1));
    let isIdle = false;
    const idle = coordinator.waitForIdle().then(() => {
      isIdle = true;
    });

    await Promise.resolve();
    expect(isIdle).toBe(false);

    refresh.resolve(refreshedSnapshot);
    await idle;
    expect(isIdle).toBe(true);
  });

  it("reports a planning failure after processing a terminal outcome", async () => {
    const assignment = buildAssignment("Stan", "goal-copper");
    const planError = new TestPlanError("replanning failed");
    const reportError = vi.fn();
    const plan: RollingActivityPlanner<TestActivityError, TestPlanError> = (
      _snapshot,
      state,
      previousOutcome,
    ) => (previousOutcome === undefined ? ok({ activities: [assignment], state }) : err(planError));
    const { completions, startActivity } = createStarter();
    const coordinator = createRollingActivityCoordinator(
      buildState(),
      buildSnapshot("2026-07-15T12:00:00.000Z"),
      {
        ...noSnapshotRetry,
        plan,
        refreshSnapshot: () => okAsync(buildSnapshot("2026-07-15T12:01:00.000Z")),
        reportError,
        startActivity,
      },
    );
    coordinator.start();

    completions.get("Stan")?.resolve(completedOutcome("Stan", "goal-copper"));
    await coordinator.waitForIdle();

    expect(reportError).toHaveBeenCalledWith(planError);
    expect(coordinator.getState().reservations).toEqual([]);
  });

  it("reports an unexpected refresh exception without keeping a stale Reservation", async () => {
    const assignment = buildAssignment("Stan", "goal-copper");
    const refreshError = new Error("refresh crashed");
    const reportError = vi.fn();
    const { completions, startActivity } = createStarter();
    const coordinator = createRollingActivityCoordinator(
      buildState(),
      buildSnapshot("2026-07-15T12:00:00.000Z"),
      {
        ...noSnapshotRetry,
        plan: (_snapshot, state) => ok({ activities: [assignment], state }),
        refreshSnapshot: () => {
          throw refreshError;
        },
        reportError,
        startActivity,
      },
    );
    coordinator.start();

    completions.get("Stan")?.resolve(completedOutcome("Stan", "goal-copper"));
    await coordinator.waitForIdle();

    expect(reportError).toHaveBeenCalledWith(refreshError);
    expect(coordinator.getState().reservations).toEqual([]);
  });

  it("returns an initial planning failure without starting work", async () => {
    const planError = new TestPlanError("planning failed");
    const { startActivity } = createStarter();
    const coordinator = createRollingActivityCoordinator(
      buildState(),
      buildSnapshot("2026-07-15T12:00:00.000Z"),
      {
        ...noSnapshotRetry,
        plan: () => err(planError),
        refreshSnapshot: () => okAsync(buildSnapshot("2026-07-15T12:01:00.000Z")),
        reportError: vi.fn(),
        startActivity,
      },
    );

    const result = coordinator.start();
    await coordinator.waitForIdle();

    expect(result.isErr() && result.error).toBe(planError);
    expect(startActivity).not.toHaveBeenCalled();
  });
});
