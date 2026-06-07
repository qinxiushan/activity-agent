# Activity Agent 演示视频策划

> 时长：6-8 分钟 | 目标观众：投资人/技术评审/内部 Demo | 核心：一句话 → 全自动方案 → 一键确认 → 真实预订

---

## 一、视频结构总览（6 幕）

```
┌─────────────┬──────────┬─────────────────────────────────────┐
│ 幕           │ 时长     │ 核心亮点                             │
├─────────────┼──────────┼─────────────────────────────────────┤
│ 1. 开场      │ 0:00-0:40 │ 问题 → 方案，一句话破题              │
│ 2. 核心流程   │ 0:40-3:00 │ 意图解析 → 自动规划 → 方案确认       │
│ 3. Phase Guard│ 3:00-4:00 │ 三层防线：工具违规被实时拦截         │
│ 4. 预订执行   │ 4:00-5:30 │ 真实状态机 + 确认码 + 失败重试       │
│ 5. 用户记忆   │ 5:30-6:30 │ 跨 session 偏好自动填充 + 多用户隔离  │
│ 6. 总结       │ 6:30-7:30 │ 关键数据 + 下一步计划                │
└─────────────┴──────────┴─────────────────────────────────────┘
```

---

## 二、分幕详细脚本 + 测试用例

### 幕 1：开场（40s）

**画面：** 浏览器打开 `http://localhost:30142/activity`，展示空白 Activity 页面。

**旁白：**
> "传统方式规划一次周末出行，需要在 3-5 个 App 之间切换，手动查天气、搜活动、找餐厅、比价格、打电话预订……平均耗时 45 分钟。Activity Agent 把这个流程压缩到一句话：你只需要告诉它'谁、什么时候、在哪、预算多少'，它自动完成从查天气到下单预订的全部工作。"

**操作：** 展示页面布局（左侧聊天区 + 右侧 Activity Panel），说明：
- Phase Progress 进度条（当前 idle）
- Plan Timeline 空白待填充
- Tool Timeline 空白待填充

**测试用例 TC-1：页面加载验证**

| 检查点 | 预期结果 |
|--------|----------|
| 页面加载 `/activity` | 200 OK，PhaseProgress 显示 idle |
| 右侧面板四组件渲染 | PhaseProgress + PlanTimeline（空）+ ToolTimeline（空）+ BookingCard（隐藏） |
| 左侧聊天输入框可见 | placeholder 可输入 |

---

### 幕 2：核心流程 — 一句话到方案（2:20）

**测试用例 TC-2：完整 SOP 流程（标准 happy path）**

**输入：**
```
想和女朋友周六(2026-07-11)去玩，下午6点前要结束，10:00开始，人在三里屯（北京朝阳），预算300元/人
```

**预期执行序列：**

```
Phase: idle → intent_capture
  ├─ intent_parse       → 提取 5 个关键字段 + auto-fill（若无历史偏好则走 clarify）
  └─ [若需追问] ask_clarification → 用户回答 → planning

Phase: intent_capture → planning
  ├─ get_weather        → {"condition":"晴","tempMax":32,"advice":"适宜户外"}
  ├─ search_activities  → 返回 3-5 个匹配活动（按 4D 评分排序）
  ├─ search_restaurants → 返回 2-3 个匹配餐厅
  ├─ check_opening_hours×N → 逐个验证营业时间
  └─ compute_route×N    → 计算出发地→活动→餐厅→活动的通勤链

Phase: planning → plan_confirm
  ├─ intent_parse(submitPlan=true) → 提交完整方案
  └─ LLM 输出格式化的方案时间轴
```

**画面重点（分镜头）：**

| 时间 | 画面 | 解说要点 |
|------|------|---------|
| 0:50 | 用户输入 prompt，点击发送 | "一句话，4 个关键信息——谁、什么时候、哪、多少钱" |
| 1:00 | PhaseProgress 从 idle → intent_capture 亮起 | "8 阶段状态机自动流转，用户无需手动推进" |
| 1:15 | ToolTimeline 依次出现 intent_parse、get_weather | "LLM 自动调用 12 个工具，无需用户'确认这个活动可以吗？'" |
| 1:35 | search_activities、search_restaurants 结果返回 | "34 条真实 POI 数据库，不是 LLM 幻觉——每个地点有真实坐标、价格、评分" |
| 2:00 | compute_route 计算通勤，check_opening_hours 逐个校验 | "自动计算通勤时间 + 验证营业时段，雨天自动推荐室内" |
| 2:20 | 方案呈现：时间轴 + 总费用 + 天气 + "确认/修改/重新生成" | "完整方案——唯一确认点，用户只需说一个字：确认" |

**验证断言（TC-2）：**

