import { ResultAsync } from "neverthrow";

import type { ArtifactsApiError, ArtifactsClient } from "../../client/index.js";
import type { components } from "../../client/schema.js";
import { type Cooldown, waitForCooldown } from "../../utils/cooldown.js";

type Destination = components["schemas"]["DestinationSchema"];

/**
 * Stateful, cooldown-aware wrapper around `ArtifactsClient` for a single
 * character: every action first waits out the cooldown left by the previous
 * one, then records the cooldown returned by the API for the next call.
 */
export const createCharacterAgent = (
  client: Pick<ArtifactsClient, "moveCharacter">,
  name: string,
) => {
  let cooldown: Cooldown | undefined;

  const withCooldown = <T extends { cooldown: Cooldown }>(
    action: () => ResultAsync<T, ArtifactsApiError>,
  ): ResultAsync<T, ArtifactsApiError> => {
    const wait = cooldown === undefined ? Promise.resolve() : waitForCooldown(cooldown);

    return ResultAsync.fromSafePromise(wait)
      .andThen(action)
      .map((result) => {
        cooldown = result.cooldown;
        return result;
      });
  };

  const move = (destination: Destination) =>
    withCooldown(() => client.moveCharacter(name, destination).map((response) => response.data));

  return { move, name };
};

export type CharacterAgent = ReturnType<typeof createCharacterAgent>;
