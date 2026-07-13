# Artifacts MMO Bot

Personal TypeScript bot for managing my 5-character crew in Artifacts MMO.

**Characters:** Cartman, Stan, Kyle, Kenny, Butters. There are no fixed roles —
every character runs the same small set of `Task` types (`farm`, `hunt`,
`craftAndEquip`, `craftAndEquipThenHunt`, `autoHunt`), assigned per-character
in `tasks.json` (not committed - see `tasks.example.json` and Configuration
below). What each one is currently doing has changed several times already
(farming → gearing up → hunting) as the crew's needs evolved; reassigning
someone just means editing that file - the running bot picks up the change
on its own within a few seconds, no restart needed.

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

# Set up task assignments
cp tasks.example.json tasks.json
# Edit tasks.json to match your characters and what they should be doing

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
│   │   ├── tasks/          # task.ts: the Task type (farm / hunt / autoHunt /
│   │   │                   # craftAndEquip / craftAndEquipThenHunt);
│   │   │                   # runTask.ts: dispatcher; taskRunners.ts: one
│   │   │                   # runner per task type; runForever.ts: shared
│   │   │                   # retry-forever loop
│   │   ├── combat.ts        # fightSafely: rests when HP is low, fights once,
│   │   │                    # logs a loss; averageDamagePerTurn/isSafeToFight:
│   │   │                    # the damage model shared with gear.ts
│   │   ├── gear.ts          # Task-appropriate equipment: findBestGatheringTool
│   │   │                    # (best tool for a gathering skill) and
│   │   │                    # findBestCombatWeapon (best weapon vs a monster)
│   │   ├── inventory.ts     # Pure helpers over a character's inventory
│   │   │                    # (held quantity, full-capacity checks, ...)
│   │   ├── progression.ts   # Automated decision layer (in progress): what
│   │   │                    # to hunt/farm/craft next, e.g. findNextSafeMonster
│   │   ├── xpRates.ts       # observedMonsterXpRates: XP/second per monster,
│   │   │                    # derived from GET /my/logs/{name} - no guessed
│   │   │                    # game formula, only data the API has revealed
│   │   ├── taskSupervisor.ts # runTaskSupervisor/reconcileTasks: re-reads
│   │   │                     # tasks.json on an interval and starts/stops/
│   │   │                     # restarts characters per AbortController
│   │   │                     # (see task.ts's tasksEqual for the diffing)
│   │   └── world.ts         # Resolves resource/monster/workshop codes to
│   │                        # map positions
│   ├── client/              # Typed, Result-based Artifacts MMO API wrapper,
│   │                         # incl. a paced rate limiter (see below)
│   │                         # (schema.d.ts is generated from the OpenAPI spec,
│   │                         # see 'pnpm generate:api-types')
│   ├── utils/                # Config, logging, cooldown helpers,
│   │                          # taskAssignments.ts (parses tasks.json)
│   └── index.ts               # Entry point: wires bot + loadTaskAssignments
│                               # into runTaskSupervisor
├── scripts/                    # One-off dev scripts (e.g. OpenAPI codegen)
├── tests/
├── .env.example
├── tasks.example.json          # Template for tasks.json (not committed)
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

### Task Assignments

`tasks.json` maps each character name to a `Task` (see `src/bot/tasks/task.ts`
for the full list of task types and their fields); it's parsed and validated
by `loadTaskAssignments` (`src/utils/taskAssignments.ts`) with the same
valibot + "throw a readable summary of every issue" pattern as env vars, and
re-read every 10 seconds while the bot runs - editing it takes effect without
a restart (see `src/bot/taskSupervisor.ts`, and the Roadmap section below for
exactly when a change applies). Not committed (see `tasks.example.json` for
the template) since it's runtime config for this account's characters, not
project source - same treatment as `.env`.

