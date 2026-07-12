import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ArtifactsApiError, createArtifactsClient } from "../src/client/index.js";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("ArtifactsApiError", () => {
  it("carries the HTTP status and response body", () => {
    const error = new ArtifactsApiError("boom", 404, { message: "not found" });

    expect(error.message).toBe("boom");
    expect(error.status).toBe(404);
    expect(error.body).toEqual({ message: "not found" });
    expect(error.name).toBe("ArtifactsApiError");
  });
});

describe("createArtifactsClient", () => {
  it("sends the bearer token and returns the parsed character on success", async () => {
    let receivedAuth: string | null = null;

    server.use(
      http.get("https://api.artifactsmmo.com/characters/:name", ({ request, params }) => {
        receivedAuth = request.headers.get("Authorization");
        return HttpResponse.json({ data: { name: params["name"] } });
      }),
    );

    const client = createArtifactsClient("test-token");
    const result = await client.getCharacter("Cartman");

    expect(receivedAuth).toBe("Bearer test-token");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().data.name).toBe("Cartman");
  });

  it("maps a non-2xx response to an ArtifactsApiError", async () => {
    server.use(
      http.get("https://api.artifactsmmo.com/characters/:name", () =>
        HttpResponse.json(
          { error: { code: 498, message: "Character not found." } },
          { status: 498 },
        ),
      ),
    );

    const client = createArtifactsClient("test-token");
    const result = await client.getCharacter("Ghost");

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(ArtifactsApiError);
    expect(error.status).toBe(498);
    expect(error.body).toEqual({ error: { code: 498, message: "Character not found." } });
  });

  it("sends the destination as the request body when moving a character", async () => {
    let receivedBody: unknown;

    server.use(
      http.post("https://api.artifactsmmo.com/my/:name/action/move", async ({ request }) => {
        receivedBody = await request.json();

        return HttpResponse.json({
          data: {
            character: {},
            cooldown: {
              expiration: "2024-01-01T00:00:05.000Z",
              reason: "movement",
              remaining_seconds: 5,
              started_at: "2024-01-01T00:00:00.000Z",
              total_seconds: 5,
            },
            destination: {},
            path: [],
          },
        });
      }),
    );

    const client = createArtifactsClient("test-token");
    const result = await client.moveCharacter("Cartman", { x: 1, y: 2 });

    expect(receivedBody).toEqual({ x: 1, y: 2 });
    expect(result.isOk()).toBe(true);
  });

  it("forwards content_code/content_type as query params and returns the map page", async () => {
    let receivedQuery: Record<string, string> = {};

    server.use(
      http.get("https://api.artifactsmmo.com/maps", ({ request }) => {
        receivedQuery = Object.fromEntries(new URL(request.url).searchParams);

        return HttpResponse.json({
          data: [{ map_id: 42, name: "Copper Rocks", x: 2, y: 1 }],
          page: 1,
          pages: 1,
          size: 50,
          total: 1,
        });
      }),
    );

    const client = createArtifactsClient("test-token");
    const result = await client.getMaps({ content_code: "copper_rocks", content_type: "resource" });

    expect(receivedQuery).toEqual({ content_code: "copper_rocks", content_type: "resource" });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().data).toEqual([{ map_id: 42, name: "Copper Rocks", x: 2, y: 1 }]);
  });
});
