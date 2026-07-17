# Artifacts MMO Crew Roadmap

This roadmap tracks Artifacts MMO Crew capabilities, not the current runtime assignments in
`tasks.json`. Git history remains the detailed record of delivered changes and
live incidents.

## Current direction

Replace long-running `autoHunt`/`autoFarm` tasks with a crew orchestrator that
automatically proposes finite Goals and selects bounded Activities from shared
Crew Snapshots and world knowledge.

Permanent MMO progression comes from completing finite milestones and
automatically proposing the next useful Goal, not from infinite Goals or
manually selected Directives.
Strategic Goal Rule order will be configurable in `orchestration.json`; safety
and correctness invariants remain fixed in code.

The migration must keep Artifacts MMO Crew usable at every step. Transitional
tasks remain until their policy and execution behavior have moved behind the
new orchestration Interface.

## Delivered foundations

### Client and runtime

- [x] Generated OpenAPI TypeScript schema.
- [x] Typed `openapi-fetch` client returning `ResultAsync`.
- [x] Account-wide paced rate limiting with safety margin.
- [x] Static catalog memoization.
- [x] Short-lived character-log and bank caching.
- [x] Bank cache invalidation after mutations.
- [x] Cooldown-aware Character Agent.
- [x] Hot-reloaded per-character `tasks.json` assignments.
- [x] Per-character cancellation and restart isolation.

### Executable workflows

- [x] Farming cycle: move, gather until full, bank.
- [x] Hunting cycle: move, fight/rest until full, bank.
- [x] Recursive craft-and-equip workflow.
- [x] Bank-aware material sourcing and inventory-full recovery.
- [x] Safe monster-drop fallback for crafting materials.
- [x] Gathering tools selected for the current skill.
- [x] Combat equipment selected against the current monster.

### Decision inputs

- [x] Pure combat safety and combat-margin model.
- [x] Safe monster selection.
- [x] Observed monster XP/second from character logs.
- [x] Farmable resource selection by gathering skill level.
- [x] Read-only combat gear upgrade detection.
- [x] Read-only recursive material-cost planning.
- [x] Bank-surplus craft detection.
- [x] Targeted profession progression for a blocked upgrade.

### Crew orchestration foundations

- [x] Shared read-only Crew Snapshot for all characters and bank pages.
- [x] Pure snapshot-to-assignment policy seam.
- [x] First cross-character resource-replenishment rule.
- [x] `activities/`, `orchestration/`, and `runtime/` module structure.
- [x] Initial bounded Activity type.
- [x] Action, Activity, Goal, Reservation, and failure vocabulary.

## In progress: bounded Activity migration

### 1. Orchestrator state

- [x] Define plain-data Goals and Reservations.
- [x] Keep runtime promises and cancellation handles outside state.
- [x] Define pure state transitions for Activity completion and Blockers.
- [x] Use crew-level Goals ordered explicitly by priority.
- [x] Track known item quantities in Reservations to avoid over-allocation.

### 2. Activity execution

- [x] Add a runtime dispatcher for bounded farming and combat Activities.
- [x] Reuse the existing farming and hunting cycles.
- [x] Add targeted craft execution that does not acquire missing inputs
      recursively.
- [x] Add targeted equip execution that does not craft missing equipment
      recursively.
- [x] Return typed Blockers for missing prerequisites.
- [x] Run explicit equipment Goals through targeted withdraw, craft, and equip
      steps, including direct recipe materials already in the bank.
- [x] Acquire a missing direct raw material from one unambiguous resource or
      monster source with an eligible crew member.
- [x] Expand equipment prerequisites through craftable material intermediates.
- [x] Assign intermediate crafts across characters and return their outputs to
      shared storage.

### 3. Rolling scheduler

- [x] Run at most one Activity per character.
- [x] Serialize simultaneous completion events.
- [x] Refresh the Crew Snapshot after an Activity finishes.
- [x] Schedule only idle characters.
- [x] Keep in-flight Reservations visible to policy.
- [x] Retry Transient Failures without invoking policy again.
- [x] Return Blockers to policy with their Goal preserved.
- [x] Retry failed Crew Snapshot refreshes before replanning.
- [x] Wire the coordinator to Character Agents and the Artifacts client.

