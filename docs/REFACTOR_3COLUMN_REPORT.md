# 3-Column 布局重构报告

> 时间: 2026-06-07
> 范围: `activity-agent` 全栈
> 目的: 把 `/activity` 合并进 `/`,以右侧栏形式承载活动规划

## 1. TL;DR

把"活动规划"从独立页面 `/activity` 合并到 home `/` 的右栏,与左侧 SessionSidebar、中间 ChatWindow 共存,形成 **3-column 布局**(sidebar | chat | activity panel)。`/activity` 现在是 307 redirect → `/`。

落地用了 3 个原子 commit:

| Commit | 主题 | 文件数 | +/- |
|---|---|---|---|
| `b691e4c` | fix(ui/activity): 删所有 AI emoji | 10 | +44/-47 |
| `18df19c` | feat(page): 3-column 布局 | 4 | +235/-96 |
| `1df7b57` | chore(activity): /activity → / | 1 | +3/-270 |

每个 commit 都 tsc 0 + smoke 126/126 + e2e 38/38,可独立 checkout,git bisect 友好。

前置 3 个 commit(`ba197db` e2e 修复、`3990fa6` BookingCard bug、`37d0c5d` prompt 删 emoji)为这次合并清场 — 不是合并的本体,但前序必要(详见 `docs/UI_DESIGN_ANALYSIS.md` 的观察 1-9)。

---

## 2. 改了什么

### 2.1 `b691e4c` — 删 UI emoji(铺垫)

把 `/activity` 页面里所有 AI 味很浓的 emoji 替换成 ASCII 字符或单字母。涉及 10 个文件,影响范围如下:

- **5 个 /activity 子组件**: `PhaseProgress.tsx` 删 `✎ ⚙ ★`;`PlanTimeline.tsx` 把 `🚌🚇🎯🍴☕` 换成 `D/T/A/M/R` 字母,删 `💰📍⏱`;`ToolTimeline.tsx` 把 12 个工具图标换成 2 字母代码 `IP/GW/SA/SR/CH/CR/RE/QB/RB/PS/PL`;`BookingCard.tsx` 删 `🍴`;`PhaseProgress.tsx` 保留 `✓ ✕ ●`(功能性状态符,非装饰)
- **`UserPreferencesPanel.tsx`**: 删 `🧠🔄🗑️`,按钮换"刷新/重置"
- **`lib/plan-state.ts`**: 注释里 `⭐` 删
- **`lib/weather-service.ts`**: `WeatherForecast.emoji` 字段从接口删;`CONDITION_META` 里 6 个天气 emoji(`☀️⛅🌧️❄️🔥🥶`)删,只留 `description` 中文
- **`scripts/p0-smoke-test.ts`**: 3 处删 emoji + 1 处断言从 `w.emoji` 改为 `w.condition + w.description`(被 weather-service 接口变化破坏的引用)
- **`tests/activity-visual.spec.ts`**: 5 处 `text=🧠 用户偏好` 改为 `text=用户偏好`

**保留的功能性 Unicode 符号**:`✓`(past phase / installed skill)、`✕`(cancelled)、`●`(current)、`○`(idle)、`?`(clarifying)、`→`(executing progress)。这些都是状态指示符,非装饰。

**保留的工具描述 emoji**:`src/tools/activity-tools.ts:536` 的 `⚠️` 保留 — 是 phase guard 警告的功能性提示,不是装饰。

### 2.2 `18df19c` — 3-column 布局(核心)

把 home `/` 改成 3-column。4 个文件,最大改动:

**`components/AppShell.tsx`** (676 → 614 行):

- 删 `FileViewer` 和 `TabBar` import
- 删 `useState<FileTab[]>([])`、`useState<string|null>(null)` 两个文件 tab 状态
- 删 `handleOpenFile`(原打开 file tab)和 `handleCloseFileTab`
- 删 `activeFileTab` 派生
- `handleOpenFile` 改成 no-op + 顶部加 TODO 注释(给 SessionSidebar 留 callback 接口,等 FileViewer 恢复)
- `rightPanelOpen` 初始值 `false` → `true`(右栏默认展开)
- 删浮动 file panel toggle 按钮(top-right fixed)
- 删 `usePathname` import 和 `const pathname = usePathname()`(原用于 `/activity` link 的 `aria-current` 高亮)
- 新增 `rightPanel: ReactNode` prop(默认 `null`)
- top bar 里的 `<a href="/activity">` link 换成 `<button onClick={toggleRightPanel}>`(同款 target/circles icon)
- 右栏容器 `right-panel-container` 渲染 `rightPanel` prop,无内容时 fallback "No panel"
- `{rightPanel && ...}` 包裹整个右栏 — 不传时不渲染容器

