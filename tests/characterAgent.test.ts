import { errAsync, okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerInfoMock } = vi.hoisted(() => ({ loggerInfoMock: vi.fn() }));

vi.mock('../src/utils/logger.js', () => ({ logger: { info: loggerInfoMock } }));

import {
  createCharacterAgent,
  createCharacterAgentFromSnapshot,
} from '../src/bot/runtime/characterAgent.js';
import { ArtifactsApiError } from '../src/client/index.js';
import type { ArtifactsClient } from '../src/client/index.js';
import type { components } from '../src/client/schema.js';

type MovementData = components['schemas']['CharacterMovementDataSchema'];
type MovementResponse =
  components['schemas']['CharacterMovementResponseSchema'];
type CharacterSnapshot = components['schemas']['CharacterSchema'];
type CharacterResponse = components['schemas']['CharacterResponseSchema'];
type Cooldown = components['schemas']['CooldownSchema'];

type Dependencies = Pick<
  ArtifactsClient,
  | 'craft'
  | 'depositGold'
  | 'depositItems'
  | 'equip'
  | 'fight'
  | 'gather'
  | 'getCharacter'
  | 'giveItems'
  | 'moveCharacter'
  | 'rest'
  | 'unequip'
  | 'withdrawGold'
  | 'withdrawItems'
>;

const buildCooldown = (expiration: string): Cooldown => ({
  expiration,
  reason: 'movement',
  remaining_seconds: 0,
  started_at: '2024-01-01T00:00:00.000Z',
  total_seconds: 0,
});

// Most `CharacterSchema` fields are irrelevant to the agent's cooldown/
// position logic, so they're stubbed out rather than filled with a full
// fixture; only `map_id` and `cooldown_expiration` are ever asserted on.
const buildCharacter = (
  overrides: Partial<CharacterSnapshot> = {},
): CharacterSnapshot => ({
  ...({} as CharacterSnapshot),
  map_id: 1,
  ...overrides,
});

const buildCharacterResponse = (
  overrides: Partial<CharacterSnapshot> = {},
): CharacterResponse => ({ data: buildCharacter(overrides) });

const buildMovementResponse = (
  expiration: string,
  mapId: number,
): MovementResponse => ({
  data: {
    character: buildCharacter({ map_id: mapId }),
    cooldown: buildCooldown(expiration),
    destination: {} as MovementData['destination'],
    path: [],
  },
});

type BankGoldResponse =
  components['schemas']['BankGoldTransactionResponseSchema'];
type BankItemResponse =
  components['schemas']['BankItemTransactionResponseSchema'];
type CharacterRestResponse =
  components['schemas']['CharacterRestResponseSchema'];
type EquipmentResponse = components['schemas']['EquipmentResponseSchema'];
type SkillResponse = components['schemas']['SkillResponseSchema'];

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

const buildRestResponse = (expiration: string): CharacterRestResponse => ({
  data: {
    character: buildCharacter({ hp: 100 }),
    cooldown: buildCooldown(expiration),
    hp_restored: 50,
  },
});

const buildBankItemResponse = (expiration: string): BankItemResponse => ({
  data: {
    bank: [],
    character: buildCharacter(),
    cooldown: buildCooldown(expiration),
    items: [],
  },
});

const buildBankGoldResponse = (expiration: string): BankGoldResponse => ({
  data: {
    bank: { quantity: 100 },
    character: buildCharacter(),
    cooldown: buildCooldown(expiration),
  },
});

type FightResponse = components['schemas']['CharacterFightResponseSchema'];

const buildFightResponse = (
  expiration: string,
  characters: CharacterSnapshot[],
): FightResponse => ({
  data: {
    characters,
    cooldown: buildCooldown(expiration),
    fight: {
      logs: [],
      opponent: 'chicken',
      result: 'win',
      turns: 3,
      characters: [],
    },
  },
});

const notImplemented = () =>
  errAsync(new ArtifactsApiError('not implemented in test', 501, undefined));

const expectActionLogged = (character: string, actionName: string): void => {
  expect(loggerInfoMock).toHaveBeenCalledWith(
    { character },
    `${character}: ${actionName}`,
  );
};

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

