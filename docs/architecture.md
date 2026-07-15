# Architecture

The bot is moving from long-running per-character `autoXXX` tasks toward a
crew orchestrator that observes shared state and schedules bounded Activities.
See [`../CONTEXT.md`](../CONTEXT.md) for the project vocabulary.

## Principles

- TypeScript ESM, functional and declarative.
- Errors are explicit through `Result`/`ResultAsync`.
- Game Actions stay behind bounded Activities.
- Decisions observe state but do not perform Actions.
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

`src/client/index.ts` wraps `openapi-fetch` against the generated
`src/client/schema.d.ts`. Every operation returns `ResultAsync` and therefore
makes failure handling part of its Interface.

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
with an existing Character Agent. It dispatches `farmResource` and `huntMonster`
to their existing cycles, plus `craftItem` and `equipItem` to targeted execution;
scheduling, Reservations, retry, and policy remain outside the dispatcher.

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

`runtime/configuredCrewRuntime.ts` resolves every configured resource against
the static catalog before constructing that adapter. The resulting Goal-to-
resource mapping feeds a pure multi-Goal replenishment policy. An unresolved
catalog entry prevents startup rather than allowing a partial or ambiguous
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
  | { type: "farmResource"; resourceCode: string }
  | { type: "huntMonster"; monsterCode: string }
  | { type: "craftItem"; itemCode: string; quantity: number }
  | { type: "equipItem"; itemCode: string };
```

Activities are complete operational cycles, not individual game Actions:

- `farmResource`: move, gather until full, then bank;
- `huntMonster`: move, fight/rest until full, then bank;
- `craftItem`: validate held inputs, move to the workshop, and craft;
- `equipItem`: replace the current slot occupant with one held target.

Movement, gathering, fighting, resting, withdrawing, and depositing remain
internal Actions. They are not scheduler-visible Activities.

Farming and hunting expose bounded cycles. Targeted crafting and equipping
return typed Blockers for missing inputs, insufficient levels, invalid recipes,
and unsupported slots; neither acquires prerequisites recursively. The legacy
`craftAndEquip` workflow remains recursive only for transitional tasks.

## Orchestration model

The target decision model is a pure state transition:

```text
CrewSnapshot + OrchestratorState
              ↓
proposed Activities + next OrchestratorState
```

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
consumption. It becomes a Reservation only after the runtime starts that
Activity successfully; runtime promises and cancellation handles remain
outside orchestration state.

`orchestration/resourceReplenishment.ts` provides the first Activity-aware pure
transition. It completes a satisfied unreserved bank Goal, avoids work already
reserved, excludes busy characters, and otherwise proposes one `farmResource`
Activity for the strongest eligible gatherer. The configured planner applies
that transition to every Goal in priority order. Its proposals act as temporary
Reservations during the same decision, allowing independent targets to use
different idle characters without duplicating in-flight work. The exact
resources remain explicit planning inputs until source-selection policy is
designed.

`orchestration/activityLifecycle.ts` owns the pure Reservation transitions. A
successfully started Activity is promoted from a proposal to a Reservation only
if its Goal still exists and its character is idle. A completed, blocked, or
cancelled Activity releases only that character's Reservation while preserving
all Goals for the next snapshot and policy decision. Transient Failures bypass
the terminal transition so the runtime can retry the same reserved Activity.

The final orchestrator will emit Activities instead of `autoXXX` tasks.
Persistent Goals will survive across several Activities while Reservations
record work already in flight.

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

## Manual control

`orchestration.json` is the opt-in crew assignment source. When present, the
entrypoint validates its ordered Goals, resolves every resource, and starts the
rolling orchestrator. Goal priority, bank thresholds, and resource codes must
all be explicit; the Adapter supplies no defaults. The file remains ignored as
account-specific runtime configuration.

When `orchestration.json` is absent, `tasks.json` remains the transitional human
Adapter and keeps its existing hot-reload behavior. `TaskAssignment` belongs to
the transitional `tasks/` model; `utils/taskAssignments.ts` only validates and
loads its JSON representation. The target is autonomous assignment with a
temporary one-shot human override that takes precedence and then returns
control to the orchestrator.

## Persistence

Orchestrator state starts in memory. SQLite is deferred until the bot needs
history, aggregation, or restart continuity that the Artifacts API cannot
provide directly. Introducing persistence later should not change the pure
policy Interface.

## Known structural debt

- `tasks/taskRunners.ts` still contains hidden orchestration and persistent
  profession goals.
- `combat.ts` mixes pure safety calculations with combat execution.
- `activities/equipment.ts` still recursively decides how to acquire inputs.
- `runForever.ts` encodes the task model that bounded Activities will replace.
