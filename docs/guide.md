# Jev Code

A TypeScript coding harness built from Jev's typed decisions. Each action is a turn: choose a tool, construct its arguments, execute it, observe its real result, then decide what to do next. Python files and Bash commands use constrained AST productions; paths and text use choices. Completion summaries come from observed tool results.

This is an experimental harness with tested execution plumbing. Jev is a decision model, not a text model: general code generation quality remains an empirical question. Accepting arbitrary tasks does **not** guarantee it can solve every task. Use actual compiler/test outcomes to assess generated code.

## Run

Requires Node.js 22+, Bash, and Python 3.9+ for Python AST generation. Node.js 24+ is needed for the native TypeScript execution example below.

```bash
npm install
npm run build
```

Set `TYPESAFE_API_KEY` in your environment or a local `.env` file (loaded automatically by the CLI). Optional SDK settings are `TYPESAFE_DEFAULT_MODEL` and `TYPESAFE_BASE_URL`. `.env`, journals, dependencies, and build output are ignored by Git.

```bash
npm run dev
npm start -- --workspace /path/to/project
npm start -- --workspace /path/to/project "Create a TypeScript CLI and test it"
npm start -- -p --yes --workspace /path/to/project --prompt-file task.md
npm start -- --interactive --workspace /path/to/project
npm run dev -- --help
```

In a terminal, launching without a task starts a persistent interactive session. A positional task starts the first run and leaves the session open for follow-ups. `-p`/`--print` runs once and exits. Task files, JSON output, and non-terminal input select one-shot mode unless `--interactive` is explicit.

You can keep typing while Jev is working: new messages update the active task at the next turn. A pending tool is reconsidered before execution if a newer instruction has arrived. `/cancel` or Ctrl-C stops the current run and returns to the session. Ctrl-C at an empty idle prompt exits. Bash output streams while commands run, and the prompt shows the current turn and argument-generation progress. The terminal shows a numbered source preview as the AST develops, syntax colors, a working indicator, and a live elapsed clock. Colors respect `NO_COLOR` and `TERM=dumb`; JSON and non-terminal output remain plain.

| Session command | Behavior |
| --- | --- |
| `/help` | Show session controls. Tab completes command names. |
| `/status` | Show workspace, served model, permission mode, activity, and last run. |
| `/plan` | Display the latest recorded plan. |
| `/history` | Show recent tasks, outcomes, and elapsed time. |
| `/files` | List files written or edited in this session. |
| `/show <path>` | View an actual file with line numbers without a model request. |
| `/clear` | Clear conversation and host observations; keep files and journals. |
| `/cancel` | Cancel active work without exiting. |
| `/permissions ask` / `/permissions auto` | Change approval of agent tool calls. |
| `/paste` | Enter a multiline task; `/end` submits, `/abort` discards. |
| `/exit` | Cancel active work and quit. |
| `!<command>` | Execute your Bash command directly; its observed result is available to Jev on the next task. |

Agent shell confirmation accepts `y` or `n`. Session commands remain available while waiting for approval; a task update causes the obsolete tool call to be reconsidered. Direct `!` commands are explicitly requested by you and execute immediately. Only one agent run or direct shell command executes at a time. Conversation lives in memory for this process, with a bounded summary of earlier tasks and recent host-command observations; restarting does not restore it automatically.

Shell commands require confirmation by default. `--confirm-writes` also confirms file mutations. `--yes` enables unattended execution. A declined call is returned as feedback; it is never executed. Tasks from stdin need `--prompt-file -`; combine that with `--yes` when Bash execution is needed.

Direct file tools resolve symlinks and reject paths outside the selected workspace. `--allow-outside` explicitly lifts that file boundary. **Bash runs on the host**; its working directory is not an OS sandbox, and its commands can access anything your user account can. Run the harness inside a container or VM when you need shell isolation. Bash children do not inherit `TYPESAFE_API_KEY` from the harness.

## Tools and turns

| Tool | Behavior |
| --- | --- |
| `list_files` | Inventory a directory without traversing symlinks or dependency/build directories. |
| `read_file` | Read bounded byte ranges; returns the total size and next offset. |
| `write_file` | Create or replace a UTF-8 file atomically, preserving existing permissions. |
| `write_files` | Write a multi-module Python project (a package plus `main.py`) as one validated set: every file is staged before any is renamed into place, and a failed rename restores the earlier files from backups, so a failure writes no files. Manifest entries that resolve to the same file (through symlinks) are rejected. |
| `edit_file` | Replace one unambiguous exact match; fail without mutation otherwise. |
| `bash` | Execute an arbitrary Bash command with bounded output and an explicit exit status. |
| `set_plan` | Record/revise the active plan and progress. |
| `finish` | End the run, gated by a separate task-scoped Jev completion choice. |
| `blocked` | Explain a missing prerequisite or user decision. |

