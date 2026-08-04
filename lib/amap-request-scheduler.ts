import { metrics } from "./metrics-registry";

export interface SchedulerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ScheduledRequest<T> {
  value: T;
  queueWaitMs: number;
  executionMs: number;
}

const SYSTEM_CLOCK: SchedulerClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function configuredQps(): number {
  const parsed = Number(process.env.AMAP_QPS_PER_SERVICE ?? 2.5);
  if (!Number.isFinite(parsed) || parsed <= 0) return 2.5;
  // The personal AMap quota used by this project is 3 requests/second/service.
  return Math.min(parsed, 3);
}

/**
 * Process-wide admission scheduler. Calls for the same AMap service are evenly
 * spaced; calls for different services remain parallel.
 */
export class AmapRequestScheduler {
  private readonly nextAllowedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, number>();
  private readonly intervalMs: number;

  constructor(options: { qps?: number; clock?: SchedulerClock } = {}) {
    const qps = Math.min(Math.max(options.qps ?? configuredQps(), 0.1), 3);
    this.intervalMs = Math.ceil(1_000 / qps);
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  private readonly clock: SchedulerClock;

  async schedule<T>(service: string, task: () => Promise<T>): Promise<ScheduledRequest<T>> {
    const queuedAt = this.clock.now();
    // Reservation is synchronous, so concurrent callers receive distinct slots.
    const admittedAt = Math.max(queuedAt, this.nextAllowedAt.get(service) ?? queuedAt);
    this.nextAllowedAt.set(service, admittedAt + this.intervalMs);
    const queueWaitMs = Math.max(0, admittedAt - queuedAt);
    if (queueWaitMs > 0) await this.clock.sleep(queueWaitMs);

    const executionStartedAt = this.clock.now();
    const count = (this.inFlight.get(service) ?? 0) + 1;
    this.inFlight.set(service, count);
    metrics.set("amap_inflight_requests", count, { service });
    metrics.observe("amap_queue_wait_seconds", queueWaitMs / 1_000, { service });
    try {
      const value = await task();
      return {
        value,
        queueWaitMs,
        executionMs: Math.max(0, this.clock.now() - executionStartedAt),
      };
    } finally {
      const remaining = Math.max(0, (this.inFlight.get(service) ?? 1) - 1);
      this.inFlight.set(service, remaining);
      metrics.set("amap_inflight_requests", remaining, { service });
    }
  }

  /** Push future admissions back after an upstream CUQPS response. */
  defer(service: string, cooldownMs: number): void {
    const deferredUntil = this.clock.now() + Math.max(0, cooldownMs);
    this.nextAllowedAt.set(service, Math.max(this.nextAllowedAt.get(service) ?? 0, deferredUntil));
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __activityAmapRequestScheduler: AmapRequestScheduler | undefined;
}

export const amapRequestScheduler =
  globalThis.__activityAmapRequestScheduler ?? new AmapRequestScheduler();
globalThis.__activityAmapRequestScheduler = amapRequestScheduler;
