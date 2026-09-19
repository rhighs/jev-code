# Jev Code

A TypeScript coding harness built from Jev's typed decisions. Each action is a turn: choose a tool, construct its arguments, execute it, observe its real result, then decide what to do next. Python files and Bash commands use constrained AST productions; paths and text use choices. Completion summaries come from observed tool results.

This is an experimental harness with tested execution plumbing. Jev is a decision model, not a text model: general code generation quality remains an empirical question. Accepting arbitrary tasks does **not** guarantee it can solve every task. Use actual compiler/test outcomes to assess generated code.

## Run

Requires Node.js 22+, Bash, and Python 3.9+ for Python AST generation. Node.js 24+ is needed for the native TypeScript execution example below.

```bash
npm install
npm run build
```

The first interactive run asks for your typesafe.ai API key and saves it to `~/.config/jev-code/config.json` (mode 600; `$XDG_CONFIG_HOME` and `JEV_CODE_CONFIG_DIR` are honored). `jev-code login` re-enters it, `jev-code logout` removes it. A `TYPESAFE_API_KEY` in the environment or a local `.env` file (loaded automatically) takes precedence over the saved key, and non-interactive commands (`--print`, `decide`, `eval`) never prompt; they fail with a pointer to `login` instead. Optional SDK settings are `TYPESAFE_DEFAULT_MODEL` and `TYPESAFE_BASE_URL`. `.env`, journals, dependencies, and build output are ignored by Git.

```bash
npm run dev
npm start -- --workspace /path/to/project
npm start -- --workspace /path/to/project "Create a TypeScript CLI and test it"
npm start -- -p --yes --workspace /path/to/project --prompt-file task.md
npm start -- --interactive --workspace /path/to/project
npm run dev -- --help
```

In a terminal, launching without a task starts a persistent interactive session. A positional task starts the first run and leaves the session open for follow-ups. `-p`/`--print` runs once and exits. Task files, JSON output, and non-terminal input select one-shot mode unless `--interactive` is explicit.

The session renders as a scrolling transcript with a pinned live area at the bottom, built on Ink. Ink renders to stderr and reads stdin, so stdout stays clean; `--json` is unaffected by the UI. The interactive session needs both stdin and stderr to be TTYs; piped input, `--json`, a task file, or a plain redirect fall back to one-shot rendering instead.

Completed tool calls join the transcript as cards. A write card shows the first 8 lines of the file with line numbers and syntax highlighting, a count of remaining lines, and a `/show <path>` hint. An edit card shows the change as a unified diff hunk, removed and added lines marked separately. A run card shows the command, exit code, duration, and the first 6 lines of output with a remaining-line count. A multi-file write lists every path written, clipped past 8 with a count, and is tracked by `/files` like single-file writes. Turn boundaries, task updates, cancellations, and the end-of-run summary are their own rows, not indented prose.

While Jev generates, a live pane pins above the prompt: the file taking shape, sized to the terminal, with the slot currently being filled marked in the source (or the last lines of output while a command runs); under 80 columns the pane is hidden and only the decision strip remains (see the degradation notes below). A one-line decision strip under the pane always shows the current slot, the chosen production, its confidence, and the running request count; before the first decision lands it reads `choosing…`. A pick is marked low-confidence when the winner's probability is within 0.1 of the runner-up's, or when Jev's own confidence is under 0.5 — there is no absolute cutoff. A status line above the prompt shows elapsed time, turn, requests used against the budget, and the active phase.

You can keep typing while Jev is working: new messages update the active task at the next turn, and once applied are echoed as their own row; the transcript and live pane stay stable while you type. `/cancel` or Ctrl-C stops the current run and returns to the session. Ctrl-C at an empty idle prompt exits.

| Session command | Behavior |
| --- | --- |
| `/help` | Show session controls. Tab completes command names. |
| `/status` | Show workspace, served model, permission mode, activity, and last run. |
| `/plan` | Display the latest recorded plan. |
| `/history` | Show recent tasks, outcomes, and elapsed time. |
| `/files` | List files written or edited in this session. |
| `/show <path>` | View an actual file with line numbers without a model request. |
| `/trace [n]` | List the last `n` decisions (default 10, max 20) with their winning production and rejected alternatives. |
| `/clear` | Clear conversation and host observations; keep files and journals. |
| `/cancel` | Cancel active work without exiting. |
| `/permissions ask` / `/permissions auto` | Change approval of agent tool calls. |
| `/paste` | Enter a multiline task; `/end` submits, `/abort` discards. |
| `/exit` | Cancel active work and quit. |
| `!<command>` | Execute your Bash command directly; its observed result is available to Jev on the next task. |

