<p align="center">
  <img src="assets/jev-code-logo.png" alt="Jev Code" width="220">
</p>

## NAME

jev-code - coding agent and decision pipe driven by Jev, the decision-only model from [typesafe.ai](https://typesafe.ai)

## SYNOPSIS

```
jev-code [options] ["task"]
jev-code --print "task"
jev-code decide "question" --choices a,b,c
jev-code decide --true "statement" [--threshold p] [--lines]
jev-code decide --score "criteria" [--lines]
jev-code decide --spec file.json
jev-code replay run-id [--speed x] [--plain]
jev-code login | logout
jev-code provider login [id] | logout [id] | list [--json] | models [id] [--json] | use [id|none] [--model id] [--base-url url]
jev-code ast install module | ast list | ast remove id
```

## EXAMPLE

A live run. Jev builds `stats.py`, reads a numeric data file, computes a summary, runs the program, and reports the observed result.

<p align="center">
  <img src="docs/media/session.gif" alt="A jev-code session building and running a Python statistics module" width="920">
</p>

Play the same recording in your terminal:

```bash
asciinema play docs/media/session.cast
```

## INSTALL

```bash
curl -fsSL https://raw.githubusercontent.com/rhighs/jev-code/main/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

The installer runs on macOS and Linux. It uses Node.js 22 or newer when present. If not, it installs a private Node.js 24 runtime. Run the installer again to update.

## DESCRIPTION

Jev does not write text. Jev selects one option from a list, or gives a probability, or gives a score. jev-code turns coding into a sequence of such selections. It builds Python as an abstract syntax tree, one production at a time. It builds Bash commands the same way. It runs the result and shows the outcome.

The interactive session is a transcript of cards. Each tool call is one card: a file write, an edit, or a command run. A live pane under the transcript shows the file while Jev builds it. A decision strip shows the current slot, the selected production, and its confidence. A shell command waits for one key: `y` allows it once, `n` denies it, `a` allows the tool for the session.

`decide` uses the same model on standard input. A shell script can branch on the exit code without parsing.

jev-code is a hybrid. Jev is the only policy. With a generation provider configured, `write_file` and Python `write_files` ask the LLM to map a source task into meaningful subproblems and compatible code options. Jev approves the map, chooses implementations, and reviews the assembled program. Language validators check it before writing; the harness then runs applicable verification. The LLM proposes structure and code but cannot approve a plan, choose tools, write files, or end a run. `propose` remains available for explanations and other file formats. See PROVIDERS.

## FIRST RUN

The first interactive run asks for your typesafe.ai API key. jev-code saves the key in `~/.config/jev-code/config.json` with mode 600.

```bash
jev-code
```

`TYPESAFE_API_KEY` in the environment overrides the saved key. Non-interactive commands do not ask. They stop with a message that names `jev-code login`.

## COMMANDS

| Command | Function |
| --- | --- |
| `jev-code` | Start an interactive session in the current directory. |
| `jev-code "task"` | Start a session and submit the task at once. |
| `jev-code --print "task"` | Run one task, print the cards to stderr and the summary to stdout, then exit. |
| `jev-code --json --print "task"` | Emit one JSON event per line on stdout. |
| `jev-code decide ...` | Make one Jev decision over stdin. See DECIDE. |
| `jev-code replay <run-id>` | Render a saved journal through the same transcript. |
| `jev-code login` | Enter the API key and save it. |
| `jev-code logout` | Remove the saved API key. |
| `jev-code provider login [id]` | Configure the generation provider: provider, authentication, model. Without `id` a picker opens. |
| `jev-code provider logout [id]` | Remove the stored credential of a provider. |
| `jev-code provider list [--json]` | List the providers, their authentication methods, the active one, and which are signed in. |
| `jev-code provider models [id] [--json]` | List the bundled and discovered models of a provider. |
| `jev-code provider use [id\|none] [--model <id>] [--base-url <url>]` | Select the active provider. Without `id` a picker opens; missing model or base URL are asked for on a terminal. Flags skip the prompts. `none` turns mapping and `propose` off. |
| `jev-code ast install <module>` | Install an AST adapter module from a local path or an npm package. |
| `jev-code ast list` | List the installed AST adapters. |
| `jev-code ast remove <id>` | Remove an installed AST adapter. |
| `jev-code --help` | Print all options. |

Session commands, typed at the prompt:

| Command | Function |
| --- | --- |
| `/help` | List the session commands. |
| `/status` | Show workspace, model, permissions, standing grants, and activity. |
| `/files` | List the files written in this session. |
| `/show <path>` | Print a file from the workspace. |
| `/trace [n]` | List the last n decisions with their alternatives. Default 10, maximum 20. |
| `/plan` | Show the plan Jev recorded. |
| `/history` | List the tasks of this session with their outcomes. |
| `/permissions ask` | Confirm each shell command. Revokes all `a` grants. |
| `/permissions auto` | Run shell commands without confirmation. |
| `/paste` | Enter a multi-line task. `/end` submits it. |
| `/cancel` | Stop the current run. |
| `/clear` | Start a new conversation. Keeps the files. |
| `!<command>` | Run a shell command on the host and show it as a card. |
| `/exit` | Leave the session. |

## LANGUAGES

Every language below is built in. jev-code selects the grammar from the file extension, or from the language named in the task.

| Language | Extensions | Grammar | Validator |
| --- | --- | --- | --- |
| Python | `.py` | Full builder: functions, loops, conditions, calls, lists, imports, helper units in parallel, multi-file packages. | `python3` compile |
| Bash | commands | Program, arguments, pipes, redirects, `&&`, `\|\|`, `;`. | `bash -n` |
| JavaScript | `.js` `.mjs` `.cjs` `.jsx` | Shared imperative core: variables, functions, if/else, while, counted and foreach loops, lists, index, arithmetic, comparison, string join. | TypeScript compiler |
| TypeScript | `.ts` `.tsx` `.mts` `.cts` | Same core, typed declarations. | TypeScript compiler |
| C | `.c` | Same core, typed. `long`, `const char *`, `bool`; functions before `main`. | `gcc -fsyntax-only` or `clang` |
| Rust | `.rs` | Same core, typed. `i64`, `&str`, `bool`; `let mut`. | `rustc --emit=metadata` |
| Go | `.go` | Same core, typed. `int`, `string`, `bool`; `_ = x` after each declaration. | `go vet` |
| Lua | `.lua` | Same core. 1-based index, `goto continue`. | `luac -p` |
| Ruby | `.rb` | Same core. `puts`, `each`, `next`. | `ruby -c` |
| Other | any | Install an adapter module. Files without an adapter use bounded text choices. | adapter |

A validator must be on `PATH` before Jev writes a file in that language. A missing validator stops the write with a message that names the tool. Each rendered program of the shared core is checked by its real toolchain: a fuzz suite in `test/lang-fuzz.test.ts` drives every dialect with random productions and compiles the result.

## PROVIDERS

Program mapping and `propose` use the same generation provider. The first interactive run asks whether to configure one. `Not now` records the choice and does not ask again. `jev-code provider login` opens the same setup at any time:

```text
Select generation provider:
> OpenAI
  Anthropic
  Google
  OpenRouter
  OpenAI-compatible
  Local

Authentication:
> Sign in with OAuth (vendor terms apply)
  Use API key

Model:
> gpt-5-nano
  gpt-5-mini
  gpt-4.1-nano
```

| Provider | Authentication | Wire | Models |
| --- | --- | --- | --- |
| `openai` | OAuth (browser, port 1455) or API key | Chat completions with a key; Responses on the ChatGPT backend with OAuth | `gpt-5-nano`, `gpt-5-mini`, `gpt-4.1-nano`, live list with a key |
| `anthropic` | OAuth (paste the code) or API key | Messages | `claude-haiku-4-5`, `claude-3-5-haiku` |
| `google` | API key | OpenAI-compatible endpoint | `gemini-2.5-flash-lite`, `gemini-2.5-flash`, live list |
| `openrouter` | OAuth (browser) or API key | Chat completions | small models from several vendors, live list |
| `openai-compatible` | API key | Chat completions at the base URL you enter | live list |
| `local` | none | Chat completions at `http://localhost:11434/v1` | live list from the server |

Use small, cheap, fast models. The generator only writes candidates; Jev does the judging. API keys are the supported path. OAuth with a consumer subscription is a convenience the vendor can withdraw; jev-code shows that in the picker label. Google OAuth is not implemented.

For a source file with a registered language adapter, `write_file` uses a program map: at most eight steps, each with one to three code options explained in task terms. For Fibonacci, the decisions concern the starting pair, advancing the sequence, and printing the requested count—not choosing AST nodes. Jev can reject the map or any piece, triggering a bounded remap. Each piece is at most 2 KB, and every candidate combination considered by Jev passes the language adapter's source check. Without a provider, the existing grammar builders remain available. `write_files` uses maps with a destination path per step and validates the assembled Python project, including local imports. Existing single-file rewrites load the destination source (up to 16 KB) and preserve behavior unrelated to the requested change.

If tool calls repeat without progress, the same provider proposes concrete next actions with paths or commands. Jev selects or rejects them; ordinary permissions still apply. Recovery cannot supply source contents directly and shares the proposal budget.


The Python prompt “a simple python fibonaci program writing the first 10” completed in a live run on September 19, 2026: 3 turns, 13 Jev requests, about 20 seconds, and output `0 1 1 2 3 5 8 13 21 34`. This is a smoke test, not a general benchmark.

How one `propose` call runs:

1. Jev fills the request: `kind` (`file` or `text`), `objective`, `constraints`, `count` (1 to 5), `path`.
2. The provider returns `count` candidates. One refresh of an expired OAuth token covers the whole batch.
3. Validators drop candidates that are truncated, empty, too large, unchanged, duplicates of an earlier candidate, a JSON wrapper around the content, or fail the language validator of the file type.
4. Jev selects one label or `reject`. The selection is one decision with `field=candidate`.
5. A `file` candidate is written atomically. A `text` candidate is returned as the output.

A run recorded against an OpenAI-compatible gateway (`gpt-5.5` behind LiteLLM) with a scripted Jev stand-in:

```text
✓ propose haiku.py · 6.0 s · 61 req
  │ +print("Moon pulls the tide in")
  │ +print("Salt wind combs the sleeping waves")
  │ +print("Dawn shells gleam softly")
── turn 2 · 1 file
  │ Moon pulls the tide in
  │ Salt wind combs the sleeping waves
  │ Dawn shells gleam softly
✓ bash 'python3' 'haiku.py' · exit 0 · 18 ms · 5 req
```

The journal record of that call:

```json
{"provider":"openai-compatible","model":"gpt-5.5",
 "candidates":[{"label":"A","valid":true,"bytes":109},
               {"label":"B","valid":true,"bytes":109},
               {"label":"C","valid":true,"bytes":112}],
 "selected":"A","confidence":0.81}
```

One failed request drops only its own candidate; the others still reach Jev. Limits: `--max-proposals <n>` caps generator calls per run (default 20). Each generator request times out after 60 s. `propose` counts as a write for `--confirm-writes`; the approval covers the request, and the content is shown in the diff card after the write. The current file and the objective are sent to the configured provider.

## DECIDE

`decide` reads all of stdin, asks Jev one question, prints the answer, and exits. It never runs tools. It never writes files.

| Form | Output | Exit status |
| --- | --- | --- |
| `decide "q" --choices a,b,c` | `label confidence` | Index of the selected label. 2 to 100 labels. |
| `decide --true "statement" [--threshold 0.5]` | Probability, two decimals. | 0 at or above the threshold. 1 below it. |
| `decide --score "criteria"` | Expected level over a four-level rubric, with its label. | 0 |
| `... --lines` | One request per stdin line. Lines ranked best first as `value<TAB>line`. | 0 |
| `decide --spec file.json` | One JSON line per question. | 0 |
| `... --json` | Each answer as a `decision` event, the same shape a run emits. | As above. |
| `... --truncate` | Decide on the head of an oversized input instead of stopping. | As above. |

Failures exit 125: no key, bad arguments, an input that does not fit without `--truncate`, or a provider error. The reason goes to stderr.

## EXAMPLES

Basic forms.

```bash
# Commit only when Jev agrees. The && chain reads the exit status.
git diff | jev-code decide --true "the change is safe to commit" && git commit -am "wip"

# One label, one probability, one exit code.
echo "Traceback (most recent call last): ValueError" | jev-code decide "Is this an error?" --choices yes,no
# yes 1.00            exit 0

# Grade one file.
jev-code decide --score "explains why, not only what" < README.md
# 1.73 mostly satisfies
```

Route by exit status. The index of the selected label is the exit status.

```bash
git log -1 --format=%B | jev-code decide "What kind of change is this?" --choices feature,fix,refactor,docs
case $? in
  0) label=feature ;; 1) label=fix ;; 2) label=refactor ;; 3) label=docs ;;
  125) echo "undecided" >&2; exit 1 ;;
esac
```

Move files to the team that owns them. Bash arrays index by exit status.

```bash
dirs=(billing support sales)
for f in inbox/*.txt; do
  jev-code decide "Who should handle this message?" --choices billing,support,sales < "$f"
  code=$?
  [ "$code" -lt 3 ] && mv "$f" "${dirs[$code]}/"
done
```

Filter log lines. `--lines` scores each line once. `--threshold` keeps the lines at or above it.

```bash
tail -n 500 app.log | jev-code decide --true "this line reports a failure" --lines --threshold 0.7
# 0.98	ERROR db connection refused
```

Rank technical debt. The highest score comes first.

```bash
rg -n "TODO|FIXME" src | jev-code decide --score "urgent: blocks users or risks data" --lines | head -5
# 2.44	src/tools.ts:88: FIXME: crashes when the file is empty
# 0.01	src/cli.ts:12: TODO: remove debug print
# 0.00	src/diff.ts:5: TODO: rename variable
```

Review a diff with several questions at once. `--spec` runs every question over the same input.

```bash
cat > review.json <<'EOF'
[
  { "question": "Which area does the diff touch most?", "choices": ["api", "ui", "build", "docs"] },
  { "true": "the diff adds or updates tests for what it changes", "threshold": 0.6 },
  { "score": "the diff is small and focused" }
]
EOF
git diff main... | jev-code decide --spec review.json | jq -c '{q: .question, a: (.choice // .score), p: .probability}'
# {"q":"Which area does the diff touch most?","a":"api","p":null}
# {"q":"the diff adds or updates tests for what it changes","a":"true","p":0.98}
# {"q":"the diff is small and focused","a":2.86,"p":null}
```

Gate on confidence, not only on the label. `--json` gives the full distribution to `jq`.

```bash
cat crash.txt | jev-code decide "Is this an error?" --choices yes,no --json \
  | jq -e '.data.choice == "yes" and .data.confidence > 0.8' > /dev/null && open-ticket crash.txt
```

Grade many files in parallel with `xargs`. Large files need `--truncate`.

```bash
ls docs/*.md | xargs -P 4 -I{} sh -c 'printf "%s\t" {}; jev-code decide --score "explains why, not only what" --truncate < {}' \
  | sort -t"$(printf '\t')" -k2 -r
```

Read a run as data. `--json` emits every event. Select the low-confidence decisions.

```bash
jev-code --print --json "write a number guessing game in game.py" \
  | jq -r 'select(.type == "decision" and .data.confidence != null and .data.confidence < 0.6)
           | "\(.data.slot // .data.field // "action") → \(.data.choice) \(.data.confidence)"'
```

Replay a saved run and grep it.

```bash
jev-code replay 810b329d-5869-4297-964e-320fd8907f23 --plain | grep '✗'
```

Reject a partial answer. A diff that does not fit stops with exit 125 unless `--truncate` is given, so a `&&` chain never commits what Jev did not read.

```bash
git diff | jev-code decide --true "safe to commit" && git commit -am wip
# decide: input is 61200 bytes; only 22976 fit. Pass --truncate to decide on the head alone.
```

## FILES

| Path | Content |
| --- | --- |
| `~/.config/jev-code/config.json` | The saved typesafe.ai API key and the `generation` settings (provider, model, auth, base URL). Mode 600. `XDG_CONFIG_HOME` and `JEV_CODE_CONFIG_DIR` change the directory. |
| `~/.config/jev-code/credentials.json` | Generation provider secrets: API keys, OAuth access and refresh tokens, keyed by provider id. Mode 600. Never copied into events, journals, or child processes. |
| `.env` | Optional. `TYPESAFE_API_KEY=...` in the current directory. Loaded before the saved key. `JEV_GENERATION_API_KEY=...` overrides the stored generation credential. |
| `.jev/runs/<run-id>.jsonl` | One journal per run: every event as one JSON line. Input for `replay`. |
| `.jev/eval/` | Eval records and journals from `npm run dev -- eval`. |

## EXIT STATUS

| Command | Status |
| --- | --- |
| Session, `--print` | 0 when the run completes. 130 when cancelled. 1 for any other outcome. |
| `decide --choices` | Index of the selected label. 125 on failure. |
| `decide --true` | 0 at or above the threshold. 1 below it. 125 on failure. |
| `decide --score`, `--spec` | 0. 125 on failure. |
| `replay --plain` | 0. 130 on Ctrl-C. |

## LIMITS

Jev has a 32k context and selects from bounded lists. Small programs complete. Larger programs can exhaust the request budget without a passing result. The eval ladder in `docs/guide.md` records the current state. Bash runs on your machine. Confirm each command unless you pass `--yes`.

## SEE ALSO

[docs/guide.md](docs/guide.md) - session, output formats, AST adapters, options, journals, eval results.