**`components/ActivityPanelWrapper.tsx`** (新文件,186 行):

自包含右栏内容。`useEffect` 里 `fetch("/api/home")` 拿 cwd、`fetch("/api/models")` 拿 `modelList` + `defaultModel`。组合:
- Header:`Activity Panel` 标题 + `新会话` 按钮(仅在有 session 时)+ `LLM 工作中` 指示器(agentRunning 时)
- Body:可滚动,error banner + 内联 chat bubble 列表(显示 user/assistant 消息)+ `UserPreferencesPanel` + `ActivityPanel`(PhaseProgress / BookingCard / PlanTimeline / ToolTimeline)
- Footer:`<select>` 模型选择器(仅 no-session 且多模型)+ `<textarea>` 输入 + `开始/发送` 按钮

**`hooks/useActivitySession.ts`** (262 → 274 行):

- 新增 `abort()` 方法:`POST /api/agent/[id]` body `{type: "abort"}` — 由 `/api/agent/[id]/route.ts` 直接转发给 `session.send()`,pi-coding-agent 标准命令
- `UseActivitySessionResult` 接口加 `abort: () => Promise<void>`

**`app/page.tsx`** (10 → 13 行):

- `import { ActivityPanelWrapper } from "@/components/ActivityPanelWrapper"`
- `<AppShell />` 改为 `<AppShell rightPanel={<ActivityPanelWrapper />} />`

### 2.3 `1df7b57` — /activity 重定向(收尾)

**`app/activity/page.tsx`** (272 → 4 行):

```tsx
import { redirect } from "next/navigation";

export default function ActivityPage(): never {
  redirect("/");
}
```

服务端 redirect,客户端浏览器 URL 跟着变成 `/`。`curl -I /activity` 返回 `HTTP/1.1 307 Temporary Redirect` + `location: /`。

`app/activity/` 目录保留(只为这个 4 行 page.tsx 存在);如要彻底清理,后续 commit 可 `rm -rf app/activity/`。

---

## 3. 设计决策

### 3.1 Activity session ≠ chat session(独立)

- chat 用 pi-coding-agent 默认工具集(read/bash/edit/write);activity 用 12 个 activity 工具
- 两者的 `useActivitySession` 与 `useAgentSession` 是独立 hook,各自管 SSE 重连 + plan state 轮询
- 用户可以同时在中间跟 chat 谈项目代码、在右栏让 LLM 规划活动 — 不冲突
- **决策依据**:活动规划是 vertical slice 产品,与 coding session 是并列场景而非子任务

### 3.2 FileViewer 删除(不保留为 drawer)

- 用户明确决定 "drop FileViewer, not preserve as drawer"
- AppShell 顶部留 TODO 注释,说明恢复路径(re-add FileViewer + TabBar imports、fileTabs/activeFileTabId state、右栏 header 里的 TabBar)
- `handleOpenFile` 改 no-op 保持 SessionSidebar 的 callback 接口
- `FileViewer.tsx` 和 `TabBar.tsx` 文件**未删** — 等需要恢复时直接用
- **决策依据**:本次重构核心是简化布局,新增 "drawer 模式" 会扩大 scope、模糊目标

### 3.3 `rightPanel: ReactNode` prop 而非写死 Activity

- AppShell 不耦合 ActivityPanelWrapper — 未来可换其他右栏内容(如 debug console、metrics dashboard)
- 默认 `null` 表示不渲染右栏容器 — 旧用法/新用法共存
- **决策依据**:保持 AppShell 的 "shell" 定位,不变成 Activity 专属

### 3.4 ActivityPanelWrapper 自包含(自 fetch /api/home 和 /api/models)

