import { randomUUID } from 'node:crypto';
import { DecisionSession, createDecisionSession, decisionSessionResources, rebindDecisionSession } from './decisions.js';
import { RunResources, resourceView, type ProgramResourceView, type RunLimits, type RunResourceOptions } from './resources.js';
import {
  CancelledError,
  ResourceExhaustedError,
  type DecisionProvider,
  type ProgramEvent,
  type ProgramRunMetadata,
  type ProgramRunOutcome,
} from './types.js';
import { validationDetail, type ValidationResult, type Validator } from './validation.js';
export type { ValidationContext } from './validation.js';

export interface ProgramContext<Input> {
  readonly input: Input;
  readonly signal: AbortSignal;
  readonly resources: ProgramResourceView;
  readonly decisions?: DecisionSession;
}

export interface ProgramInspection {
  readonly id: string;
  readonly kind: 'node' | 'map' | 'parallel' | 'flatMap';
  readonly dependencies: readonly string[];
  readonly dynamic: boolean;
}

export type FinalValidationResult = ValidationResult;
export type FinalValidator<Output> = Validator<Output>;

interface ProgramRunOptionsBase<Output> extends RunResourceOptions {
  maxDepth?: number;
  validate?: FinalValidator<Output>;
  onEvent?: (event: ProgramEvent) => void | Promise<void>;
  eventTimeoutMs?: number;
  maxRetainedEvents?: number;
}

export type ProgramRunOptions<Output> = ProgramRunOptionsBase<Output> & (
  | { provider?: DecisionProvider; session?: never }
  | { provider?: never; session?: DecisionSession }
);

type Evaluate = (context: ProgramContext<unknown>) => unknown | Promise<unknown>;
type Transform = (value: unknown, context: ProgramContext<unknown>) => unknown | Promise<unknown>;
type Bind = (value: unknown, context: ProgramContext<unknown>) => Program<unknown, unknown> | Promise<Program<unknown, unknown>>;

type Definition =
  | { readonly kind: 'node'; readonly id: string; readonly evaluate: Evaluate }
  | { readonly kind: 'map'; readonly id: string; readonly source: Definition; readonly transform: Transform }
  | { readonly kind: 'parallel'; readonly id: string; readonly children: readonly Definition[] }
  | { readonly kind: 'flatMap'; readonly id: string; readonly source: Definition; readonly bind: Bind }
  | { readonly kind: 'scope'; readonly source: Definition; readonly limits: Readonly<Partial<RunLimits>> };

type AnyProgram = Program<any, any>;
type ProgramInput<P> = P extends Program<infer Input, any> ? Input : never;
type ProgramOutput<P> = P extends Program<any, infer Output> ? Output : never;
type ParallelOutput<Programs extends readonly AnyProgram[]> = {
  readonly [Index in keyof Programs]: ProgramOutput<Programs[Index]>;
};
type IsUnion<Value, Whole = Value> = Value extends unknown ? ([Whole] extends [Value] ? false : true) : never;
type ParallelInput<Programs extends readonly AnyProgram[]> =
  Programs extends readonly [] ? unknown
    : Programs extends readonly [infer First extends AnyProgram, ...infer Rest extends readonly AnyProgram[]]
      ? ProgramInput<First> & ParallelInput<Rest>
      : ProgramInput<Programs[number]>;
type CompatiblePrograms<Programs extends readonly AnyProgram[]> =
  number extends Programs['length']
    ? true extends IsUnion<Programs[number]> ? never : Programs
    : [ParallelInput<Programs>] extends [never] ? never : Programs;

type ProgramEventInput = ProgramEvent extends infer Event
  ? Event extends ProgramEvent ? Omit<Event, 'schema' | 'runId' | 'sequence'> : never
  : never;

const UNBOUNDED_LIMITS: RunLimits = {
  decisions: Number.MAX_SAFE_INTEGER,
  nodes: Number.MAX_SAFE_INTEGER,
};
const DEFAULT_MAX_DEPTH = 256;
const DEFAULT_NODE_LIMIT = 10_000;
const DEFAULT_MAX_RETAINED_EVENTS = 10_000;
const DEFAULT_EVENT_TIMEOUT_MS = 5_000;

const detailOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const pathOf = (parent: string, id: string): string => parent.length === 0 ? id : `${parent}/${id}`;

class ProgramInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgramInvalidError';
  }
}

class ProgramDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgramDefinitionError';
  }
}

class EventObserverError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'EventObserverError';
  }
}

const assertId = (id: string): void => {
  if (typeof id !== 'string' || id.trim().length === 0) throw new ProgramDefinitionError('Program node IDs must be non-empty strings.');
  if (id.includes('/')) throw new ProgramDefinitionError(`Program node ID "${id}" cannot contain "/".`);
};

const freezeDefinition = (definition: Definition): Definition => {
  if (definition.kind === 'parallel') Object.freeze(definition.children);
  if (definition.kind === 'scope') Object.freeze(definition.limits);
  return Object.freeze(definition);
};

const rootId = (definition: Definition): string => definition.kind === 'scope' ? rootId(definition.source) : definition.id;

const emittedPaths = (definition: Definition, parentPath: string, paths: string[]): void => {
  if (definition.kind === 'scope') {
    emittedPaths(definition.source, parentPath, paths);
    return;
  }
  if (definition.kind === 'node') {
    paths.push(pathOf(parentPath, definition.id));
    return;
  }
  if (definition.kind === 'map' || definition.kind === 'flatMap') {
    emittedPaths(definition.source, parentPath, paths);
    paths.push(pathOf(parentPath, definition.id));
    return;
  }
  const path = pathOf(parentPath, definition.id);
  for (const child of definition.children) emittedPaths(child, path, paths);
  paths.push(path);
};

const validateStructure = (definition: Definition, active = new Set<Definition>(), root = true): void => {
  if (active.has(definition)) throw new ProgramDefinitionError('Program contains a static cycle.');
  active.add(definition);
  if (definition.kind !== 'scope') assertId(definition.id);
  if (definition.kind === 'parallel') {
    const ids = definition.children.map(rootId);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate !== undefined) throw new ProgramDefinitionError(`Program contains duplicate sibling node ID: ${duplicate}.`);
    for (const child of definition.children) validateStructure(child, active, false);
  } else if (definition.kind === 'map' || definition.kind === 'flatMap' || definition.kind === 'scope') {
    validateStructure(definition.source, active, false);
  }
  active.delete(definition);
  if (root) {
    const paths: string[] = [];
    emittedPaths(definition, '', paths);
    const duplicate = paths.find((path, index) => paths.indexOf(path) !== index);
    if (duplicate !== undefined) throw new ProgramDefinitionError(`Program contains duplicate static node path: ${duplicate}.`);
  }
};

const inspectDefinition = (definition: Definition, output: ProgramInspection[]): void => {
  if (definition.kind === 'scope') {
    inspectDefinition(definition.source, output);
    return;
  }
  if (definition.kind === 'map' || definition.kind === 'flatMap') inspectDefinition(definition.source, output);
  if (definition.kind === 'parallel') for (const child of definition.children) inspectDefinition(child, output);
  const dependencies = definition.kind === 'map' || definition.kind === 'flatMap'
    ? [rootId(definition.source)]
    : definition.kind === 'parallel' ? definition.children.map(rootId) : [];
  output.push(Object.freeze({
    id: definition.id,
    kind: definition.kind,
    dependencies: Object.freeze(dependencies),
    dynamic: definition.kind === 'flatMap',
  }));
};

const validateLimits = (definition: Definition, parent: RunLimits): void => {
  if (definition.kind === 'scope') {
    const narrowed = { ...parent };
    for (const [resource, limit] of Object.entries(definition.limits) as Array<[keyof RunLimits, number]>) {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new ProgramDefinitionError(`${resource} must be a non-negative safe integer.`);
      if (limit > parent[resource]) throw new ProgramDefinitionError(`${resource} child limit (${limit}) cannot exceed parent limit (${parent[resource]}).`);
      narrowed[resource] = limit;
    }
    validateLimits(definition.source, narrowed);
  } else if (definition.kind === 'parallel') {
    for (const child of definition.children) validateLimits(child, parent);
  } else if (definition.kind === 'map' || definition.kind === 'flatMap') {
    validateLimits(definition.source, parent);
  }
};