An action turn contains multiple Jev requests. Python source follows this pipeline:

```text
objective → decomposition: helper functions (name, arity, purpose) or none
          → unit bodies, concurrently: rendered source + peers + symbol table
          → Jev chooses a valid production → update AST → repeat
          → main block → assemble → validate + ast.unparse() → source
```

Multi-file projects go through `write_files`. Jev first picks a package name, one to three module names, and for each helper unit the module that holds it (`main` or a package module); units in `main.py` are not offered as peers to package units. Cross-module calls never require Jev to write imports: the assembler inserts `from <pkg>.<module> import <name>` as the first statement of the calling unit's body, or at module level in `main.py`, so mutual calls between package modules resolve at call time. The main block is emitted under `if __name__ == "__main__":`, which keeps every module importable without side effects. Before anything is written, the set is validated statically: each file is compiled and every `import`/`from` target is located on disk or in the standard library with `importlib.util.find_spec`, and a package or module name that shadows an installed module is rejected; no generated module is imported or executed. Manifest paths must be relative identifier paths ending in `.py` and pass the workspace path policy before the validation copy is made.

The Python AST builder, implemented in TypeScript, owns the grammar and tracks defined variables, function parameters, imports, functions, and builtins. Generation starts with a decomposition: Jev picks how many helper functions the program needs (zero to six), and for each a name, arity, one-line purpose, and parameter names. Zero helpers is the plain single-block path. Helper bodies are then generated concurrently, each in its own function scope that sees every helper as a callable with its arity plus a flat `peers` list, and the main block follows with the helpers defined. Each decision includes the rendered source so far with a `__jev_pending__` marker at the slot being filled, the current slot, visible symbols, and depth/function/loop constraints; context is trimmed to the request budget, dropping the plan first, then recent tool output, then windowing the source around the marker. An assignment becomes visible after its right-hand side is built. Function parameters stay in their function scope; defined functions constrain call arity from the symbol table. `return` is offered only inside functions; `break` and `continue` only inside loops, and nested functions reset loop scope. Dependent AST productions within one body run sequentially. Helper bodies and independent tool fields run concurrently, sharing one in-flight request cap (`--concurrency`, default 4, max 16). One failing helper aborts the whole write. The terminal draft shows the assembled module during helper generation and names the helper being filled.

`--search-width <k>` (default 1, max 8) generates each helper body `k` times from independent forks under the same in-flight cap and request budget. Candidates first pass a static check that never executes anything: the body must compile, reference only defined names, call peers with their declared arity, and contain a `return` when its purpose implies a value (words such as return, compute, get, read, sum, count, check, parse, build, convert). Survivors are each rated once with a Jev `score` question over a fixed four-level rubric from "does not address the purpose" to "correct and minimal"; the highest expected level is kept and ties keep the first. Every candidate outcome is a `text` event with `decoder: "search"` carrying the helper name, candidate index, kept flag, and drop reason, and the terminal prints one `search · helper · candidate i · kept|dropped(reason)` line per candidate. When every candidate is dropped the write fails with the reasons and nothing is written. Width 1 skips search entirely and issues exactly the same requests as before.

The current Python grammar supports expression statements, assignments, functions with up to three positional parameters, returns, if/else, for/while, standard-library imports, pass, break, and continue. Expressions support constants, defined names, calls to names or object/module members with up to three positional arguments, arithmetic, comparisons, lists, attributes, and indexing. Literal values and identifiers come from task-derived choices. Numbers are chosen from constants only (small integers, 20, 50, 100, 1000, -1, and numbers found in the task); identifiers come from task-derived candidates only; strings may be spelled from bounded token choices, at most 32 pieces, and spelling ends as soon as the same piece is chosen three times in a row. Python AST generation never falls back to a character grid; a failed AST stops without writing. This is a bounded subset of Python; classes, exceptions, comprehensions, decorators, keyword arguments, and other missing productions require grammar extensions. The harness accepts arbitrary objectives, but this grammar and model do not yet solve arbitrary coding tasks.

