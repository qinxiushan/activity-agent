# [bug] 删除全局 `_activePlanState` 单例，改用 AsyncLocalStorage

---

## 1. 元信息

| 字段 | 值 |
|------|-----|
| **日期** | 2026-07-16 |
| **类型** | `bug` |
| **严重度** | `P0 阻断` |
| **修改文件数** | 4 |
| **触发方式** | 代码审查（pi-agent 设计分析报告指出） |
| **关联 Issue** | 分析报告 docs/pi-agent-design-analysis.md §7.1 |

---

## 2. 问题描述

### 2.1 现象

HTTP 500 错误：`/api/agent/new` 返回 500，导致无法创建新 session。

### 2.2 根因

双重问题：

**问题 A（并发安全）**：`lib/plan-state.ts` 中 `_activePlanState` 是一个全局可变单例。当多 session 并发时（Session A 的 LLM 在 tool-execute 间隙，Session B 发来 prompt），全局单例被覆盖，导致 Session A 后续的 tool-execute 读到 Session B 的 phase 状态。phase 守卫会错误地允许或阻止工具调用。

```
时间线：
Session A                         Session B
  │                                 │
  ├─ advancePlanPhase()             │
  │   └─ _activePlanState = A       │
  ├─ inner.prompt()                 │
  │   └─ LLM 调用 tool              │
  │       └─ 读取 _activePlanState  │
  │          (仍为 A ✅)             │
  │                                 ├─ advancePlanPhase()
  │                                 │   └─ _activePlanState = B ⚠️
  │  LLM 调用下一个 tool             │
  │  └─ 读取 _activePlanState = B   │
  │     ❌ 读到错误的 phase！        │
```

**问题 B（鸡肉鸡蛋依赖）**：在 `startRpcSession` 中，`PlanStateManager.load(realSessionId)` 在 `realSessionId` 赋值之前被调用，导致传入 `undefined`。这直接引发 HTTP 500。

```typescript
// 错误顺序（修改后引入）：
const planState = await PlanStateManager.load(realSessionId); // ← undefined!
const { session: inner } = await createAgentSession({...});
const realSessionId = inner.sessionId; // ← 真正的值在下一行
```

### 2.3 影响范围

- 所有 /api/agent/new 请求 → HTTP 500，完全无法使用
- 多 session 并发场景下 phase 守卫可能误判（问题 A 本质上是时间窗口问题，问题 B 是阻断级）

---

## 3. 解决方案

### 3.1 方案选择

| 方案 | 描述 | 结论 |
|------|------|------|
| **A: 闭包注入** | `getActivityPlannerTools(planState)`，每个 session 创建自己的工具 | ❌ 鸡肉鸡蛋依赖无法解决（tools 需要 planState → planState 需要 sessionId → sessionId 需要先创建 session） |
| **B: AsyncLocalStorage** | Node.js 内置异步上下文存储，工具保持模块级单例 | ✅ 选此方案。零鸡肉鸡蛋问题，每个异步链自动获得正确的 planState |
| **C: 全局 Map** | `Map<sessionId, PlanStateManager>` 替代全局单例 | ❌ 需修改 tool execute 签名以传入 sessionId，pi SDK 的 execute ctx 参数类型不确定 |

### 3.2 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `lib/plan-state.ts` | `modify` | 删除 `_activePlanState`、`setActivePlanState()`、`getActivePlanState()`、`guardToolCallWithActive()`；新增 `withPlanState()` 和基于 `AsyncLocalStorage` 的 `getActivePlanState()` |
| `src/tools/activity-tools.ts` | `modify` | `beforeExecute` 改用 `getActivePlanState()`（AsyncLocalStorage）；`getActivityPlannerTools()` 恢复无参 |
| `lib/rpc-manager.ts` | `modify` | `ACTIVITY_TOOLS` 恢复模块级常量；`send("prompt")` 用 `withPlanState()` 包裹 `inner.prompt()`；修复 `startRpcSession` 中冗余代码 |
| `scripts/p0-smoke-test.ts` | `modify` | import 新增 `withPlanState`；测试用例改用 `withPlanState(mgr, () => tool.execute(...))` |

### 3.3 核心逻辑变化

**Before (全局单例)**:

```typescript
// plan-state.ts
let _activePlanState: PlanStateManager | null = null;
export function getActivePlanState() { return _activePlanState; }

// rpc-manager.ts
setActivePlanState(planState);
inner.prompt(userMessage).catch(() => {});

// activity-tools.ts (工具 execute 内)
const mgr = getActivePlanState(); // 可能读到别的 session！
```

**After (AsyncLocalStorage)**:

```typescript
// plan-state.ts
const planStateStorage = new AsyncLocalStorage<PlanStateManager>();
export function withPlanState<T>(mgr: PlanStateManager, fn: () => Promise<T>): Promise<T> {
  return planStateStorage.run(mgr, fn);
}
export function getActivePlanState(): PlanStateManager | null {
  return planStateStorage.getStore() ?? null;
}

// rpc-manager.ts
withPlanState(this.planState, () =>
  this.inner.prompt(userMessage).catch(() => {})
);

// activity-tools.ts (工具 execute 内，不变)
const mgr = getActivePlanState(); // 读当前异步链的 planState ✅
```

---

## 4. 验证

### 4.1 测试结果

| 测试类型 | 结果 |
|---------|------|
| 烟雾测试 | 125/125 pass |
| `grep -rn "_activePlanState"` | 0 匹配 |
| TypeScript 编译检查 | `tsc --noEmit` pass |
| 模块级 `getActivityPlannerTools()` 无参调用 | 代码审查通过 |

### 4.2 验收标准

- [x] 烟雾测试全部通过（125/125）
- [x] `plan-state.ts` 中无全局 `_activePlanState` 变量
- [x] `rpc-manager.ts` 中 `startRpcSession` 无 `realSessionId` 未定义问题
- [x] `withPlanState()` 正确包裹 `inner.prompt()` 调用
- [x] `beforeExecute` 通过 `getActivePlanState()` 读取 AsyncLocalStorage
- [x] `Intent_parse` / `ask_clarification` / `plan_save` 工具 execute 内部使用 `getActivePlanState()`

---

## 5. 回滚方案

```bash
git revert HEAD --no-edit
# 恢复 _activePlanState 全局单例 + tools 模块级常量 + setActivePlanState 调用
```

回滚影响：恢复全局单例隐患，但消除 HTTP 500。

---

## 6. 后续改进

- [ ] 考虑将 `withPlanState` 抽象到更基础的层（如 `AgentSessionWrapper.send()` 的基类），方便其他类型的 session 复用
- [ ] 为 `getActivePlanState()` 增加 TypeScript 类型守卫，使 `null` case 在编译期可检测
- [ ] 在 CI 中增加并发 session 的压测用例（验证 AsyncLocalStorage 在多 session 下的正确性）
