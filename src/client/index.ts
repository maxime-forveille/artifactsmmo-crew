import createClient, { type Middleware } from "openapi-fetch";
import { err, ok, ResultAsync } from "neverthrow";

import { env } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { API_BASE_URL } from "./constants.js";
import { memoizeAsync, memoizeAsyncWithTtl } from "./memoize.js";
import { createRateLimiter, type RateLimitWindow } from "./rateLimiter.js";
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
 * Applies a rate limiter to requests matched by `shouldLimit`. Each bucket
 * documented at https://docs.artifactsmmo.com/api_guide/rate_limits is
 * shared across the whole account/IP (i.e. across all 5 characters),
 * separately from each character's own action cooldown.
 */
const rateLimitMiddleware = (
  shouldLimit: (request: Request) => boolean,
  windows: readonly RateLimitWindow[],
): Middleware => {
  const limiter = createRateLimiter(windows);

  return {
    async onRequest({ request }) {
      if (shouldLimit(request)) {
        await limiter.acquire();
      }

      return request;
    },
  };
};

const isActionRequest = (request: Request): boolean =>
  new URL(request.url).pathname.includes("/action/");

// The `data` bucket covers every GET endpoint this client uses
// (characters/maps/items/resources/...).
const isDataRequest = (request: Request): boolean => request.method === "GET";

/**
 * Shaves a safety margin off the server-documented limits before we enforce
 * them locally. We record a request as "sent" the moment it leaves this
 * process, not when the server actually counts it, so network latency and
 * clock skew can land us exactly on the server's own boundary even while
 * staying under ours. The limits are also per-IP (not just per-token), so
 * any other traffic sharing this connection (e.g. the game's website open
 * in a browser tab) eats into the same budget. Leaving 40% headroom
 * (empirically verified live against a burst of 17 requests, see
 * `createRateLimiter`'s doc comment) avoids tripping the server-side 429 in
 * both cases.
 */
const SAFETY_MARGIN = 0.6;

// Combat XP rates are only a target-selection heuristic; refreshing them
// every two minutes keeps them useful without spending one GET per character
// on every hunt cycle.
const CHARACTER_LOG_CACHE_TTL_MS = 120_000;

// Several concurrent decision paths can inspect the same bank state. A short
// TTL collapses those reads, while deposit/withdraw calls invalidate it as
// soon as they successfully change the bank.
const BANK_ITEMS_CACHE_TTL_MS = 5_000;

