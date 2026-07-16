import { err, ok, type Result } from 'neverthrow';
import { DatabaseSync } from 'node:sqlite';

export class SqliteDatabaseError extends Error {
  constructor(path: string, options: ErrorOptions) {
    super(`Failed to open SQLite database at "${path}"`, options);
    this.name = 'SqliteDatabaseError';
  }
}

export const openSqliteDatabase = (
  path: string,
): Result<DatabaseSync, SqliteDatabaseError> => {
  try {
    return ok(new DatabaseSync(path, { enableForeignKeyConstraints: true }));
  } catch (cause: unknown) {
    return err(new SqliteDatabaseError(path, { cause }));
  }
};
