import type { ResultAsync } from 'neverthrow';

import type { ArtifactsClient } from '../../client/index.js';
import type {
  CraftItemActivity,
  EquipItemActivity,
  FarmResourceActivity,
  HuntMonsterActivity,
  WithdrawItemActivity,
} from '../activities/activity.js';
import {
  runWithdrawItemActivity,
  type WithdrawItemError,
} from '../activities/banking.js';
import {
  runCraftItemActivity,
  type CraftItemExecutionError,
} from '../activities/crafting.js';
import {
  runEquipItemActivity,
  type EquipItemExecutionError,
} from '../activities/equipping.js';
import type { FarmingError } from '../activities/farming.js';
import { runFarmingCycle } from '../activities/farming.js';
import type { HuntingError } from '../activities/hunting.js';
import { runHuntingCycle } from '../activities/hunting.js';

import type { CharacterAgent } from './characterAgent.js';

export type ExecutableActivity =
  | CraftItemActivity
  | EquipItemActivity
  | FarmResourceActivity
  | HuntMonsterActivity
  | WithdrawItemActivity;
export type ActivityExecutionError =
  | CraftItemExecutionError
  | EquipItemExecutionError
  | FarmingError
  | HuntingError
  | WithdrawItemError;

type ActivityClient = Pick<
  ArtifactsClient,
  'getBankItems' | 'getItem' | 'getMaps'
>;
type ActivityAgent = Pick<
  CharacterAgent,
  | 'craft'
  | 'depositItems'
  | 'equip'
  | 'fight'
  | 'gather'
  | 'getCharacter'
  | 'moveTo'
  | 'rest'
  | 'unequip'
  | 'withdrawItems'
>;

/**
 * Executes one already-selected bounded Activity with an existing character
 * agent. Scheduling, Reservations, retries, and policy remain outside this
 * dispatcher.
 */
export const runActivity = (
  client: ActivityClient,
  agent: ActivityAgent,
  activity: ExecutableActivity,
): ResultAsync<void, ActivityExecutionError> => {
  switch (activity.type) {
    case 'craftItem': {
      return runCraftItemActivity(client, agent, activity);
    }
    case 'equipItem': {
      return runEquipItemActivity(client, agent, activity);
    }
    case 'farmResource': {
      return runFarmingCycle(client, agent, activity.resourceCode);
    }
    case 'huntMonster': {
      return runHuntingCycle(client, agent, activity.monsterCode);
    }
    case 'withdrawItem': {
      return runWithdrawItemActivity(client, agent, activity);
    }
  }
};
