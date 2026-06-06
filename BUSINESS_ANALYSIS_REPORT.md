# activity-agent 业务目标达成度分析与优化报告

> **报告类型**：产品逻辑链路审计 + 优化路线图
> **基准**：本地 PRD「本地单日短时活动规划与执行Agent V1.0」
> **审计对象**：`/home/a/chat_robot/pi_agent/activity-agent/` 实际代码
> **日期**：2026-06-06

---

## 一、一句话总结

**activity-agent 当前的实现是一个"LLM Prompt + 6 个记录型工具"的脚手架，PRD 描述的"全流程自动执行"被严重简化：所有推荐依赖 LLM 预训练知识，"预订"是 mock，"用户确认"靠 prompt 文字约束而非代码守卫。距离 PRD 核心目标的工程化实现还有 4 个关键缺口需要补齐。**

---

## 二、PRD 核心目标 vs 现状对照表

| PRD 目标 | 现状实现 | 达成度 | 关键差距 |
|---------|---------|--------|---------|
| **一句话输入** | 浏览器 `<ChatInput />` 接收 | ✅ 100% | — |
| **智能方案生成** | LLM + 5 步 prompt 工作流 | ⚠️ 60% | 无实时数据源，全靠 LLM 训练数据 |
| **用户一键确认** | LLM prompt 约束"等待确认" | ⚠️ 30% | 无代码级强制 gate，依赖 LLM 自觉 |
| **全流程自动执行** | `reservation_exec` 生成假订单号 | ❌ 5% | 完全 mock，无真实预订/支付/通知 |
| **4-6 小时黄金时段** | prompt 提及"时长偏好"但未硬约束 | ⚠️ 20% | LLM 可推荐任意时长，无校验 |
| **容错性（自动重试+备选）** | 工具内无 try/catch | ❌ 0% | 完全依赖 LLM 自己想办法 |
| **45min → 30s** | 单轮 LLM 响应通常 < 30s | ✅ 80% | 取决于 LLM 速度，但 5 步串行会拖慢 |
| **用户偏好记忆** | 无 | ❌ 0% | 无 profile / memory 机制 |
| **可扩展性** | customTools 机制天然支持 | ✅ 90% | — |
| **灵活性（动态适配）** | prompt 显式说明不预设值 | ✅ 70% | — |

**总体达成度：约 35%**（按业务目标权重加权）

---

## 三、5 步工作流的逐环节深度分析

### 3.1 工作流全貌（来自 `src/prompts/activity-planner.ts`）

```
用户输入
   │
   ▼
[Step 1] LLM 理解意图 → 调用 intent_parse → 展示 → ⚠️ 等用户确认
   │
   ▼
[Step 2] LLM 推荐活动 → 调用 activity_search → 展示 → ⚠️ 等用户确认
   │
   ▼
[Step 3] LLM 推荐餐厅 → 调用 restaurant_search → 展示 → ⚠️ 等用户确认
   │
   ▼
[Step 4] LLM 生成完整方案（时间轴） → 展示 → ⚠️ 等用户决策（确认/修改/重新生成）
   │
   ▼
[Step 5] 用户确认 → 调用 reservation_exec（mock）→ 调用 plan_save
```

### 3.2 逐环节分析

#### Step 1：意图理解

**实现方式**（`src/tools/activity-tools.ts:83-98`）：

```typescript
{
  name: "intent_parse",
  description: "记录模型分析后的用户意图理解结果。模型先用自然语言理解用户需求，分析出结构化信息，再调用此工具保存记录",
  parameters: intentRecordSchema,  // groupType, groupSize, duration, activityTypes, ...
  execute: async (_id, params, ...) => {
    return {
      content: [{ type: "text", text: JSON.stringify({ saved: true, intent: params }) }],
      details: params,
    };
  },
}
```

**评级**：

