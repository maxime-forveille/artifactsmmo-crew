import { errAsync, okAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCharacterAgent } from "../src/bot/characters/characterAgent.js";
import { ArtifactsApiError } from "../src/client/index.js";
import type { ArtifactsClient } from "../src/client/index.js";
import type { components } from "../src/client/schema.js";

type MovementData = components["schemas"]["CharacterMovementDataSchema"];
type MovementResponse = components["schemas"]["CharacterMovementResponseSchema"];
type CharacterSnapshot = components["schemas"]["CharacterSchema"];
type CharacterResponse = components["schemas"]["CharacterResponseSchema"];
type Cooldown = components["schemas"]["CooldownSchema"];

type Dependencies = Pick<
  ArtifactsClient,
  | "craft"
  | "depositGold"
  | "depositItems"
  | "equip"
  | "fight"
  | "gather"
  | "getCharacter"
  | "giveItems"
  | "moveCharacter"
  | "rest"
  | "unequip"
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

// Most `CharacterSchema` fields are irrelevant to the agent's cooldown/
// position logic, so they're stubbed out rather than filled with a full
// fixture; only `map_id` and `cooldown_expiration` are ever asserted on.
const buildCharacter = (overrides: Partial<CharacterSnapshot> = {}): CharacterSnapshot => ({
  ...({} as CharacterSnapshot),
  map_id: 1,
  ...overrides,
});

const buildCharacterResponse = (overrides: Partial<CharacterSnapshot> = {}): CharacterResponse => ({
  data: buildCharacter(overrides),
});

const buildMovementResponse = (expiration: string, mapId: number): MovementResponse => ({
  data: {
    character: buildCharacter({ map_id: mapId }),
    cooldown: buildCooldown(expiration),
    destination: {} as MovementData["destination"],
    path: [],
  },
});

type SkillResponse = components["schemas"]["SkillResponseSchema"];
type EquipmentResponse = components["schemas"]["EquipmentResponseSchema"];

const buildCraftResponse = (expiration: string): SkillResponse => ({
  data: {
    character: buildCharacter(),
    cooldown: buildCooldown(expiration),
    details: { items: [], xp: 10 },
  },
});

const buildEquipResponse = (expiration: string): EquipmentResponse => ({
  data: {
    character: buildCharacter(),
    cooldown: buildCooldown(expiration),
    items: [],
  },
});

type FightResponse = components["schemas"]["CharacterFightResponseSchema"];

const buildFightResponse = (
  expiration: string,
  characters: CharacterSnapshot[],
): FightResponse => ({
  data: {
    characters,
    cooldown: buildCooldown(expiration),
    fight: { logs: [], opponent: "chicken", result: "win", turns: 3, characters: [] },
  },
});

const notImplemented = () =>
  errAsync(new ArtifactsApiError("not implemented in test", 501, undefined));

