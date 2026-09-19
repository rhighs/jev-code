import {
  DecisionSession,
  DecisionProgram,
  branch,
  defineRouter,
  parallel,
  route,
  runProgram,
  slot,
  type DecisionProvider,
  type Program,
  type RouteSelection,
  type TreeSlot,
} from 'jev-code';
// @ts-expect-error mutable RunResources is internal to the SDK runtime
import { RunResources } from 'jev-code';

declare const provider: DecisionProvider;
const languageProgram: Program = { body: [] };
const decisionProgram: DecisionProgram<void, number> = DecisionProgram.value('answer', 42);
const session = new DecisionSession(provider, { limits: { decisions: 1 } });
// @ts-expect-error program runs accept either a provider or a session, not both
runProgram(decisionProgram, undefined, { provider, session });
session.resources.snapshot();
// @ts-expect-error public resource views cannot mutate run accounting
session.resources.reserve('decisions');
// @ts-expect-error session rebinding is an internal same-run operation
session.withResources({});
const router = defineRouter({
  left: route('Choose left', { side: 'left' as const }),
  right: route('Choose right', { side: 'right' as const }),
});

type Selection = RouteSelection<typeof router.routes>;
declare const selection: Selection;
const side: 'left' | 'right' = selection.value.side;
void side;
void session;
void languageProgram;
void decisionProgram;

const acceptsId: DecisionProgram<{ id: string }, number> = DecisionProgram.value('id', 1);
const acceptsDetailed: DecisionProgram<{ id: string; active: boolean }, string> = DecisionProgram.value('detail', 'ok');
const safelyComposed: DecisionProgram<{ id: string; active: boolean }, readonly [number, string]> =
  parallel('compatible', [acceptsId, acceptsDetailed] as const);
// @ts-expect-error a program requiring id cannot be widened to arbitrary objects
const unsafelyWidened: DecisionProgram<object, number> = acceptsId;
declare const heterogeneous: Array<DecisionProgram<string, number> | DecisionProgram<number, number>>;
// @ts-expect-error a heterogeneous union array has no shared callable input
parallel('heterogeneous', heterogeneous);

const idSlot = slot<{ id: string }, string>({
  id: 'id-slot', description: 'Needs an id', productions: [],
});
// @ts-expect-error a slot requiring id cannot be widened to arbitrary objects
const widenedSlot: TreeSlot<object, string> = idSlot;
// @ts-expect-error a parent accepting arbitrary objects cannot attach a narrower child
branch<object, string, { child: TreeSlot<object, string> }>('unsafe-child', 'Unsafe child', { child: idSlot }, children => children.child);
void safelyComposed;
void unsafelyWidened;
void widenedSlot;
void RunResources;
