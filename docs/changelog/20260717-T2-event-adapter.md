# [improvement] T2 Event Adapter Layer - pi AgentEvent → StandardEvent

> 第一阶段开发计划（docs/分析报告/04）T2 任务交付
> 解耦前端与 pi SDK 内部事件 schema

---

## 1. 元信息

| 字段 | 值 |
|------|-----|
| **日期** | 2026-07-17 |
| **类型** | `refactor` |
| **严重度** | `P1 高`（影响前端 SDK 升级成本） |
| **修改文件数** | 5 (3 新增 + 2 修改) |
| **触发方式** | 第一阶段开发计划 + pi-agent 设计分析报告 |
| **关联 Issue** | docs/pi-agent-design-analysis.md §2.2, §6.4 |

---

## 2. 问题描述

### 2.1 现象

前端直接消费 pi SDK 内部事件 schema：
- `useAgentSession.ts` 处理 13+ 个 pi 事件类型（`message_update` / `tool_execution_start` / `turn_start` / `auto_retry_start` 等）
- `useActivitySession.ts` 处理 4 个事件
- 组件代码（`ChatWindow.tsx` / `components/activity/*.tsx`）理解 pi 内部结构如 `assistantMessageEvent.text_delta.delta`

### 2.2 根因

`lib/rpc-manager.ts` AgentSessionWrapper.subscribe 回调直接透传 pi AgentEvent：
```typescript
this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
  this.resetIdleTimer();
  for (const l of this.listeners) l(event);  // 直接透传 pi 事件
});
```

### 2.3 影响范围

- 升级 pi SDK 时（如 message_update schema 变化）所有前端代码可能 break
- 不能跨 SDK（pi → opencode-go / langgraph 等）复用前端
- 与 production 设计方法论脱节（docs/web-integration/04 要求标准化事件协议）

---

## 3. 解决方案

### 3.1 方案选择

| 方案 | 描述 | 结论 |
|------|------|------|
| **A: 全替换 - 服务端改 + 前端两个 hook 改** | 一次性让前端全部用 StandardEvent | ✅ 选此方案。彻底解耦，符合 T2 目标 |
| **B: 双 schema 并行** | 服务端同时输出 pi + standard | ❌ 增加复杂度，前端仍依赖 pi schema |
| **C: 仅服务端改，前端不改** | 服务端转换但前端用 type assertion | ❌ 类型不安全，违反 T2 目标 |

### 3.2 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `lib/event-types.ts` | `add` | 11 种 StandardEvent 类型定义 + isStandardEvent 守卫 |
| `lib/event-adapter.ts` | `add` | EventAdapter 类，映射 9 种 pi AgentEvent → 11 种 StandardEvent |
| `lib/rpc-manager.ts` | `modify` | AgentSessionWrapper 注入 EventAdapter，subscribe 回调过 adapter |
| `hooks/useAgentSession.ts` | `modify` | 13+ case 分支迁移到 StandardEvent schema |
| `hooks/useActivitySession.ts` | `modify` | 4 case 分支迁移到 StandardEvent schema |
| `components/ChatWindow.tsx` | `modify` | `event.type === "agent_end"` → `"done"` |
| `scripts/p0-smoke-test.ts` | `modify` | 新增 21 个 EventAdapter 测试 |

### 3.3 核心逻辑变化

**新增 `lib/event-types.ts`**（88 行）：

```typescript
export type StandardEvent =
  | { type: "agent_start"; sessionId: string }
  | { type: "turn_start"; turnIndex: number }
  | { type: "text_delta"; text: string; turnIndex: number }
  | { type: "thinking_delta"; text: string; turnIndex: number }
  | { type: "tool_start"; toolName: string; toolCallId: string; args: unknown }
  | { type: "tool_end"; toolName: string; toolCallId: string; isError: boolean; durationMs: number }
  | { type: "turn_end"; turnIndex: number; usage: {...}; stopReason: string; message?: unknown }
  | { type: "system"; subtype: "compaction" | "retry" | "session_recovered"; message: string }
  | { type: "error"; code: string; message: string; retryable: boolean }
  | { type: "done"; sessionId: string; totalTurns: number; totalCost: number; message?: unknown }
  | { type: "message_added"; message: unknown; role: ... };
```

**新增 `lib/event-adapter.ts`**（核心映射）：

```typescript
class EventAdapter {
  adapt(piEvent: PiAgentEvent): StandardEvent[] {
    switch (piEvent.type) {
      case "agent_start": return [{ type: "agent_start", sessionId }];
      case "turn_start": return [{ type: "turn_start", turnIndex: ++this.turnIndex }];
      case "message_update":
        if (inner.type === "text_delta") return [{ type: "text_delta", text: inner.delta, ... }];
        if (inner.type === "thinking_delta") return [{ type: "thinking_delta", ... }];
      case "tool_execution_start": return [{ type: "tool_start", ... }];
      case "tool_execution_end": return [{ type: "tool_end", isError, durationMs: ... }];
      case "agent_end": return [{ type: "done", totalTurns, totalCost }];
      // ... 等等
    }
  }
}
```

