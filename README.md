<p align="center">
  <img src="assets/jev-code-logo.png" alt="Jev Code" width="220">
</p>

[Install](https://raw.githubusercontent.com/rhighs/jev-code/main/install.sh) · macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/rhighs/jev-code/main/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

An interactive coding CLI powered by [Jev](https://typesafe.ai). Watch source take shape, run tools, send updates, and see elapsed time after every turn.

```bash
export TYPESAFE_API_KEY="your-typesafe-key"
jev-code
```

| Language | Support |
| --- | --- |
| Python | Built-in AST generation; needs Python 3.9+. Bounded grammar. |
| Bash | Built-in command ASTs: arguments, pipes, redirects, conditions, sequences. |
| TypeScript | `jev-code ast install builtin:typescript` — starter AST grammar. |
| Other languages | Install an AST adapter; general files use bounded text choices. |

Try: `write a for loop in Python and run it`. From a source checkout, `npm run dev -- eval` runs the live eval ladder.

`/help` · `/status` · `/files` · `/show main.py` · `/trace` · `/cancel` · `/permissions auto` · `/exit`

The session is a scrolling transcript of tool cards — writes, edits, and command runs — with a pinned live area beneath it showing the file taking shape and the current decision's slot, production, and confidence; approve a shell command with a single `y`, `n`, or `a` keypress.

Pipe text through one Jev decision instead of running a session:

```bash
git diff --cached | jev-code decide "Is this change safe to commit?" --choices yes,no && git commit -m "..."
```

Experimental: complex tasks can still fail. Bash executes on your machine and asks permission by default. The installer reuses Node.js 22+ or installs a private Node.js 24 runtime; rerun it to update.

[AST adapters, options, logs, development, and tested limits →](docs/guide.md)
