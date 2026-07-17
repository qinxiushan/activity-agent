# [bug] text_delta 增量文本未累加导致流式输出闪烁/突现

> 用户反馈：发送问题后流式输出"错乱弹出"，没有逐字正常吐出，一会后一块出现很多文字

---

## 1. 元信息

| 字段 | 值 |
|------|-----|
| **日期** | 2026-07-17 |
| **类型** | `bug` |
| **严重度** | `P1 高`（核心流式 UX 体验被破坏） |
| **修改文件数** | 1 |
| **触发方式** | 用户手动测试发现 |
| **关联 commit** | `49f1e73` |

---

## 2. 问题描述

### 2.1 现象

LLM 回复时前端显示异常：
1. 没有正常的逐字流式输出
2. 文字"闪烁"或"跳跃"而非逐渐增多
3. 一段时间后`message_added`事件携带完整消息，一次性出现大量文字

### 2.2 根因

T2 EventAdapter 迁移后，`text_delta` 事件只携带**增量字符**（如 `"这"`），而原 pi SDK 事件 `message_update` 携带的是**累积文本**（如 `"这是上海的天气情况..."`）。

`useAgentSession.ts` 的文本流式处理代码直接使用 `event.text`（增量）作为 `streamingMessage` 的唯一内容：

```typescript
// ❌ 错误：仅使用当前增量，之前内容被覆盖
case "text_delta":
  const partialMsg = {
    role: "assistant",
    content: [{ type: "text", text: event.text }],  // 只存了 "这"
  };
  dispatch({ type: "update", message: partialMsg });
```

每次 dispatch 替换而非追加：
```
delta 1: event.text = "这" → streamingMessage.text = "这"      ✅
delta 2: event.text = "是" → streamingMessage.text = "是"      ❌ 覆盖了"这"
delta 3: event.text = "上" → streamingMessage.text = "上"      ❌
...
最终: message_added 携带完整文本 → 一下子出现大量文字
```

### 2.3 影响范围

- 所有 LLM 流式回复（每个对话的每个回复）
- 文本流式展示完全失效
- `thinking_delta` 同理（但影响小于文本，因文本是最终输出）

---

## 3. 解决方案

### 3.1 方案选择

| 方案 | 描述 | 结论 |
|------|------|------|
| **A: useRef 累加 delta** | 按 `turnIndex` keyed Map 存储累积文本，每次 dispatch 完整文本 | ✅ 选此方案。零额外渲染，与现有 reducer 兼容 |
| **B: 改 reducer 做追加** | reducer 中读取当前 streamingMessage 并追加 delta | ❌ reducer 依赖 streamingMessage 的稳定性，追加逻辑不纯 |
| **C: 放弃 delta 格式，恢复为完整消息推送** | EventAdapter 把 text_delta 改为带完整 payload 的格式 | ❌ 即否定了 EventAdapter "轻量增量" 的设计目标 |

### 3.2 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `hooks/useAgentSession.ts` | `modify` | 新增 `accumulatedText`/`accumulatedThinking` refs，增量累加后 dispatch |

### 3.3 核心逻辑变化

**Before**:
```typescript
case "text_delta":
  const partialMsg: Partial<AgentMessage> = {
    role: "assistant",
    content: [{ type: "text", text: event.text }],
  };
  dispatch({ type: "update", message: normalizeToolCalls(partialMsg as AgentMessage) });
```

**After**:
```typescript
case "text_delta": {
  const turnKey = event.turnIndex;
  const prevText = accumulatedText.current.get(turnKey) ?? "";
  accumulatedText.current.set(turnKey, prevText + event.text);
  const fullText = accumulatedText.current.get(turnKey)!;
  const fullThinking = accumulatedThinking.current.get(turnKey) ?? "";
  const content: AssistantContentBlock[] = [];
  if (fullThinking) content.push({ type: "thinking" as const, thinking: fullThinking });
  content.push({ type: "text" as const, text: fullText });
  const partialMsg: Partial<AgentMessage> = { role: "assistant", content };
  dispatch({ type: "update", message: normalizeToolCalls(partialMsg as AgentMessage) });
  break;
}
```

关键变化：
- `accumulatedText: Map<turnIndex, string>` — 按 turn 累积 delta 文本
- `accumulatedThinking: Map<turnIndex, string>` — 按 turn 累积 thinking delta
- 每次 dispatch 的是**完整已累积文本**（`fullText`），不是增量
- `thinking_delta` 同理：累积后 + `accumulatedText` 共同构成完整 `AssistantContentBlock[]`
- `agent_start` / `done` 时 `clear()` 两个 Map

---

## 4. 验证

### 4.1 测试结果

| 测试类型 | 结果 |
|---------|------|
| 烟雾测试 | 171/171 pass |
| TypeScript 编译 | `tsc --noEmit` pass |
| SSE 实测：text_delta 事件数 | 147 个逐字增量（短回复） |
| 字符递增验证（代码审查） | 每步 `accumulatedText = prev + delta` |

### 4.2 验收标准

- [x] `accumulatedText` 按 `turnIndex` 累加所有 `text_delta` 增量
- [x] `accumulatedThinking` 按 `turnIndex` 累加所有 `thinking_delta` 增量
- [x] `streamingMessage.content` 包含完整的累积文本（不是单个字符）
- [x] `agent_start` / `done` 时清除累积缓存，防止跨轮 contamination
- [x] `AssistantContentBlock[]` 类型正确（text + thinking block 顺序保留）
- [x] `normalizeToolCalls` 不影响 text/thinking block（只处理 toolCall block）
- [x] smoke 171/171 pass
- [x] `tsc --noEmit` pass

---

## 5. 回滚方案

```bash
git revert 49f1e73 --no-edit
```

回滚影响：恢复流式输出闪烁/突现的 bug，`streamingMessage` 回到仅含增量字符的状态。

---

## 6. 后续改进

- [ ] 考虑将累积逻辑抽入 `streamReducer` 中（当前用 useRef 是权衡 reducer 无副作用约束的结果）
- [ ] 在 `turn_start` 时清理旧 turn 的累积数据（当前只清理 `agent_start`/`done`）
- [ ] 增加 E2E 测试验证流式文本的逐字符增长（通过比较 `text_delta` 事件序列与最终 `message_added` 内容）
