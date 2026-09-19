import type { Credential, ProviderSpec, Wire } from './types.js';

export const PROVIDERS: ProviderSpec[] = [
  {
    id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', wire: 'openai-chat', discover: true,
    auth: ['oauth', 'api_key'],
    models: [{ id: 'gpt-5-nano' }, { id: 'gpt-5-mini' }, { id: 'gpt-4.1-nano', temperature: 0.7 }, { id: 'gpt-4.1-mini', temperature: 0.7 }],
    oauth: {
      authorizeUrl: 'https://auth.openai.com/oauth/authorize',
      tokenUrl: 'https://auth.openai.com/oauth/token',
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      redirect: 'loopback', port: 1455, callbackPath: '/auth/callback', state: true, exchange: 'token', tokenBody: 'form',
      wire: 'openai-responses', baseUrl: 'https://chatgpt.com/backend-api/codex', discover: false,
    },
  },
  {
    id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', wire: 'anthropic-messages', discover: true,
    auth: ['oauth', 'api_key'],
    models: [{ id: 'claude-haiku-4-5-20251001', temperature: 0.7 }, { id: 'claude-3-5-haiku-latest', temperature: 0.7 }],
    oauth: {
      authorizeUrl: 'https://claude.ai/oauth/authorize',
      tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
      clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
      redirect: 'paste', callbackPath: '/oauth/code/callback', state: true, exchange: 'token',
      discover: false,
    },
  },
  {
    id: 'google', name: 'Google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', wire: 'openai-chat', discover: true,
    auth: ['api_key'],
    models: [{ id: 'gemini-2.5-flash-lite', temperature: 0.7 }, { id: 'gemini-2.5-flash', temperature: 0.7 }, { id: 'gemini-2.0-flash', temperature: 0.7 }],
  },
  {
    id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', wire: 'openai-chat', discover: true,
    auth: ['oauth', 'api_key'],
    models: [
      { id: 'openai/gpt-5-nano' },
      { id: 'google/gemini-2.5-flash-lite', temperature: 0.7 },
      { id: 'anthropic/claude-haiku-4.5', temperature: 0.7 },
      { id: 'qwen/qwen3-8b', temperature: 0.7 },
    ],
    oauth: {
      authorizeUrl: 'https://openrouter.ai/auth',
      tokenUrl: 'https://openrouter.ai/api/v1/auth/keys',
      clientId: '', scopes: [],
      redirect: 'loopback', callbackPath: '/callback', state: false, exchange: 'key',
    },
  },
  {
    id: 'openai-compatible', name: 'OpenAI-compatible', baseUrl: '', wire: 'openai-chat', discover: true,
    auth: ['api_key'], models: [],
  },
  {
    id: 'local', name: 'Local', baseUrl: 'http://localhost:11434/v1', wire: 'openai-chat', discover: true,
    auth: ['none'], models: [],
  },
];

export function providerSpec(id: string): ProviderSpec {
  const spec = PROVIDERS.find(p => p.id === id);
  if (spec) return spec;
  throw new Error(`Unknown provider: ${id}. Known: ${[...PROVIDERS.map(p => p.id), 'none'].join(', ')}.`);
}

export function resolveWire(spec: ProviderSpec, cred: Credential): { wire: Wire; baseUrl: string; discover: boolean } {
  const base = { wire: spec.wire, baseUrl: spec.baseUrl, discover: spec.discover };
  if (cred.type !== 'oauth' || !spec.oauth) return base;
  return {
    wire: spec.oauth.wire ?? base.wire,
    baseUrl: spec.oauth.baseUrl ?? base.baseUrl,
    discover: spec.oauth.discover ?? base.discover,
  };
}