const defaultDependencies: Dependencies = {
  craft: notImplemented,
  depositGold: notImplemented,
  depositItems: notImplemented,
  equip: notImplemented,
  fight: notImplemented,
  gather: notImplemented,
  getCharacter: () => okAsync(buildCharacterResponse()),
  giveItems: notImplemented,
  moveCharacter: notImplemented,
  rest: notImplemented,
  unequip: notImplemented,
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
    const moveCharacter = vi.fn(() =>
      okAsync(buildMovementResponse("2024-01-01T00:00:05.000Z", 2)),
    );
    const dependencies: Dependencies = { ...defaultDependencies, moveCharacter };

    const agent = (await createCharacterAgent(dependencies, "Cartman"))._unsafeUnwrap();
    const result = await agent.move({ x: 1, y: 1 });

    expect(moveCharacter).toHaveBeenCalledTimes(1);
    expect(moveCharacter).toHaveBeenCalledWith("Cartman", { x: 1, y: 1 });
    expect(result.isOk()).toBe(true);
  });

  it("waits out a cooldown seeded from the character's state before the first action", async () => {
    const moveCharacter = vi.fn(() =>
      okAsync(buildMovementResponse("2024-01-01T00:00:10.000Z", 2)),
    );
    const dependencies: Dependencies = {
      ...defaultDependencies,
      getCharacter: () =>
        okAsync(buildCharacterResponse({ cooldown_expiration: "2024-01-01T00:00:05.000Z" })),
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
      .mockReturnValueOnce(okAsync(buildMovementResponse("2024-01-01T00:00:05.000Z", 2)))
      .mockReturnValueOnce(okAsync(buildMovementResponse("2024-01-01T00:00:10.000Z", 3)));
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

  it("getCharacter reflects the latest known snapshot, updated after each action", async () => {
    const moveCharacter = vi.fn(() =>
      okAsync(buildMovementResponse("2024-01-01T00:00:05.000Z", 42)),
    );
    const dependencies: Dependencies = {
      ...defaultDependencies,
      getCharacter: () => okAsync(buildCharacterResponse({ map_id: 1 })),
      moveCharacter,
    };

    const agent = (await createCharacterAgent(dependencies, "Cartman"))._unsafeUnwrap();
    expect(agent.getCharacter().map_id).toBe(1);

    await agent.move({ x: 1, y: 1 });

    expect(agent.getCharacter().map_id).toBe(42);
  });

  it("moveTo skips the move call when the character is already at the target map", async () => {
    const moveCharacter = vi.fn(() =>
      okAsync(buildMovementResponse("2024-01-01T00:00:05.000Z", 5)),
    );
    const dependencies: Dependencies = {
      ...defaultDependencies,
      getCharacter: () => okAsync(buildCharacterResponse({ map_id: 5 })),
      moveCharacter,
    };

    const agent = (await createCharacterAgent(dependencies, "Cartman"))._unsafeUnwrap();
    const result = await agent.moveTo(5);

    expect(moveCharacter).not.toHaveBeenCalled();
    expect(result.isOk()).toBe(true);
  });

  it("moveTo moves the character when not at the target map", async () => {
    const moveCharacter = vi.fn(() =>
      okAsync(buildMovementResponse("2024-01-01T00:00:05.000Z", 5)),
    );
    const dependencies: Dependencies = {
      ...defaultDependencies,
      getCharacter: () => okAsync(buildCharacterResponse({ map_id: 1 })),
      moveCharacter,
    };

    const agent = (await createCharacterAgent(dependencies, "Cartman"))._unsafeUnwrap();
    const result = await agent.moveTo(5);

    expect(moveCharacter).toHaveBeenCalledWith("Cartman", { map_id: 5 });
    expect(result.isOk()).toBe(true);
    expect(agent.getCharacter().map_id).toBe(5);
  });

  it("craft defaults to quantity undefined and forwards it to the client", async () => {
    const craft = vi.fn(() => okAsync(buildCraftResponse("2024-01-01T00:00:05.000Z")));
    const dependencies: Dependencies = { ...defaultDependencies, craft };

    const agent = (await createCharacterAgent(dependencies, "Cartman"))._unsafeUnwrap();
    const result = await agent.craft("copper_bar", 6);

    expect(craft).toHaveBeenCalledWith("Cartman", "copper_bar", 6);
    expect(result.isOk()).toBe(true);
  });

  it("fight forwards participants and updates the cached snapshot from the matching entry", async () => {
    const fight = vi.fn(() =>
      okAsync(
        buildFightResponse("2024-01-01T00:00:05.000Z", [
          buildCharacter({ hp: 42, map_id: 1, name: "Kyle" }),
          buildCharacter({ hp: 130, map_id: 1, name: "Cartman" }),
        ]),
      ),
    );
    const dependencies: Dependencies = { ...defaultDependencies, fight };

    const agent = (await createCharacterAgent(dependencies, "Cartman"))._unsafeUnwrap();
    const result = await agent.fight(["Kyle"]);

    expect(fight).toHaveBeenCalledWith("Cartman", ["Kyle"]);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().fight.result).toBe("win");
    expect(agent.getCharacter().hp).toBe(130);
  });

  it("equip forwards the item list to the client", async () => {
    const equip = vi.fn(() => okAsync(buildEquipResponse("2024-01-01T00:00:05.000Z")));
    const dependencies: Dependencies = { ...defaultDependencies, equip };

    const agent = (await createCharacterAgent(dependencies, "Cartman"))._unsafeUnwrap();
    const result = await agent.equip([{ code: "copper_pickaxe", quantity: 1, slot: "weapon" }]);

    expect(equip).toHaveBeenCalledWith("Cartman", [
      { code: "copper_pickaxe", quantity: 1, slot: "weapon" },
    ]);
    expect(result.isOk()).toBe(true);
  });

  it("unequip forwards the slot list to the client", async () => {
    const unequip = vi.fn(() => okAsync(buildEquipResponse("2024-01-01T00:00:05.000Z")));
    const dependencies: Dependencies = { ...defaultDependencies, unequip };

    const agent = (await createCharacterAgent(dependencies, "Cartman"))._unsafeUnwrap();
    const result = await agent.unequip([{ quantity: 1, slot: "weapon" }]);

    expect(unequip).toHaveBeenCalledWith("Cartman", [{ quantity: 1, slot: "weapon" }]);
    expect(result.isOk()).toBe(true);
  });

  it("giveItems forwards the receiver and item list to the client", async () => {
    const giveItems = vi.fn(() =>
      okAsync({
        data: {
          character: buildCharacter(),
          cooldown: buildCooldown("2024-01-01T00:00:05.000Z"),
          items: [{ code: "copper_dagger", quantity: 1 }],
          receiver_character: buildCharacter({ name: "Stan" }),
        },
      }),
    );
    const dependencies: Dependencies = { ...defaultDependencies, giveItems };

    const agent = (await createCharacterAgent(dependencies, "Cartman"))._unsafeUnwrap();
    const result = await agent.giveItems("Stan", [{ code: "copper_dagger", quantity: 1 }]);

    expect(giveItems).toHaveBeenCalledWith("Cartman", "Stan", [
      { code: "copper_dagger", quantity: 1 },
    ]);
    expect(result.isOk()).toBe(true);
  });
});
