import { spawn } from 'node:child_process';
import type { Decisions, State } from './decisions.js';
import type { GenerateOptions } from './generation.js';
import { compactContext, MAX_GRID_REQUEST_BYTES } from './scored-grid.js';
import { gridCursor } from './grid.js';
import { sanitizedEnv } from './env.js';
import { LimitError } from './types.js';
import { choice } from '@typesafe-ai/sdk';

export type BashAst = { type: 'command'; program: string; args: string[]; redirects: Array<{ operator: '>' | '>>' | '<'; path: string }> }
  | { type: 'binary'; operator: '|' | '&&' | '||' | ';'; left: BashAst; right: BashAst }
  | { type: 'literal'; source: string };
const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
export function renderBashAst(tree: BashAst): string {
  if (tree.type === 'literal') return tree.source;
  if (tree.type === 'binary') {
    const grouped = (child: BashAst): string => child.type === 'command' ? renderBashAst(child) : `{ ${renderBashAst(child)}; }`;
    return `${grouped(tree.left)} ${tree.operator} ${grouped(tree.right)}`;
  }
  if (!tree.program || [tree.program, ...tree.args, ...tree.redirects.map(item => item.path)].some(value => value.includes('\0'))) throw new Error('Invalid Bash AST word.');
  return [quote(tree.program), ...tree.args.map(quote), ...tree.redirects.map(item => `${item.operator} ${quote(item.path)}`)].join(' ');
}
export async function validateBashSource(source: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', ['-n', '-c', source], { signal, timeout: 5000, env: sanitizedEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(-4000); });
    child.on('error', reject);
    child.on('close', code => { if (signal.aborted) reject(signal.reason); else if (code === 0) resolve(); else reject(new Error(`Bash AST syntax validation failed: ${error || `exit ${code}`}`)); });
  });
}
export async function generateBashAst(decisions: Decisions, state: State, field: string, options: GenerateOptions): Promise<string> {
  const context = compactContext(state);
  const task = state.task as { prompt?: string; updates?: string[] } | undefined;
  const objective = [task?.prompt ?? '', ...(task?.updates ?? [])].join('\n');
  const recent = Array.isArray(state.recent) ? state.recent : [];
  const inventory = state.workspace as { files?: string[] } | undefined;
  const files = [...new Set([...(objective.match(/[\w./-]+\.(?:py|[cm]?[jt]sx?|sh|json|md|txt|rb|lua|go|c|h|rs)\b/g) ?? []),
    ...recent.flatMap(record => typeof record.args?.path === 'string' ? [record.args.path] : []), ...(inventory?.files ?? []).slice(0, 100)])];
  const exact = [...objective.matchAll(/`([^`\n]+)`/g)].map(match => match[1]!).filter(source => !files.includes(source));
  const plans: BashAst[] = exact.map(source => ({ type: 'literal', source }));
  const cmd = (program: string, ...args: string[]): BashAst => ({ type: 'command', program, args, redirects: [] });
  for (const file of files) {
    const base = file.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
    const program = file.endsWith('.py') ? 'python3' : /\.[cm]?js$/.test(file) ? 'node' : file.endsWith('.ts') ? 'node' : file.endsWith('.sh') ? 'bash' : file.endsWith('.rb') ? 'ruby' : file.endsWith('.lua') ? 'lua' : file.endsWith('.go') ? 'go' : undefined;
    if (program) plans.push(cmd(program, ...(file.endsWith('.ts') ? ['--experimental-strip-types', file] : file.endsWith('.go') ? ['run', file] : [file])));
    if (file.endsWith('.c')) plans.push({ type: 'binary', operator: '&&', left: cmd('gcc', '-o', base, file), right: cmd(`./${base}`) });
    if (file.endsWith('.rs')) plans.push({ type: 'binary', operator: '&&', left: cmd('rustc', '-o', base, file), right: cmd(`./${base}`) });
  }
  let step = 0;
  let tree: BashAst | undefined;
  async function pick(slot: string, criteria: Record<string, string>, tokens?: string[]): Promise<string> {
    if (++step > Math.min(options.maxSteps, 96)) throw new LimitError('Bash AST production budget exhausted.');
    decisions.signal.throwIfAborted();
    const input = { ...context, generation: { field, phase: 'bash_ast', slot, partialAst: tree ?? null, tokens: tokens ?? [] } };
    const instruction = `Choose a valid Bash AST production for ${slot}. Follow the objective, use real files and the shortest correct command. Arguments are literal words rendered with shell quoting. Finish when the command is complete.`;
    if (Buffer.byteLength(JSON.stringify({ state: input, questions: { selection: choice(instruction, criteria) } })) > MAX_GRID_REQUEST_BYTES) throw new LimitError('Bash AST decision exceeds the request budget.');
    const keys = Object.keys(criteria);
    const selected = keys.length === 1 ? keys[0]! : await decisions.choose(input, instruction, criteria);
    const preview = tree ? renderBashAst(tree) : '';
    await options.onText?.(field, preview, false, { replace: preview }, { decoder: 'ast', step, cursor: gridCursor(preview), bytes: Buffer.byteLength(preview), ast: { slot, production: selected, symbols: [] } });
    return selected;
  }
  const plansCriteria: Record<string, string> = { compose: 'Compose a new command tree from program, argument, redirect and operator productions.' };
  plans.slice(0, 200).forEach((plan, index) => { plansCriteria[`plan_${index}`] = renderBashAst(plan); });
  const plan = await pick('plan', plansCriteria);
  if (plan !== 'compose') tree = plans[Number(plan.slice(5))]!;
  else {
    const words = objective.match(/[\p{L}\p{N}_./=-]+/gu) ?? [];
    const literals = [...objective.matchAll(/"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`/g)].map(match => match[1] ?? match[2] ?? match[3]!);
    const programs = [...new Set(['python3', 'node', 'npm', 'git', 'ls', 'cat', 'printf', 'echo', 'test', 'bash', 'pytest', 'rg', 'find', 'pwd', 'wc', 'head', 'tail', 'sed', 'awk', 'mkdir', 'cp', 'mv', 'rm', 'curl', 'cargo', 'go', 'make', ...words.filter(word => /^[A-Za-z_][\w./-]*$/.test(word))])].slice(0, 200);
    const argumentsList = [...new Set([...files, ...literals, 'test', 'run', 'build', 'typecheck', '-m', 'py_compile', '-c', '--version', '--check', '--experimental-strip-types', '-n', '-l', '-a', '-p', '.', '1', '2', '5', '10', ...words])].slice(0, 240);
    async function command(left?: BashAst, operator?: Extract<BashAst, { type: 'binary' }>['operator']): Promise<BashAst> {
      const selected = await pick('program', Object.fromEntries(programs.map((value, index) => [`word_${index}`, value])), programs);
      const current: Extract<BashAst, { type: 'command' }> = { type: 'command', program: programs[Number(selected.slice(5))]!, args: [], redirects: [] };
      tree = left && operator ? { type: 'binary', operator, left, right: current } : current;
      for (let count = 0; count < 16; count++) {
        const criteria = Object.fromEntries(argumentsList.flatMap((value, index) => current.args.includes(value) ? [] : [[`word_${index}`, JSON.stringify(value)]]));
        criteria.END = 'No more arguments are needed.';
        const argument = await pick('argument', criteria, argumentsList);
        if (argument === 'END') return current;
        current.args.push(argumentsList[Number(argument.slice(5))]!);
      }
      throw new LimitError('Bash AST argument budget exhausted.');
    }
    tree = await command();
    for (let count = 0; count < 8; count++) {
      const selected = await pick('connector', { END: 'Complete command tree.', pipe: 'Pipe stdout into another command.', and: 'Run another command only on success (&&).', or: 'Run another command only on failure (||).', sequence: 'Run another command (;).', output: 'Redirect stdout to a file (>).', append: 'Append stdout to a file (>>).', input: 'Read stdin from a file (<).' });
      if (selected === 'END') break;
      if (['output', 'append', 'input'].includes(selected)) {
        const paths = [...new Set([...files, '/dev/null'])];
        const chosen = await pick('redirect_path', Object.fromEntries(paths.map((value, index) => [`word_${index}`, value])), paths);
        let last = tree;
        while (last.type === 'binary') last = last.right;
        if (last.type !== 'command') throw new Error('Redirect requires a simple command.');
        last.redirects.push({ operator: selected === 'input' ? '<' : selected === 'append' ? '>>' : '>', path: paths[Number(chosen.slice(5))]! });
      } else {
        const left: BashAst = tree;
        const operator = selected === 'pipe' ? '|' : selected === 'and' ? '&&' : selected === 'or' ? '||' : ';';
        const right = await command(left, operator);
        tree = { type: 'binary', operator, left, right };
      }
      if (count === 7) throw new LimitError('Bash AST connector budget exhausted.');
    }
  }
  const source = renderBashAst(tree!);
  if (Buffer.byteLength(source) > options.maxBytes) throw new LimitError('Bash AST exceeds its source byte budget.');
  await validateBashSource(source, decisions.signal);
  await options.onText?.(field, source, true, { replace: source }, { decoder: 'ast', step, cursor: gridCursor(source), bytes: Buffer.byteLength(source) });
  return source;
}
