import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getPool, isDbConfigured } from "./db";
import { getStorageBackend } from "./storage";

export interface AuditEvent {
  ts?: string;
  userId?: string | null;
  sessionId?: string | null;
  eventType:
    | "tool_call"
    | "tool_blocked"
    | "tool_would_block"
    | "rate_limited"
    | "injection_detected"
    | "login"
    | "login_failed"
    | "input_rejected";
  toolName?: string | null;
  detail?: Record<string, unknown>;
}

export interface AuditQuery {
  type?: string | null;
  limit?: number;
}

export interface AuditRecord {
  ts: string;
  userId: string | null;
  sessionId: string | null;
  eventType: string;
  toolName: string | null;
  detail: Record<string, unknown>;
}

const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_BATCH_SIZE = 50;

declare global {
  // eslint-disable-next-line no-var
  var __auditQueue: AuditEvent[] | undefined;
  // eslint-disable-next-line no-var
  var __auditFlushTimer: ReturnType<typeof setTimeout> | null | undefined;
}

function getQueue(): AuditEvent[] {
  if (!globalThis.__auditQueue) globalThis.__auditQueue = [];
  return globalThis.__auditQueue;
}

function clearFlushTimer(): void {
  if (globalThis.__auditFlushTimer) {
    clearTimeout(globalThis.__auditFlushTimer);
    globalThis.__auditFlushTimer = null;
  }
}

function scheduleFlush(): void {
  if (globalThis.__auditFlushTimer) return;
  globalThis.__auditFlushTimer = setTimeout(() => {
    globalThis.__auditFlushTimer = null;
    void flushAuditLogs();
  }, FLUSH_INTERVAL_MS);
}

function getAuditDir(): string {
  return process.env.AUDIT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent", "audit");
}

function shouldUsePostgres(): boolean {
  return getStorageBackend() === "postgres" && isDbConfigured();
}

function normalizeEvent(event: AuditEvent): AuditRecord {
  return {
    ts: event.ts ?? new Date().toISOString(),
    userId: event.userId ?? null,
    sessionId: event.sessionId ?? null,
    eventType: event.eventType,
    toolName: event.toolName ?? null,
    detail: event.detail ?? {},
  };
}

export function buildAuditInsertPlaceholders(batchSize: number): string[] {
  return Array.from({ length: batchSize }, (_, index) => {
    const base = index * 6;
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`;
  });
}

async function flushToPostgres(batch: AuditRecord[]): Promise<void> {
  const values: unknown[] = [];
  const placeholders = buildAuditInsertPlaceholders(batch.length);
  batch.forEach((event) => {
    values.push(event.ts, event.userId, event.sessionId, event.eventType, event.toolName, JSON.stringify(event.detail));
  });
  await getPool().query(
    `INSERT INTO audit_logs (ts, user_id, session_id, event_type, tool_name, detail)
     VALUES ${placeholders.join(",")}`,
    values,
  );
}

async function flushToFile(batch: AuditRecord[]): Promise<void> {
  const dir = getAuditDir();
  await mkdir(dir, { recursive: true });
  const grouped = new Map<string, AuditRecord[]>();
  for (const event of batch) {
    const day = event.ts.slice(0, 10).replace(/-/g, "");
    const list = grouped.get(day) ?? [];
    list.push(event);
    grouped.set(day, list);
  }
  for (const [day, events] of grouped) {
    const filePath = path.join(dir, `${day}.jsonl`);
    const payload = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    await appendFile(filePath, payload, "utf8");
  }
}

export function audit(event: AuditEvent): void {
  const queue = getQueue();
  queue.push(event);
  if (queue.length >= FLUSH_BATCH_SIZE) {
    clearFlushTimer();
    void flushAuditLogs();
    return;
  }
  scheduleFlush();
}

export async function flushAuditLogs(): Promise<void> {
  clearFlushTimer();
  const queue = getQueue();
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length).map(normalizeEvent);
  try {
    if (shouldUsePostgres()) {
      await flushToPostgres(batch);
    } else {
      await flushToFile(batch);
    }
  } catch (error) {
    console.error("[audit] flush failed:", error instanceof Error ? error.message : error);
    // Best-effort durability: put the batch back at the front for the next flush attempt.
    queue.unshift(...batch.map((event) => ({
      ts: event.ts,
      userId: event.userId,
      sessionId: event.sessionId,
      eventType: event.eventType as AuditEvent["eventType"],
      toolName: event.toolName,
      detail: event.detail,
    })));
    scheduleFlush();
  }
}

export async function listAuditEvents(query: AuditQuery = {}): Promise<AuditRecord[]> {
  const limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 50)));
  const type = query.type?.trim() || null;
  await flushAuditLogs();

  if (shouldUsePostgres()) {
    const params: unknown[] = [];
    let sql = "SELECT ts, user_id, session_id, event_type, tool_name, detail FROM audit_logs";
    if (type) {
      params.push(type);
      sql += ` WHERE event_type=$${params.length}`;
    }
    params.push(limit);
    sql += ` ORDER BY ts DESC LIMIT $${params.length}`;
    const { rows } = await getPool().query(sql, params);
    return rows.map((row) => ({
      ts: typeof row.ts === "string" ? row.ts : new Date(row.ts).toISOString(),
      userId: row.user_id ?? null,
      sessionId: row.session_id ?? null,
      eventType: row.event_type,
      toolName: row.tool_name ?? null,
      detail: typeof row.detail === "object" && row.detail !== null ? row.detail as Record<string, unknown> : {},
    }));
  }

  const dir = getAuditDir();
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }

  const records: AuditRecord[] = [];
  for (const name of names) {
    const text = await readFile(path.join(dir, name), "utf8").catch(() => "");
    if (!text) continue;
    const lines = text.trim().split("\n").reverse();
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as AuditRecord;
        if (type && parsed.eventType !== type) continue;
        records.push(parsed);
        if (records.length >= limit) return records;
      } catch {
        // ignore malformed line
      }
    }
  }
  return records;
}
