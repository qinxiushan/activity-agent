# [bug] 修复 ResourceLoader.getSystemPrompt() 覆写导致 AGENTS.md 被丢弃

---

## 1. 元信息

| 字段 | 值 |
|------|-----|
| **日期** | 2026-07-16 |
| **类型** | `bug` |
| **严重度** | `P0 阻断` |
| **修改文件数** | 1 |
| **触发方式** | 代码审查（pi-agent 设计分析报告指出） |
| **关联 Issue** | 分析报告 docs/pi-agent-design-analysis.md §6.5 |

---

## 2. 问题描述

### 2.1 现象

`getSystemPrompt()` 完全替换了 system prompt，导致：
- 用户项目中的 `AGENTS.md` / `CLAUDE.md` 上下文文件被静默丢弃
- `~/.pi/agent/AGENTS.md` 全局上下文文件被静默丢弃
- `.pi/APPEND_SYSTEM.md` 文件被丢弃
- skill 通过 `getAppendSystemPrompt()` 注入的指引被丢弃

LLM 看不到项目约定（代码风格、常用命令、业务规则等）。

### 2.2 根因

```typescript
// rpc-manager.ts — 错误实现
function createActivityResourceLoader(cwd, agentDir) {
  const baseLoader = new DefaultResourceLoader({ cwd, agentDir });
  return {
    // ... 其他方法代理 ...
    getSystemPrompt() {
      return ACTIVITY_PLANNER_SYSTEM_PROMPT;  // 🔴 完全替换
    },
  };
}
```

`getSystemPrompt()` 是 pi SDK 中**返回主 system prompt** 的方法。`DefaultResourceLoader` 会在此方法中合并 AGENTS.md / CLAUDE.md 的内容。覆写此方法返回 `ACTIVITY_PLANNER_SYSTEM_PROMPT`，相当于把所有上下文文件内容都丢弃了。

正确的做法是使用 `getAppendSystemPrompt()`（追加到主提示词末尾），而不是替换 `getSystemPrompt()`。

### 2.3 影响范围

- 所有使用 `createActivityResourceLoader` 创建的 session
- 项目有 `.pi/AGENTS.md` 或 `AGENTS.md` 文件时，LLM 看不到这些上下文
- 对 activity-agent 业务影响较小（BPO 场景不需要 AGENTS.md），但对未来扩展影响大

---

## 3. 解决方案

### 3.1 方案选择

| 方案 | 描述 | 结论 |
|------|------|------|
| **A: 在 getAppendSystemPrompt 中追加** | 保留 baseLoader 的 `getSystemPrompt()`，把活动规划器提示词追加到 `getAppendSystemPrompt()` 末尾 | ✅ 选此方案。AGENTS.md 继续生效，规划器提示在最后追加 |
| **B: 在 getSystemPrompt 中合并** | `getSystemPrompt()` 返回 `baseLoader.getSystemPrompt() + ACTIVITY_PLANNER_SYSTEM_PROMPT` | ❌ 需要手动解析 baseLoader 返回的完整 prompt，破坏封装 |
| **C: 在 before_agent_start 注入** | 保持现状，用 Extension 的 `before_agent_start` 钩子注入 | ❌ 需要 Extension API，当前未启用 |

### 3.2 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `lib/rpc-manager.ts` | `modify` | 删除自定 `getSystemPrompt()`，改为在 `getAppendSystemPrompt()` 中追加 `ACTIVITY_PLANNER_SYSTEM_PROMPT` |

### 3.3 核心逻辑变化

**Before**:

```typescript
getSystemPrompt() {
  return ACTIVITY_PLANNER_SYSTEM_PROMPT; // 替换 baseLoader 的 system prompt
},
getAppendSystemPrompt: () => baseLoader.getAppendSystemPrompt(),
```

**After**:

```typescript
getSystemPrompt: () => baseLoader.getSystemPrompt(),  // 保留 AGENTS.md 等
getAppendSystemPrompt() {
  const base = baseLoader.getAppendSystemPrompt();
  // 在 baseLoader 的追加内容之后追加活动规划器提示
  return base
    ? `${base}\n\n${ACTIVITY_PLANNER_SYSTEM_PROMPT}`
    : ACTIVITY_PLANNER_SYSTEM_PROMPT;
},
```

---

## 4. 验证

### 4.1 测试结果

| 测试类型 | 结果 |
|---------|------|
| 烟雾测试 | 125/125 pass |
| TypeScript 编译 | `tsc --noEmit` pass |

### 4.2 验收标准

- [x] `getSystemPrompt()` 不再被覆写，返回 `baseLoader.getSystemPrompt()` 的值
- [x] `getAppendSystemPrompt()` 追加了 `ACTIVITY_PLANNER_SYSTEM_PROMPT` 在 baseLoader 内容之后
- [x] `getSystemPrompt()` 与 `getAppendSystemPrompt()` 两者内容不丢失不冲突
- [x] AGENTS.md 文件内容恢复生效（可通过在项目根目录放 AGENTS.md 并检查 `session.agent.state.systemPrompt` 验证）

---

## 5. 回滚方案

```bash
git revert HEAD --no-edit
```

回滚影响：恢复 `getSystemPrompt()` 覆写，AGENTS.md 再次被丢弃。

---

## 6. 后续改进

- [ ] 无
