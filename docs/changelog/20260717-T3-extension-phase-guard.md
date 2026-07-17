# [refactor] T3 Phase Guard 迁移到 Extension pi.on("tool_call") 钩子

> 第一阶段开发计划（docs/分析报告/04）T3 任务交付
> 用 pi SDK Extension 原生 tool_call 钩子替代 tool-wrapper beforeExecute 回调

---

## 1. 元信息

| 字段 | 值 |
|------|-----|
| **日期** | 2026-07-17 |
| **类型** | `refactor` |
| **严重度** | `P1 高`（影响工具执行路径） |
| **修改文件数** | 4 |
| **触发方式** | 第一阶段开发计划 + pi-agent 设计分析报告 |
| **关联 Issue** | docs/pi-agent-design-analysis.md §6.3, §7.1 |

---

## 2. 问题描述

### 2.1 现象

SOP-v2 阶段守卫（phase guard）通过 `tool-wrapper beforeExecute` 回调实现，在工具 `execute()` 调用之前检查 phase 合法性。这种方式的问题是：

1. **拦截时机晚**：Extension `pi.on("tool_call")` 钩子在 LLM 决定调工具后立即触发（在参数校验之前），而 `beforeExecute` 在工具 executor 准备执行时才触发
2. **全局单例隐患**：`beforeExecute` 调 `getActivePlanState()` 读取 AsyncLocalStorage，但在工具 wrapper 的 `beforeExecute` 中没有 session 上下文注入
3. **重复代码**：4 个工具分类中的 `beforeExecute` 回调完全相同（`activity-tools.ts:684,706,718,731`）

### 2.2 根因

原项目在 `pi-agent-design-analysis.md` §6.3 中指出的 design gap：
> """当前实现依赖 `beforeExecute` 回调。改进方案：在 Extension 中使用 `pi.on("tool_call")` 全局处理——不需要每个工具单独 wrap，在 LLM 调用工具后立即拦截。"""

### 2.3 影响范围

- 所有 12 个业务工具的 phase 守卫路径改变（Extension 代替 wrapper beforeExecute）
- 保留工具 body 内自检（layer 3 defense in depth）不受影响
- 非业务工具（built-in read/write/bash 等）不受影响（Extension 不拦截）

---

## 3. 解决方案

### 3.1 方案选择

| 方案 | 描述 | 结论 |
|------|------|------|
| **A: Extension pi.on("tool_call") 钩子** | 用 SDK 原生钩子全局拦截 | ✅ 选此方案。SDK 原生支持，拦截时机更早，0 代码重复 |
| **B: beforeExecute 保留 + Extension 并存** | 双保险 | ❌ 重复拦截，增加测试复杂度 |
| **C: ResourceLoader.extensionsOverride** | 用 override 回调注入 Extension | ❌ 不如 extensionFactories 直接 |

### 3.2 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `lib/extensions/phase-guard.ts` | `add` | Extension 入口文件，`pi.on("tool_call")` 注册 phase guard |
| `lib/rpc-manager.ts` | `modify` | `DefaultResourceLoader` 传 `extensionFactories: [phaseGuardExtension]` |
| `src/tools/activity-tools.ts` | `modify` | 删除 4 处重复 `beforeExecute` 回调 |
| `scripts/p0-smoke-test.ts` | `modify` | 新增 6 个 Extension phase guard 测试 |

### 3.3 核心逻辑变化

**新增 `lib/extensions/phase-guard.ts`**：

```typescript
export default function phaseGuardExtension(pi: ExtensionAPI): void {
  const BUSINESS_TOOLS = new Set([...]); // 12 个业务工具

  pi.on("tool_call", async (event) => {
    if (!BUSINESS_TOOLS.has(event.toolName)) return; // 非业务工具放行

    const mgr = getActivePlanState();
    if (!mgr) return; // 没有 plan state → 放行

    const result = mgr.guardToolCall(event.toolName);
    if (!result.allowed) {
      return { block: true, reason: `Tool "${event.toolName}" not allowed in phase "${result.currentPhase}"` };
    }
  });
}
```

**修改 `lib/rpc-manager.ts`**：

