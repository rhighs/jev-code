---
name: jev-code
description: Use the rhighs/jev-code TypeScript SDK and CLI for typed Jev decisions, routing, constrained code generation, and stdin classification. Use when integrating this package or running its CLI.
---

# jev-code

Jev selects from application-defined options. Your application owns authorization and effects. This skill provides instructions only; it does not install the CLI or supply credentials.

## Start from the right project

- Use [rhighs/jev-code](https://github.com/rhighs/jev-code), not an unrelated npm package with the same name. The package is not published to npm.
- Follow the [README](https://github.com/rhighs/jev-code/blob/main/README.md) for CLI installation. Follow the [SDK guide](https://github.com/rhighs/jev-code/blob/main/docs/sdk.md) for source builds and package installation. Node.js 22+ is required.
- Use `jev-code login` for CLI credentials or `TYPESAFE_API_KEY` for direct SDK use. Never put keys into code, logs or committed files.

## SDK

Import from `jev-code`, not internal paths. Use `DecisionSession` for typed choices, probabilities and scores; `defineRouter` and `route` for typed routing; `DecisionProgram` for composition; the tree API for bounded expansion and validation.

Route values are data. Validate the selected action and authorize it before running effects. Set limits, deadlines and cancellation for model-backed work. Test logic with a deterministic `DecisionProvider`; do not make paid API calls without authorization.

## CLI

```bash
jev-code --help
jev-code --print "write hello.py and run it"
jev-code --resume last
```

Shell commands execute on the local machine. Keep confirmation enabled unless the user explicitly authorizes unattended execution. Never treat model approval as permission from the user. Task state and file excerpts can leave the machine for TypeSafe’s API; use synthetic inputs for examples.

`decide` reads stdin and does not execute tools. `--choices` exits with the selected label’s zero-based index; `--true` exits 0 at or above the threshold and 1 below it. Failures exit 125. `--truncate` evaluates only the head of oversized input. Handle failure separately from a valid choice.

See the [CLI guide](https://github.com/rhighs/jev-code/blob/main/docs/guide.md) for options, adapters and journals. Confirm language validators are installed before code generation. Treat generated code as untrusted until checked. This is experimental software; do not claim reliability from the demo or assume all languages have equal coverage.
