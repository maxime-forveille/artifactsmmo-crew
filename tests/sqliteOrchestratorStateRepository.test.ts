import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import type { ActiveGoal } from '../src/bot/orchestration/orchestratorState.js';
import type { DurableOrchestratorState } from '../src/bot/orchestration/orchestratorStateRepository.js';
import { openSqliteDatabase } from '../src/persistence/database.js';
import {
  applyMigrations,
  orchestratorStateMigrations,
} from '../src/persistence/migrations.js';
import {
  createSqliteOrchestratorStateRepository,
  SqliteOrchestratorStateRepositoryError,
} from '../src/persistence/sqliteOrchestratorStateRepository.js';

const openDatabases: DatabaseSync[] = [];
const temporaryDirectories: string[] = [];

const openMigratedDatabase = (path = ':memory:'): DatabaseSync => {
  const database = openSqliteDatabase(path)._unsafeUnwrap();
  applyMigrations(database, orchestratorStateMigrations)._unsafeUnwrap();
  openDatabases.push(database);
  return database;
};

const closeDatabase = (database: DatabaseSync): void => {
  const index = openDatabases.indexOf(database);
  if (index >= 0) {
    openDatabases.splice(index, 1);
  }

  database.close();
};

const configuredGoal: ActiveGoal = {
  characterName: 'Stan',
  id: 'equipItem:Stan:copper_armor',
  itemCode: 'copper_armor',
  origin: 'configured',
  type: 'equipItem',
};

const prerequisiteGoal: ActiveGoal = {
  id: 'replenishBankItem:copper_bar:10',
  itemCode: 'copper_bar',
  minimumBankQuantity: 10,
  origin: 'prerequisite',
  parentGoalId: configuredGoal.id,
  reason: 'Acquire materials for the parent Goal',
  resourceCode: 'copper_rocks',
  rule: 'equipmentUpgrade',
  type: 'replenishBankItem',
};

const monsterPrerequisiteGoal: ActiveGoal = {
  id: 'replenishBankItem:slime_gel:10',
  itemCode: 'slime_gel',
  minimumBankQuantity: 10,
  monsterCode: 'yellow_slime',
  origin: 'prerequisite',
  parentGoalId: configuredGoal.id,
  reason: 'Acquire monster drops for the parent Goal',
  rule: 'professionProgression',
  type: 'replenishBankItem',
};

const professionGoal: ActiveGoal = {
  characterName: 'Stan',
  id: 'reachProfessionLevel:Stan:gearcrafting:5',
  origin: 'prerequisite',
  parentGoalId: configuredGoal.id,
  reason: 'Reach gearcrafting level 5 for the parent Goal',
  rule: 'professionProgression',
  skill: 'gearcrafting',
  targetLevel: 5,
  type: 'reachProfessionLevel',
};

const productionGoal: ActiveGoal = {
  id: 'produceItem:copper_bar:10',
  itemCode: 'copper_bar',
  minimumBankQuantity: 10,
  origin: 'prerequisite',
  parentGoalId: professionGoal.id,
  reason: 'Craft an intermediate for the parent Goal',
  rule: 'professionProgression',
  type: 'produceItem',
};

const autonomousGoal: ActiveGoal = {
  characterName: 'Kyle',
  id: 'reachCombatLevel:Kyle:8',
  origin: 'autonomous',
  reason: 'Progress Kyle to the next combat level',
  rule: 'combatProgression',
  targetLevel: 8,
  type: 'reachCombatLevel',
};

const overrideGoal: ActiveGoal = {
  characterName: 'Butters',
  id: 'equipItem:Butters:copper_helmet',
  itemCode: 'copper_helmet',
  origin: 'override',
  type: 'equipItem',
};

