# AGENTS.md

Rules for coding agents operating in this repository. This file is the project
index; detailed knowledge lives in the documents below.

## Documentation map

Read the primary document for the area before changing it:

- `CONTEXT.md`: canonical vocabulary for Action, Activity, Goal, Reservation,
  Blocker, Transient Failure, and orchestration.
- `docs/architecture.md`: module responsibilities, dependency direction, and
  the target orchestration model.
- `docs/roadmap.md`: migration status and intended sequencing. Roadmap items
  provide context, not authorization for unrelated work.
- `docs/runbook.md`: runtime operation, diagnostics, rate limits, mutation
  testing, and live-check safety.
- `README.md` and `package.json`: setup and supported commands.

## Scope and safety

Agents provide local development help: investigate, propose, implement,
validate, and summarize changes for human review.

- Do not push or open pull requests.
- Do not commit unless the user explicitly requests it.
- Do not expose tokens, secrets, or account-specific data.
- Do not invent Artifacts API contracts, domain policies, thresholds, or
  irreversible behavior.
- Internal implementation types are allowed when they directly support the
  requested behavior and respect the documented architecture.
- Do not remove or weaken tests to make code pass.
- Do not introduce dependencies without a concrete justification.
- Follow `docs/architecture.md`; do not introduce competing architectural
  patterns.

For non-trivial changes, give a short plan first. Keep changes focused on the
request, address root causes, validate the affected scope, and summarize the
result. Update documentation when a change alters documented vocabulary,
behavior, module responsibilities, or operational guidance.

## Architecture and vocabulary

- An **Action** is one elementary operation sent to Artifacts MMO.
- An **Activity** is a bounded workflow composed of Actions.
- Orchestration observes `CrewSnapshot` plus state and proposes Activities; it
  does not perform Actions.
- Runtime executes, retries, schedules, and cancels; it does not own policy.
- Keep orchestration decisions deterministic and pure where practical.
- Prefer observed live game state over duplicated local state.
- Expected API, transport, and domain failures use typed
  `Result`/`ResultAsync` values. Typed `Error` subclasses may be error payloads.
- Follow `CONTEXT.md` and `docs/architecture.md` when distinguishing Blockers,
  Transient Failures, and Cancellation.
- `src/bot/tasks/` is transitional. Fix it when required, but do not deepen the
  forever-task or `autoXXX` model when new behavior belongs in Activities or
  orchestration.

## TypeScript and code style

- Use TypeScript for source, tests, and scripts. Generated declarations and
  tool-required configuration formats are exceptions.
- The repository uses ESM with `NodeNext` resolution.
- Include `.js` extensions in relative TypeScript imports.
- Prefer `type` over `interface` in handwritten code. Generated declarations
  are exempt.
- Use `import type` when an import is used only as a type.
- Prefer arrow functions and pure functions.
- Prefer functional, declarative TypeScript. Avoid classes except typed
  `Error` subclasses.
- Use guard clauses and early returns for error handling.
- Use braces in conditionals except for readable ternaries.
- Use named exports in application modules. Tool configuration may use a
  required default export.
- Do not create re-export-only barrel modules. An `index.ts` containing real
  implementation is not a barrel.
- Use camelCase directory and file names, except established documentation and
  tool-convention files.
- Keep object keys alphabetical when order has no semantic meaning. Preserve
  protocol or domain ordering when it improves clarity.
- Use descriptive names, including auxiliary verbs such as `isLoading` and
  `hasError` for state.
- Avoid speculative abstractions. Extract shared logic, or extract when doing
  so creates a clear domain seam, pure decision seam, or meaningful test seam.

## Dependencies and generated code

- Prefer existing dependencies and established project patterns.
- Use Valibot for runtime validation and date-fns for date calculations.
- Do not substitute competing libraries without a justified dependency
  change.
- Never edit `src/client/schema.d.ts` directly.
- Regenerate API declarations with `pnpm generate:api-types` and review the
  generated diff.

## Tests and validation

Use `package.json` scripts instead of invoking `tsc`, `vitest`, `oxlint`,
`oxfmt`, `tsx`, Stryker, or other underlying binaries directly.

Run checks appropriate to the changed scope:

- source changes normally require `pnpm format`, `pnpm type-check`,
  `pnpm lint`, and relevant tests;
- documentation-only changes require at least `pnpm format:check` and link or
  reference validation where applicable;
- OpenAPI regeneration requires type-checking and tests after reviewing the
  generated diff.

Tests must not make uncontrolled live network calls. Use MSW for HTTP behavior.
Live checks require explicit need and must follow `docs/runbook.md`.

Whenever tests are added, run scoped mutation testing for each source file
whose behavior the new tests cover, using
`pnpm test:mutation --mutate <source-file>`. Use the full mutation suite only
when the changed scope justifies it.

Mutation testing measures contract strength, not progress toward an artificial
100% score. Add tests for meaningful surviving mutants, not equivalent or
implementation-only mutants.

Do not claim validation passed unless the command was run successfully. If a
failure is unrelated to the change, report it rather than hiding or fixing it
without scope.

## Commit style

When the user requests commits:

- use focused conventional commits, such as `feat: add activity scheduling`;
- prefer intermediate commits when the user asks for them;
- keep the title clear and concise;
- explain what changed and why in the body;
- wrap commit body lines at 72 characters or fewer;
- do not push after committing.

## Priority

Correctness > readability > maintainability > performance.
