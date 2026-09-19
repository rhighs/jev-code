import { spawn } from 'node:child_process';
import { jsonState, type Decisions, type State } from './decisions.js';
import type { GenerateOptions } from './generation.js';
import { compactContext, MAX_GRID_REQUEST_BYTES } from './scored-grid.js';
import { gridCursor } from './grid.js';
import { sanitizedEnv } from './env.js';
import { LimitError } from './types.js';
import { choice } from '@typesafe-ai/sdk';
import { branch, complete, runTree, slot, type ProgramRunOutcome, type ProductionContext, type TreeSlot } from './sdk/index.js';

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

function completedTreeValue<Value>(outcome: ProgramRunOutcome<Value>): Value {
  if (outcome.status === 'completed') return outcome.value;
  if (outcome.status === 'exhausted') throw new LimitError('Bash AST production selection exhausted its run budget.', { evidence: outcome.evidence });
  if (outcome.status === 'failed') throw outcome.error;
  throw new Error(outcome.detail);
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
  let previewTree: BashAst | undefined;
  let pendingOperator: Extract<BashAst, { type: 'binary' }>['operator'] | undefined;
  interface SelectionSpec { readonly semantic: string; readonly criteria: Record<string, string>; readonly tokens: string[] }
  interface SelectionRequest { readonly input: ReturnType<typeof jsonState>; readonly instruction: string }
  const selectionSpecs = new Map<string, SelectionSpec>();
  const pendingRequests = new Map<string, SelectionRequest>();
  let observedState: State = state;
  const prepareSelection = (slot: string, criteria: Record<string, string>, tokens: string[] = [], partialAst: BashAst | null = previewTree ?? null) => {
    if (++step > Math.min(options.maxSteps, 96)) throw new LimitError('Bash AST production budget exhausted.');
    decisions.signal.throwIfAborted();
    const input = jsonState({ ...context, generation: { field, phase: 'bash_ast', slot, partialAst, tokens } });
    const instruction = `Choose a valid Bash AST production for ${slot}. Follow the objective, use real files and the shortest correct command. Arguments are literal words rendered with shell quoting. Finish when the command is complete.`;
    if (Buffer.byteLength(JSON.stringify({ state: input, questions: { selection: choice(instruction, criteria) } })) > MAX_GRID_REQUEST_BYTES) throw new LimitError('Bash AST decision exceeds the request budget.');
    return { slot, criteria, input, instruction };
  };
  const reportSelection = async (slot: string, selected: string, preview: string): Promise<void> => {
    await options.onText?.(field, preview, false, { replace: preview }, { decoder: 'ast', step, cursor: gridCursor(preview), bytes: Buffer.byteLength(preview), ast: { slot, production: selected, symbols: [] } });
  };
  const registerSlot = (id: string, semantic: string, criteria: Record<string, string>, tokens: string[] = []): void => {
    selectionSpecs.set(id, { semantic, criteria, tokens });
  };
  const requestFor = (id: string): SelectionRequest => {
    const existing = pendingRequests.get(id);
    if (existing !== undefined) return existing;
    const spec = selectionSpecs.get(id);
    if (spec === undefined) throw new Error(`Missing Bash tree selection metadata for ${id}.`);
    const request = prepareSelection(spec.semantic, spec.criteria, spec.tokens);
    pendingRequests.set(id, request);
    observedState = request.input;
    return request;
  };
  const selected = async (id: string, production: string): Promise<void> => {
    const spec = selectionSpecs.get(id);
    if (spec === undefined) throw new Error(`Missing Bash tree selection metadata for ${id}.`);
    requestFor(id);
    const preview = previewTree ? renderBashAst(previewTree) : '';
    await reportSelection(spec.semantic, production, preview);
    pendingRequests.delete(id);
  };
  const plansCriteria: Record<string, string> = { compose: 'Compose a new command tree from program, argument, redirect and operator productions.' };
  plans.slice(0, 200).forEach((plan, index) => { plansCriteria[`plan_${index}`] = renderBashAst(plan); });
  const words = objective.match(/[\p{L}\p{N}_./=-]+/gu) ?? [];
  const literals = [...objective.matchAll(/"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`/g)].map(match => match[1] ?? match[2] ?? match[3]!);
  const programs = [...new Set(['python3', 'node', 'npm', 'git', 'ls', 'cat', 'printf', 'echo', 'test', 'bash', 'pytest', 'rg', 'find', 'pwd', 'wc', 'head', 'tail', 'sed', 'awk', 'mkdir', 'cp', 'mv', 'rm', 'curl', 'cargo', 'go', 'make', ...words.filter(word => /^[A-Za-z_][\w./-]*$/.test(word))])].slice(0, 200);
  const argumentsList = [...new Set([...files, ...literals, 'test', 'run', 'build', 'typecheck', '-m', 'py_compile', '-c', '--version', '--check', '--experimental-strip-types', '-n', '-l', '-a', '-p', '.', '1', '2', '5', '10', ...words])].slice(0, 240);
  const paths = [...new Set([...files, '/dev/null'])];
  type CommandNode = Extract<BashAst, { type: 'command' }>;
  type Connector = (left: BashAst) => BashAst;
  interface ArgumentsResult { readonly args: readonly string[]; readonly connect: Connector }

  const connectorCriteria = { END: 'Complete command tree.', pipe: 'Pipe stdout into another command.', and: 'Run another command only on success (&&).', or: 'Run another command only on failure (||).', sequence: 'Run another command (;).', output: 'Redirect stdout to a file (>).', append: 'Append stdout to a file (>>).', input: 'Read stdin from a file (<).' };
  const identityConnector: Connector = left => left;
  const commandSlot = (commandIndex: number, nextConnector: number | undefined): TreeSlot<State, BashAst> => {
    const id = `bash-program-${commandIndex}`;
    const criteria = Object.fromEntries(programs.map((value, index) => [`word_${index}`, value]));
    registerSlot(id, 'program', criteria, programs);
    return slot({
      id, description: 'the executable program for a Bash command',
      productions: programs.map((program, index) => branch<State, BashAst, { arguments: TreeSlot<State, ArgumentsResult> }>(
        `word_${index}`, program,
        async () => {
          await selected(id, `word_${index}`);
          const current: CommandNode = { type: 'command', program, args: [], redirects: [] };
          previewTree = previewTree !== undefined && pendingOperator !== undefined
            ? { type: 'binary', operator: pendingOperator, left: previewTree, right: current }
            : current;
          pendingOperator = undefined;
          return { arguments: argumentSlot(commandIndex, program, [], 0, nextConnector) };
        },
        children => {
          const command: CommandNode = { type: 'command', program, args: [...children.arguments.args], redirects: [] };
          const assembled = children.arguments.connect(command);
          tree = assembled;
          return assembled;
        },
      )),
    });
  };
  const argumentSlot = (commandIndex: number, program: string, args: readonly string[], count: number, nextConnector: number | undefined): TreeSlot<State, ArgumentsResult> => {
    const id = `bash-argument-${commandIndex}-${count}`;
    const available = argumentsList.flatMap((value, index) => args.includes(value) ? [] : [[`word_${index}`, JSON.stringify(value)] as const]);
    const criteria = Object.fromEntries([...available, ['END', 'No more arguments are needed.']]);
    registerSlot(id, 'argument', criteria, argumentsList);
    const end = nextConnector === undefined
      ? complete<State, ArgumentsResult>('END', criteria.END!, async () => {
        await selected(id, 'END');
        return { args, connect: identityConnector };
      })
      : branch<State, ArgumentsResult, { connector: TreeSlot<State, Connector> }>('END', criteria.END!, async () => {
        await selected(id, 'END');
        return { connector: connectorSlot(nextConnector) };
      }, ({ connector }) => ({ args, connect: connector }));
    const argumentProductions = available.map(([production, description]) => {
      const value = argumentsList[Number(production.slice(5))]!;
      if (count === 15) return complete<State, ArgumentsResult>(production, description, async () => {
        await selected(id, production);
        throw new LimitError('Bash AST argument budget exhausted.');
      });
      return branch<State, ArgumentsResult, { next: TreeSlot<State, ArgumentsResult> }>(production, description, async () => {
        await selected(id, production);
        rightmostCommand(previewTree!).args.push(value);
        return { next: argumentSlot(commandIndex, program, [...args, value], count + 1, nextConnector) };
      }, ({ next }) => next);
    });
    return slot({ id, description: `the next argument for ${program}`, productions: [...argumentProductions, end] });
  };
  const redirectPathSlot = (connectorCount: number, operator: '>' | '>>' | '<'): TreeSlot<State, Connector> => {
    const id = `bash-redirect-path-${connectorCount}`;
    const criteria = Object.fromEntries(paths.map((value, index) => [`word_${index}`, value]));
    registerSlot(id, 'redirect_path', criteria, paths);
    return slot({
      id, description: 'the redirect path',
      productions: paths.map((path, index) => connectorCount === 7
        ? complete<State, Connector>(`word_${index}`, path, async () => {
          await selected(id, `word_${index}`);
          rightmostCommand(previewTree!).redirects.push({ operator, path });
          return left => {
            const last = rightmostCommand(left);
            last.redirects.push({ operator, path });
            return left;
          };
        })
        : branch<State, Connector, { next: TreeSlot<State, Connector> }>(`word_${index}`, path, async () => {
          await selected(id, `word_${index}`);
          rightmostCommand(previewTree!).redirects.push({ operator, path });
          return { next: connectorSlot(connectorCount + 1) };
        }, ({ next }) => left => {
          const last = rightmostCommand(left);
          last.redirects.push({ operator, path });
          return next(left);
        })),
    });
  };
  const rightmostCommand = (value: BashAst): CommandNode => {
    let last = value;
    while (last.type === 'binary') last = last.right;
    if (last.type !== 'command') throw new Error('Redirect requires a simple command.');
    return last;
  };
  const connectorSlot = (count: number): TreeSlot<State, Connector> => {
    const id = `bash-connector-${count}`;
    registerSlot(id, 'connector', connectorCriteria);
    const connector = (production: 'pipe' | 'and' | 'or' | 'sequence', operator: '|' | '&&' | '||' | ';') =>
      branch<State, Connector, { right: TreeSlot<State, BashAst> }>(production, connectorCriteria[production], async () => {
        await selected(id, production);
        pendingOperator = operator;
        return { right: commandSlot(count + 1, count === 7 ? undefined : count + 1) };
      }, ({ right }) => left => ({ type: 'binary', operator, left, right }));
    const redirect = (production: 'output' | 'append' | 'input', operator: '>' | '>>' | '<') =>
      branch<State, Connector, { path: TreeSlot<State, Connector> }>(production, connectorCriteria[production], async () => {
        await selected(id, production);
        return { path: redirectPathSlot(count, operator) };
      }, ({ path }) => left => path(left));
    return slot({
      id, description: 'the next Bash connector or redirect',
      productions: [
        complete('END', connectorCriteria.END, async () => { await selected(id, 'END'); return identityConnector; }),
        connector('pipe', '|'), connector('and', '&&'), connector('or', '||'), connector('sequence', ';'),
        redirect('output', '>'), redirect('append', '>>'), redirect('input', '<'),
      ].map(production => count === 7 && production.id !== 'END'
        ? { ...production, assemble: production.kind === 'branch' ? async (children: never, context: ProductionContext<State>) => {
          await production.assemble(children, context);
          throw new LimitError('Bash AST connector budget exhausted.');
        } : undefined } as typeof production
        : production),
    });
  };

  registerSlot('bash-plan', 'plan', plansCriteria);
  const root = slot<State, BashAst>({
    id: 'bash-plan',
    description: 'the root Bash command plan',
    productions: Object.entries(plansCriteria).map(([id, description]) => id === 'compose'
      ? branch<State, BashAst, { command: TreeSlot<State, BashAst> }>(id, description, async () => {
        await selected('bash-plan', id);
        return { command: commandSlot(0, 0) };
      }, ({ command }) => command)
      : complete(id, description, async () => {
        await selected('bash-plan', id);
        const plan = plans[Number(id.slice(5))]!;
        previewTree = plan;
        return plan;
      })),
  });
  const planOutcome = await runTree(root, state, {
    session: decisions.publicSession(() => observedState),
    state: treeSlot => requestFor(treeSlot.id).input,
    instructions: treeSlot => requestFor(treeSlot.id).instruction,
  });
  decisions.signal.throwIfAborted();
  tree = completedTreeValue(planOutcome);
  const source = renderBashAst(tree!);
  if (Buffer.byteLength(source) > options.maxBytes) throw new LimitError('Bash AST exceeds its source byte budget.');
  await validateBashSource(source, decisions.signal);
  await options.onText?.(field, source, true, { replace: source }, { decoder: 'ast', step, cursor: gridCursor(source), bytes: Buffer.byteLength(source) });
  return source;
}
