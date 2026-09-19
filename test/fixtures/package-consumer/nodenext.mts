import {
  DecisionSession,
  defineRouter,
  route,
  type DecisionProvider,
  type RouteSelection,
} from 'jev-code';

declare const provider: DecisionProvider;
const session = new DecisionSession(provider, { limits: { decisions: 1 } });
const router = defineRouter({
  left: route('Choose left', { side: 'left' as const }),
  right: route('Choose right', { side: 'right' as const }),
});

type Selection = RouteSelection<typeof router.routes>;
declare const selection: Selection;
const side: 'left' | 'right' = selection.value.side;
void side;
void session;
