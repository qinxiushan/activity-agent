import { randomUUID } from "node:crypto";
import { getRedis } from "./redis";
import { metrics } from "./metrics-registry";

const WINDOW_MS = 60_000;
const REDIS_WARN_INTERVAL_MS = 30_000;

type RateLimitAction = "message" | `tool:${string}`;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
  limit: number;
  source: "redis" | "memory" | "disabled";
}

declare global {
  // eslint-disable-next-line no-var
  var __memoryRateLimiter:
    | Map<string, number[]>
    | undefined;
}

let lastRedisWarnAt = 0;

function nowMs(): number {
  return Date.now();
}

function getLimitPerMinute(): number {
  const raw = Number(process.env.RATE_LIMIT_MSGS_PER_MIN ?? "20");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20;
}

function getToolLimitPerMinute(toolName: string): number | null {
  if (toolName === "commit_itinerary") return 5;
  // One normal submission plus one stale-token recovery. Prevent blind retry loops.
  if (toolName === "submit_plan") return 2;
  if (toolName === "detect_user_region") return 10;
  if (toolName === "get_place_details") return 60;
  if (toolName === "compare_route_options") return 30;
  if (toolName === "distance_matrix") return 20;
  if (toolName === "calculate_budget") return 30;
  if (toolName === "search_activities" || toolName === "search_restaurants" ||
      toolName === "search_places_text" || toolName === "search_places_nearby" ||
      toolName === "discover_place_candidates") return 30;
  return null;
}

export function isRateLimitEnabled(): boolean {
  return process.env.RATE_LIMIT_ENABLED === "true";
}

export function isMessageRateLimitedCommand(command: { type?: unknown } | null | undefined): boolean {
  const type = typeof command?.type === "string" ? command.type : "";
  return type === "prompt" || type === "steer" || type === "follow_up" || type === "clarification_response";
}

function getMemoryWindowStore(): Map<string, number[]> {
  if (!globalThis.__memoryRateLimiter) {
    globalThis.__memoryRateLimiter = new Map();
  }
  return globalThis.__memoryRateLimiter;
}

function recordRateLimitHit(action: RateLimitAction): void {
  metrics.inc("rate_limit_hits_total", { action });
}

function logRedisFallbackOnce(err: unknown): void {
  const now = nowMs();
  if (now - lastRedisWarnAt < REDIS_WARN_INTERVAL_MS) return;
  lastRedisWarnAt = now;
  const message = err instanceof Error ? err.message : String(err);
  console.error("[rate-limiter] redis unavailable, using in-memory fallback:", message);
}

function runMemorySlidingWindow(key: string, limit: number, now: number): RateLimitResult {
  const store = getMemoryWindowStore();
  const existing = store.get(key) ?? [];
  const cutoff = now - WINDOW_MS;
  const active = existing.filter((ts) => ts > cutoff);
  const oldest = active[0];

  if (active.length >= limit) {
    const retryAfterMs = oldest ? Math.max(1, WINDOW_MS - (now - oldest)) : WINDOW_MS;
    store.set(key, active);
    return {
      allowed: false,
      retryAfterMs,
      remaining: 0,
      limit,
      source: "memory",
    };
  }

  active.push(now);
  store.set(key, active);
  return {
    allowed: true,
    retryAfterMs: 0,
    remaining: Math.max(0, limit - active.length),
    limit,
    source: "memory",
  };
}

async function runRedisSlidingWindow(key: string, limit: number, now: number): Promise<RateLimitResult> {
  const redis = getRedis();
  if (redis.status === "wait") {
    await redis.connect();
  }

  const member = `${now}:${randomUUID()}`;
  const cutoff = now - WINDOW_MS;
  const tx = redis.multi();
  tx.zremrangebyscore(key, 0, cutoff);
  tx.zcard(key);
  tx.zadd(key, now, member);
  tx.pexpire(key, WINDOW_MS);
  const results = await tx.exec();
  if (!results) {
    throw new Error("redis transaction aborted");
  }

  const countBefore = Number(results[1]?.[1] ?? 0);
  if (countBefore >= limit) {
    await redis.zrem(key, member);
    const oldestRaw = await redis.zrange(key, 0, 0, "WITHSCORES");
    const oldestScore = oldestRaw.length >= 2 ? Number(oldestRaw[1]) : now;
    const retryAfterMs = Math.max(1, WINDOW_MS - (now - oldestScore));
    return {
      allowed: false,
      retryAfterMs,
      remaining: 0,
      limit,
      source: "redis",
    };
  }

  return {
    allowed: true,
    retryAfterMs: 0,
    remaining: Math.max(0, limit - (countBefore + 1)),
    limit,
    source: "redis",
  };
}

export async function checkMessageRateLimit(userId: string): Promise<RateLimitResult> {
  const limit = getLimitPerMinute();
  if (!isRateLimitEnabled()) {
    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: limit,
      limit,
      source: "disabled",
    };
  }

  const now = nowMs();
  const key = `rate_limit:user:${userId}:chat_messages`;

  try {
    const result = await runRedisSlidingWindow(key, limit, now);
    if (!result.allowed) recordRateLimitHit("message");
    return result;
  } catch (err) {
    logRedisFallbackOnce(err);
    const result = runMemorySlidingWindow(key, limit, now);
    if (!result.allowed) recordRateLimitHit("message");
    return result;
  }
}

export async function checkToolRateLimit(userId: string, toolName: string): Promise<RateLimitResult | null> {
  const limit = getToolLimitPerMinute(toolName);
  if (!limit) return null;
  if (!isRateLimitEnabled()) {
    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: limit,
      limit,
      source: "disabled",
    };
  }

  const now = nowMs();
  const key = `rate_limit:user:${userId}:tool:${toolName}`;
  const action = `tool:${toolName}` as RateLimitAction;

  try {
    const result = await runRedisSlidingWindow(key, limit, now);
    if (!result.allowed) recordRateLimitHit(action);
    return result;
  } catch (err) {
    logRedisFallbackOnce(err);
    const result = runMemorySlidingWindow(key, limit, now);
    if (!result.allowed) recordRateLimitHit(action);
    return result;
  }
}

export function buildRateLimitHeaders(retryAfterMs: number): HeadersInit {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return {
    "Retry-After": String(retryAfterSeconds),
  };
}

export function formatRateLimitError(retryAfterMs: number): {
  error: "rate_limited";
  retryAfterMs: number;
  message: string;
} {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return {
    error: "rate_limited",
    retryAfterMs,
    message: `发送太频繁，请约 ${retryAfterSeconds} 秒后重试`,
  };
}
