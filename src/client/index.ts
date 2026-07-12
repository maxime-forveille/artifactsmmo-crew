import createClient, { type Middleware } from "openapi-fetch";
import { err, ok, ResultAsync } from "neverthrow";

import { env } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { API_BASE_URL } from "./constants.js";
import type { components, paths } from "./schema.js";

export class ArtifactsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "ArtifactsApiError";
  }
}

type FetchResult<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};

/**
 * Turns an openapi-fetch call into a `ResultAsync`, so callers can never
 * forget to handle a failure path (unlike a thrown exception, the error is
 * part of the type and must be handled via `.match`, `.map`, `.mapErr`, ...).
 */
const toResult = <T>(promise: Promise<FetchResult<T>>): ResultAsync<T, ArtifactsApiError> =>
  ResultAsync.fromPromise(
    promise,
    (thrown) => new ArtifactsApiError("Artifacts API request failed to send", 0, thrown),
  ).andThen(({ data, error, response }) => {
    if (error !== undefined) {
      logger.error(
        { body: error, status: response.status, url: response.url },
        "Artifacts API request failed",
      );
      return err(
        new ArtifactsApiError(
          `Artifacts API request failed: ${response.status} ${response.statusText}`,
          response.status,
          error,
        ),
      );
    }

    return ok(data as T);
  });

const authMiddleware = (token: string): Middleware => ({
  onRequest({ request }) {
    request.headers.set("Authorization", `Bearer ${token}`);
    return request;
  },
});

/**
 * Thin, fully-typed wrapper around the Artifacts MMO REST API.
 *
 * Every method returns a `ResultAsync<T, ArtifactsApiError>` rather than
 * throwing, so the error case is part of the return type and must be
 * handled explicitly (e.g. via `.match(onOk, onErr)`).
 * @see https://docs.artifactsmmo.com/
 */
export const createArtifactsClient = (token: string = env.ARTIFACTS_TOKEN) => {
  const client = createClient<paths>({ baseUrl: API_BASE_URL });
  client.use(authMiddleware(token));

  const getCharacter = (name: string) =>
    toResult(client.GET("/characters/{name}", { params: { path: { name } } }));

  const moveCharacter = (name: string, destination: components["schemas"]["DestinationSchema"]) =>
    toResult(
      client.POST("/my/{name}/action/move", {
        body: destination,
        params: { path: { name } },
      }),
    );

  return { client, getCharacter, moveCharacter };
};

export type ArtifactsClient = ReturnType<typeof createArtifactsClient>;

export const bot = createArtifactsClient();