A trusted, isolated `python3` serializer constructs real `ast` nodes, fixes locations, compiles the completed tree without executing it, then calls [`ast.unparse()`](https://docs.python.org/3/library/ast.html#ast.unparse). The resulting source is parsed and compiled again before the file tool can run. Formatting is chosen by Python, so original comments and exact formatting are not preserved. Compilation checks syntax and control-flow legality; it does not prove runtime behavior or task correctness. Actual execution and tests remain Bash tools chosen by Jev.

Paths and working directories use typed choices over exact values derived from the objective. If none fits, bounded token choices compose the value. Other text uses the same span/token choices, with at most 32 productions for paths and 128 for general text. There is **no automatic character-grid fallback**. Typing `retry` or `try again` keeps the previous objective, including its requested destination and language.

Bash generation builds a command tree: program, literal arguments, redirects, pipelines, success/failure conditions, and command sequences. Jev chooses whole words and AST productions; the renderer quotes arguments and preserves operator grouping. A verification command for an observed file can be selected as a complete tree in one request. User-supplied commands in backticks can also be selected exactly. `bash -n` checks syntax without executing the generated source; execution still follows the permission policy.

`--experimental-grid` explicitly enables the earlier parallel character-grid backend for unsupported fields: one categorical `Choice` distribution per cell, decoded by its highest-probability character, with END padding. Batch size defaults to eight cells and concurrency to four batches; configure `--grid-batch-size` and `--concurrency`. Requests split to fit a conservative payload budget, and backend `max_tokens_exceeded` errors split multi-cell batches further. Invalid grids stop after at most three rounds. This backend remains unreliable for unconstrained code and prose. Installed source adapters continue to use AST generation even with this flag.

Numeric arguments use choices over valid values and documented defaults, with text generation as a fallback. They are range-checked; enums and booleans use typed choices directly. New files only reach their tool after **all** arguments finish. Exhausted or invalid generation never writes a partial draft. A field that hits its own generation limit (AST productions, byte size, request size) is recorded as a failed tool call and the run continues; only the run-level request, turn, and time budgets end the run. Tool failures feed the next turn. Two identical unchanged reads temporarily remove that read action from the next turn, requiring a different action instead of repeating the same read indefinitely. Two consecutive whole-file writes (`write_file` or `write_files`) to the same paths without a run in between leave only shell tools available on the next turn, so the program must be run before it is rewritten again (when no shell tool is registered, write tools are removed instead). API failures terminate the run rather than replaying a shell command.

Limits are explicit: 50 action turns, 512 Jev requests, 256 AST productions or experimental grid cells per field, and five minutes per run by default. Python AST nesting is capped at eight levels, a single Python block stops after 16 statements, and decision payloads are bounded. Override run budgets with `--max-turns`, `--max-requests`, `--max-steps`, and `--timeout-ms`. Bash AST composition also has a 96-production limit. Bash execution has a generated timeout of up to 10 minutes, defaulting to 30 seconds; the run deadline still applies. Ctrl-C aborts model requests and terminates the current Bash process group. Background daemons intentionally detached by a command are outside that cancellation guarantee.

Run statuses are `completed`, `blocked`, `limited`, `cancelled`, or `error`. Only `completed` exits with code 0; cancellation exits with 130, other failures with 1. Interactive mode carries a bounded conversation summary and inspects the current workspace on each run. New API-side instructions can be queued during a run and are applied at the next turn boundary.

## Observe

Every run writes `.jev/runs/<run-id>.jsonl` with decisions, model identities, progress, full tool arguments, outcomes, usage, and final status. Journals are created with owner-only file permissions. They can contain project source and command output. `--no-journal` disables persistence; `--json` emits machine-readable events to stdout, with any confirmation prompts on stderr. Generation events report AST productions and tree previews, exact-plan selections, or grid cell patches with their candidate probabilities. The terminal shows the active draft while generation runs. The completed source is shown before execution; Bash stdout and stderr stream separately. `bytes` counts UTF-8 bytes.

The CLI prints real tool outcomes and an observed completion summary derived from successful tool records. A finish turn only selects the action and checks completion; it generates no prose. The default check is a categorical `complete` / `continue` choice over the current task and observed results; it excludes prior conversations and avoids a fixed probability cutoff. Library hosts can explicitly opt into a strict Noul gate with `completionThreshold`. Rejected completion requires another action before a new finish attempt, and rejected finish records are excluded from verification evidence. Three rejected completion checks without an implementation write stop with `limited`; repeated Bash runs, reads, or plan updates do not reset that guard. Generated blocker explanations are retained as `modelSummary`. For experimental evaluation, inspect generated files and verification results. This version does not automatically resume interrupted runs or replay tool effects; start a new task against the existing workspace to continue work.

## Timing

Each turn ends with its duration, total elapsed time since the prompt, and request count. Permission waits, model generation, tool execution, and verification are included. Timing uses a monotonic clock; UTC timestamps make runs comparable across logs.

```text
Turn 1 finished · 3.9 s · 3.9 s total elapsed · 9 requests
Turn 2 finished · 1.1 s · 4.9 s total elapsed · 4 requests
Turn 3 finished · 1.1 s · 6.0 s total elapsed · 3 requests
6.0 s elapsed; 3 turns, 16 requests
```

Every JSONL event has `elapsedMs`. `turn_end` events contain `durationMs`, `elapsedMs`, and `requests`; the final `end` event and library result contain `startedAt`, `endedAt`, and `durationMs`. Library results also include `turnTimings`. `/status` shows elapsed time for current/last work and `/history` shows task durations. A run starts when the harness accepts the prompt and ends when it determines the final status, before delivery of the final event. Updates join the same run clock. The same timing fields are available for failures, limits, and cancellations.

## Install AST adapters

Python is built in. An optional TypeScript starter grammar is included and uses the actual TypeScript compiler factory and printer. It supports const declarations, console.log, constants, references to defined variables, and arithmetic; it is not the full TypeScript grammar.

After the curl installation, enable it in any workspace with:

```bash
jev-code ast install builtin:typescript
jev-code ast list
```

To install an adapter module from a source checkout:

```bash
npm run build
npm run dev -- ast install ./examples/typescript-ast.mjs
npm run dev -- ast list
npm run dev
# Later, remove it:
npm run dev -- ast remove typescript
```

Installation records adapter modules in `<workspace>/.jev/asts.json`; subsequent CLI sessions load them automatically. Use `--workspace /path/to/project` for another workspace. Local module paths resolve against that workspace and are stored as absolute paths. To load an adapter for one session without installation:

```bash
npm run dev -- --asts ./examples/typescript-ast.mjs
```

Packages work too: install an adapter package into your workspace using npm, then run `npm run dev -- ast install <package-name>` from this harness with the target `--workspace`. The package must provide a Node-resolvable ESM module exporting an `astAdapters` array. A parser package alone is not a Jev generator: an adapter must implement the production loop, AST rendering, and source validation. Adapter modules execute as trusted host code, like tool modules.

An adapter implements the exported `AstAdapter` interface: `id`, `extensions`, `languages`, `generate(decisions, state, field, options)`, and mandatory `validate(source, signal)`. Generation uses the shared Jev request budget and abort signal. The host checks byte limits and validates returned source before marking generation complete or executing a file tool. Registered language/file extensions choose their AST adapter automatically, and adapter errors terminate that draft without reverting to the grid. Duplicate ids, languages, or extensions are rejected. Library hosts can pass `astAdapters` in `HarnessOptions` or call `harness.registerAst(adapter)` between runs. See [the TypeScript adapter](../src/typescript-ast.ts) for a working implementation.

## Extend

`Harness.registerTool` adds tools between runs. The CLI accepts `--tools /absolute/path/to/tools.mjs` for a module exporting a `tools` array. Each tool supplies a name, description, argument fields, an effect category, and an executor. It becomes selectable on every subsequent turn. Tool modules execute as ordinary trusted host code.

```typescript
import { Harness, JevProvider, type Tool } from './dist/index.js';

const tool: Tool = {
  name: 'project_info',
  description: 'Read the project-specific information needed for this task.',
  effect: 'read',
  fields: {},
  async execute(_args, context) {
    return { ok: true, output: `Project workspace: ${context.workspace}` };
  },
};

const harness = new Harness({
  workspace: '/path/to/project',
  provider: new JevProvider(),
  onEvent: event => console.log(event.type, event.turn),
});
harness.registerTool(tool);
const controller = new AbortController();
const result = await harness.run('Inspect this project and implement the requested change.', controller.signal);
console.log(result.status, result.summary);
// While a run is active, another host callback can call:
// harness.enqueue('Use Rust instead; keep the existing tests.');
```

For direct library use, export the API key before constructing `JevProvider`; `.env` loading belongs to the CLI. Inject a `DecisionProvider` for deterministic tests, and an `authorize` callback for your host's permission policy. All registered tools receive an abort signal and the same workspace path resolver. Custom tools must honor those facilities themselves.

## Verify

```bash
npm run typecheck
npm test
npm run demo
```

The offline demo uses a clearly labeled scripted provider and real tools in a temporary workspace. Integration tests exercise creation, failed command feedback, targeted edits, a successful rerun, rejected completion, cancellation, budgets, Unicode generation, path policy, custom tools, interactive follow-ups, live task updates, permissions, streamed Bash output, multiline input, and conversation reset. Additional tests exercise run/turn timing, adapter installation and reload, mandatory adapter validation, typed terminal generation without grid fallback, the file viewer, and styled previews. They do not measure live model quality.

Live validation on September 17, 2026 used Jev through the official SDK with the objective “Create a simple Python hello world. Run it with python3 to verify it.” Jev chose AST productions for `print('Hello, world!')`, wrote `main.py`, ran `python3 'main.py'`, observed `Hello, world!`, and completed in 3 turns and 16 requests. The live interactive session repeated this successfully in 3 turns and 16 requests (20,426 input tokens), streamed AST progress and command output, remained open, and accepted `/status`. These are narrow smoke tests, not a general coding benchmark.

After removing default grids and generated finish prose, a live “write a for loop in Python and run it” task generated `for i in range(5): print(i)`, printed 0 through 4, and completed in 3 turns, 22 requests, and 9.6 seconds. Generic one-argument range bounds exclude zero; explicitly requested empty or negative ranges remain valid. A more complex number-guessing-game trial exhausted 256 requests without producing a complete AST or writing a file. Complex generation still needs better model guidance and broader grammar coverage; passing syntax checks alone does not establish correctness.

## Eval

```bash
npm run dev -- eval
npm run dev -- eval guessing-game
npm run dev -- eval --eval-out /path/to/records
npm run dev -- eval compare .jev/eval/<before>.json .jev/eval/<after>.json
```

`eval` runs a fixed ladder of tasks against live Jev: `guessing-game`, `file-io-script`, and `multi-file-package`, each defined in `eval/<task>/task.json` with a prompt, a `stage` tag, and optional limit overrides, plus a `check.ts` that judges the resulting workspace deterministically. The guessing-game checker plays the game adaptively from the program's own feedback lines, so no seed is needed. Every task runs in a fresh temporary workspace that is deleted afterwards; its journal is kept under `.jev/eval/journals/<task>/`. One record per task is written to `.jev/eval/<timestamp>.json` under the current directory or `--eval-out`. `--search-width` applies to eval runs and is recorded on each record as `searchWidth`. A record file is a JSON array with one object per task: `task`, `stage`, `status`, `summary`, `check` (`ok`, `reason`), `turns`, `requests`, `inputTokens`, `durationMs`, `runId`, `commit`, `startedAt`. `eval compare <a> <b>` prints one row per task across the two files with pass, requests, duration, and status side by side and the request and duration deltas; a task present in only one file shows `absent`. `eval compare` does not need an API key.

`eval` is a development command: task checkers live outside the compiled `src/` tree, so run it with `npm run dev`, not the installed binary. It implies `--yes`: agent Bash executes on this host without confirmation, and checkers execute the generated programs. Run it inside a container or VM when you want isolation. Programs spawned by checkers do not receive `TYPESAFE_API_KEY`. Eval never runs in CI.

### Eval results

Live results on 2026-09-18 (one run per task, default task limits; `pass` means the checker accepted the workspace):

| build | guessing-game | file-io-script | multi-file-package |
| --- | --- | --- | --- |
| before rendered context (`ec792ca`) | fail, 2 turns, 1394 requests, 9 min 15 s, request-size overflow | not run | not run |
| rendered context (`1398293`) | fail, 1 turn, 102 requests, 33 s, token budget | fail, 78 requests, 27 s | fail, 125 requests, 44 s |
| decompose-and-fill (`2c9a341`) | fail, 23 turns, 2000 requests, 11 min 15 s | fail, 1 turn, 1500 productions, 9 min 47 s | fail, 60 turns, 2839 requests, 15 min 47 s |
| loop guards (`87849a1`) | fail, 33 turns, 2000 requests, 11 min 24 s | fail, 39 turns, 3000 requests, 12 min 44 s | fail, 60 turns, 1941 requests, 11 min 25 s |
| review fixes (`3925414`) | fail, 25 turns, 2000 requests, 11 min 20 s | fail, 44 turns, 3000 requests, 13 min 23 s | fail, 60 turns, 2783 requests, 15 min 9 s |

No task passes yet. The failure mode moved from crashes (request-size overflow, token loops, a serializer error on every `else` branch) to decision quality: every run now spends its whole budget in a write, write, read cycle, the rewrite guard forces the read, and the program is almost never executed. The generated programs have the right shape (a `randint` call, an input loop, `open` and a running total, a package module imported by `main.py`) but wrong details, such as nested lists as `randint` arguments, `int()` without an argument, or a literal `'Hello, <name>!'`. Search width above 1 has not been measured live.

API integration follows the [official TypeScript SDK](https://github.com/typesafe-ai/typesafe-sdk-js) and its [typed question builders](https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/src/questions.ts).
