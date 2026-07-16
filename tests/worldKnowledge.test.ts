import { errAsync, okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { readWorldKnowledge } from '../src/bot/orchestration/worldKnowledge.js';
import {
  ArtifactsApiError,
  type ArtifactsClient,
} from '../src/client/index.js';
import type { components } from '../src/client/schema.js';

type Item = components['schemas']['ItemSchema'];
type Monster = components['schemas']['MonsterSchema'];
type Resource = components['schemas']['ResourceSchema'];

const buildItem = (code: string): Item => ({ ...({} as Item), code });
const buildMonster = (code: string): Monster => ({ ...({} as Monster), code });
const buildResource = (code: string): Resource => ({
  ...({} as Resource),
  code,
});

const buildPage = <T>(data: T[], page = 1, pages = 1) => ({
  data,
  page,
  pages,
  size: 100,
  total: data.length,
});

type WorldKnowledgeClient = Pick<
  ArtifactsClient,
  'getItems' | 'getMonsters' | 'getResources'
>;

describe('readWorldKnowledge', () => {
  it('reads every catalog page and sorts each collection by code', async () => {
    const getItems = vi.fn(({ page = 1 }: { page?: number }) =>
      okAsync(
        page === 1
          ? buildPage([buildItem('wooden_staff')], 1, 2)
          : buildPage([buildItem('copper_dagger')], 2, 2),
      ),
    );
    const getMonsters = vi.fn(() =>
      okAsync(
        buildPage([buildMonster('yellow_slime'), buildMonster('chicken')]),
      ),
    );
    const getResources = vi.fn(({ page = 1 }: { page?: number }) =>
      okAsync(
        page === 1
          ? buildPage([buildResource('copper_rocks')], 1, 2)
          : buildPage([buildResource('ash_tree')], 2, 2),
      ),
    );

    const result = await readWorldKnowledge({
      getItems,
      getMonsters,
      getResources,
    } as unknown as WorldKnowledgeClient);

    expect(result._unsafeUnwrap()).toEqual({
      items: [buildItem('copper_dagger'), buildItem('wooden_staff')],
      monsters: [buildMonster('chicken'), buildMonster('yellow_slime')],
      resources: [buildResource('ash_tree'), buildResource('copper_rocks')],
    });
    expect(getItems).toHaveBeenNthCalledWith(1, { page: 1, size: 100 });
    expect(getItems).toHaveBeenNthCalledWith(2, { page: 2, size: 100 });
    expect(getMonsters).toHaveBeenCalledOnce();
    expect(getMonsters).toHaveBeenCalledWith({ page: 1, size: 100 });
    expect(getResources).toHaveBeenNthCalledWith(1, { page: 1, size: 100 });
    expect(getResources).toHaveBeenNthCalledWith(2, { page: 2, size: 100 });
  });

  it('returns empty deterministic collections for empty catalogs', async () => {
    const emptyPage = buildPage([]);
    const client = {
      getItems: vi.fn(() => okAsync(emptyPage)),
      getMonsters: vi.fn(() => okAsync(emptyPage)),
      getResources: vi.fn(() => okAsync(emptyPage)),
    } as unknown as WorldKnowledgeClient;

    const result = await readWorldKnowledge(client);

    expect(result._unsafeUnwrap()).toEqual({
      items: [],
      monsters: [],
      resources: [],
    });
  });

  it('propagates a catalog failure instead of returning partial knowledge', async () => {
    const apiError = new ArtifactsApiError('unavailable', 503, {});
    const client = {
      getItems: vi.fn(() => okAsync(buildPage([]))),
      getMonsters: vi.fn(() => errAsync(apiError)),
      getResources: vi.fn(() => okAsync(buildPage([]))),
    } as unknown as WorldKnowledgeClient;

    const result = await readWorldKnowledge(client);

    expect(result.isErr() && result.error).toBe(apiError);
  });
});
