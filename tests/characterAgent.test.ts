import { errAsync, okAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCharacterAgent } from "../src/bot/characters/characterAgent.js";
import { ArtifactsApiError } from "../src/client/index.js";
import type { components } from "../src/client/schema.js";

type MovementData = components["schemas"]["CharacterMovementDataSchema"];
type MovementResponse = components["schemas"]["CharacterMovementResponseSchema"];
type Cooldown = components["schemas"]["CooldownSchema"];

const buildCooldown = (expiration: string): Cooldown => ({
  expiration,
  reason: "movement",
  remaining_seconds: 0,
  started_at: "2024-01-01T00:00:00.000Z",
  total_seconds: 0,
});

// `character` and `destination` are irrelevant to the agent's cooldown logic,
// so they're stubbed out rather than filled with a full fixture.
const buildMovementResponse = (expiration: string): MovementResponse => ({
  data: {
    character: {} as MovementData["character"],
    cooldown: buildCooldown(expiration),
    destination: {} as MovementData["destination"],
    path: [],
  },
});

describe("createCharacterAgent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("performs the first move immediately (no prior cooldown)", async () => {
    const moveCharacter = vi.fn(() => okAsync(buildMovementResponse("2024-01-01T00:00:05.000Z")));
    const agent = createCharacterAgent({ moveCharacter }, "Cartman");

    const result = await agent.move({ x: 1, y: 1 });

    expect(moveCharacter).toHaveBeenCalledTimes(1);
    expect(moveCharacter).toHaveBeenCalledWith("Cartman", { x: 1, y: 1 });
    expect(result.isOk()).toBe(true);
  });

  it("waits out the previous cooldown before issuing the next move", async () => {
    const moveCharacter = vi
      .fn()
      .mockReturnValueOnce(okAsync(buildMovementResponse("2024-01-01T00:00:05.000Z")))
      .mockReturnValueOnce(okAsync(buildMovementResponse("2024-01-01T00:00:10.000Z")));
    const agent = createCharacterAgent({ moveCharacter }, "Cartman");

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
    const moveCharacter = vi.fn(() => errAsync(apiError));
    const agent = createCharacterAgent({ moveCharacter }, "Cartman");

    const result = await agent.move({ x: 1, y: 1 });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(apiError);
  });
});
