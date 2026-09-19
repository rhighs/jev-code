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

export interface BranchProduction<Input, Output, Children extends ChildSlots<Input> = ChildSlots<Input>> {
  readonly kind: 'branch';
  readonly id: string;
  readonly description: string;
  readonly children: Children;
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
  private declare readonly _input: (input: Input) => void;
  private declare readonly _output: Output;

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
  children: Children,
  assemble: (children: ChildValues<Children>, context: ProductionContext<Input>) => Output | Promise<Output>,
  valid?: TreeValidator<Input>,
): BranchProduction<Input, Output, Children> => Object.freeze({
  kind: 'branch', id, description, children: Object.freeze({ ...children }), assemble,
  ...(valid === undefined ? {} : { valid }),
});

type TreeResolution<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly detail: string };

const resolved = <Value>(value: Value): TreeResolution<Value> => Object.freeze({ ok: true, value });
const rejected = <Value>(detail: string): TreeResolution<Value> => Object.freeze({ ok: false, detail });
const MAX_PRODUCTIONS_PER_SLOT = 255;

const definitionOf = <Input, Output>(treeSlot: TreeSlot<Input, Output>): SlotOptions<Input, Output> => {
  const definition = slotDefinitions.get(treeSlot) as SlotOptions<Input, Output> | undefined;
  if (definition === undefined) throw new TreeDefinitionError('Tree slot identity is not owned by this runtime.');
  return definition;
};

const assertName = (kind: string, id: string): void => {
  if (typeof id !== 'string' || id.trim().length === 0) throw new TreeDefinitionError(`${kind} IDs must be non-empty strings.`);
  if (id.includes('/')) throw new TreeDefinitionError(`${kind} ID "${id}" cannot contain "/".`);
};

const validateGrammar = <Input>(root: TreeSlot<Input, unknown>): void => {
  const active = new Set<object>();
  const seenSlots = new Set<object>();
  const slotIds = new Set<string>();
  const visit = (treeSlot: TreeSlot<Input, unknown>): void => {
    if (active.has(treeSlot)) throw new TreeDefinitionError(`Tree grammar contains a cycle at slot "${definitionOf(treeSlot).id}".`);
    const definition = definitionOf(treeSlot);
    if (seenSlots.has(treeSlot) || slotIds.has(definition.id)) throw new TreeDefinitionError(`Tree grammar contains duplicate slot identity: ${definition.id}.`);
    assertName('Slot', definition.id);
    if (definition.description.trim().length === 0) throw new TreeDefinitionError(`Slot "${definition.id}" requires a description.`);
    if (definition.productions.length > MAX_PRODUCTIONS_PER_SLOT) {
      throw new TreeDefinitionError(`Slot "${definition.id}" cannot contain more than ${MAX_PRODUCTIONS_PER_SLOT} productions.`);
    }
    seenSlots.add(treeSlot);
    slotIds.add(definition.id);
    active.add(treeSlot);
    const productionIds = new Set<string>();
    for (const production of definition.productions) {
      assertName('Production', production.id);
      if (productionIds.has(production.id)) throw new TreeDefinitionError(`Slot "${definition.id}" contains duplicate production identity: ${production.id}.`);
      productionIds.add(production.id);
      if (production.description.trim().length === 0) throw new TreeDefinitionError(`Production "${production.id}" requires a description.`);
      if (production.kind === 'branch') {
        const entries = Object.entries(production.children);
        if (entries.length === 0) throw new TreeDefinitionError(`Branch production "${production.id}" requires at least one child slot.`);
        for (const [name, child] of entries) {
          if (name.trim().length === 0) throw new TreeDefinitionError(`Branch production "${production.id}" has an unnamed child slot.`);
          if (child === undefined || child === null) throw new TreeDefinitionError(`Branch production "${production.id}" is missing child slot "${name}".`);
          visit(child);
        }
      }
    }
    active.delete(treeSlot);
  };
  visit(root);
};

export interface TreeProgramOptions<Input> {
  readonly state?: (slot: { readonly id: string; readonly description: string }, input: Input) => JsonObject;
  readonly instructions?: (slot: { readonly id: string; readonly description: string }, input: Input) => string;
  readonly maxDepth?: number;
}

const compileSlot = <Input, Output>(
  treeSlot: TreeSlot<Input, Output>,
  options: TreeProgramOptions<Input>,
  depth: number,
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
    const entries = Object.entries(production.children);
    const children = entries.map(([, child]) => compileSlot(child, options, depth + 1));
    return parallel(`${definition.id}:children`, children).map(`${definition.id}:assemble`, async (values, context) => {
      const failed = values.find(value => !value.ok);
      if (failed !== undefined && !failed.ok) return rejected<Output>(failed.detail);
      const childValues = Object.fromEntries(entries.map(([name], index) => {
        const child = values[index]!;
        if (!child.ok) throw new Error('Rejected child remained after tree validation.');
        return [name, child.value];
      })) as ChildValues<typeof production.children>;
      const value = await production.assemble(childValues, context);
      const detail = await validationDetail(value, definition.validate, context, `Slot "${definition.id}" validation failed.`);
      return detail === undefined ? resolved(value) : rejected<Output>(detail);
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
  validateGrammar(root as TreeSlot<Input, unknown>);
  return compileSlot(root, options, 0);
};

export interface TreeRunOptions<Input, Output> extends Omit<ProgramRunOptions<TreeResolution<Output>>, 'validate' | 'maxDepth'>, TreeProgramOptions<Input> {
  readonly validate?: FinalValidator<Output>;
}

export async function runTree<Input, Output>(
  root: TreeSlot<Input, Output>,
  input: Input,
  options: TreeRunOptions<Input, Output> = {},
): Promise<ProgramRunOutcome<Output>> {
  const { state, instructions, maxDepth, validate, ...runOptions } = options;
  const program = treeProgram(root, {
    ...(state === undefined ? {} : { state }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
  });
  const outcome = await runProgram(program, input, {
    ...runOptions,
    validate: async (result, context) => {
      if (!result.ok) return result.detail;
      return validate?.(result.value, context);
    },
  });
  if (outcome.status !== 'completed') return outcome;
  if (!outcome.value.ok) throw new Error('Completed tree program has no value.');
  return { status: 'completed', value: outcome.value.value, metadata: outcome.metadata };
}

export type { ChildSlots, ChildValues, SlotOutput, TreeResolution };
