import { Program, parallel, runProgram, type FinalValidationResult, type FinalValidator, type ProgramContext, type ProgramRunOptions } from './program.js';
import type { JsonObject, ProgramRunOutcome } from './types.js';
import { validationDetail, type Validator } from './validation.js';

export type TreeValidationResult = FinalValidationResult;
export type TreeValidator<Value> = Validator<Value>;

export interface ProductionContext<Input> extends ProgramContext<Input> {}

export interface CompleteProduction<Input, Output> {
  readonly kind: 'complete';
  readonly id: string;
  readonly description: string;
  readonly valid?: TreeValidator<Input>;
  readonly complete: (context: ProductionContext<Input>) => Output | Promise<Output>;
}

type AnySlot<Input> = TreeSlot<Input, unknown>;
type ChildSlots<Input> = Readonly<Record<string, AnySlot<Input>>>;
type SlotOutput<Slot> = Slot extends TreeSlot<any, infer Output> ? Output : never;
type ChildValues<Children extends ChildSlots<any>> = {
  readonly [Key in keyof Children]: SlotOutput<Children[Key]>;
};
export type ChildSlotFactory<Input, Children extends ChildSlots<Input>> =
  (context: ProductionContext<Input>) => Children | Promise<Children>;

export interface BranchProduction<Input, Output, Children extends ChildSlots<Input> = ChildSlots<Input>> {
  readonly kind: 'branch';
  readonly id: string;
  readonly description: string;
  readonly children: Children | ChildSlotFactory<Input, Children>;
  readonly valid?: TreeValidator<Input>;
  assemble(children: ChildValues<Children>, context: ProductionContext<Input>): Output | Promise<Output>;
}

export type Production<Input, Output> =
  | CompleteProduction<Input, Output>
  | BranchProduction<Input, Output, ChildSlots<Input>>;

export interface SlotOptions<Input, Output> {
  readonly id: string;
  readonly description: string;
  readonly productions: readonly Production<Input, Output>[];
  readonly validate?: TreeValidator<Output>;
}

export class TreeDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TreeDefinitionError';
  }
}

const slotDefinitions = new WeakMap<object, SlotOptions<any, any>>();

export class TreeSlot<Input, Output> {
  protected declare readonly _input: (input: Input) => void;
  protected declare readonly _output: Output;

  constructor(options: SlotOptions<Input, Output>) {
    slotDefinitions.set(this, Object.freeze({ ...options, productions: Object.freeze([...options.productions]) }));
    Object.freeze(this);
  }
}

export const slot = <Input, Output>(options: SlotOptions<Input, Output>): TreeSlot<Input, Output> =>
  new TreeSlot(options);

export const complete = <Input, Output>(
  id: string,
  description: string,
  build: (context: ProductionContext<Input>) => Output | Promise<Output>,
  valid?: TreeValidator<Input>,
): CompleteProduction<Input, Output> => Object.freeze({ kind: 'complete', id, description, complete: build, ...(valid === undefined ? {} : { valid }) });

export const branch = <Input, Output, const Children extends ChildSlots<Input>>(
  id: string,
  description: string,
  children: Children | ChildSlotFactory<Input, Children>,
  assemble: (children: ChildValues<Children>, context: ProductionContext<Input>) => Output | Promise<Output>,
  valid?: TreeValidator<Input>,
): BranchProduction<Input, Output, Children> => Object.freeze({
  kind: 'branch', id, description,
  children: typeof children === 'function' ? children : Object.freeze({ ...children }), assemble,
  ...(valid === undefined ? {} : { valid }),
});

type TreeResolution<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly detail: string };

const resolved = <Value>(value: Value): TreeResolution<Value> => Object.freeze({ ok: true, value });
const rejected = <Value>(detail: string): TreeResolution<Value> => Object.freeze({ ok: false, detail });
const MAX_PRODUCTIONS_PER_SLOT = 255;
const DEFAULT_STATIC_SLOT_LIMIT = 10_000;
const DEFAULT_STATIC_EDGE_LIMIT = 10_000;

const definitionOf = <Input, Output>(treeSlot: TreeSlot<Input, Output>): SlotOptions<Input, Output> => {
  const definition = slotDefinitions.get(treeSlot) as SlotOptions<Input, Output> | undefined;
  if (definition === undefined) throw new TreeDefinitionError('Tree slot identity is not owned by this runtime.');
  return definition;
};

