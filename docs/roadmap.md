# Roadmap

This roadmap tracks bot capabilities, not the current runtime assignments in
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

The migration must keep the current bot usable at every step. Transitional
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

- [x] Add a runtime dispatcher for bounded farming and hunting Activities.
- [x] Reuse the existing farming and hunting cycles.
- [x] Add targeted craft execution that does not acquire missing inputs
      recursively.
- [x] Add targeted equip execution that does not craft missing equipment
      recursively.
- [x] Return typed Blockers for missing prerequisites.
- [x] Run explicit equipment Goals through targeted withdraw, craft, and equip
      steps, including direct recipe materials already in the bank.
- [x] Acquire a missing direct raw material from one unambiguous gather or hunt
      source with an eligible crew member.
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
- [ ] Keep safety, Reservations, resource protection, and prerequisites outside
      configurable strategy order.
- [x] Add the first automatically generated finite progression Goal.
- [ ] Preserve a blocked parent Goal while inserting its prerequisite Goal ahead
      of it.

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

- [ ] Move monster selection into a pure combat Goal Rule.
- [ ] Move resource selection into a pure gathering Goal Rule.
- [ ] Move profession Goals out of local task-runner Maps.
- [ ] Move gear-upgrade decisions into orchestration.
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

## Persistence

Start with in-memory orchestrator state.

Consider SQLite only when at least one of these becomes necessary:

- Goals must survive process restarts;
- request-rate history must survive development restarts;
- decision history is needed for tuning;
- API data no longer provides enough queryable history;
- production and consumption rates need aggregation.

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
