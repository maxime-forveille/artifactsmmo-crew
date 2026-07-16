# Artifacts MMO Bot

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
_Avoid_: Action, strategy, forever task

**Crew Snapshot**:
A read-only observation of every character and the shared bank, captured for
one orchestration decision without duplicating the game as local state.
_Avoid_: Character cache, local game state

**Goal**:
A desired outcome that may persist across several activities, such as unlocking
a profession level, equipping an upgrade, or replenishing a bank resource.
_Avoid_: Activity, task

**Orchestrator**:
The decision module that combines a crew snapshot with persistent goals and
proposes bounded activities; it never performs game actions directly.
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
