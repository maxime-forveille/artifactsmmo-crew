import { err, errAsync, ok, okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  createConfiguredCrewRuntime,
  resolveConfiguredItems,
  resolveConfiguredResources,
  resolveEquipmentMaterials,
} from '../src/bot/runtime/configuredCrewRuntime.js';
import {
  ArtifactsApiError,
  type ArtifactsClient,
} from '../src/client/index.js';
import type { components } from '../src/client/schema.js';
import { createInMemoryOrchestratorStateRepository } from '../src/persistence/inMemoryOrchestratorStateRepository.js';
import type { OrchestrationConfig } from '../src/utils/orchestrationConfig.js';

type BankPage = components['schemas']['DataPage_SimpleItemSchema_'];
type Character = components['schemas']['CharacterSchema'];
type Item = components['schemas']['ItemSchema'];
type Monster = components['schemas']['MonsterSchema'];
type Resource = components['schemas']['ResourceSchema'];

class TestRepositoryError extends Error {}

const buildCharacter = (): Character => ({
  ...({} as Character),
  inventory: [],
  level: 5,
  name: 'Stan',
  weapon_slot: 'copper_dagger',
});

const buildItem = (code: string): Item => ({
  ...({} as Item),
  code,
  level: 1,
  name: code,
  type: 'weapon',
});

const buildMonster = (code: string, itemCode: string): Monster => ({
  ...({} as Monster),
  code,
  drops: [{ code: itemCode, max_quantity: 1, min_quantity: 1, rate: 1 }],
  level: 1,
  name: code,
});

const buildResource = (code: string, itemCode?: string): Resource => ({
  code,
  drops:
    itemCode === undefined
      ? []
      : [{ code: itemCode, max_quantity: 1, min_quantity: 1, rate: 1 }],
  level: 1,
  name: code,
  skill: 'mining',
});

const buildPage = <T>(data: T[]) => ({
  data,
  page: 1,
  pages: 1,
  size: 100,
  total: data.length,
});

const buildConfig = (): OrchestrationConfig => ({
  goals: [
    {
      id: 'goal-copper',
      itemCode: 'copper_ore',
      minimumBankQuantity: 50,
      resourceCode: 'copper_rocks',
      type: 'replenishBankItem',
    },
    {
      id: 'goal-ash',
      itemCode: 'ash_wood',
      minimumBankQuantity: 25,
      resourceCode: 'ash_tree',
      type: 'replenishBankItem',
    },
  ],
});

const buildEquipmentConfig = (): OrchestrationConfig => ({
  goals: [
    {
      characterName: 'Stan',
      id: 'equip-stan-dagger',
      itemCode: 'copper_dagger',
      type: 'equipItem',
    },
  ],
});

const buildBankPage = (): BankPage => ({
  data: [
    { code: 'ash_wood', quantity: 25 },
    { code: 'copper_ore', quantity: 50 },
  ],
  page: 1,
  pages: 1,
  size: 100,
  total: 2,
});

describe('resolveConfiguredItems', () => {
  it('resolves equipment targets while preserving Goal ids', async () => {
    const getItem = vi.fn((code: string) => okAsync({ data: buildItem(code) }));
    const client = { getItem } as Pick<ArtifactsClient, 'getItem'>;

    const result = await resolveConfiguredItems(client, buildEquipmentConfig());

    expect(result.isOk() && result.value).toEqual([
      { goalId: 'equip-stan-dagger', item: buildItem('copper_dagger') },
    ]);
    expect(getItem).toHaveBeenCalledWith('copper_dagger');
  });

  it('propagates an item catalog failure', async () => {
    const apiError = new ArtifactsApiError('unavailable', 503, {});
    const getItem = vi.fn(() => errAsync(apiError));
    const client = { getItem } as Pick<ArtifactsClient, 'getItem'>;

    const result = await resolveConfiguredItems(client, buildEquipmentConfig());

    expect(result.isErr() && result.error).toBe(apiError);
  });

  it('does not query items for resource Goals', async () => {
    const getItem = vi.fn();
    const client = { getItem } as unknown as Pick<ArtifactsClient, 'getItem'>;

    const result = await resolveConfiguredItems(client, buildConfig());

    expect(result.isOk() && result.value).toEqual([]);
    expect(getItem).not.toHaveBeenCalled();
  });
});