### 4. Autonomous Goal policy

- [x] Decide that Goals are finite milestones; do not add infinite Goals or
      manually selected Directives.
- [x] Define deterministic paginated `WorldKnowledge` loading for static items,
      monsters, and resources.
- [x] Pass `WorldKnowledge` as explicit input to autonomous Goal Policy.
- [x] Define `GoalRule`, `GoalCandidate`, and `GoalProposal` plain-data types.
- [x] Implement `createGoalPolicy` with a `proposeGoals` façade.
- [x] Split policy into `discoverGoalCandidates`, `rankGoalCandidates`, and
      `selectCompatibleGoals`.
- [x] Give generated Goals stable semantic IDs and prevent equivalent active
      Goals from being proposed twice.
- [x] Keep safety, Reservations, resource protection, and prerequisites outside
      configurable strategy order.
- [x] Add the first automatically generated finite progression Goal.
- [x] Propose an obtainable weapon upgrade when no level-appropriate combat is
      safe.
- [x] Invoke Goal Policy from the rolling runtime and persist accepted Goals
      before their Activities start.
- [x] Replace a completed combat Goal from the same observed Snapshot so
      autonomous progression does not become idle between levels.
- [x] Preserve a blocked parent Goal while inserting its prerequisite Goal ahead
      of it.
- [x] Convert crafting-level Blockers into durable `reachProfessionLevel`
      prerequisites and reconcile their observed completion.

### 5. Configurable strategy

- [x] Validate named Goal Rules in `orchestration.json`.
- [x] Configure Goal Rule priority as one ordered array without numeric priority
      collisions.
- [x] Require every supported autonomous rule to be present exactly once when
      policy is configured; explicit disabling semantics remain undesigned.
- [ ] Keep one-shot override Goals above autonomous Goal Proposals.
- [ ] Log the rule, reason, configured rank, and utility evidence for every
      selected Goal Proposal.
- [ ] Add utility weights only after deterministic rule ordering is proven.

### 6. Extract existing automatic decisions

- [x] Move monster selection into pure combat planning.
- [ ] Move resource selection into a pure gathering Goal Rule.
- [x] Plan one bounded profession-XP withdrawal or craft from held and unreserved
      bank materials for durable profession Goals.
- [x] Turn one absent raw profession-recipe material with a unique eligible
      gathering source into a durable bank-stock prerequisite.
- [x] Turn one absent profession-recipe material that is itself craftable from
      held or banked inputs into a durable `produceItem` prerequisite.
- [x] Turn one absent profession-recipe material with a unique monster source
      into a durable bank-stock prerequisite and safe combat Activity.
- [ ] Turn insufficient gathering levels into one-layer profession prerequisites,
      then remove equivalent local task-runner decisions.
- [ ] Extend the first weapon-only equipment Goal Rule to the remaining combat
      slots.
- [ ] Split farming and hunting super-Activities into short gathering/combat
      chunks plus explicit inventory storage.
- [ ] Replace `autoHunt` and `autoFarm` with automatically generated Goals and
      composed Activities.
- [ ] Remove `runForever` once no autonomous behavior depends on it.

### 7. Assignment sources

- [x] Validate explicit orchestration Goals and resource mappings.
- [x] Resolve configured resources and items before runtime startup.
- [x] Move assignment vocabulary out of `utils/`.
- [x] Keep `tasks.json` as a human Adapter during migration.
- [ ] Change `orchestration.json` from explicit assignment input to Goal Policy
      configuration plus optional one-shot overrides.
- [ ] Make autonomous orchestration the default assignment source once proven.
- [ ] Remove the `tasks.json` fallback, Task Supervisor, and `src/bot/tasks/`.

## Decision quality

- [x] Support several simultaneous bank targets with explicit priority.
- [x] Account for in-flight production before assigning duplicate work.
- [x] Rank Goal Candidates first by configured Goal Rule order, then by utility
      and a deterministic tie-breaker.
