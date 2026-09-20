export interface PythonNode { _type: string; [field: string]: unknown }
export const node = (_type: string, fields: Record<string, unknown> = {}): PythonNode => ({ _type, ...fields });
export const name = (id: string, store = false): PythonNode => node('Name', { id, ctx: node(store ? 'Store' : 'Load') });
export interface Symbol { kind: 'builtin' | 'variable' | 'parameter' | 'function' | 'module'; arity?: number }
export interface Scope { names: Map<string, Symbol>; parent?: Scope; function: boolean; loop: boolean }
export interface Vocab { words: string[]; identifiers: string[]; strings: string[]; numbers: number[]; purposes: string[] }
export interface Builder {
  pick(slot: string, scope: Scope, criteria: Record<string, string>, depth?: number): Promise<string>;
  terminal(slot: string, scope: Scope, values: Array<string | number>): Promise<string | number>;
  identifier(slot: string, scope: Scope, exclude?: string[]): Promise<string>;
  expression(target: PythonNode, scope: Scope, depth: number, slot?: string, numberConstraint?: 'positive' | 'nonzero', calls?: number): Promise<void>;
  block(body: PythonNode[], scope: Scope, depth: number, slot: string): Promise<void>;
}

export const functionDef = (id: string, parameters: PythonNode[], body: PythonNode[]): PythonNode =>
  node('FunctionDef', { name: id, args: node('arguments', { posonlyargs: [], args: parameters, vararg: null, kwonlyargs: [], kw_defaults: [], kwarg: null, defaults: [] }), body, decorator_list: [], returns: null, type_comment: null, type_params: [] });
