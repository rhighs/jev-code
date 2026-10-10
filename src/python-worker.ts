import { spawn, type ChildProcess } from 'node:child_process';
import type { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { sanitizedEnv } from './env.js';
import type { RunContextWorker } from './run-context.js';
import { LimitError } from './types.js';

/**
 * The single trusted serializer program behind every Python bridge operation. It is the union of
 * the four pre-worker `python3 -I -c` scripts: tree unparse, source compile, project validate, and
 * candidate check. It reads one JSONL request per line and writes one JSONL response per line, so
 * one long-lived child serves a whole run instead of a spawn per production. Nothing is executed:
 * every operation compiles or parses generated source and the serializer itself is the only code
 * that runs.
 */
const workerProgram = String.raw`
import ast, builtins, importlib.util, json, os, sys

try:
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

class Done(BaseException):
    def __init__(self, result):
        super().__init__()
        self.result = result

def require_version():
    if sys.version_info < (3, 9):
        raise RuntimeError('Python AST generation requires Python 3.9 or newer')

def decode(value):
    if isinstance(value, list): return [decode(item) for item in value]
    if not isinstance(value, dict): return value
    kind = value.get('_type')
    cls = getattr(ast, kind, None)
    if not isinstance(cls, type) or not issubclass(cls, ast.AST): raise ValueError('Invalid AST node')
    fields = {key: decode(item) for key, item in value.items() if key != '_type'}
    if 'type_params' not in cls._fields and fields.get('type_params') == []: fields.pop('type_params')
    if any(key not in cls._fields for key in fields): raise ValueError('Invalid AST field')
    return cls(**fields)

def op_unparse(payload):
    tree = ast.fix_missing_locations(decode(payload))
    compile(tree, '<jev-ast>', 'exec')
    source = ast.unparse(tree)
    if source: source += '\n'
    compile(ast.parse(source), '<jev-source>', 'exec')
    return source

def op_source(payload):
    compile(ast.parse(payload), '<jev>', 'exec')
    return None

_project_root = None

def op_project(payload):
    global _project_root
    root = payload['root']
    paths = payload['paths']
    if _project_root is not None and _project_root in sys.path:
        sys.path.remove(_project_root)
        sys.path_importer_cache.pop(_project_root, None)
    for top in sorted({p.split('/')[0].removesuffix('.py') for p in paths}):
        if importlib.util.find_spec(top) is not None: raise ValueError(f'{top} shadows an installed module')
    sys.path.insert(0, root)
    _project_root = root
    def local(parts):
        base = os.path.join(root, *parts)
        if os.path.isfile(base + '.py'): return base + '.py'
        if os.path.isdir(base) and os.path.isfile(os.path.join(base, '__init__.py')): return os.path.join(base, '__init__.py')
        return None
    def resolve(name, where):
        parts = name.split('.')
        if local(parts[:1]) is None:
            if importlib.util.find_spec(parts[0]) is None: raise ValueError(f'{where}: cannot resolve import {name}')
            return None
        for i in range(1, len(parts) + 1):
            if local(parts[:i]) is None: raise ValueError(f'{where}: cannot resolve import {name}')
        return local(parts)
    def exported(path):
        names = set()
        for stmt in ast.parse(open(path, encoding='utf-8').read()).body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)): names.add(stmt.name)
            elif isinstance(stmt, ast.Assign): names.update(t.id for t in stmt.targets if isinstance(t, ast.Name))
            elif isinstance(stmt, (ast.Import, ast.ImportFrom)): names.update((a.asname or a.name).split('.')[0] for a in stmt.names)
        return names
    def check(path, tree):
        for stmt in ast.walk(tree):
            if isinstance(stmt, ast.Import):
                for a in stmt.names: resolve(a.name, path)
            elif isinstance(stmt, ast.ImportFrom):
                if stmt.level: raise ValueError(f'{path}: relative imports are not supported')
                target = resolve(stmt.module, path)
                if target is None: continue
                if target.endswith('__init__.py'):
                    for a in stmt.names:
                        if a.name != '*' and a.name not in exported(target) and local(stmt.module.split('.') + [a.name]) is None:
                            raise ValueError(f'{path}: {stmt.module} has no name {a.name}')
                else:
                    names = exported(target)
                    for a in stmt.names:
                        if a.name != '*' and a.name not in names: raise ValueError(f'{path}: {stmt.module} has no name {a.name}')
    for path in paths:
        source = open(os.path.join(root, path), encoding='utf-8').read()
        try: tree = ast.parse(source, path)
        except SyntaxError as err: raise ValueError(f'{path}: {err.msg} (line {err.lineno})')
        compile(tree, path, 'exec')
    for path in paths:
        check(path, ast.parse(open(os.path.join(root, path), encoding='utf-8').read(), path))
    return None

def op_candidate(spec):
    def done(reason, symbol=None):
        raise Done({'reason': reason, 'symbol': symbol} if symbol else {'reason': reason})
    try:
        tree = ast.parse(spec['source'])
        compile(tree, '<candidate>', 'exec')
    except Exception:
        done('compile')
    fn = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == spec['name']), None)
    if fn is None: done('compile')
    defined = set(dir(builtins)) | set(spec['params']) | set(spec['peers']) | {spec['name']}
    for n in ast.walk(fn):
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store): defined.add(n.id)
        elif isinstance(n, (ast.Import, ast.ImportFrom)): defined.update((a.asname or a.name).split('.')[0] for a in n.names)
        elif isinstance(n, ast.FunctionDef): defined.add(n.name); defined.update(a.arg for a in n.args.args)
        elif isinstance(n, ast.ExceptHandler) and n.name: defined.add(n.name)
    for n in ast.walk(fn):
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id not in defined: done('undefined', n.id)
    for n in ast.walk(fn):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in spec['peers'] and (len(n.args) != spec['peers'][n.func.id] or n.keywords): done('arity', n.func.id)
    if spec['wantsReturn'] and not any(isinstance(n, ast.Return) and n.value is not None for n in ast.walk(fn)): done('return')
    done('ok')

def dispatch(op, payload):
    require_version()
    if op == 'unparse': return op_unparse(payload)
    if op == 'source': return op_source(payload)
    if op == 'project': return op_project(payload)
    if op == 'candidate': return op_candidate(payload)
    raise ValueError('Unknown serializer operation: ' + str(op))

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    request_id = None
    try:
        request = json.loads(line)
        request_id = request.get('id')
        response = {'id': request_id, 'ok': True, 'result': dispatch(request['op'], request.get('payload'))}
    except Done as done:
        response = {'id': request_id, 'ok': True, 'result': done.result}
    except Exception as error:
        response = {'id': request_id, 'ok': False, 'error': str(error)}
    sys.stdout.write(json.dumps(response) + '\n')
    sys.stdout.flush()
`;

/** The four bridge operations the serializer serves. */
export type PythonOperation = 'unparse' | 'source' | 'project' | 'candidate';

export interface PythonBridgeCall {
  /**
   * Cancels this request only: the rejected call leaves the worker and every concurrent sibling in
   * flight. A crash or timeout is different and rejects every in-flight call.
   */
  signal: AbortSignal;
  /** Response byte budget (source bytes for `unparse`); each operation has its pre-worker default. */
  maxBytes?: number;
  /** Per-request timeout; a hung request kills and restarts the worker. */
  timeoutMs?: number;
}

export interface PythonBridge {
  run(operation: PythonOperation, payload: unknown, call: PythonBridgeCall): Promise<unknown>;
  dispose(): void | Promise<void>;
}

export interface PythonWorkerSpawnOptions {
  env: NodeJS.ProcessEnv;
  stdio: ['pipe', 'pipe', 'pipe'];
}

/** Injectable spawner for tests (spawn-count probe); defaults to `node:child_process` spawn. */
export type PythonWorkerSpawn = (command: string, args: string[], options: PythonWorkerSpawnOptions) => ChildProcess;

export interface PythonWorkerOptions {
  /** Injectable spawner for tests; the worker spawns exactly one child per lifetime (plus restarts). */
  spawn?: PythonWorkerSpawn;
  /** Per-request timeout; a timed-out request kills the worker and rejects every in-flight call. */
  timeoutMs?: number;
  /** Worker exits tolerated before the bridge switches to spawn-per-call; restarts below the limit. */
  crashLimit?: number;
}

export class PythonWorkerDisposedError extends Error {
  constructor(message = 'The Python serializer worker was disposed; create a new worker for another run.') {
    super(message);
    this.name = 'PythonWorkerDisposedError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CRASH_LIMIT = 3;
const MAX_STDERR_BYTES = 8_000;
/**
 * Response-line cap. The old per-call bridge killed a child whose stdout exceeded
 * `maxBytes * 6 + 1024`; a 256k-byte source worst-cases to ~1.54MB of JSON-escaped output plus the
 * envelope, so a fixed cap preserves that guard while covering every operation.
 */
const MAX_RESPONSE_BYTES = 1_700_000;

const defaultMaxBytes = (operation: PythonOperation): number =>
  operation === 'unparse' ? 256_000 : operation === 'candidate' ? 512 : 16;

const defaultSpawn: PythonWorkerSpawn = (command, args, options) => spawn(command, args, options);

/** Post-response checks shared by the worker and the spawn-per-call fallback, so both are identical. */
const checkResult = (operation: PythonOperation, result: unknown, maxBytes: number): unknown => {
  if (operation !== 'unparse') return result;
  if (typeof result !== 'string') throw new Error('Python returned invalid source.');
  if (Buffer.byteLength(result) > maxBytes) throw new LimitError('Unparsed Python exceeds the source byte budget.');
  return result;
};

const validationError = (detail: string): Error => new Error(`Python AST validation failed: ${detail}`);

const setRef = (child: ChildProcess, ref: boolean): void => {
  if (ref) child.ref(); else child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    // Child stdio pipes are net.Socket instances; a single downcast keeps ref/unref typed.
    const handle = stream as Socket | null;
    if (ref) handle?.ref(); else handle?.unref();
  }
};

interface PendingCall {
  operation: PythonOperation;
  maxBytes: number;
  signal: AbortSignal;
  timer: NodeJS.Timeout;
  onAbort: () => void;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

/**
 * One lazy JSONL serializer child per run, multiplexing all four bridge operations with per-request
 * ids. Cancelling a call rejects only that call; a crash or timeout rejects every in-flight call
 * deterministically and the next call restarts the child. A missing or repeatedly crashing python3
 * falls back to the pre-worker spawn-per-call path. The child is unref'd while idle (an exit hook
 * kills it when the parent exits) and ref'd while calls are in flight, so a library caller that
 * forgets to close the process default never hangs, and the run context's disposal still kills it.
 */
export class PythonWorker implements PythonBridge, RunContextWorker {
  readonly spawner: PythonWorkerSpawn;
  readonly timeoutMs: number;
  readonly crashLimit: number;
  /** Worker children spawned over this lifetime, for the spawn-count probe. */
  spawnCount = 0;

  private child: ChildProcess | undefined;
  private spawning: Promise<ChildProcess | undefined> | undefined;
  private decoder: StringDecoder | undefined;
  private buffer = '';
  private stderr = '';
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private crashes = 0;
  private fallback = false;
  private disposed = false;
  private exitHook: (() => void) | undefined;

  constructor(options: PythonWorkerOptions = {}) {
    this.spawner = options.spawn ?? defaultSpawn;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.crashLimit = options.crashLimit ?? DEFAULT_CRASH_LIMIT;
  }

  /** True while a child is running; a restarted worker is alive again after the next call. */
  get alive(): boolean { return this.child !== undefined; }

  /** True once the bridge gave up on the worker (missing python3 or repeated crashes). */
  get usingFallback(): boolean { return this.fallback; }

  async run(operation: PythonOperation, payload: unknown, call: PythonBridgeCall): Promise<unknown> {
    if (this.disposed) throw new PythonWorkerDisposedError();
    call.signal.throwIfAborted();
    if (this.fallback) return runOneShot(this.spawner, operation, payload, call, this.timeoutMs);
    const child = await this.ensureChild();
    // dispose() may have raced the spawn: never send after disposal and never fall back to a
    // one-shot child for a disposed worker.
    if (this.disposed) throw new PythonWorkerDisposedError();
    if (child === undefined) return runOneShot(this.spawner, operation, payload, call, this.timeoutMs);
    return this.send(child, operation, payload, call);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    this.child = undefined;
    this.decoder = undefined;
    this.buffer = '';
    this.rejectAll(new PythonWorkerDisposedError());
    if (this.exitHook !== undefined) {
      process.off('exit', this.exitHook);
      this.exitHook = undefined;
    }
    if (child !== undefined) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }

  private ensureChild(): Promise<ChildProcess | undefined> {
    if (this.child !== undefined) return Promise.resolve(this.child);
    this.spawning ??= this.spawnChild();
    return this.spawning;
  }

  private async spawnChild(): Promise<ChildProcess | undefined> {
    let child: ChildProcess;
    try {
      child = this.spawner('python3', ['-I', '-u', '-c', workerProgram], { env: sanitizedEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      this.spawning = undefined;
      this.fallback = true;
      return undefined;
    }
    this.spawnCount++;
    const started = await new Promise<boolean>(resolve => {
      const done = (value: boolean): void => {
        child.off('spawn', onSpawn);
        child.off('error', onError);
        child.off('exit', onExit);
        resolve(value);
      };
      const onSpawn = (): void => done(true);
      const onError = (): void => done(false);
      const onExit = (): void => done(false);
      child.once('spawn', onSpawn);
      child.once('error', onError);
      child.once('exit', onExit);
    });
    this.spawning = undefined;
    if (!started) {
      // A spawn failure can emit a second error event; keep it observed so it cannot throw.
      child.on('error', () => { /* the fallback reports the failure */ });
      this.fallback = true;
      return undefined;
    }
    if (this.disposed) {
      // dispose() ran while the handshake was in flight: the child was never attached, so kill it
      // here instead of leaving an orphaned python3 alive for the process lifetime.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      return undefined;
    }
    this.attach(child);
    return child;
  }

  private attach(child: ChildProcess): void {
    this.child = child;
    this.buffer = '';
    this.stderr = '';
    this.decoder = new StringDecoder('utf8');
    child.stdout?.on('data', (chunk: Buffer) => this.onData(child, chunk));
    child.stderr?.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-MAX_STDERR_BYTES); });
    child.stdin?.on('error', error => this.crash(child, validationError(`worker stdin failed: ${error instanceof Error ? error.message : String(error)}`)));
    child.on('error', error => this.crash(child, error));
    child.on('close', (code, signal) => this.crash(child, validationError(`worker exited (${code ?? signal ?? 'unknown'}): ${this.stderr.trim()}`)));
    setRef(child, false);
    if (this.exitHook === undefined) {
      this.exitHook = () => {
        const current = this.child;
        this.child = undefined;
        if (current !== undefined) {
          try { current.kill('SIGKILL'); } catch { /* already gone */ }
        }
      };
      process.on('exit', this.exitHook);
    }
  }

  private send(child: ChildProcess, operation: PythonOperation, payload: unknown, call: PythonBridgeCall): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.child !== child || child.stdin === null) {
        reject(new Error('Python serializer worker is not running.'));
        return;
      }
      const id = this.nextId++;
      const maxBytes = call.maxBytes ?? defaultMaxBytes(operation);
      const timeoutMs = call.timeoutMs ?? this.timeoutMs;
      const timer = setTimeout(() => {
        this.crash(child, validationError(`worker timed out after ${timeoutMs}ms; every in-flight call was rejected and the worker restarted`));
      }, timeoutMs);
      timer.unref();
      const onAbort = (): void => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.settle(id, pending);
        pending.reject(call.signal.reason);
      };
      call.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { operation, maxBytes, signal: call.signal, timer, onAbort, resolve, reject });
      setRef(child, true);
      // The signal can abort while the call awaits a spawning worker; the listener above is not
      // re-fired for an already-aborted signal, so re-check before writing.
      if (call.signal.aborted) { onAbort(); return; }
      try {
        child.stdin.write(JSON.stringify({ id, op: operation, payload }) + '\n', error => {
          if (error) this.crash(child, validationError(`worker stdin failed: ${error.message}`));
        });
      } catch (error) {
        this.crash(child, validationError(`worker stdin failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  private onData(child: ChildProcess, chunk: Buffer): void {
    if (this.child !== child || this.decoder === undefined) return;
    this.buffer += this.decoder.write(chunk);
    if (this.buffer.length > MAX_RESPONSE_BYTES) {
      this.crash(child, new LimitError('Python serializer response exceeds its byte budget.'));
      return;
    }
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim()) this.onLine(child, line);
      index = this.buffer.indexOf('\n');
    }
  }

  private onLine(child: ChildProcess, line: string): void {
    let response: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    try { response = JSON.parse(line) as typeof response; }
    catch { this.crash(child, validationError('worker returned an invalid response line')); return; }
    if (typeof response.id !== 'number' || !Number.isSafeInteger(response.id)) {
      this.crash(child, validationError('worker returned a response without a request id'));
      return;
    }
    const call = this.pending.get(response.id);
    if (call === undefined) return; // cancelled locally; the worker's answer is dropped
    this.settle(response.id, call);
    if (response.ok === true) {
      try { call.resolve(checkResult(call.operation, response.result, call.maxBytes)); }
      catch (error) { call.reject(error); }
    } else {
      call.reject(validationError(typeof response.error === 'string' && response.error ? response.error : 'unknown error'));
    }
  }

  private settle(id: number, call: PendingCall): void {
    this.pending.delete(id);
    clearTimeout(call.timer);
    call.signal.removeEventListener('abort', call.onAbort);
    if (!this.pending.size) {
      const child = this.child;
      if (child !== undefined) setRef(child, false);
    }
  }

  private crash(child: ChildProcess, error: unknown): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.decoder = undefined;
    this.buffer = '';
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    this.crashes++;
    if (this.crashes >= this.crashLimit) this.fallback = true;
    this.rejectAll(error instanceof Error ? error : new Error(String(error)));
  }

  private rejectAll(reason: unknown): void {
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const call of calls) {
      clearTimeout(call.timer);
      call.signal.removeEventListener('abort', call.onAbort);
      call.reject(reason);
    }
  }
}

/**
 * Spawn-per-call fallback: one `python3 -I -c` child per operation, the pre-worker behavior. Used
 * when python3 is missing, after repeated worker crashes, and for foreign worker handles that
 * cannot serve bridge operations.
 */
export function runOneShot(spawner: PythonWorkerSpawn, operation: PythonOperation, payload: unknown, call: PythonBridgeCall, defaultTimeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  call.signal.throwIfAborted();
  const timeoutMs = call.timeoutMs ?? defaultTimeoutMs;
  const maxBytes = call.maxBytes ?? defaultMaxBytes(operation);
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawner('python3', ['-I', '-u', '-c', workerProgram], { env: sanitizedEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) { reject(error); return; }
    const decoder = new StringDecoder('utf8');
    let output = '', stderr = '', settled = false;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      call.signal.removeEventListener('abort', onAbort);
    };
    const fail = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(reason);
    };
    const onAbort = (): void => fail(call.signal.reason);
    timer = setTimeout(() => fail(validationError(`worker timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref();
    call.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', error => fail(error));
    child.stdin?.on('error', error => fail(error));
    child.stdout?.on('data', (chunk: Buffer) => {
      output += decoder.write(chunk);
      if (output.length > MAX_RESPONSE_BYTES) fail(new LimitError('Python serializer response exceeds its byte budget.'));
    });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-MAX_STDERR_BYTES); });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      cleanup();
      output += decoder.end();
      if (call.signal.aborted) { reject(call.signal.reason); return; }
      const line = output.split('\n').find(part => part.trim() !== '');
      if (code !== 0) { reject(validationError(stderr.trim() || `exit ${code}`)); return; }
      let response: { ok?: unknown; result?: unknown; error?: unknown };
      try { response = JSON.parse(line ?? '') as typeof response; }
      catch { reject(validationError(stderr.trim() || 'invalid response')); return; }
      if (response.ok !== true) { reject(validationError(typeof response.error === 'string' && response.error ? response.error : 'unknown error')); return; }
      try { resolve(checkResult(operation, response.result, maxBytes)); }
      catch (error) { reject(error); }
    });
    // The signal can abort while the child spawns; the listener above is not re-fired for an
    // already-aborted signal, so re-check before writing.
    if (call.signal.aborted) { onAbort(); return; }
    child.stdin?.end(JSON.stringify({ id: 1, op: operation, payload }) + '\n');
  });
}

/** The stateless pre-worker bridge, for contexts whose worker handle cannot serve bridge operations. */
export const spawnPerCallBridge: PythonBridge = {
  run: (operation, payload, call) => runOneShot(defaultSpawn, operation, payload, call),
  dispose: () => undefined,
};
