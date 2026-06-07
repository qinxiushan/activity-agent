# 待改进观察 (Forward-Looking UX Observations)

> 来源:`docs/UI_DESIGN_ANALYSIS.md` §8(2026-06-07 读源代码时的前瞻性观察)。
> 抽取时间:2026-06-07 — 3-column 重构(`18df19c`)+ cleanup(`0ca82e1`)完成之后。
> 目的:这些观察不在重构范围内,但仍然有效 — 落地时可参考,避免再次全量重读代码。

---

## 状态图例

- **[已解决]**:本次 3-column 重构(commit `18df19c` 之后)或更早的 commit 已落地
- **[部分解决]**:基础设施/方法已就位,UI 接线未做
- **[未解决]**:观察仍然成立,待后续处理

---

## 1. 信息密度  [已解决]

解决:commit `fb814cb` 在 `components/activity/ActivityPanel.tsx` 加 phase-driven 渲染。`idle` 只显示 `PhaseProgress`;`intent_capture` / `clarifying` / `planning` 显示 `PhaseProgress` + `ToolTimeline`;`plan_confirm`+ 全部显示(`BookingCard` 仅在 `hasBooking()` 满足时出现);`cancelled` 暂不纳入(等 §2 单独处理)。噪声面板在早期 phase 自动隐藏,无需用户手动折叠。

## 2. 相位进度条  [未解决]

7 个相位:`idle` / `intent_capture` / `clarifying` / `planning` / `plan_confirm` / `executing` / `completed`。**少了 `cancelled`** —— 被取消的会话没有终止指示(进度条只终止于 `completed`)。

## 3. 轮询与 SSE 的重叠  [未解决]

SSE 投递 `message_end` / `tool_execution_start` / `tool_execution_end`,plan-state 1.5s 轮询读到的内容大部分 SSE 事件也覆盖了。**轮询可能冗余**,但目前仍作为 SSE 断开时的兜底保留(有用但可能过度)。

## 4. UI 中看不到用户身份  [未解决]

`lib/user-context.ts: getCurrentUserIdFromRequest()` 解析 userId,`UserPreferencesPanel` 隐式显示,但 UI **从不**显式展示「你是 alice」之类。Header 加个身份小标签更清楚。`/api/dev-login` 是 dev-only — UI 上加个「dev 模式」提示能避免误用。

## 5. 错误暴露  [未解决]

错误现在以 banner 形式渲染在消息列表上方(早期修复)。但 **plan-state 轮询** 或 **preferences 轮询**(若端点 500)的错误**没有暴露** —— 只在 console。SSE 重连是静默的。加个「正在重连…」指示器能帮用户理解停顿。

## 6. 相位 ↔ 面板的映射  [已解决]

解决:commit `fb814cb` 给每个面板加显式的「相关 phase 集合」:
- `PhaseProgress`: 始终显示(总指示器)
- `ToolTimeline`: `TOOL_VISIBLE_PHASES`(`intent_capture` / `clarifying` / `planning` / `plan_confirm` / `executing` / `completed`)
- `PlanTimeline`: `PLAN_VISIBLE_PHASES`(`plan_confirm` / `executing` / `completed`,plan 已生成)
- `BookingCard`: 数据驱动 — `hasBooking()` 返回 true 时显示(任一 `reservation_exec` / `query_booking` tool call `ok && endedAt !== null`)

`cancelled` 暂不纳入(等 §2 单独处理)。

## 7. 硬编码 SAMPLE_PROMPTS  [已解决]

原 6 个 prompt 硬编码在 `app/activity/page.tsx`,用户不可配置。**3-column 重构落地时删除**(commit `18df19c`,与 `ActivityPanelWrapper.tsx` 一起),统一视觉一致性优先于新用户引导。`grep -r SAMPLE_PROMPTS` 现在为空。

## 8. ToolTimeline 的空/尚无工具状态  [已解决]

原始观察:未确认空列表分支 — 工具时间线是显示「暂无工具调用」占位还是直接空渲染?
确认:`components/activity/ToolTimeline.tsx:36-53` 有空数组分支 — 渲染 panel 容器 + 标题"工具调用时间线" + 占位文字 "等待 LLM 开始…"(dim 色,居中)。模式与 `PlanTimeline` 的 "LLM 正在自动规划…" 占位一致(同样是「还在等数据」语义,不是「完成了」语义)。无需改动。

## 9. 取消 UX  [已解决]

原始观察:`reset()` 在 hook 里存在,但按钮是否接通不清楚。
解决:commit `18df19c` 加了 `useActivitySession.abort()` 方法(hook 内部 `POST /api/agent/[id]` body `{type:"abort"}`),commit `aa04c01` 在 `components/ActivityPanelWrapper.tsx` 头部接线了 "停止" 按钮(local `aborting` state 防双击,颜色 `#ef4444` 与 error banner 一致)。`activity.agentRunning` 为 true 时显示,点击后等 server 发 `agent_end` SSE 事件 → 按钮自动消失。

---

## 备注

- 原 `docs/UI_DESIGN_ANALYSIS.md` 在抽取本文件后被删除(文件从未 commit 过,无 git history)。
- 原文件 §2.1 / §6.1 含有错误信息(声称 AppShell 33K+ 行、Tailwind utility 风格 — 实际 614 行,inline styles + CSS variables),故原文件不可原样保留。
- §7「值得保留的模式」没有提取 —— 那些都是「好的实践,保持原样」,不需要 follow-up 文档。
- 落地任一观察时,先在本文件里把状态改成 `[已解决]` 并加 commit ref,避免下次全量重读。
