import type { AstRegistry } from '../ast-adapters.js';
import { readConfig } from '../config.js';
import { proposeTool } from '../propose/tool.js';
import type { Tool } from '../types.js';
import { providerSpec } from './catalog.js';
import { credentialFor } from './credentials.js';
import { is401, withFreshToken } from './oauth.js';
import type { Completion, Credential, GenerationError, ModelRow, ProposalProvider, ProposalRequest } from './types.js';
import { complete, type Prompt } from './wire.js';

type Warn = (line: string) => void;

const SYSTEM = 'You produce candidate content only. Output exactly the requested content with no explanation, no code fences, and no JSON or shell wrapper around it.';

const prompt = (req: ProposalRequest): Prompt => {
  const lines = [`Objective: ${req.objective}`];
  if (req.constraints) lines.push(`Constraints: ${req.constraints}`);
  if (req.path) lines.push(`Path: ${req.path}`);
  if (req.current !== undefined) lines.push(req.kind === 'file' ? 'Current content:' : `Content of ${req.path}:`, req.current);
  const file = req.path ? ` Output the complete source code of the file ${req.path}; the output must be valid code for that file type, not prose.` : ' Output the complete file.';
  return { system: req.kind === 'file' ? `${SYSTEM}${file}` : `${SYSTEM} Answer the objective directly.`, user: lines.join('\n') };
};

export async function providerFromConfig(env: NodeJS.ProcessEnv = process.env, warn: Warn = () => {}): Promise<ProposalProvider | undefined> {
  const { generation } = await readConfig(env);
  if (!generation || generation.provider === 'none') return undefined;
  const base = providerSpec(generation.provider);
  const spec = generation.baseUrl ? { ...base, baseUrl: generation.baseUrl } : base;
  const stored = await credentialFor(spec.id, env, true);
  let cred: Credential | undefined = stored ?? (generation.auth === 'none' || spec.auth.includes('none') ? { type: 'none' } : undefined);
  if (!cred) {
    warn(`No credential for ${spec.id}; propose disabled. Run jev-code provider login ${spec.id}.`);
    return undefined;
  }
  const id = generation.model ?? spec.models[0]?.id;
  if (!id) {
    warn(`No model for ${spec.id}; propose disabled. Run jev-code provider login ${spec.id}.`);
    return undefined;
  }
  const row: ModelRow = spec.models.find(m => m.id === id) ?? { id };
  return {
    id: spec.id,
    model: row.id,
    generate: (req, signal) => withFreshToken(spec, cred!, env, async fresh => {
      cred = fresh;
      const settled = await Promise.allSettled(Array.from({ length: req.count }, () => complete(spec, fresh, row, prompt(req), signal)));
      signal.throwIfAborted();
      const denied = settled.find(s => s.status === 'rejected' && is401(s.reason));
      if (denied?.status === 'rejected') throw denied.reason;
      return settled.map((s): Completion | GenerationError => s.status === 'fulfilled' ? s.value : { error: s.reason instanceof Error ? s.reason.message : String(s.reason) });
    }, signal),
  };
}

export async function proposeTools(env: NodeJS.ProcessEnv, registry: AstRegistry, warn?: Warn): Promise<Tool[]> {
  const provider = await providerFromConfig(env, warn);
  return provider ? [proposeTool(provider, registry)] : [];
}