A tool that needs permission renders as the card it would produce — the full command (every line of a multi-line one) or the diff is visible, untruncated, before you answer — and resolves on a single keypress: `y` allows this call once, `n` denies it, `a` allows that tool for the rest of the session. While a prompt is awaiting approval the status line reads `y allow · n deny · a always` and typing does not reach the input box; only those three keys register, and Ctrl-C still cancels the run. Keys are ignored for the first 300 ms after the card appears, and if you were mid-way through typing an update the line stays yours: the status line asks you to send or erase it first, so a stray `a` lands in your text, not on the gate. `/permissions ask` and `/clear` revoke every standing `a` grant, and `/status` lists the grants in force. A denial is recorded as its own card, with the reason returned to Jev, and the run continues; a pending tool is reconsidered before execution if a newer task update has arrived in the meantime. Direct `!` commands are explicitly requested by you and execute immediately. Only one agent run or direct shell command executes at a time. Conversation lives in memory for this process, with a bounded summary of earlier tasks and recent host-command observations; restarting does not restore it automatically.

Shell commands require confirmation by default. `--confirm-writes` also confirms file mutations. `--yes` enables unattended execution. A declined call is returned as feedback; it is never executed. Tasks from stdin need `--prompt-file -`; combine that with `--yes` when Bash execution is needed.

Direct file tools resolve symlinks and reject paths outside the selected workspace. `--allow-outside` explicitly lifts that file boundary. **Bash runs on the host**; its working directory is not an OS sandbox, and its commands can access anything your user account can. Run the harness inside a container or VM when you need shell isolation. Bash children do not inherit `TYPESAFE_API_KEY` from the harness.

**Degradation.** Below 80 columns the live pane is dropped and only the decision strip remains; every line is clipped to the terminal width with a trailing ellipsis, so the terminal's own auto-wrap never splits a word across two screen lines. `NO_COLOR` or `TERM=dumb` turn off color and cursor movement in both the interactive session and `--print`. Under tmux and over SSH, the pinned live area redraws only when its content changes, so scrollback and multiplexer redraws stay legible. A non-TTY stdin or stderr — a pipe, a redirect, `--json`, a task file — falls back to the plain, `--print`-style renderer instead of mounting Ink.

Interactive rendering runs on Ink, React, and `ink-text-input` at runtime; `--print`, `--json`, `decide`, and `replay --plain` never load them. The installer is unaffected: it still runs `npm ci --ignore-scripts` from the source tarball against the committed `package-lock.json`.

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
| `propose` | Ask the configured generation model for candidates, filter them, let Jev select one or reject all, then write the file or return the text. Registered only when a provider is configured. See Propose. |
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

The Python AST builder, implemented in TypeScript, owns the grammar and tracks defined variables, function parameters, imports, functions, and builtins. Generation starts with a decomposition: Jev picks how many helper functions the program needs (zero to six), and for each a name, arity, one-line purpose, and parameter names. Zero helpers is the plain single-block path. Helper bodies are then generated concurrently, each in its own function scope that sees every helper as a callable with its arity plus a flat `peers` list, and the main block follows with the helpers defined. Each decision includes the rendered source so far with a `__jev_pending__` marker at the slot being filled, the current slot, visible symbols, and depth/function/loop constraints; context is trimmed to the request budget, dropping the plan first, then recent tool output, then windowing the source around the marker. An assignment becomes visible after its right-hand side is built. Function parameters stay in their function scope; defined functions constrain call arity from the symbol table. `return` is offered only inside functions; `break` and `continue` only inside loops, and nested functions reset loop scope. Dependent AST productions within one body run sequentially. Helper bodies and independent tool fields run concurrently, sharing one in-flight request cap (`--concurrency`, default 4, max 16). One failing helper aborts the whole write. The live pane shows the assembled module during helper generation and names the helper being filled.

