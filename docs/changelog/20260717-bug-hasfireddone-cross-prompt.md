# [bug] EventAdapter.hasFiredDone 跨 prompt 未重置导致多轮对话后 done 事件被吞

> 用户反馈：规划完成进入等待确认阶段后，输入框仍显示 steer/follow-up 形态，无法正常输入

---

## 1. 元信息

| 字段 | 值 |
|------|-----|
| **日期** | 2026-07-17 |
| **类型** | `bug` |
| **严重度** | `P1 高`（阻断多轮对话交互） |
| **修改文件数** | 2 |
| **触发方式** | 用户手动测试发现 |
| **关联 commit** | `1289e5a` |

---

## 2. 问题描述

### 2.1 现象

用户发送消息后，LLM 完成规划，agent 等待用户确认（`plan_confirm` phase）。但输入框不显示正常输入模式，而是持续显示"Steer 立即注入 / Follow-up 排队…"——即 `isStreaming == true` 时的状态。用户无法正常输入确认指令。

### 2.2 根因

`lib/event-adapter.ts` 的 `EventAdapter` 在 `agent_end` → `done` 转换上有一个 `hasFiredDone` 幂等守卫：

```typescript
case "agent_end":
  if (this.hasFiredDone) return [];  // 第二次 agent_end 被吞
  this.hasFiredDone = true;
  return [{ type: "done", ... }];
```

但 `EventAdapter` 实例在 `AgentSessionWrapper` 构造函数中创建一次（`rpc-manager.ts:74`），跨所有 prompt 生命周期。第一轮 prompt 结束后 `hasFiredDone = true`，第二轮 prompt 的 `agent_end` 被静默吞掉：

```
Prompt 1: agent_start → ... → agent_end → hasFiredDone=false → done ✅
Prompt 2: agent_start → ... → agent_end → hasFiredDone=true  → return [] ❌
```

没有 `done` 事件 → 前端 `useAgentSession.ts` 的 `case "done"` 不触发 → `dispatch({ type: "end" })` 不调用 → `isStreaming` 永远 `true` → ChatInput 显示 steer/follow-up 模式。

### 2.3 影响范围

- 所有多轮对话交互（activity-agent 的核心场景）
- 第一轮 prompt 正常，第二轮后输入框卡死
- 用户必须刷新页面才能继续

---

## 3. 解决方案

### 3.1 方案选择

| 方案 | 描述 | 结论 |
|------|------|------|
| **A: agent_start 时重置 hasFiredDone** | 新 prompt 周期开始前重置幂等守卫 | ✅ 最简单，语义最清晰 |
| **B: 每次 prompt 前手动 reset() EventAdapter** | 在 `startRpcSession` 或 `send("prompt")` 时显式重置 | ❌ 需要额外接口，容易遗漏 |
| **C: 移除 hasFiredDone 守卫** | 完全允许多次 done | ❌ agent_end 可能多次触发，产生重复 done |

### 3.2 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `lib/event-adapter.ts` | `modify` | `agent_start` case 中添加 `this.hasFiredDone = false` |
| `scripts/p0-smoke-test.ts` | `modify` | 新增 4 个跨 prompt `done` 幂等性测试 |

### 3.3 核心逻辑变化

**Before**:
```typescript
case "agent_start":
  return [{ type: "agent_start", sessionId: this.sessionId }];
```

**After**:
```typescript
case "agent_start":
  this.hasFiredDone = false;  // 重置跨 prompt 状态标志
  return [{ type: "agent_start", sessionId: this.sessionId }];
```

---

## 4. 验证

### 4.1 测试结果

| 测试类型 | 结果 |
|---------|------|
| 烟雾测试 | 171/171 pass (原 167 + 4 新增跨 prompt 测试) |
| TypeScript 编译 | `tsc --noEmit` pass |
| 人工 curl 验证：prompt 1 done | ✅ 1 次 |
| 人工 curl 验证：prompt 2 done | ✅ 1 次（修复前 0 次） |
| 完整活动规划 2 轮 SSE 检查 | ✅ 两个 prompt 各发送 1 次 done |

### 4.2 验收标准

- [x] `agent_start` 事件触发 `hasFiredDone = false`
- [x] 第二轮 `agent_end` 正确生成 `done` 事件
- [x] 第一轮 `agent_end` → `done` 幂等性保持（重复 `agent_end` 不产生第二个 done）
- [x] smoke 171/171 pass
- [x] `tsc --noEmit` pass
- [x] 真实 LLM 两轮对话端到端验证通过

---

## 5. 回滚方案

```bash
git revert 1289e5a --no-edit
```

回滚影响：恢复多轮对话 done 被吞的 bug，两轮以上对话输入框卡死。

---

## 6. 后续改进

- [ ] 考虑将 `EventAdapter` 生命周期与 prompt 绑定（每个 prompt 创建新 adapter），而非 session 级单例
- [ ] 增加集成测试：多轮对话 E2E 中验证第二轮 `done` 事件
