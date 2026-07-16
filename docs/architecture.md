# Architecture

The bot is moving from long-running per-character `autoXXX` tasks toward a
crew orchestrator that observes shared state and schedules bounded Activities.
See [`../CONTEXT.md`](../CONTEXT.md) for the project vocabulary.

## Principles

- TypeScript ESM, functional and declarative.
- Errors are explicit through `Result`/`ResultAsync`.
- Game Actions stay behind bounded Activities.
- Goals are finite milestones with observable completion conditions.
- Permanent progression comes from automatic Goal proposal, not infinite Goals.
- Decisions observe state but do not perform Actions.
- Strategic rule priority is configurable; safety invariants are not.
- The runtime schedules, retries, and cancels without owning policy.
- Live game data is preferred over duplicated local state.

## Module map

```text
src/
  bot/
    activities/       Bounded executable workflows and Activity types
    orchestration/    Crew snapshots and shared decision policy
    runtime/          Character execution state and supervision
    tasks/            Transitional forever-task implementation
    combat.ts         Combat execution and safety model (still mixed)
    gear.ts           Equipment selection
    inventory.ts      Pure inventory helpers
    materialPlan.ts   Read-only material and profession planning
    progression.ts    Monster and resource selection
    world.ts          Game-code to map resolution
    xpRates.ts        Observed combat XP/second
  client/             Typed Result-based Artifacts MMO client
  utils/              Configuration, logging, cooldowns, tasks.json adapter
```

The `tasks/` directory remains transitional. Its `autoHunt` and `autoFarm`
Implementations still combine policy, state, execution, and retry. Their logic
will move incrementally into orchestration and bounded Activities.

## Client

`src/client/index.ts` composes focused functional wrappers around
`openapi-fetch` and the generated `src/client/schema.d.ts`:

- `transport.ts` creates the OpenAPI transport and converts responses to typed
  `ResultAsync` values;
- `middleware.ts` owns authentication and account-wide rate-limit policy;
- `account.ts` owns dynamic character, bank, and log reads;
- `catalog.ts` owns process-lifetime cached game-content reads;
- `actions.ts` owns elementary Action requests and bank-cache invalidation;
- `errors.ts` defines the typed API error payload.

The composed Interface remains the only client dependency used by bot modules.
Every operation returns `ResultAsync`, making failure handling explicit.

The client also owns account-wide request protection:

- paced sliding-window rate limiting for Action and data buckets;
- process-lifetime caching for static catalogs;
- short-lived caching for character logs and bank reads;
- immediate bank-cache invalidation after successful mutations.

## Runtime

`runtime/characterAgent.ts` tracks one character's latest state from Action
responses and waits out cooldowns before sending the next Action. Agents can be
seeded directly from the initial Crew Snapshot, avoiding one duplicate character
read per crew member at startup.

`runtime/activityDispatcher.ts` executes one already-selected bounded Activity
with an existing Character Agent. It dispatches `farmResource` and
`fightMonster` to their existing cycles, plus `craftItem`, `depositItem`,
`equipItem`, and
`withdrawItem` to targeted execution; scheduling, Reservations, retry, and
policy remain outside the dispatcher.

`runtime/activityLauncher.ts` atomically reserves an idle character and starts
one dispatched Activity. It retries failures classified as transient without
releasing the Reservation or invoking policy, then emits a completed, blocked,
or cancelled terminal outcome. Error-to-disposition classification remains an
injected boundary while existing Activities still return their transitional raw
error unions.

`runtime/activityEventProcessor.ts` serializes those terminal outcomes against
the latest shared state. It releases the matching Reservation, preserves Goals
and Blocker details, then refreshes the Crew Snapshot before processing the next
event. A failed refresh keeps the released state and previous snapshot so the
runtime never replays a terminal event against an already-finished Activity.

`runtime/activityScheduler.ts` evaluates one Activity policy against one
snapshot and state, validates the complete proposed plan, then launches each
assignment against the state produced by the preceding start. Whole-plan
validation prevents malformed multi-Activity proposals from starting only a
prefix before discovering a duplicate character or missing Goal.

