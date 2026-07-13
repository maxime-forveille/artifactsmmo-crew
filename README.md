# Artifacts MMO Bot

Personal TypeScript bot for managing my 5-character crew in Artifacts MMO.

**Characters:** Cartman, Stan, Kyle, Kenny, Butters. There are no fixed roles —
every character runs the same small set of `Task` types (`farm`, `hunt`,
`craftAndEquip`), assigned per-character in `src/index.ts`. What each one is
currently doing has changed several times already (farming → gearing up →
hunting) as the crew's needs evolved; reassigning someone just means editing
one line and restarting `pnpm dev`.

## Status

🟢 **Working** — the bot runs real gather/combat/craft loops end-to-end
against the live API. Iterating incrementally: small feature, tested (unit
tests + live smoke checks), then the next one.

## Tech Stack

- **Runtime:** Node.js 24.17.0
- **Language:** TypeScript 7, compiled/type-checked in strict mode
- **API:** [Artifacts MMO](https://docs.artifactsmmo.com/), typed via `openapi-fetch` against a generated `schema.d.ts` (see `pnpm generate:api-types`)
- **Errors:** [`neverthrow`](https://github.com/supermacro/neverthrow) — every client/strategy call returns a `Result`/`ResultAsync`, never throws, so failure paths can't be forgotten
- **Package Manager:** pnpm 11.9.0 (enforced via `packageManager`/`devEngines` in `package.json`)
- **Validation:** Valibot (env vars)
- **Dates:** date-fns (Temporal isn't natively available yet on Node 24 without `--experimental-temporal` or a polyfill)
- **Logging:** pino (pretty-printed in development)
- **Testing:** Vitest + MSW (for HTTP-contract tests against the client)
- **Linting/Formatting:** oxlint + oxfmt

## Quick Start

```bash
# Install dependencies
pnpm install

# Set up environment
cp .env.example .env
# Edit .env with your Artifacts token

# Run the bot
pnpm dev
```

## Project Structure

```
.
├── src/
│   ├── bot/                # Main bot logic
│   │   ├── characters/     # characterAgent.ts: cooldown/position-aware agent
│   │   │                   # factory, shared by all 5 characters (not one
│   │   │                   # file per character)
│   │   ├── strategies/     # farming.ts, hunting.ts, equipment.ts, banking.ts:
│   │   │                   # gathering, combat, craft+equip, and bank-deposit
│   │   │                   # pipelines
│   │   ├── tasks/          # runTask.ts: Task type (farm / hunt /
│   │   │                   # craftAndEquip) + dispatcher describing what a
│   │   │                   # character should be doing, run or continuous
│   │   ├── combat.ts        # fightSafely: rests when HP is low, fights once,
│   │   │                    # logs a loss - shared by hunting.ts and
│   │   │                    # equipment.ts's monster-drop fallback
│   │   ├── inventory.ts     # Pure helpers over a character's inventory
│   │   │                    # (held quantity, full-capacity checks, ...)
│   │   └── world.ts         # Resolves resource/monster/workshop codes to
│   │                        # map positions
│   ├── client/              # Typed, Result-based Artifacts MMO API wrapper,
│   │                         # incl. a paced rate limiter (see below)
│   │                         # (schema.d.ts is generated from the OpenAPI spec,
│   │                         # see 'pnpm generate:api-types')
│   ├── utils/                # Config, logging, cooldown helpers
│   └── index.ts               # Entry point: character -> Task assignments
├── scripts/                    # One-off dev scripts (e.g. OpenAPI codegen)
├── tests/
├── .env.example
└── package.json
```

## Configuration

### Environment Variables

```bash
# .env
ARTIFACTS_TOKEN=your_jwt_token_here
LOG_LEVEL=info
NODE_ENV=development

# Reserved for future use - validated but not wired to anything yet
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
ENABLE_NOTIFICATIONS=true
```

## What's implemented

- **`ArtifactsClient`** (`src/client/index.ts`) — every method (`getCharacter`,
  `getMaps`, `getItem`, `getResources`, `getMonsters`, `getBankItems`,
  `moveCharacter`, `rest`, `gather`, `fight`, `craft`, `equip`, `unequip`,
  `giveItems`, bank deposit/withdraw, gold) returns a `ResultAsync`, never
  throws.
- **Rate limiting** — a sliding-window limiter per bucket (`action`, `data`),
  with a safety margin under the server's documented limits and _paced_
  requests (never releases a backlog of queued requests all at once - see
  `src/client/rateLimiter.ts`'s doc comment for why that mattered in
  practice).
- **`CharacterAgent`** (`src/bot/characters/characterAgent.ts`) — wraps the
  client for one character: waits out cooldowns automatically, tracks
  position/inventory/HP from every action's response (including `fight`,
  which needed special handling — see git history for why).
- **World resolution** (`src/bot/world.ts`) — maps a resource/monster/workshop
  code to a map position, and finds which resource node or monster drops a
  given item code (item codes and resource/monster codes are distinct).
- **Farming** (`src/bot/strategies/farming.ts`) — move to a resource, gather
  until the inventory is full, bank everything.
- **Hunting** (`src/bot/strategies/hunting.ts` + `src/bot/combat.ts`) — move
  to a monster, fight repeatedly (resting below 50% HP, logging losses
  without stopping), bank everything looted.
- **Craft & equip** (`src/bot/strategies/equipment.ts`) — recursively resolves
  and gathers/crafts whatever materials are missing, checking in order: held
  inventory, the bank, whatever's currently equipped (e.g. the starter
  `wooden_stick` gets unequipped to use as a material for `wooden_staff`),
  then falls back to gathering, or hunting when a material is a monster drop
  rather than a gatherable resource. Equipping is idempotent (skips if the
  exact target item is already in that slot) and replaces whatever else is
  equipped there otherwise (unequip, then equip) — so the same item list can
  be handed to every character and it'll upgrade past their starter gear
  instead of treating it as "already equipped".
- **Inventory-full handling** — farming and hunting bank everything once
  full; mid-craft material gathering deposits everything _except_ the item
  being accumulated so progress isn't lost; a bank withdrawal that wouldn't
  fit deposits everything else first (all react to the same 497 "inventory
  full" the game returns).
- **Tasks** (`src/bot/tasks/runTask.ts`) — `farm` and `hunt` loop forever;
  `craftAndEquip` works through a list of items once. `src/index.ts` assigns
  one task per character.
- **Tests** — 60+ Vitest tests (dependency-injected fakes/neverthrow, no real
  network except `tests/client.test.ts`, which uses MSW for HTTP-contract
  tests).

## Scripts

```bash
# Development
pnpm dev               # Run the bot with hot reload (tsx watch)
pnpm build             # Compile TypeScript (tsconfig.build.json)
pnpm start             # Run the compiled build
pnpm type-check        # Type checking only, no emit

# Quality
pnpm test              # Run all tests once
pnpm test:watch        # Watch mode
pnpm test:coverage     # Coverage report
pnpm lint              # oxlint
pnpm lint:fix          # oxlint --fix
pnpm format            # oxfmt
pnpm format:check      # oxfmt --check

# Codegen
pnpm generate:api-types  # Regenerate src/client/schema.d.ts from the live OpenAPI spec
```

## Known Limitations

- **No runtime task control** — assignments are a hardcoded list in
  `src/index.ts`; reassigning a character means editing that file and
  restarting `pnpm dev`. A persistent/runtime task queue has been discussed
  but not built.
- **Single-character combat only** — `fight` supports up to 2 additional
  `participants` for boss monsters (per the API), but nothing in the bot
  builds multi-character boss fights or raids yet.
- **No trading** — Grand Exchange buy/sell and NPC trading aren't
  implemented.
- **Discord notifications** — `DISCORD_WEBHOOK_URL`/`ENABLE_NOTIFICATIONS`
  are validated as env vars but nothing sends notifications yet.

## Roadmap

This tracks the bot's own capabilities, not what any character happens to be
doing right now (that's just runtime config in `src/index.ts`).

Recently delivered (see git log for details):

- ✅ Typed API client with `Result`-based error handling, no thrown exceptions
- ✅ Rate limiting tuned against real 429s (paced requests + safety margin)
- ✅ Cooldown/position/HP-aware character agent
- ✅ Farming loop with automatic bank deposits
- ✅ Craft-and-equip pipeline with recursive material resolution, idempotent
  re-runs, and inventory-full handling mid-gather
- ✅ Combat: safe hunting loop (auto-rest, loss-tolerant) and a monster-drop
  fallback for crafting materials that aren't gatherable resources
- ✅ Bank-aware material sourcing (checks the bank before re-gathering/hunting)
- ✅ Equip upgrades replace whatever's already in a slot (unequip + equip)
  instead of treating starter gear as a permanent placeholder
- ✅ Equipped items get reclaimed as crafting materials when needed (e.g. the
  starter `wooden_stick` weapon is exactly what `wooden_staff` needs)
- ✅ Bank withdrawals that wouldn't fit in the inventory deposit everything
  else first, instead of hitting the game's 497 "inventory full" error
- ✅ Character-to-character item transfers (`giveItems`) — not wired into any
  `Task` yet (it needs both characters on the same tile, which the current
  one-character-per-task model doesn't coordinate), but available and used
  for one-off moves like consolidating a spare weapon onto one character

Up next (not yet started, roughly in order of likely value):

- [ ] **Automated progression decisions** — right now what to farm/hunt is a
      hardcoded resource/monster code per character. The goal is a decision layer
      that looks at a character's current level (and gear) and automatically
      picks the best available thing to do next, gathering or hunting, without
      a human choosing the target by hand.
- [ ] A lightweight way to reassign tasks without restarting the process
- [ ] Grand Exchange trading
- [ ] Multi-character boss fights
- [ ] Discord notifications for notable events (rare drops, task failures)

## Debugging

### Enable Verbose Logging

```bash
LOG_LEVEL=debug pnpm dev
```

### One-off live checks

For read-only or low-risk API checks during development, drop a scratch
script under `scripts/` (prefixed `_`, e.g. `scripts/_checkRates.ts`), run it
with `pnpm exec tsx --env-file=.env scripts/_checkRates.ts`, then delete it —
these aren't meant to be committed.

## Resources

- 📖 [Artifacts MMO Docs](https://docs.artifactsmmo.com/)
- 🔗 [OpenAPI Spec](https://api.artifactsmmo.com/openapi.json)
- 🎮 [Game Website](https://artifactsmmo.com/)

## Notes

- This is a **personal project** for learning TypeScript, async patterns, and API automation
- Not affiliated with Artifacts MMO team
- Please respect the game's ToS when using automation
- Ban risk is assumed by the user
