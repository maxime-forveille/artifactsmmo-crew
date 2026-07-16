# Artifacts MMO Bot

Personal TypeScript bot for coordinating a five-character crew in
[Artifacts MMO](https://artifactsmmo.com/).

The bot currently runs gathering, hunting, crafting, equipment, and banking
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

Do not run multiple bot processes for the same account. Artifacts rate limits
are shared across characters and processes.

## Documentation

- [`CONTEXT.md`](CONTEXT.md) — project vocabulary: Action, Activity, Goal,
  Reservation, Blocker, and orchestration terms.
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
  utils/              Configuration, logging, cooldowns, JSON adapter
```

The target decision flow is:

```text
CrewSnapshot + OrchestratorState
              ↓
proposed Activities + next OrchestratorState
```

Each Activity runs one complete operational cycle. The orchestrator observes
the crew again after completion and schedules new work only for idle
characters. See [`docs/architecture.md`](docs/architecture.md) for the full
model and migration plan.

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

The equipment Goal resolves its recipe tree, retrieves banked inputs, crafts
intermediates, then crafts and equips the target. When a missing raw material
has exactly one gather or hunt source, an eligible crew member acquires it
first. The target character currently performs every craft in that chain;
ambiguous sources and insufficient profession levels remain blocked.

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
pnpm test:coverage       # Generate coverage
pnpm test:mutation:dry   # Validate Stryker configuration
pnpm test:mutation       # Run incremental mutation testing

pnpm generate:api-types  # Refresh generated OpenAPI declarations
```

Use these package scripts rather than invoking their underlying binaries
directly.

## Important operational notes

- The client paces Action and data requests below server limits.
- Static catalogs are cached for the process lifetime.
- Bank data and character logs use short-lived caches.
- Local rate-limit history is lost on restart; the server window is not.
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