| 维度 | 评分 | 评价 |
|------|------|------|
| Schema 完整性 | ⭐⭐⭐⭐ | 8 个字段覆盖人群/时长/类型/饮食/预算/位置/特殊需求 |
| 提取准确性 | ⭐⭐ | 全部依赖 LLM 推断，无 NLU 校验/二次确认 |
| 歧义处理 | ⭐ | prompt 说"询问是否准确"但无强制 |
| 持久化 | ⭐⭐⭐⭐⭐ | 工具确实把数据存到 session |

**关键缺陷**：

- ❌ **没有歧义检测**：如果用户说"晚上跟朋友吃个饭"，LLM 可能直接猜出 groupSize=4、cuisine=xxx，但没有"我不确定，请确认"的强制回环
- ❌ **没有置信度**：每次都是硬性提取，没有"我不确定是 3 人还是 4 人"的软标注
- ❌ **没有二次确认机制**：prompt 写"询问是否准确"，但 LLM 可能认为"已经表达了准确信息"就跳过

#### Step 2：活动推荐

**实现方式**（`src/tools/activity-tools.ts:99-114`）：

```typescript
{
  name: "activity_search",
  description: "记录模型推荐的活动方案。模型根据意图自己推荐合适的活动",
  parameters: Type.Object({
    activities: Type.Array(Type.Object({
      name: Type.String(),
      type: Type.String({ description: "outdoor/cultural/shopping/entertainment" }),
      duration: Type.Number(),
      price: Type.Number(),
      rating: Type.Number(),
      location: Type.String(),
    }))
  }),
  execute: async (_id, params) => ({ saved: true, activityCount: params.activities.length }),
}
```

**评级**：

| 维度 | 评分 | 评价 |
|------|------|------|
| Schema 设计 | ⭐⭐⭐⭐ | 6 个字段够用 |
| **数据真实性** | ⭐ | **致命缺陷** |
| 时长/价格准确性 | ⭐ | LLM 编的数据，训练截止后无更新 |
| 位置准确性 | ⭐ | 可能推荐已关闭/不存在的地点 |
| 与 LLM 知识的绑定 | ⭐⭐⭐⭐ | LLM 训练数据中的主要城市/景点尚可 |

**关键缺陷**：

- ❌ **完全无真实数据源**：grep 全 src/ 目录，无 `fetch`、`axios`、`http`、`https` 调用
- ❌ **价格/评分是 LLM 编的**：注释 `"description": "费用（元）, 0表示免费"` 暗示应该是真实数据，但实际是 LLM 自由发挥
- ❌ **不存在的地点风险**：LLM 可能推荐"上海星空图书馆"这种幻觉产物
- ❌ **无 POI 数据库接入**：PRD 说"全品类活动资源匹配"，当前实现 = LLM 脑子里有什么就推什么

#### Step 3：餐厅推荐

与 Step 2 完全同构（`src/tools/activity-tools.ts:115-130`），所有缺陷一致。

**额外问题**：

- ❌ **没有实时营业状态**：午餐时间推荐已关门餐厅
- ❌ **没有实时排队情况**：推荐"网红店"但要等位 2 小时
- ❌ **没有真实评价数据**：LLM 编的"评分 4.8"
- ❌ **没有真实人均价格**：北京/上海同等档次餐厅价格差异可达 3 倍

#### Step 4：方案生成

**实现方式**：无专用工具，纯 LLM 文本输出。prompt 要求"时刻+行为+地点"时间轴格式（`src/prompts/activity-planner.ts:65-79`）。

**评级**：

| 维度 | 评分 | 评价 |
|------|------|------|
| 格式规范性 | ⭐⭐⭐⭐ | prompt 给了完整模板 |
| **时长校验** | ⭐ | 没有强制 4-6 小时 |
| 通勤时间考虑 | ⭐⭐ | prompt 提及但 LLM 自由发挥 |
| **总费用计算** | ⭐ | LLM 自加，可能算错 |

**关键缺陷**：

- ❌ **无结构化输出校验**：LLM 输出的"时间轴"是 markdown 文本，没有 JSON schema 强制
- ❌ **无总时长计算**：没有工具验证"你说 4 小时，但 sum > 6 小时"
- ❌ **无总预算校验**：可能超出用户预算范围
- ❌ **无地理合理性**：可能推荐上午在三里屯、下午在苏州

