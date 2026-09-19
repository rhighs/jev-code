# Jev TypeScript SDK

`jev-code` is a Jev-only TypeScript SDK for bounded decisions. Applications define the alternatives and own every effect. Jev selects among those alternatives; it does not write source text, invent tree nodes, run tools, or manage permissions.

The public package entry point provides four layers:

- `DecisionSession` validates typed Jev choices, probabilities, and scores while tracking shared limits, cancellation, deadlines, and usage.
- `Router` selects one application-defined route and returns its typed value without executing it.
- `DecisionProgram` composes immutable decision work with deterministic transforms, dependent continuation, and bounded parallelism. The `Program` type remains the language-AST shape from 0.1.x.
- The tree API expands typed slots from finite productions, resolves independent children in parallel, assembles nodes deterministically, and validates the completed value.

The coding harness and `jev-code` CLI remain available from the same package. They are applications of these public decision contracts, not prerequisites for using the SDK.

## Install

The package requires Node.js 22 or newer and is ESM-only. npm publication is not part of the current release process; from a source checkout, build with pnpm. The final two npm commands deliberately exercise npm tarball interoperability:

```bash
pnpm install --frozen-lockfile
pnpm run build
npm pack
npm install /path/to/jev-code-0.2.0.tgz
```

Import only from the package root. Internal paths such as `jev-code/sdk/router.js` are intentionally not exported.

## Provide Jev decisions

`DecisionProvider` is the only model boundary. The included `JevProvider` connects to typesafe.ai; tests can inject a deterministic implementation with the same interface.

```typescript
import { DecisionSession, JevProvider } from 'jev-code';

const decisions = new DecisionSession(new JevProvider(), {
  limits: { decisions: 8 },
  timeoutMs: 10_000,
});

const result = await decisions.choose(
  { ticket: { subject: 'Refund for duplicate charge' } },
  'Choose the team that owns this ticket.',
  {
    billing: 'Invoices, charges, and refunds',
    account: 'Sign-in and account access',
    product: 'Using product features',
  },
);

console.log(result.value, result.metadata.confidence);
```

Decision state must be JSON-compatible. Responses are checked for the exact answer shape, valid labels, normalized distributions, finite usage counts, and the expected answer keys. Invalid or failed responses reject with `DecisionError` and structured evidence.

`DecisionSession.fork()` shares limits, usage, deadline, and concurrency with the parent session. Use it to isolate cancellation for sibling work without creating a fresh request budget.
Decision observers use the same `eventTimeoutMs` policy as program observers (5 seconds by default) and are raced against session cancellation and deadlines.

## Route typed values

A router contains two to 255 named routes. Route values are returned as data and never invoked by the router, so the application remains responsible for authorization and effects.

```typescript
import { DecisionSession, defineRouter, route } from 'jev-code';

const router = defineRouter({
  inspect: route('Read project state without changing it', { effect: 'read' } as const),
  modify: route('Change project files', { effect: 'write' } as const),
  verify: route('Run a check without changing files', { effect: 'execute' } as const),
});

const selected = await router.select(
  decisions,
  { task: 'Run the unit tests' },
  'Choose the next application action.',
);

// Authorize and execute selected.value in application code.
console.log(selected.key, selected.value.effect);
```

`router.program(id, instructions, state)` embeds the same selection in a `DecisionProgram` and uses that run's shared decision resources.

See [`examples/router.ts`](../examples/router.ts) for an executable deterministic example.

## Compose decision programs

Decision programs are reusable immutable definitions. Every call to `runProgram` gets isolated values and events while sharing one bounded resource scope within that run.

```typescript
import { DecisionProgram, fromInput, node, parallel, runProgram, value } from 'jev-code';

const region = value<{ service: string }, string>('default-region', 'us-east');
const typed: DecisionProgram<{ service: string }, string> = region;
const service = fromInput<{ service: string }, string>('service-name', input => input.service);
const checks = parallel('checks', [
  node<{ service: string }, boolean>('healthy', async ({ input }) => input.service.length > 0),
  node<{ service: string }, boolean>('named', async ({ input }) => !input.service.includes(' ')),
]);

const program = parallel('deployment-inputs', [region, service, checks])
  .map('deployment', ([selectedRegion, serviceName, passed]) => ({ selectedRegion, serviceName, ready: passed.every(Boolean) }));

const outcome = await runProgram(program, { service: 'api' }, {
  concurrency: 2,
  limits: { nodes: 16 },
  validate: (result, { signal }) => !signal.aborted && result.ready || 'Deployment checks failed.',
});
```

Use `value` for constants (including function values) and `fromInput` for concise input-derived nodes. Use `map` for deterministic transforms and `flatMap` for data-dependent program structure. `parallel` requires children with a compatible input type, preserves result order, and respects the run's concurrency bound. Outcomes are exhaustive: `completed`, `failed`, `invalid`, `cancelled`, or `exhausted`. Each outcome includes ordered run metadata and one terminal event. Runs default to 10,000 nodes, depth 256, and 10,000 retained events, so decision-free dynamic expansion and metadata cannot grow without bound.

Pass either `provider` or `session` to a program or tree run, never both. A supplied session shares its private run accounting with the run; program contexts expose only the read-only `ProgramResourceView`.