describe('resolveEquipmentMaterials', () => {
  const buildResolvedItem = (materialCodes: readonly string[]) => ({
    goalId: 'equip-stan-dagger',
    item: {
      ...buildItem('copper_dagger'),
      craft: {
        items: materialCodes.map((code) => ({ code, quantity: 1 })),
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting' as const,
      },
    },
  });

  it('resolves a direct material with one gather source', async () => {
    const material = buildItem('copper_ore');
    const resource = buildResource('copper_rocks', 'copper_ore');
    const getItem = vi.fn(() => okAsync({ data: material }));
    const getMonsters = vi.fn(() => okAsync(buildPage([])));
    const getResources = vi.fn(() => okAsync(buildPage([resource])));

    const result = await resolveEquipmentMaterials(
      { getItem, getMonsters, getResources },
      [buildResolvedItem(['copper_ore'])],
    );

    expect(result._unsafeUnwrap()).toEqual({
      items: [{ goalId: 'equip-stan-dagger', item: material }],
      sources: [
        {
          goalId: 'equip-stan-dagger',
          materialSource: {
            itemCode: 'copper_ore',
            source: { resource, type: 'gather' },
          },
        },
      ],
    });
    expect(getMonsters).toHaveBeenCalledWith({ drop: 'copper_ore', size: 100 });
    expect(getResources).toHaveBeenCalledWith({
      drop: 'copper_ore',
      size: 100,
    });
  });

  it('resolves a direct material with one monster source', async () => {
    const material = buildItem('yellow_slimeball');
    const monster = buildMonster('yellow_slime', 'yellow_slimeball');
    const getItem = vi.fn(() => okAsync({ data: material }));
    const getMonsters = vi.fn(() => okAsync(buildPage([monster])));
    const getResources = vi.fn(() => okAsync(buildPage([])));

    const result = await resolveEquipmentMaterials(
      { getItem, getMonsters, getResources },
      [buildResolvedItem(['yellow_slimeball'])],
    );

    expect(result._unsafeUnwrap()).toEqual({
      items: [{ goalId: 'equip-stan-dagger', item: material }],
      sources: [
        {
          goalId: 'equip-stan-dagger',
          materialSource: {
            itemCode: 'yellow_slimeball',
            source: { monster, type: 'monster' },
          },
        },
      ],
    });
  });

  it('leaves a material source unresolved when no catalog source exists', async () => {
    const material = buildItem('unknown_material');
    const getItem = vi.fn(() => okAsync({ data: material }));
    const getMonsters = vi.fn(() => okAsync(buildPage([])));
    const getResources = vi.fn(() => okAsync(buildPage([])));

    const result = await resolveEquipmentMaterials(
      { getItem, getMonsters, getResources },
      [buildResolvedItem(['unknown_material'])],
    );

    expect(result._unsafeUnwrap()).toEqual({
      items: [{ goalId: 'equip-stan-dagger', item: material }],
      sources: [],
    });
  });

  it('does not choose between resource and monster sources when both can produce the material', async () => {
    const material = buildItem('slime_residue');
    const getItem = vi.fn(() => okAsync({ data: material }));
    const getMonsters = vi.fn(() =>
      okAsync(buildPage([buildMonster('yellow_slime', 'slime_residue')])),
    );
    const getResources = vi.fn(() =>
      okAsync(buildPage([buildResource('slime_pool', 'slime_residue')])),
    );

    const result = await resolveEquipmentMaterials(
      { getItem, getMonsters, getResources },
      [buildResolvedItem(['slime_residue'])],
    );

    expect(result._unsafeUnwrap()).toEqual({
      items: [{ goalId: 'equip-stan-dagger', item: material }],
      sources: [],
    });
  });

  it('queries a repeated direct material only once per Goal', async () => {
    const getItem = vi.fn(() => okAsync({ data: buildItem('copper_ore') }));
    const getMonsters = vi.fn(() => okAsync(buildPage([])));
    const getResources = vi.fn(() => okAsync(buildPage([])));

    await resolveEquipmentMaterials({ getItem, getMonsters, getResources }, [
      buildResolvedItem(['copper_ore', 'copper_ore']),
    ]);

    expect(getItem).toHaveBeenCalledOnce();
    expect(getMonsters).toHaveBeenCalledOnce();
    expect(getResources).toHaveBeenCalledOnce();
  });

  it('recursively resolves craftable intermediates down to a raw source', async () => {
    const copperOre = buildItem('copper_ore');
    const copperBar = {
      ...buildItem('copper_bar'),
      craft: {
        items: [{ code: 'copper_ore', quantity: 3 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting' as const,
      },
    };
    const resource = buildResource('copper_rocks', 'copper_ore');
    const getItem = vi.fn((code: string) =>
      okAsync({ data: code === 'copper_bar' ? copperBar : copperOre }),
    );
    const getMonsters = vi.fn(() => okAsync(buildPage([])));
    const getResources = vi.fn(() => okAsync(buildPage([resource])));

    const result = await resolveEquipmentMaterials(
      { getItem, getMonsters, getResources },
      [buildResolvedItem(['copper_bar'])],
    );

    expect(result._unsafeUnwrap()).toEqual({
      items: [
        { goalId: 'equip-stan-dagger', item: copperBar },
        { goalId: 'equip-stan-dagger', item: copperOre },
      ],
      sources: [
        {
          goalId: 'equip-stan-dagger',
          materialSource: {
            itemCode: 'copper_ore',
            source: { resource, type: 'gather' },
          },
        },
      ],
    });
    expect(getMonsters).toHaveBeenCalledOnce();
    expect(getResources).toHaveBeenCalledOnce();
  });

  it('stops descending when a material recipe points back to an ancestor', async () => {
    const copperBar = {
      ...buildItem('copper_bar'),
      craft: {
        items: [{ code: 'copper_dagger', quantity: 1 }],
        level: 1,
        quantity: 1,
        skill: 'weaponcrafting' as const,
      },
    };
    const getItem = vi.fn(() => okAsync({ data: copperBar }));
    const getMonsters = vi.fn();
    const getResources = vi.fn();

    const result = await resolveEquipmentMaterials(
      { getItem, getMonsters, getResources } as unknown as Pick<
        ArtifactsClient,
        'getItem' | 'getMonsters' | 'getResources'
      >,
      [buildResolvedItem(['copper_bar'])],
    );

    expect(result._unsafeUnwrap()).toEqual({
      items: [{ goalId: 'equip-stan-dagger', item: copperBar }],
      sources: [],
    });
    expect(getItem).toHaveBeenCalledOnce();
    expect(getMonsters).not.toHaveBeenCalled();
    expect(getResources).not.toHaveBeenCalled();
  });

  it('propagates a material catalog failure', async () => {
    const apiError = new ArtifactsApiError('unavailable', 503, {});
    const getItem = vi.fn(() => okAsync({ data: buildItem('copper_ore') }));
    const getMonsters = vi.fn(() => errAsync(apiError));
    const getResources = vi.fn(() => okAsync(buildPage([])));

    const result = await resolveEquipmentMaterials(
      { getItem, getMonsters, getResources },
      [buildResolvedItem(['copper_ore'])],
    );

    expect(result.isErr() && result.error).toBe(apiError);
  });
});

describe('resolveConfiguredResources', () => {
  it('resolves every configured resource while preserving Goal ids', async () => {
    const getResource = vi.fn((code: string) =>
      okAsync({ data: buildResource(code) }),
    );
    const client = { getResource } as Pick<ArtifactsClient, 'getResource'>;

    const result = await resolveConfiguredResources(client, buildConfig());

    expect(result.isOk() && result.value).toEqual([
      { goalId: 'goal-copper', resource: buildResource('copper_rocks') },
      { goalId: 'goal-ash', resource: buildResource('ash_tree') },
    ]);
    expect(getResource).toHaveBeenNthCalledWith(1, 'copper_rocks');
    expect(getResource).toHaveBeenNthCalledWith(2, 'ash_tree');
  });

  it('propagates a catalog failure instead of building a partial mapping', async () => {
    const apiError = new ArtifactsApiError('unavailable', 503, {});
    const getResource = vi.fn((code: string) =>
      code === 'ash_tree'
        ? errAsync(apiError)
        : okAsync({ data: buildResource(code) }),
    );
    const client = { getResource } as Pick<ArtifactsClient, 'getResource'>;

    const result = await resolveConfiguredResources(client, buildConfig());

    expect(result.isErr() && result.error).toBe(apiError);
  });

  it('does not query the catalog when no Goals are configured', async () => {
    const getResource = vi.fn();
    const client = { getResource } as unknown as Pick<
      ArtifactsClient,
      'getResource'
    >;

    const result = await resolveConfiguredResources(client, { goals: [] });

    expect(result.isOk() && result.value).toEqual([]);
    expect(getResource).not.toHaveBeenCalled();
  });
});

describe('createConfiguredCrewRuntime', () => {
  it('restores and completes an already-satisfied durable Goal without starting an Action', async () => {
    const getBankItems = vi.fn(() =>
      okAsync({ ...buildBankPage(), data: [], total: 0 }),
    );
    const getItem = vi.fn((code: string) => okAsync({ data: buildItem(code) }));
    const getMyCharacters = vi.fn(() => okAsync({ data: [buildCharacter()] }));
    const client = {
      getBankItems,
      getItem,
      getMyCharacters,
    } as unknown as ArtifactsClient;
    const stateRepository = createInMemoryOrchestratorStateRepository({
      goals: [
        {
          characterName: 'Stan',
          id: 'equip-stan-dagger',
          itemCode: 'copper_dagger',
          origin: 'configured',
          type: 'equipItem',
        },
      ],
    });

    const result = await createConfiguredCrewRuntime(client, {
      config: { goals: [] },
      reportError: vi.fn(),
      stateRepository,
      waitBeforeRetry: vi.fn(async () => undefined),
    });
    const runtime = result._unsafeUnwrap();

    expect(runtime.getState()).toEqual({
      goals: [
        {
          characterName: 'Stan',
          id: 'equip-stan-dagger',
          itemCode: 'copper_dagger',
          origin: 'configured',
          type: 'equipItem',
        },
      ],
      reservations: [],
    });
    expect(runtime.start().isOk()).toBe(true);
    expect(runtime.getState()).toEqual({ goals: [], reservations: [] });
    expect(getItem).toHaveBeenCalledWith('copper_dagger');
    expect(getMyCharacters).toHaveBeenCalledOnce();
    expect(getBankItems).toHaveBeenCalledOnce();
    expect(stateRepository.load()._unsafeUnwrap()).toEqual({ goals: [] });
  });

  it('builds a runtime from resolved resources and validated Goals', async () => {
    const getResource = vi.fn((code: string) =>
      okAsync({ data: buildResource(code) }),
    );
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
      stateRepository: createInMemoryOrchestratorStateRepository(),
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

  it('restores an explicitly persisted empty state without resolving fallback Goals', async () => {
    const getBankItems = vi.fn(() => okAsync(buildBankPage()));
    const getItem = vi.fn();
    const getMyCharacters = vi.fn(() => okAsync({ data: [buildCharacter()] }));
    const getResource = vi.fn();
    const stateRepository = createInMemoryOrchestratorStateRepository({
      goals: [],
    });

    const result = await createConfiguredCrewRuntime(
      {
        getBankItems,
        getItem,
        getMyCharacters,
        getResource,
      } as unknown as ArtifactsClient,
      {
        config: {
          goals: [...buildConfig().goals, ...buildEquipmentConfig().goals],
        },
        reportError: vi.fn(),
        stateRepository,
        waitBeforeRetry: vi.fn(async () => undefined),
      },
    );
    const runtime = result._unsafeUnwrap();

    expect(runtime.getState()).toEqual({ goals: [], reservations: [] });
    expect(runtime.start().isOk()).toBe(true);
    expect(stateRepository.load()._unsafeUnwrap()).toEqual({ goals: [] });
    expect(getItem).not.toHaveBeenCalled();
    expect(getResource).not.toHaveBeenCalled();
  });

  it('returns a repository load failure before reading the Artifacts API', async () => {
    const repositoryError = new TestRepositoryError('load failed');
    const getBankItems = vi.fn();
    const getItem = vi.fn();
    const getMyCharacters = vi.fn();

    const result = await createConfiguredCrewRuntime(
      { getBankItems, getItem, getMyCharacters } as unknown as ArtifactsClient,
      {
        config: buildEquipmentConfig(),
        reportError: vi.fn(),
        stateRepository: {
          load: () => err(repositoryError),
          save: () => ok(undefined),
        },
        waitBeforeRetry: vi.fn(async () => undefined),
      },
    );

    expect(result.isErr() && result.error).toBe(repositoryError);
    expect(getBankItems).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    expect(getMyCharacters).not.toHaveBeenCalled();
  });

  it('does not start planned work when durable state cannot be saved', async () => {
    const repositoryError = new TestRepositoryError('save failed');
    const save = vi.fn(() => err(repositoryError));
    const getBankItems = vi.fn(() =>
      okAsync({ ...buildBankPage(), data: [], total: 0 }),
    );
    const getItem = vi.fn((code: string) => okAsync({ data: buildItem(code) }));
    const equip = vi.fn();
    const getMyCharacters = vi.fn(() =>
      okAsync({
        data: [
          {
            ...buildCharacter(),
            inventory: [{ code: 'copper_dagger', quantity: 1 }],
            weapon_slot: '',
          },
        ],
      }),
    );

    const result = await createConfiguredCrewRuntime(
      {
        equip,
        getBankItems,
        getItem,
        getMyCharacters,
      } as unknown as ArtifactsClient,
      {
        config: buildEquipmentConfig(),
        reportError: vi.fn(),
        stateRepository: { load: () => ok(undefined), save },
        waitBeforeRetry: vi.fn(async () => undefined),
      },
    );
    const runtime = result._unsafeUnwrap();
    const started = runtime.start();

    expect(started.isErr() && started.error).toBe(repositoryError);
    expect(save).toHaveBeenCalledWith({
      goals: [
        {
          characterName: 'Stan',
          id: 'equip-stan-dagger',
          itemCode: 'copper_dagger',
          origin: 'configured',
          type: 'equipItem',
        },
      ],
    });
    expect(equip).not.toHaveBeenCalled();
    expect(runtime.getState().goals).toHaveLength(1);
  });
});
