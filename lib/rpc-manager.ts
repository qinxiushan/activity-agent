// 启用扩展 prompt caching（Anthropic 1h / OpenAI 24h）
// 缓存命中时 token 成本降低 ~90%，在 SDK 加载前设置确保生效
if (!process.env.PI_CACHE_RETENTION) {
  process.env.PI_CACHE_RETENTION = "long";
}

import { createAgentSession, SessionManager, DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { cacheSessionPath } from "./session-reader";
import type { AgentSessionLike, ToolInfo } from "./pi-types";
import { getActivityPlannerTools, TOOL_METADATA } from "@/src/tools/activity-tools";
import { ACTIVITY_PLANNER_SYSTEM_PROMPT } from "@/src/prompts/activity-planner";
import { withPlanState, PlanStateManager, classifyUserConfirmation, describeWaitingFor } from "./plan-state";
import { EventAdapter } from "./event-adapter";
import type { StandardEvent } from "./event-types";
import { metrics } from "./metrics-registry";
import phaseGuardExtension from "./extensions/phase-guard";
import { closePool } from "./db";
import { closeRedis } from "./redis";

// ============================================================================
// 资源加载器：注入活动规划器系统提示词
// ============================================================================

function createActivityResourceLoader(cwd: string, agentDir: string): ResourceLoader {
  const baseLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [phaseGuardExtension],
  });
  return {
    getExtensions: () => baseLoader.getExtensions(),
    getSkills: () => baseLoader.getSkills(),
    getPrompts: () => baseLoader.getPrompts(),
    getThemes: () => baseLoader.getThemes(),
    getAgentsFiles: () => baseLoader.getAgentsFiles(),
    getAppendSystemPrompt: () => baseLoader.getAppendSystemPrompt(),
    getSystemPrompt() {
      return ACTIVITY_PLANNER_SYSTEM_PROMPT;
    },
    extendResources: (paths) => baseLoader.extendResources(paths),
    reload: () => baseLoader.reload(),
  };
}

// ============================================================================
// 活动工具定义（模块级单例，planState 通过 AsyncLocalStorage 注入）
// ============================================================================

const ACTIVITY_TOOLS = getActivityPlannerTools();
export const ACTIVITY_TOOL_NAMES = ACTIVITY_TOOLS.map((t) => t.name);

// 工具预设：activity-agent 仅使用活动工具
export const PRESET_NONE: string[] = [];
export const PRESET_DEFAULT: string[] = [...ACTIVITY_TOOL_NAMES];
export const PRESET_FULL: string[] = [...ACTIVITY_TOOL_NAMES];

// ============================================================================
// 类型定义
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: StandardEvent) => void;

