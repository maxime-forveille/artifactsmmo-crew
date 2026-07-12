import createClient, { type Middleware } from "openapi-fetch";
import { err, ok, ResultAsync } from "neverthrow";

import { env } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { API_BASE_URL } from "./constants.js";
import { createRateLimiter } from "./rateLimiter.js";
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

// Per https://docs.artifactsmmo.com/api_guide/rate_limits: the `action`
// bucket (every POST /my/{name}/action/...) is capped at 10/s, 100/min and
// 5000/hour, shared across the whole account/IP (i.e. across all 5
// characters), separately from each character's own cooldown.
const actionRateLimitMiddleware = (): Middleware => {
  const limiter = createRateLimiter([
    { limit: 10, windowMs: 1_000 },
    { limit: 100, windowMs: 60_000 },
    { limit: 5_000, windowMs: 3_600_000 },
  ]);

  return {
    async onRequest({ request }) {
      if (new URL(request.url).pathname.includes("/action/")) {
        await limiter.acquire();
      }

      return request;
    },
  };
};

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
  client.use(actionRateLimitMiddleware());

  const getCharacter = (name: string) =>
    toResult(client.GET("/characters/{name}", { params: { path: { name } } }));

  const getMaps = (query?: paths["/maps"]["get"]["parameters"]["query"]) =>
    toResult(client.GET("/maps", { params: query === undefined ? {} : { query } }));

  const getItem = (code: string) =>
    toResult(client.GET("/items/{code}", { params: { path: { code } } }));

  const moveCharacter = (name: string, destination: components["schemas"]["DestinationSchema"]) =>
    toResult(
      client.POST("/my/{name}/action/move", {
        body: destination,
        params: { path: { name } },
      }),
    );

  const rest = (name: string) =>
    toResult(client.POST("/my/{name}/action/rest", { params: { path: { name } } }));

  const gather = (name: string) =>
    toResult(client.POST("/my/{name}/action/gathering", { params: { path: { name } } }));

  const fight = (name: string, participants?: readonly string[]) =>
    toResult(
      client.POST("/my/{name}/action/fight", {
        body: participants ? { participants: [...participants] } : undefined,
        params: { path: { name } },
      }),
    );

  const craft = (name: string, code: string, quantity = 1) =>
    toResult(
      client.POST("/my/{name}/action/crafting", {
        body: { code, quantity },
        params: { path: { name } },
      }),
    );

  const equip = (name: string, items: components["schemas"]["EquipSchema"][]) =>
    toResult(
      client.POST("/my/{name}/action/equip", {
        body: items,
        params: { path: { name } },
      }),
    );

  const depositItems = (name: string, items: components["schemas"]["SimpleItemSchema"][]) =>
    toResult(
      client.POST("/my/{name}/action/bank/deposit/item", {
        body: items,
        params: { path: { name } },
      }),
    );

  const withdrawItems = (name: string, items: components["schemas"]["SimpleItemSchema"][]) =>
    toResult(
      client.POST("/my/{name}/action/bank/withdraw/item", {
        body: items,
        params: { path: { name } },
      }),
    );

  const depositGold = (name: string, quantity: number) =>
    toResult(
      client.POST("/my/{name}/action/bank/deposit/gold", {
        body: { quantity },
        params: { path: { name } },
      }),
    );

  const withdrawGold = (name: string, quantity: number) =>
    toResult(
      client.POST("/my/{name}/action/bank/withdraw/gold", {
        body: { quantity },
        params: { path: { name } },
      }),
    );

  return {
    client,
    craft,
    depositGold,
    depositItems,
    equip,
    fight,
    gather,
    getCharacter,
    getItem,
    getMaps,
    moveCharacter,
    rest,
    withdrawGold,
    withdrawItems,
  };
};

export type ArtifactsClient = ReturnType<typeof createArtifactsClient>;

export const bot = createArtifactsClient();
