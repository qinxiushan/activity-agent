# [improvement] 阶段2-T2：Redis 用户级消息限流（含内存降级与前端友好提示）

---

## 1. 元信息

| 字段 | 值 |
|------|-----|
| **日期** | 2026-07-18 |
| **类型** | `improvement` |
| **严重度** | `P0 阻断`（阶段 2 多用户保护前置） |
| **修改文件数** | 8（新增 1 + 修改 7） |
| **触发方式** | 按 `docs/分析报告/07-第二阶段开发计划.md` §T2 执行 |
| **关联** | T0 Redis 连接层；T1 PG 持久化已完成 |

---

## 2. 问题描述

### 2.1 现象

`/api/agent/new` 与 `/api/agent/[id]` 对消息类命令完全无速率保护。任意用户可在 1 分钟内无限触发 LLM turn，存在刷爆平台配额和拖垮服务的风险。

### 2.2 根因

阶段 1 与阶段 2 T1 只完成了业务与持久化改造，还没有把 Redis 接入到请求入口的控制面。

### 2.3 影响范围

- 首条消息入口：`POST /api/agent/new`
- 已有会话消息入口：`POST /api/agent/[id]`
- 前端输入体验：429 时原实现会先清空输入，导致文本丢失
- 指标观测：缺少 rate limit hit metric

---

## 3. 解决方案

### 3.1 方案选择

按计划实现“**Redis 滑动窗口 + Redis 故障自动降级到进程内存窗口**”：

```text
message request
  -> 识别是否为 prompt/steer/follow_up
  -> checkMessageRateLimit(userId)
       -> Redis ZSET sliding window
       -> [失败] fallback 到内存窗口
  -> allow / 429(rate_limited + Retry-After)
```

### 3.2 修改文件清单

| 文件 | 改法 | 说明 |
|------|------|------|
| `lib/rate-limiter.ts` | add | 新增限流核心：消息类命令识别、Redis 滑动窗口、内存降级、429 结构化响应 |
| `lib/metrics-registry.ts` | modify | 新增 `rate_limit_hits_total{action}` counter |
| `app/api/agent/new/route.ts` | modify | 首条 `prompt` 请求接入限流 |
| `app/api/agent/[id]/route.ts` | modify | `prompt/steer/follow_up` 接入限流；`get_state` 等控制命令不计数 |
| `lib/agent-client.ts` | modify | 前端 API 错误结构化，支持 `status/code/retryAfterMs` |
| `components/ChatInput.tsx` | modify | 改为“发送成功才清空输入” |
| `hooks/useAgentSession.ts` | modify | 429/发送失败回滚 optimistic user message，并用轻量 `sendError` 提示 |
| `hooks/useActivitySession.ts` | modify | activity 侧识别 429 JSON，展示友好错误 |
| `components/ChatWindow.tsx` | modify | 输入区上方增加轻量错误提示条 |
| `scripts/p0-smoke-test.ts` | modify | 新增 T2 限流 smoke：命令分类 / disabled / fallback / 429 / metric |

### 3.3 核心逻辑变化

后端从“无保护直通”变为“消息类命令先过限流器”：

```ts
// before
const result = await session.send(body);

// after
if (isMessageRateLimitedCommand(body)) {
  const verdict = await checkMessageRateLimit(userId);
  if (!verdict.allowed) return 429;
}
const result = await session.send(body);
```

前端从“点击发送立即清空输入”变为“服务端接受后才清空”：

```ts
// before
onSend(msg);
setValue("");

// after
const ok = await onSend(msg);
if (ok !== false) setValue("");
```

---

## 4. 验证

### 4.1 测试结果

| 测试 | 结果 |
|------|------|
| `node_modules/.bin/tsc --noEmit` | pass |
| `npm run test:smoke` | **232/232 pass** |

### 4.2 验收对照

- [x] 仅 `prompt/steer/follow_up` 进入限流；`get_state` 等控制命令不计数
- [x] 命中时返回 `429`、`Retry-After`、`{ error: "rate_limited", retryAfterMs }`
- [x] Redis 不可用时自动降级到内存窗口，不阻断业务
- [x] `rate_limit_hits_total{action="message"}` 计数增长
- [x] 前端被拒时保留输入文本，不吞消息

---

## 5. 回滚方案

```bash
git revert <本次 commit>
# 或仅关闭限流：
# .env -> RATE_LIMIT_ENABLED=false
```

回滚影响：恢复到阶段 2 T1 状态，请求入口不再有消息级防刷保护。

---

## 6. 后续改进

- [ ] T3：切到认证用户后，把限流 key 从 v3 userId 链无缝升级到 authenticated userId
- [ ] T6：在 tool_call 层增加工具级限流（L5）
- [ ] 增加 `X-RateLimit-*` 响应头，便于前端做剩余额度提示
