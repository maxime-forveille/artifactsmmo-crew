# Artifacts MMO Crew Runbook

Operational guidance for running and diagnosing Artifacts MMO Crew. See
[`../README.md`](../README.md) for installation and
[`architecture.md`](architecture.md) for design.

## Start and stop

```bash
pnpm dev
```

Development uses `tsx watch`; saving a source file restarts the process.
Stopping the command sends normal process termination, but an in-flight game
Action has already reached the server and cannot be cancelled remotely.

Production-style local execution:

```bash
pnpm build
pnpm start
```

Do not run several instances of Artifacts MMO Crew with the same account.
Action and data rate limits are shared across the account/IP, while each process
only knows its own local request history.

## Runtime configuration

Required environment variable:

```bash
ARTIFACTS_TOKEN=your_jwt_token
```

Common optional values:

```bash
LOG_LEVEL=info
NODE_ENV=development
```

The runtime currently supports two mutually exclusive configuration paths:

1. `orchestration.json` starts the rolling orchestrator with its current ordered
   explicit `goals` schema and may also validate `policy.goalRuleOrder`;
2. when that file is absent, `tasks.json` starts the transitional Task Adapter.

Create transitional task assignments from the template:

```bash
cp tasks.example.json tasks.json
```

`tasks.json` is re-read every 10 seconds. A valid changed assignment aborts the
old character task between cycles, waits for it to stop, then starts the new
one. Invalid JSON is logged and the last-known-good assignments keep running.

The migration schema accepts `policy.goalRuleOrder`, requiring every supported
rule exactly once, but the current runtime still executes only explicit Goals.
Autonomous Goal generation and optional one-shot overrides remain future steps.
Safety, Reservation, prerequisite, and resource-exclusivity invariants remain
non-configurable.

## Validation commands

Use repository scripts rather than invoking tool binaries directly:

```bash
pnpm format
pnpm type-check
pnpm lint
pnpm test
```

Additional checks:

```bash
pnpm format:check
pnpm test:coverage
pnpm test:mutation:dry
pnpm test:mutation
```

Generate API types after the live OpenAPI schema changes:

```bash
pnpm generate:api-types
```

Review the generated diff before keeping it.

## Logs

Set verbose logging when diagnosing decisions or request flow:

```bash
LOG_LEVEL=debug pnpm dev
```

Normal logs identify:

- the character;
- selected task or target;
- movement and Action start/completion;
- cooldown duration and waiting;
- banking and inventory recovery;
- decision fallbacks and Blockers;
- HTTP status, URL, and response body on client errors.

Once autonomous Goal Policy is implemented, decision logs will also identify the
originating Goal Rule, resulting Goal Proposal, selected Activity, configured
rank, reason, and utility evidence.

Avoid logging the Artifacts token or full Authorization header.

## Rate limits

The Artifacts API applies account/IP limits across all characters. The client
uses separate paced sliding-window buckets for Actions and data reads, with a
safety margin below the documented server limits.

Static catalogs are cached for the process lifetime. Character logs use a
short TTL because they only guide XP heuristics. Bank reads use a short TTL and
are invalidated after successful deposits or withdrawals.

### HTTP 429

Typical messages include:

```text
Rate limit exceeded: 10 per 1 second
Rate limit exceeded: 200 per 1 minute
Rate limit exceeded: 2000 per 1 hour
```

Checks:

1. confirm only one Artifacts MMO Crew process is running;
2. stop additional scripts or browser traffic using the same account/IP;
3. inspect whether a decision loop repeatedly requests dynamic data;
4. avoid repeated `tsx watch` restarts during the server's hourly window;
5. wait for the indicated server window before live retesting.

The limiter is currently in memory. Restarting the process clears local
history but does not clear the server's window. A restart can therefore receive
a 429 on its first request even when the new process has sent nothing before.

Do not solve an hourly 429 only by increasing retry frequency. Reduce duplicate
reads, cache stable data, or persist limiter history when SQLite is introduced.

## Inventory full: status 497

The game returns status 497 when a character cannot receive more items.
Existing workflows should recover as follows:

- farming/hunting: move to the bank and deposit everything;
- material gathering during craft: preserve the target material and deposit
  other inventory;
- bank withdrawal: make room before retrying the withdrawal.

If 497 repeats, inspect the requested withdrawal quantity and whether the
inventory contains only the item the workflow is trying to preserve. Large
multi-craft quantities previously caused impossible withdrawals; bounded craft
quantities are preferred.

## Combat safety

`fightSafely` rests before combat when HP is at or below half of maximum HP.
The strict comparison is intentional: exactly half HP is not considered safe
because another similar hit could defeat the character.

`findNextSafeMonster` filters targets through the combat safety model. If no
monster qualifies, current transitional tasks log `NoSafeMonsterFoundError`
and retry/fallback rather than fighting an unsafe target.

When diagnosing repeated losses:

1. verify the equipped weapon and armor in the character snapshot;
2. inspect the selected monster and computed safety path;
3. confirm material-acquisition combat also passed the safety check;
4. check whether the character rested before the fight;
5. preserve logs showing opponent, HP, and result.

## Characters appear idle

Check in order:

1. an Action cooldown may still be running;
2. the task may be retrying after a logged error;
3. `tasks.json` may be invalid or omit the character;
4. inventory may be full while banking failed;
5. no safe monster/resource/recipe may currently qualify;
6. a previous task may be finishing its bounded cycle before reassignment.

Use `LOG_LEVEL=debug` before assuming the process is stuck.

## Bank and crafting diagnosis

When a craft does not progress, verify:

- the target recipe's exact crafting profession and required level;
- held inventory before bank quantities;
- all recursive material sources;
- gathering-level eligibility for resource sources;
- combat safety for monster-drop sources;
- inventory capacity before withdrawals;
- the requested craft quantity is bounded.

A material being present in the bank does not imply that the character has
space to withdraw it or the profession level to craft its consumer.

## Mutation testing

Stryker runs in-place because the current TypeScript native-preview package is
incompatible with Stryker's sandbox tsconfig rewriting. It creates a backup
under `.stryker-tmp` and restores source files when complete.

The Vitest runner creates one `stryker-setup-<worker>.js` file in the project
root and can fail to remove every file when workers close concurrently. The
package scripts use `scripts/runMutationTests.ts` to preserve concurrency while
removing these runner artifacts after both successful and failed runs.

Do not interrupt mutation testing unless necessary. If interrupted, inspect
`.stryker-tmp` and the Git diff before continuing. HTML reports are written to
`reports/mutation/` and are ignored by Git.

Surviving mutants are not automatically missing tests. Some are equivalent or
cover defensive branches impossible under the generated OpenAPI types. Add a
test only when the mutant represents a meaningful contract.

## Live-check safety

Before any live check:

- stop the normal Artifacts MMO Crew process;
- prefer read-only endpoints;
- avoid loops and broad pagination unless required;
- account for the existing hourly server window;
- never commit scratch scripts containing account-specific data;
- restart the main Artifacts MMO Crew process only after the check exits.

Unit and MSW tests remain the default verification path. Live checks confirm
server behavior; they do not replace deterministic tests.