const assertName = (kind: string, id: string): void => {
  if (typeof id !== 'string' || id.trim().length === 0) throw new TreeDefinitionError(`${kind} IDs must be non-empty strings.`);
  if (id.includes('/')) throw new TreeDefinitionError(`${kind} ID "${id}" cannot contain "/".`);
};

interface GrammarRegistry {
  readonly slots: Set<object>;
  readonly slotIds: Set<string>;
  slotsUsed: number;
  edgesUsed: number;
}

interface GrammarLimits {
  readonly slots: number;
  readonly edges: number;
}

const childEntries = <Input>(production: BranchProduction<Input, unknown>): Array<[string, AnySlot<Input>]> | undefined =>
  typeof production.children === 'function' ? undefined : Object.entries(production.children);

const validateEntries = <Input>(productionId: string, entries: Array<[string, AnySlot<Input>]>): void => {
  if (entries.length === 0) throw new TreeDefinitionError(`Branch production "${productionId}" requires at least one child slot.`);
  for (const [name, child] of entries) {
    if (name.trim().length === 0) throw new TreeDefinitionError(`Branch production "${productionId}" has an unnamed child slot.`);
    if (child === undefined || child === null) throw new TreeDefinitionError(`Branch production "${productionId}" is missing child slot "${name}".`);
  }
};

const validateGrammar = <Input>(
  roots: readonly TreeSlot<Input, unknown>[],
  limits: GrammarLimits,
  registry: GrammarRegistry = { slots: new Set(), slotIds: new Set(), slotsUsed: 0, edgesUsed: 0 },
  ancestors: ReadonlySet<object> = new Set(),
): GrammarRegistry => {
  type Work = { readonly kind: 'enter'; readonly treeSlot: TreeSlot<Input, unknown> } | { readonly kind: 'exit'; readonly treeSlot: TreeSlot<Input, unknown> };
  const active = new Set<object>(ancestors);
  const stack: Work[] = [...roots].reverse().map(treeSlot => ({ kind: 'enter', treeSlot }));
  while (stack.length > 0) {
    const work = stack.pop()!;
    if (work.kind === 'exit') {
      active.delete(work.treeSlot);
      continue;
    }
    const definition = definitionOf(work.treeSlot);
    if (active.has(work.treeSlot)) throw new TreeDefinitionError(`Tree grammar contains a cycle at slot "${definition.id}".`);
    if (registry.slots.has(work.treeSlot) || registry.slotIds.has(definition.id)) {
      throw new TreeDefinitionError(`Tree grammar contains duplicate slot identity: ${definition.id}.`);
    }
    if (++registry.slotsUsed > limits.slots) throw new TreeDefinitionError(`Tree grammar exceeds the static slot preflight budget (${limits.slots}).`);
    assertName('Slot', definition.id);
    if (definition.description.trim().length === 0) throw new TreeDefinitionError(`Slot "${definition.id}" requires a description.`);
    if (definition.productions.length > MAX_PRODUCTIONS_PER_SLOT) {
      throw new TreeDefinitionError(`Slot "${definition.id}" cannot contain more than ${MAX_PRODUCTIONS_PER_SLOT} productions.`);
    }
    registry.slots.add(work.treeSlot);
    registry.slotIds.add(definition.id);
    active.add(work.treeSlot);
    stack.push({ kind: 'exit', treeSlot: work.treeSlot });
    const descendants: TreeSlot<Input, unknown>[] = [];
    const productionIds = new Set<string>();
    for (const production of definition.productions) {
      assertName('Production', production.id);
      if (productionIds.has(production.id)) throw new TreeDefinitionError(`Slot "${definition.id}" contains duplicate production identity: ${production.id}.`);
      productionIds.add(production.id);
      if (production.description.trim().length === 0) throw new TreeDefinitionError(`Production "${production.id}" requires a description.`);
      if (production.kind !== 'branch') continue;
      const entries = childEntries(production);
      if (entries === undefined) continue;
      validateEntries(production.id, entries);
      registry.edgesUsed += entries.length;
      if (registry.edgesUsed > limits.edges) throw new TreeDefinitionError(`Tree grammar exceeds the static edge preflight budget (${limits.edges}).`);
      descendants.push(...entries.map(([, child]) => child));
    }
    for (let index = descendants.length - 1; index >= 0; index--) stack.push({ kind: 'enter', treeSlot: descendants[index]! });
  }
  return registry;
};

