#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_LIMITS } from './harness.js';
import { JevProvider } from './provider.js';
import { DEMO_PROMPT, DemoProvider, runDemo } from './demo.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtInTools } from './tools.js';
import { createPrinter, printRun } from './print.js';
import { isInteractiveTTY } from './terminal-style.js';
import { formatDuration } from './timing.js';
import { AstRegistry, loadInstalledAsts, loadAstModule, installAstModule, removeAstAdapter } from './ast-adapters.js';
import { bundledAstAdapters } from './lang/index.js';
import { compareRecords, formatComparison, runEval, type EvalRecord } from './eval.js';
import { runDecide } from './decide.js';
import { NO_KEY, configPath, promptSecret, readConfig, resolveApiKey, writeConfig } from './config.js';
import { MAX_GRID_REQUEST_BYTES } from './scored-grid.js';
import { checkSchema, findJournal, readJournal, replayPlain } from './replay.js';
import { spawn } from 'node:child_process';
import { sanitizedEnv } from './env.js';
import { proposeTools } from './providers/index.js';
import { pick, providerCommand, wizard } from './providers/setup.js';
import type { HarnessOptions } from './harness.js';
import type { Tool } from './types.js';

const HELP = `jev-code [options] ["your coding task"]

Starts an interactive coding session in a terminal. Use -p for one-shot tasks.

  --workspace <path>       Working directory (default: current directory)
  --prompt-file <path>     Read a task from a UTF-8 file; - reads stdin
  --interactive           Force interactive mode (including with --prompt-file)
  --print, -p             Run one task and exit
  --yes                   Execute agent tool calls without confirmation
  --confirm-writes        Also confirm file mutations
  --allow-outside          Allow direct file tools to address paths outside workspace
  --max-turns <n>          Action budget (default: 50)
  --max-requests <n>       Jev request budget (default: ${DEFAULT_LIMITS.maxRequests})
  --max-steps <n>          Maximum AST productions or grid cells per field (default: ${DEFAULT_LIMITS.maxGenerationSteps})
  --grid-batch-size <n>    Character Choices per request (default: 8, max: 128)
  --concurrency <n>       In-flight Jev requests shared by parallel units and grids (default: 4, max: 16)
  --search-width <n>      Candidates generated per Python unit; the best survivor is kept (default: 1, max: 8)
  --timeout-ms <n>         Total run time (default: ${DEFAULT_LIMITS.maxRunMs})
  --max-proposals <n>      Generator proposals per run (default: ${DEFAULT_LIMITS.maxProposals})
  --tools <module>        Load additional tools exported as a tools array
  --asts <module>         Load AST adapters for this session (repeatable)
  --experimental-grid    Opt into character-grid fallback (slow/unreliable)
  ast install <module>    Install local/npm AST adapters in this workspace
  ast list               List available AST adapters
  ast remove <id>         Remove an installed adapter
  eval [task]             Run the live eval ladder (dev-only, implies --yes; honors --search-width)
  eval compare <a> <b>    Compare two .jev/eval record files
  decide "<q>" --choices a,b  Ask one choice over stdin; prints "label confidence", exits with the label index
  decide --true "<statement>" Print the probability the statement holds for stdin; exits 0 at or above --threshold (0.5)
  decide --score "<criteria>" Print the expected level over a four-level rubric for stdin
  decide --spec <file.json>   Run [{ question, choices } | { true, threshold? } | { score }] over stdin; one JSON line each
    --lines                   With --true or --score: one request per stdin line, ranked best first
    --json                    Print each decide answer as a decision event; failures exit 125
  login                   Enter your typesafe.ai API key and save it under ~/.config/jev-code
  logout                  Forget the saved API key
  provider login|logout|list|models|use  Configure the generation provider behind the propose tool
  replay <run-id>         Render a saved .jev/runs or .jev/eval journal through the transcript
    --speed <x>               Pace events at x times real time (default: instant; gaps capped at 2 s)
    --plain                   Print cards as text instead of the Ink view
  --eval-out <dir>        Directory for .jev/eval records (default: current directory)
  --json                  Emit JSONL events on stdout
  --no-journal            Disable .jev/runs JSONL persistence
  --demo                  Offline scripted demo with real file and Bash tools; in a terminal it opens the full session
  --help                  Show help

The first run asks for your API key; TYPESAFE_API_KEY in the environment overrides the saved one. Ctrl-C cancels the current run.
Direct file tools stay in the workspace unless --allow-outside is set.
Bash is an ordinary host shell, with the workspace as its initial directory.
`;