- [ ] Compare hunting and gathering with observed XP/time data.
- [ ] Choose profession XP recipes from observed efficiency rather than only
      missing-material count and recipe level.
- [ ] Re-evaluate resource thresholds from observed consumption and production.
- [ ] Coordinate one character gathering for another character's craft Goal.
- [ ] Process useful bank surpluses without starving higher-priority Goals.

## SQLite persistence

SQLite is now planned before autonomous orchestration becomes the default. It
must remain an Adapter around pure policy and planning functions, never a new
source of game truth or a place where strategy is implemented.

### Durable orchestrator state

- [x] Introduce an active-Goal representation that retains Goal data, priority,
      `parentGoalId`, origin, originating Goal Rule, and decision reason.
- [x] Define an `OrchestratorStateRepository` Port and an isolated in-memory
      Adapter.
- [x] Implement the SQLite `OrchestratorStateRepository` Adapter.
- [x] Add a versioned SQLite schema and forward-only migrations.
- [x] Persist Goal acceptance, completion, ordering, and prerequisite metadata
      transactionally before newly planned Activities start.
- [x] Load durable Goals after restart, then reconcile them against a fresh Crew
      Snapshot before planning new work.
- [x] Restart with no active Reservations: runtime promises disappeared and must
      never be reconstructed as running work.
- [x] Complete Goals already satisfied by observed API state before proposing
      replacements.
- [x] Resolve restored equipment and bank-replenishment Goals from
      Goal-independent world knowledge rather than configuration Goal IDs.
- [x] Preserve autonomous, override, and blocked parent Goals across restarts for
      every current Goal type wired into the live runtime.
- [x] Keep Character state, inventory, equipment, cooldowns, and bank contents
      authoritative in the Artifacts API rather than duplicated local state.
- [x] Add restart and migration tests using isolated temporary databases.

### Persistent cache

Implement this as a separate tranche after durable orchestrator state. It may
share the SQLite database, but it must use separate tables and an independent
Adapter contract.

- [ ] Persist static world knowledge for items, monsters, resources, and maps so
      development restarts do not refetch unchanged catalog pages.
- [ ] Store normalized cache keys, payload version, fetch time, and freshness
      metadata for every cached entry.
- [ ] Define freshness and invalidation policy per data family instead of one
      global TTL.
- [ ] Never cache failed responses, transport failures, or rate-limit responses
      as successful data.
- [ ] Keep live account data short-lived and invalidate affected bank or
      character entries immediately after successful mutations.
- [ ] Never use stale cached account data as an authoritative Crew Snapshot.
- [ ] Persist request-window history needed to respect minute and hourly rate
      limits across development restarts.
- [ ] Persist combat and profession observations needed for later XP/time and
      production/consumption decisions.
- [ ] Add bounded retention and pruning for logs, observations, and expired
      cache entries.
- [ ] Exclude authorization tokens, request headers, and other secrets from
      persistent cache data.
- [ ] Add cache hit, expiry, invalidation, restart, corruption, and migration
      tests.

SQLite may later support decision-history queries and production/consumption
aggregation, but those capabilities must consume recorded observations rather
than move policy decisions into SQL.

## Later capabilities

### Recycling

Recycle only when the safety policy is proven. Open constraints:

- only crafted equipment, never raw resources by default;
- only equipment sufficiently below current progression;
- never recycle the best available gathering tool for a skill;
- preserve an item until a strictly better replacement is held or equipped;
- provide a dry-run explanation before any irreversible recycle Action.

### Economy and combat

- [ ] Grand Exchange trading.
- [ ] NPC trading.
- [ ] Multi-character boss fights.
- [ ] Raid participation and coordinated group equipment.

### Event-driven decisions

- [ ] Consume raid spawns and server announcements.
- [ ] React to rare events without waiting for the next polling cycle.
- [ ] Send optional Discord notifications for notable drops and failures.

Event consumption stays long-term until the polling orchestrator and its
priority model are stable.
