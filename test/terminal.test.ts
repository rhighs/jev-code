import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { TerminalSession } from '../src/terminal.js';
import type { HarnessOptions } from '../src/harness.js';
import type { DecisionProvider, HarnessEvent, Tool } from '../src/types.js';
import { ScriptedProvider, type Step } from './helpers.js';

async function setup(t: test.TestContext, provider: DecisionProvider, yes = true, onEvent?: (event: HarnessEvent) => void, tools?: Tool[], gridOptions?: Pick<HarnessOptions, 'gridBatchSize' | 'gridConcurrency'>) {
  const workspace = await mkdtemp(join(tmpdir(), 'jev-terminal-'));
  const input = new PassThrough(), output = new PassThrough();
  let transcript = '';
  output.on('data', data => { transcript += String(data); });
  const session = new TerminalSession({ harness: { experimentalGrid: true, workspace, provider, journalDirectory: false, ...(tools ? { tools } : {}), ...gridOptions },
    input, output, model: 'test-jev', yes, ...(onEvent ? { onEvent } : {}),
  });
  const done = session.run();
  t.after(async () => { input.end(); await done; await rm(workspace, { recursive: true, force: true }); });
  const wait = (text: string, count = 1): Promise<void> => new Promise((resolve, reject) => {
    const check = (): void => { if (transcript.split(text).length - 1 >= count) { clearTimeout(timer); output.removeListener('data', check); resolve(); } };
    const timer = setTimeout(() => { output.removeListener('data', check); reject(new Error(`Missing output ${JSON.stringify(text)}:\n${transcript}`)); }, 3000);
    output.on('data', check);
    check();
  });
  return { input, session, workspace, done, wait, transcript: () => transcript };
}

test('interactive session displays help, handles unknown commands and exits without an API call', async t => {
  const provider = new ScriptedProvider([]);
  const { input, done, wait, transcript } = await setup(t, provider);
  input.write('/help\n/unknown\n/status\n/exit\n');
  await wait('Unknown command /unknown');
  assert.equal(await done, 0);
  assert.match(transcript(), /Jev Code · test-jev/);
  assert.match(transcript(), /Permissions: auto/);
  assert.equal(provider.states.length, 0);
});

test('follow-up prompts share conversation and workspace across runs', async t => {
  const steps: Step[] = [
    { action: 'write_file', args: { path: 'hello.txt', content: 'hello' } },
    { action: 'finish', args: { summary: 'Wrote a file.' } },
  ];
  const base = new ScriptedProvider(steps);
  const { input, done, wait, workspace, transcript } = await setup(t, base);
  input.write('Write hello.txt with hello.\n');
  await wait('Wrote hello.txt.');
  input.write('Do it again.\n');
  await wait('Jev · completed', 2);
  assert.equal(await readFile(join(workspace, 'hello.txt'), 'utf8'), 'hello');
  const followUp = base.states.find(state => state.task.prompt === 'Do it again.') as unknown as { conversation: unknown[] };
  assert.ok(followUp.conversation.length);
  input.write('/history\n/exit\n');
  assert.equal(await done, 0);
  assert.match(transcript(), /\[completed\] Do it again/);
});

