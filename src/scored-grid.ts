import type { Decisions, State } from './decisions.js';
import type { GenerateOptions } from './generation.js';
import { characterAlphabet, describeCharacter, gridCursor, type ScoredCell, type TextProgress } from './grid.js';
import { choice } from '@typesafe-ai/sdk';
import { LimitError } from './types.js';

type SyntaxChecker = (state: State, field: string, text: string) => Array<{ message: string; offset: number }>;
const MAX_CELLS = 65_536;
export const MAX_GRID_REQUEST_BYTES = 24_000;

export function compactContext(state: State): State {
  const clip = (value: unknown, limit: number): unknown => typeof value === 'string' && value.length > limit ? value.slice(0, limit) + '\n[context clipped]' : value;
  const args = state.argumentsSoFar as Record<string, unknown> | undefined;
  const fields = state.argumentFields as Record<string, { description: string; type: string }> | undefined;
  return { task: state.task, action: state.action, field: state.field,
    argumentsSoFar: args ? Object.fromEntries(Object.entries(args).map(([key, value]) => [key, clip(value, 2048)])) : {},
    argumentFields: fields ? Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, { type: field.type, description: clip(field.description, 500) }])) : {},
    plan: clip(state.plan, 1000), recent: Array.isArray(state.recent) ? state.recent.slice(-2).map(record => ({ turn: record.turn, tool: record.tool,
      args: Object.fromEntries(Object.entries(record.args ?? {}).map(([key, value]) => [key, clip(value, 2048)])),
      result: { ok: record.result?.ok, output: clip(record.result?.output, 1000), data: { exitCode: record.result?.data?.exitCode } } })) : [],
  };
}