#### Step 5：执行预订

**实现方式**（`src/tools/activity-tools.ts:131-151`）：

```typescript
{
  name: "reservation_exec",
  execute: async (_id, params) => {
    const result = {
      orderId: `ORD-${Date.now().toString(36)}`,           // ← 假订单号
      status: "confirmed",                                  // ← 假状态
      restaurantName: params.restaurantName,
      date: params.date,
      time: params.time,
      partySize: params.partySize,
      confirmationCode: Math.random().toString(36).slice(2, 8).toUpperCase(),  // ← 假确认码
    };
    return { content: [...], details: result };
  },
}
```

**评级**：

| 维度 | 评分 | 评价 |
|------|------|------|
| 看起来执行了 | ⭐⭐⭐ | 返回了"订单号"和"确认码" |
| **真的执行了吗** | ⭐ | 完全 mock |
| 实际预订/支付 | ❌ | 无 |
| 真实通知（短信/邮件） | ❌ | 无 |
| 错误回滚 | ❌ | 任何失败都"成功" |

**这是 PRD 最大的缺口**：「全流程自动执行」是 demo 阶段全部 mock，PRD 已经说"不包含真实资金交易"，但即便是模拟也应该有"模拟数据库写入、模拟通知发送、模拟状态机"，当前实现就是 4 行代码生成假 ID。

---

## 四、关键问题清单（按 PRD 业务影响排序）

### 4.1 P0：阻塞核心业务目标

| # | 问题 | 位置 | 影响 | 业务后果 |
|---|------|------|------|---------|
| 1 | **无真实活动/餐厅数据源** | `src/tools/activity-tools.ts:99-130` | Step 2-3 完全不可信 | 用户拿到的方案是 LLM 编的，无法验收 |
| 2 | **预订完全 mock** | `src/tools/activity-tools.ts:139-149` | Step 5 = 假动作 | "全流程自动执行" 名存实亡 |
| 3 | **无"用户确认"代码级守卫** | `src/prompts/activity-planner.ts:24, 31, 38` | 5 步工作流可被 LLM 跳过 | LLM 可能 1 个 turn 调完所有工具，破坏"用户决策权" |
| 4 | **工具无错误处理** | 全部 6 个工具的 `execute()` | 任何异常都冒泡到 LLM | 容错性 = 0，PRD 第 5 条核心原则违反 |

### 4.2 P1：影响体验和扩展性

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 5 | **无用户偏好记忆** | 全局 | 每次对话从零开始，"个性化推荐"无法实现 |
| 6 | **时长无硬约束** | prompt 仅建议 | 可能推荐 30 分钟或 10 小时的方案 |
| 7 | **预算无硬约束** | prompt 提及 | 可能超预算 2 倍 |
| 8 | **无结构化输出校验** | Step 4 | LLM 输出是 markdown，前端解析脆弱 |
| 9 | **无地理位置校验** | Step 2-4 | 通勤时间"考虑"= LLM 自由发挥 |

### 4.3 P2：优化项

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 10 | **5 步串行拖慢响应** | `src/prompts/activity-planner.ts` | 5 次 LLM 调用 = ~50-100s，违反 30s 目标 |
| 11 | **无 metric 埋点** | 全局 | 无法量化"30s 完成率"、"确认率" |
| 12 | **无 A/B 测试钩子** | 全局 | 灵活性原则只能"靠 prompt 改字" |
| 13 | **plan_save 无持久化** | `src/tools/activity-tools.ts:158-162` | 方案"保存"了但下次加载 = 空数组 |

---

## 五、关键问题的根本原因分析

### 5.1 为什么"工具"只做记录不做数据获取？

**设计哲学**（AGENTS.md 已明确）：

> **"Tools are 'recording' tools - LLM does all reasoning, tools only persist results"**

