---
date: 2026-09-19
topic: jev-decision-tree-sdk
---

# Jev Decision and Tree SDK

## Summary

Create a Jev-only TypeScript SDK for typed routing, decision programs, and bounded construction of validated formal trees. `jev-code` will use the same public contracts and will remove every LLM generation, proposal, mapping, and provider-setup path.

---

## Problem Frame

Jev supplies typed choices, probabilities, and scores, but complex consumers must currently build their own orchestration, budgets, cancellation, dependency ordering, tree traversal, validation, and event streams. `jev-code` contains working versions of these ideas, but they are coupled to a coding harness rather than presented as a coherent reusable library.

The experiment with LLM-produced code chunks obscures the distinctive product. This project is a Jev decision harness: every uncertain branch is a bounded Jev decision over alternatives supplied by deterministic host code. General-purpose formal tree construction—not LLM generation—is the reusable center. Code and shell ASTs are reference applications of that model.

---

## Actors

- A1. SDK consumer: Defines typed routers, decision programs, or formal tree grammars.
- A2. Host application: Supplies input, finite alternatives, validators, and any effects performed after a decision.
- A3. Jev decision provider: Selects among offered alternatives and returns typed decision metadata.
- A4. `jev-code`: Proves the public SDK against coding actions and constrained AST construction.

---

## Key Flows

- F1. **Typed routing:** A host offers finite typed routes, Jev selects one, and the SDK returns the route plus metadata without executing its handler.
- F2. **Decision program:** A host composes sequential, parallel, and data-dependent decisions; the runtime enforces shared limits and returns a typed outcome.
- F3. **Formal tree construction:** A grammar exposes valid productions for a pending slot; Jev selects one; the runtime expands child slots, validates the completed tree, and stops within node/depth/request bounds.
- F4. **Jev Code dogfooding:** `jev-code` routes actions and builds code/command trees through public SDK contracts, then retains application-owned permissions and effects.

---

## Requirements

**Jev-only authority**

- R1. Every uncertain selection must be made by Jev from a finite set of host-supplied alternatives.
- R2. The project must contain no LLM candidate producer, `propose` tool, program mapper, action mapper, generation-provider configuration, OAuth/API-key setup for generation providers, or documentation advertising those features.
- R3. The SDK must not define an LLM/provider abstraction other than the Jev decision-provider boundary supplied by `@typesafe-ai/sdk`.
- R4. Deterministic host logic may validate, eliminate, or auto-resolve a structurally forced singleton, but it may not make a semantic choice that belongs to Jev.

**Decision programs**

- R5. The SDK must expose typed routers and immutable typed programs with typed input and output.
- R6. Programs must support sequential transformation, bounded parallel composition, and data-dependent continuation.
- R7. Program definitions must be concurrently reusable; each run owns isolated state while nested work shares run budgets and cancellation.
- R8. Runs must return discriminated completed, failed, invalid, cancelled, and exhausted outcomes.
- R9. Runs must emit versioned, monotonically ordered, bounded events suitable for logs, UI, and host persistence.

**Formal tree construction**

- R10. The SDK must let consumers define a domain-neutral formal tree grammar made of named slots and finite productions.
- R11. A production may complete a slot with a typed node or introduce typed child slots whose results are assembled into a parent node.
- R12. The tree runtime must expose only structurally valid productions, ask Jev to choose among semantic alternatives, and validate every completed node and final tree.
- R13. Independent child slots may expand concurrently while sharing request, node, depth, time, and concurrency limits.
- R14. Invalid grammars, duplicate identities, cycles, missing dependencies, depth overflow, and node exhaustion must fail clearly without presenting a partial tree as complete.
- R15. Tree definitions and events must remain domain-neutral; source code, files, paths, commands, and language-specific node kinds belong to consumers.

**Host boundary and testing**

- R16. The SDK must not own filesystem, shell, network, authorization, credentials, UI, persistence, or application completion semantics.
- R17. Deterministic Jev providers must make routers, programs, and trees fully testable without network access.
- R18. Decision results must expose selected values and normalized metadata without leaking raw provider responses.