export async function generateScoredGrid(decisions: Decisions, state: State, field: string, description: string,
  options: GenerateOptions, syntaxFeedback: SyntaxChecker): Promise<string> {
  const batchSize = options.gridBatchSize ?? 8, concurrency = options.gridConcurrency ?? 4;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 128) throw new Error('gridBatchSize must be 1–128.');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('gridConcurrency must be 1–16.');
  const maxCells = Math.min(options.maxSteps, options.maxBytes + 1, MAX_CELLS);
  const alphabet = characterAlphabet([JSON.stringify(state), ...options.fragments]);
  const values = new Map(alphabet.map(symbol => [symbol.key, symbol.value]));
  const characterCriteria = Object.fromEntries(alphabet.map(symbol => [symbol.key, symbol.key === 'END' ? 'The text has ended. This position is at or after its end.' : describeCharacter(symbol.value)]));
  const baseContext = compactContext(state);
  // Shape/intent precede a whole parallel cell wave; there is never a character prefix loop.
  const sizes = new Set([maxCells, ...[8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536].filter(size => size <= maxCells)]);
  const criteria: Record<string, string> = Object.fromEntries([...sizes].map(size => [`cells_${size}`, `Allocate ${size} character positions including END/padding.`]));
  let capacity: number;
  if (sizes.size === 1) capacity = maxCells;
  else {
    const selected = await decisions.choose({ ...baseContext, generation: { field, description, phase: 'shape', maxCells } },
      `Allocate an output grid for ${field}. ${description} Select the smallest offered capacity that holds the COMPLETE text plus at least one END cell. All its cells will be scored in parallel, not appended sequentially.`, criteria);
    capacity = Number(selected.slice(6));
  }
  const columns = Math.min(32, capacity);
  let previous = '';
  let feedback = '';
  let repairs = 0;
  let round = 0;
  while (true) {
    decisions.signal.throwIfAborted();
    round++;
    const rows = Math.ceil(capacity / columns);
    const cells: Array<string | null> = Array(capacity).fill(null);
    let completed = 0;
    let bytes = 0;
    const grid = { rows, columns, capacity, alphabet };
    const progress = (): TextProgress => ({ decoder: 'grid', step: round, bytes, cursor: { row: 0, column: 0, offset: 0 },
      grid: { rows, columns, round, completed, total: capacity } });
    await options.onText?.(field, '', false, { grid: { rows, columns, round, completed, total: capacity, cells: [] } }, progress());
    const context = { ...baseContext, generation: { field, description, decoder: 'grid', phase: 'cells', round, grid, previous: previous.slice(0, 8192), feedback } };
    const instructions = `Construct the COMPLETE raw ${field}. ${description}\n` +
      `Task: ${JSON.stringify(state.task ?? {})}. Current action: ${String(state.action ?? '')}.\n` +
      `The output is a row-major character grid with ${columns} columns and ${capacity} cells. Grid row boundaries do NOT insert newlines; choose a newline character where needed.\n` +
      'Choose the SINGLE CHARACTER belonging at this position of the entire coherent minimal output. Think of the complete text before choosing this position. ' +
      'Choose END at every position at or after the end of the output. Keep literal spaces/newlines exact. For new source prefer conventional minimal formatting, double-quoted strings and a final newline. No presentation fences unless requested.\n' +
      (feedback ? `Repair the previous draft in generation.previous: ${feedback}.\n` : '');
    const batches: Array<Array<{ key: string; index: number }>> = [];
    const questionText = (index: number): string => instructions + `Which character is at absolute index ${index} (zero based), output cell [${Math.floor(index / columns)}, ${index % columns}]?`;
    const requestBytes = (batch: Array<{ key: string; index: number }>): number => Buffer.byteLength(JSON.stringify({ state: context,
      questions: Object.fromEntries(batch.map(({ key, index }) => [key, choice(questionText(index), characterCriteria)])) }));
    const framingBytes = Buffer.byteLength(JSON.stringify({ state: context, questions: {} }));
    let batch: Array<{ key: string; index: number }> = [];
    let batchBytes = framingBytes;
    const finishBatch = (): void => {
      if (requestBytes(batch) > MAX_GRID_REQUEST_BYTES) throw new LimitError(`Grid context for ${field} exceeds the safe request size; reduce task/context size.`);
      batches.push(batch);
      batch = [];
      batchBytes = framingBytes;
    };
    for (let index = 0; index < capacity; index++) {
      const entry = { key: `cell_${Math.floor(index / columns)}_${index % columns}`, index };
      const entryBytes = Buffer.byteLength(JSON.stringify({ [entry.key]: choice(questionText(index), characterCriteria) })) - 2;
      if (batch.length && (batch.length >= batchSize || batchBytes + entryBytes + 1 > MAX_GRID_REQUEST_BYTES)) finishBatch();
      batchBytes += entryBytes + (batch.length ? 1 : 0);
      batch.push(entry);
      if (batchBytes > MAX_GRID_REQUEST_BYTES) throw new LimitError(`Grid context for ${field} exceeds the safe request size; reduce task/context size.`);
    }
    if (batch.length) finishBatch();
    decisions.assertRequestBudget(batches.length);
    const controller = new AbortController();
    const scoped = decisions.fork(controller.signal);
    for (let start = 0; start < batches.length; start += concurrency) {
      const outcomes = await Promise.allSettled(batches.slice(start, start + concurrency).map(async batch => {
        try {
          const choices = await scoped.chooseMany(context, Object.fromEntries(batch.map(({ key, index }) => [key, questionText(index)])), characterCriteria);
          const patches: ScoredCell[] = batch.map(({ key, index }) => {
            const selected = choices[key]!;
            const value = values.get(selected.choice)!;
            cells[index] = value;
            bytes += Buffer.byteLength(value);
            return { index, row: Math.floor(index / columns), column: index % columns, score: selected.score, value, probabilities: selected.probabilities };
          });
          completed += batch.length;
          await options.onText?.(field, '', false,
            { grid: { rows, columns, round, completed, total: capacity, cells: patches } }, progress());
        } catch (error) { controller.abort(error); throw error; }
      }));
      const failure = outcomes.find(outcome => outcome.status === 'rejected');
      if (failure?.status === 'rejected') throw controller.signal.reason ?? failure.reason;
    }
    const end = cells.indexOf('');
    previous = cells.join('');
    if (end < 0) {
      if (++repairs >= 3) throw new LimitError(`Grid for ${field} produced no END after ${repairs} rounds; incomplete text was not executed.`);
      if (capacity >= maxCells) throw new LimitError(`Scored grid exhausted ${maxCells} cells for ${field} without END; incomplete text was not executed.`);
      capacity = Math.min(maxCells, capacity * 2);
      feedback = 'The previous grid contained no END cell. Use this larger grid for the entire output, followed by END/padding.';
      continue;
    }
    const text = cells.slice(0, end).join('');
    const syntax = syntaxFeedback(state, field, text);
    let invalidPadding = false;
    for (let index = end; index < cells.length; index++) if (cells[index] !== '') { invalidPadding = true; break; }
    if (invalidPadding) feedback = 'There are characters after END. Produce contiguous text, then only END/padding.';
    else if (!text && !options.allowEmpty) feedback = 'This field requires nonempty text.';
    else if (Buffer.byteLength(text) > options.maxBytes) throw new LimitError(`${field} exceeds its byte limit; text was not executed.`);
    else if (syntax.length && await decisions.probability({ ...baseContext, generation: { field, phase: 'validate', draft: text, syntax } },
      'Does the user explicitly request intentionally invalid or incomplete JavaScript/TypeScript source? Answer no for ordinary source creation.') < 0.85) {
      feedback = `Compiler syntax errors: ${JSON.stringify(syntax)}.`;
    } else if (await decisions.probability({ ...baseContext, generation: { field, description, phase: 'validate', draft: text } },
      `Does this COMPLETE decoded ${field} satisfy its exact requirements? ${description} Draft: ${JSON.stringify(text)}. ` +
      'Answer no for missing text, mangled characters, guessed/invented results, or an unrequested empty field. This checks the argument, not completion of the whole task.') < 0.85) {
      feedback = 'The decoded text failed its task-specific correctness check. Repair the whole grid in parallel.';
    } else {
      await options.onText?.(field, text, true, { replace: text }, { ...progress(), bytes: Buffer.byteLength(text), cursor: gridCursor(text) });
      return text;
    }
    if (++repairs >= 3) throw new LimitError(`Scored grid for ${field} failed validation after ${repairs} rounds; text was not executed. ${feedback}`);
  }
}
