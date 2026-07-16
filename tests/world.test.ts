import { errAsync, okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  findMonsterForDrop,
  findResourceForDrop,
  LocationNotFoundError,
  MonsterNotFoundError,
  resolveLocation,
  ResourceNotFoundError,
} from '../src/bot/world.js';
import { ArtifactsApiError } from '../src/client/index.js';
import type { ArtifactsClient } from '../src/client/index.js';
import type { components } from '../src/client/schema.js';

type MapPage = components['schemas']['StaticDataPage_MapSchema_'];
type Map = components['schemas']['MapSchema'];
type Resource = components['schemas']['ResourceSchema'];
type ResourcePage = components['schemas']['StaticDataPage_ResourceSchema_'];
type Monster = components['schemas']['MonsterSchema'];
type MonsterPage = components['schemas']['StaticDataPage_MonsterSchema_'];

const buildMap = (overrides: Partial<Map> = {}): Map => ({
  ...({} as Map),
  ...overrides,
});

const buildPage = (data: Map[]): MapPage => ({
  data,
  page: 1,
  pages: 1,
  size: 50,
  total: data.length,
});

const buildResource = (overrides: Partial<Resource> = {}): Resource => ({
  ...({} as Resource),
  ...overrides,
});

const buildResourcePage = (data: Resource[]): ResourcePage => ({
  data,
  page: 1,
  pages: 1,
  size: 50,
  total: data.length,
});

const buildMonster = (overrides: Partial<Monster> = {}): Monster => ({
  ...({} as Monster),
  ...overrides,
});

const buildMonsterPage = (data: Monster[]): MonsterPage => ({
  data,
  page: 1,
  pages: 1,
  size: 50,
  total: data.length,
});

describe('resolveLocation', () => {
  it('returns the first map matching the content type/code', async () => {
    const first = buildMap({ map_id: 277, x: 2, y: 0 });
    const second = buildMap({ map_id: 512, x: 5, y: 5 });
    const getMaps = vi.fn(() => okAsync(buildPage([first, second])));

    const result = await resolveLocation(
      { getMaps } as Pick<ArtifactsClient, 'getMaps'>,
      'resource',
      'copper_rocks',
    );

    expect(getMaps).toHaveBeenCalledWith({
      content_code: 'copper_rocks',
      content_type: 'resource',
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(first);
  });

  it('returns a LocationNotFoundError when no map matches', async () => {
    const getMaps = vi.fn(() => okAsync(buildPage([])));

    const result = await resolveLocation(
      { getMaps } as Pick<ArtifactsClient, 'getMaps'>,
      'monster',
      'unknown_monster',
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(LocationNotFoundError);
    expect((error as LocationNotFoundError).contentType).toBe('monster');
    expect((error as LocationNotFoundError).contentCode).toBe(
      'unknown_monster',
    );
  });

  it('propagates a getMaps failure without swallowing it', async () => {
    const apiError = new ArtifactsApiError('boom', 500, undefined);
    const getMaps = vi.fn(() => errAsync(apiError));

    const result = await resolveLocation(
      { getMaps } as Pick<ArtifactsClient, 'getMaps'>,
      'workshop',
      'weaponcrafting',
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(apiError);
  });
});

describe('findResourceForDrop', () => {
  it('returns the first resource that drops the item', async () => {
    const resource = buildResource({ code: 'copper_rocks' });
    const getResources = vi.fn(() => okAsync(buildResourcePage([resource])));

    const result = await findResourceForDrop(
      { getResources } as Pick<ArtifactsClient, 'getResources'>,
      'copper_ore',
    );

    expect(getResources).toHaveBeenCalledWith({ drop: 'copper_ore' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(resource);
  });

  it('returns a ResourceNotFoundError when no resource drops the item', async () => {
    const getResources = vi.fn(() => okAsync(buildResourcePage([])));

    const result = await findResourceForDrop(
      { getResources } as Pick<ArtifactsClient, 'getResources'>,
      'feather',
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(ResourceNotFoundError);
    expect((error as ResourceNotFoundError).itemCode).toBe('feather');
  });

  it('propagates a getResources failure without swallowing it', async () => {
    const apiError = new ArtifactsApiError('boom', 500, undefined);
    const getResources = vi.fn(() => errAsync(apiError));

    const result = await findResourceForDrop(
      { getResources } as Pick<ArtifactsClient, 'getResources'>,
      'copper_ore',
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(apiError);
  });
});

describe('findMonsterForDrop', () => {
  it('returns the first monster that drops the item', async () => {
    const monster = buildMonster({ code: 'chicken' });
    const getMonsters = vi.fn(() => okAsync(buildMonsterPage([monster])));

    const result = await findMonsterForDrop(
      { getMonsters } as Pick<ArtifactsClient, 'getMonsters'>,
      'feather',
    );

    expect(getMonsters).toHaveBeenCalledWith({ drop: 'feather' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(monster);
  });

  it('returns a MonsterNotFoundError when no monster drops the item', async () => {
    const getMonsters = vi.fn(() => okAsync(buildMonsterPage([])));

    const result = await findMonsterForDrop(
      { getMonsters } as Pick<ArtifactsClient, 'getMonsters'>,
      'wooden_stick',
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(MonsterNotFoundError);
    expect((error as MonsterNotFoundError).itemCode).toBe('wooden_stick');
  });

  it('propagates a getMonsters failure without swallowing it', async () => {
    const apiError = new ArtifactsApiError('boom', 500, undefined);
    const getMonsters = vi.fn(() => errAsync(apiError));

    const result = await findMonsterForDrop(
      { getMonsters } as Pick<ArtifactsClient, 'getMonsters'>,
      'feather',
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(apiError);
  });
});