// ============================================================================
// AgentSessionWrapper 包装器
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private _alive = true;
  private lastError: { code: string; message: string; retryable: boolean } | null = null;
  public readonly planState: PlanStateManager;
  private eventAdapter: EventAdapter;

  constructor(public readonly inner: AgentSessionLike, planState?: PlanStateManager, userId?: string) {
    this.planState = planState ?? new PlanStateManager(inner.sessionId, undefined, userId);
    this.eventAdapter = new EventAdapter(inner.sessionId, this.planState);
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  isAlive(): boolean {
    return this._alive;
  }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      this.resetIdleTimer();
      const standardEvents = this.eventAdapter.adapt(event as unknown as Parameters<EventAdapter["adapt"]>[0]);
      for (const standardEvent of standardEvents) {
        this.dispatchEvent(standardEvent);
      }
    });
    this.resetIdleTimer();
    // session 创建时记录活跃数 + 基础计数（便于验证 pipeline 工作）
    metrics.set("active_sessions", this.getActiveSessionCountFromRegistry());
    this.onDestroy(() => {
      metrics.set("active_sessions", this.getActiveSessionCountFromRegistry());
    });
  }

  private collectMetrics(event: StandardEvent): void {
    try {
      switch (event.type) {
        case "turn_end": {
          const tokens = event.usage.input + event.usage.output;
          if (tokens > 0) {
            metrics.inc("llm_tokens_total", { model: this.inner.model?.id ?? "unknown" }, tokens);
          }
          metrics.set("active_sessions", this.getActiveSessionCountFromRegistry());
          break;
        }
        case "tool_end":
          metrics.inc("tool_call_total", { tool: event.toolName, status: event.isError ? "error" : "ok" });
          break;
      }
    } catch (e) {
      console.error("[metrics] collect failed:", e);
    }
  }

  private dispatchEvent(event: StandardEvent): void {
    for (const listener of this.listeners) listener(event);
    this.collectMetrics(event);
  }

  /** 从 globalThis 获取活跃 session 数（与 AgentSessionWrapper 共享注册表） */
  private getActiveSessionCountFromRegistry(): number {
    const registry = (globalThis as { __piSessions?: Map<string, AgentSessionWrapper> }).__piSessions;
    if (!registry) return 0;
    let count = 0;
    for (const s of registry.values()) {
      if (s.isAlive()) count++;
    }
    return count;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.destroy(), 10 * 60 * 1000);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  getPlanPhaseInfo(): { phase: string; waitingFor: string } {
    return {
      phase: this.planState.currentPhase,
      waitingFor: describeWaitingFor(this.planState.currentPhase),
    };
  }

  private async advancePlanPhase(userMessage: string): Promise<void> {
    const mgr = this.planState;
    mgr.incrementTurn();
    const currentPhase = mgr.currentPhase;
    const intent = classifyUserConfirmation(userMessage);

    if (currentPhase === "idle" || currentPhase === "completed" || currentPhase === "cancelled") {
      await mgr.transition("intent_capture", `new turn: ${userMessage.slice(0, 30)}`);
      return;
    }

    if (currentPhase === "clarifying") {
      await mgr.transition("planning", "user responded to clarification (or defaulted)");
      return;
    }

    if (currentPhase === "plan_confirm") {
      if (intent === "confirm") {
        await mgr.transition("executing", "user confirmed final plan");
      } else if (intent === "modify") {
        await mgr.transition("planning", "user wants to modify plan");
      } else if (intent === "reject" || intent === "ambiguous") {
        await mgr.transition("intent_capture", "user rejected, restart from scratch");
      }
      return;
    }
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;

    switch (type) {
      case "prompt": {
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const userMessage = command.message as string;
        this.lastError = null;
        await this.advancePlanPhase(userMessage);
        // 在 AsyncLocalStorage 作用域内运行 prompt，确保工具 execute 读到正确的 planState
        void withPlanState(
          this.planState,
          () => this.inner.prompt(userMessage, promptImages?.length ? { images: promptImages } : undefined),
        ).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.lastError = { code: "PROMPT_FAILED", message, retryable: true };
          console.error(`[rpc-manager] prompt failed for ${this.sessionId}:`, error);
          this.dispatchEvent({
            type: "error",
            code: "PROMPT_FAILED",
            message,
            retryable: true,
          });
        });
        return null;
      }

      case "abort":
        await this.inner.abort();
        return null;

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: 0,
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "auto",
          lastError: this.lastError,
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        const registry = this.inner.modelRegistry;
        const model = registry.find(provider, modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId();
        cacheSessionPath(newSessionId, newSessionFile);
        this.destroy();
        return { cancelled: false, newSessionId };
      }

      case "navigate_tree": {
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        return null;
      }

      case "compact": {
        const { findCutPoint, DEFAULT_COMPACTION_SETTINGS } = await import("@earendil-works/pi-coding-agent");
        const pathEntries = this.inner.sessionManager.getBranch() as Array<{ type: string }>;
        const settings = { ...DEFAULT_COMPACTION_SETTINGS, ...this.inner.settingsManager.getCompactionSettings() };
        let prevCompactionIndex = -1;
        for (let i = pathEntries.length - 1; i >= 0; i--) {
          if (pathEntries[i].type === "compaction") { prevCompactionIndex = i; break; }
        }
        const boundaryStart = prevCompactionIndex + 1;
        const cutPoint = findCutPoint(pathEntries as never, boundaryStart, pathEntries.length, settings.keepRecentTokens);
        const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
        if (historyEnd <= boundaryStart) {
          throw new Error("Conversation too short to compact");
        }
        const result = await this.inner.compact(command.customInstructions as string | undefined);
        return result;
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "set_tools": {
        this.inner.setActiveToolsByName(command.toolNames as string[]);
        return null;
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.unsubscribe?.();
    this.onDestroyCallback?.();
  }
}

// ============================================================================
// 会话注册表
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __piShutdownRegistered: boolean | undefined;
  var __piShutdownInFlight: Promise<void> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    registerShutdownHandlers();
  }
  return globalThis.__piSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

function registerShutdownHandlers(): void {
  if (globalThis.__piShutdownRegistered) return;
  globalThis.__piShutdownRegistered = true;

  process.once("exit", () => {
    globalThis.__piSessions?.forEach((s) => s.destroy());
  });

  const asyncCleanup = (signal: "SIGINT" | "SIGTERM") => {
    void shutdownRpcSessions(signal).finally(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", () => asyncCleanup("SIGINT"));
  process.once("SIGTERM", () => asyncCleanup("SIGTERM"));
}

export async function shutdownRpcSessions(reason = "shutdown"): Promise<void> {
  if (globalThis.__piShutdownInFlight) return globalThis.__piShutdownInFlight;

  const task = (async () => {
    const registry = globalThis.__piSessions;
    const sessions = registry ? [...registry.values()] : [];
    console.log(`[rpc-manager] shutdown start (${reason}) — sessions=${sessions.length}`);

    for (const session of sessions) {
      try {
        session.destroy();
      } catch (error) {
        console.error(
          `[rpc-manager] destroy failed for ${session.sessionId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    await closePool();
    console.log("[rpc-manager] postgres pool closed");

    await closeRedis();
    console.log("[rpc-manager] redis client closed");
  })().finally(() => {
    globalThis.__piShutdownInFlight = undefined;
  });

  globalThis.__piShutdownInFlight = task;
  return task;
}

/**
 * 获取或创建指定会话对应的 AgentSession。
 * 对于新会话（sessionFile === ""），pi 会生成自己的 id。
 * 始终激活完整的活动规划工具集。
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  userId?: string,
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    const agentDir = getAgentDir();

    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined)
      : SessionManager.create(cwd, undefined);

    const activityToolsList = ACTIVITY_TOOLS;
    const resourceLoader = createActivityResourceLoader(cwd, agentDir);

    const { session: inner } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager,
      resourceLoader,
      customTools: activityToolsList,
    });

    inner.setActiveToolsByName(ACTIVITY_TOOL_NAMES);

    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

    const planState = await PlanStateManager.load(realSessionId, undefined, userId);
    if (userId && planState.userId !== userId) {
      await planState.setUserId(userId);
    }

    const wrapper = new AgentSessionWrapper(inner, planState, userId);
    wrapper.start();

    wrapper.onDestroy(() => {
      registry.delete(realSessionId);
    });
    registry.set(realSessionId, wrapper);

    return { session: wrapper, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