**修改 `lib/rpc-manager.ts`**：

```diff
- this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
-   this.resetIdleTimer();
-   for (const l of this.listeners) l(event);
- });
+ this.eventAdapter = new EventAdapter(inner.sessionId, this.planState);
+ this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
+   this.resetIdleTimer();
+   const standardEvents = this.eventAdapter.adapt(event);
+   for (const se of standardEvents)
+     for (const l of this.listeners) l(se);
+ });
```

**修改 `hooks/useAgentSession.ts`**（13 case 全部迁移）：

```diff
- case "agent_end":
+ case "done":
- case "message_start":
- case "message_update": { ...event.message... }
+ case "text_delta":
+ case "thinking_delta": { ... event.text ... }
+ case "message_added": { ... event.message ... }
- case "tool_execution_start": { ... event.toolCallId, event.toolName ... }
+ case "tool_start": { ... event.toolCallId, event.toolName ... }
- case "tool_execution_end":
+ case "tool_end":
- case "auto_retry_start":
- case "auto_retry_end":
- case "auto_compaction_start":
- case "compaction_start":
+ case "system":
+   if (event.subtype === "retry") { ... }
+   else if (event.subtype === "compaction") { ... }
```

---

## 4. 验证

### 4.1 测试结果

| 测试类型 | 结果 |
|---------|------|
| TypeScript 编译 | `tsc --noEmit` pass |
| 烟雾测试 | 161/161 pass (140 + 21 新增 EventAdapter 测试) |
| 端到端 SSE 验证 | 8/11 StandardEvent 出现 (text_delta, thinking_delta, message_added, turn_end, done, tool_start, tool_end, connected) |
| 端到端无 pi 事件 | ✅ SSE 流中无 `message_update` / `tool_execution_*` 等 pi 内部类型 |
| 真实 LLM 调用 | deepseek-v4-flash, "查询上海今天天气" → intent_parse + get_weather 工具调用正常 |

### 4.2 验收标准

- [x] SSE 事件中**不包含** `message_update` / `tool_execution_start` 等 pi 内部 schema
- [x] 11 种 StandardEvent 全部定义 (event-types.ts)
- [x] EventAdapter 映射 9 种 pi 事件到 11 种 StandardEvent
- [x] rpc-manager 集成 EventAdapter，listeners 收到的是 StandardEvent
- [x] useAgentSession 13+ case 全部迁移到新 schema
- [x] useActivitySession 4 case 全部迁移到新 schema
- [x] 文本流式输出仍正常（每字一个 `text_delta`）
- [x] 工具调用显示为 `tool_start` / `tool_end`（不是 `tool_execution_start`）
- [x] 完成时收到 `done` 事件（不是 `agent_end`）
- [x] smoke 161/161 pass
- [x] `tsc --noEmit` pass
- [x] 不破坏现有任何端点

### 4.3 人工 review（已完成）

| 步骤 | 操作 | 实际结果 |
|------|------|----------|
| 1 | 创建 session + curl SSE | 立即收到 `connected` |
| 2 | 发 prompt "说hi" + 监听 SSE | 看到 73 个 `text_delta` + 29 个 `thinking_delta` |
| 3 | 观察 message_added | ✅ 消息完成时收到，含完整 content |
| 4 | 观察 turn_end | ✅ 含 usage (input/output/cacheRead/cost) |
| 5 | 观察 done | ✅ 含 totalTurns + totalCost |
| 6 | 发 prompt "查询上海天气" + 监听 SSE | 看到 `tool_start` + `tool_end` (intent_parse + get_weather) |
| 7 | 验证无 pi 事件残留 | ✅ grep `message_update` / `tool_execution_*` 在前端代码为 0 匹配 |
| 8 | 浏览器访问 `/activity` 主页 | UI 正常加载（SOP-v2 阶段进度可见） |

### 4.4 EventAdapter 单元测试覆盖

21 个测试覆盖：
- 9 种 pi 事件类型映射
- 边界 case：unknown event / no type / 重复 agent_end（idempotent）
- 状态管理：turnIndex 递增、cost 累加、toolStartTimes 清理

---

## 5. 回滚方案

```bash
git revert HEAD --no-edit
# 恢复 rpc-manager / hooks / components 的旧 event schema
# 删除 lib/event-types.ts 和 lib/event-adapter.ts
```

回滚影响：
- 前端恢复依赖 pi SDK 事件 schema
- 业务功能不受影响（只是耦合度变高）
- smoke 测试从 161 降回 140

---

## 6. 后续改进

- [ ] useAgentSession 中保留对 `compaction_*` 事件的更细粒度区分（当前合并到 `system.subtype=compaction`）
- [ ] EventAdapter 增加 `phase` 字段注入（从 planState 读取，让前端不依赖 plan-state 轮询）
- [ ] Stage 2 真实 LLM 多轮调用验证 e2e 测试
- [ ] 未来若需要支持多 SDK 切换，可在 EventAdapter 中实现多适配器模式
