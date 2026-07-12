import { ResultAsync } from "neverthrow";

import type { ArtifactsApiError, ArtifactsClient } from "../../client/index.js";
import type { components } from "../../client/schema.js";
import { type Cooldown, waitUntil } from "../../utils/cooldown.js";

type Destination = components["schemas"]["DestinationSchema"];
type SimpleItem = components["schemas"]["SimpleItemSchema"];

type CharacterAgentDependencies = Pick<
  ArtifactsClient,
  | "depositGold"
  | "depositItems"
  | "fight"
  | "gather"
  | "getCharacter"
  | "moveCharacter"
  | "rest"
  | "withdrawGold"
  | "withdrawItems"
>;

const buildCharacterAgent = (
  client: CharacterAgentDependencies,
  name: string,
  initialCooldownExpiration: string | undefined,
) => {
  let nextActionAt = initialCooldownExpiration;

  const withCooldown = <T extends { cooldown: Cooldown }>(
    action: () => ResultAsync<T, ArtifactsApiError>,
  ): ResultAsync<T, ArtifactsApiError> => {
    const wait = nextActionAt === undefined ? Promise.resolve() : waitUntil(nextActionAt);

    return ResultAsync.fromSafePromise(wait)
      .andThen(action)
      .map((result) => {
        nextActionAt = result.cooldown.expiration;
        return result;
      });
  };

  const move = (destination: Destination) =>
    withCooldown(() => client.moveCharacter(name, destination).map((response) => response.data));

  const rest = () => withCooldown(() => client.rest(name).map((response) => response.data));

  const gather = () => withCooldown(() => client.gather(name).map((response) => response.data));

  const fight = (participants?: readonly string[]) =>
    withCooldown(() => client.fight(name, participants).map((response) => response.data));

  const depositItems = (items: SimpleItem[]) =>
    withCooldown(() => client.depositItems(name, items).map((response) => response.data));

  const withdrawItems = (items: SimpleItem[]) =>
    withCooldown(() => client.withdrawItems(name, items).map((response) => response.data));

  const depositGold = (quantity: number) =>
    withCooldown(() => client.depositGold(name, quantity).map((response) => response.data));

  const withdrawGold = (quantity: number) =>
    withCooldown(() => client.withdrawGold(name, quantity).map((response) => response.data));

  return {
    depositGold,
    depositItems,
    fight,
    gather,
    move,
    name,
    rest,
    withdrawGold,
    withdrawItems,
  };
};

export type CharacterAgent = ReturnType<typeof buildCharacterAgent>;

/**
 * Creates a stateful, cooldown-aware wrapper around `ArtifactsClient` for a
 * single character: every action first waits out the cooldown left by the
 * previous one, then records the cooldown returned by the API for the next
 * call. The initial cooldown is seeded from the character's current state
 * (`GET /characters/{name}`), so a freshly created agent doesn't have to
 * guess whether the character is still on cooldown from a previous run.
 */
export const createCharacterAgent = (
  client: CharacterAgentDependencies,
  name: string,
): ResultAsync<CharacterAgent, ArtifactsApiError> =>
  client
    .getCharacter(name)
    .map((character) => buildCharacterAgent(client, name, character.data.cooldown_expiration));
