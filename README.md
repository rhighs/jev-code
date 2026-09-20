<p align="center">
  <img src="assets/jev-code-logo.png" alt="Jev Code" width="220">
</p>

## NAME

jev-code - a coding agent and TypeScript SDK built on Jev, the decision-only model from [typesafe.ai](https://typesafe.ai)

## SDK

`jev-code` is a TypeScript library first. Your code lists the options and runs the effects. Jev only picks one option. The library gives you decision sessions, typed routers, `DecisionProgram` values, and bounded tree building. The CLI below is built on the same pieces.

```typescript
import { DecisionSession, defineRouter, route } from 'jev-code';

const router = defineRouter({
  inspect: route('Read state without changing it', { effect: 'read' } as const),
  modify: route('Change application state', { effect: 'write' } as const),
});

const selected = await router.select(
  new DecisionSession(provider),
  { request: 'Show the current status' },
  'Choose the application route.',
);
```

See [the SDK guide](docs/sdk.md) and the runnable [router](examples/router.ts) and [dependency-tree](examples/dependency-tree.ts) examples. Import from the package root only.

## CLI SYNOPSIS

```
jev-code [options] ["task"]
jev-code --print "task"
jev-code decide "question" --choices a,b,c
jev-code decide --true "statement" [--threshold p] [--lines]
jev-code decide --score "criteria" [--lines]
jev-code decide --spec file.json
jev-code replay run-id [--speed x] [--plain]
jev-code login | logout
jev-code ast install module | ast list | ast remove id
```

## EXAMPLE

A live run. Jev builds `greet.py` one grammar rule at a time, reads it back, fixes the names, runs it, and reports the output.

<p align="center">
  <img src="docs/media/session.gif" alt="A jev-code session building and running greet.py" width="920">
</p>

## INSTALL

```bash
curl -fsSL https://raw.githubusercontent.com/rhighs/jev-code/main/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

Works on macOS and Linux. Uses your Node.js 22+ if you have it, otherwise installs a private Node.js 24. Run it again to update.

## DESCRIPTION

Jev does not write text. It picks one option from a list, or gives a probability, or gives a score. jev-code turns coding into a chain of such picks. It builds a program as a syntax tree, one grammar rule at a time, for the languages listed below. It builds shell commands the same way. Then it runs the result and shows what happened.

The session is a list of cards. Each tool call is one card: a file write, an edit, or a command. A pane under the cards shows the file while Jev builds it. A strip shows the current slot, the chosen rule, and its confidence. Before a shell command runs, press one key: `y` allows it once, `n` denies it, `a` allows that tool for the whole session.

`decide` asks Jev one question about standard input. A shell script can branch on the exit code. No parsing needed.

## FIRST RUN

The first run asks for your typesafe.ai API key and saves it in `~/.config/jev-code/config.json` (mode 600).

```bash
jev-code
```

`TYPESAFE_API_KEY` in the environment wins over the saved key. Non-interactive commands never ask; they stop and tell you to run `jev-code login`.

## COMMANDS

| Command | Function |
| --- | --- |
| `jev-code` | Start an interactive session in the current directory. |
| `jev-code "task"` | Start a session and submit the task at once. |
| `jev-code --print "task"` | Run one task, print the cards to stderr and the summary to stdout, then exit. |
| `jev-code --json --print "task"` | Emit one JSON event per line on stdout. |
| `jev-code decide ...` | Make one Jev decision over stdin. See DECIDE. |
| `jev-code replay <run-id>` | Replay a saved run as cards. |
| `jev-code login` | Enter the API key and save it. |
| `jev-code logout` | Remove the saved API key. |
| `jev-code ast install <module>` | Install a language adapter from a local path or npm. |
| `jev-code ast list` | List installed adapters. |
| `jev-code ast remove <id>` | Remove an adapter. |
| `jev-code --help` | Print all options. |

Session commands, typed at the prompt:

| Command | Function |
| --- | --- |
| `/help` | List the session commands. |
| `/status` | Show workspace, model, permissions, and activity. |
| `/files` | List the files written in this session. |
| `/show <path>` | Print a file from the workspace. |
| `/trace [n]` | Show the last n decisions and what else Jev considered. Default 10, max 20. |
| `/plan` | Show the plan Jev recorded. |
| `/history` | List the tasks of this session with their outcomes. |
| `/permissions ask` | Ask before each shell command. Clears every `a` grant. |
| `/permissions auto` | Run shell commands without confirmation. |
| `/paste` | Enter a multi-line task. `/end` submits it. |
| `/cancel` | Stop the current run. |
| `/clear` | Start over. Keeps the files. |
| `!<command>` | Run a shell command yourself and show it as a card. |
| `/exit` | Leave the session. |

## LANGUAGES

These languages are built in. jev-code picks the grammar from the file extension, or from the language named in the task.

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
| Other | any | Install an adapter. Without one, Jev picks from bounded text choices. | adapter |

The validator must be on `PATH` before Jev writes a file in that language. If it is missing, the write stops and the message names the tool. Every language is fuzz-tested against its real compiler in `test/lang-fuzz.test.ts`.

## DECIDE

`decide` reads stdin, asks Jev one question, prints the answer, and exits. It never runs tools or writes files.

| Form | Output | Exit status |
| --- | --- | --- |
| `decide "q" --choices a,b,c` | `label confidence` | Index of the selected label. 2 to 100 labels. |
| `decide --true "statement" [--threshold 0.5]` | Probability, two decimals. | 0 at or above the threshold. 1 below it. |
| `decide --score "criteria"` | Expected level over a four-level rubric, with its label. | 0 |
| `... --lines` | One request per stdin line. Lines ranked best first as `value<TAB>line`. | 0 |
| `decide --spec file.json` | One JSON line per question. | 0 |
| `... --json` | Each answer as a `decision` event, the same shape a run emits. | As above. |
| `... --truncate` | Decide on the head of an oversized input instead of stopping. | As above. |

Any failure exits 125: no key, bad arguments, input too large without `--truncate`, or a provider error. The reason goes to stderr.

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

Branch on the exit status. It is the index of the chosen label.

```bash
git log -1 --format=%B | jev-code decide "What kind of change is this?" --choices feature,fix,refactor,docs
case $? in
  0) label=feature ;; 1) label=fix ;; 2) label=refactor ;; 3) label=docs ;;
  125) echo "undecided" >&2; exit 1 ;;
