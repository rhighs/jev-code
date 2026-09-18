import type { AstAdapter } from '../ast-adapters.js';
import { cAstAdapter } from './c.js';
import { goAstAdapter } from './go.js';
import { javascriptAstAdapter, typescriptAstAdapter } from './javascript.js';
import { luaAstAdapter } from './lua.js';
import { rubyAstAdapter } from './ruby.js';
import { rustAstAdapter } from './rust.js';

export const bundledAstAdapters = (): AstAdapter[] => [javascriptAstAdapter, typescriptAstAdapter, cAstAdapter, rustAstAdapter, goAstAdapter, luaAstAdapter, rubyAstAdapter];