`--search-width <k>` (default 1, max 8) generates each helper body `k` times from independent forks under the same in-flight cap and request budget. Candidates first pass a static check that never executes anything: the body must compile, reference only defined names, call peers with their declared arity, and contain a `return` when its purpose implies a value (words such as return, compute, get, read, sum, count, check, parse, build, convert). Survivors are each rated once with a Jev `score` question over a fixed four-level rubric from "does not address the purpose" to "correct and minimal"; the highest expected level is kept and ties keep the first. Every candidate outcome is a `text` event with `decoder: "search"` carrying the helper name, candidate index, kept flag, and drop reason, and the terminal prints one `search · helper · candidate i · kept|dropped(reason)` line per candidate. When every candidate is dropped the write fails with the reasons and nothing is written. Width 1 skips search entirely and issues exactly the same requests as before.

The current Python grammar supports expression statements, assignments, functions with up to three positional parameters, returns, if/else, for/while, standard-library imports, pass, break, and continue. Expressions support constants, defined names, calls to names or object/module members with up to three positional arguments, arithmetic, comparisons, lists, attributes, and indexing. Literal values and identifiers come from task-derived choices. Numbers are chosen from constants only (small integers, 20, 50, 100, 1000, -1, and numbers found in the task); identifiers come from task-derived candidates only; strings may be spelled from bounded token choices, at most 32 pieces, and spelling ends as soon as the same piece is chosen three times in a row. Python AST generation never falls back to a character grid; a failed AST stops without writing. This is a bounded subset of Python; classes, exceptions, comprehensions, decorators, keyword arguments, and other missing productions require grammar extensions. The harness accepts arbitrary objectives, but this grammar and model do not yet solve arbitrary coding tasks.