```json
// tasks.json
{
  "Cartman": { "type": "autoHunt" },
  "Stan": { "type": "farm", "resource": "copper_rocks" },
  "Kyle": { "type": "hunt", "monster": "chicken" },
  "Kenny": { "type": "craftAndEquip", "items": ["copper_ring", "copper_boots"] },
  "Butters": {
    "type": "craftAndEquipThenHunt",
    "items": ["wooden_staff"],
    "monster": "yellow_slime"
  }
}
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
  `craftAndEquip` works through a list of items once;
  `craftAndEquipThenHunt` does both (gear up, then hunt forever - the
  craft/equip part is a no-op for characters that already have the item).
  `src/index.ts` assigns one task per character.
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
doing right now (that's just runtime config in `tasks.json`).

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
- ✅ `autoHunt` task: picks the best monster that's still safe to fight,
  re-evaluated every cycle instead of a fixed monster code — all 5
  characters run it now (see "Automated progression decisions" below)
- ✅ Task-appropriate equipment: `farm` equips the best gathering tool for
  the resource's skill before gathering, and `hunt`/`autoHunt` equip the
  best weapon against the specific monster being fought, both via the
  existing bank-aware `craftAndEquip` (see "Automated progression
  decisions" below)
- ✅ Target selection now prefers whichever safe monster has the best
  _observed_ XP/second rate from the character's own fight history (`GET