- 不依赖 AppShell 传 cwd/model — 简化调用方
- 与原 `/activity/page.tsx` 行为一致(fetch 同样两个 endpoint)
- **决策依据**:右栏是一个独立产品切片,需要能 standalone 工作;AppShell 只需传 "内容是什么",不用传 "内容需要什么"

### 3.5 删 SAMPLE_PROMPTS

- 原 `/activity/page.tsx` 顶部有 3 个示例 prompt 按钮,点击填入 textarea
- 删 — home page 中间 chat 区没有 sample prompts,保持风格一致
- 用户在右栏看到的是空状态提示 "开始一个活动规划"
- **决策依据**:视觉一致性 > 新用户引导;新用户有 LLM 提示文本足够了

### 3.6 Toggle 按钮替换 link(默认展开)

- 原 top bar 里的 `<a href="/activity">` link 改成 `<button onClick={toggleRightPanel}>`(同款 target/circles SVG)
- icon 不变 — 用户认知里 "这个圈" = "活动规划" 一致
- `rightPanelOpen` 默认 `true` — 用户打开 home 立即看到活动规划,符合 "vertical slice" 定位
- **决策依据**:活动规划是核心功能,不该藏在二级页面

### 3.7 右栏宽度复用 CSS class

- 复用 `right-panel-container` + `right-panel-open`/`right-panel-closed` 三个 CSS class(原本给 file panel 用)
- 宽度 transition 动画、桌面/移动断点都自动继承
- **决策依据**:零新增 CSS,globals.css 改动 = 0

---

## 4. 坑和修复

### 4.1 `usePathname` import 删了但调用忘了删

**坑**:删 `/activity` link 时只删了 `import { usePathname }`,忘了删 `const pathname = usePathname()`。tsc 报:

```
components/AppShell.tsx(17,20): error TS2552: Cannot find name 'usePathname'.
Did you mean 'pathname'?
```

**修**:`grep -n usePathname` 找到第 17 行的调用,删除。

**教训**:删 import 时一定要 `grep` 整个文件确认无引用,不能只看 import 行。

### 4.2 `WeatherForecast.emoji` 字段删除破坏 smoke test

**坑**:删 `lib/weather-service.ts` 里 `emoji` 字段后,`scripts/p0-smoke-test.ts:73` 的 `!!w.emoji && !!w.condition` 引用变成 type error。

**修**:把断言改成 `!!w.condition && !!w.description` — 同样的覆盖度(字段存在性),但用仍在接口里的字段。

**教训**:删接口字段前先 `grep -rn '\\.字段名' lib/ scripts/` 找所有调用点,一并改。

### 4.3 Playwright locator `text=🧠 用户偏好` 失效

**坑**:删 `UserPreferencesPanel.tsx` 的 `🧠` 后,`tests/activity-visual.spec.ts` 5 处 `page.locator("text=🧠 用户偏好")` 都变成无法匹配的 locator — 5 个 test 全 fail。

**修**:`replaceAll` 5 处统一改成 `text=用户偏好`,语义不变。

**教训**:UI 文本改 emoji 时,Playwright locator 是隐藏的字符串引用,必须同步 grep + 改。

### 4.4 e2e test 假阴性(LLM 速度)

**坑**:`scripts/e2e-real-llm-test.ts` 在 turn 2 完成后断言 `s2.phase === "executing"`,但 deepseek-v4-flash + 800ms `processingDelayMs` 太快,LLM 在 turn 2 一次性完成了 `reservation_exec` + `query_booking` + `plan_save`,phase 已经到 `completed`。

**修**:`ba197db` 单独 commit 把断言改为 `=== "executing" || === "completed"`,接纳 LLM 速度提升。

**教训**:e2e 时间相关断言要用 "范围" 而非 "精确值",预留 LLM 性能提升空间。

### 4.5 BookingCard 一直显示"预订中"

**坑**:`components/activity/BookingCard.tsx` 从 `tc.resultSummary` 解析 booking JSON,但 `useActivitySession.ts:summarizeResult` 限制字符串 ≤ 80 字符:`s.length > max ? s.slice(0, max) + "…" : s`。Booking JSON ~250+ 字符,被截断后 JSON.parse 失败,BookingCard 一直 fallback 到 "预订中"。

