# AGENTS.md

Rules for AI agents operating in this repository. This root file is the **index**.

## Agent profile

Senior TypeScript full-stack engineer specialised in Node.js, Scripting.

## Scope and behaviour

Agents in this repo are for **local development help only** — propose, implement, run tests / lint / type-check, and stop there. The human reviews the diff and commits.

Do not:

- push, or open PRs.
- Invent APIs, data models, or behaviours not described in the task.
- Remove or weaken tests to make code pass.
- Introduce new dependencies without justification.
- Change architectural patterns without explicit instruction.

For non-trivial changes: short plan first, then implement, then run tests / format / type-check, then summarise what changed.

## Core principles

- Concise, technical TypeScript. Functional and declarative; avoid classes.
- Favour iteration and modularisation over duplication; factorise only when shared by ≥2 consumers.
- Descriptive names with auxiliary verbs (`isLoading`, `hasError`).
- Guard clauses and early returns for error handling.
- Optimise for readability and maintainability.

## TypeScript

- TypeScript everywhere. Repo is ESM (`"type": "module"`).
- Prefer `type` over `interface`.
- Prefer arrow functions and pure functions.
- Curly braces in conditionals (except ternaries). One-liners only when highly readable.
- No barrel files (`index.ts` that re-exports).

## Architecture

pnpm repository.

Validation: valibot (functional, tree-shakeable API — `v.object()`/`v.pipe()`/`v.safeParse()` as plain functions rather than zod's method-chained builder — and a much smaller bundle; chosen over zod for the same "avoid classes"/functional-first reasoning). Dates: date-fns (pure functions over native `Date`; avoid class-based date libraries like luxon/moment to stay consistent with "avoid classes"). Temporal is not used yet: not natively available in Node 24 without `--experimental-temporal` or a polyfill dependency — revisit once it ships stable.

## Code style

- Named exports.
- camelCase directories and files (e.g., `userService.ts`).
- Sort object keys and props alphabetically.

## Commit style

- Use conventional commits (e.g., `feat: add user service`).
- Commit title should be clear and concise.
- Commit body should explain what changed and why.

## Priority

Correctness > readability > maintainability > performance.