/my/logs/{name}`), falling back to the highest-level heuristic for
  monsters it hasn't fought recently (see "Automated progression
  decisions" below)
- ✅ Task assignments moved out of `src/index.ts` and into `tasks.json`
  (`src/utils/taskAssignments.ts`, validated with valibot, same
  fail-fast-with-a-readable-summary pattern as env vars) - reassigning a
  character no longer needs a code change, just an edit to that file
- ✅ `tasks.json` reloads without restarting the process
  (`src/bot/taskSupervisor.ts`): re-read every 10s, diffed per character
  (`tasksEqual`), and only characters whose task actually changed get
  restarted - everyone else keeps running untouched. A restart means an
  `AbortController` per character is aborted and its (forever-looping)
  task is awaited before the new one starts, so a reassignment applies
  cleanly between cycles, never mid-action - see `runForever`'s doc
  comment for exactly when that check happens (can take up to one full
  cycle). A JSON typo mid-edit is logged and skipped, not fatal - the bot
  keeps running the last-known-good assignments.

Up next (not yet started, roughly in order of likely value):

- [ ] Grand Exchange trading
- [ ] Multi-character boss fights
- [ ] Discord notifications for notable events (rare drops, task failures)

### Automated progression decisions (in design)

Right now what to farm/hunt/craft is a hardcoded resource/monster/item code
per character in `src/index.ts`, picked and adjusted by hand every time a
character levels up or finishes a gear upgrade (this happened repeatedly
while building the bot so far). The goal is a decision layer that picks the
best next thing to do on its own. Planned in small, independently-testable
pieces:

1. ✅ **`isSafeToFight(character, monster)`** (`src/bot/combat.ts`) — a pure
   heuristic deciding whether a fight is worth attempting, before
   committing to it.
   - Per-element damage: attack stat boosted by the attacker's `dmg`/
     `dmg_<element>` % bonuses (characters only — monsters don't have
     these), then mitigated by the defender's resistance to that element,
     summed across all four elements, computed both ways (character →
     monster and monster → character).
   - Critical strikes included on both sides (average damage multiplier
     `1 + 0.5 × crit% / 100`), since gear can swing crit chance a lot (e.g.
     `copper_dagger` = 35% vs `wooden_stick`'s 5%).
   - Converted to "turns to kill" vs "turns to die"; safe only if
     `turns_to_kill ≤ turns_to_die / 2` — a 2x margin, in the same spirit as
     `restIfLow`'s 50%-HP threshold, to absorb the variance this simplified
     model doesn't capture (crit streaks, roll luck, ...).
   - Turn order/initiative is deliberately ignored (documented
     simplification, not an oversight) — revisit only if real fights diverge
     too much from the prediction.
2. ✅ **`findNextSafeMonster(client, character)`** (`src/bot/progression.ts`)
   — queries monsters up to the character's level and picks the best one
   `isSafeToFight` still allows, using the observed XP/second rate from
   point 4 where available and the highest-level heuristic as a fallback
   otherwise. Returns `undefined` when nothing qualifies, which callers
   should treat as "go upgrade gear instead" (point 3). Wired in as the new
   `autoHunt` `Task` (`src/bot/tasks/runTask.ts`), which re-picks the
   target every cycle instead of using a fixed monster code — all 5
   characters run it now.
3. ✅ **Task-appropriate equipment ("build per task")** (`src/bot/gear.ts`)
   — equip whatever fits the activity at hand, not just the highest raw
   combat stats.
   - `findBestGatheringTool(client, skill, maxLevel)` — Artifacts MMO models
     gathering tools as weapons with an effect whose code matches the
     gathering skill and a negative value (e.g. `copper_pickaxe` has
     `{code: "mining", value: -10}`, a 10% cooldown reduction). Picks the
     largest reduction among weapons at or below `maxLevel`. Wired into
     `runFarmTask`, once before its forever loop (the resource, and so the
     needed skill, never changes mid-task).
   - `findBestCombatWeapon(client, character, monster, maxLevel)` — reuses
     `combat.ts`'s `averageDamagePerTurn` (now exported): removes the
     currently-equipped weapon's own contribution from the character's
     stats, adds each candidate weapon's contribution back in, and picks
     whichever deals the most estimated damage against that specific
     monster (weapon effect codes like `attack_<element>`, `dmg`,
     `dmg_<element>`, `critical_strike` map 1:1 onto the same stat names
     the damage model already uses). Wired into `runHuntTask` (once, fixed
     monster) and `runAutoHuntTask` (every cycle, since the target — and so
     the ideal weapon — can change as the character levels up).
   - Both reuse `craftAndEquip` as-is (bank-aware, idempotent, can reclaim
     items from other slots) — no new low-level capability was needed, just
     the selection logic. Failures are logged and non-fatal: the character
     just keeps whatever's currently equipped.
   - Still open: `findNextSafeMonster` returning `undefined` doesn't yet
     trigger "try upgrading gear first" — it just retries later.
4. ✅ **Target selection by XP/loot rate** (`src/bot/xpRates.ts`) — replaces
   `findNextSafeMonster`'s "highest level that's safe" stand-in with a real
   estimate, without guessing at a game formula: the API never reveals a
   monster's XP ahead of time, only after a fight actually happens (in the
   fight response, and in `GET /my/logs/{name}`'s history of past ones).
   - `observedMonsterXpRates(client, characterName)` fetches the
     character's last 100 log entries, sums XP and cooldown seconds per
     opponent across every fight found (win _or_ loss — a loss's 0 XP is
     real data, not something to discard), and returns XP/second per
     monster code. A monster this character hasn't fought recently is
     simply absent from the result, not zero - `findNextSafeMonster` only
     compares monsters it actually has a rate for.
   - `findNextSafeMonster` now picks whichever safe monster has the best
     observed rate, falling back to the old highest-level heuristic when
     none of the safe candidates have been fought recently enough to have
     one yet (e.g. right after leveling into a new bracket).
   - `observedMonsterXpRatesOrEmpty` degrades a log-fetch failure to an
     empty map instead of blocking target selection - same non-blocking
     spirit as the equipment failures in point 3.
   - Because the rates come from the account's own server-side log
     history (`/my/logs/{name}`, last ~5000 actions), this survives
     process restarts for free - no separate persistence needed for this
     piece.

This will likely replace the fixed resource/monster codes in `farm`/`hunt`
tasks with periodic re-evaluation (e.g. after every cycle) rather than a
separate "decide once at startup" step, so a character naturally moves to a
better target as it levels up or gears up, without a human editing
`src/index.ts` and restarting.

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
