/**
 * Metrics Endpoint - /api/metrics
 *
 * 用于 Prometheus 抓取，格式 text/plain; version=0.0.4。
 * 暴露 5 个核心 metric：
 *   # HELP llm_tokens_total Total LLM tokens consumed
 *   # TYPE llm_tokens_total counter
 *   llm_tokens_total{model="deepseek-v4-flash"} 12345
 *
 *   # HELP active_sessions Number of active agent sessions
 *   # TYPE active_sessions gauge
 *   active_sessions 3
 *
 *   # HELP tool_call_total Total tool calls
 *   # TYPE tool_call_total counter
 *   tool_call_total{tool="get_weather",status="ok"} 42
 *
 *   # HELP turn_duration_seconds Turn duration in seconds
 *   # TYPE turn_duration_seconds histogram
 *   turn_duration_seconds_sum 12.345
 *   turn_duration_seconds_count 5
 *
 *   # HELP rate_limit_hits_total Total rate limit hits
 *   # TYPE rate_limit_hits_total counter
 *   rate_limit_hits_total{action="message"} 1
 */

import { metrics } from "@/lib/metrics-registry";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return new Response(metrics.render(), {
    headers: {
      "Content-Type": "text/plain; version=0.0.4",
      "Cache-Control": "no-cache",
    },
  });
}
