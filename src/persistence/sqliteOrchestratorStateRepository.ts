import { err, ok } from 'neverthrow';
import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';

import { GOAL_RULE_NAMES } from '../bot/orchestration/goalRule.js';
import type { ActiveGoal } from '../bot/orchestration/orchestratorState.js';
import type {
  DurableOrchestratorState,
  OrchestratorStateRepository,
} from '../bot/orchestration/orchestratorStateRepository.js';

const repositoryOperations = ['load', 'save'] as const;
type RepositoryOperation = (typeof repositoryOperations)[number];

export class SqliteOrchestratorStateRepositoryError extends Error {
  constructor(
    public readonly operation: RepositoryOperation,
    options: ErrorOptions,
  ) {
    super(`Failed to ${operation} SQLite orchestrator state`, options);
    this.name = 'SqliteOrchestratorStateRepositoryError';
  }
}

const craftSkillSchema = v.picklist([
  'alchemy',
  'cooking',
  'gearcrafting',
  'jewelrycrafting',
  'mining',
  'weaponcrafting',
  'woodcutting',
]);
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const positiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

const goalSchema = v.variant('type', [
  v.object({
    characterName: nonEmptyStringSchema,
    id: nonEmptyStringSchema,
    itemCode: nonEmptyStringSchema,
    type: v.literal('equipItem'),
  }),
  v.object({
    id: nonEmptyStringSchema,
    itemCode: nonEmptyStringSchema,
    minimumBankQuantity: positiveIntegerSchema,
    type: v.literal('produceItem'),
  }),
  v.object({
    characterName: nonEmptyStringSchema,
    id: nonEmptyStringSchema,
    targetLevel: positiveIntegerSchema,
    type: v.literal('reachCombatLevel'),
  }),
  v.object({
    characterName: nonEmptyStringSchema,
    id: nonEmptyStringSchema,
    skill: craftSkillSchema,
    targetLevel: positiveIntegerSchema,
    type: v.literal('reachProfessionLevel'),
  }),
  v.object({
    id: nonEmptyStringSchema,
    itemCode: nonEmptyStringSchema,
    minimumBankQuantity: positiveIntegerSchema,
    monsterCode: v.optional(nonEmptyStringSchema),
    resourceCode: v.optional(nonEmptyStringSchema),
    type: v.literal('replenishBankItem'),
  }),
]);

const originSchema = v.variant('origin', [
  v.object({ origin: v.picklist(['configured', 'override']) }),
  v.object({
    origin: v.literal('autonomous'),
    reason: nonEmptyStringSchema,
    rule: v.picklist(GOAL_RULE_NAMES),
  }),
  v.object({
    origin: v.literal('prerequisite'),
    parentGoalId: nonEmptyStringSchema,
    reason: nonEmptyStringSchema,
    rule: v.picklist(GOAL_RULE_NAMES),
  }),
]);

const activeGoalSchema = v.intersect([goalSchema, originSchema]);

const persistedGoalRowsSchema = v.array(
  v.object({
    goalJson: v.string(),
    id: nonEmptyStringSchema,
    origin: v.picklist([
      'autonomous',
      'configured',
      'override',
      'prerequisite',
    ]),
    parentGoalId: v.nullable(v.string()),
    reason: v.nullable(v.string()),
    rule: v.nullable(v.picklist(GOAL_RULE_NAMES)),
    type: v.picklist([
      'equipItem',
      'produceItem',
      'reachCombatLevel',
      'reachProfessionLevel',
      'replenishBankItem',
    ]),
  }),
);

type PersistedGoalMetadata = Readonly<{
  origin: ActiveGoal['origin'];
  parentGoalId: string | null;
  reason: string | null;
  rule: (typeof GOAL_RULE_NAMES)[number] | null;
}>;

const metadataForGoal = (goal: ActiveGoal): PersistedGoalMetadata => {
  if (goal.origin === 'autonomous') {
    return {
      origin: goal.origin,
      parentGoalId: null,
      reason: goal.reason,
      rule: goal.rule,
    };
  }

  if (goal.origin === 'prerequisite') {
    return {
      origin: goal.origin,
      parentGoalId: goal.parentGoalId,
      reason: goal.reason,
      rule: goal.rule,
    };
  }

  return { origin: goal.origin, parentGoalId: null, reason: null, rule: null };
};

const parseActiveGoal = (goalJson: string): ActiveGoal =>
  v.parse(activeGoalSchema, JSON.parse(goalJson) as unknown);

const assertMatchingMetadata = (
  goal: ActiveGoal,
  row: v.InferOutput<typeof persistedGoalRowsSchema>[number],
): void => {
  const metadata = metadataForGoal(goal);

  if (
    goal.id !== row.id ||
    goal.type !== row.type ||
    metadata.origin !== row.origin ||
    metadata.parentGoalId !== row.parentGoalId ||
    metadata.reason !== row.reason ||
    metadata.rule !== row.rule
  ) {
    throw new Error(`Persisted metadata does not match Goal "${row.id}"`);
  }
};

const rollback = (database: DatabaseSync): void => {
  try {
    database.exec('ROLLBACK;');
  } catch {
    // Preserve the repository error that triggered the rollback.
  }
};

export const createSqliteOrchestratorStateRepository = (
  database: DatabaseSync,
): OrchestratorStateRepository<SqliteOrchestratorStateRepositoryError> => ({
  load: () => {
    try {
      const hasPersistedState =
        database
          .prepare('SELECT id FROM orchestrator_state WHERE id = 1')
          .get() !== undefined;

      if (!hasPersistedState) {
        return ok(undefined);
      }

      const rows = v.parse(
        persistedGoalRowsSchema,
        database
          .prepare(
            `
              SELECT
                goal_json AS goalJson,
                id,
                origin,
                parent_goal_id AS parentGoalId,
                reason,
                rule,
                type
              FROM orchestrator_goals
              ORDER BY position
            `,
          )
          .all(),
      );
      const goals = rows.map((row) => {
        const goal = parseActiveGoal(row.goalJson);
        assertMatchingMetadata(goal, row);
        return goal;
      });

      return ok({ goals });
    } catch (cause: unknown) {
      return err(new SqliteOrchestratorStateRepositoryError('load', { cause }));
    }
  },
  save: (state: DurableOrchestratorState) => {
    try {
      database.exec('BEGIN IMMEDIATE;');
      database.exec('DELETE FROM orchestrator_goals;');

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

      state.goals.forEach((goal, position) => {
        const metadata = metadataForGoal(goal);
        insertGoal.run(
          position,
          goal.id,
          goal.type,
          metadata.origin,
          metadata.parentGoalId,
          metadata.rule,
          metadata.reason,
          JSON.stringify(goal),
        );
      });

      database
        .prepare(
          `
            INSERT INTO orchestrator_state (id, saved_at)
            VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT (id) DO UPDATE SET saved_at = excluded.saved_at
          `,
        )
        .run();
      database.exec('COMMIT;');
      return ok(undefined);
    } catch (cause: unknown) {
      rollback(database);
      return err(new SqliteOrchestratorStateRepositoryError('save', { cause }));
    }
  },
});