async function stdinText(): Promise<string> {
  let value = '';
  for await (const chunk of process.stdin) {
    value += String(chunk);
    if (value.length > 32_000) throw new Error('Stdin prompt exceeds 32000 characters.');
  }
  return value;
}

async function replay(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { speed: { type: 'string' }, plain: { type: 'boolean' } } });
  const [id, ...extra] = positionals;
  if (!id || extra.length) throw new Error('Use replay <run-id> [--speed <x>] [--plain].');
  const speed = values.speed === undefined ? 0 : Number(values.speed);
  if (values.speed !== undefined && (!Number.isFinite(speed) || speed < 0)) throw new Error('--speed must be a number >= 0.');
  const path = await findJournal(process.cwd(), id);
  if (!path) throw new Error(`No journal found for run ${id}.`);
  const events = await readJournal(path);
  const warning = checkSchema(events);
  if (warning) process.stderr.write(`replay: ${warning}\n`);
  if (!values.plain && isInteractiveTTY(process.stdin, process.stderr)) {
    const { runReplay } = await import('./ui/replay-session.js');
    process.exitCode = await runReplay({ events, runId: id, speed });
    return;
  }
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop);
  try { await replayPlain(events, { stdout: process.stdout, stderr: process.stderr }, speed, controller.signal); }
  finally { process.removeListener('SIGINT', stop); }
  if (controller.signal.aborted) process.exitCode = 130;
}

const ignoreEpipe = (stream: NodeJS.WriteStream): void => { stream.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; }); };

async function readStdin(limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    chunks.push(buf);
    total += buf.length;
    if (total >= limit) { process.stdin.destroy(); break; }
  }
  return Buffer.concat(chunks).toString('utf8');
}

const openBrowser = (url: string): Promise<void> => new Promise(resolve => {
  const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true, env: sanitizedEnv() });
  child.on('error', () => resolve());
  child.on('spawn', () => { child.unref(); resolve(); });
});

const KEY_PROMPT = 'Paste your typesafe.ai API key (saved to ~/.config/jev-code/config.json): ';

async function ensureApiKey(interactive: boolean): Promise<void> {
  const key = await resolveApiKey(interactive ? () => promptSecret(KEY_PROMPT) : async () => undefined);
  if (!key) throw new Error(NO_KEY);
  process.env.TYPESAFE_API_KEY = key;
}

async function login(): Promise<void> {
  const key = await promptSecret(KEY_PROMPT);
  if (!key) throw new Error('login needs a terminal and a non-empty key.');
  process.stdout.write(`Saved API key to ${await writeConfig({ ...await readConfig(), apiKey: key })}\n`);
}

async function logout(): Promise<void> {
  const { apiKey: _apiKey, ...rest } = await readConfig();
  await writeConfig(rest);
  process.stdout.write(`Removed the API key from ${configPath()}\n`);
}