const buildState = (): DurableOrchestratorState => ({
  goals: [
    productionGoal,
    professionGoal,
    prerequisiteGoal,
    monsterPrerequisiteGoal,
    configuredGoal,
    autonomousGoal,
    overrideGoal,
  ],
});

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    database.close();
  }

  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('createSqliteOrchestratorStateRepository', () => {
  it('loads undefined before any durable state has been saved', () => {
    const repository = createSqliteOrchestratorStateRepository(
      openMigratedDatabase(),
    );

    expect(repository.load()._unsafeUnwrap()).toBeUndefined();
  });

  it('saves and loads ordered Goals with every origin metadata shape', () => {
    const repository = createSqliteOrchestratorStateRepository(
      openMigratedDatabase(),
    );
    const state = buildState();

    expect(repository.save(state).isOk()).toBe(true);

    expect(repository.load()._unsafeUnwrap()).toEqual(state);
  });

  it.each([
    'alchemy',
    'cooking',
    'gearcrafting',
    'jewelrycrafting',
    'mining',
    'weaponcrafting',
    'woodcutting',
  ] as const)('persists the %s profession Goal skill', (skill) => {
    const repository = createSqliteOrchestratorStateRepository(
      openMigratedDatabase(),
    );
    const goal: ActiveGoal = {
      ...professionGoal,
      id: `reachProfessionLevel:Stan:${skill}:5`,
      skill,
    };
    const state = { goals: [goal, configuredGoal] };

    repository.save(state)._unsafeUnwrap();

    expect(repository.load()._unsafeUnwrap()).toEqual(state);
  });

  it('restores durable Goals after reopening a database file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'artifactsmmo-crew-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'orchestrator.sqlite');
    const firstDatabase = openMigratedDatabase(databasePath);
    createSqliteOrchestratorStateRepository(firstDatabase)
      .save(buildState())
      ._unsafeUnwrap();
    closeDatabase(firstDatabase);

    const reopenedDatabase = openMigratedDatabase(databasePath);
    const repository =
      createSqliteOrchestratorStateRepository(reopenedDatabase);

    expect(repository.load()._unsafeUnwrap()).toEqual(buildState());
  });

  it('distinguishes an explicitly saved empty state from missing state', () => {
    const repository = createSqliteOrchestratorStateRepository(
      openMigratedDatabase(),
    );

    repository.save({ goals: [] })._unsafeUnwrap();

    expect(repository.load()._unsafeUnwrap()).toEqual({ goals: [] });
  });

  it('replaces the complete previously persisted Goal list', () => {
    const repository = createSqliteOrchestratorStateRepository(
      openMigratedDatabase(),
    );
    repository.save(buildState())._unsafeUnwrap();

    repository.save({ goals: [overrideGoal] })._unsafeUnwrap();

    expect(repository.load()._unsafeUnwrap()).toEqual({
      goals: [overrideGoal],
    });
  });

  it('rolls back the complete replacement when relational integrity fails', () => {
    const repository = createSqliteOrchestratorStateRepository(
      openMigratedDatabase(),
    );
    repository.save({ goals: [configuredGoal] })._unsafeUnwrap();

    const result = repository.save({ goals: [prerequisiteGoal] });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(SqliteOrchestratorStateRepositoryError);
    expect(error.name).toBe('SqliteOrchestratorStateRepositoryError');
    expect(error.message).toBe('Failed to save SQLite orchestrator state');
    expect(error.operation).toBe('save');
    expect(error.cause).toBeInstanceOf(Error);
    expect(repository.load()._unsafeUnwrap()).toEqual({
      goals: [configuredGoal],
    });
  });

  it('returns a typed load error when persisted Goal JSON is invalid', () => {
    const database = openMigratedDatabase();
    const repository = createSqliteOrchestratorStateRepository(database);
    repository.save({ goals: [configuredGoal] })._unsafeUnwrap();
    database
      .prepare('UPDATE orchestrator_goals SET goal_json = ? WHERE id = ?')
      .run('{"id":"incomplete"}', configuredGoal.id);

    const result = repository.load();

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(SqliteOrchestratorStateRepositoryError);
    expect(error.name).toBe('SqliteOrchestratorStateRepositoryError');
    expect(error.message).toBe('Failed to load SQLite orchestrator state');
    expect(error.operation).toBe('load');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('rejects a persisted id that disagrees with its Goal JSON', () => {
    const database = openMigratedDatabase();
    const repository = createSqliteOrchestratorStateRepository(database);
    repository.save({ goals: [configuredGoal] })._unsafeUnwrap();
    database
      .prepare('UPDATE orchestrator_goals SET goal_json = ? WHERE id = ?')
      .run(
        JSON.stringify({ ...configuredGoal, id: 'different-goal-id' }),
        configuredGoal.id,
      );

    const result = repository.load();

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().cause).toEqual(
      new Error(
        `Persisted metadata does not match Goal "${configuredGoal.id}"`,
      ),
    );
  });

  it.each([
    [
      'type',
      'replenishBankItem',
      configuredGoal.id,
      { goals: [configuredGoal] },
    ],
    ['origin', 'override', configuredGoal.id, { goals: [configuredGoal] }],
    ['parent_goal_id', autonomousGoal.id, prerequisiteGoal.id, buildState()],
    ['reason', 'Different reason', prerequisiteGoal.id, buildState()],
    ['rule', 'combatProgression', prerequisiteGoal.id, buildState()],
  ] as const)(
    'rejects a persisted %s that disagrees with its Goal JSON',
    (column, value, goalId, state) => {
      const database = openMigratedDatabase();
      const repository = createSqliteOrchestratorStateRepository(database);
      repository.save(state)._unsafeUnwrap();
      database
        .prepare(`UPDATE orchestrator_goals SET ${column} = ? WHERE id = ?`)
        .run(value, goalId);

      const result = repository.load();

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().cause).toEqual(
        new Error(`Persisted metadata does not match Goal "${goalId}"`),
      );
    },
  );
});