## Build validated formal trees

A tree grammar consists of named `slot` values. Each slot has finite `complete` or `branch` productions:

- `complete` builds a value for that slot.
- `branch` names child slots and deterministically assembles their values.
- A `branch` may receive a child factory instead of a child record. The runtime calls that factory only after Jev selects the production, so recursive and input-dependent grammars do not construct unselected subtrees.
- `valid` filters a production from the available choices for an input.
- `validate` checks a completed slot value.

When one production is structurally available, the runtime resolves it without a Jev request. When two or more productions remain, Jev chooses among their IDs and descriptions. Independent branch children run concurrently.

```typescript
import { branch, complete, runTree, slot } from 'jev-code';

const host = slot<{ replicas: number }, string>({
  id: 'host',
  description: 'Host placement',
  productions: [
    complete('east', 'Place in the east region', () => 'east'),
    complete('west', 'Place in the west region', () => 'west'),
  ],
});

const count = slot<{ replicas: number }, number>({
  id: 'count',
  description: 'Replica count',
  productions: [complete('requested', 'Use the requested count', ({ input }) => input.replicas)],
  validate: value => value > 0 || 'Replica count must be positive.',
});

const deployment = slot<{ replicas: number }, { host: string; count: number }>({
  id: 'deployment',
  description: 'Deployment specification',
  productions: [branch('pair', 'Combine placement and count', { host, count }, children => children)],
});

const outcome = await runTree(deployment, { replicas: 3 }, {
  provider,
  concurrency: 2,
  maxDepth: 4,
  limits: { decisions: 4, nodes: 16 },
});
```

Static grammar edges are checked iteratively before execution for empty IDs, duplicate slot identities, duplicate production IDs, missing children, and cycles. `maxStaticSlots` and `maxStaticEdges` (10,000 each by default) bound that preflight without relying on the JavaScript call stack. Lazy children receive the active `ProductionContext`, then are checked for the same duplicate, cycle, and missing-dependency errors when their selected production admits them. A failed child, node validator, final validator, depth bound, or resource limit never returns a partial tree.

See [`examples/dependency-tree.ts`](../examples/dependency-tree.ts) for an executable non-code dependency tree.

The coding application dogfoods this API in `generateBashAst`: plan selection, program productions, recursive argument lists, connectors, redirects, and final `BashAst` assembly are tree slots and branch assemblers. Candidate derivation, request-size checks, and progress rendering remain application helpers; semantic choices are dispatched only by `runTree`.

## Limits, cancellation, and events

`DecisionSession`, `runProgram`, and `runTree` accept an `AbortSignal`, timeout, concurrency bound, and resource limits. Program and tree runs can bound `decisions` and `nodes`; the compatibility harness also reports its application-specific counters through the same resource snapshot.

```typescript
const controller = new AbortController();

const outcome = await runTree(root, input, {
  provider,
  signal: controller.signal,
  timeoutMs: 5_000,
  concurrency: 4,
  limits: { decisions: 32, nodes: 128 },
  maxRetainedEvents: 2_000,
  onEvent: event => console.log(event.sequence, event.type),
});
```

Caller cancellation produces `cancelled`; a deadline or consumed SDK resource limit produces `exhausted` with structured evidence. Validators receive the active signal and read-only resources. Event observers are delivered serially with backpressure. A rejected non-terminal observer fails the run, and each delivery is bounded by `eventTimeoutMs` (5 seconds by default) and raced against cancellation so an observer cannot prevent settlement. A terminal observer is called exactly once; rejection or timeout is reported as `metadata.observerFailure` without changing the underlying outcome or attempting a second terminal callback. Retained events remain ordered by `sequence`; `metadata.droppedEvents` reports earlier events omitted from the bounded tail.

## Package contract

The supported import is:

```typescript
import { DecisionProgram, DecisionSession, defineRouter, runProgram, runTree, type Program } from 'jev-code';
```

The package ships ESM JavaScript and declarations from `dist/`, the CLI binary, this SDK guide, and the two public examples. It does not ship source tests, repository configuration, local environment files, or credentials. Package contract tests install the generated tarball into clean consumers and verify runtime import, NodeNext and bundler declaration resolution, CLI execution, blocked deep imports, and the tarball allowlist under supported Node versions.

## CLI and harness

The package also exports `Harness`, `JevProvider`, the built-in tools, and AST helpers used by the coding application. Application hosts retain responsibility for tool registration, authorization, workspace policy, and execution. See the [CLI and harness guide](guide.md) for interactive sessions, journals, adapters, and command-line usage.

## Migrating from 0.1.x

Version 0.2.0 intentionally removes the LLM generation-provider, `propose`, action-map, and program-map APIs. They have no replacement: applications should provide finite alternatives through `DecisionSession`, `Router`, or typed tree productions, then authorize and perform effects in application code. References to `proposeTool`, `ProposalProvider`, `ProviderSpec`, provider setup/catalog modules, and deep imports under `providers/` or `propose/` must be deleted.

The language AST `Program` type remains available as `Program` (and `LanguageProgram`). The new executable runtime is named `DecisionProgram`; use that name for values returned by `node`, `value`, `fromInput`, `parallel`, and `router.program`. This avoids silently reusing the established `Program` name for a different contract.
