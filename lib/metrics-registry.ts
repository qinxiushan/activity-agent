/**
 * Metrics Registry - Prometheus text-format metrics collector
 *
 * 自实现（不引入 prom-client），暴露核心运行指标：
 * 1. llm_tokens_total      counter   — 累计 token 量（按 model 区分）
 * 2. active_sessions       gauge     — 当前活跃 session 数
 * 3. tool_call_total       counter   — 工具调用次数（按 tool/status 区分）
 * 4. turn_duration_seconds histogram — turn 耗时秒数分布
 * 5. rate_limit_hits_total counter   — 限流命中次数（按 action 区分）
 *
 * 设计原则：
 * - 无外部依赖
 * - 线程安全：单 Node.js 进程 + 同步数据结构
 * - 格式兼容：输出符合 Prometheus exposition format (text/plain; version=0.0.4)
 */

type MetricType = "counter" | "gauge" | "histogram";

interface MetricDef {
  name: string;
  help: string;
  type: MetricType;
  labelNames: string[];
  buckets?: number[];
}

type Labels = Record<string, string>;

class MetricsRegistry {
  private defs: MetricDef[] = [];
  private counters = new Map<string, Map<string, number>>();
  private gauges = new Map<string, Map<string, number>>();
  private histograms = new Map<string, Map<string, number[]>>();

  registerCounter(name: string, help: string, labelNames: string[] = []): this {
    this.defs.push({ name, help, type: "counter", labelNames });
    this.counters.set(name, new Map());
    return this;
  }

  registerGauge(name: string, help: string, labelNames: string[] = []): this {
    this.defs.push({ name, help, type: "gauge", labelNames });
    this.gauges.set(name, new Map());
    return this;
  }

  registerHistogram(name: string, help: string, labelNames: string[] = []): this {
    this.defs.push({
      name,
      help,
      type: "histogram",
      labelNames,
      buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    });
    this.histograms.set(name, new Map());
    return this;
  }

  inc(name: string, labels: Labels = {}, value = 1): void {
    const m = this.counters.get(name);
    if (!m) throw new Error(`Counter "${name}" not registered`);
    const key = this.serializeLabels(labels);
    m.set(key, (m.get(key) ?? 0) + value);
  }

  set(name: string, value: number, labels: Labels = {}): void {
    const m = this.gauges.get(name);
    if (!m) throw new Error(`Gauge "${name}" not registered`);
    const key = this.serializeLabels(labels);
    m.set(key, value);
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const m = this.histograms.get(name);
    if (!m) throw new Error(`Histogram "${name}" not registered`);
    const key = this.serializeLabels(labels);
    const arr = m.get(key) ?? [];
    arr.push(value);
    if (arr.length > 1000) arr.shift();
    m.set(key, arr);
  }

  /**
   * 渲染为 Prometheus text/plain 格式
   * 符合 https://prometheus.io/docs/instrumenting/exposition_formats/
   */
  render(): string {
    const lines: string[] = [];
    for (const def of this.defs) {
      lines.push(`# HELP ${def.name} ${def.help}`);
      lines.push(`# TYPE ${def.name} ${def.type}`);
      const data = this.getDataStore(def.name, def.type);
      for (const [key, val] of data) {
        if (def.type === "histogram") {
          const samples = val as number[];
          const buckets = def.buckets ?? [];
          for (const bucket of buckets) {
            const count = samples.filter((sample) => sample <= bucket).length;
            lines.push(`${def.name}_bucket${this.appendLeLabel(key, bucket)} ${count}`);
          }
          lines.push(`${def.name}_bucket${this.appendLeLabel(key, "+Inf")} ${samples.length}`);
          if (samples.length > 0) {
            const sum = samples.reduce((a, b) => a + b, 0);
            lines.push(`${def.name}_sum${key} ${sum}`);
          }
          lines.push(`${def.name}_count${key} ${samples.length}`);
        } else {
          lines.push(`${def.name}${key} ${val}`);
        }
      }
    }
    return lines.join("\n") + "\n";
  }

  /**
   * 读取 metric 当前值（用于测试）
   */
  getCounterValue(name: string, labels: Labels = {}): number {
    const m = this.counters.get(name);
    if (!m) return 0;
    return m.get(this.serializeLabels(labels)) ?? 0;
  }

  getGaugeValue(name: string, labels: Labels = {}): number | undefined {
    const m = this.gauges.get(name);
    if (!m) return undefined;
    return m.get(this.serializeLabels(labels));
  }

  private getDataStore(name: string, type: MetricType): Map<string, number | number[]> {
    if (type === "counter") return this.counters.get(name) ?? new Map();
    if (type === "gauge") return this.gauges.get(name) ?? new Map();
    return this.histograms.get(name) ?? new Map();
  }

  private serializeLabels(labels: Labels): string {
    const keys = Object.keys(labels).sort();
    if (keys.length === 0) return "";
    return `{${keys.map((k) => `${k}="${labels[k].replace(/"/g, '\\"')}"`).join(",")}}`;
  }

  private appendLeLabel(serializedLabels: string, le: number | string): string {
    const leLabel = `le="${String(le)}"`;
    if (!serializedLabels) return `{${leLabel}}`;
    return serializedLabels.replace(/\}$/, `,${leLabel}}`);
  }
}

// 全局单例
export const metrics = new MetricsRegistry();

// ─── 4 个核心 metric 注册 ────────────────────────────────────────

metrics.registerCounter("llm_tokens_total", "Total LLM tokens consumed", ["model"]);
metrics.registerGauge("active_sessions", "Number of active agent sessions");
metrics.registerCounter("tool_call_total", "Total tool calls", ["tool", "status"]);
metrics.registerHistogram("turn_duration_seconds", "Turn duration in seconds");
metrics.registerCounter("rate_limit_hits_total", "Total rate limit hits", ["action"]);
metrics.registerCounter("tool_span_total", "Persisted SDK tool execution spans", ["tool", "status"]);
metrics.registerHistogram("tool_duration_seconds", "Exact SDK tool execution duration in seconds", ["tool", "status"]);
metrics.registerCounter("tool_span_orphan_total", "Tool execution end events without a matching start");
metrics.registerCounter("tool_span_persist_failure_total", "Tool execution spans that failed to persist");
