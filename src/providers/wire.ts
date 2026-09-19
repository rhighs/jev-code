import { resolveWire } from './catalog.js';
import type { Completion, Credential, ModelRow, ProviderSpec, Wire } from './types.js';

export interface Prompt { system: string; user: string }

interface ChatRes { choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }> }
interface MessagesRes { content?: Array<{ text?: string }>; stop_reason?: string }
interface SseEvent { type?: string; delta?: string; response?: { status?: string } }
interface ModelsRes { data?: Array<{ id?: unknown }> }

export const scrub = (text: string, secrets: string[]): string => {
  const base = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, '[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
  return secrets.filter(Boolean).reduce((acc, s) => acc.split(s).join('[redacted]'), base);
};

const secretsOf = (cred: Credential): string[] => {
  if (cred.type === 'api_key') return [cred.key];
  if (cred.type === 'oauth') return [cred.access, cred.account ?? ''];
  return [];
};

const headersFor = (wire: Wire, cred: Credential): Record<string, string> => {
  const base: Record<string, string> = { 'content-type': 'application/json' };
  if (wire === 'anthropic-messages') base['anthropic-version'] = '2023-06-01';
  if (cred.type === 'none') return base;
  if (cred.type === 'api_key') {
    return wire === 'anthropic-messages' ? { ...base, 'x-api-key': cred.key } : { ...base, Authorization: `Bearer ${cred.key}` };
  }
  const auth = { ...base, Authorization: `Bearer ${cred.access}` };
  if (wire === 'anthropic-messages') return { ...auth, 'anthropic-beta': 'oauth-2025-04-20' };
  if (wire === 'openai-responses' && cred.account) return { ...auth, 'chatgpt-account-id': cred.account };
  return auth;
};

const requestFor = (wire: Wire, baseUrl: string, model: ModelRow, prompt: Prompt): { url: string; body: unknown } => {
  const temperature = model.temperature !== undefined ? { temperature: model.temperature } : {};
  if (wire === 'openai-chat') {
    return {
      url: `${baseUrl}/chat/completions`,
      body: { model: model.id, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], ...temperature },
    };
  }
  if (wire === 'anthropic-messages') {
    return {
      url: `${baseUrl}/v1/messages`,
      body: { model: model.id, max_tokens: 8192, system: prompt.system, messages: [{ role: 'user', content: prompt.user }], ...temperature },
    };
  }
  return { url: `${baseUrl}/responses`, body: { model: model.id, instructions: prompt.system, input: prompt.user, store: false, stream: true } };
};

const MAX_BODY = 4 * 1024 * 1024;

const bounded = async (res: Response): Promise<string> => {
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_BODY) throw new Error('response body exceeds 4MB');
  return text;
};

const parseChat = async (res: Response): Promise<Completion> => {
  const data = JSON.parse(await bounded(res)) as ChatRes;
  const first = data.choices?.[0];
  return { text: first?.message?.content ?? '', truncated: first?.finish_reason === 'length' };
};

const parseMessages = async (res: Response): Promise<Completion> => {
  const data = JSON.parse(await bounded(res)) as MessagesRes;
  return { text: (data.content ?? []).map(c => c.text ?? '').join(''), truncated: data.stop_reason === 'max_tokens' };
};

const sseEvent = (line: string): SseEvent | undefined => {
  if (!line.startsWith('data:')) return undefined;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return undefined;
  return JSON.parse(payload) as SseEvent;
};

const parseResponses = async (res: Response): Promise<Completion> => {
  if (!res.body) return { text: '', truncated: true };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return { text, truncated: true };
    bytes += value.byteLength;
    if (bytes > MAX_BODY) { void reader.cancel().catch(() => {}); throw new Error('response body exceeds 4MB'); }
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const ev = sseEvent(line);
      if (ev?.type === 'response.output_text.delta') text += ev.delta ?? '';
      if (ev?.type !== 'response.completed') continue;
      void reader.cancel().catch(() => {});
      return { text, truncated: ev.response?.status === 'incomplete' };
    }
  }
};

const parsers: Record<Wire, (res: Response) => Promise<Completion>> = {
  'openai-chat': parseChat,
  'anthropic-messages': parseMessages,
  'openai-responses': parseResponses,
};

const describe = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
};

export async function complete(spec: ProviderSpec, cred: Credential, model: ModelRow, prompt: Prompt, signal: AbortSignal, timeoutMs = 60_000): Promise<Completion> {
  const { wire, baseUrl } = resolveWire(spec, cred);
  const headers = headersFor(wire, cred);
  const secrets = secretsOf(cred);
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const fail = (err: unknown): never => {
    if (signal.aborted) throw signal.reason;
    if (combined.aborted) throw new Error(`${spec.id} timed out after ${timeoutMs / 1000} s`);
    throw new Error(`${spec.id} failed: ${scrub(describe(err), secrets)}`);
  };
  const req = requestFor(wire, baseUrl, model, prompt);
  const res = await fetch(req.url, { method: 'POST', headers, body: JSON.stringify(req.body), signal: combined }).catch(fail);
  if (!res.ok) {
    const body = await res.text().catch(fail);
    throw new Error(`${spec.id} ${res.status}: ${scrub(body.slice(0, 300), secrets)}`);
  }
  const out = await parsers[wire](res).catch(fail);
  if (!out.text) throw new Error(`${spec.id} returned no content`);
  return out;
}

export async function listModels(spec: ProviderSpec, cred: Credential, signal: AbortSignal, timeoutMs = 15_000): Promise<string[] | undefined> {
  const { wire, baseUrl, discover } = resolveWire(spec, cred);
  if (!discover) return undefined;
  const url = wire === 'anthropic-messages' ? `${baseUrl}/v1/models` : `${baseUrl}/models`;
  try {
    const res = await fetch(url, { headers: headersFor(wire, cred), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
    if (!res.ok) return undefined;
    const data = await res.json() as ModelsRes;
    const ids = (data.data ?? []).map(m => m.id).filter((id): id is string => typeof id === 'string');
    const bundled = spec.models.map(m => m.id);
    return [...bundled, ...ids.filter(id => !bundled.includes(id)).sort()];
  } catch {
    return undefined;
  }
}
