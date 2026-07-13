import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactsClient } from "../src/client/index.js";

// The interesting logic here is the diffing/orchestration in
// reconcileTasks/runTaskSupervisor, not runTask itself (already covered by
// runTask.test.ts) - so runTask is mocked with a controllable stand-in that
// only resolves once its AbortSignal is aborted, exactly like a real
// forever-looping task would (see runForever's doc comment).
const { runTaskMock } = vi.hoisted(() => ({
  runTaskMock: vi.fn(
    (_client: unknown, _character: string, _task: unknown, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }

        signal?.addEventListener("abort", () => resolve());
      }),
  ),
}));

vi.mock("../src/bot/tasks/runTask.js", () => ({ runTask: runTaskMock }));

import { reconcileTasks, runTaskSupervisor } from "../src/bot/taskSupervisor.js";

const fakeClient = {} as ArtifactsClient;

describe("reconcileTasks", () => {
  beforeEach(() => {
    runTaskMock.mockClear();
  });

  it("starts characters newly added to assignments", async () => {
    const running = new Map();

    await reconcileTasks(fakeClient, running, [
      { character: "Cartman", task: { type: "autoHunt" } },
    ]);

    expect(runTaskMock).toHaveBeenCalledWith(
      fakeClient,
      "Cartman",
      { type: "autoHunt" },
      expect.any(AbortSignal),
    );
    expect(running.has("Cartman")).toBe(true);
  });

  it("leaves an unchanged character running untouched", async () => {
    const running = new Map();
    const assignment = { character: "Cartman", task: { type: "autoHunt" as const } };

    await reconcileTasks(fakeClient, running, [assignment]);
    const firstRun = running.get("Cartman");

    await reconcileTasks(fakeClient, running, [assignment]);

    expect(running.get("Cartman")).toBe(firstRun);
    expect(runTaskMock).toHaveBeenCalledTimes(1);
  });

  it("restarts a character whose task changed, waiting for the old run to stop first", async () => {
    const running = new Map();

    await reconcileTasks(fakeClient, running, [
      { character: "Cartman", task: { type: "autoHunt" } },
    ]);

    // reconcileTasks awaits the old run's promise before starting the new
    // one; the mock only resolves once aborted, so this resolving at all
    // proves the old controller was actually aborted first.
    await reconcileTasks(fakeClient, running, [
      { character: "Cartman", task: { resource: "copper_rocks", type: "farm" } },
    ]);

    expect(runTaskMock).toHaveBeenCalledTimes(2);
    expect(runTaskMock).toHaveBeenNthCalledWith(
      2,
      fakeClient,
      "Cartman",
      { resource: "copper_rocks", type: "farm" },
      expect.any(AbortSignal),
    );
  });

  it("stops a character removed from assignments", async () => {
    const running = new Map();

    await reconcileTasks(fakeClient, running, [
      { character: "Cartman", task: { type: "autoHunt" } },
    ]);
    await reconcileTasks(fakeClient, running, []);

    expect(running.has("Cartman")).toBe(false);
  });

  it("doesn't touch other characters when only one is reassigned", async () => {
    const running = new Map();

    await reconcileTasks(fakeClient, running, [
      { character: "Cartman", task: { type: "autoHunt" } },
      { character: "Stan", task: { type: "autoHunt" } },
    ]);
    runTaskMock.mockClear();
    const stanRun = running.get("Stan");

    await reconcileTasks(fakeClient, running, [
      { character: "Cartman", task: { resource: "copper_rocks", type: "farm" } },
      { character: "Stan", task: { type: "autoHunt" } },
    ]);

    expect(runTaskMock).toHaveBeenCalledTimes(1);
    expect(running.get("Stan")).toBe(stanRun);
  });
});

describe("runTaskSupervisor", () => {
  beforeEach(() => {
    runTaskMock.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconciles immediately, then again every reloadIntervalMs", async () => {
    let call = 0;
    const loadAssignments = vi.fn(() => {
      call += 1;
      return call === 1
        ? [{ character: "Cartman", task: { type: "autoHunt" as const } }]
        : [
            { character: "Cartman", task: { type: "autoHunt" as const } },
            { character: "Stan", task: { type: "autoHunt" as const } },
          ];
    });

    void runTaskSupervisor(fakeClient, loadAssignments, 10_000);

    await vi.advanceTimersByTimeAsync(0);
    expect(runTaskMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runTaskMock).toHaveBeenCalledTimes(2);
  });

  it("keeps running (and retries later) when loadAssignments throws", async () => {
    let calls = 0;
    const flakyLoad = vi.fn(() => {
      calls += 1;

      if (calls === 2) {
        throw new Error("boom");
      }

      return [{ character: "Cartman", task: { type: "autoHunt" as const } }];
    });

    void runTaskSupervisor(fakeClient, flakyLoad, 10_000);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(flakyLoad).toHaveBeenCalledTimes(3);
  });
});
