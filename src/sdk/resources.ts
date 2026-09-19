import { CancelledError, ResourceExhaustedError, type ResourceKind, type TokenUsage } from './types.js';

export interface RunLimits {
  decisions: number;
  nodes: number;
}

export interface RunResourceOptions {
  limits?: Partial<RunLimits>;
  concurrency?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RunResourceSnapshot {
  used: RunLimits;
  limits: RunLimits;
  usage: TokenUsage;
  inflight: number;
}

/** Read-only run information exposed to program nodes and validators. */
export interface ProgramResourceView {
  readonly signal: AbortSignal;
  readonly concurrency: number;
  snapshot(): RunResourceSnapshot;
  effectiveLimits(): RunLimits;
  throwIfAborted(): void;
}

const resourceViews = new WeakMap<RunResources, ProgramResourceView>();

export const resourceView = (resources: RunResources): ProgramResourceView => {
  const existing = resourceViews.get(resources);
  if (existing !== undefined) return existing;
  const view = Object.freeze({
    get signal(): AbortSignal { return resources.signal; },
    get concurrency(): number { return resources.concurrency; },
    snapshot: (): RunResourceSnapshot => resources.snapshot(),
    effectiveLimits: (): RunLimits => resources.effectiveLimits(),
    throwIfAborted: (): void => resources.throwIfAborted(),
  });
  resourceViews.set(resources, view);
  return view;
};

interface Waiter {
  signal: AbortSignal;
  active: boolean;
  resolve: () => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

interface PermitGate {
  inflight: number;
  head: number;
  readonly waiters: Waiter[];
}

interface SharedResources {
  readonly limits: RunLimits;
  readonly concurrency: number;
  readonly used: RunLimits;
  readonly usage: TokenUsage;
  readonly providerGate: PermitGate;
  readonly nodeGate: PermitGate;
}

interface ScopedLimits {
  readonly limits: Partial<RunLimits>;
  readonly used: RunLimits;
}

const UNBOUNDED = Number.MAX_SAFE_INTEGER;
const DEFAULT_LIMITS: RunLimits = {
  decisions: UNBOUNDED,
  nodes: UNBOUNDED,
};

const validateCount = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer.`);
};

const reasonMessage = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason ?? 'Run cancelled.');
export class RunResources {
  get signal(): AbortSignal { return this.currentSignal; }

  private currentSignal: AbortSignal;
  private deadlineSignal: AbortSignal | undefined;
  private timeoutMs: number | undefined;
  private deadlineAt: number | undefined;
  private shared: SharedResources;
  private scopes: ScopedLimits[] = [];

  constructor(options: RunResourceOptions = {}) {
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    for (const [name, value] of Object.entries(limits)) validateCount(name, value);
    const concurrency = options.concurrency ?? 4;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive safe integer.');
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error('timeoutMs must be a positive safe integer.');
    }

    if (options.timeoutMs !== undefined) {
      this.deadlineSignal = AbortSignal.timeout(options.timeoutMs);
      this.deadlineAt = Date.now() + options.timeoutMs;
    }
    this.timeoutMs = options.timeoutMs;
    const signals = [options.signal, this.deadlineSignal].filter((signal): signal is AbortSignal => signal !== undefined);
    this.currentSignal = signals.length === 0 ? new AbortController().signal : signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    this.shared = {
      limits,
      concurrency,
      used: { decisions: 0, nodes: 0 },
      usage: { inputTokens: 0, outputTokens: 0 },
      providerGate: { inflight: 0, head: 0, waiters: [] },
      nodeGate: { inflight: 0, head: 0, waiters: [] },
    };
  }

  fork(signal?: AbortSignal, limits?: Partial<RunLimits>): RunResources {
    const signals = [this.signal, signal].filter((value): value is AbortSignal => value !== undefined);
    const child = new RunResources();
    child.shared = this.shared;
    child.deadlineSignal = this.deadlineSignal;
    child.timeoutMs = this.timeoutMs;
    child.deadlineAt = this.deadlineAt;
    child.currentSignal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    child.scopes = [...this.scopes];
    if (limits !== undefined) {
      for (const [name, value] of Object.entries(limits) as Array<[keyof RunLimits, number]>) {
        validateCount(name, value);
        const parentLimit = this.effectiveLimit(name);
        if (value > parentLimit) throw new Error(`${name} child limit (${value}) cannot exceed parent limit (${parentLimit}).`);
      }
      child.scopes.push({
        limits: { ...limits },
        used: { decisions: 0, nodes: 0 },
      });
    }
    return child;
  }

  snapshot(): RunResourceSnapshot {
    return {
      used: { ...this.shared.used },
      limits: this.effectiveLimits(),
      usage: { ...this.shared.usage },
      inflight: this.shared.providerGate.inflight + this.shared.nodeGate.inflight,
    };
  }

  effectiveLimits(): RunLimits {
    return {
      decisions: this.effectiveLimit('decisions'),
      nodes: this.effectiveLimit('nodes'),
    };
  }

  addUsage(usage: TokenUsage): void {
    this.shared.usage.inputTokens += usage.inputTokens;
    this.shared.usage.outputTokens += usage.outputTokens;
  }

  assertAvailable(resource: ResourceKind, count = 1): void {
    validateCount('count', count);
    const used = this.shared.used[resource];
    const limit = this.shared.limits[resource];
    if (used + count > limit) {
      throw new ResourceExhaustedError(`${resource} budget exhausted (${limit}).`, {
        evidence: { kind: 'exhausted', resource, limit, used },
      });
    }
    for (const scope of this.scopes) {
      const scopeLimit = scope.limits[resource];
      if (scopeLimit !== undefined && scope.used[resource] + count > scopeLimit) {
        throw new ResourceExhaustedError(`${resource} scoped budget exhausted (${scopeLimit}).`, {
          evidence: { kind: 'exhausted', resource, limit: scopeLimit, used: scope.used[resource] },
        });
      }
    }
  }

  reserve(resource: ResourceKind, count = 1): void {
    this.throwIfAborted();
    this.assertAvailable(resource, count);
    this.shared.used[resource] += count;
    for (const scope of this.scopes) scope.used[resource] += count;
  }

  throwIfAborted(): void {
    if (!this.signal.aborted) return;
    if (this.deadlineSignal?.aborted) {
      const timeoutMs = this.timeoutMs ?? 0;
      throw new ResourceExhaustedError(`Run deadline exceeded after ${timeoutMs}ms.`, {
        cause: this.signal.reason,
        evidence: { kind: 'deadline-exceeded', source: 'deadline', timeoutMs },
      });
    }
    throw new CancelledError(reasonMessage(this.signal.reason), { cause: this.signal.reason });
  }

  async execute<T>(resource: ResourceKind, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.withPermit(async signal => {
      this.reserve(resource);
      return operation(signal);
    });
  }

  /** Run work under the shared concurrency gate without charging another resource. */
  async withPermit<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.withGate(this.shared.providerGate, operation);
  }

  /** Run one program node under the node gate, separate from provider dispatch. */
  async withNodePermit<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.withGate(this.shared.nodeGate, operation);
  }

  get concurrency(): number {
    return this.shared.concurrency;
  }

  /** Settle when work finishes or this resource scope is cancelled. */
  async raceSignal<T>(operation: Promise<T>): Promise<T> {
    this.throwIfAborted();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = (): void => {
        try { this.throwIfAborted(); } catch (error) { reject(error); }
      };
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      if (onAbort !== undefined) this.signal.removeEventListener('abort', onAbort);
    }
  }

  private async withGate<T>(gate: PermitGate, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    await this.acquire(gate);
    // AbortSignal.timeout is unref'ed by Node; keep the process alive only while work is pending.
    const deadlineKeeper = this.deadlineAt === undefined
      ? undefined
      : setTimeout(() => {}, Math.max(1, this.deadlineAt - Date.now() + 1));
    let operationStarted = false;
    let operationSettled = false;
    let detached = false;
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      this.release(gate);
    };
    try {
      this.throwIfAborted();
      const underlying = Promise.resolve().then(() => operation(this.signal));
      operationStarted = true;
      const tracked = underlying.then(
        value => {
          operationSettled = true;
          if (detached) releaseOnce();
          return value;
        },
        error => {
          operationSettled = true;
          if (detached) releaseOnce();
          throw error;
        },
      );
      return await this.raceSignal(tracked);
    } finally {
      if (deadlineKeeper !== undefined) clearTimeout(deadlineKeeper);
      if (!operationStarted || operationSettled) releaseOnce();
      else detached = true;
    }
  }

  private acquire(gate: PermitGate): Promise<void> {
    this.throwIfAborted();
    if (gate.inflight < this.shared.concurrency) {
      gate.inflight++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = {} as Waiter;
      waiter.signal = this.signal;
      waiter.active = true;
      waiter.resolve = (): void => {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        resolve();
      };
      waiter.reject = reject;
      waiter.onAbort = (): void => {
        waiter.active = false;
        try { this.throwIfAborted(); } catch (error) { reject(error); }
      };
      this.signal.addEventListener('abort', waiter.onAbort, { once: true });
      gate.waiters.push(waiter);
    });
  }

  private release(gate: PermitGate): void {
    while (gate.head < gate.waiters.length) {
      const waiter = gate.waiters[gate.head++]!;
      if (!waiter.active) continue;
      waiter.active = false;
      waiter.resolve();
      this.compactWaiters(gate);
      return;
    }
    gate.inflight--;
    this.compactWaiters(gate);
  }

  private compactWaiters(gate: PermitGate): void {
    if (gate.head < 1024 || gate.head * 2 < gate.waiters.length) return;
    gate.waiters.splice(0, gate.head);
    gate.head = 0;
  }

  private effectiveLimit(resource: ResourceKind): number {
    return this.scopes.reduce((limit, scope) => Math.min(limit, scope.limits[resource] ?? limit), this.shared.limits[resource]);
  }
}
