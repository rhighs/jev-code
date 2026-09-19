---
title: "feat: Add Jev decision and tree SDK"
type: feat
status: completed
date: 2026-09-19
topic: typed-decision-sdk
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
origin: docs/brainstorms/2026-09-19-typed-decision-program-sdk-requirements.md
---

# feat: Add Jev decision and tree SDK

## Summary

Build a Jev-only public runtime for typed routing, composable decision programs, and validated formal tree construction. Delete all LLM proposal/mapping/provider functionality, migrate `jev-code` action routing and one real AST path to public SDK contracts, then validate the packed ESM/declaration surface.

---

## Assumptions

- Keep the existing ESM Node 22+ package and root SDK entry for v1; do not create an unverified npm scope.
- Keep the completed public decision-session work and in-progress program algebra because both are Jev-only.
- Model trees as typed slots with finite productions; a production either completes a slot or introduces child slots and a deterministic assembler.
- A single structurally valid production may resolve without Jev; two or more semantic alternatives always require Jev.
- Actual npm publication remains deferred; this work produces and tests a publishable tarball.

---

## Requirements

- R1. Public typed decision session, router, and immutable program algebra use Jev as the sole policy model.
- R2. Public formal-tree runtime supports typed slots, finite productions, child dependencies, validation, bounded parallel expansion, and exhaustive outcomes/events.
- R3. Remove generation providers, provider setup, `propose`, program/action mapping, related config, tests, docs, and CLI commands.
- R4. Preserve application-owned tools, permissions, workspace policy, journals, replay, UI, and completion behavior.
- R5. Dogfood the public router for harness actions and the public tree API in at least one real AST/command builder.
- R6. Expose intentional ESM declarations and verify clean packed-package consumers.
- R7. Preserve all remaining CLI and SDK tests under Node 24 and supported Node 22 behavior.

---

## Scope Boundaries

### Deferred for later

- Persistence/resume, distributed scheduling, graph debugger, additional grammar migrations, and npm publication.

### Outside this product's identity

- Any LLM generation, proposal, mapping, recovery, provider configuration, or candidate-production abstraction.
- SDK-owned effects, agent memory, permissions, filesystem, shell, UI, or credentials.

---

## Key Technical Decisions

- **Program algebra:** immutable `value`, `map`, bounded parallel composition, and data-dependent continuation provide typed dependency structure.
- **Tree grammar:** consumers expose named slots and finite productions; the runtime recursively expands selected productions and deterministically assembles validated nodes.
- **Run isolation:** definitions are reusable; every run owns values/events while nested work shares counters, deadline, cancellation, and concurrency.
- **Separate events:** SDK events remain domain-neutral and bridge into existing harness events without replacing journal schema.
- **Hard deletion of LLM surfaces:** remove code and documentation instead of maintaining disabled compatibility paths.

---

## Implementation Units

### U1. Public Jev decision session and run resources

**Goal:** Finish and verify the current extraction of strict Jev decisions, typed metadata, shared budgets, cancellation, and compatibility facade.

**Files:** `src/sdk/types.ts`, `src/sdk/resources.ts`, `src/sdk/decisions.ts`, `src/decisions.ts`, `src/types.ts`, `test/sdk-decisions.test.ts`, existing decision/harness tests.

**Test scenarios:** exact response validation; choice/probability/score metadata; shared budget races; cancellation/deadline distinction; compatibility event/request counts.

### U2. Typed program runtime

**Goal:** Finish immutable typed composition, isolated runs, program outcomes, ordered events, final validation, and bounded parallel/data-dependent execution.

**Dependencies:** U1

**Files:** `src/sdk/program.ts`, SDK types/resources/index, `test/sdk-program.test.ts`.

**Test scenarios:** static mapping; typed parallel tuple; dynamic continuation; fresh concurrent runs; node/depth/request exhaustion; sibling cancellation; one terminal event; failed final validation.

### U3. General-purpose formal tree construction and router

**Goal:** Add a concise router and domain-neutral slot/production tree runtime on top of the Jev session/program resources.

**Dependencies:** U1, U2

**Files:** create `src/sdk/router.ts`, `src/sdk/tree.ts`, `test/sdk-router.test.ts`, `test/sdk-tree.test.ts`; modify SDK exports.

