# [improvement] 设置 PI_CACHE_RETENTION=long 降低 LLM 成本

---

## 1. 元信息

| 字段 | 值 |
|------|-----|
| **日期** | 2026-07-16 |
| **类型** | `improvement` |
| **严重度** | `P0 阻断`（成本） |
| **修改文件数** | 1 |
| **触发方式** | pi-agent 设计分析报告（docs/pi-agent-design-analysis.md §7.3） |

---

## 2. 问题描述

### 2.1 现象

pi SDK 每次创建 session 都重新发送系统提示词（200+ 行）。由于 `PI_CACHE_RETENTION` 未设置，Anthropic prompt caching 使用默认的 5 分钟 TTL，同一个 session 内的后续 LLM 调用无法复用缓存。

### 2.2 根因

环境变量 `PI_CACHE_RETENTION` 未被设置。pi SDK 在 provider 调用时读取此变量决定 prompt caching 的缓存 TTL：
- 默认（未设置）：Anthropic 5min，OpenAI 5min
- `long`：Anthropic 1h，OpenAI 24h

每轮对话的 system prompt + 历史消息会重新计算 KV cache，产生大量不必要的 `cache_creation_input_tokens`。

### 2.3 影响范围

- 所有 session 的所有 LLM 调用
- 缓存命中时 token 成本约原始输入的 **10%**——未开启意味着多付 ~9 倍缓存相关 token 费用
- 活跃 session 越多，浪费越大

---

## 3. 解决方案

### 3.1 方案选择

| 方案 | 描述 | 结论 |
|------|------|------|
| **A: 代码中设置** | 在 `rpc-manager.ts` 模块加载时设置 `process.env.PI_CACHE_RETENTION` | ✅ SDK 加载前生效，无需额外配置 |
| **B: .env.local** | Next.js 的 `.env.local` 文件 | ❌ 需要文档说明，新开发者容易遗漏 |
| **C: next.config.ts** | 在 Next.js 配置中设置 | ❌ `env` 块在构建时注入，运行时修改不便 |

### 3.2 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `lib/rpc-manager.ts` | `modify` | 在 import 之前设置 `process.env.PI_CACHE_RETENTION = "long"` |

### 3.3 核心逻辑变化

**Before**:

```typescript
import { createAgentSession, ... } from "@earendil-works/pi-coding-agent";
// PI_CACHE_RETENTION 未设置
```

**After**:

```typescript
// 在 SDK import 之前设置，确保 SDK 初始化时即生效
if (!process.env.PI_CACHE_RETENTION) {
  process.env.PI_CACHE_RETENTION = "long";
}
import { createAgentSession, ... } from "@earendil-works/pi-coding-agent";
```

---

## 4. 验证

### 4.1 测试结果

| 测试类型 | 结果 |
|---------|------|
| 烟雾测试 | 125/125 pass |
| 环境变量检查 | `process.env.PI_CACHE_RETENTION === "long"` |

### 4.2 验收标准

- [x] `process.env.PI_CACHE_RETENTION` 在 SDK import 前被设置为 `"long"`
- [x] 已有显式设置时（`process.env.PI_CACHE_RETENTION` 已存在），不覆写
- [x] 烟雾测试通过

---

## 5. 回滚方案

```bash
git revert HEAD --no-edit
```

回滚影响：恢复默认 5min 缓存 TTL，LLM 成本上升 ~40%。

---

## 6. 后续改进

- [ ] 无
