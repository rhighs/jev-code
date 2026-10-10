import type { Decisions, State } from './decisions.js';
import type { Field } from './types.js';
import type { TextProgress, TextChange } from './grid.js';
import type { RunContext } from './run-context.js';
import { decisionChoiceBytes, fitDecisionState, MAX_DECISION_REQUEST_BYTES } from './decision-context.js';
import { compactContext, generateScoredGrid } from './scored-grid.js';
import ts from 'typescript';
import { AstRegistry, type AstAdapter } from './ast-adapters.js';
import { planText } from './text-plan.js';
import { gridCursor } from './grid.js';
import { LimitError } from './types.js';
import { generateStructuredText } from './structured-text.js';
import { generateBashAst } from './bash-ast.js';
import { parseManifest } from './python-ast.js';

const defaultAsts = new AstRegistry();

/** Observations contribute characters to the alphabet, never whole-output templates. */
export function fragmentsFrom(texts: string[]): string[] {
  return texts.map(text => text.slice(0, 8000));
}

export interface GenerateOptions {
  maxSteps: number;
  maxBytes: number;
  allowEmpty: boolean;
  fragments: string[];
  astRegistry?: AstRegistry;
  experimentalGrid?: boolean;
  gridBatchSize?: number;
  concurrency?: number;
  searchWidth?: number;
  /** Run-scoped generation state; defaults to the decisions facade's shared context. */
  context?: RunContext;
  /** Host-side note for decisions that were skipped or rejected for size reasons (journal hook). */
  note?: (message: string) => Promise<void>;
  onText?: (field: string, value: string, done: boolean, change?: TextChange, progress?: TextProgress) => Promise<void>;
}

