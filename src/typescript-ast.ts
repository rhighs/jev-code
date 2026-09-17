import ts from 'typescript';
import type { AstAdapter } from './ast-adapters.js';
import { LimitError } from './types.js';
import { gridCursor } from './grid.js';

/** An installable starter grammar using the actual TypeScript compiler AST. */
export const typescriptAstAdapter: AstAdapter = {
  id: 'typescript', extensions: ['.ts', '.tsx', '.mts', '.cts'], languages: ['typescript'],
  async validate(source, signal) {
    signal.throwIfAborted();
    const errors = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [];
    if (errors.length) throw new Error(errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
  },
  async generate(decisions, state, field, options) {
    const task = state.task as { prompt?: string; updates?: string[] } | undefined;
    const objective = [task?.prompt ?? '', ...(task?.updates ?? [])].join('\n');
    const words = objective.match(/[A-Za-z_][A-Za-z_0-9]*/g) ?? [];
    const strings = [...new Set([...objective.matchAll(/"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`/g)].map(match => match[1] ?? match[2] ?? match[3]!).concat(words.flatMap((word, index) => {
      const phrase = words.slice(index, index + 2).join(' ');
      return [word, phrase, phrase[0]!.toUpperCase() + phrase.slice(1) + '!'];
    })))].slice(0, 200);
    const identifiers = [...new Set(words.filter(word => /^[a-z_][a-z_0-9]*$/.test(word) && !['const', 'let', 'return', 'function', 'class', 'export', 'import', 'new', 'if', 'for', 'while', 'var', 'true', 'false', 'null', 'this', 'default', 'delete', 'await', 'async', 'yield', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'in', 'instanceof', 'typeof', 'void', 'with', 'super', 'extends', 'enum', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'static'].includes(word)).concat(['message', 'result', 'value']))].slice(0, 200);
    const numbers = [...new Set([0, 1, 2, ...(objective.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)])].filter(Number.isFinite).slice(0, 200);
    const statements: ts.Statement[] = [], symbols = new Set<string>();
    const factory = ts.factory, printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const render = () => printer.printFile(factory.createSourceFile(statements, factory.createToken(ts.SyntaxKind.EndOfFileToken), ts.NodeFlags.None));
    let steps = 0;
    async function choose(slot: string, criteria: Record<string, string>): Promise<string> {
      decisions.signal.throwIfAborted();
      if (++steps > options.maxSteps) throw new LimitError('TypeScript AST production budget exhausted.');
      const keys = Object.keys(criteria);
      if (!keys.length) throw new Error(`No terminal candidates for ${slot}. Supply explicit literal values in the objective.`);
      const source = render();
      if (Buffer.byteLength(JSON.stringify({ objective, source, criteria })) > 16_000) throw new LimitError('TypeScript AST decision context exceeds its budget.');
      const selected = keys.length === 1 ? keys[0]! : await decisions.choose({ task: { prompt: objective }, generation: {
        phase: 'ast', field, slot, partialSource: source, symbols: [...symbols], constraints: { maxDepth: 6, remainingSteps: options.maxSteps - steps },
      } }, `Choose a valid TypeScript AST production for ${slot}. Satisfy the objective with minimal code.`, criteria);
      await options.onText?.(field, source, false, { replace: source }, { decoder: 'ast', step: steps, cursor: gridCursor(source), bytes: Buffer.byteLength(source), ast: { slot, production: selected, symbols: [...symbols] } });
      return selected;
    }
    async function terminal(slot: string, values: Array<string | number>): Promise<string | number> {
      const key = await choose(slot, Object.fromEntries(values.map((value, index) => [`value_${index}`, JSON.stringify(value)])));
      return values[Number(key.slice(6))]!;
    }
    async function expression(depth = 0): Promise<ts.Expression> {
      const criteria: Record<string, string> = { string: 'String literal from the objective.', number: 'Number literal.', true: 'true', false: 'false', null: 'null' };
      if (symbols.size) criteria.name = 'Reference a defined variable.';
      if (depth < 6) criteria.binary = 'Arithmetic combining two expressions.';
      const production = await choose('expression', criteria);
      if (production === 'string') return factory.createStringLiteral(String(await terminal('string', strings)));
      if (production === 'number') {
        const number = Number(await terminal('number', numbers));
        return number < 0 ? factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, factory.createNumericLiteral(-number)) : factory.createNumericLiteral(number);
      }
      if (production === 'name') return factory.createIdentifier(String(await terminal('reference', [...symbols])));
      if (production === 'true') return factory.createTrue();
      if (production === 'false') return factory.createFalse();
      if (production === 'null') return factory.createNull();
      const ops = { add: ts.SyntaxKind.PlusToken, subtract: ts.SyntaxKind.MinusToken, multiply: ts.SyntaxKind.AsteriskToken, divide: ts.SyntaxKind.SlashToken } as const;
      const op = await choose('operator', { add: '+', subtract: '-', multiply: '*', divide: '/' }) as keyof typeof ops;
      return factory.createBinaryExpression(await expression(depth + 1), factory.createToken(ops[op]), await expression(depth + 1));
    }
    while (true) {
      const criteria: Record<string, string> = { print: 'Print an expression with console.log.', assign: 'Declare a const variable.' };
      if (statements.length || options.allowEmpty) criteria.finish = 'The objective is satisfied; complete the AST.';
      const production = await choose('module_body', criteria);
      if (production === 'finish') return render();
      if (production === 'print') statements.push(factory.createExpressionStatement(factory.createCallExpression(factory.createPropertyAccessExpression(factory.createIdentifier('console'), 'log'), undefined, [await expression()])));
      else {
        const id = String(await terminal('identifier', identifiers.filter(value => !symbols.has(value))));
        statements.push(factory.createVariableStatement(undefined, factory.createVariableDeclarationList([factory.createVariableDeclaration(id, undefined, undefined, await expression())], ts.NodeFlags.Const)));
        symbols.add(id);
      }
    }
  },
};