**这个设计选择的优点**：
- 简单：6 个工具总计 175 行代码
- 灵活：所有"数据"通过 prompt 注入到 LLM 上下文，LLM 自由发挥
- 成本低：不需要外部 API key、不需要付费数据源

**这个设计选择的致命问题**：
- LLM 的预训练数据**永远过时**（最新到 2024 年或 2025 年初）
- LLM 的"推荐"是**统计平均**而不是"实时最优"
- 任何关闭/新增/价格变化的餐厅/活动，LLM 都不知道
- 这违背了 PRD 1.1 节"全品类休闲场景"的真实数据要求

**类比**：这等于让一个记忆力一般的旅游博主，根据 1 年前去过某城市的记忆，给你推荐当地餐厅。不是不能做，但用户不会买单。

### 5.2 为什么"用户确认"靠 prompt 而不是代码？

**当前实现的问题**：

`src/prompts/activity-planner.ts` 反复出现：

```
> 用户确认前，绝不要进入下一步。
```

这只是一段**自然语言指令**，依赖 LLM 的服从性。LLM 在以下情况会"违规"：

1. **长上下文压力**：当 prompt 累积到 10K+ token，LLM 可能"忘记"早期约束
2. **Temperature > 0**：随机性导致偶尔跳过步骤
3. **复杂的用户输入**：用户一次性说"帮我找餐厅预订 7 点"，LLM 倾向于一步到位
4. **弱模型（Haiku/Mini）**：理解/服从能力差

**正确做法**：应该是代码级状态机：

```typescript
// 伪代码
type PlanState =
  | { phase: 'awaiting_intent_confirm'; intent: Intent }
  | { phase: 'awaiting_activities_confirm'; intent: Intent; activities: Activity[] }
  | { phase: 'awaiting_plan_confirm'; plan: Plan }
  | { phase: 'executing'; orderId?: string };

async function handleUserMessage(state: PlanState, msg: string) {
  if (state.phase === 'awaiting_intent_confirm') {
    if (!isConfirmation(msg)) {
      // LLM 重新解析 intent
    }
    // 否则进入下一阶段
  }
  // ...
}
```

### 5.3 为什么没有 fallback/重试？

**当前所有工具的 execute() 都没有 try/catch**：

```typescript
execute: async (_id, params, ...) => {
  const result = { ... };
  return { content: [...], details: result };
}
```

任何异常直接抛到 AgentSession → SSE → 浏览器 500。**PRD 第 5 条核心原则「容错性：任何环节出现异常时，自动重试并提供备选方案，保证服务不中断」完全没有代码实现**。

---

## 六、优化空间（按优先级，3 档）

### 6.1 P0：必做（影响业务可行性）

#### 优化 1：引入真实数据源（替代 LLM 编造）

**问题**：Step 2-3 的所有推荐都是 LLM 编的。

**方案**：

| 层级 | 改造 |
|------|------|
| **数据源** | 接入大众点评/高德地图/小红书 API（Demo 阶段可用 mock 数据集） |
| **工具升级** | `activity_search` 改为**真正查询** POI 数据库（带 location 半径、category 过滤） |
| **Schema 升级** | 增加 `source: string`（数据来源）+ `availability: 'open' \| 'closed'` |
| **降级策略** | 如果 API 超时/失败，回退到 LLM 知识（而不是直接报错） |

**代码改造示例**：

```typescript
// src/tools/activity-tools.ts 改造后
{
  name: "activity_search",
  description: "搜索真实的活动 POI 数据。必传 location + category，可选 radius(米) + priceRange",
  parameters: Type.Object({
    location: Type.String({ description: "城市或区域, e.g. '北京三里屯'" }),
    category: Type.String({ description: "outdoor/cultural/shopping/entertainment" }),
    radius: Type.Optional(Type.Number({ description: "搜索半径(米), 默认 3000" })),
    maxResults: Type.Optional(Type.Number({ description: "最多返回 N 个, 默认 5" })),
  }),
  execute: async (params) => {
    try {
      // 1. 真实 API 查询
      const pois = await fetchPOIsFromDB(params.location, params.category, params.radius);
      // 2. 格式化返回
      return { content: [{ type: "text", text: JSON.stringify(pois) }], details: pois };
    } catch (e) {
      // 3. 降级到 LLM 知识
      return await fallbackToLLMKnowledge(params);
    }
  },
}
```