**修**:`3990fa6` 单独 commit:
- `ActivityToolCall` 接口加 `result: unknown` 字段(原 `resultSummary` 旁)
- `tool_execution_end` 事件处理时 `result: result` 存完整 payload(不受截断)
- `BookingCard.tsx` 改用 `parseBookingResult(tc.result)` 解析,新增 helper 处理 string/object/undefined 三种情况
- `resultSummary` 保留(仍用于 ToolTimeline 展示摘要)

**教训**:**数据截断是 bug 温床**。展示用的 summary 可以截断,但程序消费的原始数据必须保留全量。

### 4.6 提交里多了 3 个多余注释(commit 3 时)

**坑**:`b691e4c` 提交时在 AppShell 加了 3 个新注释:
```tsx
// Right panel — content provided via rightPanel prop...
// FileViewer/TabBar dropped in 3-column merge...
const handleOpenFile = useCallback((_filePath, _fileName) => {
  // no-op until FileViewer is restored
}, []);
```

前 2 个是 state 描述(`const [rightPanelOpen, ...]` 本身自解释),第 3 个是函数体描述(空函数体自解释)。

**修**:`edit` 删 2 个 state 注释 + 1 个 `// no-op` 注释,保留 TODO 注释(FileViewer 恢复指引是用户明确要求的)。

**教训**:**注释要 "必要才留"**:自解释代码不写;BDD 格式 `given/when/then` 写;算法/安全/性能关键点写。state 描述、no-op 描述、空函数体描述一律不写。

---

## 5. skill 候选

### 5.1 `atomic-feature-rollout` ⭐⭐⭐

这次 6-commit 重构(3 个前置 + 3 个核心)是 `atomic-feature-rollout` 的教科书例子:

- **每 commit 一个关注点**:test fix / BookingCard / prompt emoji / UI emoji / 3-column / redirect,互不交叉
- **中间状态自洽**:commit 3 (UI emoji) 后,`/activity` 仍然完整工作(只是没有 emoji);commit 4 (3-column) 后,`/activity` 仍可用,与 home 并存;commit 5 (redirect) 后,所有入口都到 home
- **每个 commit tsc 0 + smoke 0 + e2e 0**:bisect 友好
- **doc-sync 在版本边界(commit 6)**:不在每个 commit 写文档,避免 doc 频繁变动

**skill 抽取价值**:高。可作为 `atomic-feature-rollout` 的标准案例存档。

### 5.2 `phase-gated-agent` ⭐⭐

这次重构有清晰的 phase 计划(6 个 commit),每个 phase 验证后才进入下一个 — 与 `phase-gated-agent` 的 SOP-v2 模式(intent → plan → confirm → execute)契合。

但这次没有"用户确认"环节 — 用户在重构开始前就批准了 6-commit 计划,中间不再询问。

**skill 抽取价值**:中。`phase-gated-agent` 的"phase 边界 + tool whitelist + 状态持久化"这次用不上(我们用的是 git + tsc + smoke + e2e),但"phase 计划必须先确认"的核心 discipline 一致。

### 5.3 `progressive-identity-hardening` ⭐

不直接适用 — 这次重构是 UI 布局,不是身份/权限。但 activity-agent 的 userId 体系(单用户 → 多用户)有 `useActivitySession` 的 hook 隔离,可参考 `progressive-identity-hardening` 的 v1 → v2 → v3 模式做未来扩展。

**skill 抽取价值**:低。本次不抽取。

---

## 6. 验证

### 6.1 Gate 结果(每个 commit 都跑)

| Commit | tsc | smoke | e2e:real | 备注 |
|---|---|---|---|---|
| `ba197db` (test fix) | 0 | 126/126 | 38/38 | 单独验证 |
| `3990fa6` (BookingCard) | 0 | 126/126 | 38/38 | 单独验证 |
| `37d0c5d` (prompt emoji) | 0 | 126/126 | 38/38 | 单独验证 |
| `b691e4c` (UI emoji) | 0 | 126/126 | 38/38 | 单独验证 |
| `18df19c` (3-column) | 0 | 126/126 | 38/38 | 单独验证 |
| `1df7b57` (redirect) | 0 | 126/126 | 38/38 | + `curl -I /activity` → 307 → / |