test('updates typed while Jev works reconsider an obsolete pending write before execution', async t => {
  const base = new ScriptedProvider([
    { action: 'write_file', args: { path: 'old.txt', content: 'old requirements' } },
    { action: 'write_file', args: { path: 'new.txt', content: 'new requirements' } },
    { action: 'finish', args: { summary: 'Applied the update.' } },
  ]);
  let input: PassThrough;
  let sent = false;
  const setupResult = await setup(t, base, true, event => {
    if (event.type === 'text' && event.data.field === 'content' && !sent) { sent = true; input.write('Use new.txt instead.\n'); }
  });
  input = setupResult.input;
  input.write('Write old.txt.\n');
  await setupResult.wait('Wrote new.txt.');
  await assert.rejects(readFile(join(setupResult.workspace, 'old.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(setupResult.workspace, 'new.txt'), 'utf8'), 'new requirements');
  assert.match(setupResult.transcript(), /Update queued/);
  assert.match(setupResult.transcript(), /Task update applied/);
  input.write('/exit\n');
  assert.equal(await setupResult.done, 0);
});

test('model shell commands ask for permission; denied commands never execute', async t => {
  const base = new ScriptedProvider([
    { action: 'bash', args: { command: 'touch denied.txt', cwd: '.', timeout_ms: '' } },
    { action: 'blocked', args: { summary: 'Permission was denied.' } },
  ]);
  const { input, wait, workspace, transcript } = await setup(t, base, false);
  input.write('Create a file with Bash.\n');
  await wait('allow [y/n]>');
  input.write('n\n');
  await wait('Jev · blocked');
  await assert.rejects(readFile(join(workspace, 'denied.txt')), { code: 'ENOENT' });
  assert.match(transcript(), /Host declined/);
  input.write('/exit\n');
});

test('cancellation releases a permission prompt and the session accepts another task', async t => {
  const base = new ScriptedProvider([{ action: 'bash', args: { command: 'touch cancelled.txt', cwd: '.', timeout_ms: '' } }]);
  const { input, wait, workspace, transcript } = await setup(t, base, false);
  input.write('Create cancelled.txt with Bash.\n');
  await wait('allow [y/n]>');
  input.write('/cancel\n');
  await wait('Jev · cancelled');
  input.write('/status\n/clear\n/exit\n');
  await assert.rejects(readFile(join(workspace, 'cancelled.txt')), { code: 'ENOENT' });
  assert.match(transcript(), /Fresh conversation/);
});

test('task updates release an obsolete permission prompt without approving its command', async t => {
  const base = new ScriptedProvider([
    { action: 'bash', args: { command: 'touch obsolete.txt', cwd: '.', timeout_ms: '' } },
    { action: 'write_file', args: { path: 'current.txt', content: 'current' } },
    { action: 'finish', args: { summary: 'Applied the update.' } },
  ]);
  const { input, wait, workspace } = await setup(t, base, false);
  input.write('Create a file with Bash.\n');
  await wait('allow [y/n]>');
  input.write('Use write_file for current.txt instead.\n');
  await wait('Wrote current.txt.');
  await assert.rejects(readFile(join(workspace, 'obsolete.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(workspace, 'current.txt'), 'utf8'), 'current');
  input.write('/exit\n');
});

test('direct Bash streams before completion and its observed result reaches the next Jev task', async t => {
  const base = new ScriptedProvider([{ action: 'blocked', args: { summary: 'Nothing else is required.' } }]);
  const { input, wait, transcript } = await setup(t, base);
  input.write('!printf "streamed\\n"; sleep 0.1; printf "finished\\n"\n');
  await wait('  streamed\n');
  assert.equal(transcript().includes('Bash · exit 0'), false);
  await wait('Bash · exit 0');
  input.write('Explain the previous command.\n');
  await wait('Jev · blocked');
  const state = base.states[0] as unknown as { observations: Array<{ args: { command: string }; result: { output: string } }> };
  assert.match(state.observations[0]!.result.output, /streamed\nfinished/);
  input.write('/exit\n');
});

test('multiline paste submits one task with exact newlines, and clear drops conversation', async t => {
  const base = new ScriptedProvider([{ action: 'blocked', args: { summary: 'Need more information.' } }]);
  const { input, wait } = await setup(t, base);
  input.write('/paste\nFirst line\n  indented second line\n/end\n');
  await wait('Jev · blocked');
  assert.equal(base.states[0]?.task.prompt, 'First line\n  indented second line');
  input.write('/clear\nNew task.\n');
  await wait('Jev · blocked', 2);
  const state = base.states.find(state => state.task.prompt === 'New task.') as unknown as { conversation: unknown[] };
  assert.deepEqual(state.conversation, []);
  input.write('/exit\n');
});

test('cancelling a running direct command keeps the session available', async t => {
  const { input, wait, transcript } = await setup(t, new ScriptedProvider([]));
  input.write('!printf "started\\n"; sleep 30\n');
  await wait('  started\n');
  input.write('/cancel\n');
  await wait('Bash · cancelled');
  input.write('/status\n/history\n/exit\n');
  assert.match(transcript(), /Activity: ready/);
  assert.match(transcript(), /\[cancelled\]/);
});

test('custom tool output preserves chunked lines and bounds an unterminated line', async t => {
  const tool: Tool = { name: 'emit', description: 'Stream text.', effect: 'read', fields: {},
    async execute(_args, context) {
      await context.onOutput?.('stdout', 'first');
      await context.onOutput?.('stdout', ' line\n');
      for (let i = 0; i < 40; i++) await context.onOutput?.('stdout', 'x'.repeat(1000));
      await context.onOutput?.('stdout', '\nlast line');
      return { ok: true, output: 'Streamed.' };
    },
  };
  const provider = new ScriptedProvider([{ action: 'emit', args: {} }, { action: 'finish', args: { summary: 'Done.' } }]);
  const { input, wait, transcript } = await setup(t, provider, true, undefined, [tool]);
  input.write('Stream output.\n');
  await wait('Jev · completed');
  assert.match(transcript(), /  first line\n/);
  assert.match(transcript(), /x{32000} \[line truncated\]\n/);
  assert.equal(transcript().includes('x'.repeat(32001)), false);
  assert.match(transcript(), /  last line\n/);
  input.write('/exit\n');
});

test('generated content streams before the file is written', async t => {
  const base = new ScriptedProvider([
    { action: 'write_file', args: { path: 'streamed.txt', content: 'hello' } },
    { action: 'finish', args: { summary: 'Done.' } },
  ]);
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const provider: DecisionProvider = { decide: async (state, questions, signal) => {
    const generation = (state as unknown as { generation?: { field: string; phase: string } }).generation;
    if (generation?.field === 'content' && generation.phase === 'cells' && !questions.cell_0_0) await gate;
    return base.decide(state, questions, signal);
  } };
  const { input, wait, workspace, transcript } = await setup(t, provider, true, undefined, undefined, { gridBatchSize: 2, gridConcurrency: 4 });
  t.after(resume);
  input.write('Write streamed.txt with hello.\n');
  try {
    await wait('Draft · write_file.content · grid');
    await wait('write_file.content · round 1 · 2/8 cells');
    assert.match(transcript(), /\| he/);
    await assert.rejects(readFile(join(workspace, 'streamed.txt')), { code: 'ENOENT' });
    assert.equal(transcript().includes('Jev · completed'), false);
  } finally { resume(); }
  await wait('Wrote streamed.txt.');
  assert.equal(await readFile(join(workspace, 'streamed.txt'), 'utf8'), 'hello');
  input.write('/exit\n');
});

test('interactive file viewer shows generated files and turn timing without model requests', async t => {
  const provider = new ScriptedProvider([
    { action: 'write_file', args: { path: 'hello.txt', content: 'hello\nworld\n' } },
    { action: 'finish', args: { summary: 'Created the file.' } },
  ]);
  const { input, wait, transcript, done } = await setup(t, provider);
  input.write('Create hello.txt.\n');
  await wait('Jev · completed');
  const requests = provider.states.length;
  input.write('/files\n/show hello.txt\n');
  await wait('╭─ hello.txt');
  assert.match(transcript(), /1  hello\n│\s+2  world/);
  assert.match(transcript(), /Turn 1 finished · .* total elapsed/);
  assert.match(transcript(), /elapsed · 2 turns/);
  assert.equal(provider.states.length, requests);
  input.write('/show ../outside.txt\n');
  await wait('Error:');
  input.write('/exit\n');
  assert.equal(await done, 0);
});
