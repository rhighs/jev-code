// Transcribed from the real recording at docs/media/session.gif.

type Seg = [text: string, cls?: string];
export type Line = Seg[];

const decision = (key: string, value: string): Line => [
  [`  ${key}`, 't-key'],
  [' → ', 't-arrow'],
  [value, 't-val'],
];

export const session: Line[] = [
  [['› create hello.py that prints Hello, world! and run it with python3', 't-prompt']],
  [['── turn 1 · 0 files', 't-mute']],
  decision('unit_count', '0'),
  decision('module_body', 'expr'),
  decision('expression', 'call'),
  decision('callee', 'name_0'),
  decision('argument_count', '1'),
  decision('argument_0', 'string'),
  decision('string', 'value_58'),
  decision('module_body', 'finish'),
  [['✓ write_file hello.py · 5 ms · 9 req', 't-ok']],
  [['  │   1  ', 't-mute'], ["print('Hello, world!')"]],
  [['── turn 2 · 1 file', 't-mute']],
  decision('plan', 'plan_0'),
  [['  │ ', 't-mute'], ['Hello, world!']],
  [["✓ bash 'python3' 'hello.py' · exit 0 · 30 ms · 3 req", 't-ok']],
  [['── turn 3 · 1 file', 't-mute']],
  [['[completed]']],
  [['  Wrote hello.py.']],
  [['  Bash exited with code 0.']],
  [['4.3 s · 3/50 turns · 16/512 requests · 23079 tokens · run 875b5b19-233e-48ca-bce2-da72a968afc6', 't-mute']],
];
