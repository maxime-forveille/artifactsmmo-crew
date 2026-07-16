import { readFileSync } from 'node:fs';
import * as v from 'valibot';

import { taskSchema, type TaskAssignment } from '../bot/tasks/task.js';

// A JSON object keyed by character name, rather than an array of
// {character, task} pairs, so a duplicate character name is a JSON
// impossibility (last write wins, silently) rather than a validation rule
// this schema would otherwise need to enforce itself.
const assignmentsSchema = v.record(v.string(), taskSchema);

/**
 * Parses and validates `raw` (the contents of a tasks.json file) into a list of
 * character -> Task assignments. Throws with a readable summary of every issue
 * found on invalid input - same pattern as `utils/config.ts`'s `loadEnv`, since
 * both are boot-time configuration that should fail fast and loudly rather than
 * start the bot in a half-configured state.
 */
export const parseTaskAssignments = (
  raw: string,
): readonly TaskAssignment[] => {
  const parsed: unknown = JSON.parse(raw);
  const result = v.safeParse(assignmentsSchema, parsed);

  if (!result.success) {
    const issues = result.issues
      .map(
        (issue) => `  - ${v.getDotPath(issue) ?? '(root)'}: ${issue.message}`,
      )
      .join('\n');
    throw new Error(`Invalid task assignments:\n${issues}`);
  }

  return Object.entries(result.output).map(([character, task]) => ({
    character,
    task,
  }));
};

/**
 * Reads and parses the task assignments file at `path` (a JSON object mapping
 * character name to `Task`, see `tasks.example.json`). Not committed (see
 * `.gitignore`) since it's runtime config for this particular account's
 * characters, not project source - same treatment as `.env`.
 */
export const loadTaskAssignments = (
  path = 'tasks.json',
): readonly TaskAssignment[] =>
  parseTaskAssignments(readFileSync(path, 'utf-8'));