const definitions = new WeakMap<object, Definition>();
const definitionOf = (program: AnyProgram): Definition => {
  const definition = definitions.get(program);
  if (definition === undefined) throw new ProgramDefinitionError('Program identity is not owned by this runtime.');
  return definition;
};

export class Program<Input, Output> {
  protected declare readonly _input: (input: Input) => void;
  protected declare readonly _output: Output;

  private constructor(definition: Definition) {
    definitions.set(this, definition);
    Object.freeze(this);
  }

  static node<Input, Output>(id: string, evaluate: (context: ProgramContext<Input>) => Output | Promise<Output>): Program<Input, Output> {
    assertId(id);
    return new Program(freezeDefinition({ kind: 'node', id, evaluate: evaluate as Evaluate }));
  }

  static value<Input, Output>(id: string, output: Output): Program<Input, Output> {
    return Program.node(id, () => output);
  }

  static fromInput<Input, Output>(id: string, factory: (input: Input) => Output | Promise<Output>): Program<Input, Output> {
    return Program.node(id, ({ input }) => factory(input));
  }

  static parallel<const Programs extends readonly AnyProgram[]>(
    id: string,
    programs: Programs & CompatiblePrograms<Programs>,
  ): Program<ParallelInput<Programs>, ParallelOutput<Programs>> {
    assertId(id);
    const children = [...programs].map(program => definitionOf(program));
    const definition = freezeDefinition({ kind: 'parallel', id, children });
    validateStructure(definition);
    return new Program(definition);
  }

  map<Next>(id: string, transform: (value: Output, context: ProgramContext<Input>) => Next | Promise<Next>): Program<Input, Next> {
    assertId(id);
    const source = definitionOf(this);
    if (id === rootId(source)) throw new ProgramDefinitionError(`Program contains duplicate node ID: ${id}.`);
    const definition = freezeDefinition({ kind: 'map', id, source, transform: transform as Transform });
    validateStructure(definition);
    return new Program(definition);
  }

  flatMap<Next>(id: string, bind: (value: Output, context: ProgramContext<Input>) => Program<Input, Next> | Promise<Program<Input, Next>>): Program<Input, Next> {
    assertId(id);
    const source = definitionOf(this);
    if (id === rootId(source)) throw new ProgramDefinitionError(`Program contains duplicate node ID: ${id}.`);
    const definition = freezeDefinition({ kind: 'flatMap', id, source, bind: bind as Bind });
    validateStructure(definition);
    return new Program(definition);
  }

  withLimits(limits: Partial<RunLimits>): Program<Input, Output> {
    for (const [resource, limit] of Object.entries(limits)) {
      if (!Number.isSafeInteger(limit) || (limit as number) < 0) throw new ProgramDefinitionError(`${resource} must be a non-negative safe integer.`);
    }
    return new Program(freezeDefinition({ kind: 'scope', source: definitionOf(this), limits: { ...limits } }));
  }

  inspect(): readonly ProgramInspection[] {
    const inspection: ProgramInspection[] = [];
    inspectDefinition(definitionOf(this), inspection);
    return Object.freeze(inspection);
  }
}

export const node = Program.node;
export const value = Program.value;
export const fromInput = Program.fromInput;
export const parallel = Program.parallel;

interface Runtime<Input> {
  readonly input: Input;
  readonly resources: RunResources;
  readonly decisions?: DecisionSession;
  readonly maxDepth: number;
  readonly controller: AbortController;
  readonly events: ProgramEvent[];
  readonly maxRetainedEvents: number;
  readonly runId: string;
  readonly onEvent?: (event: ProgramEvent) => void | Promise<void>;
  readonly eventTimeoutMs: number;
  sequence: number;
  droppedEvents: number;
  primaryError?: unknown;
  observerFailure?: { readonly detail: string };
  eventTail: Promise<void>;
}

