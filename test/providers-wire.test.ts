import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { providerSpec } from '../src/providers/catalog.js';
import type { Credential, ModelRow, ProviderSpec } from '../src/providers/types.js';
import { complete, listModels, scrub } from '../src/providers/wire.js';

interface Recorded { method: string; url: string; headers: IncomingHttpHeaders; body: string }
type Handler = (req: Recorded, res: ServerResponse) => void;

const KEY = 'topsecret-key-123456';
const ACCESS = 'oauth-access-token-abcdef';
const prompt = { system: 'Only code.', user: 'Write hello.' };
const row: ModelRow = { id: 'm-1', temperature: 0.7 };
const plain: ModelRow = { id: 'm-2' };
const apiKey: Credential = { type: 'api_key', key: KEY };
const oauth: Credential = { type: 'oauth', access: ACCESS, account: 'acct-42' };
const never = new AbortController().signal;

const serve = async (t: test.TestContext, handler: Handler): Promise<{ baseUrl: string; reqs: Recorded[] }> => {
  const reqs: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rec = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() };
      reqs.push(rec);
      handler(rec, res);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { baseUrl: `http://127.0.0.1:${port}`, reqs };
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const sse = (res: ServerResponse, events: unknown[], done = true): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const ev of events) res.write(`event: x\ndata: ${JSON.stringify(ev)}\n\n`);
  if (done) res.write('data: [DONE]\n\n');
  res.end();
};

const chatSpec = (baseUrl: string, models: ModelRow[] = []): ProviderSpec => ({ ...providerSpec('openai-compatible'), baseUrl, models });
const anthropicSpec = (baseUrl: string): ProviderSpec => ({ ...providerSpec('anthropic'), baseUrl });
const responsesSpec = (baseUrl: string): ProviderSpec => {
  const spec = providerSpec('openai');
  return { ...spec, baseUrl, oauth: { ...spec.oauth!, baseUrl } };
};
const parse = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>;

test('scrub removes bearer tokens, sk- keys and the given secrets', () => {
  const text = `Authorization: Bearer abc.def-123 key=sk-abcdefghijklmnop other=${KEY} keep=me`;
  assert.equal(scrub(text, [KEY, '']), 'Authorization: [redacted] key=[redacted] other=[redacted] keep=me');
});

test('openai-chat sends the bearer key, the system message and the declared temperature', async t => {
  const { baseUrl, reqs } = await serve(t, (_req, res) => json(res, 200, { choices: [{ message: { content: 'print(1)' }, finish_reason: 'stop' }] }));
  const out = await complete(chatSpec(baseUrl), apiKey, row, prompt, never);
  assert.deepEqual(out, { text: 'print(1)', truncated: false });
  const [req] = reqs;
  assert.ok(req);
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/chat/completions');
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  assert.equal(req.headers['content-type'], 'application/json');
  assert.deepEqual(parse(req.body), {
    model: 'm-1',
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    temperature: 0.7,
  });
});

test('openai-chat omits temperature for rows without one and reports length truncation', async t => {
  const { baseUrl, reqs } = await serve(t, (_req, res) => json(res, 200, { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }));
  const out = await complete(chatSpec(baseUrl), { type: 'none' }, plain, prompt, never);
  assert.deepEqual(out, { text: 'partial', truncated: true });
  const body = parse(reqs[0]!.body);
  assert.equal(body.model, 'm-2');
  assert.ok(!('temperature' in body));
  assert.equal(reqs[0]!.headers.authorization, undefined);
});

test('anthropic-messages with an api key uses x-api-key and joins the content blocks', async t => {
  const { baseUrl, reqs } = await serve(t, (_req, res) => json(res, 200, { content: [{ type: 'text', text: 'foo' }, { type: 'text', text: 'bar' }], stop_reason: 'max_tokens' }));
  const out = await complete(anthropicSpec(baseUrl), apiKey, row, prompt, never);
  assert.deepEqual(out, { text: 'foobar', truncated: true });
  const [req] = reqs;
  assert.ok(req);
  assert.equal(req.url, '/v1/messages');
  assert.equal(req.headers['x-api-key'], KEY);
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers.authorization, undefined);
  assert.deepEqual(parse(req.body), {
    model: 'm-1', max_tokens: 8192, system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }], temperature: 0.7,
  });
});

test('anthropic-messages with oauth sends a bearer token and the oauth beta header', async t => {
  const { baseUrl, reqs } = await serve(t, (_req, res) => json(res, 200, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }));
  const out = await complete(anthropicSpec(baseUrl), oauth, row, prompt, never);
  assert.deepEqual(out, { text: 'ok', truncated: false });
  const [req] = reqs;
  assert.ok(req);
  assert.equal(req.headers.authorization, `Bearer ${ACCESS}`);
  assert.match(String(req.headers['anthropic-beta']), /oauth-2025-04-20/);
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers['x-api-key'], undefined);
});

