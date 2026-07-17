# Artifacts MMO Crew

Personal TypeScript crew orchestrator for coordinating five characters in
[Artifacts MMO](https://artifactsmmo.com/).

Artifacts MMO Crew currently runs gathering, hunting, crafting, equipment, and banking
workflows against the live API. It is being migrated from long-running
per-character `autoXXX` tasks toward a crew orchestrator that observes shared
state and schedules bounded Activities.

## Status

🟢 **Working against the live API.** Development remains incremental: one
small capability, deterministic tests, then live verification when needed.

Current characters: Cartman, Stan, Kyle, Kenny, and Butters. Runtime assignments
remain configurable through the `tasks.json` fallback during the orchestration
migration.

## Quick start

Requirements:

- Node.js 24.17.0;
- pnpm 11.9.0;
- an Artifacts MMO token.

```bash
pnpm install
cp .env.example .env
cp tasks.example.json tasks.json
```

Set the token in `.env`:

```bash
ARTIFACTS_TOKEN=your_jwt_token
```

Start the development process:

```bash
pnpm dev
```

Do not run multiple instances of Artifacts MMO Crew for the same account.
Artifacts rate limits are shared across characters and processes.

## Documentation

- [`CONTEXT.md`](CONTEXT.md) — project vocabulary: Action, Activity, Goal,
  Goal Rule, Goal Candidate, Goal Proposal, Reservation, and Blocker.
- [`docs/architecture.md`](docs/architecture.md) — module responsibilities,
  dependency direction, and the target orchestrator.
- [`docs/roadmap.md`](docs/roadmap.md) — delivered foundations and ordered next
  steps.
- [`docs/runbook.md`](docs/runbook.md) — runtime operation, diagnostics, rate
  limits, common failures, and live-check safety.
- [`AGENTS.md`](AGENTS.md) — repository rules for coding agents.

## Architecture summary

```text
src/
  bot/
    activities/       Bounded executable workflows
    orchestration/    Shared crew sensing and decisions
    runtime/          Character execution and supervision
    tasks/            Transitional forever-task implementation
  client/             Typed Result-based Artifacts API client
  persistence/        In-memory and SQLite persistence Adapters
  utils/              Configuration, logging, cooldowns, JSON adapter
```

The target decision flow is:

```text
CrewSnapshot + WorldKnowledge + OrchestratorState + GoalPolicy
                              ↓
                   finite Goal Proposals
                              ↓
              proposed bounded Activities
```

Goals are measurable milestones, not permanent modes. Autonomous progression
comes from proposing the next Goal whenever capacity becomes available or a
previous Goal completes. Activities execute bounded operational work before the
orchestrator observes again. Current farming and hunting cycles remain
transitional super-Activities and will be split into short work chunks plus
explicit storage. See [`docs/architecture.md`](docs/architecture.md) for the
full model and migration plan.

## Runtime assignments

The entrypoint starts configured crew orchestration when `orchestration.json`
exists. The file contains an ordered `goals` array. A `replenishBankItem` Goal
requires `id`, `itemCode`, `minimumBankQuantity`, and `resourceCode`. An
`equipItem` Goal requires `id`, `characterName`, and `itemCode`:

```json
{
  "goals": [
    {
      "characterName": "Stan",
      "id": "equip-stan-dagger",
      "itemCode": "copper_dagger",
      "type": "equipItem"
    }
  ]
}
```

At startup, active Goals resolve against one shared `WorldKnowledge` catalogue
of items, monsters, and resources. A combat-level Goal selects the highest-level
safe monster for its character until the target level is observed. The equipment
Goal resolves its recipe tree,
retrieves banked inputs, crafts intermediates, then crafts and equips the target.
When a missing raw material has exactly one resource or monster source, an
eligible crew member acquires it. Eligible characters can craft intermediate or
target items for one another; their output returns to the bank before the
consumer continues. Ambiguous sources and insufficient crew profession levels
remain blocked.

`orchestration.json` is becoming a strategy file rather than a replacement
`tasks.json`. During migration, `policy.goalRuleOrder` is accepted alongside the
current explicit `goals`. Every known rule must appear exactly once:

```json
{
  "goals": [],
  "policy": {
    "goalRuleOrder": [
      "equipmentUpgrade",
      "combatProgression",
      "professionProgression",
      "gatheringProgression",
      "bankReplenishment",
      "bankSurplusProcessing"
    ]
  }
}
```

When `policy` is present, the runtime invokes Goal Policy before Activity
planning. `combatProgression` creates one safe next-level Goal per available
character and replaces it after the level is observed. If no level-appropriate
monster is safe, the first `equipmentUpgrade` slice can propose an obtainable,
equippable weapon that strictly improves combat against the easiest current
challenge. Goals are persisted before their Activities start. Remaining named
rules are validated but produce no candidates until their implementations land;
finite one-shot overrides remain a later migration step. Omitting `policy` keeps
explicit-Goal behavior.

When an equipment craft is blocked by its profession level, orchestration
inserts a durable `reachProfessionLevel` prerequisite immediately before the
preserved equipment Goal. Until the required level is observed, it selects one
known recipe supported by held and unreserved bank materials, preferring fewer
withdrawals, then higher recipe level and stable item code. Each decision starts
at most one material withdrawal or one craft. If no recipe is supported, the
first missing material that is itself craftable from held or banked inputs
becomes a durable `produceItem` prerequisite. Otherwise, a raw material with
one unambiguous gathering source becomes a `replenishBankItem` prerequisite
when a crew member can already gather it; one unambiguous monster source becomes
a `replenishBankItem` prerequisite executed through safe combat. Insufficient
gathering levels remain a later prerequisite layer.

Configured orchestration persists active Goals in the ignored local file
`artifactsmmo-crew.sqlite`. On restart it restores those Goals with no active
Reservations, resolves their catalog needs independently of the current JSON,
observes a fresh Crew Snapshot, and records any reconciled state before
launching more Activities. Delete the database only when intentionally
resetting durable orchestration intent; the next start recreates its schema and
falls back to the Goals in `orchestration.json`.

Rule order is configurable strategy. Safety, Reservations, prerequisite
resolution, bank protection, and one-Activity-per-character constraints remain
non-configurable invariants. Reordering rules changes priorities without a code
change; adding new behavior still requires a tested Goal Rule.

When `orchestration.json` is absent, `tasks.json` remains the transitional human
Adapter. It is validated with Valibot and reloaded every 10 seconds without
restarting unchanged characters.

```json
{
  "Cartman": { "type": "autoHunt" },
  "Stan": { "skill": "mining", "type": "autoFarm" },
  "Kyle": { "monster": "chicken", "type": "hunt" }
}
```

See `tasks.example.json` and `src/bot/tasks/task.ts` for all current task
variants. Do not create both files expecting them to merge:
`orchestration.json` takes precedence. The orchestrator will progressively
replace `autoHunt` and `autoFarm`; explicit human control will remain as a
future one-shot override.

## Technology

- TypeScript 7 in strict ESM mode;
- `openapi-fetch` with generated Artifacts OpenAPI types;
- `neverthrow` for explicit `Result`/`ResultAsync` failures;
- Valibot for runtime configuration validation;
- date-fns for date handling;
- pino for structured logs;
- Vitest and MSW for deterministic tests;
- Stryker for mutation testing;
- oxlint and oxfmt for code quality.

## Commands

```bash
pnpm dev                 # Development with watch mode
pnpm build               # Compile with tsconfig.build.json
pnpm start               # Run the compiled build
pnpm type-check          # Type-check without emitting

pnpm format              # Format source and documentation
pnpm format:check        # Check formatting
pnpm lint                # Run oxlint
pnpm lint:fix            # Apply safe lint fixes

pnpm test                # Run the test suite once
pnpm test:watch          # Run tests in watch mode
pnpm test:coverage          # Generate coverage
pnpm test:mutation:changed  # Mutate changed source ranges once
pnpm test:mutation:dry      # Validate Stryker configuration
pnpm test:mutation          # Run full incremental mutation testing

pnpm generate:api-types  # Refresh generated OpenAPI declarations
```

Use these package scripts rather than invoking their underlying binaries
directly.

## Important operational notes

- The client paces Action and data requests below server limits.
- Static catalogs are cached for the process lifetime.
- Bank data and character logs use short-lived caches.
- Local rate-limit history is lost on restart; the server window is not.
- Configured Goals survive restarts in `artifactsmmo-crew.sqlite`; Reservations
  do not.
- Farming and hunting recover from full inventories by banking.
- Combat selection and material-acquisition fights use the shared safety model.

For diagnosis and recovery procedures, use
[`docs/runbook.md`](docs/runbook.md).

## Development approach

- functional TypeScript; avoid classes except typed errors;
- named exports and explicit dependencies;
- pure decision functions separated from game Actions;
- bounded Activities instead of hidden forever loops;
- correctness before readability, maintainability, then performance;
- no real network calls in tests except through MSW interception.

Detailed constraints for coding agents live in [`AGENTS.md`](AGENTS.md).