const emit = async <Input>(runtime: Runtime<Input>, event: ProgramEventInput, fatal = true): Promise<void> => {
  const complete = Object.freeze({ schema: 1 as const, runId: runtime.runId, sequence: ++runtime.sequence, ...event }) as ProgramEvent;
  runtime.events.push(complete);
  if (runtime.events.length > runtime.maxRetainedEvents) {
    runtime.events.shift();
    runtime.droppedEvents++;
  }
  if (runtime.onEvent !== undefined) {
    const terminal = event.type.startsWith('run-') && event.type !== 'run-started';
    const delivered = runtime.eventTail.catch(() => {}).then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new EventObserverError(
          `Program event observer did not settle within ${runtime.eventTimeoutMs}ms.`,
        )), runtime.eventTimeoutMs);
      });
      try {
        const observed = Promise.resolve().then(() => runtime.onEvent?.(complete)).catch(error => {
          throw new EventObserverError(`Program event observer rejected: ${detailOf(error)}`, { cause: error });
        });
        const delivery = Promise.race([observed, timeout]);
        await (terminal ? delivery : runtime.resources.raceSignal(delivery));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    });
    runtime.eventTail = delivered;
    if (terminal) {
      try {
        await delivered;
      } catch (error) {
        runtime.observerFailure = Object.freeze({ detail: detailOf(error) });
      }
      return;
    }
    if (fatal) {
      try {
        await delivered;
      } catch (error) {
        throw error;
      }
    } else await delivered.catch(() => {});
  }
};

const registerFailure = <Input>(runtime: Runtime<Input>, error: unknown): void => {
  if (runtime.primaryError !== undefined) return;
  runtime.primaryError = error;
  runtime.controller.abort(error);
};

const contextFor = <Input>(runtime: Runtime<Input>, resources: RunResources, nodeId: string, path: string): ProgramContext<Input> => {
  const context: ProgramContext<Input> = {
    input: runtime.input,
    signal: resources.signal,
    resources: resourceView(resources),
    ...(runtime.decisions === undefined ? {} : {
      decisions: rebindDecisionSession(runtime.decisions, resources).observe(result => {
        return emit(runtime, { type: 'decision-completed', nodeId, path, decision: result });
      }),
    }),
  };
  return Object.freeze(context);
};

const runNode = async <Input>(
  runtime: Runtime<Input>,
  resources: RunResources,
  id: string,
  path: string,
  depth: number,
  operation: (context: ProgramContext<Input>) => unknown | Promise<unknown>,
): Promise<unknown> => {
  resources.reserve('nodes');
  await emit(runtime, { type: 'node-ready', nodeId: id, path, depth });
  try {
    const result = await resources.withNodePermit(async () => {
      await emit(runtime, { type: 'node-started', nodeId: id, path, depth });
      return operation(contextFor(runtime, resources, id, path));
    });
    resources.throwIfAborted();
    await emit(runtime, { type: 'node-completed', nodeId: id, path, depth });
    return result;
  } catch (error) {
    let classified = error;
    if (runtime.primaryError === undefined && resources.signal.aborted) {
      try { resources.throwIfAborted(); } catch (abortError) { classified = abortError; }
    }
    if (runtime.primaryError !== undefined && classified === runtime.controller.signal.reason) {
      await emit(runtime, { type: 'node-cancelled', nodeId: id, path, depth, detail: detailOf(classified) }, false);
    } else if (classified instanceof ProgramInvalidError || classified instanceof ProgramDefinitionError) {
      registerFailure(runtime, classified);
      await emit(runtime, { type: 'node-invalid', nodeId: id, path, depth, detail: classified.message }, false);
    } else if (classified instanceof ResourceExhaustedError) {
      registerFailure(runtime, classified);
      await emit(runtime, { type: 'node-exhausted', nodeId: id, path, depth, evidence: classified.evidence }, false);
    } else if (classified instanceof CancelledError) {
      registerFailure(runtime, classified);
      await emit(runtime, { type: 'node-cancelled', nodeId: id, path, depth, detail: classified.message }, false);
    } else {
      registerFailure(runtime, classified);
      await emit(runtime, { type: 'node-failed', nodeId: id, path, depth, detail: detailOf(classified) }, false);
    }
    throw classified;
  }
};