esac
```

Sort files by owner. A Bash array turns the exit status back into a name.

```bash
dirs=(billing support sales)
for f in inbox/*.txt; do
  jev-code decide "Who should handle this message?" --choices billing,support,sales < "$f"
  code=$?
  [ "$code" -lt 3 ] && mv "$f" "${dirs[$code]}/"
done
```

Filter log lines. `--lines` judges each line on its own. `--threshold` keeps the lines at or above it.

```bash
tail -n 500 app.log | jev-code decide --true "this line reports a failure" --lines --threshold 0.7
# 0.98	ERROR db connection refused
```

Rank technical debt. Highest score first.

```bash
rg -n "TODO|FIXME" src | jev-code decide --score "urgent: blocks users or risks data" --lines | head -5
# 2.44	src/tools.ts:88: FIXME: crashes when the file is empty
# 0.01	src/cli.ts:12: TODO: remove debug print
# 0.00	src/diff.ts:5: TODO: rename variable
```

Ask several questions about one diff. `--spec` runs each question over the same input.

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

Gate on confidence, not just the label. `--json` hands the full distribution to `jq`.

```bash
cat crash.txt | jev-code decide "Is this an error?" --choices yes,no --json \
  | jq -e '.data.choice == "yes" and .data.confidence > 0.8' > /dev/null && open-ticket crash.txt
```

Grade many files at once with `xargs`. Large files need `--truncate`.

```bash
ls docs/*.md | xargs -P 4 -I{} sh -c 'printf "%s\t" {}; jev-code decide --score "explains why, not only what" --truncate < {}' \
  | sort -t"$(printf '\t')" -k2 -r
```

Read a run as data. `--json` emits every event. This picks out the low-confidence decisions.

```bash
jev-code --print --json "write a number guessing game in game.py" \
  | jq -r 'select(.type == "decision" and .data.confidence != null and .data.confidence < 0.6)
           | "\(.data.slot // .data.field // "action") → \(.data.choice) \(.data.confidence)"'
```

Replay a saved run and grep it.

```bash
jev-code replay 810b329d-5869-4297-964e-320fd8907f23 --plain | grep '✗'
```

Never judge half an input. A diff that does not fit stops with exit 125 unless you pass `--truncate`, so the `&&` chain never commits what Jev did not read.

```bash
git diff | jev-code decide --true "safe to commit" && git commit -am wip
# decide: input is 61200 bytes; only 22976 fit. Pass --truncate to decide on the head alone.
```

## FILES

| Path | Content |
| --- | --- |
| `~/.config/jev-code/config.json` | The saved typesafe.ai API key. Mode 600. `XDG_CONFIG_HOME` and `JEV_CODE_CONFIG_DIR` change the directory. |
| `.env` | Optional. `TYPESAFE_API_KEY=...` in the current directory. Loaded before the saved key. |
| `.jev/runs/<run-id>.jsonl` | One journal per run: every event as one JSON line. Input for `replay`. |
| `.jev/eval/` | Eval records and journals from `pnpm run dev -- eval`. |

## EXIT STATUS

| Command | Status |
| --- | --- |
| Session, `--print` | 0 when the run completes. 130 when cancelled. 1 for any other outcome. |
| `decide --choices` | Index of the selected label. 125 on failure. |
| `decide --true` | 0 at or above the threshold. 1 below it. 125 on failure. |
| `decide --score`, `--spec` | 0. 125 on failure. |
| `replay --plain` | 0. 130 on Ctrl-C. |

## LIMITS

Jev has a 32k context and picks from short lists. Small programs finish. Larger ones can run out of request budget before they pass. `docs/guide.md` records the current eval results. Shell commands run on your machine; confirm each one unless you pass `--yes`.

## SEE ALSO

[docs/sdk.md](docs/sdk.md) - decisions, routers, programs, trees, limits, and the package contract.

[docs/guide.md](docs/guide.md) - sessions, output formats, AST adapters, options, journals, and eval results.