const cloneRegistry = (registry: GrammarRegistry): GrammarRegistry => ({
  slots: new Set(registry.slots),
  slotIds: new Set(registry.slotIds),
  slotsUsed: registry.slotsUsed,
  edgesUsed: registry.edgesUsed,
});

export interface TreeProgramOptions<Input> {
  readonly state?: (slot: { readonly id: string; readonly description: string }, input: Input) => JsonObject;
  readonly instructions?: (slot: { readonly id: string; readonly description: string }, input: Input) => string;
  readonly maxDepth?: number;
  readonly maxStaticSlots?: number;
  readonly maxStaticEdges?: number;
}

const compileSlot = <Input, Output>(
  treeSlot: TreeSlot<Input, Output>,
  options: TreeProgramOptions<Input>,
  depth: number,
  staticRegistry: GrammarRegistry,
  registries: WeakMap<object, GrammarRegistry>,
  grammarLimits: GrammarLimits,
  ancestors: ReadonlySet<object>,
): Program<Input, TreeResolution<Output>> => {
  const definition = definitionOf(treeSlot);
  return Program.node<Input, TreeResolution<Production<Input, Output>>>(definition.id, async context => {
    if (options.maxDepth !== undefined && depth > options.maxDepth) {
      return rejected(`Tree depth ${depth} exceeds limit ${options.maxDepth}.`);
    }
    const candidates: Production<Input, Output>[] = [];
    for (const production of definition.productions) {
      const detail = await validationDetail(
        context.input,
        production.valid,
        context,
        `Production "${production.id}" is invalid.`,
      );
      if (detail === undefined) candidates.push(production);
    }
    if (candidates.length === 0) return rejected(`Slot "${definition.id}" has no valid productions.`);
    if (candidates.length === 1) return resolved(candidates[0]!);
    if (context.decisions === undefined) throw new Error('Tree programs require a Jev decision provider when a slot has multiple valid productions.');
    const identity = { id: definition.id, description: definition.description };
    const state = options.state?.(identity, context.input) ?? { slot: definition.id };
    const instructions = options.instructions?.(identity, context.input) ?? `Choose a production for ${definition.description}.`;
    const criteria = Object.fromEntries(candidates.map(production => [production.id, production.description]));
    const decision = await context.decisions.choose(state, instructions, criteria);
    return resolved(candidates.find(production => production.id === decision.value)!);
  }).flatMap(`${definition.id}:expand`, selection => {
    if (!selection.ok) return Program.value<Input, TreeResolution<Output>>(`${definition.id}:invalid`, rejected(selection.detail));
    const production = selection.value;
    if (production.kind === 'complete') {
      return Program.node<Input, TreeResolution<Output>>(`${definition.id}:complete`, async context => {
        const value = await production.complete(context);
        const detail = await validationDetail(value, definition.validate, context, `Slot "${definition.id}" validation failed.`);
        return detail === undefined ? resolved(value) : rejected(detail);
      });
    }
    return Program.node<Input, { readonly entries: Array<[string, AnySlot<Input>]>; readonly context: ProductionContext<Input> }>(`${definition.id}:admit`, async context => {
      const children = typeof production.children === 'function' ? await production.children(context) : production.children;
      if (typeof children !== 'object' || children === null || Array.isArray(children)) {
        throw new TreeDefinitionError(`Branch production "${production.id}" did not return named child slots.`);
      }
      const entries = Object.entries(children);
      validateEntries(production.id, entries);
      if (typeof production.children === 'function') {
        let registry = registries.get(context.resources);
        if (registry === undefined) {
          registry = cloneRegistry(staticRegistry);
          registries.set(context.resources, registry);
        }
        validateGrammar(entries.map(([, child]) => child), grammarLimits, registry, new Set([...ancestors, treeSlot]));
      }
      return { entries, context };
    }).flatMap(`${definition.id}:children`, admitted => {
      const nextAncestors = new Set([...ancestors, treeSlot]);
      const children = admitted.entries.map(([, child]) => compileSlot(
        child, options, depth + 1, staticRegistry, registries, grammarLimits, nextAncestors,
      ));
      return parallel(`${definition.id}:parallel`, children).map(`${definition.id}:assemble`, async (values, context) => {
      const failed = values.find(value => !value.ok);
      if (failed !== undefined && !failed.ok) return rejected<Output>(failed.detail);
      const childValues = Object.fromEntries(admitted.entries.map(([name], index) => {
        const child = values[index]!;
        if (!child.ok) throw new Error('Rejected child remained after tree validation.');
        return [name, child.value];
      })) as ChildValues<ChildSlots<Input>>;
      const value = await production.assemble(childValues, context);
      const detail = await validationDetail(value, definition.validate, context, `Slot "${definition.id}" validation failed.`);
      return detail === undefined ? resolved(value) : rejected<Output>(detail);
      });
    });
  });
};

