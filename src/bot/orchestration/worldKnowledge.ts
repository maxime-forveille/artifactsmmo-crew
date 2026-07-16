import { ResultAsync } from 'neverthrow';

import type { ArtifactsApiError, ArtifactsClient } from '../../client/index.js';
import type { components } from '../../client/schema.js';

type Item = Readonly<components['schemas']['ItemSchema']>;
type Monster = Readonly<components['schemas']['MonsterSchema']>;
type Resource = Readonly<components['schemas']['ResourceSchema']>;
type StaticPage<T> = Readonly<{
  data: readonly T[];
  page: number;
  pages: number;
  size: number;
  total: number;
}>;
type WorldKnowledgeClient = Pick<
  ArtifactsClient,
  'getItems' | 'getMonsters' | 'getResources'
>;

export type WorldKnowledge = Readonly<{
  items: readonly Item[];
  monsters: readonly Monster[];
  resources: readonly Resource[];
}>;

const PAGE_SIZE = 100;

const readAllPages = <T, E>(
  readPage: (page: number) => ResultAsync<StaticPage<T>, E>,
): ResultAsync<readonly T[], E> =>
  readPage(1).andThen((firstPage) => {
    const remainingPages = Array.from(
      { length: firstPage.pages - 1 },
      (_, index) => readPage(index + 2),
    );

    return ResultAsync.combine(remainingPages).map((pages) =>
      [firstPage, ...pages].flatMap((page) => page.data),
    );
  });

const byCode = <T extends { readonly code: string }>(
  left: T,
  right: T,
): number => left.code.localeCompare(right.code);

/** Reads deterministic process-lifetime game knowledge for pure Goal Policy. */
export const readWorldKnowledge = (
  client: WorldKnowledgeClient,
): ResultAsync<WorldKnowledge, ArtifactsApiError> =>
  ResultAsync.combine([
    readAllPages((page) => client.getItems({ page, size: PAGE_SIZE })),
    readAllPages((page) => client.getMonsters({ page, size: PAGE_SIZE })),
    readAllPages((page) => client.getResources({ page, size: PAGE_SIZE })),
  ]).map(([items, monsters, resources]) => ({
    items: [...items].sort(byCode),
    monsters: [...monsters].sort(byCode),
    resources: [...resources].sort(byCode),
  }));