**工作量**：~3-5 天（含数据源对接、schema 设计、测试）

#### 优化 2：reservation_exec 真实化

**问题**：预订完全 mock。

**方案**：

| 阶段 | 方案 |
|------|------|
| **Demo 阶段** | 写一个 mock 预订服务，存到本地 SQLite，模拟完整订单生命周期（pending → confirmed → notified） |
| **Pre-prod 阶段** | 接入真实预订 API（大众点评/口碑），但仍是 mock 支付 |
| **Prod 阶段** | 接入真实支付（需 ICP + 牌照） |

**关键**：

```typescript
// 至少应该有"模拟订单生命周期"的能力
{
  name: "reservation_exec",
  execute: async (params) => {
    // 1. 写入数据库
    const order = await db.orders.create({
      status: 'pending',
      ...params,
      createdAt: new Date(),
    });
    // 2. 模拟异步处理（90% 成功率）
    setTimeout(async () => {
      const success = Math.random() > 0.1;  // 模拟 10% 失败率
      await db.orders.update(order.id, {
        status: success ? 'confirmed' : 'failed',
        confirmedAt: success ? new Date() : null,
      });
      // 3. 触发通知
      await sendNotification(order.userId, `预订${success ? '成功' : '失败'}`);
    }, 1500);
    return { orderId: order.id, status: 'pending' };
  },
}
```

**工作量**：~5-7 天（含数据库、状态机、通知 mock）

#### 优化 3：状态机化的"用户确认"机制

**问题**：5 步工作流靠 prompt 文字约束，违反 PRD 第 1 条核心原则（用户中心）。

**方案**：

```typescript
// 新增 src/lib/plan-state.ts
export type PlanState =
  | { phase: 'intent_understanding'; userInput: string }
  | { phase: 'intent_confirm'; intent: IntentRecordParams }
  | { phase: 'activity_searching'; intent: IntentRecordParams }
  | { phase: 'activity_confirm'; intent: IntentRecordParams; activities: ActivityRecordParams }
  | { phase: 'restaurant_searching'; intent: IntentRecordParams; activities: ActivityRecordParams }
  | { phase: 'restaurant_confirm'; intent: IntentRecordParams; activities: ActivityRecordParams; restaurants: RestaurantRecordParams }
  | { phase: 'plan_generating'; ... }
  | { phase: 'plan_confirm'; plan: Plan; needsExecution: boolean }
  | { phase: 'executing'; plan: Plan; orderId?: string }
  | { phase: 'completed'; plan: Plan; orderId: string };

// 在 RPCManager 层强制 phase 转换
async function handleUserInput(state: PlanState, input: string): Promise<PlanState> {
  switch (state.phase) {
    case 'intent_confirm':
      if (isConfirmation(input)) {
        return { phase: 'activity_searching', intent: state.intent };
      } else {
        // 重新解析意图
        const newIntent = await reparseIntent(input, state.intent);
        return { phase: 'intent_confirm', intent: newIntent };
      }
    // ...
  }
}
```

**业务价值**：
- ✅ 用户每一步决策都有明确 UI 提示
- ✅ 撤销/修改方案是确定性操作
- ✅ LLM 无法"跳过"步骤
- ✅ 用户可以查看历史决策

**工作量**：~7-10 天（核心状态机 + UI 集成 + 测试）

#### 优化 4：工具层 try/catch + 降级 + 重试

**问题**：所有工具无错误处理，违反 PRD 容错性原则。

**方案**：