const withSafetyMargin = (windows: readonly RateLimitWindow[]): RateLimitWindow[] =>
  windows.map((window) => ({
    ...window,
    limit: Math.max(1, Math.floor(window.limit * SAFETY_MARGIN)),
  }));

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
  client.use(
    rateLimitMiddleware(
      isActionRequest,
      withSafetyMargin([
        { limit: 10, windowMs: 1_000 },
        { limit: 100, windowMs: 60_000 },
        { limit: 5_000, windowMs: 3_600_000 },
      ]),
    ),
  );
  client.use(
    rateLimitMiddleware(
      isDataRequest,
      withSafetyMargin([
        { limit: 10, windowMs: 1_000 },
        { limit: 200, windowMs: 60_000 },
        { limit: 2_000, windowMs: 3_600_000 },
      ]),
    ),
  );

  const getCharacter = (name: string) =>
    toResult(client.GET("/characters/{name}", { params: { path: { name } } }));

  // These 7 catalog endpoints describe game content (items, monsters,
  // resources, maps) that never changes for as long as this process runs -
  // caching them (see `memoizeAsync`) avoids re-fetching the exact same
  // query every single task cycle, across all 5 characters, which was
  // eating heavily into the account's hourly GET rate limit for no benefit
  // (confirmed live: real 429s against the server's own "2000 per 1 hour"
  // bucket). The genuinely dynamic logs and bank below use short TTL caches
  // instead; character snapshots stay uncached.
  const cacheKey = (...args: unknown[]): string => JSON.stringify(args);

  const getMaps = memoizeAsync(
    (query?: paths["/maps"]["get"]["parameters"]["query"]) =>
      toResult(client.GET("/maps", { params: query === undefined ? {} : { query } })),
    cacheKey,
  );

  const getItem = memoizeAsync(
    (code: string) => toResult(client.GET("/items/{code}", { params: { path: { code } } })),
    cacheKey,
  );

  const getItems = memoizeAsync(
    (query?: paths["/items"]["get"]["parameters"]["query"]) =>
      toResult(client.GET("/items", { params: query === undefined ? {} : { query } })),
    cacheKey,
  );

  const getResource = memoizeAsync(
    (code: string) => toResult(client.GET("/resources/{code}", { params: { path: { code } } })),
    cacheKey,
  );

  const getResources = memoizeAsync(
    (query?: paths["/resources"]["get"]["parameters"]["query"]) =>
      toResult(client.GET("/resources", { params: query === undefined ? {} : { query } })),
    cacheKey,
  );

  const getMonster = memoizeAsync(
    (code: string) => toResult(client.GET("/monsters/{code}", { params: { path: { code } } })),
    cacheKey,
  );

  const getMonsters = memoizeAsync(
    (query?: paths["/monsters"]["get"]["parameters"]["query"]) =>
      toResult(client.GET("/monsters", { params: query === undefined ? {} : { query } })),
    cacheKey,
  );

  const cachedBankItems = memoizeAsyncWithTtl(
    (query?: paths["/my/bank/items"]["get"]["parameters"]["query"]) =>
      toResult(client.GET("/my/bank/items", { params: query === undefined ? {} : { query } })),
    cacheKey,
    BANK_ITEMS_CACHE_TTL_MS,
  );
  const getBankItems = (query?: paths["/my/bank/items"]["get"]["parameters"]["query"]) =>
    cachedBankItems(query);

  const cachedCharacterLogs = memoizeAsyncWithTtl(
    (name: string, query?: paths["/my/logs/{name}"]["get"]["parameters"]["query"]) =>
      toResult(client.GET("/my/logs/{name}", { params: { path: { name }, query: query ?? {} } })),
    cacheKey,
    CHARACTER_LOG_CACHE_TTL_MS,
  );
  const getCharacterLogs = (
    name: string,
    query?: paths["/my/logs/{name}"]["get"]["parameters"]["query"],
  ) => cachedCharacterLogs(name, query);

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

  const unequip = (name: string, items: components["schemas"]["UnequipSchema"][]) =>
    toResult(
      client.POST("/my/{name}/action/unequip", {
        body: items,
        params: { path: { name } },
      }),
    );

  const giveItems = (
    name: string,
    receiverCharacter: string,
    items: components["schemas"]["SimpleItemSchema"][],
  ) =>
    toResult(
      client.POST("/my/{name}/action/give/item", {
        body: { character: receiverCharacter, items },
        params: { path: { name } },
      }),
    );

  const depositItems = (name: string, items: components["schemas"]["SimpleItemSchema"][]) =>
    toResult(
      client.POST("/my/{name}/action/bank/deposit/item", {
        body: items,
        params: { path: { name } },
      }),
    ).map((response) => {
      cachedBankItems.clear();
      return response;
    });

  const withdrawItems = (name: string, items: components["schemas"]["SimpleItemSchema"][]) =>
    toResult(
      client.POST("/my/{name}/action/bank/withdraw/item", {
        body: items,
        params: { path: { name } },
      }),
    ).map((response) => {
      cachedBankItems.clear();
      return response;
    });

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
    getBankItems,
    getCharacter,
    getCharacterLogs,
    getItem,
    getItems,
    getMaps,
    getMonster,
    getMonsters,
    getResource,
    getResources,
    giveItems,
    moveCharacter,
    rest,
    unequip,
    withdrawGold,
    withdrawItems,
  };
};

export type ArtifactsClient = ReturnType<typeof createArtifactsClient>;

export const bot = createArtifactsClient();