const tsDiagnostics = (fileName: string, text: string): Array<{ message: string; offset: number }> =>
  (ts.transpileModule(text, { fileName, reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
  } }).diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    .slice(0, 5).map(diagnostic => ({ message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'), offset: diagnostic.start ?? text.length }));

export function syntaxFeedback(state: State, field: string, text: string): Array<{ message: string; offset: number }> {
  const args = state.argumentsSoFar as Record<string, unknown> | undefined;
  if (field !== 'content' || typeof args?.path !== 'string' || !/\.(?:[cm]?[jt]sx?)$/.test(args.path) || !text) return [];
  return tsDiagnostics(args.path, text);
}

/** JS/TS single-file diagnostics for the one narrowed retry; other dialects keep current behavior. */
const repairDiagnostics = (adapter: AstAdapter, state: State, source: string): Array<{ message: string; offset: number }> => {
  if (adapter.id !== 'javascript' && adapter.id !== 'typescript') return [];
  const args = state.argumentsSoFar as Record<string, unknown> | undefined;
  const path = typeof args?.path === 'string' && /\.(?:[cm]?[jt]sx?)$/.test(args.path) ? args.path : adapter.id === 'typescript' ? 'main.ts' : 'main.js';
  return tsDiagnostics(path, source);
};

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function generateText(decisions: Decisions, state: State, field: string, description: string, options: GenerateOptions): Promise<string> {
  if (field === 'command' && !options.experimentalGrid) return generateBashAst(decisions, state, field, options);
  if (field === 'files' && state.action === 'write_files') {
    const registry = options.astRegistry ?? defaultAsts;
    const adapter = [registry.resolve(state), ...registry.list()].find(candidate => candidate?.generateProject && candidate.validateProject);
    if (!adapter) throw new Error('No AST adapter can generate a multi-file project.');
    const manifest = await adapter.generateProject!(decisions, state, field, { ...options,
      ...(options.onText ? { onText: async (name: string, value: string, done: boolean, change?: TextChange, progress?: TextProgress) => { if (!done) await options.onText!(name, value, false, change, progress); } } : {}),
    });
    decisions.signal.throwIfAborted();
    if (Buffer.byteLength(manifest) > options.maxBytes) throw new LimitError(`AST adapter ${adapter.id} returned a project outside its size constraints.`);
    await adapter.validateProject!(parseManifest(manifest), decisions.signal);
    decisions.signal.throwIfAborted();
    await options.onText?.(field, manifest, true, { replace: manifest }, { decoder: 'ast', step: 0, cursor: gridCursor(manifest), bytes: Buffer.byteLength(manifest) });
    return manifest;
  }
  const adapter = field === 'content' ? (options.astRegistry ?? defaultAsts).resolve(state) : undefined;
  if (adapter) {
    const forward = options.onText ? { onText: async (name: string, value: string, done: boolean, change?: TextChange, progress?: TextProgress) => { if (!done) await options.onText!(name, value, false, change, progress); } } : {};
    const attempt = async (attemptState: State): Promise<{ source: string; failure?: unknown }> => {
      const source = await adapter.generate(decisions, attemptState, field, { ...options, ...forward });
      decisions.signal.throwIfAborted();
      if (typeof source !== 'string' || (!source && !options.allowEmpty) || Buffer.byteLength(source) > options.maxBytes) throw new LimitError(`AST adapter ${adapter.id} returned source outside its byte/size constraints.`);
      try { await adapter.validate(source, decisions.signal); } catch (failure) { return { source, failure }; }
      decisions.signal.throwIfAborted();
      return { source };
    };
    const first = await attempt(state);
    let accepted = first.source;
    if (first.failure !== undefined) {
      decisions.signal.throwIfAborted();
      const syntax = repairDiagnostics(adapter, state, first.source);
      if (!syntax.length) throw first.failure;
      // One narrowed retry: the diagnostics ride in generation.syntax, which lang/core.ts consumes
      // to drop matching productions, and stay in the decision state for the model.
      const generation = state.generation && typeof state.generation === 'object' ? state.generation as Record<string, unknown> : {};
      const retryState: State = { ...state, generation: { ...generation, field, syntax, reason: errorText(first.failure) } };
      const second = await attempt(retryState);
      if (second.failure !== undefined) throw new Error(`AST adapter ${adapter.id} source failed validation after one narrowed retry: ${errorText(second.failure)}`, { cause: second.failure });
      accepted = second.source;
    }
    await options.onText?.(field, accepted, true, { replace: accepted }, { decoder: 'ast', step: 0, cursor: gridCursor(accepted), bytes: Buffer.byteLength(accepted) });
    return accepted;
  }
  const ws = state.workspace as { files?: string[] } | undefined;
  const plan = await planText(decisions, compactContext(state), field, Array.isArray(ws?.files) ? ws.files : [], options.note);
  if (plan !== undefined && (!syntaxFeedback(state, field, plan).length)) {
    if ((!plan && !options.allowEmpty) || Buffer.byteLength(plan) > options.maxBytes) throw new LimitError(`${field} selected text violates its size constraints.`);
    await options.onText?.(field, plan, true, { replace: plan }, { decoder: 'choice', step: 1, cursor: gridCursor(plan), bytes: Buffer.byteLength(plan) });
    return plan;
  }
  return options.experimentalGrid ? generateScoredGrid(decisions, state, field, description, options, syntaxFeedback)
    : generateStructuredText(decisions, state, field, description, options);
}

export async function generateArguments(decisions: Decisions, state: State, fields: Record<string, Field>,
  options: Omit<GenerateOptions, 'allowEmpty' | 'maxBytes'>): Promise<Record<string, string | number | boolean>> {
  const controller = new AbortController();
  const scoped = decisions.fork(controller.signal);
  const rawNumbers = JSON.stringify(state).match(/-?\d+(?:\.\d+)?/g) ?? [];
  // Size safety for field choices: compact history/recent and re-measure before sending. A field
  // that cannot fit fails that field decision (a failed field record in the harness), not the run.
  const fittedFieldInput = (name: string, instructions: string, criteria: Record<string, string>): State => {
    const input: State = { ...state, argumentFields: fields, field: name };
    const fit = fitDecisionState(input, candidate => decisionChoiceBytes(candidate, instructions, criteria), MAX_DECISION_REQUEST_BYTES);
    if (fit.overBudget) {
      throw new LimitError(`Field decision size failure: path=field, field=${name}, bytes=${fit.bytes}, cap=${fit.cap}, trimmed keys=${fit.trimmed.join(', ') || 'none'}; the request was not sent.`);
    }
    return fit.state;
  };
  const outcomes = await Promise.allSettled(Object.entries(fields).map(async ([name, field]) => {
    try {
      let value: string | number | boolean;
      if (field.type === 'boolean') {
        const criteria = { true: 'Yes.', false: 'No.' };
        value = await scoped.choose(fittedFieldInput(name, field.description, criteria), field.description, criteria) === 'true';
      } else if (field.type === 'enum') {
        value = await scoped.choose(fittedFieldInput(name, field.description, field.choices), field.description, field.choices);
      } else if (field.type === 'number') {
        const numbers = new Set([field.default, field.min, field.max, 0, 1, 2, 5, 10, 100, 1000, 8000, 30_000, 60_000,
          ...rawNumbers.slice(0, 100).map(Number)].filter((number): number is number => number !== undefined && Number.isFinite(number) &&
          (field.min === undefined || number >= field.min) && (field.max === undefined || number <= field.max)));
        const criteria: Record<string, string> = { custom: 'Construct another numeric value using bounded token choices.' };
        if (field.default !== undefined) criteria.default = `Use the documented default value ${field.default}.`;
        for (const number of numbers) criteria[`number_${number}`] = `Use ${number}.`;
        const instruction = `${field.description} Use the default unless the task needs another value.`;
        const input = fittedFieldInput(name, instruction, criteria);
        const selected = await scoped.choose(input, instruction, criteria);
        if (selected !== 'custom') value = selected === 'default' ? field.default! : Number(selected.slice(7));
        else {
          const text = await generateText(scoped, input, name, field.description, { ...options, maxBytes: 32, allowEmpty: false });
          if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new Error(`${name} must be a number.`);
          value = Number(text);
        }
        if (!Number.isFinite(value) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) throw new Error(`${name} is outside its permitted range.`);
      } else value = await generateText(scoped, { ...state, argumentFields: fields, field: name }, name, field.description, { ...options, maxBytes: field.maxBytes ?? 256_000, allowEmpty: field.allowEmpty ?? false });
      return [name, value] as const;
    } catch (error) { controller.abort(error); throw error; }
  }));
  const failure = outcomes.find(outcome => outcome.status === 'rejected');
  if (failure?.status === 'rejected') throw controller.signal.reason ?? failure.reason;
  const args: Record<string, string | number | boolean> = Object.fromEntries(outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : []));
  const registry = options.astRegistry ?? defaultAsts;
  const routedAdapter = registry.resolve({ argumentsSoFar: args });
  const initialAdapter = registry.resolve(state);
  // A sibling path is known only after the parallel field wave. Validate source against it now.
  if (typeof args.content === 'string' && fields.content?.type === 'string' &&
      ((typeof args.path === 'string' && routedAdapter?.id !== initialAdapter?.id) || syntaxFeedback({ argumentsSoFar: args }, 'content', args.content).length)) {
    args.content = await generateText(decisions, { ...state, argumentsSoFar: args }, 'content', fields.content.description,
      { ...options, maxBytes: fields.content.maxBytes ?? 256_000, allowEmpty: fields.content.allowEmpty ?? false });
  }
  return args;
}
