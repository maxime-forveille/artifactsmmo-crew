import { err, ok, type ResultAsync } from 'neverthrow';

import type { ArtifactsApiError, ArtifactsClient } from '../client/index.js';
import type { components } from '../client/schema.js';

type MapContentType = components['schemas']['MapContentType'];
type Map = components['schemas']['MapSchema'];
type Resource = components['schemas']['ResourceSchema'];
type Monster = components['schemas']['MonsterSchema'];

/** The map content code shared by every bank location in the game. */
export const BANK_CONTENT_CODE = 'bank';

export class LocationNotFoundError extends Error {
  constructor(
    public readonly contentType: MapContentType,
    public readonly contentCode: string,
  ) {
    super(`No map found for ${contentType} "${contentCode}"`);
    this.name = 'LocationNotFoundError';
  }
}

export class ResourceNotFoundError extends Error {
  constructor(public readonly itemCode: string) {
    super(`No gatherable resource drops "${itemCode}"`);
    this.name = 'ResourceNotFoundError';
  }
}

export class MonsterNotFoundError extends Error {
  constructor(public readonly itemCode: string) {
    super(`No monster drops "${itemCode}"`);
    this.name = 'MonsterNotFoundError';
  }
}

/**
 * Resolves a resource/monster/workshop code to a map position. The
 * `gather`/`fight`/`crafting` actions take no body: they act on whatever is on
 * the character's current tile, so moving to the right tile first is how a task
 * like "farm copper_rocks" actually gets executed.
 *
 * Picks the first match returned by the API. Doesn't (yet) account for the
 * character's current position, so it won't necessarily be the closest one.
 */
export const resolveLocation = (
  client: Pick<ArtifactsClient, 'getMaps'>,
  contentType: MapContentType,
  contentCode: string,
): ResultAsync<Map, ArtifactsApiError | LocationNotFoundError> =>
  client
    .getMaps({ content_code: contentCode, content_type: contentType })
    .andThen((page) => {
      const [map] = page.data;

      return map
        ? ok(map)
        : err(new LocationNotFoundError(contentType, contentCode));
    });

/**
 * Finds which gatherable resource node drops `itemCode` (e.g. "copper_ore" is
 * dropped by the "copper_rocks" resource). Item codes and resource-node codes
 * are distinct, so this is the step needed before `resolveLocation` can find a
 * map for a raw material.
 *
 * Picks the first match returned by the API.
 */
export const findResourceForDrop = (
  client: Pick<ArtifactsClient, 'getResources'>,
  itemCode: string,
): ResultAsync<Resource, ArtifactsApiError | ResourceNotFoundError> =>
  client.getResources({ drop: itemCode }).andThen((page) => {
    const [resource] = page.data;

    return resource ? ok(resource) : err(new ResourceNotFoundError(itemCode));
  });

/**
 * Finds which monster drops `itemCode` (e.g. "feather" is dropped by the
 * "chicken" monster). This is the combat equivalent of `findResourceForDrop`,
 * used when a craft material isn't a gatherable resource but a monster drop
 * instead.
 *
 * Picks the first match returned by the API.
 */
export const findMonsterForDrop = (
  client: Pick<ArtifactsClient, 'getMonsters'>,
  itemCode: string,
): ResultAsync<Monster, ArtifactsApiError | MonsterNotFoundError> =>
  client.getMonsters({ drop: itemCode }).andThen((page) => {
    const [monster] = page.data;

    return monster ? ok(monster) : err(new MonsterNotFoundError(itemCode));
  });