`runtime/rollingActivityCoordinator.ts` connects scheduling, launching, terminal
processing, and snapshot refresh in one serialized rolling loop. Existing
Activities remain concurrent; each terminal outcome refreshes observation and
re-enters policy with its Blocker details before the next queued outcome is
handled. Snapshot failures classified as retryable wait and retry inside the
same event, so policy never runs on stale observation. Expected and unexpected
asynchronous failures are reported without leaving stale Reservations in
runtime state.

`runtime/crewRuntime.ts` is the concrete Artifacts adapter. It reads the initial
snapshot, seeds Character Agents, dispatches bounded Activities, classifies
transport/server failures for retry, and refreshes observations. Goals, policy,
reporting, and retry timing remain explicit inputs; the adapter does not invent
bank thresholds or autonomous priorities.

`runtime/configuredCrewRuntime.ts` resolves every configured resource and item
against the static catalog before constructing that adapter. For equipment it
walks the static recipe tree, resolves every intermediate item, and accepts a
raw material source only when the catalogs expose exactly one resource or
monster source. Cyclic references stop descending; absent and ambiguous sources
remain unresolved instead of being chosen arbitrarily. The resulting
Goal-to-target mappings feed one pure planner in global priority order. An
unresolved configured target prevents startup rather than allowing a partial
runtime configuration.

`runtime/taskSupervisor.ts` currently supervises long-running tasks with one
`AbortController` per character. Its useful behavior should survive the
migration:

- per-character concurrency;
- failure isolation;
- abort-before-replace ordering;
- unchanged assignments remain untouched.

Its Interface must later accept normal completion of bounded Activities rather
than assuming every assignment runs forever.

## Activities

`activities/activity.ts` defines the initial scheduler-visible work:

```ts
type Activity =
  | { type: 'farmResource'; resourceCode: string }
  | { type: 'fightMonster'; monsterCode: string }
  | { type: 'craftItem'; itemCode: string; quantity: number }
  | { type: 'depositItem'; itemCode: string; quantity: number }
  | { type: 'equipItem'; itemCode: string }
  | { type: 'withdrawItem'; itemCode: string; quantity: number };
```

Activities are operationally bounded workflows, not permanent instructions:

- `farmResource`: currently moves, gathers until full, then banks;
- `fightMonster`: currently moves, fights/rests until full, then banks;
- `craftItem`: validates held inputs, moves to the workshop, and crafts;
- `depositItem`: validates held stock, moves to the bank, and deposits only the
  requested item quantity;
- `equipItem`: replaces the current slot occupant with one held target;
- `withdrawItem`: validates bank stock and inventory room, then retrieves an
  item.

Movement, gathering, fighting, resting, withdrawing, and depositing remain
individual Actions. The current farming and hunting Activities are transitional
super-Activities: they hide storage and delayed re-evaluation behind a full
inventory cycle. The target model separates short gathering/combat chunks from
inventory storage, with an operational action limit and early return on level-up
or full inventory. This keeps policy responsive without refreshing a full Crew
Snapshot after every single Action.

Targeted crafting and equipping
return typed Blockers for missing inputs, insufficient levels, invalid recipes,
and unsupported slots; neither acquires prerequisites recursively. The legacy
`craftAndEquip` workflow remains recursive only for transitional tasks.

## Orchestration model

The target model has two pure decision transitions:

```text
CrewSnapshot + WorldKnowledge + OrchestratorState + GoalPolicy
                              ↓
                 Goal Proposals + next Goals
                              ↓
              proposed Activities + next OrchestratorState
```

Goals remain finite. Autonomous MMO progression is the repeated process of
completing one measurable Goal, observing the result, and automatically
proposing the next useful Goal. The design does not introduce infinite Goals or
manually selected Directives.

### Autonomous Goal policy

`createGoalPolicy` builds the pure Goal Policy from validated strategic
configuration and a registry of named Goal Rules. The resulting `proposeGoals`
function is the policy façade called by orchestration. Its implementation stays
split into three test seams:

1. `discoverGoalCandidates` runs Goal Rules against observed state and world
   knowledge;
2. `rankGoalCandidates` applies configured rule order, then utility and a stable
   deterministic tie-breaker;
3. `selectCompatibleGoals` selects compatible Goal Candidates and produces Goal
   Proposals, excluding conflicts over characters, Reservations, active Goals,
   or shared resources.

Each `GoalCandidate` records its proposed finite Goal, originating Goal Rule,
reason, and optional utility evidence. A selected `GoalProposal` is not an
Activity and performs no game operation; it becomes a persistent Goal only when
accepted into orchestrator state.

