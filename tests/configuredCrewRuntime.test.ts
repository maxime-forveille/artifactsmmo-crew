import { err, ok, okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { createConfiguredCrewRuntime } from '../src/bot/runtime/configuredCrewRuntime.js';
import type { ArtifactsClient } from '../src/client/index.js';
import type { components } from '../src/client/schema.js';
import { createInMemoryOrchestratorStateRepository } from '../src/persistence/inMemoryOrchestratorStateRepository.js';
import type { OrchestrationConfig } from '../src/utils/orchestrationConfig.js';

type BankPage = components['schemas']['DataPage_SimpleItemSchema_'];
type Character = components['schemas']['CharacterSchema'];
type Item = components['schemas']['ItemSchema'];
type Monster = components['schemas']['MonsterSchema'];
type Resource = components['schemas']['ResourceSchema'];

const goalRuleOrder = [
  'equipmentUpgrade',
  'combatProgression',
  'professionProgression',
  'gatheringProgression',
  'bankReplenishment',
  'bankSurplusProcessing',
] as const;

class TestRepositoryError extends Error {}

const buildCharacter = (overrides: Partial<Character> = {}): Character => ({
  ...({} as Character),
  attack_air: 0,
  attack_earth: 10,
  attack_fire: 0,
  attack_water: 0,
  critical_strike: 0,
  hp: 100,
  inventory: [],
  level: 5,
  max_hp: 100,
  mining_level: 5,
  name: 'Stan',
  res_air: 0,
  res_earth: 0,
  res_fire: 0,
  res_water: 0,
  weapon_slot: 'copper_dagger',
  ...overrides,
});

const buildItem = (code: string): Item => ({
  ...({} as Item),
  code,
  level: 1,
  name: code,
  type: 'weapon',
});

const buildMonster = (): Monster => ({
  ...({} as Monster),
  attack_air: 0,
  attack_earth: 1,
  attack_fire: 0,
  attack_water: 0,
  code: 'yellow_slime',
  critical_strike: 0,
  hp: 10,
  level: 2,
  name: 'Yellow Slime',
  res_air: 0,
  res_earth: 0,
  res_fire: 0,
  res_water: 0,
});

const buildResource = (code: string, itemCode: string): Resource => ({
  code,
  drops: [{ code: itemCode, max_quantity: 1, min_quantity: 1, rate: 1 }],
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

type ClientOptions = Readonly<{
  bank?: BankPage;
  characters?: readonly Character[];
  items?: readonly Item[];
  monsters?: readonly Monster[];
  resources?: readonly Resource[];
}>;

const buildClient = (options: ClientOptions = {}) => {
  const getBankItems = vi.fn(() => okAsync(options.bank ?? buildBankPage()));
  const getItems = vi.fn(() => okAsync(buildPage([...(options.items ?? [])])));
  const getMonsters = vi.fn(() =>
    okAsync(buildPage([...(options.monsters ?? [])])),
  );
  const getMyCharacters = vi.fn(() =>
    okAsync({ data: [...(options.characters ?? [buildCharacter()])] }),
  );
  const getResources = vi.fn(() =>
    okAsync(buildPage([...(options.resources ?? [])])),
  );

  return {
    client: {
      getBankItems,
      getItems,
      getMonsters,
      getMyCharacters,
      getResources,
    } as unknown as ArtifactsClient,
    getBankItems,
    getItems,
    getMonsters,
    getMyCharacters,
    getResources,
  };
};

describe('createConfiguredCrewRuntime', () => {
  it('restores and completes an already-satisfied durable Goal without starting an Action', async () => {
    const { client, getBankItems, getItems, getMyCharacters } = buildClient({
      bank: { ...buildBankPage(), data: [], total: 0 },
      items: [buildItem('copper_dagger')],
    });
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
    expect(getItems).toHaveBeenCalledOnce();
    expect(getMyCharacters).toHaveBeenCalledOnce();
    expect(getBankItems).toHaveBeenCalledOnce();
    expect(stateRepository.load()._unsafeUnwrap()).toEqual({ goals: [] });
  });

  it('builds a runtime from shared world knowledge and validated Goals', async () => {
    const { client, getBankItems, getMyCharacters, getResources } = buildClient(
      {
        characters: [],
        resources: [
          buildResource('ash_tree', 'ash_wood'),
          buildResource('copper_rocks', 'copper_ore'),
        ],
      },
    );
    const reportError = vi.fn();
    const waitBeforeRetry = vi.fn(async () => undefined);

    const result = await createConfiguredCrewRuntime(client, {
      config: buildConfig(),
      reportError,
      stateRepository: createInMemoryOrchestratorStateRepository(),
      waitBeforeRetry,
    });
    const runtime = result._unsafeUnwrap();

    expect(runtime.start().isOk()).toBe(true);
    expect(runtime.getState()).toEqual({ goals: [], reservations: [] });
    expect(getResources).toHaveBeenCalledOnce();
    expect(getMyCharacters).toHaveBeenCalledOnce();
    expect(getBankItems).toHaveBeenCalledOnce();
    expect(reportError).not.toHaveBeenCalled();
    expect(waitBeforeRetry).not.toHaveBeenCalled();
  });

  it('restores a resource Goal absent from configuration by using world knowledge', async () => {
    const { client, getResources } = buildClient({
      resources: [buildResource('copper_rocks', 'copper_ore')],
    });
    const stateRepository = createInMemoryOrchestratorStateRepository({
      goals: [
        {
          id: 'autonomous-copper-stock',
          itemCode: 'copper_ore',
          minimumBankQuantity: 50,
          origin: 'autonomous',
          reason: 'Keep enough ore for equipment prerequisites',
          rule: 'bankReplenishment',
          type: 'replenishBankItem',
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

    expect(runtime.start().isOk()).toBe(true);
    expect(runtime.getState()).toEqual({ goals: [], reservations: [] });
    expect(getResources).toHaveBeenCalledOnce();
    expect(stateRepository.load()._unsafeUnwrap()).toEqual({ goals: [] });
  });

  it('restores and completes an autonomous combat Goal absent from configuration', async () => {
    const { client, getMonsters } = buildClient();
    const stateRepository = createInMemoryOrchestratorStateRepository({
      goals: [
        {
          characterName: 'Stan',
          id: 'reachCombatLevel:Stan:5',
          origin: 'autonomous',
          reason: 'Progress Stan to the next combat frontier',
          rule: 'combatProgression',
          targetLevel: 5,
          type: 'reachCombatLevel',
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

    expect(runtime.start().isOk()).toBe(true);
    expect(runtime.getState()).toEqual({ goals: [], reservations: [] });
    expect(getMonsters).toHaveBeenCalledOnce();
    expect(stateRepository.load()._unsafeUnwrap()).toEqual({ goals: [] });
  });

  it('persists autonomous Goals before starting their Activities', async () => {
    const repositoryError = new TestRepositoryError('save failed');
    const save = vi.fn(() => err(repositoryError));
    const fight = vi.fn();
    const { client, getMonsters } = buildClient({ monsters: [buildMonster()] });

    const result = await createConfiguredCrewRuntime(
      { ...client, fight } as ArtifactsClient,
      {
        config: { goals: [], policy: { goalRuleOrder: [...goalRuleOrder] } },
        reportError: vi.fn(),
        stateRepository: { load: () => ok({ goals: [] }), save },
        waitBeforeRetry: vi.fn(async () => undefined),
      },
    );
    const runtime = result._unsafeUnwrap();

    expect(runtime.start()._unsafeUnwrapErr()).toBe(repositoryError);
    expect(save).toHaveBeenCalledWith({
      goals: [
        {
          characterName: 'Stan',
          id: 'reachCombatLevel:Stan:6',
          origin: 'autonomous',
          reason: 'Stan can progress from combat level 5 to 6',
          rule: 'combatProgression',
          targetLevel: 6,
          type: 'reachCombatLevel',
        },
      ],
    });
    expect(getMonsters).toHaveBeenCalledOnce();
    expect(fight).not.toHaveBeenCalled();
  });

  it('restores an explicitly persisted empty state without reading world knowledge', async () => {
    const { client, getItems, getMonsters, getResources } = buildClient();
    const stateRepository = createInMemoryOrchestratorStateRepository({
      goals: [],
    });

    const result = await createConfiguredCrewRuntime(client, {
      config: {
        goals: [...buildConfig().goals, ...buildEquipmentConfig().goals],
      },
      reportError: vi.fn(),
      stateRepository,
      waitBeforeRetry: vi.fn(async () => undefined),
    });
    const runtime = result._unsafeUnwrap();

    expect(runtime.getState()).toEqual({ goals: [], reservations: [] });
    expect(runtime.start().isOk()).toBe(true);
    expect(stateRepository.load()._unsafeUnwrap()).toEqual({ goals: [] });
    expect(getItems).not.toHaveBeenCalled();
    expect(getMonsters).not.toHaveBeenCalled();
    expect(getResources).not.toHaveBeenCalled();
  });

  it('returns a repository load failure before reading the Artifacts API', async () => {
    const repositoryError = new TestRepositoryError('load failed');
    const { client, getBankItems, getItems, getMyCharacters } = buildClient();

    const result = await createConfiguredCrewRuntime(client, {
      config: buildEquipmentConfig(),
      reportError: vi.fn(),
      stateRepository: {
        load: () => err(repositoryError),
        save: () => ok(undefined),
      },
      waitBeforeRetry: vi.fn(async () => undefined),
    });

    expect(result.isErr() && result.error).toBe(repositoryError);
    expect(getBankItems).not.toHaveBeenCalled();
    expect(getItems).not.toHaveBeenCalled();
    expect(getMyCharacters).not.toHaveBeenCalled();
  });

  it('does not start planned work when durable state cannot be saved', async () => {
    const repositoryError = new TestRepositoryError('save failed');
    const save = vi.fn(() => err(repositoryError));
    const equip = vi.fn();
    const { client, ...catalog } = buildClient({
      bank: { ...buildBankPage(), data: [], total: 0 },
      characters: [
        {
          ...buildCharacter(),
          inventory: [{ code: 'copper_dagger', quantity: 1, slot: 0 }],
          weapon_slot: '',
        },
      ],
      items: [buildItem('copper_dagger')],
    });

    const result = await createConfiguredCrewRuntime(
      { ...client, equip } as ArtifactsClient,
      {
        config: buildEquipmentConfig(),
        reportError: vi.fn(),
        stateRepository: { load: () => ok(undefined), save },
        waitBeforeRetry: vi.fn(async () => undefined),
      },
    );
    const runtime = result._unsafeUnwrap();

    expect(runtime.start().isErr()).toBe(true);
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
    expect(catalog.getItems).toHaveBeenCalledOnce();
  });
});