```diff
- const baseLoader = new DefaultResourceLoader({ cwd, agentDir });
+ const baseLoader = new DefaultResourceLoader({
+   cwd, agentDir,
+   extensionFactories: [phaseGuardExtension],  // 注入 phase guard Extension
+ });
```

**修改 `src/tools/activity-tools.ts`**（删除 4 处重复代码）：

```diff
- beforeExecute: () => {
-   const mgr = getActivePlanState();
-   if (!mgr) return { allowed: true };
-   return mgr.guardToolCall(tool.name);
- },
// ↓ 删除后，phase guard 由 Extension 处理
```

---

## 4. 验证

### 4.1 测试结果

| 测试类型 | 结果 |
|---------|------|
| TypeScript 编译 | `tsc --noEmit` pass |
| 烟雾测试 | 167/167 pass (161 + 6 新增 Extension 测试) |
| 端到端 LLM 流程 | ✅ deepseek-v4-flash 真实调用通过 |
| phase guard 拦截验证 | ✅ `reservation_exec` 被 Extension 拦截 + 单元测试验证 |
| 合法工具放行验证 | ✅ `intent_parse` 放行 |
| 非业务工具放行验证 | ✅ `bash` 不受 Extension 管控 |

### 4.2 验收标准

- [x] `pi.on("tool_call")` 钩子在所有 12 个业务工具执行前触发
- [x] 非法工具调用被 Extension 拦截（返回 `{ block: true, reason }`）
- [x] 合法工具调用被 Extension 放行（返回 void）
- [x] 非业务工具（如 bash）不被 Extension 拦截
- [x] 无 plan state 时放行（初始化阶段）
- [x] 4 处 `beforeExecute` 已从 `activity-tools.ts` 删除
- [x] 工具 body 内自检（layer 3）保留，3 层防御体系完整
- [x] smoke 167/167 pass
- [x] `tsc --noEmit` pass
- [x] 真实 LLM 调用端到端通过

### 4.3 人工 review（已完成）

| 步骤 | 操作 | 实际结果 |
|------|------|----------|
| 1 | 启动 dev server + 真实 LLM 请求 "查询上海今天天气" | `get_weather` 工具正常调用 |
| 2 | 真实 LLM 请求 "周六下午上海玩" 触发完整流程 | `intent_parse` → `ask_clarification` 正常 |
| 3 | 单元测试验证 `reservation_exec` 在 `intent_capture` 被拦截 | ✅ `block: true` |
| 4 | 验证 `beforeExecute` 已从 4 个分类全部删除 | ✅ grep 确认 0 匹配 |
| 5 | 验证 `getActivePlanState()` 仍用于工具 body 自检 | ✅ 4 处保留（layer 3） |

### 4.4 3 层防御体系现状

```
Layer 1 (最外层): TOOL_PHASE_RULES 静态白名单    ← 不变
  └─ plan-state.ts: 工具注册前写入的静态权限表

Layer 2 (中间层): Extension pi.on("tool_call")     ← NEW (替换 beforeExecute)
  └─ lib/extensions/phase-guard.ts: 在 LLM 调工具后立即拦截

Layer 3 (最内层): 工具 body 自检                  ← 不变
  └─ activity-tools.ts: intent_parse submitPlan=true
     requires planning phase, ask_clarification MAX_CLARIFICATIONS=1
```

---

## 5. 回滚方案

```bash
git revert HEAD --no-edit
# 恢复 rpc-manager.ts, activity-tools.ts, 删除 phase-guard.ts
```

回滚影响：
- phase guard 回到 `beforeExecute` 模式（功能不变，拦截时机稍微晚一点）
- smoke 测试从 167 降回 161
- 业务功能不受影响

---

## 6. 后续改进

- [ ] T5 阶段将 Extension `tool_result` 钩子加入同一 Extension 文件（工具结果脱敏）
- [ ] 考虑将 Extension 的 BUSINESS_TOOLS 集合改为从 `TOOL_METADATA` 读取（避免硬编码）
- [ ] 未来可在 Extension 中记录 `tool_call` 审计日志（pi.on("tool_call") 是一个理想的审计点）