```
✅ intent_parse 被调用
✅ get_weather 被调用（含城市+日期参数）
✅ search_activities 被调用（至少 1 次）
✅ search_restaurants 被调用（至少 1 次）
✅ compute_route 被调用
✅ check_opening_hours 被调用
✅ reservation_exec 未被调用（用户还没确认）
✅ plan-state.json phase = "plan_confirm"
✅ plan-state.json 5 个 critical fields 全部非空
✅ plan-state.json plan.timeline 至少 3 条记录
```

---

### 幕 3：Phase Guard — 三层防线（1:00）

**画面：** 回到 ToolTimeline，高亮一个被 BLOCKED 的工具调用。

**测试用例 TC-3：Phase Guard 拦截（需要 LLM 尝试违规调用）**

由于 LLM 通常遵守 prompt 规则，此场景可用两种方式演示：

**方案 A（自然触发）：** 使用不完整的 prompt 诱导 LLM 跳过某些步骤，观察 PHASE_GUARD 返回。

**方案 B（录屏叠加说明）：** 解释代码级的三层防线设计，配合 ToolTimeline 截图展示 PHASE_GUARD 返回的 JSON 结构和红色 BLOCKED 标识。

**旁白：**
> "Activity Agent 有三层 phase 防线确保 LLM 不会在用户确认前就下单预订。第一层：工具注册前的静态白名单——比如 reservation_exec 只能在 executing 阶段调用。第二层：每次工具执行前，wrapper 的 beforeExecute 读取当前 phase——不匹配直接返回 PHASE_GUARD JSON。第三层：工具内部自校验——防止在 plan_confirm 阶段重复提交方案覆盖执行状态。"

**画面重点：**

| 时间 | 画面 | 解说要点 |
|------|------|---------|
| 3:15 | 展示 TOOL_PHASE_RULES 代码片段 | "第一层：reservation_exec 仅在 executing 阶段可用" |
| 3:30 | ToolTimeline 中红色 BLOCKED 标识 | "第二层：非法调用被实时拦截，LLM 收到 JSON 错误后自动调整" |
| 3:45 | 8 阶段转换图 | "8 个阶段的转换是 DAG，非法跳转直接拒绝——不是建议，是硬约束" |

**验证断言（TC-3）：**

```
✅ 任何在 plan_confirm 阶段调用 reservation_exec 返回 PHASE_GUARD
✅ 工具执行结果为 { error: true, code: "PHASE_GUARD" }
✅ ToolTimeline 显示红色 BLOCKED badge
✅ LLM 收到 PHASE_GUARD 后不会崩溃，继续生成用户友好回复
```

---

### 幕 4：预订执行 + 容错（1:30）

**测试用例 TC-4：确认 → 执行 → 预订成功**

**操作：** 用户在方案呈现后输入 "确认"。

**预期序列：**

```
Phase: plan_confirm → executing
  ├─ reservation_exec  → { orderId: "ORD-xxx", status: "pending" }
  ├─ reservation_exec  → (第二个餐厅，若有)
  ├─ query_booking     → { status: "confirmed", confirmationCode: "A3F8K2" }
  └─ plan_save         → 持久化 + 写用户偏好
Phase: executing → completed
```

**画面重点：**

| 时间 | 画面 | 解说要点 |
|------|------|---------|
| 4:15 | 用户输入"确认" | "用户一键确认，预订自动执行" |
| 4:25 | PhaseProgress executing 亮起 | "phase 自动切换到 executing" |
| 4:35 | reservation_exec 工具调用 → orderId | "真实预订状态机：pending → processing → confirmed" |
| 4:50 | BookingCard 弹出 | "确认码 A3F8K2，日期、时间、人数——全自动完成" |
| 5:05 | 展示预订失败 + retry_booking | "10% 模拟失败率——失败自动重试，3 次 exponential backoff" |

**验证断言（TC-4）：**

```
✅ phase 从 plan_confirm 转换为 executing
✅ reservation_exec 至少被调用 1 次
✅ 返回的 orderId 格式为 ORD-<timestamp>-<random>
✅ query_booking 返回 status ∈ {confirmed, failed}
✅ 若 confirmed：confirmationCode 非空 6 位大写字母数字
✅ 若 failed：可用 retry_booking 重试
✅ plan_save 被调用
✅ final phase = "completed"
✅ BookingCard 组件正确显示 restaurantName/date/time/confirmationCode
```

---

### 幕 5：用户偏好记忆（1:00）

**测试用例 TC-5：跨 session 偏好自动填充 + 多用户隔离**

**画面：** 展示 UserPreferencesPanel。

**操作序列：**

