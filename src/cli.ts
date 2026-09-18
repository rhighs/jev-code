#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { Harness, DEFAULT_LIMITS } from './harness.js';
import { JevProvider } from './provider.js';
import { runDemo } from './demo.js';
import { builtInTools } from './tools.js';
import { TerminalSession } from './terminal.js';
import { GenerationDisplay } from './draft.js';
import { formatDuration } from './timing.js';
import { AstRegistry, loadInstalledAsts, loadAstModule, installAstModule, removeAstAdapter } from './ast-adapters.js';
import { compareRecords, formatComparison, runEval, type EvalRecord } from './eval.js';
import { runDecide } from './decide.js';
import type { HarnessOptions } from './harness.js';
import type { HarnessEvent, Tool } from './types.js';

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
  --eval-out <dir>        Directory for .jev/eval records (default: current directory)
  --json                  Emit JSONL events on stdout
  --no-journal            Disable .jev/runs JSONL persistence
  --demo                  Offline scripted demo with real file and Bash tools
  --help                  Show help

Set TYPESAFE_API_KEY for live Jev runs. Ctrl-C cancels the current run.
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

async function main(): Promise<void> {
  try { loadEnvFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (process.argv[2] === 'decide') {
    if (!process.env.TYPESAFE_API_KEY) { process.stderr.write('decide: TYPESAFE_API_KEY is required.\n'); process.exitCode = 125; return; }
    let input = '';
    for await (const chunk of process.stdin) input += String(chunk);
    const res = await runDecide(process.argv.slice(3), input, new JevProvider());
    process.stdout.write(res.stdout);
    process.stderr.write(res.stderr);
    process.exitCode = res.code;
    return;
  }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    workspace: { type: 'string' }, 'prompt-file': { type: 'string' }, interactive: { type: 'boolean' },
    print: { type: 'boolean', short: 'p' },
    yes: { type: 'boolean' }, 'confirm-writes': { type: 'boolean' }, 'allow-outside': { type: 'boolean' },
    'max-turns': { type: 'string' }, 'max-requests': { type: 'string' }, 'max-steps': { type: 'string' },
    'timeout-ms': { type: 'string' }, 'grid-batch-size': { type: 'string' }, concurrency: { type: 'string' }, 'search-width': { type: 'string' }, tools: { type: 'string' }, json: { type: 'boolean' },
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
    else for (const adapter of new AstRegistry(await loadInstalledAsts(workspace)).list()) process.stdout.write(`${adapter.id}\t${adapter.extensions.join(', ')}\t${adapter.id === 'python' ? 'built-in' : 'installed'}\n`);
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
    if (!process.env.TYPESAFE_API_KEY) throw new Error('eval needs TYPESAFE_API_KEY for live Jev runs.');
    process.stderr.write('eval runs unattended: agent Bash executes on this host without confirmation.\n');
    const width = values['search-width'];
    if (width !== undefined && !/^[1-8]$/.test(width)) throw new Error('--search-width must be 1–8.');
    const records = await runEval({ provider: new JevProvider(), out: resolve(values['eval-out'] ?? '.'), ...(only === undefined ? {} : { only }), searchWidth: width === undefined ? 1 : Number(width),
      onRecord: r => process.stdout.write(`${r.task}\t${r.check.ok ? 'pass' : 'fail'}\t${r.status}\t${r.turns} turns\t${r.requests} requests\t${formatDuration(r.durationMs)}\t${r.check.reason}\n`) });
    process.exitCode = records.every(r => r.check.ok) ? 0 : 1;
    return;
  }
  let streamed = false;
  const draft = new GenerationDisplay();
  const onEvent = (event: HarnessEvent): void => {
    if (values.json) process.stdout.write(JSON.stringify(event) + '\n');
    else if (event.type === 'text' || event.type === 'action') process.stderr.write(draft.consume(event));
    else if (event.type === 'turn') process.stderr.write(`Turn ${event.turn}\n`);
    else if (event.type === 'turn_end') process.stderr.write(`Turn ${event.turn} finished · ${formatDuration(event.data.durationMs)} · ${formatDuration(event.data.elapsedMs)} total elapsed · ${event.data.requests} requests\n`);
    else if (event.type === 'tool_start') { streamed = false; process.stderr.write(`  → ${String(event.data.tool)}\n`); }
    else if (event.type === 'tool_output') { streamed = true; process.stderr.write(stripVTControlCharacters(String(event.data.text))); }
    else if (event.type === 'tool_end') {
      const result = event.data.result;
      process.stderr.write(`  ${result.ok ? '✓' : '✗'} ${streamed ? String(event.data.tool) : stripVTControlCharacters(result.output.slice(0, 2000))}\n`);
      streamed = false;
    }
  };
  if (values.demo) {
    if (!values.json) process.stderr.write('Offline scripted demo (no Jev API calls).\n');
    const { workspace, result } = await runDemo(onEvent);
    if (!values.json) process.stdout.write(`${result.summary}\nDemo workspace: ${workspace}\n`);
    return;
  }
  if (values['prompt-file'] && positionals.length) throw new Error('Use a positional task or --prompt-file, not both.');
  if (values.interactive && values.print) throw new Error('Choose --interactive or --print, not both.');
  if (values['prompt-file'] === '-' && values.interactive) throw new Error('Interactive mode needs a terminal; stdin is already used for the prompt.');
  if (values.interactive && !process.stdin.isTTY) throw new Error('--interactive requires a terminal.');
  const interactive = values.interactive ?? (Boolean(process.stdin.isTTY) && !values.print && !values['prompt-file'] && !values.json);
  const prompt = values['prompt-file'] === '-' ? await stdinText()
    : values['prompt-file'] ? await readFile(resolve(values['prompt-file']), 'utf8') : positionals.join(' ');
  if (!prompt && !interactive) throw new Error('Supply a coding task, or start without arguments in a terminal. Use --help for options.');
  const extraTools: Tool[] = [];
  if (values.tools) {
    const module = await import(pathToFileURL(resolve(values.tools)).href) as { tools?: Tool[] };
    if (!Array.isArray(module.tools)) throw new Error('Tool module must export a tools array.');
    extraTools.push(...module.tools);
  }
  const limit = (name: 'max-turns' | 'max-requests' | 'max-steps' | 'timeout-ms' | 'grid-batch-size' | 'concurrency' | 'search-width', fallback: number): number => {
    const raw = values[name];
    if (raw !== undefined && !/^\d+$/.test(raw)) throw new Error(`--${name} must be a positive integer.`);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error(`--${name} must be a positive integer <= 2147483647.`);
    return value;
  };
  const provider = new JevProvider();
  const harnessOptions: Omit<HarnessOptions, 'onEvent' | 'authorize'> = {
    workspace, provider, tools: [...builtInTools(), ...extraTools],
    experimentalGrid: values['experimental-grid'] ?? false,
    astAdapters: [...await loadInstalledAsts(workspace), ...(await Promise.all((values.asts ?? []).map(module => loadAstModule(workspace, module)))).flat()],
    maxTurns: limit('max-turns', DEFAULT_LIMITS.maxTurns), maxRequests: limit('max-requests', DEFAULT_LIMITS.maxRequests), maxGenerationSteps: limit('max-steps', DEFAULT_LIMITS.maxGenerationSteps),
    maxRunMs: limit('timeout-ms', DEFAULT_LIMITS.maxRunMs), allowOutsideWorkspace: values['allow-outside'] ?? false,
    gridBatchSize: limit('grid-batch-size', 8), concurrency: limit('concurrency', 4), searchWidth: limit('search-width', 1),
    ...(values['no-journal'] ? { journalDirectory: false as const } : {}),
  };
  if (interactive) {
    const session = new TerminalSession({ harness: harnessOptions, input: process.stdin, output: process.stderr,
      model: process.env.TYPESAFE_DEFAULT_MODEL ?? 'jev-latest', initialPrompt: prompt,
      yes: values.yes ?? false, confirmWrites: values['confirm-writes'] ?? false,
      ...(values.json ? { onEvent } : {}),
    });
    process.exitCode = await session.run();
    return;
  }
  let readline: ReturnType<typeof createInterface> | undefined;
  let activeController: AbortController | undefined;
  const cancel = (): void => activeController?.abort(new Error('Cancelled by user.'));
  const harness = new Harness({ ...harnessOptions, onEvent,
    authorize: async (tool, args, signal) => {
      if (values.yes || (tool.effect !== 'shell' && !(values['confirm-writes'] && tool.effect === 'write'))) return true;
      if (!readline) {
        process.stderr.write(`Tool ${tool.name} needs confirmation; run with --yes for unattended execution.\n`);
        return false;
      }
      process.stderr.write(`${tool.name}: ${JSON.stringify(args)}\n`);
      return /^y(?:es)?$/i.test((await readline.question('Execute? [y/N] ', { signal })).trim());
    },
  });
  readline = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
  process.on('SIGINT', cancel);
  readline?.on('SIGINT', cancel);
  try {
    activeController = new AbortController();
    const result = await harness.run(prompt, activeController.signal);
    activeController = undefined;
    if (!values.json) process.stdout.write(`[${result.status}] ${result.summary}\n${formatDuration(result.durationMs)} elapsed; ${result.turns} turns, ${result.requests} requests; run ${result.id}\n`);
    process.exitCode = result.status === 'completed' ? 0 : result.status === 'cancelled' ? 130 : 1;
  } finally {
    readline?.close();
    process.removeListener('SIGINT', cancel);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`jev-code: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