async function main(): Promise<void> {
  ignoreEpipe(process.stdout);
  ignoreEpipe(process.stderr);
  try { loadEnvFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (process.argv[2] === 'login') return login();
  if (process.argv[2] === 'logout') return logout();
  if (process.argv[2] === 'provider') { process.exitCode = await providerCommand(process.argv.slice(3), { out: process.stdout, stdin: process.stdin, open: openBrowser }); return; }
  if (process.argv[2] === 'decide') {
    try { await ensureApiKey(false); }
    catch (error) { process.stderr.write(`decide: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 125; return; }
    const input = await readStdin(MAX_GRID_REQUEST_BYTES * 4);
    const res = await runDecide(process.argv.slice(3), input, new JevProvider());
    process.stdout.write(res.stdout);
    process.stderr.write(res.stderr);
    process.exitCode = res.code;
    return;
  }
  if (process.argv[2] === 'replay') return replay(process.argv.slice(3));
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    workspace: { type: 'string' }, 'prompt-file': { type: 'string' }, interactive: { type: 'boolean' },
    print: { type: 'boolean', short: 'p' },
    yes: { type: 'boolean' }, 'confirm-writes': { type: 'boolean' }, 'allow-outside': { type: 'boolean' },
    'max-turns': { type: 'string' }, 'max-requests': { type: 'string' }, 'max-steps': { type: 'string' },
    'timeout-ms': { type: 'string' }, 'grid-batch-size': { type: 'string' }, concurrency: { type: 'string' }, 'search-width': { type: 'string' }, 'max-proposals': { type: 'string' }, tools: { type: 'string' }, json: { type: 'boolean' },
    'experimental-grid': { type: 'boolean' }, asts: { type: 'string', multiple: true }, 'no-journal': { type: 'boolean' }, demo: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    'eval-out': { type: 'string' },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  const workspace = resolve(values.workspace ?? '.');
  if (positionals[0] === 'ast') {
    const [, command, target, ...extra] = positionals;
    if (extra.length || !['install', 'list', 'remove'].includes(command ?? '') || (command === 'list' ? target !== undefined : !target)) throw new Error('Use ast install <module>, ast list, or ast remove <id>.');
    if (command === 'install') process.stdout.write(`Installed AST adapters: ${(await installAstModule(workspace, target!)).join(', ')}\n`);
    else if (command === 'remove') { await removeAstAdapter(workspace, target!); process.stdout.write(`Removed AST adapter: ${target}\n`); }
    else { const bundled = new Set(['python', ...bundledAstAdapters().map(a => a.id)]); for (const adapter of new AstRegistry(await loadInstalledAsts(workspace)).list()) process.stdout.write(`${adapter.id}\t${adapter.extensions.join(', ')}\t${bundled.has(adapter.id) ? 'built-in' : 'installed'}\n`); }
    return;
  }
  if (positionals[0] === 'eval' && positionals[1] === 'compare') {
    const [, , a, b, ...extra] = positionals;
    if (!a || !b || extra.length) throw new Error('Use eval compare <a.json> <b.json>.');
    const load = async (path: string): Promise<EvalRecord[]> => JSON.parse(await readFile(resolve(path), 'utf8')) as EvalRecord[];
    process.stdout.write(formatComparison(compareRecords(await load(a), await load(b))));
    return;
  }
  if (positionals[0] === 'eval') {
    const [, only, ...extra] = positionals;
    if (extra.length) throw new Error('Use eval [task] or eval compare <a.json> <b.json>.');
    await ensureApiKey(false);
    process.stderr.write('eval runs unattended: agent Bash executes on this host without confirmation.\n');
    const width = values['search-width'];
    if (width !== undefined && !/^[1-8]$/.test(width)) throw new Error('--search-width must be 1–8.');
    const records = await runEval({ provider: new JevProvider(), out: resolve(values['eval-out'] ?? '.'), ...(only === undefined ? {} : { only }), searchWidth: width === undefined ? 1 : Number(width),
      onRecord: r => process.stdout.write(`${r.task}\t${r.check.ok ? 'pass' : 'fail'}\t${r.status}\t${r.turns} turns\t${r.requests} requests\t${formatDuration(r.durationMs)}\t${r.check.reason}\n`) });
    process.exitCode = records.every(r => r.check.ok) ? 0 : 1;
    return;
  }
  const jsonOut = values.json ? process.stdout : undefined;
  if (values.demo && !values.json && !values.print && isInteractiveTTY(process.stdin, process.stderr)) {
    const { runSession } = await import('./ui/session.js');
    const workspace = await mkdtemp(join(tmpdir(), 'jev-demo-'));
    process.exitCode = await runSession({ harness: { workspace, provider: new DemoProvider(), experimentalGrid: true, journalDirectory: false }, model: 'offline-scripted-demo', initialPrompt: DEMO_PROMPT, yes: true });
    return;
  }
  if (values.demo) {
    if (!values.json) process.stderr.write('Offline scripted demo (no Jev API calls).\n');
    const printer = createPrinter(process.stderr, jsonOut);
    const { workspace } = await runDemo(printer.onEvent);
    if (!values.json) process.stdout.write(`${printer.summary().join('\n')}\nDemo workspace: ${workspace}\n`);
    return;
  }
  if (values['prompt-file'] && positionals.length) throw new Error('Use a positional task or --prompt-file, not both.');
  if (values.interactive && values.print) throw new Error('Choose --interactive or --print, not both.');
  if (values['prompt-file'] === '-' && values.interactive) throw new Error('Interactive mode needs a terminal; stdin is already used for the prompt.');
  const tty = isInteractiveTTY(process.stdin, process.stderr);
  if (values.interactive && !tty) throw new Error('--interactive requires a terminal.');
  const interactive = values.interactive ?? (tty && !values.print && !values['prompt-file'] && !values.json);
  const prompt = values['prompt-file'] === '-' ? await stdinText()
    : values['prompt-file'] ? await readFile(resolve(values['prompt-file']), 'utf8') : positionals.join(' ');
  if (!prompt && !interactive) throw new Error('Supply a coding task, or start without arguments in a terminal. Use --help for options.');
  const extraTools: Tool[] = [];
  if (values.tools) {
    const module = await import(pathToFileURL(resolve(values.tools)).href) as { tools?: Tool[] };
    if (!Array.isArray(module.tools)) throw new Error('Tool module must export a tools array.');
    extraTools.push(...module.tools);
  }
  const limit = (name: 'max-turns' | 'max-requests' | 'max-steps' | 'timeout-ms' | 'grid-batch-size' | 'concurrency' | 'search-width' | 'max-proposals', fallback: number): number => {
    const raw = values[name];
    if (raw !== undefined && !/^\d+$/.test(raw)) throw new Error(`--${name} must be a positive integer.`);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error(`--${name} must be a positive integer <= 2147483647.`);
    return value;
  };
  await ensureApiKey(tty);
  const cfg = interactive && tty ? await readConfig() : undefined;
  if (cfg && !cfg.generation) {
    const io = { out: process.stderr, stdin: process.stdin, open: openBrowser };
    const i = await pick('Configure a generation provider for propose?', ['Yes', 'Not now'], io);
    if (i === 0) await wizard(io).catch((err: unknown) => process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`));
    else if (i === 1) await writeConfig({ ...cfg, generation: { provider: 'none' } });
  }
  const asts = [...await loadInstalledAsts(workspace), ...(await Promise.all((values.asts ?? []).map(module => loadAstModule(workspace, module)))).flat()];
  const propose = await proposeTools(process.env, new AstRegistry(asts), line => process.stderr.write(`${line}\n`));
  const provider = new JevProvider();
  const harnessOptions: Omit<HarnessOptions, 'onEvent' | 'authorize'> = {
    workspace, provider, tools: [...builtInTools(), ...extraTools, ...propose],
    experimentalGrid: values['experimental-grid'] ?? false,
    astAdapters: asts,
    maxTurns: limit('max-turns', DEFAULT_LIMITS.maxTurns), maxRequests: limit('max-requests', DEFAULT_LIMITS.maxRequests), maxGenerationSteps: limit('max-steps', DEFAULT_LIMITS.maxGenerationSteps),
    maxRunMs: limit('timeout-ms', DEFAULT_LIMITS.maxRunMs), allowOutsideWorkspace: values['allow-outside'] ?? false,
    gridBatchSize: limit('grid-batch-size', 8), concurrency: limit('concurrency', 4), searchWidth: limit('search-width', 1), maxProposals: limit('max-proposals', DEFAULT_LIMITS.maxProposals),
    ...(values['no-journal'] ? { journalDirectory: false as const } : {}),
  };
  if (interactive) {
    const { runSession } = await import('./ui/session.js');
    process.exitCode = await runSession({ harness: harnessOptions, model: process.env.TYPESAFE_DEFAULT_MODEL ?? 'jev-latest', initialPrompt: prompt,
      yes: values.yes ?? false, confirmWrites: values['confirm-writes'] ?? false,
      ...(jsonOut ? { onEvent: createPrinter(process.stderr, jsonOut).onEvent } : {}),
    });
    return;
  }
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new Error('Cancelled by user.'));
  process.on('SIGINT', cancel);
  try {
    const result = await printRun({ harness: harnessOptions, prompt, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
      yes: values.yes ?? false, confirmWrites: values['confirm-writes'] ?? false, json: values.json ?? false, signal: controller.signal, onInterrupt: cancel });
    process.exitCode = result.status === 'completed' ? 0 : result.status === 'cancelled' ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', cancel);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`jev-code: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
