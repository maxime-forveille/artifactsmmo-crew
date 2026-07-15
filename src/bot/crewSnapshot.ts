import { okAsync, ResultAsync } from "neverthrow";

import type { ArtifactsApiError, ArtifactsClient } from "../client/index.js";
import type { components } from "../client/schema.js";

type BankItem = Readonly<components["schemas"]["SimpleItemSchema"]>;
type Character = Readonly<components["schemas"]["CharacterSchema"]>;
type CrewSnapshotClient = Pick<ArtifactsClient, "getBankItems" | "getMyCharacters">;
type Now = () => Date;

export type CrewSnapshot = Readonly<{
  bank: readonly BankItem[];
  capturedAt: string;
  characters: readonly Character[];
}>;

const byCode = (left: BankItem, right: BankItem): number => left.code.localeCompare(right.code);
const byName = (left: Character, right: Character): number => left.name.localeCompare(right.name);

const readBankItems = (
  client: Pick<CrewSnapshotClient, "getBankItems">,
): ResultAsync<readonly BankItem[], ArtifactsApiError> =>
  client.getBankItems({ page: 1, size: 100 }).andThen((firstPage) => {
    if (firstPage.pages <= 1) {
      return okAsync([...firstPage.data].sort(byCode));
    }

    const remainingPages = Array.from({ length: firstPage.pages - 1 }, (_, index) =>
      client.getBankItems({ page: index + 2, size: 100 }),
    );

    return ResultAsync.combine(remainingPages).map((pages) =>
      [firstPage, ...pages].flatMap((page) => page.data).sort(byCode),
    );
  });

/**
 * Reads the account state needed by future cross-character decisions.
 * Characters and bank pages are fetched as one operation and exposed as a
 * deterministic read-only value. The API has no atomic account-snapshot
 * endpoint, so `capturedAt` records when both reads completed successfully.
 */
export const readCrewSnapshot = (
  client: CrewSnapshotClient,
  now: Now = () => new Date(),
): ResultAsync<CrewSnapshot, ArtifactsApiError> =>
  ResultAsync.combine([client.getMyCharacters(), readBankItems(client)]).map(
    ([charactersResponse, bank]) => ({
      bank,
      capturedAt: now().toISOString(),
      characters: [...charactersResponse.data].sort(byName),
    }),
  );