export const treeProgram = <Input, Output>(
  root: TreeSlot<Input, Output>,
  options: TreeProgramOptions<Input> = {},
): Program<Input, TreeResolution<Output>> => {
  if (options.maxDepth !== undefined && (!Number.isSafeInteger(options.maxDepth) || options.maxDepth < 0)) {
    throw new TreeDefinitionError('maxDepth must be a non-negative safe integer.');
  }
  const maxStaticSlots = options.maxStaticSlots ?? DEFAULT_STATIC_SLOT_LIMIT;
  const maxStaticEdges = options.maxStaticEdges ?? DEFAULT_STATIC_EDGE_LIMIT;
  if (!Number.isSafeInteger(maxStaticSlots) || maxStaticSlots < 1) throw new TreeDefinitionError('maxStaticSlots must be a positive safe integer.');
  if (!Number.isSafeInteger(maxStaticEdges) || maxStaticEdges < 0) throw new TreeDefinitionError('maxStaticEdges must be a non-negative safe integer.');
  const grammarLimits = { slots: maxStaticSlots, edges: maxStaticEdges };
  const staticRegistry = validateGrammar([root as TreeSlot<Input, unknown>], grammarLimits);
  return compileSlot(root, options, 0, staticRegistry, new WeakMap(), grammarLimits, new Set());
};

type DistributiveOmit<Value, Keys extends PropertyKey> = Value extends unknown ? Omit<Value, Keys> : never;

export type TreeRunOptions<Input, Output> = DistributiveOmit<ProgramRunOptions<TreeResolution<Output>>, 'validate' | 'maxDepth'> & TreeProgramOptions<Input> & {
  readonly validate?: FinalValidator<Output>;
};

export async function runTree<Input, Output>(
  root: TreeSlot<Input, Output>,
  input: Input,
  options: TreeRunOptions<Input, Output> = {},
): Promise<ProgramRunOutcome<Output>> {
  const { state, instructions, maxDepth, maxStaticSlots, maxStaticEdges, validate, ...runOptions } = options;
  const program = treeProgram(root, {
    ...(state === undefined ? {} : { state }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(maxStaticSlots === undefined ? {} : { maxStaticSlots }),
    ...(maxStaticEdges === undefined ? {} : { maxStaticEdges }),
  });
  const outcome = await runProgram(program, input, {
    ...runOptions,
    // A selected branch admits children, enters a parallel layer, and then compiles the next slot.
    ...(maxDepth === undefined ? {} : {
      maxDepth: maxDepth > (Number.MAX_SAFE_INTEGER - 2) / 3 ? Number.MAX_SAFE_INTEGER : maxDepth * 3 + 2,
    }),
    validate: async (result, context) => {
      if (!result.ok) return result.detail;
      return validate?.(result.value, context);
    },
  } as ProgramRunOptions<TreeResolution<Output>>);
  if (outcome.status === 'failed' && outcome.error instanceof TreeDefinitionError) throw outcome.error;
  if (outcome.status !== 'completed') return outcome;
  if (!outcome.value.ok) throw new Error('Completed tree program has no value.');
  return { status: 'completed', value: outcome.value.value, metadata: outcome.metadata };
}

export type { ChildSlots, ChildValues, SlotOutput, TreeResolution };
