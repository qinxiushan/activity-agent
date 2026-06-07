"use client";

import type { ActivityToolCall, ActivityPlanState } from "@/hooks/useActivitySession";

interface BookingDetails {
  orderId: string;
  restaurantName: string;
  date: string;
  time: string;
  partySize: number;
  confirmationCode?: string;
  status: string;
}

function extractBooking(toolCalls: ActivityToolCall[]): BookingDetails | null {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i]!;
    if (tc.name !== "reservation_exec" && tc.name !== "query_booking") continue;
    if (!tc.ok) continue;
    const parsed = parseBookingResult(tc.result);
    if (!parsed) continue;
    const orderId = (parsed.orderId as string) ?? "";
    if (!orderId) continue;
    const restaurantName = (parsed.restaurantName as string) ?? "";
    const date = (parsed.date as string) ?? "";
    const time = (parsed.time as string) ?? "";
    const partySize = typeof parsed.partySize === "number" ? parsed.partySize : 2;
    const confirmationCode = (parsed.confirmationCode as string | undefined) ?? (parsed.code as string | undefined);
    const status = (parsed.status as string) ?? "unknown";
    return { orderId, restaurantName, date, time, partySize, confirmationCode, status };
  }
  return null;
}

function parseBookingResult(result: unknown): Record<string, unknown> | null {
  if (result === undefined || result === null) return null;
  if (typeof result === "string") {
    try { return JSON.parse(result) as Record<string, unknown>; } catch { return null; }
  }
  if (typeof result === "object") return result as Record<string, unknown>;
  return null;
}

export function BookingCard({ toolCalls, planState }: { toolCalls: ActivityToolCall[]; planState: ActivityPlanState | null }) {
  const booking = extractBooking(toolCalls);
  const isExecuting = planState?.phase === "executing" || planState?.phase === "completed";

  if (!booking && !isExecuting) return null;

  if (!booking) {
    return (
      <div style={{
        background: "var(--bg-panel)", border: "1px solid var(--border)",
        borderRadius: 12, padding: "16px 18px", marginBottom: 12,
      }}>
        <div style={{
          fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase",
          letterSpacing: 0.6, marginBottom: 12, fontWeight: 600,
        }}>
          预订中…
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          正在调用 reservation_exec…
        </div>
      </div>
    );
  }

  const statusColor = booking.status === "confirmed" || booking.status === "notified"
    ? "#10b981"
    : booking.status === "failed"
      ? "#ef4444"
      : "#f59e0b";

  return (
    <div style={{
      background: "linear-gradient(135deg, color-mix(in srgb, var(--accent) 8%, var(--bg-panel)), var(--bg-panel))",
      border: "1px solid color-mix(in srgb, var(--accent) 30%, var(--border))",
      borderRadius: 12, padding: "16px 18px", marginBottom: 12,
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 12,
      }}>
        <div style={{
          fontSize: 11, color: "var(--accent)", textTransform: "uppercase",
          letterSpacing: 0.6, fontWeight: 700,
        }}>
          预订确认
        </div>
        <div style={{
          fontSize: 9, padding: "2px 8px", borderRadius: 10,
          background: statusColor, color: "white", fontWeight: 600, textTransform: "uppercase",
        }}>
          {booking.status}
        </div>
      </div>

      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
        {booking.restaurantName}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 11, color: "var(--text-muted)" }}>
        <div>
          <div style={{ color: "var(--text-dim)", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4 }}>日期</div>
          <div style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{booking.date}</div>
        </div>
        <div>
          <div style={{ color: "var(--text-dim)", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4 }}>时间</div>
          <div style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{booking.time}</div>
        </div>
        <div>
          <div style={{ color: "var(--text-dim)", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4 }}>人数</div>
          <div style={{ color: "var(--text)" }}>{booking.partySize} 人</div>
        </div>
        {booking.confirmationCode && (
          <div>
            <div style={{ color: "var(--text-dim)", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4 }}>确认码</div>
            <div style={{ color: "var(--accent)", fontWeight: 700, fontFamily: "var(--font-mono)" }}>{booking.confirmationCode}</div>
          </div>
        )}
      </div>

      <div style={{
        marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)",
        fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)",
      }}>
        订单号: {booking.orderId}
      </div>
    </div>
  );
}
