import { DecisionSession } from './decisions.js';
import { Program } from './program.js';
import type { ChoiceDecisionResult, JsonObject } from './types.js';

export interface Route<Value> {
  readonly description: string;
  readonly value: Value;
}

export type RouteTable = Readonly<Record<string, Route<unknown>>>;

type RouteKey<Routes extends RouteTable> = keyof Routes & string;
type RouteSelection<Routes extends RouteTable> = {
  [Key in RouteKey<Routes>]: {
    readonly key: Key;
    readonly route: Routes[Key];
    readonly value: Routes[Key]['value'];
    readonly decision: ChoiceDecisionResult<RouteKey<Routes>>;
  }
}[RouteKey<Routes>];

export const route = <Value>(description: string, value: Value): Route<Value> =>
  Object.freeze({ description, value });

export class Router<const Routes extends RouteTable> {
  readonly routes: Routes;

  constructor(routes: Routes) {
    const entries = Object.entries(routes);
    if (entries.length < 2 || entries.length > 255) throw new Error('Router requires 2-255 routes.');
    for (const [key, candidate] of entries) {
      if (key.trim().length === 0) throw new Error('Route keys must be non-empty strings.');
      if (candidate.description.trim().length === 0) throw new Error(`Route "${key}" requires a description.`);
    }
    this.routes = Object.freeze({ ...routes });
    Object.freeze(this);
  }

  async select(
    decisions: DecisionSession,
    state: JsonObject,
    instructions: string,
  ): Promise<RouteSelection<Routes>> {
    const criteria = Object.fromEntries(
      Object.entries(this.routes).map(([key, candidate]) => [key, candidate.description]),
    ) as Record<RouteKey<Routes>, string>;
    const decision = await decisions.choose(state, instructions, criteria);
    const key = decision.value;
    const selected = this.routes[key]!;
    return Object.freeze({ key, route: selected, value: selected.value, decision }) as RouteSelection<Routes>;
  }

  program<Input>(
    id: string,
    instructions: string | ((input: Input) => string),
    state: (input: Input) => JsonObject,
  ): Program<Input, RouteSelection<Routes>> {
    return Program.node(id, async ({ input, decisions }) => {
      if (decisions === undefined) throw new Error('Router programs require a Jev decision provider.');
      const prompt = typeof instructions === 'function' ? instructions(input) : instructions;
      return this.select(decisions, state(input), prompt);
    });
  }
}

export const defineRouter = <const Routes extends RouteTable>(routes: Routes): Router<Routes> => new Router(routes);

export type { RouteSelection };