**Reference application and distribution**

- R19. `jev-code` must use public SDK contracts for action routing and at least one real AST/command tree construction path.
- R20. Existing permissions, workspace policy, journals, replay, CLI rendering, budgets, cancellation, and no-partial-write guarantees must remain application behavior.
- R21. The package must expose a deliberate ESM public API with declarations and packed-artifact tests; unrelated implementation modules must not become public accidentally.
- R22. Documentation must include a small typed router, a non-code tree, and the `jev-code` tree integration.

---

## Acceptance Examples

- AE1. **Covers R1, R5, R18.** A three-route ticket router returns one typed Jev-selected route and metadata but never invokes the route handler.
- AE2. **Covers R6-R9.** Two independent child programs run within one concurrency limit; their dependent continuation waits for both and all events have increasing sequence numbers.
- AE3. **Covers R10-R14.** A menu grammar expands categories and items into a validated tree; invalid productions are absent before Jev chooses, and node/depth limits prevent unbounded expansion.
- AE4. **Covers R11-R13.** A selected parent production introduces two child slots, they expand concurrently, and their typed results assemble into the parent.
- AE5. **Covers R8, R14.** A final tree validator rejects the assembly and the run returns non-completed evidence without a completed value.
- AE6. **Covers R2-R3.** Repository and packed-package searches contain no generation-provider, proposal, mapper, or LLM-facing public feature.
- AE7. **Covers R17.** Router and tree tests run entirely with a deterministic local Jev provider.
- AE8. **Covers R19-R20.** `jev-code` selects an action through the SDK, then its existing authorization layer can deny execution; a real AST path builds through the public tree contract before the application writes anything.

---

## Success Criteria

- A useful typed router fits in roughly one screen of TypeScript.
- A non-code example demonstrates recursive, validated, data-dependent tree construction.
- `jev-code` contains no optional LLM generation feature or setup surface.
- At least one production `jev-code` AST/command builder consumes the public tree API rather than a private duplicate.
- All SDK behavior is testable with deterministic providers and all existing non-LLM CLI behavior remains green.
- The packed tarball supports documented ESM imports and declaration consumers without loading UI modules.

---

## Scope Boundaries

### Deferred for later

- Persistent/resumable tree runs and cross-process scheduling.
- Interactive graph visualization beyond the event stream.
- Additional convenience grammars after the core tree contract is proven.
- Actual npm publication pending owner-controlled package naming and license decisions.

### Outside this product's identity

- LLM-powered generation, proposal, mapping, judging, or recovery.
- A general-purpose agent framework that owns tools, memory, permissions, or effects.
- A hosted workflow/model service or credential manager.
- A universal parser generator; the SDK selects among consumer-defined productions but does not parse grammar notation.
- Coding-specific AST definitions as core SDK concepts.

---

## Key Decisions

- Jev-only is a product boundary, not a default mode: LLM generation support is deleted rather than retained behind flags.
- Typed decision programs are the orchestration layer; formal tree construction is the main reusable higher-level capability.
- Tree grammars expose finite valid productions one slot at a time; Jev supplies semantic policy while deterministic code guarantees structural validity.
- Effects remain with hosts, making the same kernel suitable for routers, configuration trees, plans, code ASTs, and command trees.
- `jev-code` dogfooding is mandatory so the public contracts are shaped by a demanding real application.

---

## Dependencies / Assumptions

- The initial audience is TypeScript/Node.js developers building complex applications with Jev.
- `@typesafe-ai/sdk` remains the only model dependency.
- Existing hand-written Python, Bash, and shared-language AST builders provide migration patterns and behavioral baselines.
- Program and tree definitions can keep rich typed values locally while projecting JSON-safe context to Jev.

---

## Outstanding Questions

### Deferred to Planning

- Select the smallest tree grammar API that preserves TypeScript inference for recursive child slots.
- Choose the first `jev-code` AST/command builder to migrate with the lowest compatibility risk.
- Decide whether the existing package root or a dedicated subpath best communicates the SDK contract without a package split.
