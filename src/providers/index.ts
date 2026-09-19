import type { AstRegistry } from '../ast-adapters.js';
import { readConfig } from '../config.js';
import { proposeTool } from '../propose/tool.js';
import type { Tool } from '../types.js';
import { providerSpec } from './catalog.js';
import { credentialFor } from './credentials.js';
import { withFreshToken } from './oauth.js';
import type { Credential, ModelRow, ProposalProvider, ProposalRequest } from './types.js';
import { complete, type Prompt } from './wire.js';

type Warn = (line: string) => void;

const SYSTEM = 'You produce candidate content only. Output exactly the requested content with no explanation and no code fences.';

const prompt = (req: ProposalRequest): Prompt => {
  const lines = [`Objective: ${req.objective}`];
  if (req.constraints) lines.push(`Constraints: ${req.constraints}`);
  if (req.path) lines.push(`Path: ${req.path}`);
  if (req.current !== undefined) lines.push('Current content:', req.current);
  return { system: req.kind === 'file' ? `${SYSTEM} Output the complete file.` : SYSTEM, user: lines.join('\n') };
};

export async function providerFromConfig(env: NodeJS.ProcessEnv = process.env, warn: Warn = () => {}): Promise<ProposalProvider | undefined> {
  const { generation } = await readConfig(env);
  if (!generation || generation.provider === 'none') return undefined;
  const base = providerSpec(generation.provider);
  const spec = generation.baseUrl ? { ...base, baseUrl: generation.baseUrl } : base;
  const stored = await credentialFor(spec.id, env);
  const cred: Credential | undefined = stored ?? (generation.auth === 'none' || spec.auth.includes('none') ? { type: 'none' } : undefined);
  if (!cred) {
    warn(`No credential for ${spec.id}; propose disabled. Run jev-code provider login ${spec.id}.`);
    return undefined;
  }
  const id = generation.model ?? spec.models[0]?.id;
  if (!id) {
    warn(`No model for ${spec.id}; propose disabled. Run jev-code provider login ${spec.id}.`);
    return undefined;
  }
  const row: ModelRow = spec.models.find(m => m.id === id) ?? { id, temperature: 0.7 };
  return {
    id: spec.id,
    model: row.id,
    generate: (req, signal) => withFreshToken(spec, cred, env, fresh =>
      Promise.all(Array.from({ length: req.count }, () => complete(spec, fresh, row, prompt(req), signal)))),
  };
}

export async function proposeTools(env: NodeJS.ProcessEnv, registry: AstRegistry, warn?: Warn): Promise<Tool[]> {
  const provider = await providerFromConfig(env, warn);
  return provider ? [proposeTool(provider, registry)] : [];
}
