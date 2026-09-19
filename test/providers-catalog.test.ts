import assert from 'node:assert/strict';
import test from 'node:test';
import { PROVIDERS, providerSpec, resolveWire } from '../src/providers/catalog.js';

test('the catalog lists six providers with descriptors and bundled models where required', () => {
  assert.deepEqual(PROVIDERS.map(p => p.id), ['openai', 'anthropic', 'google', 'openrouter', 'openai-compatible', 'local']);
  for (const spec of PROVIDERS) {
    if (spec.auth.includes('oauth')) assert.ok(spec.oauth, `${spec.id} needs an oauth descriptor`);
    if (spec.id === 'openai-compatible' || spec.id === 'local') assert.equal(spec.models.length, 0);
    else assert.ok(spec.models.length >= 1, `${spec.id} needs a bundled model`);
    for (const row of spec.models) if (/gpt-5-/.test(row.id)) assert.equal(row.temperature, undefined);
  }
  assert.equal(providerSpec('openrouter').oauth?.state, false);
});

test('resolveWire applies the OAuth overrides only for oauth credentials', () => {
  const openai = providerSpec('openai');
  assert.deepEqual(resolveWire(openai, { type: 'api_key', key: 'k' }),
    { wire: 'openai-chat', baseUrl: 'https://api.openai.com/v1', discover: true });
  assert.deepEqual(resolveWire(openai, { type: 'oauth', access: 'a' }),
    { wire: 'openai-responses', baseUrl: 'https://chatgpt.com/backend-api/codex', discover: false });
});

test('providerSpec names the known ids when asked for an unknown one', () => {
  assert.throws(() => providerSpec('nonesuch'),
    { message: 'Unknown provider: nonesuch. Known: openai, anthropic, google, openrouter, openai-compatible, local, none.' });
});
