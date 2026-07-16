# Artifacts MMO Crew

This context coordinates an autonomous crew while keeping game operations,
bounded execution, and cross-character decisions distinct.

## Language

**Action**:
One elementary operation accepted by Artifacts MMO, such as moving, gathering,
fighting, crafting, resting, or using the bank.
_Avoid_: Activity, task

**Activity**:
A bounded workflow composed of one or more actions, executed for one character
before the orchestrator observes the crew again and chooses what comes next.
Combat is the domain family; `fightMonster` is its target Activity name. `hunt`
is reserved for transitional tasks and cycles that repeatedly fight and bank.
_Avoid_: Action, strategy, forever task

**Crew Snapshot**:
A read-only observation of every character and the shared bank, captured for
one orchestration decision without duplicating the game as local state.
_Avoid_: Character cache, local game state

**Goal**:
A finite desired outcome with an observable completion condition that may
persist across several activities, such as reaching a specific profession
level, equipping an upgrade, or replenishing a bank resource to a threshold.
Permanent MMO progression emerges by automatically proposing the next finite
Goal after one completes; it is not represented as an infinite Goal or a
manually selected Directive.
_Avoid_: Activity, task, permanent mode

**Goal Rule**:
A named pure decision rule that discovers zero or more Goal Candidates from
observed state and world knowledge, such as `equipmentUpgrade` or
`combatProgression`. Rule order is strategic configuration; safety and
correctness invariants are not Goal Rules and cannot be reordered.
_Avoid_: Task type, Activity dispatcher

**Goal Candidate**:
A possible finite Goal discovered by a Goal Rule, together with its reason and
optional utility evidence. It has not yet been selected or persisted.
_Avoid_: Goal, Reservation

**Goal Proposal**:
A Goal Candidate selected by policy as compatible with current Goals,
Reservations, characters, and shared resources. A proposal becomes an Active
Goal when accepted into orchestrator state.
_Avoid_: Activity proposal, Reservation

**Active Goal**:
An accepted finite Goal enriched with durable orchestration metadata: origin,
priority through state ordering, and for autonomous work its Goal Rule, reason,
and optional parent relationship. It persists across Activities and restarts.
_Avoid_: Goal Proposal, Reservation

**Goal Policy**:
The pure decision boundary built by `createGoalPolicy` and invoked as
`proposeGoals`. It discovers Goal Candidates, applies configured strategic
priority, ranks utility within each rule, and selects compatible Goal Candidates
to produce Goal Proposals. It never performs Actions or plans Activity execution
details.
_Avoid_: Directive, task supervisor, Activity planner

**Orchestrator**:
The decision module that combines a crew snapshot, world knowledge, persistent
Goals, Reservations, and Goal Policy. It proposes finite Goals and bounded
Activities; it never performs game Actions directly.
_Avoid_: Task runner, activity executor

**Reservation**:
A plain-data record of an activity already running for a character, including
what it intends to produce or consume and exact quantities when they are known,
so another decision does not duplicate or over-allocate that work.
_Avoid_: Running promise, lock

**Blocker**:
A domain reason an activity cannot advance its goal, returned to the
orchestrator so it can preserve the goal and choose prerequisite work.
_Avoid_: Transient error, retry

**Transient Failure**:
A transport, rate-limit, or server failure that leaves the selected activity
valid and is retried by the runtime without invoking policy again.
_Avoid_: Blocker, activity outcome