A trusted, isolated `python3` serializer constructs real `ast` nodes, fixes locations, compiles the completed tree without executing it, then calls [`ast.unparse()`](https://docs.python.org/3/library/ast.html#ast.unparse). The resulting source is parsed and compiled again before the file tool can run. Formatting is chosen by Python, so original comments and exact formatting are not preserved. Compilation checks syntax and control-flow legality; it does not prove runtime behavior or task correctness. Actual execution and tests remain Bash tools chosen by Jev.

Paths and working directories use typed choices over exact values derived from the objective. If none fits, bounded token choices compose the value. Other text uses the same span/token choices, with at most 32 productions for paths and 128 for general text. There is **no automatic character-grid fallback**. Typing `retry` or `try again` keeps the previous objective, including its requested destination and language.

Bash generation builds a command tree: program, literal arguments, redirects, pipelines, success/failure conditions, and command sequences. Jev chooses whole words and AST productions; the renderer quotes arguments and preserves operator grouping. A verification command for an observed file can be selected as a complete tree in one request. User-supplied commands in backticks can also be selected exactly. `bash -n` checks syntax without executing the generated source; execution still follows the permission policy.

`--experimental-grid` explicitly enables the earlier parallel character-grid backend for unsupported fields: one categorical `Choice` distribution per cell, decoded by its highest-probability character, with END padding. Batch size defaults to eight cells and concurrency to four batches; configure `--grid-batch-size` and `--concurrency`. Requests split to fit a conservative payload budget, and backend `max_tokens_exceeded` errors split multi-cell batches further. Invalid grids stop after at most three rounds. This backend remains unreliable for unconstrained code and prose. Installed source adapters continue to use AST generation even with this flag.

Numeric arguments use choices over valid values and documented defaults, with text generation as a fallback. They are range-checked; enums and booleans use typed choices directly. New files only reach their tool after **all** arguments finish. Exhausted or invalid generation never writes a partial draft. A field that hits its own generation limit (AST productions, byte size, request size) is recorded as a failed tool call and the run continues; only the run-level request, turn, and time budgets end the run. Tool failures feed the next turn. Two identical unchanged reads temporarily remove that read action from the next turn, requiring a different action instead of repeating the same read indefinitely. Two consecutive whole-file writes (`write_file` or `write_files`) to the same paths without a run in between leave only shell tools available on the next turn, so the program must be run before it is rewritten again (when no shell tool is registered, write tools are removed instead). API failures terminate the run rather than replaying a shell command.

Limits are explicit: 50 action turns, 512 Jev requests, 256 AST productions or experimental grid cells per field, and five minutes per run by default. Python AST nesting is capped at eight levels, a single Python block stops after 16 statements, and decision payloads are bounded. Override run budgets with `--max-turns`, `--max-requests`, `--max-steps`, and `--timeout-ms`. Bash AST composition also has a 96-production limit. Bash execution has a generated timeout of up to 10 minutes, defaulting to 30 seconds; the run deadline still applies. Ctrl-C aborts model requests and terminates the current Bash process group. Background daemons intentionally detached by a command are outside that cancellation guarantee.

Run statuses are `completed`, `blocked`, `limited`, `cancelled`, or `error`. Only `completed` exits with code 0; cancellation exits with 130, other failures with 1. Interactive mode carries a bounded conversation summary and inspects the current workspace on each run. New API-side instructions can be queued during a run and are applied at the next turn boundary.

## Program mapping

With a generation provider, `write_file` resolves the destination first and uses the registered language adapter to validate a mapped program. It no longer asks Jev to choose individual AST productions for this route. The LLM proposes a JSON map containing an observable goal, verification checks, ordered subproblems, input/output names, and compatible code options. Jev reviews the map against the original task, selects each implementation by its meaning and code, and reviews the assembled result. The generator has no tool access or authority to approve its own plan.

Maps contain at most eight steps and three options per step. Each option is at most 2 KB; the map is at most 32 KB. For each option, validation assembles the selected earlier pieces, that option, and the first option from each remaining step. This checks compatibility before Jev selects; those later pieces remain tentative. An invalid default later piece can require remapping. Jev rejection or source validation failure returns feedback to the mapper. There are at most three mapping attempts per draft, sharing `--max-proposals` with `propose`. Jev reviews and selections share the normal request and generation-step budgets. Errors never fall back silently to token-by-token grammar generation, and no draft is written before approval and validation finish.

The journal and trace mark these decisions with `phase: "program_map"`: `review_plan`, `choose_step`, and `review_program`. Progress displays the subproblem and the meaning of the selected implementation. Language validation is not proof of runtime behavior; the harness must still run applicable verification. The current adapter's validation determines which syntax or static checks are available.

Repeated calls with unchanged results trigger action mapping. The provider proposes at most four concrete actions; unknown tools, invalid arguments, repeated calls, and embedded source contents are filtered out. Jev selects or rejects the remaining options in `phase: "action_map"`. The selected action still passes ordinary authorization. Source writes go through program mapping; recovery shares `--max-proposals` with code maps and `propose`. A successful write resets the repetition window.


Python `write_files` uses the same mapping flow with a safe relative `.py` path per step. Fragments are joined per file, and candidate projects pass cross-file import validation. For single-file rewrites, the mapper receives the actual destination source, capped at 16 KB; larger files require focused edits. Both generator and review are scoped to the destination file, while task completion still covers every requested change and verification. Without a configured generation provider, both write tools retain their grammar builders. Free text still uses `propose text`. Library hosts enable mapping by passing `generationProvider` in `HarnessOptions`; the CLI shares its configured provider with mapping and `propose`.

## Propose

Jev cannot write open-ended text. `propose` gives it a bounded way to get some: a small autoregressive model produces candidates, TypeScript filters them, and Jev selects. The generator is not an agent. It does not see the tool list, the plan, or the history. It receives one objective, optional constraints, the path, and the current file content. It returns text.

The request fields are filled by Jev through the normal argument generator: `kind` (`file` or `text`), `objective`, `constraints` (may be empty), `count` (1 to 5, default 3), `path` (required for `file`; for `text` an optional existing file whose content is given to the generator as context and left unchanged). The provider returns `count` completions from `count` parallel single-completion requests. Validators run in a fixed order and stop at the first failure: `generation failed` (the request itself failed), `truncated` (the model hit its output limit), `empty`, `too large` (over 16 KB), `unchanged` (equal to the current file after whitespace normalization), `json wrapper` (a JSON object or array standing in for a non-JSON file), `duplicate of <label>` (equal to an earlier valid candidate), then the language validator of the matching adapter (`python3` compile, the TypeScript compiler, `gcc`, `rustc`, `go vet`, `luac`, `ruby -c`). Code fences are stripped first, including an unterminated fence or trailing prose after the closing fence. A candidate that is a JSON object with a single string value, or a `cat > file <<'EOF'` heredoc, is unwrapped to its inner content before the checks run.

Jev then answers one `choice` question. The options are the valid labels (`A` to `E`) and `reject`. Each label's text is the first line where that candidate differs from every other valid one, with `+n/-m` line counts against the current file. The state carries a bounded diff or head per candidate, never the full texts, so the request stays inside the usual budget. The decision event carries `field: "candidate"` and `phase: "propose"`, so `/trace` and `--json` show it like any other decision. `reject` returns `ok: false` with the candidate table so Jev can change the constraints or take another action. A `file` selection is written with the same atomic write as `write_file`; a `text` selection is the tool output.

The tool output lists the provider, the model, one line per candidate with its verdict, and the selection with its confidence. The `tool_end` record carries the same data plus a diff hunk of at most 120 lines. The session card shows the diff. Two consecutive `propose` writes to the same path without a run leave only shell tools for the next turn, as for `write_file`. Two consecutive rejected `propose` calls with the same request remove `propose` for the next turn. Provider response bodies are capped at 4 MB. `--max-proposals <n>` (default 20) caps generator calls across mapping and proposals per run; when exhausted, the tool returns `ok: false` and names `write_file` and `edit_file`.

`propose` has `effect: write`. With `--confirm-writes` the host approves the request (path, objective, constraints) before any candidate exists; the content is visible in the diff card afterwards. The current file content and the objective leave the machine and reach the configured provider; do not point `propose` at files that hold secrets.

## Providers

The provider layer lives in `src/providers/` and does not import the harness. A provider is one row in `catalog.ts`: id, base URL, wire protocol, authentication methods, bundled lightweight models, and an OAuth descriptor when the vendor offers one. Three wire protocols cover the six providers: OpenAI chat completions (`openai` with a key, `google`, `openrouter`, `openai-compatible`, `local`), Anthropic messages (`anthropic`), and OpenAI Responses over SSE on the ChatGPT backend (`openai` with OAuth). Adding a provider is one catalog row and, at most, one wire function.

Configuration is split. `~/.config/jev-code/config.json` holds `generation: { provider, model, auth, baseUrl }`. `~/.config/jev-code/credentials.json` holds the secrets keyed by provider id, mode 600, written like the config file. `JEV_GENERATION_API_KEY` in the environment overrides the stored credential for the active provider only, and `sanitizedEnv()` strips it, like `TYPESAFE_API_KEY`, from every child process. Errors from the wire client are scrubbed of bearer tokens, key-shaped strings, and every header value that was sent before they reach a tool result, an event, or a journal.

OAuth uses authorization code with PKCE. `openai` opens the browser and listens on `127.0.0.1:1455` (when the port is taken, paste the redirect URL from the browser instead); `anthropic` opens the browser and asks you to paste the code (or the whole redirect URL); `openrouter` opens the browser, listens on an ephemeral loopback port, and exchanges the code for an API key. `state` is checked where the vendor sends it. Tokens are refreshed once per `generate` call when expired and once more on a 401; concurrent calls share one refresh. A failed refresh leaves the stored credential untouched and reports `run jev-code provider login <id>`. `provider logout` deletes the local credential; it does not revoke the grant at the vendor. Consumer-subscription OAuth (ChatGPT, Claude) is meant for the vendors' own clients and can stop working; API keys are the supported path. Google OAuth is not implemented.

Commands: `provider login [id]` runs the picker (provider, authentication, model; live model lists come from `/models` when the provider has one); `provider logout [id]`; `provider list [--json]`; `provider models [id] [--json]`; `provider use [id|none] [--model <id>] [--base-url <url>]`: on a terminal it asks for whatever is missing (provider, base URL, model); the flags and `JEV_GENERATION_API_KEY` cover scripted setups. On the first interactive run without a `generation` section, the session asks once whether to configure a provider. Non-interactive runs never ask; without a usable provider, `propose` is not registered and nothing else changes.

## Observe

Every run writes `.jev/runs/<run-id>.jsonl` with decisions, model identities, progress, full tool arguments, outcomes, usage, and final status. Journals are created with owner-only file permissions. They can contain project source and command output. `--no-journal` disables persistence. Generation events report AST productions and tree previews, exact-plan selections, or grid cell patches with their candidate probabilities. The completed source is shown before execution; Bash stdout and stderr stream separately. `bytes` counts UTF-8 bytes.

`--print` renders the same cards as the interactive transcript, in plain text with no cursor movement, spinners, or color unless the target stream is a TTY and `NO_COLOR`/`TERM=dumb` allow it. Cards go to stderr as each tool call completes; the fixed-shape `[status]` summary — the outcome, the facts from tool records, and the budget spent — is written to stdout once, at the end, so `jev-code --print ... | tail -1` keeps working. Non-TTY output never reprints the whole source on each AST production: it prints one short step line per production and the final source once, inside its card, exactly as `--print` does. Any confirmation prompt goes to stderr, never stdout.

`--json` emits one machine-readable event per line to stdout; this UI changed no event shape, only added fields: `schema: 1` on the `start` event, and `options` (the winner plus up to three runners-up), `field`, `phase`, `slot`, `unit`, `candidate`, and (from `decide --lines`) `line` on `decision` events. Probability decisions carry the same identity fields as choices and scores.

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

## Decide

`decide` turns stdin into one Jev decision so a shell script can branch on it. It never runs tools, never writes files, and never loads the TUI; it needs `TYPESAFE_API_KEY` like every other live command. It reads stdin first; when the text does not fit the request budget it refuses with exit 125, because a decision over the head of a diff must not approve its tail. Pass `--truncate` to decide on the head anyway; stderr then reports `input truncated to N bytes`.

Pick exactly one mode:

| Flag | Behavior |
| --- | --- |
| `decide "<question>" --choices a,b,c` | Ask one choice question over stdin. Labels must be unique; 2 to 100 of them. Prints `label confidence` on stdout; exits with the 0-based index of the chosen label. |
| `decide --true "<statement>" [--threshold 0.5]` | Print the probability the statement holds for stdin. Exits 0 at or above `--threshold` (0 to 1, default 0.5), 1 below it. |
| `decide --score "<criteria>"` | Print the expected level over a fixed four-level rubric ("does not satisfy" to "fully satisfies") for stdin. Exits 0. |
| `--lines` | With `--true` or `--score`: score each non-blank stdin line separately, one request per line, and print them ranked best first as `value <tab> line`. With `--true` and `--threshold`, only lines meeting the threshold are printed. |
| `decide --spec <file.json>` | Run several questions from a JSON array — each entry exactly one of `{ question, choices }`, `{ true, threshold? }`, or `{ score }` — over the same stdin; prints one JSON line per answer. |
| `--json` | Print each answer as a `decision` harness event (the same shape a run emits, with a synthetic `runId`; with `--lines`, `data.line` carries the scored line) instead of the plain-text or JSON-per-line output above. |
| `--truncate` | Decide on the head of an oversized stdin instead of failing. |

Exit codes follow one rule: an option's own index for `--choices`, 0 for `--score`/`--spec` successes and for `--true` at or above `--threshold`, 1 for `--true` below it, and 125 for any failure — a missing key, bad arguments, oversized stdin without `--truncate`, a single choice, more than 100 choices, a broken pipe, or a confidence failure from the provider — with the reason on stderr. Choices are capped at 100 so their indices never reach 125.

```bash
# Gate a commit on a diff verdict
git diff --cached | jev-code decide "Is this change safe to commit?" --choices yes,no && git commit -m "..."

# Page on-call only above a confidence threshold
cat error.log | jev-code decide --true "this log shows a crash" --threshold 0.7 && ./page-oncall.sh

# Rank lines by relevance
printf 'line one\nline two\nline three\n' | jev-code decide --score "relevance to the task" --lines

# Run several questions from a spec file
cat notes.md | jev-code decide --spec review.json

# Same choice, as a decision event
echo "some text" | jev-code decide "Is this spam?" --choices yes,no --json
```

`--lines` and `--spec` cost one Jev request per line or question, so a large `--spec` or a long piped file scales the request count accordingly; stdin itself is trimmed to the same request-size budget generation uses, independent of that count.

## Replay

`jev-code replay <run-id> [--speed x] [--plain]` renders a saved journal through the same transcript model a live run uses — the same cards and live pane, from a file instead of a live harness. It looks for `<run-id>.jsonl` under `.jev/runs/` first, then under `.jev/eval/journals/<task>/`. An unknown run id exits non-zero with a one-line error.

On an interactive terminal it mounts the same Ink session, read-only — no prompt, no approvals. `--plain`, or a non-interactive terminal, renders through the plain renderer instead, identical in shape to `--print` output. Replay is instant by default; `--speed x` paces it by the original events' `elapsedMs` deltas divided by `x`, with any single gap between events capped at 2 seconds so a long pause in the original run does not stall playback. Ctrl-C exits replay immediately, whether paced or instant.

The journal's `start` event carries `schema: 1`. A journal from a newer schema is refused, with a message naming both the journal's version and the version replay supports. A journal missing that field is an older, schema-0 journal; it replays best-effort with a warning.

## Install AST adapters

Python, JavaScript, TypeScript, C, Rust, Go, Lua and Ruby are built in; `jev-code ast list` shows them. Python has its own builder (`src/python-ast.ts`). The other seven share one generator (`src/lang/core.ts`): a small intermediate representation of statements and expressions is built production by production with the same decision context and pending-slot preview as Python, and a dialect (`src/lang/<language>.ts`) supplies the keyword set, builtins with arities and return types, a feature set (functions, while, counted range, foreach, lists, index, string comparison, string join), a renderer, and a validator that runs the real toolchain. Typed dialects (TypeScript annotations, C, Rust, Go) only build expressions whose type the core can infer, so declarations and parameters carry types; the core also closes every typed function with a default return when a path falls through, keeps functions at the top level, hides main-local variables from function bodies, refuses self-assignment and assignment to loop variables, and never divides by a zero literal, because gcc, rustc and go vet reject each of those.

`test/lang-fuzz.test.ts` drives each dialect with random valid productions and compiles every rendered program with its toolchain; `JEV_FUZZ_ROUNDS` sets the count. Validators are `gcc -fsyntax-only` (or `clang`), `rustc --emit=metadata`, `go vet` in a temporary module, `luac -p`, `ruby -c`, and the TypeScript compiler for JavaScript and TypeScript. A missing validator fails the write with a message that names the tool.

To add a language, write a dialect and export `adapterFor(dialect)` from a module; see `examples/dialect-ast.mjs` for a Racket dialect in forty lines. `builtin:<id>` remains accepted by `ast install` for the bundled ids and is a no-op.

To install an adapter module from a source checkout:

```bash
npm run build
npm run dev -- ast install ./examples/dialect-ast.mjs
npm run dev -- ast list
npm run dev
# Later, remove it:
npm run dev -- ast remove racket
```

Installation records adapter modules in `<workspace>/.jev/asts.json`; subsequent CLI sessions load them automatically. Use `--workspace /path/to/project` for another workspace. Local module paths resolve against that workspace and are stored as absolute paths. To load an adapter for one session without installation:

```bash
npm run dev -- --asts ./examples/dialect-ast.mjs
```

Packages work too: install an adapter package into your workspace using npm, then run `npm run dev -- ast install <package-name>` from this harness with the target `--workspace`. The package must provide a Node-resolvable ESM module exporting an `astAdapters` array. A parser package alone is not a Jev generator: an adapter must implement the production loop, AST rendering, and source validation. Adapter modules execute as trusted host code, like tool modules.

An adapter implements the exported `AstAdapter` interface: `id`, `extensions`, `languages`, `generate(decisions, state, field, options)`, and mandatory `validate(source, signal)`. Generation uses the shared Jev request budget and abort signal. The host checks byte limits and validates returned source before marking generation complete or executing a file tool. Registered language/file extensions choose their AST adapter automatically, and adapter errors terminate that draft without reverting to the grid. Duplicate ids, languages, or extensions are rejected. Library hosts can pass `astAdapters` in `HarnessOptions` or call `harness.registerAst(adapter)` between runs. See [the JavaScript dialect](../src/lang/javascript.ts) and [the shared core](../src/lang/core.ts) for the bundled implementation.

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
npm run build
```

Integration tests exercise creation, failed command feedback, targeted edits, a successful rerun, rejected completion, cancellation, budgets, Unicode generation, path policy, custom tools, interactive follow-ups, live task updates, permissions, streamed Bash output, multiline input, and conversation reset. Additional tests exercise run/turn timing, adapter installation and reload, mandatory adapter validation, typed terminal generation without grid fallback, the file viewer, and styled previews. They do not measure live model quality.

Live validation on September 17, 2026 used Jev through the official SDK with the objective “Create a simple Python hello world. Run it with python3 to verify it.” Jev chose AST productions for `print('Hello, world!')`, wrote `main.py`, ran `python3 'main.py'`, observed `Hello, world!`, and completed in 3 turns and 16 requests. The live interactive session repeated this successfully in 3 turns and 16 requests (20,426 input tokens), streamed AST progress and command output, remained open, and accepted `/status`. These are narrow smoke tests, not a general coding benchmark.

After removing default grids and generated finish prose, a live “write a for loop in Python and run it” task generated `for i in range(5): print(i)`, printed 0 through 4, and completed in 3 turns, 22 requests, and 9.6 seconds. Generic one-argument range bounds exclude zero; explicitly requested empty or negative ranges remain valid. A more complex number-guessing-game trial exhausted 256 requests without producing a complete AST or writing a file. Complex generation still needs better model guidance and broader grammar coverage; passing syntax checks alone does not establish correctness.

## Eval

```bash
npm run dev -- eval
npm run dev -- eval guessing-game
npm run dev -- eval --eval-out /path/to/records
npm run dev -- eval compare .jev/eval/<before>.json .jev/eval/<after>.json
```

`eval` uses the configured generation provider for mapping and runs a fixed ladder of tasks against live Jev: `guessing-game`, `file-io-script`, and `multi-file-package`, each defined in `eval/<task>/task.json` with a prompt, a `stage` tag, and optional limit overrides, plus a `check.ts` that judges the resulting workspace deterministically. The guessing-game checker plays the game adaptively from the program's own feedback lines, so no seed is needed. Every task runs in a fresh temporary workspace that is deleted afterwards; its journal is kept under `.jev/eval/journals/<task>/`. One record per task is written to `.jev/eval/<timestamp>.json` under the current directory or `--eval-out`. `--search-width` applies to eval runs and is recorded on each record as `searchWidth`. A record file is a JSON array with one object per task: `task`, `stage`, `status`, `summary`, `check` (`ok`, `reason`), `turns`, `requests`, `inputTokens`, `durationMs`, `runId`, `commit`, `startedAt`. `eval compare <a> <b>` prints one row per task across the two files with pass, requests, duration, and status side by side and the request and duration deltas; a task present in only one file shows `absent`. `eval compare` does not need an API key.

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
| forced run after a rewrite pair (`61944ca`) | fail, 23 turns, 2000 requests, 10 min 54 s | fail, 32 turns, 3000 requests, 14 min 13 s | fail, 60 turns, 1749 requests, 9 min 45 s |
| list and file-name fixes (`1f7f88c`) | fail, 32 turns, 2000 requests, 11 min 18 s | fail, 34 turns, 3000 requests, 12 min 29 s | fail, 60 turns, 3294 requests, 18 min 34 s |
| same, `--search-width 3` | fail, 37 turns, 2000 requests, 11 min 4 s | fail, 9 turns, 3000 requests, 7 min 49 s | not run |
| call-nesting and bash fixes (`517d0f0`) | fail, 38 turns, 2000 requests, 10 min 44 s | fail, 34 turns, 3000 requests, 13 min 24 s | fail, 60 turns, 2516 requests, 13 min 53 s |

In those grammar-only baseline runs, no task passed. The failure mode moved from crashes (request-size overflow, token loops, a serializer error on every `else` branch) to decision quality. Since the rewrite guard forces a run, programs execute every third turn (19 runs in a 60-turn multi-file run, up from 1) and the shapes are nearly right: `'Hello, ' + name` in a package module imported by `main.py`, a `randint` call and an input loop, `open` with a running total. The remaining defects are single wrong picks, such as `randint(range(1 + 100, 100), 100)`, `print('Too low', None)`, or calling the greeting with `'Name'` instead of `'World'`. Search width 3 spends the same request budget in a third of the turns without a better program, so the request budget, not candidate count, is the binding limit.

The mapped implementation passed the same live ladder on 2026-09-19 with Jev 1.13.0 and the configured `gpt-5.5` generation provider:

| task | result | turns | Jev requests | elapsed |
| --- | --- | --- | --- | --- |
| guessing-game | pass | 5 | 31 | 22.8 s |
| file-io-script | pass | 3 | 13 | 13.0 s |
| multi-file-package | pass | 3 | 12 | 19.9 s |

Separate live checks covered Fibonacci creation in Python and TypeScript, a three-file Python project, preservation of existing tests while adding a negative-input case, and an interactive terminal follow-up changing the output count from 10 to 15. These are observed runs, not guarantees for every model response. The automated suite passed all 358 tests.

API integration follows the [official TypeScript SDK](https://github.com/typesafe-ai/typesafe-sdk-js) and its [typed question builders](https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/src/questions.ts).
