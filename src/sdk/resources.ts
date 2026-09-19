import { CancelledError, LimitError, type ResourceKind, type TokenUsage } from './types.js';

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

interface Waiter {
  signal: AbortSignal;
  resolve: () => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

interface SharedResources {
  readonly limits: RunLimits;
  readonly concurrency: number;
  readonly used: RunLimits;
  readonly usage: TokenUsage;
  inflight: number;
  readonly waiters: Waiter[];
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
  private inheritedPermit: { active: boolean } | undefined;

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
      inflight: 0,
      waiters: [],
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
    child.inheritedPermit = this.inheritedPermit;
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
      limits: { ...this.shared.limits },
      usage: { ...this.shared.usage },
      inflight: this.shared.inflight,
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
      throw new LimitError(`${resource} budget exhausted (${limit}).`, {
        evidence: { kind: 'exhausted', resource, limit, used },
      });
    }
    for (const scope of this.scopes) {
      const scopeLimit = scope.limits[resource];
      if (scopeLimit !== undefined && scope.used[resource] + count > scopeLimit) {
        throw new LimitError(`${resource} scoped budget exhausted (${scopeLimit}).`, {
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
      throw new LimitError(`Run deadline exceeded after ${timeoutMs}ms.`, {
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
    if (this.inheritedPermit !== undefined) {
      if (!this.inheritedPermit.active) throw new Error('The inherited concurrency permit is no longer active.');
      this.throwIfAborted();
      return operation(this.signal);
    }
    await this.acquire();
    // AbortSignal.timeout is unref'ed by Node; keep the process alive only while work is pending.
    const deadlineKeeper = this.deadlineAt === undefined
      ? undefined
      : setTimeout(() => {}, Math.max(1, this.deadlineAt - Date.now() + 1));
    try {
      this.throwIfAborted();
      return await operation(this.signal);
    } finally {
      if (deadlineKeeper !== undefined) clearTimeout(deadlineKeeper);
      this.release();
    }
  }

  /** Delegate the current permit to nested resource calls made by one admitted node. */
  async withPermitScope<T>(operation: (resources: RunResources) => Promise<T>): Promise<T> {
    return this.withPermit(async () => {
      const lease = { active: true };
      const scoped = this.fork();
      scoped.inheritedPermit = lease;
      try {
        return await operation(scoped);
      } finally {
        lease.active = false;
      }
    });
  }

  private acquire(): Promise<void> {
    this.throwIfAborted();
    if (this.shared.inflight < this.shared.concurrency) {
      this.shared.inflight++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = {} as Waiter;
      waiter.signal = this.signal;
      waiter.resolve = (): void => {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        resolve();
      };
      waiter.reject = reject;
      waiter.onAbort = (): void => {
        const index = this.shared.waiters.indexOf(waiter);
        if (index >= 0) this.shared.waiters.splice(index, 1);
        try { this.throwIfAborted(); } catch (error) { reject(error); }
      };
      this.signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.shared.waiters.push(waiter);
    });
  }

  private release(): void {
    const waiter = this.shared.waiters.shift();
    if (waiter) waiter.resolve();
    else this.shared.inflight--;
  }

  private effectiveLimit(resource: ResourceKind): number {
    return this.scopes.reduce((limit, scope) => Math.min(limit, scope.limits[resource] ?? limit), this.shared.limits[resource]);
  }
}
