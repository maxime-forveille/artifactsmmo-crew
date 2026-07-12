import { errAsync, okAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCharacterAgent } from "../src/bot/characters/characterAgent.js";
import { ArtifactsApiError } from "../src/client/index.js";
import type { ArtifactsClient } from "../src/client/index.js";
import type { components } from "../src/client/schema.js";

type MovementData = components["schemas"]["CharacterMovementDataSchema"];
type MovementResponse = components["schemas"]["CharacterMovementResponseSchema"];
type CharacterResponse = components["schemas"]["CharacterResponseSchema"];
type Cooldown = components["schemas"]["CooldownSchema"];

type Dependencies = Pick<
  ArtifactsClient,
  | "depositGold"
  | "depositItems"
  | "fight"
  | "gather"
  | "getCharacter"
  | "moveCharacter"
  | "rest"
  | "withdrawGold"
  | "withdrawItems"
>;

const buildCooldown = (expiration: string): Cooldown => ({
  expiration,
  reason: "movement",
  remaining_seconds: 0,
  started_at: "2024-01-01T00:00:00.000Z",
  total_seconds: 0,
});

// `character`, `destination` and most `CharacterSchema` fields are irrelevant
// to the agent's cooldown logic, so they're stubbed out rather than filled
// with a full fixture.
const buildMovementResponse = (expiration: string): MovementResponse => ({
  data: {
    character: {} as MovementData["character"],
    cooldown: buildCooldown(expiration),
    destination: {} as MovementData["destination"],
    path: [],
  },
});

const buildCharacterResponse = (cooldownExpiration?: string): CharacterResponse => ({
  data: {
    ...({} as CharacterResponse["data"]),
    ...(cooldownExpiration === undefined ? {} : { cooldown_expiration: cooldownExpiration }),
  },
});

const notImplemented = () =>
  errAsync(new ArtifactsApiError("not implemented in test", 501, undefined));

const defaultDependencies: Dependencies = {
  depositGold: notImplemented,
  depositItems: notImplemented,
  fight: notImplemented,
  gather: notImplemented,
  getCharacter: () => okAsync(buildCharacterResponse()),
  moveCharacter: notImplemented,
  rest: notImplemented,
  withdrawGold: notImplemented,
  withdrawItems: notImplemented,
};

describe("createCharacterAgent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("propagates a failure from the initial getCharacter call", async () => {
    const apiError = new ArtifactsApiError("character not found", 498, undefined);
    const dependencies: Dependencies = {
      ...defaultDependencies,
      getCharacter: () => errAsync(apiError),
    };

    const result = await createCharacterAgent(dependencies, "Cartman");

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(apiError);
  });

  it("performs the first move immediately when the character has no prior cooldown", async () => {
    const moveCharacter = vi.fn(() => okAsync(buildMovementResponse("2024-01-01T00:00:05.000Z")));
    const dependencies: Dependencies = { ...defaultDependencies, moveCharacter };

    const agent = (await createCharacterAgent(dependencies, "Cartman"))._unsafeUnwrap();
    const result = await agent.move({ x: 1, y: 1 });

    expect(moveCharacter).toHaveBeenCalledTimes(1);
    expect(moveCharacter).toHaveBeenCalledWith("Cartman", { x: 1, y: 1 });
    expect(result.isOk()).toBe(true);
  });

  it("waits out a cooldown seeded from the character's state before the first action", async () => {
    const moveCharacter = vi.fn(() => okAsync(buildMovementResponse("2024-01-01T00:00:10.000Z")));
    const dependencies: Dependencies = {
      ...defaultDependencies,
      getCharacter: () => okAsync(buildCharacterResponse("2024-01-01T00:00:05.000Z")),
      moveCharacter,
    };

    const agent = (await createCharacterAgent(dependencies, "Cartman"))._unsafeUnwrap();
    const movePromise = agent.move({ x: 1, y: 1 });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(moveCharacter).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await movePromise;

    expect(moveCharacter).toHaveBeenCalledTimes(1);
  });

  it("waits out the previous cooldown before issuing the next move", async () => {
    const moveCharacter = vi
      .fn()
      .mockReturnValueOnce(okAsync(buildMovementResponse("2024-01-01T00:00:05.000Z")))
      .mockReturnValueOnce(okAsync(buildMovementResponse("2024-01-01T00:00:10.000Z")));
    const dependencies: Dependencies = { ...defaultDependencies, moveCharacter };

    const agent = (await createCharacterAgent(dependencies, "Cartman"))._unsafeUnwrap();

    await agent.move({ x: 1, y: 1 });
    expect(moveCharacter).toHaveBeenCalledTimes(1);

    const secondMove = agent.move({ x: 2, y: 2 });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(moveCharacter).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await secondMove;

    expect(moveCharacter).toHaveBeenCalledTimes(2);
  });

  it("propagates a failed move as an Err without swallowing it", async () => {
    const apiError = new ArtifactsApiError("boom", 499, undefined);
    const dependencies: Dependencies = {
      ...defaultDependencies,
      moveCharacter: () => errAsync(apiError),
    };

    const agent = (await createCharacterAgent(dependencies, "Cartman"))._unsafeUnwrap();
    const result = await agent.move({ x: 1, y: 1 });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(apiError);
  });
});
