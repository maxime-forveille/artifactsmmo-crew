import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";

import {
  createConfiguredCrewRuntime,
  resolveConfiguredItems,
  resolveConfiguredResources,
} from "../src/bot/runtime/configuredCrewRuntime.js";
import { ArtifactsApiError, type ArtifactsClient } from "../src/client/index.js";
import type { components } from "../src/client/schema.js";
import type { OrchestrationConfig } from "../src/utils/orchestrationConfig.js";

type BankPage = components["schemas"]["DataPage_SimpleItemSchema_"];
type Character = components["schemas"]["CharacterSchema"];
type Item = components["schemas"]["ItemSchema"];
type Resource = components["schemas"]["ResourceSchema"];

const buildCharacter = (): Character => ({
  ...({} as Character),
  inventory: [],
  level: 5,
  name: "Stan",
  weapon_slot: "copper_dagger",
});

const buildItem = (code: string): Item => ({
  ...({} as Item),
  code,
  level: 1,
  name: code,
  type: "weapon",
});

const buildResource = (code: string): Resource => ({
  code,
  drops: [],
  level: 1,
  name: code,
  skill: "mining",
});

const buildConfig = (): OrchestrationConfig => ({
  goals: [
    {
      id: "goal-copper",
      itemCode: "copper_ore",
      minimumBankQuantity: 50,
      resourceCode: "copper_rocks",
      type: "replenishBankItem",
    },
    {
      id: "goal-ash",
      itemCode: "ash_wood",
      minimumBankQuantity: 25,
      resourceCode: "ash_tree",
      type: "replenishBankItem",
    },
  ],
});

const buildEquipmentConfig = (): OrchestrationConfig => ({
  goals: [
    {
      characterName: "Stan",
      id: "equip-stan-dagger",
      itemCode: "copper_dagger",
      type: "equipItem",
    },
  ],
});

const buildBankPage = (): BankPage => ({
  data: [
    { code: "ash_wood", quantity: 25 },
    { code: "copper_ore", quantity: 50 },
  ],
  page: 1,
  pages: 1,
  size: 100,
  total: 2,
});

describe("resolveConfiguredItems", () => {
  it("resolves equipment targets while preserving Goal ids", async () => {
    const getItem = vi.fn((code: string) => okAsync({ data: buildItem(code) }));
    const client = { getItem } as Pick<ArtifactsClient, "getItem">;

    const result = await resolveConfiguredItems(client, buildEquipmentConfig());

    expect(result.isOk() && result.value).toEqual([
      { goalId: "equip-stan-dagger", item: buildItem("copper_dagger") },
    ]);
    expect(getItem).toHaveBeenCalledWith("copper_dagger");
  });

  it("propagates an item catalog failure", async () => {
    const apiError = new ArtifactsApiError("unavailable", 503, {});
    const getItem = vi.fn(() => errAsync(apiError));
    const client = { getItem } as Pick<ArtifactsClient, "getItem">;

    const result = await resolveConfiguredItems(client, buildEquipmentConfig());

    expect(result.isErr() && result.error).toBe(apiError);
  });

  it("does not query items for resource Goals", async () => {
    const getItem = vi.fn();
    const client = { getItem } as unknown as Pick<ArtifactsClient, "getItem">;

    const result = await resolveConfiguredItems(client, buildConfig());

    expect(result.isOk() && result.value).toEqual([]);
    expect(getItem).not.toHaveBeenCalled();
  });
});

describe("resolveConfiguredResources", () => {
  it("resolves every configured resource while preserving Goal ids", async () => {
    const getResource = vi.fn((code: string) => okAsync({ data: buildResource(code) }));
    const client = { getResource } as Pick<ArtifactsClient, "getResource">;

    const result = await resolveConfiguredResources(client, buildConfig());

    expect(result.isOk() && result.value).toEqual([
      { goalId: "goal-copper", resource: buildResource("copper_rocks") },
      { goalId: "goal-ash", resource: buildResource("ash_tree") },
    ]);
    expect(getResource).toHaveBeenNthCalledWith(1, "copper_rocks");
    expect(getResource).toHaveBeenNthCalledWith(2, "ash_tree");
  });

  it("propagates a catalog failure instead of building a partial mapping", async () => {
    const apiError = new ArtifactsApiError("unavailable", 503, {});
    const getResource = vi.fn((code: string) =>
      code === "ash_tree" ? errAsync(apiError) : okAsync({ data: buildResource(code) }),
    );
    const client = { getResource } as Pick<ArtifactsClient, "getResource">;

    const result = await resolveConfiguredResources(client, buildConfig());

    expect(result.isErr() && result.error).toBe(apiError);
  });

  it("does not query the catalog when no Goals are configured", async () => {
    const getResource = vi.fn();
    const client = { getResource } as unknown as Pick<ArtifactsClient, "getResource">;

    const result = await resolveConfiguredResources(client, { goals: [] });

    expect(result.isOk() && result.value).toEqual([]);
    expect(getResource).not.toHaveBeenCalled();
  });
});

describe("createConfiguredCrewRuntime", () => {
  it("completes an already-equipped configured Goal without starting an Action", async () => {
    const getBankItems = vi.fn(() => okAsync({ ...buildBankPage(), data: [], total: 0 }));
    const getItem = vi.fn((code: string) => okAsync({ data: buildItem(code) }));
    const getMyCharacters = vi.fn(() => okAsync({ data: [buildCharacter()] }));
    const client = {
      getBankItems,
      getItem,
      getMyCharacters,
    } as unknown as ArtifactsClient;

    const result = await createConfiguredCrewRuntime(client, {
      config: buildEquipmentConfig(),
      reportError: vi.fn(),
      waitBeforeRetry: vi.fn(async () => undefined),
    });
    const runtime = result._unsafeUnwrap();

    expect(runtime.start().isOk()).toBe(true);
    expect(runtime.getState()).toEqual({ goals: [], reservations: [] });
    expect(getItem).toHaveBeenCalledWith("copper_dagger");
    expect(getMyCharacters).toHaveBeenCalledOnce();
    expect(getBankItems).toHaveBeenCalledOnce();
  });

  it("builds a runtime from resolved resources and validated Goals", async () => {
    const getResource = vi.fn((code: string) => okAsync({ data: buildResource(code) }));
    const getBankItems = vi.fn(() => okAsync(buildBankPage()));
    const getMyCharacters = vi.fn(() => okAsync({ data: [] }));
    const client = {
      getBankItems,
      getMyCharacters,
      getResource,
    } as unknown as ArtifactsClient;
    const reportError = vi.fn();
    const waitBeforeRetry = vi.fn(async () => undefined);

    const result = await createConfiguredCrewRuntime(client, {
      config: buildConfig(),
      reportError,
      waitBeforeRetry,
    });
    const runtime = result._unsafeUnwrap();
    const started = runtime.start();

    expect(started.isOk()).toBe(true);
    expect(runtime.getState()).toEqual({ goals: [], reservations: [] });
    expect(getResource).toHaveBeenCalledTimes(2);
    expect(getMyCharacters).toHaveBeenCalledTimes(1);
    expect(getBankItems).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
    expect(waitBeforeRetry).not.toHaveBeenCalled();
  });
});