test('openai-responses folds the SSE deltas and sends the account header', async t => {
  const { baseUrl, reqs } = await serve(t, (_req, res) => sse(res, [
    { type: 'response.created', response: { status: 'in_progress' } },
    { type: 'response.output_text.delta', delta: 'a' },
    { type: 'response.output_text.delta', delta: 'b' },
    { type: 'response.output_text.delta', delta: 'c' },
    { type: 'response.completed', response: { status: 'completed' } },
  ]));
  const out = await complete(responsesSpec(baseUrl), oauth, plain, prompt, never);
  assert.deepEqual(out, { text: 'abc', truncated: false });
  const [req] = reqs;
  assert.ok(req);
  assert.equal(req.url, '/responses');
  assert.equal(req.headers.authorization, `Bearer ${ACCESS}`);
  assert.equal(req.headers['chatgpt-account-id'], 'acct-42');
  assert.deepEqual(parse(req.body), { model: 'm-2', instructions: prompt.system, input: prompt.user, store: false, stream: true });
});

test('openai-responses reports truncation for incomplete and unfinished streams', async t => {
  const incomplete = await serve(t, (_req, res) => sse(res, [
    { type: 'response.output_text.delta', delta: 'x' },
    { type: 'response.completed', response: { status: 'incomplete' } },
  ]));
  assert.deepEqual(await complete(responsesSpec(incomplete.baseUrl), oauth, plain, prompt, never), { text: 'x', truncated: true });
  const cut = await serve(t, (_req, res) => sse(res, [{ type: 'response.output_text.delta', delta: 'y' }], false));
  assert.deepEqual(await complete(responsesSpec(cut.baseUrl), oauth, plain, prompt, never), { text: 'y', truncated: true });
});

test('a non-2xx response surfaces the status and a scrubbed body', async t => {
  const { baseUrl } = await serve(t, (req, res) => json(res, 500, { error: 'bad', headers: req.headers }));
  await assert.rejects(complete(chatSpec(baseUrl), apiKey, row, prompt, never), (err: Error) => {
    assert.match(err.message, /^openai-compatible 500: /);
    assert.ok(!err.message.includes(KEY), err.message);
    assert.match(err.message, /\[redacted\]/);
    return true;
  });
});

test('a fetch rejection is reported with its cause and without the key', async t => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: new Error(`connect refused for ${KEY}`) }); };
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(complete(chatSpec('http://127.0.0.1:9'), apiKey, row, prompt, never), (err: Error) => {
    assert.match(err.message, /^openai-compatible failed: fetch failed: connect refused for \[redacted\]$/);
    return true;
  });
});

test('a silent server times out', async t => {
  const { baseUrl } = await serve(t, () => {});
  await assert.rejects(complete(chatSpec(baseUrl), apiKey, row, prompt, never, 200), { message: 'openai-compatible timed out after 0.2 s' });
});

test('an empty choices array is reported as no content', async t => {
  const { baseUrl } = await serve(t, (_req, res) => json(res, 200, { choices: [] }));
  await assert.rejects(complete(chatSpec(baseUrl), apiKey, row, prompt, never), { message: 'openai-compatible returned no content' });
});

test('an aborted signal rejects with the abort reason', async t => {
  const { baseUrl, reqs } = await serve(t, (_req, res) => json(res, 200, { choices: [{ message: { content: 'late' } }] }));
  const ctl = new AbortController();
  const reason = new Error('stop now');
  ctl.abort(reason);
  await assert.rejects(complete(chatSpec(baseUrl), apiKey, row, prompt, ctl.signal), (err: unknown) => err === reason);
  assert.equal(reqs.length, 0);
});

test('listModels puts the bundled rows first and sorts the rest', async t => {
  const { baseUrl, reqs } = await serve(t, (_req, res) => json(res, 200, { data: [{ id: 'zeta' }, { id: 'bundled-b' }, { id: 'alpha' }, { id: 'bundled-a' }] }));
  const spec = chatSpec(baseUrl, [{ id: 'bundled-a' }, { id: 'bundled-b' }]);
  assert.deepEqual(await listModels(spec, apiKey, never), ['bundled-a', 'bundled-b', 'alpha', 'zeta']);
  assert.equal(reqs[0]!.method, 'GET');
  assert.equal(reqs[0]!.url, '/models');
  assert.equal(reqs[0]!.headers.authorization, `Bearer ${KEY}`);
});

test('listModels uses /v1/models for anthropic and returns undefined on failure or without discovery', async t => {
  const { baseUrl, reqs } = await serve(t, (_req, res) => json(res, 404, { error: 'nope' }));
  assert.equal(await listModels(anthropicSpec(baseUrl), apiKey, never), undefined);
  assert.equal(reqs[0]!.url, '/v1/models');
  assert.equal(reqs[0]!.headers['x-api-key'], KEY);
  assert.equal(await listModels(responsesSpec(baseUrl), oauth, never), undefined);
  assert.equal(reqs.length, 1);
});

test('a response body over 4MB is rejected before parsing', async t => {
  const big = 'x'.repeat(4 * 1024 * 1024 + 1);
  const { baseUrl } = await serve(t, (_req, res) => json(res, 200, { choices: [{ message: { content: big }, finish_reason: 'stop' }] }));
  await assert.rejects(complete(chatSpec(baseUrl), apiKey, row, prompt, never), /exceeds 4MB/);
});
