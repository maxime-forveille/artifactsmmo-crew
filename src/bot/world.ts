import { err, ok, type ResultAsync } from "neverthrow";

import type { ArtifactsApiError, ArtifactsClient } from "../client/index.js";
import type { components } from "../client/schema.js";

type MapContentType = components["schemas"]["MapContentType"];
type Map = components["schemas"]["MapSchema"];

export class LocationNotFoundError extends Error {
  constructor(
    public readonly contentType: MapContentType,
    public readonly contentCode: string,
  ) {
    super(`No map found for ${contentType} "${contentCode}"`);
    this.name = "LocationNotFoundError";
  }
}

/**
 * Resolves a resource/monster/workshop code to a map position. The
 * `gather`/`fight`/`crafting` actions take no body: they act on whatever is
 * on the character's current tile, so moving to the right tile first is how
 * a task like "farm copper_rocks" actually gets executed.
 *
 * Picks the first match returned by the API. Doesn't (yet) account for the
 * character's current position, so it won't necessarily be the closest one.
 */
export const resolveLocation = (
  client: Pick<ArtifactsClient, "getMaps">,
  contentType: MapContentType,
  contentCode: string,
): ResultAsync<Map, ArtifactsApiError | LocationNotFoundError> =>
  client.getMaps({ content_code: contentCode, content_type: contentType }).andThen((page) => {
    const [map] = page.data;

    return map ? ok(map) : err(new LocationNotFoundError(contentType, contentCode));
  });
