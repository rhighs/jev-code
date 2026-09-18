import type { AstAdapter } from '../ast-adapters.js';
import { javascriptAstAdapter, typescriptAstAdapter } from './javascript.js';

export const bundledAstAdapters = (): AstAdapter[] => [javascriptAstAdapter, typescriptAstAdapter];
