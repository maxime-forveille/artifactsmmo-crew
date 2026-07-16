import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  openSqliteDatabase,
  SqliteDatabaseError,
} from '../src/persistence/database.js';
import {
  applyMigrations,
  orchestratorStateMigrations,
  SqliteMigrationError,
  type Migration,
} from '../src/persistence/migrations.js';

const openDatabases: DatabaseSync[] = [];

const openMemoryDatabase = (): DatabaseSync => {
  const database = openSqliteDatabase(':memory:')._unsafeUnwrap();
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

const migrationVersions = (database: DatabaseSync): readonly number[] =>
  database
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => row['version'] as number);

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    database.close();
  }
});

describe('openSqliteDatabase', () => {
  it('opens a database with foreign-key enforcement enabled', () => {
    const database = openMemoryDatabase();

    expect(
      database.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'],
    ).toBe(1);
  });

  it('returns a typed error when the database cannot be opened', () => {
    const missingDirectory = join(tmpdir(), randomUUID(), 'state.sqlite');
    const result = openSqliteDatabase(missingDirectory);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(SqliteDatabaseError);
    expect(error.name).toBe('SqliteDatabaseError');
    expect(error.message).toContain(missingDirectory);
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe('applyMigrations', () => {
  it('creates the versioned orchestrator Goal schema', () => {
    const database = openMemoryDatabase();

    expect(applyMigrations(database, orchestratorStateMigrations).isOk()).toBe(
      true,
    );
    expect(migrationVersions(database)).toEqual([1]);
    expect(
      database
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE name = 'orchestrator_goals' AND type = 'table'
          `,
        )
        .get()?.['name'],
    ).toBe('orchestrator_goals');
  });

  it('allows a prerequisite to be inserted before its parent in one transaction', () => {
    const database = openMemoryDatabase();
    applyMigrations(database, orchestratorStateMigrations)._unsafeUnwrap();
    const insertGoal = database.prepare(`
      INSERT INTO orchestrator_goals (
        position,
        id,
        type,
        origin,
        parent_goal_id,
        rule,
        reason,
        goal_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    database.exec('BEGIN;');
    insertGoal.run(
      0,
      'replenishBankItem:copper_bar:10',
      'replenishBankItem',
      'prerequisite',
      'equipItem:Stan:copper_armor',
      'equipmentUpgrade',
      'Acquire materials for the parent Goal',
      '{"id":"replenishBankItem:copper_bar:10"}',
    );
    insertGoal.run(
      1,
      'equipItem:Stan:copper_armor',
      'equipItem',
      'configured',
      null,
      null,
      null,
      '{"id":"equipItem:Stan:copper_armor"}',
    );

    expect(() => database.exec('COMMIT;')).not.toThrow();
  });

  it('is idempotent when every migration is already applied', () => {
    const database = openMemoryDatabase();

    applyMigrations(database, orchestratorStateMigrations)._unsafeUnwrap();
    applyMigrations(database, orchestratorStateMigrations)._unsafeUnwrap();

    expect(migrationVersions(database)).toEqual([1]);
  });

  it('applies only new migrations when the plan grows', () => {
    const database = openMemoryDatabase();
    const migrations: readonly Migration[] = [
      { statements: ['CREATE TABLE first_table (id INTEGER);'], version: 1 },
      { statements: ['CREATE TABLE second_table (id INTEGER);'], version: 2 },
      { statements: ['CREATE TABLE third_table (id INTEGER);'], version: 3 },
    ];

    applyMigrations(database, migrations.slice(0, 1))._unsafeUnwrap();
    applyMigrations(database, migrations)._unsafeUnwrap();

    expect(migrationVersions(database)).toEqual([1, 2, 3]);
  });

  it('rolls back the complete failing migration', () => {
    const database = openMemoryDatabase();
    const result = applyMigrations(database, [
      {
        statements: [
          'CREATE TABLE rolled_back_table (id INTEGER);',
          'THIS IS NOT VALID SQL;',
        ],
        version: 1,
      },
    ]);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(SqliteMigrationError);
    expect(error.name).toBe('SqliteMigrationError');
    expect(error.message).toBe('Failed to apply SQLite migration 1');
    expect(error.migrationVersion).toBe(1);
    expect(error.cause).toBeInstanceOf(Error);
    expect(migrationVersions(database)).toEqual([]);
    expect(
      database
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE name = 'rolled_back_table'
          `,
        )
        .get(),
    ).toBeUndefined();
  });

  it('rejects migration plans whose versions are not strictly increasing', () => {
    const database = openMemoryDatabase();
    const result = applyMigrations(database, [
      { statements: [], version: 2 },
      { statements: [], version: 1 },
    ]);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().migrationVersion).toBe(1);
    expect(result._unsafeUnwrapErr().message).toContain(
      'strictly increasing positive integer versions',
    );
  });

  it('rejects duplicate migration versions', () => {
    const database = openMemoryDatabase();
    const result = applyMigrations(database, [
      { statements: [], version: 1 },
      { statements: [], version: 1 },
    ]);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.message).toBe(
      'SQLite migrations must have strictly increasing positive integer versions',
    );
    expect(error.migrationVersion).toBe(1);
    expect(error.cause).toBeUndefined();
  });

  it('returns a typed error when migration state cannot be inspected', () => {
    const database = openMemoryDatabase();
    closeDatabase(database);

    const result = applyMigrations(database, orchestratorStateMigrations);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(SqliteMigrationError);
    expect(error.name).toBe('SqliteMigrationError');
    expect(error.message).toBe('Failed to inspect SQLite migrations');
    expect(error.migrationVersion).toBeUndefined();
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('rejects applied versions that are not a prefix of the migration plan', () => {
    const database = openMemoryDatabase();
    const existingPlan: readonly Migration[] = [
      { statements: ['CREATE TABLE existing_table (id INTEGER);'], version: 2 },
    ];
    const currentPlan: readonly Migration[] = [
      { statements: ['CREATE TABLE missing_table (id INTEGER);'], version: 1 },
      ...existingPlan,
    ];

    applyMigrations(database, existingPlan)._unsafeUnwrap();
    const result = applyMigrations(database, currentPlan);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain(
      'do not match the current migration plan',
    );
  });
});