```
1. 展示右侧 UserPreferencesPanel → 默认空
2. 完成一次会话（幕 4 的 completed 状态）
3. 等 5s → UserPreferencesPanel 自动刷新，显示从历史推断的默认值
4. 开启新 session 输入模糊 prompt："周末想出去玩"
   → intent_parse 自动填充上次的 departurePoint/partySize/budget
   → LLM 回复："已根据您的偏好，默认使用：出发地三里屯、2人、预算300元……"
```

**旁白：**
> "用户偏好记忆让第二次使用更简单。系统从历史方案中自动学习你的习惯——出发地、人数、预算、偏好品类——下次只需说'周末想出去玩'，关键信息自动补全。多用户之间数据完全隔离。"

**验证断言（TC-5）：**

```
✅ 会话完成后，UserPreferencesPanel 显示 partySize/budget/departurePoint
✅ 新 session 输入模糊 prompt → intent_parse 结果含 autoFilledFields
✅ autoFilledFields 包含至少 1 个从历史推断的字段
✅ LLM 回复中提及自动填充的字段（用户被告知）
✅ 另一 userId 的 preferences 完全隔离（读不到其他用户数据）
✅ PUT /api/user-preferences 支持手动修改
✅ POST action=reset 可清空所有偏好
```

---

### 幕 6：总结（1:00）

**画面：** 全屏数据卡片 + 架构图。

**关键数据：**

| 指标 | 数值 |
|------|------|
| 架构 | SOP-v2 · 8-phase · 12-tool · single-confirm |
| 工具调用 | 全部经 retry + timeout + fallback 包装 |
| POI 数据库 | 34 条真实数据（22 活动 + 12 餐厅） |
| 预订状态机 | 5 状态：pending → processing → confirmed/failed → notified |
| 错误处理 | 5 层防线 + 8 种 BookingError 错误码 |
| 测试覆盖 | 126 smoke asserts + 24 e2e asserts |
| 用户记忆 | ≥50% 出现率阈值 + 5 条 ring buffer |

**旁白：**
> "Activity Agent 验证了一个核心命题：在严格的状态机约束 + 真实数据源 + 多层容错的组合下，LLM 可以可靠地完成从意图理解到预订执行的全流程自动化。当前 v0.2.0 已完整实现 SOP-v2，126 个 smoke 测试 + 24 个真实 LLM e2e 测试全部通过。下一步：接入高德/大众点评真实 API，将这套架构推向生产。"

---

## 三、测试用例汇总

| 编号 | 名称 | 类型 | 依赖 | 覆盖亮点 |
|------|------|------|------|---------|
| TC-1 | 页面加载验证 | 手动/Playwright | 仅 dev server | UI 完整性 |
| TC-2 | 完整 SOP 流程 | E2E（LLM） | API key + dev server | 12 工具全链路 |
| TC-3 | Phase Guard 拦截 | 手动/截图 | SOP 完成 | 三层防线 |
| TC-4 | 确认 → 预订执行 | E2E（LLM） | TC-2 的 session | 状态机 + 容错 |
| TC-5 | 用户偏好记忆 | E2E（LLM） | 多次 session | 跨 session + 隔离 |

**测试优先级：** TC-2 > TC-4 > TC-5 > TC-1 > TC-3

---

## 四、拍摄建议

| 要点 | 建议 |
|------|------|
| **录屏工具** | OBS Studio（免费开源），录制 1920×1080，浏览器缩放 150% 保证文字可读 |
| **Tab 切换** | 准备 3 个 Tab：`/activity`（主画面）、VS Code（代码特写）、Terminal（测试输出） |
| **代码特写** | 关键文件提前打开到对应行：`plan-state.ts:80-93`（TOOL_PHASE_RULES）、`tool-wrapper.ts:105-221`（wrapToolWithResilience） |
| **网络** | 使用本地 localhost（无延迟），提前 `npm run dev` 确保 server 已启动 |
| **LLM 预热** | 录前先跑一次 TC-2 确认 LLM 行为稳定，避免录制时翻车 |
| **备用数据** | 若 LLM 返回不稳定，准备 2-3 个备选 prompt 变体快速切换 |

## 五、Prompt 变体（备选）

| 场景 | Prompt | 亮点 |
|------|--------|------|
| 标准 happy path | 想和女朋友周六(2026-07-11)去玩，下午6点前结束，10:00开始，人在三里屯(北京朝阳)，预算300元/人 | 5 关键字段齐全，走完整流程 |
| 模糊意图（触发 auto-fill） | 周末想出去玩 | 仅有关键信息缺失，测试 autoFillIntent |
| 雨天场景 | 周六想带爸妈出去玩，人在上海静安寺，预算500元/人 | 触发 preferIndoor + 饮食限制推理 |
| 修改方案 | （确认后说）把第二家餐厅换成日料 | 触发 modify → planning → re-plan_save |