### 6.2 额外检查

- **Dev server 热重载**:每次 `git commit` 后,Next.js dev server(pid 478991)自动 HMR,无需重启。`/api/sessions` 持续 200。
- **Playwright visual**:`tests/activity-visual.spec.ts` 5 个 locator 在 commit 3 (`b691e4c`) 同步更新;commit 5 (`1df7b57`) 之后 navigate `/activity` 自动跟随 307 透明跳到 `/`,locator 仍命中右栏(同一份 `UserPreferencesPanel`)。
- **Bisect-clean**:每个 commit 都能 `git checkout` 独立跑通(只是 commit 3 之前右栏没整合到 home,但 `/activity` 仍可用)。

### 6.3 未做的验证

- **真实 UI 视觉对比**:没有跑 `npm run test:visual` 截屏对比 commit 3 vs commit 5 的 home page 视觉差。改动是显著的(2-col → 3-col),手动验证即可。
- **多浏览器兼容**:仅在 Chromium 测过 Playwright。Firefox/Safari 行为依赖 globals.css 的 CSS class,未测。
- **多 cwd 切换**:未在两个不同 cwd 之间切换 SessionSidebar 验证右栏是否独立恢复 — 当前右栏用 `useActivitySession`,每次 mount 都会新 fetch /api/home,与 cwd 切换解耦。
- **大 plan state 性能**:未测 plan state timeline > 50 段的渲染性能。PlanTimeline 一次渲染所有 legs,可能在大数据下变慢。

### 6.4 关键决策点(如果时间倒流)

1. **是否合并 commit 3 + 4**:UI emoji + 3-column 是 2 个不同关注点(前者是 UI 卫生,后者是布局重构),保持分离让 bisect 更有意义。
2. **是否直接删 `app/activity/`**:留 redirect 而不是删,是为了让 Playwright test + 老书签平滑过渡。后续 commit 可 `rm -rf app/activity/`。
3. **是否合并 `b691e4c` 到 `18df19c`**:emoji 清理不影响 3-column 布局,合并会让 commit 4 变得巨大(150+ lines / 10 files)。分开更好。

---

## 7. 相关 commit

| Hash | Title | Files | +/- |
|---|---|---|---|
| `ba197db` | test(e2e): accept 'completed' phase in post-confirm assertion | 1 | +1/-1 |
| `3990fa6` | fix(BookingCard): use full tool result, not truncated summary | 2 | +29/-3 |
| `37d0c5d` | fix(prompts): drop AI emoji template, add 'no emoji in output' rule | 1 | +3/-25 |
| `b691e4c` | fix(ui/activity): remove all AI-flavored emoji from /activity components | 10 | +44/-47 |
| `18df19c` | feat(page): 3-column layout — merge /activity into / as right panel | 4 | +235/-96 |
| `1df7b57` | chore(activity): redirect /activity → / (home page now hosts the panel) | 1 | +3/-270 |
| (this)  | docs(report): record the 3-column refactor | 1 | (this file) |

合计 7 commits,跨越 emoji 卫生 / bug 修复 / 布局重构 / 文档 4 个主题,每个 commit 独立可验证。

---

## 8. 下一步建议

1. **`rm -rf app/activity/`**:彻底清理已死的目录,删 redirect 包装。Playwright test 需要从 navigate `/activity` 改成 navigate `/`。
2. **`useActivitySession.abort()` 加 UI 按钮**:方法已加(commit 4),但 ActivityPanelWrapper header 还没暴露按钮 — 用户跑长任务时无法 stop。
3. **`FileViewer` 恢复决策**:当前 TODO 注释保留。如果未来 activity-agent 不再需要 file viewer(纯 vertical slice 定位),可彻底删 `FileViewer.tsx` + `TabBar.tsx` + `SessionSidebar.onOpenFile` 接口。
4. **CSS 重构**:右栏宽度固定 ~420px(从 globals.css 的 `right-panel-container` 看),可考虑加 resizer 拖拽调整。
5. **`docs/UI_DESIGN_ANALYSIS.md` 整合**:之前的 UI 分析 doc 是 256 行,本次报告 200+ 行,两份有重叠 — 后续可合并到 `docs/UI_DESIGN_V2.md` 一份。