describe('createCharacterAgent', () => {
  beforeEach(() => {
    loggerInfoMock.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('can start from an existing Crew Snapshot without another character read', () => {
    const getCharacter = vi.fn(defaultDependencies.getCharacter);
    const dependencies = { ...defaultDependencies, getCharacter };

    const agent = createCharacterAgentFromSnapshot(
      dependencies,
      buildCharacter({ name: 'Cartman' }),
    );

    expect(agent.name).toBe('Cartman');
    expect(agent.getCharacter().name).toBe('Cartman');
    expect(getCharacter).not.toHaveBeenCalled();
  });

  it('propagates a failure from the initial getCharacter call', async () => {
    const apiError = new ArtifactsApiError(
      'character not found',
      498,
      undefined,
    );
    const dependencies: Dependencies = {
      ...defaultDependencies,
      getCharacter: () => errAsync(apiError),
    };

    const result = await createCharacterAgent(dependencies, 'Cartman');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(apiError);
  });

  it('performs the first move immediately when the character has no prior cooldown', async () => {
    const moveCharacter = vi.fn(() =>
      okAsync(buildMovementResponse('2024-01-01T00:00:05.000Z', 2)),
    );
    const dependencies: Dependencies = {
      ...defaultDependencies,
      moveCharacter,
    };

    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();
    const result = await agent.move({ x: 1, y: 1 });

    expect(moveCharacter).toHaveBeenCalledTimes(1);
    expect(moveCharacter).toHaveBeenCalledWith('Cartman', { x: 1, y: 1 });
    expect(result.isOk()).toBe(true);
    expect(
      loggerInfoMock.mock.calls.some(([, message]) =>
        String(message).includes('waiting out cooldown'),
      ),
    ).toBe(false);
  });

  it("waits out a cooldown seeded from the character's state before the first action", async () => {
    const moveCharacter = vi.fn(() =>
      okAsync(buildMovementResponse('2024-01-01T00:00:10.000Z', 2)),
    );
    const dependencies: Dependencies = {
      ...defaultDependencies,
      getCharacter: () =>
        okAsync(
          buildCharacterResponse({
            cooldown_expiration: '2024-01-01T00:00:05.000Z',
          }),
        ),
      moveCharacter,
    };

    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();
    const movePromise = agent.move({ x: 1, y: 1 });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(moveCharacter).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await movePromise;

    expect(moveCharacter).toHaveBeenCalledTimes(1);
    expect(loggerInfoMock).toHaveBeenCalledWith(
      { character: 'Cartman', waitSeconds: 5 },
      'Cartman: waiting out cooldown before move',
    );
    expectActionLogged('Cartman', 'move');
    expect(loggerInfoMock).toHaveBeenCalledWith(
      { character: 'Cartman', cooldownSeconds: 0 },
      'Cartman: move done',
    );
  });

  it('waits out the previous cooldown before issuing the next move', async () => {
    const moveCharacter = vi
      .fn()
      .mockReturnValueOnce(
        okAsync(buildMovementResponse('2024-01-01T00:00:05.000Z', 2)),
      )
      .mockReturnValueOnce(
        okAsync(buildMovementResponse('2024-01-01T00:00:10.000Z', 3)),
      );
    const dependencies: Dependencies = {
      ...defaultDependencies,
      moveCharacter,
    };

    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();

    await agent.move({ x: 1, y: 1 });
    expect(moveCharacter).toHaveBeenCalledTimes(1);

    const secondMove = agent.move({ x: 2, y: 2 });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(moveCharacter).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await secondMove;

    expect(moveCharacter).toHaveBeenCalledTimes(2);
  });

  it('propagates a failed move as an Err without swallowing it', async () => {
    const apiError = new ArtifactsApiError('boom', 499, undefined);
    const dependencies: Dependencies = {
      ...defaultDependencies,
      moveCharacter: () => errAsync(apiError),
    };

    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();
    const result = await agent.move({ x: 1, y: 1 });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(apiError);
  });

  it('getCharacter reflects the latest known snapshot, updated after each action', async () => {
    const moveCharacter = vi.fn(() =>
      okAsync(buildMovementResponse('2024-01-01T00:00:05.000Z', 42)),
    );
    const dependencies: Dependencies = {
      ...defaultDependencies,
      getCharacter: () => okAsync(buildCharacterResponse({ map_id: 1 })),
      moveCharacter,
    };

    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();
    expect(agent.getCharacter().map_id).toBe(1);

    await agent.move({ x: 1, y: 1 });

    expect(agent.getCharacter().map_id).toBe(42);
  });

  it('moveTo skips the move call when the character is already at the target map', async () => {
    const moveCharacter = vi.fn(() =>
      okAsync(buildMovementResponse('2024-01-01T00:00:05.000Z', 5)),
    );
    const dependencies: Dependencies = {
      ...defaultDependencies,
      getCharacter: () => okAsync(buildCharacterResponse({ map_id: 5 })),
      moveCharacter,
    };

    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();
    const result = await agent.moveTo(5);

    expect(moveCharacter).not.toHaveBeenCalled();
    expect(result.isOk()).toBe(true);
  });

  it('moveTo moves the character when not at the target map', async () => {
    const moveCharacter = vi.fn(() =>
      okAsync(buildMovementResponse('2024-01-01T00:00:05.000Z', 5)),
    );
    const dependencies: Dependencies = {
      ...defaultDependencies,
      getCharacter: () => okAsync(buildCharacterResponse({ map_id: 1 })),
      moveCharacter,
    };

    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();
    const result = await agent.moveTo(5);

    expect(moveCharacter).toHaveBeenCalledWith('Cartman', { map_id: 5 });
    expect(result.isOk()).toBe(true);
    expect(agent.getCharacter().map_id).toBe(5);
  });

  it('rest forwards the character and refreshes its snapshot', async () => {
    const rest = vi.fn(() =>
      okAsync(buildRestResponse('2024-01-01T00:00:05.000Z')),
    );
    const dependencies: Dependencies = { ...defaultDependencies, rest };
    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();

    const result = await agent.rest();

    expect(rest).toHaveBeenCalledWith('Cartman');
    expect(result.isOk()).toBe(true);
    expect(agent.getCharacter().hp).toBe(100);
    expectActionLogged('Cartman', 'rest');
  });

  it('gather forwards the character and refreshes its snapshot', async () => {
    const gather = vi.fn(() =>
      okAsync(buildCraftResponse('2024-01-01T00:00:05.000Z')),
    );
    const dependencies: Dependencies = { ...defaultDependencies, gather };
    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();

    const result = await agent.gather();

    expect(gather).toHaveBeenCalledWith('Cartman');
    expect(result.isOk()).toBe(true);
    expect(agent.getCharacter()).toBe(result._unsafeUnwrap().character);
    expectActionLogged('Cartman', 'gather');
  });

  it('depositItems forwards items and refreshes its snapshot', async () => {
    const depositItems = vi.fn(() =>
      okAsync(buildBankItemResponse('2024-01-01T00:00:05.000Z')),
    );
    const dependencies: Dependencies = { ...defaultDependencies, depositItems };
    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();
    const items = [{ code: 'copper_ore', quantity: 3 }];

    const result = await agent.depositItems(items);

    expect(depositItems).toHaveBeenCalledWith('Cartman', items);
    expect(result.isOk()).toBe(true);
    expect(agent.getCharacter()).toBe(result._unsafeUnwrap().character);
    expectActionLogged('Cartman', 'depositItems');
  });

  it('withdrawItems forwards items and refreshes its snapshot', async () => {
    const withdrawItems = vi.fn(() =>
      okAsync(buildBankItemResponse('2024-01-01T00:00:05.000Z')),
    );
    const dependencies: Dependencies = {
      ...defaultDependencies,
      withdrawItems,
    };
    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();
    const items = [{ code: 'copper_ore', quantity: 3 }];

    const result = await agent.withdrawItems(items);

    expect(withdrawItems).toHaveBeenCalledWith('Cartman', items);
    expect(result.isOk()).toBe(true);
    expect(agent.getCharacter()).toBe(result._unsafeUnwrap().character);
    expectActionLogged('Cartman', 'withdrawItems');
  });

  it('depositGold forwards the quantity and refreshes its snapshot', async () => {
    const depositGold = vi.fn(() =>
      okAsync(buildBankGoldResponse('2024-01-01T00:00:05.000Z')),
    );
    const dependencies: Dependencies = { ...defaultDependencies, depositGold };
    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();

    const result = await agent.depositGold(25);

    expect(depositGold).toHaveBeenCalledWith('Cartman', 25);
    expect(result.isOk()).toBe(true);
    expect(agent.getCharacter()).toBe(result._unsafeUnwrap().character);
    expectActionLogged('Cartman', 'depositGold');
  });

  it('withdrawGold forwards the quantity and refreshes its snapshot', async () => {
    const withdrawGold = vi.fn(() =>
      okAsync(buildBankGoldResponse('2024-01-01T00:00:05.000Z')),
    );
    const dependencies: Dependencies = { ...defaultDependencies, withdrawGold };
    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();

    const result = await agent.withdrawGold(25);

    expect(withdrawGold).toHaveBeenCalledWith('Cartman', 25);
    expect(result.isOk()).toBe(true);
    expect(agent.getCharacter()).toBe(result._unsafeUnwrap().character);
    expectActionLogged('Cartman', 'withdrawGold');
  });

  it('craft forwards its explicit quantity to the client', async () => {
    const craft = vi.fn(() =>
      okAsync(buildCraftResponse('2024-01-01T00:00:05.000Z')),
    );
    const dependencies: Dependencies = { ...defaultDependencies, craft };

    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();
    const result = await agent.craft('copper_bar', 6);

    expect(craft).toHaveBeenCalledWith('Cartman', 'copper_bar', 6);
    expect(result.isOk()).toBe(true);
    expectActionLogged('Cartman', 'craft');
  });

  it('fight forwards participants and updates the cached snapshot from the matching entry', async () => {
    const fight = vi.fn(() =>
      okAsync(
        buildFightResponse('2024-01-01T00:00:05.000Z', [
          buildCharacter({ hp: 42, map_id: 1, name: 'Kyle' }),
          buildCharacter({ hp: 130, map_id: 1, name: 'Cartman' }),
        ]),
      ),
    );
    const dependencies: Dependencies = { ...defaultDependencies, fight };

    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();
    const result = await agent.fight(['Kyle']);

    expect(fight).toHaveBeenCalledWith('Cartman', ['Kyle']);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().fight.result).toBe('win');
    expect(agent.getCharacter().hp).toBe(130);
    expectActionLogged('Cartman', 'fight');
  });

  it('equip forwards the item list to the client', async () => {
    const equip = vi.fn(() =>
      okAsync(buildEquipResponse('2024-01-01T00:00:05.000Z')),
    );
    const dependencies: Dependencies = { ...defaultDependencies, equip };

    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();
    const result = await agent.equip([
      { code: 'copper_pickaxe', quantity: 1, slot: 'weapon' },
    ]);

    expect(equip).toHaveBeenCalledWith('Cartman', [
      { code: 'copper_pickaxe', quantity: 1, slot: 'weapon' },
    ]);
    expect(result.isOk()).toBe(true);
    expectActionLogged('Cartman', 'equip');
  });

  it('unequip forwards the slot list to the client', async () => {
    const unequip = vi.fn(() =>
      okAsync(buildEquipResponse('2024-01-01T00:00:05.000Z')),
    );
    const dependencies: Dependencies = { ...defaultDependencies, unequip };

    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();
    const result = await agent.unequip([{ quantity: 1, slot: 'weapon' }]);

    expect(unequip).toHaveBeenCalledWith('Cartman', [
      { quantity: 1, slot: 'weapon' },
    ]);
    expect(result.isOk()).toBe(true);
    expectActionLogged('Cartman', 'unequip');
  });

  it('giveItems forwards the receiver and item list to the client', async () => {
    const giveItems = vi.fn(() =>
      okAsync({
        data: {
          character: buildCharacter(),
          cooldown: buildCooldown('2024-01-01T00:00:05.000Z'),
          items: [{ code: 'copper_dagger', quantity: 1 }],
          receiver_character: buildCharacter({ name: 'Stan' }),
        },
      }),
    );
    const dependencies: Dependencies = { ...defaultDependencies, giveItems };

    const agent = (
      await createCharacterAgent(dependencies, 'Cartman')
    )._unsafeUnwrap();
    const result = await agent.giveItems('Stan', [
      { code: 'copper_dagger', quantity: 1 },
    ]);

    expect(giveItems).toHaveBeenCalledWith('Cartman', 'Stan', [
      { code: 'copper_dagger', quantity: 1 },
    ]);
    expect(result.isOk()).toBe(true);
    expectActionLogged('Cartman', 'giveItems');
  });

  it('keeps the previous snapshot when a fight response omits this character', async () => {
    const initial = buildCharacter({ hp: 75, name: 'Cartman' });
    const fight = vi.fn(() =>
      okAsync(
        buildFightResponse('2024-01-01T00:00:05.000Z', [
          buildCharacter({ hp: 42, name: 'Kyle' }),
        ]),
      ),
    );
    const dependencies: Dependencies = { ...defaultDependencies, fight };
    const agent = createCharacterAgentFromSnapshot(dependencies, initial);

    const result = await agent.fight(['Kyle']);

    expect(result.isOk()).toBe(true);
    expect(agent.getCharacter()).toBe(initial);
  });
});