const evaluate = async <Input>(
  definition: Definition,
  runtime: Runtime<Input>,
  resources: RunResources,
  parentPath: string,
  depth: number,
): Promise<unknown> => {
  resources.throwIfAborted();
  if (depth > runtime.maxDepth) {
    const error = new ProgramInvalidError(`Dynamic program depth ${depth} exceeds limit ${runtime.maxDepth}.`);
    registerFailure(runtime, error);
    throw error;
  }
  if (definition.kind === 'scope') {
    return evaluate(definition.source, runtime, resources.fork(undefined, definition.limits), parentPath, depth);
  }
  if (definition.kind === 'node') {
    const path = pathOf(parentPath, definition.id);
    return runNode(runtime, resources, definition.id, path, depth, context => definition.evaluate(context as ProgramContext<unknown>));
  }
  if (definition.kind === 'map') {
    const source = await evaluate(definition.source, runtime, resources, parentPath, depth);
    const path = pathOf(parentPath, definition.id);
    return runNode(runtime, resources, definition.id, path, depth, context => definition.transform(source, context as ProgramContext<unknown>));
  }
  if (definition.kind === 'parallel') {
    const path = pathOf(parentPath, definition.id);
    const settled: PromiseSettledResult<unknown>[] = new Array(definition.children.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < definition.children.length) {
        const index = next++;
        try {
          settled[index] = { status: 'fulfilled', value: await evaluate(definition.children[index]!, runtime, resources, path, depth + 1) };
        } catch (error) {
          registerFailure(runtime, error);
          settled[index] = { status: 'rejected', reason: error };
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(definition.children.length, resources.concurrency) },
      () => worker(),
    ));
    const failure = runtime.primaryError ?? settled.find(result => result?.status === 'rejected')?.reason;
    if (failure !== undefined) throw failure;
    const values = settled.map(result => (result as PromiseFulfilledResult<unknown>).value);
    return runNode(runtime, resources, definition.id, path, depth, async () => values);
  }
  const source = await evaluate(definition.source, runtime, resources, parentPath, depth);
  const path = pathOf(parentPath, definition.id);
  const child = await runNode(runtime, resources, definition.id, path, depth, context => definition.bind(source, context as ProgramContext<unknown>));
  if (!(child instanceof Program)) throw new ProgramInvalidError(`flatMap node "${definition.id}" did not return a Program.`);
  try {
    const childDefinition = definitionOf(child);
    validateStructure(childDefinition);
    validateLimits(childDefinition, resources.effectiveLimits());
  } catch (error) {
    if (error instanceof ProgramDefinitionError) throw new ProgramInvalidError(error.message);
    throw error;
  }
  return evaluate(definitionOf(child), runtime, resources, path, depth + 1);
};

const metadataFor = <Input>(runtime: Runtime<Input>): ProgramRunMetadata => Object.freeze({
  runId: runtime.runId,
  events: Object.freeze([...runtime.events]),
  droppedEvents: runtime.droppedEvents,
  resources: (() => {
    const snapshot = runtime.resources.snapshot();
    return Object.freeze({
      used: Object.freeze(snapshot.used),
      limits: Object.freeze(snapshot.limits),
      usage: Object.freeze(snapshot.usage),
      inflight: snapshot.inflight,
    });
  })(),
  ...(runtime.observerFailure === undefined ? {} : { observerFailure: runtime.observerFailure }),
});