`orchestration/goalProposalAcceptance.ts` performs that pure state transition.
It appends autonomous proposals after active Goals, inserts prerequisite Goals
immediately before their preserved parent, rejects missing parents, and treats
an equivalent active Goal as an idempotent no-op. Existing Goal order and
Reservations remain unchanged.

Goal Rules represent strategic opportunity families such as
`equipmentUpgrade`, `combatProgression`, `professionProgression`,
`gatheringProgression`, `bankReplenishment`, and `bankSurplusProcessing`. Their
order belongs in `orchestration.json`, allowing strategy changes without code
changes. A rule may calculate utility within its own family from observed
XP/time, equipment gain, estimated duration, material cost, or future market
cost. Initial policy should use deterministic rule order before adding tunable
weights.

Correctness constraints are evaluated outside configurable rule order. Safety,
Reservation exclusivity, bank quantity protection, one Activity per character,
cooldowns, and irreversible-item protections cannot be demoted by configuration.
Priority tiers are:

1. explicit one-shot human overrides;
2. prerequisite Goals that unblock an already committed Goal;
3. autonomous Goal Proposals ranked by configured Goal Rule order.

The policy expands prerequisite cascades one observed layer at a time rather
than speculating a complete tree. A blocked equipment Goal can propose a finite
profession-level Goal; that Goal can later propose a resource Goal. Completing a
prerequisite resumes its preserved parent Goal. Stable semantic IDs prevent the
same Goal from being proposed twice and persistent Goals prevent policy from
oscillating on every snapshot.

`orchestration/worldKnowledge.ts` reads every static item, monster, and resource
catalog page into deterministic code-sorted collections. The underlying client
caches those static page reads for the process lifetime. This loader is not yet
called by the current explicit-Goal runtime; it becomes an explicit input when
autonomous Goal Policy is wired, avoiding new startup GETs before the data is
used. Recipes are embedded in items, and future market observations can extend
this input without allowing Goal Rules to fetch their own data.

`orchestration/crewSnapshot.ts` reads all characters and every bank page into a
deterministic read-only value. The game has no atomic account-snapshot
endpoint, so `capturedAt` records when both reads completed.

`orchestration/crewPolicy.ts` is currently transitional: it emits existing
`TaskAssignment[]` with `autoHunt` as a baseline. Its first concrete
cross-character rule can assign the strongest eligible gatherer to a fixed
resource until an explicit bank threshold is reached.

`orchestration/orchestratorState.ts` defines crew-level Goals in explicit
priority order and serializable Activity assignments. Each assignment
identifies its Goal, character, Activity, and intended item production or
consumption. Intents include exact quantities when an Activity can know them;
bounded gathering and combat outputs remain unquantified.
becomes a Reservation only after the runtime starts that Activity successfully;
runtime promises and cancellation handles remain outside orchestration state.

`orchestration/resourceReplenishment.ts` completes a satisfied unreserved bank
Goal, avoids work already reserved, excludes busy characters, and otherwise
proposes one `farmResource` Activity for the strongest eligible gatherer.

`orchestration/combatProgression.ts` advances a finite combat-level Goal. It
completes the Goal when the target level is observed, waits for authoritative
Reservations, or selects the highest-level safe monster at or below the
character level. Safety is evaluated at post-rest HP and monster code breaks
equal-level ties deterministically. No safe target is a typed planning error for
a future equipment-prerequisite rule. Until combat Activities are shortened, the
selected `fightMonster` Activity still uses the transitional full hunting cycle.

`orchestration/equipmentProgression.ts` advances an explicit character equipment
Goal through one recursive recipe step at a time. It retrieves banked inputs,
assigns an eligible gatherer or safe fighter for a uniquely sourced raw
material, crafts intermediates in dependency order, crafts the target, equips
it, and then completes the Goal. The target character crafts when eligible;
otherwise the highest-skilled idle crafter performs the step and deposits its
output into
shared storage for the next consumer. The planner subtracts quantities reserved
by in-flight withdrawals from observed bank stock. Replenishment waits for
active withdrawals to settle, while withdrawals proposed in the current pure
decision can trigger parallel replenishment. Matching production already in
flight, busy holders, and busy crafters also cause the Goal to wait.
Profession-level Blockers remain for a later planner layer to turn into
profession progression work.