```typescript
// 新增 src/lib/tool-wrapper.ts
export function wrapToolWithRetry(tool: ToolDefinition, opts: { maxRetries: 3, backoff: 'exponential' }): ToolDefinition {
  return {
    ...tool,
    execute: async (id, params, signal, onUpdate, ctx) => {
      let lastError: Error | undefined;
      for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
        try {
          return await tool.execute(id, params, signal, onUpdate, ctx);
        } catch (e) {
          lastError = e as Error;
          if (attempt < opts.maxRetries - 1) {
            await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
          }
        }
      }
      // 所有重试都失败 → 降级到 LLM 知识
      return await fallbackToLLMKnowledge(tool.name, params, lastError);
    },
  };
}
```

**工作量**：~2-3 天

### 6.2 P1：建议做（影响体验和扩展性）

#### 优化 5：用户偏好记忆

**方案**：

```typescript
// 新增 src/lib/user-profile.ts
export interface UserProfile {
  id: string;
  preferences: {
    cuisines: string[];              // ['川菜', '日料']
    priceRange: { min: number; max: number };
    avoidList: string[];              // ['密室逃脱'] （不喜欢）
    groupType: 'single' | 'couple' | 'family' | 'friends';
    frequentLocations: string[];      // ['北京朝阳', '上海静安']
  };
  history: {
    sessionId: string;
    intent: IntentRecordParams;
    finalPlan: Plan;
    rating?: number;                  // 1-5 星
    timestamp: Date;
  }[];
}

// 在 Step 1 之后注入到 context
// 在 Step 5 之后请求 1-5 星评分
```

**工作量**：~3-5 天

#### 优化 6：硬性约束（4-6 小时、预算等）

**方案**：

```typescript
// 新增 src/lib/constraints.ts
export const BUSINESS_CONSTRAINTS = {
  goldenHours: { min: 4, max: 6 },
  fullDay: { min: 6, max: 12 },
  budgetTolerance: 0.2,  // 允许 ±20% 超预算
  geoRadius: { min: 1000, max: 30000 },  // 1-30 公里
};

// 在工具 execute 中校验
execute: async (params) => {
  const totalDuration = sumDuration(params.activities);
  if (totalDuration < 4 || totalDuration > 6) {
    // 自动调整方案
    return await adjustToConstraints(params);
  }
}
```

**工作量**：~3 天

#### 优化 7：结构化输出（JSON Schema 强制）

**方案**：使用 LLM 的 `response_format: { type: 'json_schema' }` 能力，强制 Step 4 输出 JSON。

```typescript
const planSchema = {
  type: 'object',
  required: ['timeSlots', 'totalCost', 'totalDuration'],
  properties: {
    timeSlots: { type: 'array', items: { /* ... */ } },
    totalCost: { type: 'number' },
    totalDuration: { type: 'number' },
  },
};
```

**工作量**：~2 天

### 6.3 P2：锦上添花

| 优化 | 工作量 | 业务价值 |
|------|-------|---------|
| 5 步 → 2-3 步（并行 LLM 调用） | 5 天 | 响应时间 50s → 15s |
| Metric 埋点（响应时间/确认率/完成率） | 2 天 | 量化运营 |
| A/B 测试 prompt 框架 | 3 天 | 持续优化 |
| plan_save 真实持久化 | 1 天 | 加载历史方案 |
| 多语言（英文/粤语） | 3 天 | 拓展市场 |

---

## 七、重构建议：最小可行版本（MVP）

如果资源有限，建议按以下顺序推进：

### Week 1：核心业务闭环（PRD 1.2 核心目标）

- **Day 1-2**：优化 1（数据源 mock）— 用本地 SQLite + 100 条模拟 POI 数据
- **Day 3-4**：优化 2（预订 mock 但有状态）— SQLite + 状态机
- **Day 5**：优化 4（工具重试）— 复用工具 wrapper

**Week 1 交付**：能演示"输入 → 推荐 → 确认 → 预订 → 看到订单状态"

### Week 2：状态机和体验

- **Day 6-8**：优化 3（状态机化确认）— PlanState + UI 提示
- **Day 9-10**：优化 5（用户记忆）— 简化版 profile

**Week 2 交付**：能演示"用户能看到自己在哪一步、能撤销、能重选"