export async function runProgram<Input, Output>(
  program: Program<Input, Output>,
  input: Input,
  options: ProgramRunOptions<Output> = {},
): Promise<ProgramRunOutcome<Output>> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) throw new Error('maxDepth must be a non-negative safe integer.');
  const maxRetainedEvents = options.maxRetainedEvents ?? DEFAULT_MAX_RETAINED_EVENTS;
  if (!Number.isSafeInteger(maxRetainedEvents) || maxRetainedEvents < 1) throw new Error('maxRetainedEvents must be a positive safe integer.');
  const eventTimeoutMs = options.eventTimeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS;
  if (!Number.isSafeInteger(eventTimeoutMs) || eventTimeoutMs < 1) throw new Error('eventTimeoutMs must be a positive safe integer.');
  const definition = definitionOf(program);
  validateStructure(definition);
  if (options.provider !== undefined && options.session !== undefined) throw new Error('Pass either provider or session, not both.');
  const existingResources = options.session === undefined ? undefined : decisionSessionResources(options.session);
  if (existingResources !== undefined && (options.concurrency !== undefined || options.timeoutMs !== undefined)) {
    throw new Error('Existing resources already define concurrency and timeout.');
  }
  const defaultNodeLimit = existingResources === undefined
    ? DEFAULT_NODE_LIMIT
    : Math.min(DEFAULT_NODE_LIMIT, existingResources.effectiveLimits().nodes);
  const runLimits = { nodes: defaultNodeLimit, ...options.limits };
  const rootLimits = existingResources === undefined
    ? { ...UNBOUNDED_LIMITS, ...runLimits }
    : { ...existingResources.effectiveLimits(), ...runLimits };
  validateLimits(definition, rootLimits);

  const controller = new AbortController();
  const signals = [options.signal, controller.signal].filter((signal): signal is AbortSignal => signal !== undefined);
  const resources = existingResources === undefined
    ? new RunResources({
      limits: runLimits,
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      signal: AbortSignal.any(signals),
    })
    : existingResources.fork(AbortSignal.any(signals), runLimits);
  const decisions = options.session === undefined
    ? (options.provider === undefined ? undefined : createDecisionSession(options.provider, resources))
    : rebindDecisionSession(options.session, resources);
  const runtime: Runtime<Input> = {
    input,
    resources,
    ...(decisions === undefined ? {} : { decisions }),
    maxDepth,
    controller,
    events: [],
    maxRetainedEvents,
    eventTimeoutMs,
    runId: randomUUID(),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    sequence: 0,
    droppedEvents: 0,
    eventTail: Promise.resolve(),
  };
  let outcome: ProgramRunOutcome<Output>;
  try {
    await emit(runtime, { type: 'run-started' });
    const output = await evaluate(definition, runtime, resources, '', 0) as Output;
    resources.throwIfAborted();
    const validation = await resources.raceSignal(validationDetail(
      output,
      options.validate,
      { signal: resources.signal, resources: resourceView(resources) },
      'Final program validation failed.',
    ));
    if (validation !== undefined) throw new ProgramInvalidError(validation);
    await emit(runtime, { type: 'run-completed', nodes: resources.snapshot().used.nodes });
    outcome = { status: 'completed', value: output, metadata: metadataFor(runtime) };
  } catch (caught) {
    const error = runtime.primaryError ?? caught;
    const nodes = resources.snapshot().used.nodes;
    if (error instanceof ProgramInvalidError || error instanceof ProgramDefinitionError) {
      await emit(runtime, { type: 'run-invalid', nodes, detail: error.message }, false);
      outcome = { status: 'invalid', detail: error.message, metadata: metadataFor(runtime) };
    } else if (error instanceof ResourceExhaustedError) {
      await emit(runtime, { type: 'run-exhausted', nodes, evidence: error.evidence }, false);
      outcome = { status: 'exhausted', evidence: error.evidence, metadata: metadataFor(runtime) };
    } else if (error instanceof CancelledError || (options.signal?.aborted && runtime.primaryError === undefined)) {
      const detail = detailOf(options.signal?.reason ?? error);
      await emit(runtime, { type: 'run-cancelled', nodes, detail }, false);
      outcome = { status: 'cancelled', detail, metadata: metadataFor(runtime) };
    } else {
      const detail = detailOf(error);
      await emit(runtime, { type: 'run-failed', nodes, detail }, false);
      outcome = { status: 'failed', error, detail, metadata: metadataFor(runtime) };
    }
  }
  await runtime.eventTail.catch(() => {});
  return outcome;
}
