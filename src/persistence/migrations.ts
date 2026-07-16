import { err, ok, type Result } from 'neverthrow';
import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';

export type Migration = Readonly<{
  statements: readonly string[];
  version: number;
}>;

export class SqliteMigrationError extends Error {
  readonly migrationVersion: number | undefined;

  constructor(
    message: string,
    migrationVersion: number | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.migrationVersion = migrationVersion;
    this.name = 'SqliteMigrationError';
  }
}

const migrationTableStatement = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    applied_at TEXT NOT NULL
  ) STRICT;
`;

export const orchestratorStateMigrations: readonly Migration[] = [
  {
    statements: [
      `
        CREATE TABLE orchestrator_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          saved_at TEXT NOT NULL
        ) STRICT;
      `,
      `
        CREATE TABLE orchestrator_goals (
          position INTEGER PRIMARY KEY CHECK (position >= 0),
          id TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL,
          origin TEXT NOT NULL,
          parent_goal_id TEXT,
          rule TEXT,
          reason TEXT,
          goal_json TEXT NOT NULL CHECK (json_valid(goal_json)),
          FOREIGN KEY (parent_goal_id)
            REFERENCES orchestrator_goals(id)
            DEFERRABLE INITIALLY DEFERRED,
          CHECK (
            (
              origin IN ('configured', 'override')
              AND parent_goal_id IS NULL
              AND rule IS NULL
              AND reason IS NULL
            )
            OR (
              origin = 'autonomous'
              AND parent_goal_id IS NULL
              AND rule IS NOT NULL
              AND reason IS NOT NULL
            )
            OR (
              origin = 'prerequisite'
              AND parent_goal_id IS NOT NULL
              AND rule IS NOT NULL
              AND reason IS NOT NULL
            )
          )
        ) STRICT;
      `,
    ],
    version: 1,
  },
];

const validateMigrationPlan = (
  migrations: readonly Migration[],
): Result<void, SqliteMigrationError> => {
  let previousVersion = 0;

  for (const migration of migrations) {
    if (
      !Number.isInteger(migration.version) ||
      migration.version <= previousVersion
    ) {
      return err(
        new SqliteMigrationError(
          'SQLite migrations must have strictly increasing positive integer versions',
          migration.version,
        ),
      );
    }

    previousVersion = migration.version;
  }

  return ok(undefined);
};

const appliedMigrationRowsSchema = v.array(
  v.object({ version: v.pipe(v.number(), v.integer(), v.minValue(1)) }),
);

const readAppliedVersions = (database: DatabaseSync): readonly number[] =>
  v
    .parse(
      appliedMigrationRowsSchema,
      database
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all(),
    )
    .map(({ version }) => version);

const validateAppliedVersions = (
  appliedVersions: readonly number[],
  migrations: readonly Migration[],
): Result<void, SqliteMigrationError> => {
  const plannedVersions = migrations.map(({ version }) => version);
  const isAppliedPrefix = appliedVersions.every(
    (version, index) => plannedVersions[index] === version,
  );

  if (isAppliedPrefix) {
    return ok(undefined);
  }

  return err(
    new SqliteMigrationError(
      'Applied SQLite migrations do not match the current migration plan',
      undefined,
    ),
  );
};

const rollback = (database: DatabaseSync): void => {
  try {
    database.exec('ROLLBACK;');
  } catch {
    // Preserve the migration error that triggered the rollback.
  }
};

const applyMigration = (
  database: DatabaseSync,
  migration: Migration,
): Result<void, SqliteMigrationError> => {
  try {
    database.exec('BEGIN IMMEDIATE;');

    for (const statement of migration.statements) {
      database.exec(statement);
    }

    database
      .prepare(
        `
          INSERT INTO schema_migrations (version, applied_at)
          VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        `,
      )
      .run(migration.version);
    database.exec('COMMIT;');
    return ok(undefined);
  } catch (cause: unknown) {
    rollback(database);
    return err(
      new SqliteMigrationError(
        `Failed to apply SQLite migration ${migration.version}`,
        migration.version,
        { cause },
      ),
    );
  }
};

export const applyMigrations = (
  database: DatabaseSync,
  migrations: readonly Migration[],
): Result<void, SqliteMigrationError> => {
  const planValidation = validateMigrationPlan(migrations);
  if (planValidation.isErr()) {
    return planValidation;
  }

  let appliedVersions: readonly number[];

  try {
    database.exec(migrationTableStatement);
    appliedVersions = readAppliedVersions(database);
  } catch (cause: unknown) {
    return err(
      new SqliteMigrationError(
        'Failed to inspect SQLite migrations',
        undefined,
        { cause },
      ),
    );
  }

  const appliedValidation = validateAppliedVersions(
    appliedVersions,
    migrations,
  );
  if (appliedValidation.isErr()) {
    return appliedValidation;
  }

  for (const migration of migrations.slice(appliedVersions.length)) {
    const result = applyMigration(database, migration);
    if (result.isErr()) {
      return result;
    }
  }

  return ok(undefined);
};
