import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";

import { ArtifactsApiError } from "../src/client/index.js";
import type { ArtifactsClient } from "../src/client/index.js";
import type { components } from "../src/client/schema.js";
import { LocationNotFoundError, resolveLocation } from "../src/bot/world.js";

type MapPage = components["schemas"]["StaticDataPage_MapSchema_"];
type Map = components["schemas"]["MapSchema"];

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

describe("resolveLocation", () => {
  it("returns the first map matching the content type/code", async () => {
    const first = buildMap({ map_id: 277, x: 2, y: 0 });
    const second = buildMap({ map_id: 512, x: 5, y: 5 });
    const getMaps = vi.fn(() => okAsync(buildPage([first, second])));

    const result = await resolveLocation(
      { getMaps } as Pick<ArtifactsClient, "getMaps">,
      "resource",
      "copper_rocks",
    );

    expect(getMaps).toHaveBeenCalledWith({
      content_code: "copper_rocks",
      content_type: "resource",
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(first);
  });

  it("returns a LocationNotFoundError when no map matches", async () => {
    const getMaps = vi.fn(() => okAsync(buildPage([])));

    const result = await resolveLocation(
      { getMaps } as Pick<ArtifactsClient, "getMaps">,
      "monster",
      "unknown_monster",
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(LocationNotFoundError);
    expect((error as LocationNotFoundError).contentType).toBe("monster");
    expect((error as LocationNotFoundError).contentCode).toBe("unknown_monster");
  });

  it("propagates a getMaps failure without swallowing it", async () => {
    const apiError = new ArtifactsApiError("boom", 500, undefined);
    const getMaps = vi.fn(() => errAsync(apiError));

    const result = await resolveLocation(
      { getMaps } as Pick<ArtifactsClient, "getMaps">,
      "workshop",
      "weaponcrafting",
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(apiError);
  });
});