**Approach:** Tree slots expose finite typed productions. Selected productions either return a validated node or define typed child slots plus an assembler. Independent children expand concurrently; depth/node/request limits and final validation prevent partial completion.

**Test scenarios:** three-route typed selection; singleton structural resolution; recursive non-code tree; parallel children; invalid production filtering; duplicate/cycle/depth/node failures; deterministic provider; rejected final tree.

### U4. Remove all LLM-powered surfaces

**Goal:** Return `jev-code` to a Jev-only harness with no generation-provider or proposal machinery.

**Dependencies:** U1

**Files:** delete `src/providers/`, `src/propose/`, `src/program-map.ts`, `src/action-map.ts` and their dedicated tests; modify `src/harness.ts`, `src/generation.ts`, `src/cli.ts`, `src/config.ts`, `src/index.ts`, `package.json`, `README.md`, `docs/guide.md`, remaining fixtures/tests.

**Approach:** Remove configuration and CLI provider flows, mapper/proposal options and budgets, mapped recovery, proposal tool registration, and documentation. Keep Jev-native AST, structured-text, and grid fallback generation paths.

**Test scenarios:** CLI rejects removed provider/proposal options; harness retains Jev-only action/tool loop; code/command generation still runs with deterministic Jev; repository search finds no live LLM feature references; no removed module leaks through declarations.

### U5. Dogfood router and tree in `jev-code`

**Goal:** Use public SDK contracts for action routing and one production AST/command construction path without moving effects into the SDK.

**Dependencies:** U2, U3, U4

**Files:** modify `src/harness.ts` and the selected AST/command builder; update corresponding harness, AST, event-baseline, permission, and cancellation tests.

**Approach:** The harness passes its existing decision session into the public router, then retains authorization/execution. Migrate the lowest-risk real tree builder (prefer Bash or shared core after execution-time inspection) through the public tree grammar while preserving rendered output and validators.

**Test scenarios:** action routing through SDK then allow/deny; same request counts/statuses; real tree output unchanged; shared cancellation/budgets; invalid/exhausted tree never reaches a write or shell effect.

### U6. Examples, documentation, and package contract

**Goal:** Document the Jev-only SDK identity and prove public imports from the packed artifact.

**Dependencies:** U3-U5

**Files:** create `examples/router.ts`, `examples/dependency-tree.ts`, `docs/sdk.md`, package consumer fixtures/tests; modify `README.md`, `docs/guide.md`, `src/index.ts`, `package.json`, `tsconfig.json`, CI.

**Test scenarios:** examples use only public exports; root ESM import avoids UI; declarations typecheck under NodeNext and bundler resolution; deep imports fail; CLI binary remains executable; tarball excludes source tests/config/credentials.

---

## Risks & Mitigations

- **Tree API loses type inference:** use opaque generic slot/production values and compile-time fixtures.
- **Deletion breaks unrelated CLI paths:** remove in vertical slices and run focused harness/CLI tests after each surface.
- **Dogfood changes request counts:** keep one shared decision session and characterize counts before migration.
- **Event/replay regression:** bridge SDK events; do not replace existing journal event types.
- **Accidental LLM remnants:** repository-wide semantic search plus package declaration/tarball inspection.
- **Public API leaks internals:** explicit root exports and clean-consumer tests.

---

## Verification

- Typecheck, build, and all remaining tests pass under Node 24; package compatibility also runs on Node 22.
- Repository and generated-declaration searches contain no LLM generation/provider/proposal/mapping feature surface.
- Router and non-code recursive tree examples run with deterministic Jev providers.
- `jev-code` action routing and one AST/command tree use public SDK APIs while permissions and effects remain application-owned.
- Packed tarball passes ESM runtime, declaration consumer, CLI binary, and blocked-deep-import checks.

---

## Sources & References

- Origin: `docs/brainstorms/2026-09-19-typed-decision-program-sdk-requirements.md`
- Existing runtime: `src/decisions.ts`, `src/harness.ts`, `src/python-ast.ts`, `src/bash-ast.ts`, `src/lang/core.ts`
- Compatibility: `test/events-baseline.test.ts`, `test/harness.test.ts`, `test/python-ast.test.ts`