### Week 3：优化和监控

- 优化 6（约束校验）
- 优化 7（结构化输出）
- Metric 埋点

---

## 八、风险与决策点

### 8.1 决策点 1：数据源选择

| 选项 | 成本 | 数据质量 | 合规风险 |
|------|------|---------|---------|
| 大众点评 API | ¥ | 高 | 中（需商业授权） |
| 高德地图 POI | ¥¥ | 高 | 低（已商用） |
| 自建 POI 数据库 | ¥¥¥ | 取决于采集 | 低 |
| LLM 知识（现状） | 免费 | 低 | 无 |
| Mock 数据集 | 免费 | 演示级 | 无 |

**建议**：Demo 阶段用 mock，生产阶段用高德 + 大众点评组合。

### 8.2 决策点 2：是否要状态机

**正方**：
- 符合 PRD 第 1 条核心原则（用户中心）
- 业务可控
- 撤销/重做简单

**反方**：
- 增加开发复杂度
- 限制 LLM 灵活性（PRD 第 3 条原则是灵活性）

**建议**：**采用软状态机** — 用 prompt 引导 + 代码兜底。如果 LLM 跳过步骤，自动回滚到上一步并提示用户。

### 8.3 决策点 3：是否要"用户偏好记忆"

**正方**：
- 提升推荐质量
- 减少重复输入

**反方**：
- 隐私风险
- 增加数据库依赖

**建议**：**做简化的 session-level 记忆** — 同一会话内记忆，跨会话清空（除非用户主动保存）。

---

## 九、关键文件改造优先级

| 文件 | 当前状态 | 改造内容 | 优先级 |
|------|---------|---------|--------|
| `src/tools/activity-tools.ts` | 6 个 recording tools | 改为真实数据源查询 | 🔴 P0 |
| `src/tools/activity-tools.ts` (reservation_exec) | 假订单号 | 接入 mock 订单服务 | 🔴 P0 |
| `src/tools/activity-tools.ts` (execute 函数) | 无 try/catch | 包装重试 + 降级 | 🔴 P0 |
| `src/prompts/activity-planner.ts` | 文字约束确认 | 配合状态机软化 | 🟡 P1 |
| `lib/rpc-manager.ts` | 无状态机 | 新增 PlanState 强制 | 🟡 P1 |
| `lib/agent-client.ts` | 简单封装 | 集成状态机事件 | 🟡 P1 |
| 新增 `lib/plan-state.ts` | — | 状态机定义 | 🟡 P1 |
| 新增 `lib/user-profile.ts` | — | 用户记忆 | 🟡 P1 |
| 新增 `lib/constraints.ts` | — | 业务硬约束 | 🟡 P1 |
| 新增 `lib/tool-wrapper.ts` | — | 工具重试包装 | 🔴 P0 |
| `components/ChatWindow.tsx` | 简单展示 | 状态机驱动 UI | 🟡 P1 |

---

## 十、结论

**当前 activity-agent 处于"骨架完整、血肉未填"的状态**：

- ✅ 整体架构合理（Next.js + pi-coding-agent + customTools）
- ✅ 5 步工作流的设计哲学正确
- ✅ 中文 prompt + 工具描述清晰
- ❌ 数据真实性 = 0
- ❌ 执行能力 = mock
- ❌ 容错性 = 0
- ❌ 用户控制 = 软约束

**建议的工程化路径**：
1. **第一阶段（1 周）**：补齐 4 个 P0 优化（数据源、预订 mock、状态机、工具重试）
2. **第二阶段（1 周）**：补齐 3 个 P1 优化（约束、记忆、结构化输出）
3. **第三阶段（持续）**：性能优化、Metric、A/B

**预期效果**：完成 P0+P1 后，PRD 核心目标达成度从 35% 提升到 85%+。

---

**报告完。**
**关联文档**：
- [INTEGRATION_REPORT.md](./INTEGRATION_REPORT.md)（技术架构，约 950 行）
- [AGENTS.md](./AGENTS.md)（项目说明）
