import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";

import { readCrewSnapshot } from "../src/bot/orchestration/crewSnapshot.js";
import { ArtifactsApiError, type ArtifactsClient } from "../src/client/index.js";
import type { components } from "../src/client/schema.js";

type BankPage = components["schemas"]["DataPage_SimpleItemSchema_"];
type Character = components["schemas"]["CharacterSchema"];

const buildBankPage = (data: BankPage["data"], page: number, pages: number): BankPage => ({
  data,
  page,
  pages,
  size: 100,
  total: data.length,
});

const buildCharacter = (name: string): Character => ({ ...({} as Character), name });

describe("readCrewSnapshot", () => {
  it("reads every bank page once and returns a deterministic account view", async () => {
    const getBankItems = vi.fn((query?: { page?: number; size?: number }) =>
      okAsync(
        query?.page === 2
          ? buildBankPage([{ code: "ash_wood", quantity: 12 }], 2, 2)
          : buildBankPage([{ code: "copper_ore", quantity: 8 }], 1, 2),
      ),
    );
    const getMyCharacters = vi.fn(() =>
      okAsync({ data: [buildCharacter("Stan"), buildCharacter("Cartman")] }),
    );
    const client = { getBankItems, getMyCharacters } as Pick<
      ArtifactsClient,
      "getBankItems" | "getMyCharacters"
    >;

    const result = await readCrewSnapshot(client, () => new Date("2026-07-15T12:00:00.000Z"));

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      bank: [
        { code: "ash_wood", quantity: 12 },
        { code: "copper_ore", quantity: 8 },
      ],
      capturedAt: "2026-07-15T12:00:00.000Z",
      characters: [buildCharacter("Cartman"), buildCharacter("Stan")],
    });
    expect(getBankItems).toHaveBeenNthCalledWith(1, { page: 1, size: 100 });
    expect(getBankItems).toHaveBeenNthCalledWith(2, { page: 2, size: 100 });
    expect(getMyCharacters).toHaveBeenCalledTimes(1);
  });

  it("does not request another bank page when the first page is complete", async () => {
    const getBankItems = vi.fn(() => okAsync(buildBankPage([], 1, 1)));
    const client = {
      getBankItems,
      getMyCharacters: vi.fn(() => okAsync({ data: [] })),
    } as Pick<ArtifactsClient, "getBankItems" | "getMyCharacters">;

    const result = await readCrewSnapshot(client);

    expect(result.isOk()).toBe(true);
    expect(getBankItems).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed account read instead of returning a partial snapshot", async () => {
    const error = new ArtifactsApiError("boom", 500, {});
    const client = {
      getBankItems: vi.fn(() => okAsync(buildBankPage([], 1, 1))),
      getMyCharacters: vi.fn(() => errAsync(error)),
    } as Pick<ArtifactsClient, "getBankItems" | "getMyCharacters">;

    const result = await readCrewSnapshot(client);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(error);
  });
});
