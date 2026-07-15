import { okAsync, ResultAsync } from "neverthrow";

import type { ArtifactsApiError, ArtifactsClient } from "../../client/index.js";
import type { components } from "../../client/schema.js";
import { type Cooldown, msUntilExpiration, waitUntil } from "../../utils/cooldown.js";
import { logger } from "../../utils/logger.js";

export type CharacterSnapshot = components["schemas"]["CharacterSchema"];
type Destination = components["schemas"]["DestinationSchema"];
type EquipItem = components["schemas"]["EquipSchema"];
type SimpleItem = components["schemas"]["SimpleItemSchema"];
type UnequipItem = components["schemas"]["UnequipSchema"];

export type CharacterAgentDependencies = Pick<
  ArtifactsClient,
  | "craft"
  | "depositGold"
  | "depositItems"
  | "equip"
  | "fight"
  | "gather"
  | "getCharacter"
  | "giveItems"
  | "moveCharacter"
  | "rest"
  | "unequip"
  | "withdrawGold"
  | "withdrawItems"
>;

const buildCharacterAgent = (
  client: CharacterAgentDependencies,
  name: string,
  initial: CharacterSnapshot,
) => {
  let nextActionAt = initial.cooldown_expiration;
  let character = initial;

  // Every action response carries the character's cooldown and a fresh
  // `character` snapshot. `fight` is the one exception at the API level - it
  // returns a `characters` array instead (fights can involve up to 3
  // characters against a boss), so `fight` below picks out this character's
  // own entry and reshapes it to fit the same `character` field before
  // reaching `withCooldown`. Both are recorded here so the rest of the agent
  // never has to guess whether a cooldown is still running, where the
  // character currently is, or its current HP/inventory after a fight.
  const withCooldown = <T extends { cooldown: Cooldown; character?: CharacterSnapshot }>(
    actionName: string,
    action: () => ResultAsync<T, ArtifactsApiError>,
  ): ResultAsync<T, ArtifactsApiError> => {
    const waitMs = nextActionAt === undefined ? 0 : msUntilExpiration(nextActionAt);

    if (waitMs > 0) {
      logger.info(
        { character: name, waitSeconds: Math.ceil(waitMs / 1000) },
        `${name}: waiting out cooldown before ${actionName}`,
      );
    }

    const wait =
      waitMs > 0 && nextActionAt !== undefined ? waitUntil(nextActionAt) : Promise.resolve();

    return ResultAsync.fromSafePromise(wait)
      .andThen(() => {
        logger.info({ character: name }, `${name}: ${actionName}`);
        return action();
      })
      .map((result) => {
        nextActionAt = result.cooldown.expiration;

        if (result.character !== undefined) {
          character = result.character;
        }

        logger.info(
          { character: name, cooldownSeconds: result.cooldown.total_seconds },
          `${name}: ${actionName} done`,
        );

        return result;
      });
  };

  const getCharacter = (): CharacterSnapshot => character;

  const move = (destination: Destination) =>
    withCooldown("move", () =>
      client.moveCharacter(name, destination).map((response) => response.data),
    );

  /** Moves to `mapId` unless the character is already there. */
  const moveTo = (mapId: number): ResultAsync<void, ArtifactsApiError> =>
    character.map_id === mapId ? okAsync(undefined) : move({ map_id: mapId }).map(() => undefined);

  const rest = () => withCooldown("rest", () => client.rest(name).map((response) => response.data));

  const gather = () =>
    withCooldown("gather", () => client.gather(name).map((response) => response.data));

  const craft = (code: string, quantity?: number) =>
    withCooldown("craft", () =>
      client.craft(name, code, quantity).map((response) => response.data),
    );

  const equip = (items: EquipItem[]) =>
    withCooldown("equip", () => client.equip(name, items).map((response) => response.data));

  const unequip = (items: UnequipItem[]) =>
    withCooldown("unequip", () => client.unequip(name, items).map((response) => response.data));

  const giveItems = (receiverCharacter: string, items: SimpleItem[]) =>
    withCooldown("giveItems", () =>
      client.giveItems(name, receiverCharacter, items).map((response) => response.data),
    );

  const fight = (participants?: readonly string[]) =>
    withCooldown("fight", () =>
      client.fight(name, participants).map((response) => {
        const data = response.data;
        const self = data.characters.find((c) => c.name === name);
        return self === undefined ? data : { ...data, character: self };
      }),
    );

  const depositItems = (items: SimpleItem[]) =>
    withCooldown("depositItems", () =>
      client.depositItems(name, items).map((response) => response.data),
    );

  const withdrawItems = (items: SimpleItem[]) =>
    withCooldown("withdrawItems", () =>
      client.withdrawItems(name, items).map((response) => response.data),
    );

  const depositGold = (quantity: number) =>
    withCooldown("depositGold", () =>
      client.depositGold(name, quantity).map((response) => response.data),
    );

  const withdrawGold = (quantity: number) =>
    withCooldown("withdrawGold", () =>
      client.withdrawGold(name, quantity).map((response) => response.data),
    );

  return {
    craft,
    depositGold,
    depositItems,
    equip,
    fight,
    gather,
    getCharacter,
    giveItems,
    move,
    moveTo,
    name,
    rest,
    unequip,
    withdrawGold,
    withdrawItems,
  };
};

export type CharacterAgent = ReturnType<typeof buildCharacterAgent>;

/** Creates an Agent from a character already present in a Crew Snapshot. */
export const createCharacterAgentFromSnapshot = (
  client: CharacterAgentDependencies,
  initial: CharacterSnapshot,
): CharacterAgent => buildCharacterAgent(client, initial.name, initial);

/**
 * Creates a stateful, cooldown-aware wrapper around `ArtifactsClient` for a
 * single character: every action first waits out the cooldown left by the
 * previous one, then records the cooldown and character state returned by
 * the API for the next call. Both are seeded from the character's current
 * state (`GET /characters/{name}`), so a freshly created agent doesn't have
 * to guess whether it's still on cooldown or where it currently is.
 */
export const createCharacterAgent = (
  client: CharacterAgentDependencies,
  name: string,
): ResultAsync<CharacterAgent, ArtifactsApiError> =>
  client.getCharacter(name).map((character) => buildCharacterAgent(client, name, character.data));