`orchestration/configuredGoalPlanner.ts` applies both transitions in global
priority order. Proposals act as temporary Reservations during the same
decision, allowing independent targets to use different idle characters without
duplicating in-flight work. Exact catalog targets remain explicit planning
inputs until automatic target selection is designed.

`orchestration/activityLifecycle.ts` owns the pure Reservation transitions. A
successfully started Activity is promoted from a proposal to a Reservation only
if its Goal still exists and its character is idle. A completed, blocked, or
cancelled Activity releases only that character's Reservation while preserving
all Goals for the next snapshot and policy decision. Transient Failures bypass
the terminal transition so the runtime can retry the same reserved Activity.

The final orchestrator will automatically propose finite Goals and emit bounded
Activities instead of `autoXXX` tasks. Persistent Goals survive across several
Activities while Reservations record work already in flight. When a Goal
completes, Goal Policy observes the new frontier and proposes the next milestone,
creating permanent progression without permanent task assignments.

## Rolling scheduling

Scheduling is rolling rather than a global barrier:

1. each character runs at most one Activity;
2. a completed Activity emits one serialized runtime event;
3. the runtime refreshes the shared Crew Snapshot;
4. policy proposes work only for idle characters;
5. in-flight Activities continue uninterrupted;
6. their Reservations participate in policy to prevent duplicate work.

Promises and cancellation handles remain runtime details. Reservations are
plain data so state can eventually be persisted without serializing runtime
objects.

## Failures

Failures are classified by meaning:

- **Transient Failure**: network, rate-limit, or server failure. The runtime
  waits and retries the same Activity because its intent remains valid.
- **Blocker**: a domain precondition prevents progress. The Activity ends, its
  Reservation is removed, its Goal is preserved, and policy selects
  prerequisite work.
- **Cancellation**: shutdown or a future manual override. It is neither a
  failure nor a Blocker.

This avoids both replanning on network noise and retrying impossible work
forever.

## Configuration and manual control

Today, `orchestration.json` is the opt-in crew assignment source. When present,
the entrypoint validates its ordered explicit Goals, resolves every resource and
item, and starts the rolling orchestrator. Goal priority, bank thresholds, and
resource codes must all be explicit; the Adapter supplies no defaults. The file
remains ignored as account-specific runtime configuration.

Its target responsibility is policy rather than per-character assignment. The
migration schema now accepts a validated `policy.goalRuleOrder` alongside
explicit `goals`. Every supported Goal Rule must appear exactly once when policy
is present. The current runtime does not consume that order yet. Optional
`overrides` will later contain finite one-shot Goals. Reordering known rules must
change strategic preference without a code change. Adding a new behavior still
requires a new tested Goal Rule; JSON does not contain executable decision
logic.

Target shape:

```json
{
  "policy": {
    "goalRuleOrder": [
      "equipmentUpgrade",
      "combatProgression",
      "professionProgression",
      "gatheringProgression",
      "bankReplenishment",
      "bankSurplusProcessing"
    ]
  },
  "overrides": []
}
```

Weights and concurrency limits may be added after ordered rules are proven, but
safety and correctness invariants remain outside configuration. Overrides take
precedence, finish normally, and then return control to autonomous policy.

When `orchestration.json` is absent, `tasks.json` remains the transitional human
Adapter and keeps its existing hot-reload behavior. `TaskAssignment` belongs to
the transitional `tasks/` model; `utils/taskAssignments.ts` only validates and
loads its JSON representation. The migration ends by making autonomous
orchestration the default and removing this fallback.

## Persistence

Orchestrator state starts in memory. SQLite is deferred until the bot needs
history, aggregation, or restart continuity that the Artifacts API cannot
provide directly. Introducing persistence later should not change the pure
policy Interface.

## Known structural debt

- Goal Policy foundations and Goal Rule order validation exist, but the runtime
  still executes explicit `orchestration.json` Goals instead of autonomous Goal
  Proposals.
- `tasks/taskRunners.ts` still contains hidden orchestration and persistent
  profession goals.
- `combat.ts` mixes pure safety calculations with combat execution.
- `activities/equipment.ts` still recursively decides how to acquire inputs.
- `runForever.ts` encodes the task model that bounded Activities will replace.
