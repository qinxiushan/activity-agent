# activity-agent 集成与技术分析报告

> **报告范围**：activity-agent（Next.js 15 + React 19 实现的 Pi Coding Agent Web 前端）与 `@earendil-works/pi-coding-agent@0.75.5` 的集成关系
>
> **报告时间**：2026-06-06
>
> **最后更新**：2026-06-07（删除 11 个 pi-web stub routes：auth/*、skills/*、models-config/test、sessions/new；见 commit b493687）
>
> **基线版本**：
> - `activity-agent`：本地 `package.json`（commit HEAD）
> - `pi-coding-agent`：**npm registry 0.75.5**（非本地源码；本地 monorepo 源码为 0.76.0，存在小幅 API 差异）
> - `pi-web`：参考对照实现
>
> **读者对象**：activity-agent 维护者、Pi Coding Agent 集成开发者、Code Review 人员

---

## 目录

1. [项目背景与核心结论](#1-项目背景与核心结论)
2. [第一部分：路由对齐工作（17 个文件差异处理）](#2-第一部分路由对齐工作17-个文件差异处理)
3. [第二部分：activity-agent 架构详解](#3-第二部分activity-agent-架构详解)
4. [第三部分：运行流程全图](#4-第三部分运行流程全图)
5. [第四部分：pi-coding-agent 核心能力清单](#5-第四部分pi-coding-agent-核心能力清单)
6. [第五部分：Extension 概念详解](#6-第五部分extension-概念详解)
7. [第六部分：Tool vs Extension 区别与选型](#7-第六部分tool-vs-extension-区别与选型)
8. [第七部分：完整流程的代码节点映射](#8-第七部分完整流程的代码节点映射)
9. [第八部分：activity-agent 的扩展点分析](#9-第八部分activity-agent-的扩展点分析)
10. [第九部分：改进建议](#10-第九部分改进建议)
11. [第十部分：行号参考速查表](#11-第十部分行号参考速查表)
12. [附录 A：术语表](#附录-a术语表)
13. [附录 B：完整路由清单](#附录-b完整路由清单)
14. [附录 C：状态同步日志（2026-06-06 SOP-v2）](#附录-c状态同步日志2026-06-06-sop-v2)

---

## 1. 项目背景与核心结论

### 1.1 项目背景

**activity-agent** 是一个基于 Next.js 15（App Router）+ React 19 实现的 Pi Coding Agent 的 **Web 前端**。它的目标是把 pi-coding-agent 这个原本基于 TUI（终端 UI）+ JSON-RPC stdio 的 AI 编程助手，包装成可以在浏览器里使用的形态。

- **pi-coding-agent**：核心运行时，提供 AgentSession、SessionManager、ModelRegistry、AuthStorage 等基础设施
- **activity-agent**：Web 适配层，提供 UI、会话管理、SSE 流式协议、用户配置
- **pi-web**：原始参考实现，与 activity-agent 同源但功能更全

### 1.2 核心结论（TL;DR）

| 维度 | 结论 |
|------|------|
| **activity-agent 是不是 pi-coding-agent 的 Extension** | ❌ 不是。它没有用 Extension 系统 |
| **activity-agent 用 pi-coding-agent 的方式** | 通过 `createAgentSession({ customTools, resourceLoader })` 工厂方法直接构造 AgentSession |
| **activity-agent 做了哪些定制** | 3 个核心扩展点：①**12 个**活动规划 `customTools` 注入（SOP-v2） ②自定义 `ResourceLoader` 包装注入中文系统 prompt ③Map+ SSE 桥接实现多 session 并发 |
| **activity-agent 没用哪些能力** | Extension 系统、`registerCommand`、TUI UI 钩子（widget/footer/status）、shortcut、`navigateTree`、`compact`、`steer`/`followUp`（API 暴露但前端未接） |
| **可改进空间** | 3 个高优先级 + 5 个中优先级（见第 10 节） |

### 1.3 报告读者可能想知道的"一句话回答"

1. **Extension 是什么？** 一个动态加载的 TS 模块，可以订阅 25+ 生命周期事件、注册工具/命令/快捷键、定制 TUI UI。
2. **Tool 和 Extension 的区别？** Tool 是 LLM 可调用的单个函数（4 个字段）；Extension 是完整插件容器（5 大类 API）。
3. **pi-coding-agent 核心能力？** 3 层：基础设施（SessionManager / ModelRegistry / AuthStorage / ResourceLoader）+ 运行时（AgentSession / createAgentSession / compact / navigateTree / streaming）+ 扩展（内置 7 工具 + customTools + Extension + RPC/Print/JSON 模式）。
4. **activity-agent 是扩展还是照搬？** 三处定制（customTools / ResourceLoader / SSE 桥），其余照搬。

---

## 2. 第一部分：路由对齐工作（17 个文件差异处理）

### 2.1 工作背景

activity-agent 和 pi-web 同源但发展不同步。pi-web 中存在 17 个文件，activity-agent 中缺失或不一致。本次工作的目标是**让 activity-agent 在 TypeScript 编译、运行时 API、UI 引用三个层面与 pi-web 对齐**。

### 2.2 差异清单与处理策略

#### 2.2.1 缺失的 API 路由（11 个）— 已补齐

| # | 路径（activity-agent/app/api/...） | 用途 | 处理方式 |
|---|-----------------------------------|------|----------|
| 1 | `skills/search/route.ts` | 搜索已安装的 skills | 桩实现：501 + 空列表 |
| 2 | `skills/route.ts` | 列出所有 skills | 桩实现：501 + 空列表 |
| 3 | `skills/install/route.ts` | 安装新 skill | 桩实现：501 + 错误消息 |
| 4 | `auth/providers/route.ts` | 已配置 provider 列表 | 桩实现：501 + 空列表 |
| 5 | `auth/all-providers/route.ts` | 所有支持的 provider | 桩实现：501 + 空列表 |
| 6 | `auth/login/[provider]/route.ts` | OAuth 登录入口 | 桩实现：501 + 错误消息 |
| 7 | `auth/logout/[provider]/route.ts` | 登出 | 桩实现：501 + 错误消息 |
| 8 | `auth/api-key/[provider]/route.ts` | API key 认证 | 桩实现：501 + 错误消息 |
| 9 | `default-cwd/route.ts` | 默认工作目录查询 | **完整实现**：返回 `process.cwd()` |
| 10 | `models-config/test/route.ts` | 测试模型连接 | 桩实现：501 + 错误消息 |
| 11 | `sessions/new/route.ts` | 新建会话入口 | **410 Gone**：明确告知"通过 /chat 端点" |

#### 2.2.2 关键的 TypeScript 类型导出

`app/api/skills/search/route.ts` 不仅是个桩文件，它还 **export 了 `SkillSearchResult` 接口**：

```typescript
// activity-agent/app/api/skills/search/route.ts
export interface SkillSearchResult {
  name: string;
  description?: string;
  source?: string;
  installed?: boolean;
}

export async function GET() {
  return Response.json({ results: [] }, { status: 501 });
}
```

**为什么这很关键**：`components/SkillsConfig.tsx` 等前端组件直接 import 这个类型。如果删除或简化此文件，TypeScript 编译会失败。

#### 2.2.3 完整实现 vs 桩实现的判断标准

- **完整实现**（`default-cwd`）：逻辑极简（< 10 行）且不依赖 pi-coding-agent 内部 API
- **410 Gone**（`sessions/new`）：明确表达"接口已迁移"语义
- **501 Not Implemented**（其余 9 个）：表达"接口存在但后端未实现"，前端可以显示"功能开发中"

### 2.3 验证记录

| 验证项 | 工具 | 结果 |
|--------|------|------|
| TypeScript 编译 | `npx tsc --noEmit` | ✅ 无错误（无输出） |
| 路由可达性 | `curl http://localhost:30142/api/...` | ✅ 11/11 路由返回正确状态码 |
| 类型导出正确 | `grep -r "SkillSearchResult" components/` | ✅ 所有引用解析成功 |

### 2.4 缺失的 UI 组件（6 个）— 本次未处理

pi-web 中有 6 个 UI 组件在 activity-agent 中缺失，**本次工作未涉及**：

- `components/SkillsConfig.tsx`（部分）
- `components/ModelsConfig.tsx`（部分）
- `components/ProviderConfig.tsx`
- `components/AuthStatus.tsx`
- `components/ApiKeyForm.tsx`
- `components/SkillCard.tsx`

这些组件的引用通过"已补齐的路由类型导出"暂时满足了编译要求，但运行时点击相关 UI 会显示空状态或错误。**建议在后续工作中按需补齐**。

---

## 3. 第二部分：activity-agent 架构详解

### 3.1 整体架构（4 层）

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 1: Browser (React 19 SPA)                                    │
│   - components/* (UI 组件)                                          │
│   - hooks/* (React Hooks)                                          │
│   - app/*/page.tsx (Next.js 页面)                                  │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ HTTP / SSE
┌──────────────────────────▼──────────────────────────────────────────┐
│ Layer 2: Next.js Server (App Router)                                │
│   - app/api/**/route.ts (API 路由)                                  │
│   - app/api/agent/* (agent 操作端点)                                 │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ 函数调用
┌──────────────────────────▼──────────────────────────────────────────┐
│ Layer 3: lib/ (业务逻辑层)                                            │
│   - lib/rpc-manager.ts (RPCManager: 多 session 状态机)                 │
│   - lib/plan-state.ts (PlanStateManager: 8 阶段 SOP-v2 状态机)       │
│   - lib/tool-wrapper.ts (tool retry/timeout/metrics 包装)             │
│   - lib/poi-database.ts (34 POI: 22 活动 + 12 餐厅)                 │
│   - lib/weather-service.ts / lib/route-service.ts /                │
│     lib/opening-hours-service.ts (deterministic mock 数据)          │
│   - lib/booking-service.ts (真实预订状态机)                          │
│   - lib/agent-client.ts (agent 客户端封装)                            │
│   - lib/pi-types.ts (TypeScript 类型桥接)                            │
│   - lib/session-reader.ts (会话读取)                                  │
│   - lib/file-paths.ts (路径工具)                                     │
│   - lib/normalize.ts (数据规范化)                                     │
└──────────────────────────┬──────────────────────────────────────────┘
                            │ npm package
┌──────────────────────────▼──────────────────────────────────────────┐
│ Layer 4: @earendil-works/pi-coding-agent 0.75.5                     │
│   - core/agent-session.ts (AgentSession ~3096 行)                  │
│   - core/sdk.ts (createAgentSession 工厂)                          │
│   - core/session-manager.ts (SessionManager)                       │
│   - core/model-registry.ts (ModelRegistry)                         │
│   - core/auth-storage.ts (AuthStorage)                             │
│   - core/resource-loader.ts (DefaultResourceLoader)                │
│   - core/extensions/* (Extension 系统)                              │
│   - @mariozechner/pi-ai (LLM 客户端)                                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 关键模块详细说明

#### 3.2.1 `lib/rpc-manager.ts` — 多 session 状态机（核心）

**位置**：`activity-agent/lib/rpc-manager.ts`

**职责**：
- 维护 `Map<sessionId, AgentSessionLike>` 实例池
- 处理 session 生命周期：create / open / list / delete / fork
- 把 AgentSession 事件流（`AgentSessionEvent`）转译为 SSE 推送给浏览器
- 注入中文 system prompt + 活动规划规则

**关键数据流**：
```
HTTP request → RPCManager.sendMessage(sessionId, text)
           → session.subscribe((event) => forwardToSSE(event))
           → session.prompt(text)
           → AgentSession.runTurn() (异步)
           → events flow back via EventBus
           → SSE forward to Express Response
```

#### 3.2.2 `lib/pi-types.ts` — 类型桥接层

**位置**：`activity-agent/lib/pi-types.ts`

**职责**：定义 `AgentSessionLike` 接口，匹配 `AgentSession` 类的公共方法签名，让 activity-agent 不需要直接 import `AgentSession` 类（降低耦合）。

```typescript
export interface AgentSessionLike {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: PromptOptions): Promise<void>;
  abort(): void;
  setModel(model: Model): void;
  setThinkingLevel(level: ThinkingLevel): void;
  getAllTools(): ToolInfo[];
  // ... ~20 个方法
}
```

**为什么需要这个**：activity-agent 用 loose typing 而非直接 import class，便于：
1. 在测试中 mock
2. 避免包版本升级时的类型不兼容
3. 支持 pi-coding-agent 的 `.d.ts` 演化

#### 3.2.3 `lib/agent-client.ts` — 单 session 客户端封装

**位置**：`activity-agent/lib/agent-client.ts`

**职责**：封装单个 AgentSession 的所有操作，向上层（API route）提供简单的函数式 API（`sendMessage`、`abort`、`setModel` 等）。

#### 3.2.4 `src/tools/activity-tools.ts` — 12 个活动规划工具（SOP-v2）

**位置**：`activity-agent/src/tools/activity-tools.ts`（718 行）

**职责**：定义 **12 个**自定义工具（SOP-v2 升级后从 6 个扩展），按 4 个 phase 分组：

| # | 工具名 | 所属 phase | 用途 |
|---|--------|-----------|------|
| 1 | `intent_parse` | `intent_capture` | 记录结构化意图 **或** 提交最终方案（`submitPlan: true`） |
| 2 | `ask_clarification` | `intent_capture` | 1-shot 追问（`MAX_CLARIFICATIONS=1` 硬限） |
| 3 | `get_weather` | `planning` | 真实天气查询（deterministic mock） |
| 4 | `search_activities` | `planning` | 活动 POI 查询（22 条真实 POI） |
| 5 | `search_restaurants` | `planning` | 餐厅 POI 查询（12 条真实 POI） |
| 6 | `check_opening_hours` | `planning` | 营业时间校验 |
| 7 | `compute_route` | `planning` | 通勤时间（步行/公交/驾车，Haversine） |
| 8 | `reservation_exec` | `executing` | 真实预订状态机（pending → confirmed/failed） |
| 9 | `query_booking` | `executing` | 查询订单状态 |
| 10 | `retry_booking` | `executing` | 重试失败订单 |
| 11 | `plan_save` | persist | 保存最终方案到 plan-state 文件 |
| 12 | `plan_load` | persist | 加载历史方案 |

**注入方式**：作为 `customTools` 数组传给 `createAgentSession()`（`lib/rpc-manager.ts:366-371`）。

**Phase 守卫**：每个工具的 `execute` 被 `guardToolCallWithActive` 包装（`lib/plan-state.ts:291`），跨 phase 调用返回 `PHASE_GUARD` 错误。例如 `reservation_exec` 只允许在 `executing` phase，`intent_parse(submitPlan:true)` 只允许在 `planning`。

### 3.3 数据流：从用户发消息到屏幕更新

```
User types in <ChatInput />
         │
         ▼
fetch('/api/agent/sessions/:id/messages', { method: 'POST', body: { text } })
         │
         ▼
Next.js Route Handler (app/api/agent/sessions/[id]/messages/route.ts)
         │
         ▼
RPCManager.sendMessage(sessionId, text)
         │
         ├─ session.prompt(text)  ─────► AgentSession.prompt()
         │                                    │
         │                                    ▼
         │                            AgentSession.runTurn()
         │                                    │
         │                                    ▼
         │                            streamSimple() (LLM streaming)
         │                                    │
         │                                    ▼
         │                            tool.execute() (if tool_call)
         │                                    │
         │                                    ▼
         │                            events emitted
         │                                    │
         │  subscribe callback  ◄────────────┘
         │
         ▼
SSE forward: response.write(`data: ${JSON.stringify(event)}\n\n`)
         │
         ▼
Browser EventSource receives SSE chunk
         │
         ▼
React state update → re-render <ChatMessages />
```

---

## 4. 第三部分：运行流程全图

### 4.1 启动流程（应用冷启动）

```
1. Next.js boot
   └─> 加载所有 lib/* 模块（RPCManager 单例）

2. 首次 HTTP 请求触发
   └─> 加载 @earendil-works/pi-coding-agent
       └─> 加载 DefaultResourceLoader
           └─> 扫描 ~/.pi/agent/extensions/ (Extension 系统)
           └─> 加载 system prompt 模板
       └─> 加载 ModelRegistry
           └─> 解析 ~/.pi/agent/models.json (模型配置)

3. 第一次用户访问首页
   └─> 浏览器加载 components + hooks
   └─> 浏览器建立 EventSource 到 /api/agent/events
   └─> 准备就绪
```

### 4.2 新建会话流程

```
1. 用户点击"New Session"按钮
   └─> 浏览器 POST /api/agent/sessions
       └─> RPCManager.createSession()
           ├─> const id = generateUuid()
           ├─> const { session } = await createAgentSession({
           │       cwd: process.cwd(),
           │       model: modelRegistry.getDefaultModel(),
           │       customTools: [...ACTIVITY_TOOLS],
           │       resourceLoader: createResourceLoader(cwd),
           │   })
           ├─> this.sessions.set(id, session)
           └─> return { sessionId: id }

2. 浏览器跳转 /sessions/:id
   └─> 浏览器 EventSource 重新建立到 /api/agent/sessions/:id/events
       └─> 浏览器加载历史消息（GET /api/agent/sessions/:id/messages）
```

### 4.3 发送消息流程

```
1. 用户输入文本 → 点击"发送"
   └─> 浏览器 POST /api/agent/sessions/:id/messages
       body: { text: "..." }

2. Route Handler 收到请求
   └─> const session = rpcManager.get(id)
   └─> const cleanup = session.subscribe((event) => {
           // 把 event 写进 SSE 流
           controller.enqueue(`data: ${JSON.stringify(event)}\n\n`)
       })
   └─> await session.prompt(text)
   └─> cleanup()  // 关闭 SSE

3. AgentSession.prompt(text) (pi/core/agent-session.ts:962)
   └─> append user entry to SessionManager (.jsonl)
   └─> buildContext()  // 收集 system prompt + 历史消息 + 工具列表
   └─> runTurn()
       └─> streamSimple()  // 调用 LLM
           └─> if tool_call: tool.execute() → 追加 tool_result → 继续流
           └─> if finish: append assistant message → emit turn_end

4. events 通过 subscribe 推回 → SSE → 浏览器
```

### 4.4 Fork 会话流程

```
1. 用户在某个 entry 点击"分支"
   └─> 浏览器 POST /api/agent/sessions/:id/fork
       body: { entryId: "..." }

2. RPCManager.forkSession(id, entryId)
   └─> const oldSession = this.sessions.get(id)
   └─> const newId = generateUuid()
   └─> await oldSession.forkTo(newId, entryId)
       // 内部调用 SessionManager.createBranchedSession()
   └─> const newSession = await this._openSession(newId, ...)
   └─> this.sessions.set(newId, newSession)
   └─> return { sessionId: newId }

3. 浏览器跳转 /sessions/:newId
```

### 4.5 删除会话流程

```
1. 用户点击"删除"按钮
   └─> 浏览器 DELETE /api/agent/sessions/:id

2. RPCManager.deleteSession(id)
   └─> const session = this.sessions.get(id)
   └─> await session.shutdown()  // 关闭 agent
   └─> await fs.unlink(session.getSessionFile())  // 删除 .jsonl
   └─> this.sessions.delete(id)
   └─> return 204
```

---

## 5. 第四部分：pi-coding-agent 核心能力清单

### 5.1 三层能力模型

```
┌────────────────────────────────────────────────────────────────┐
│ 扩展层 (Extension Layer)                                        │
│   - 7 个内置工具 (read/write/edit/bash/grep/find/ls)             │
│   - customTools 注入点                                         │
│   - Extension 插件系统 (jiti)                                   │
│   - RPC / Print / JSON 模式                                    │
└────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────┐
│ 运行时层 (Runtime Layer)                                       │
│   - AgentSession (~3096 行状态机)                                │
│   - createAgentSession 工厂                                     │
│   - compaction (上下文压缩)                                      │
│   - branching / navigateTree (会话树)                            │
│   - streaming events (AgentSessionEvent union)                 │
└────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────┐
│ 基础设施层 (Infrastructure Layer)                                │
│   - SessionManager (.jsonl 持久化)                               │
│   - ModelRegistry (模型注册表)                                   │
│   - AuthStorage (API key 存储)                                  │
│   - SettingsManager (用户偏好)                                   │
│   - DefaultResourceLoader (资源加载器)                            │
│   - EventBus (事件总线)                                         │
└────────────────────────────────────────────────────────────────┘
```

### 5.2 基础设施层详解

#### 5.2.1 `SessionManager`（`core/session-manager.ts`）

**职责**：管理 `.jsonl` 会话文件的增删改查。

**关键方法**：

| 方法 | 位置 | 职责 |
|------|------|------|
| `create(cwd, name?)` | session-manager.ts | 创建新会话文件 |
| `open(file)` | session-manager.ts | 加载已存在的会话 |
| `listAll()` | session-manager.ts | 列出所有会话（按修改时间排序） |
| `getEntries()` | session-manager.ts | 读取所有 entry（user/assistant/tool） |
| `getTree()` | session-manager.ts | 重建会话树（处理 parent/branch 关系） |
| `getLeafId()` | session-manager.ts | 获取当前活跃叶子节点 |
| `appendEntry(entry)` | session-manager.ts | 增量写入 .jsonl |
| `createBranchedSession(fromId)` | session-manager.ts | Fork 当前会话到新 ID |
| `getSessionFile()` | session-manager.ts | 返回文件路径 |
| `isPersisted()` | session-manager.ts | 是否已写入磁盘 |

#### 5.2.2 `ModelRegistry`（`core/model-registry.ts`）

**职责**：模型 ID 解析与获取。

**关键方法**：

| 方法 | 职责 |
|------|------|
| `getModel(id: string)` | 解析 "provider/model" 格式 |
| `getDefaultModel()` | 从 settings 读取默认模型 |
| `listAvailable()` | 列出所有可用模型 |

#### 5.2.3 `AuthStorage`（`core/auth-storage.ts`）

**职责**：API key 持久化。

**存储位置**：`~/.pi/agent/auth.json`（权限 0600）

**关键方法**：
- `getApiKey(provider)` / `setApiKey(provider, key)`
- `getOAuthToken(provider)` / `setOAuthToken(provider, token)`

#### 5.2.4 `DefaultResourceLoader`（`core/resource-loader.ts`）

**职责**：加载系统 prompt、skills、extensions、themes。

**关键方法**：
- `getSystemPrompt()` → 完整系统 prompt
- `getAppendSystemPrompt()` → 追加的 prompt
- `loadExtensions()` → 通过 jiti 加载 `~/.pi/agent/extensions/`

### 5.3 运行时层详解

#### 5.3.1 `AgentSession`（`core/agent-session.ts`，~3096 行）

**职责**：状态机 + 事件流 + LLM 循环。

**关键方法**（按使用频率排序）：

| 方法 | 行号 | 职责 |
|------|------|------|
| `subscribe(listener)` | 673 | 订阅事件流 |
| `getActiveToolNames()` | 757 | 当前激活的工具名 |
| `setActiveToolsByName(names)` | 783 | 启用/禁用工具 |
| `getAllTools()` | 764 | 所有可用工具（含内置 + customTools） |
| `prompt(text)` | 962 | 发送用户消息 |
| `abort()` | - | 中断当前 turn |
| `setThinkingLevel(level)` | 1510 | 设置思考级别 |
| `compact()` | 1611 | 上下文压缩 |
| `getContextUsage()` | 2929 | 当前 token 用量 |

#### 5.3.2 `createAgentSession`（`core/sdk.ts:202`）

**签名**：

```typescript
async function createAgentSession(options?: CreateAgentSessionOptions): Promise<{
  session: AgentSession;
  modelRegistry: ModelRegistry;
  authStorage: AuthStorage;
}>
```

**关键 options**：

| 字段 | 必需 | 用途 |
|------|------|------|
| `cwd` | ✅ | 当前工作目录 |
| `model` | ✅ | 默认模型 |
| `customTools` | ❌ | 注入的额外工具 |
| `resourceLoader` | ❌ | 自定义资源加载器 |
| `agentDir` | ❌ | Agent 数据目录（默认 `~/.pi/agent`） |
| `sessionDir` | ❌ | 会话目录（默认 `~/.pi/agent/sessions`） |
| `authStorage` | ❌ | 注入认证 |
| `settingsManager` | ❌ | 注入设置 |

### 5.4 扩展层详解

#### 5.4.1 7 个内置工具（`core/tools/*.ts`）

| 工具 | 文件 | 用途 |
|------|------|------|
| `read` | tools/read.ts | 读文件 |
| `write` | tools/write.ts | 写文件 |
| `edit` | tools/edit.ts | 编辑文件（diff） |
| `bash` | tools/bash.ts | 执行 shell 命令 |
| `grep` | tools/grep.ts | 文本搜索 |
| `find` | tools/find.ts | 文件查找 |
| `ls` | tools/ls.ts | 目录列表 |

#### 5.4.2 customTools 注入

```typescript
const myTool: ToolDefinition = {
  name: "my_tool",
  description: "...",
  parameters: Type.Object({ foo: Type.String() }),
  execute: async (args, ctx) => "result",
};

const { session } = await createAgentSession({
  customTools: [myTool],
  // ...
});
```

**注意**：`customTools` 会在 `getAllTools()` 中与内置工具合并。

#### 5.4.3 Extension 系统（`core/extensions/*`）

**入口**：`DefaultResourceLoader.loadExtensions()` 扫描 `~/.pi/agent/extensions/`

**文件**：
- `core/extensions/loader.ts`（jiti loader）
- `core/extensions/runner.ts`（ExtensionRunner 类）
- `core/extensions/types.ts`（`ExtensionAPI` 接口，第 1084 行）
- `core/extensions/wrapper.ts`（错误隔离）

**加载流程**（详见第 6 节）。

#### 5.4.4 顶层入口（`modes/*.ts`）

| 入口 | 用途 | activity-agent 用法 |
|------|------|-------------------|
| `interactiveMode()` | TUI 交互式 | ❌ |
| `runRpc({ mode: "rpc" })` | JSON-RPC over stdio | ❌ |
| `runRpc({ mode: "print" })` | 一次性 prompt | ❌ |
| `runRpc({ mode: "json" })` | 结构化 JSON 输出 | ❌ |
| `createAgentSession()` | SDK 工厂 | ✅ **唯一入口** |

---

## 6. 第五部分：Extension 概念详解

### 6.1 什么是 Extension

**Extension（扩展）** 是 pi-coding-agent 提供的一种"插件"机制：一个独立的 TypeScript 文件，通过 jiti 在运行时被 `DefaultResourceLoader` 动态加载到 `AgentSession` 中，可以：

1. **订阅 25+ 生命周期事件**（`session_start`、`user_message`、`tool_call`、`agent_end` 等）
2. **注册工具**（`pi.registerTool`）
3. **注册命令**（`pi.registerCommand`）
4. **注册快捷键**（`pi.registerShortcut`）
5. **定制 TUI UI**（`pi.setStatus` / `pi.setWidget` / `pi.setFooter`）

### 6.2 Extension 的最小示例

```typescript
// ~/.pi/agent/extensions/hello.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 1. 订阅事件
  pi.on("session_start", async (event, ctx) => {
    pi.setStatus("Hello from extension!");
  });

  pi.on("user_message", async (event, ctx) => {
    console.log("User said:", event.content);
  });

  // 2. 注册工具
  pi.registerTool({
    name: "greet",
    description: "Say hello to someone",
    parameters: Type.Object({ name: Type.String() }),
    execute: async ({ name }, ctx) => `Hello, ${name}!`,
  });

  // 3. 注册命令
  pi.registerCommand("hello", {
    description: "Print hello message",
    handler: async (args, ctx) => {
      pi.sendMessage("Hello from command!");
    },
  });

  // 4. 注册快捷键
  pi.registerShortcut("ctrl+h", {
    description: "Show help",
    handler: async (ctx) => {
      pi.setWidget("HelpWidget", "Help content here");
    },
  });
}
```

### 6.3 加载机制详解

**步骤 1**：`DefaultResourceLoader` 扫描 `~/.pi/agent/extensions/`

```typescript
// core/resource-loader.ts:398
const extensionsResult = await loadExtensions(extensionPaths, this.cwd, this.eventBus);
```

**步骤 2**：`loadExtensions` 用 jiti 加载每个 `.ts` 文件

```typescript
// core/extensions/loader.ts
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(extensionPath);
const factory = mod.default;
```

**步骤 3**：调用 factory，传入 `ExtensionAPI`

```typescript
const extension: Extension = { factory, sourceInfo };
const api = createExtensionAPI(extension, eventBus);
await factory(api);
```

**步骤 4**：`ExtensionRunner` 接管所有 Extension

```typescript
// core/extensions/runner.ts
class ExtensionRunner {
  bindToSession(session: AgentSession) {
    // 把所有 extension 的 on() 监听接到 AgentSession 事件
  }
}
```

### 6.4 25+ 事件清单（部分）

| 事件 | 触发时机 | payload |
|------|----------|---------|
| `session_start` | 会话开始 | `{ sessionId, cwd }` |
| `session_resume` | 恢复会话 | `{ sessionId }` |
| `session_shutdown` | 会话结束 | `{ sessionId }` |
| `user_message` | 用户发消息 | `{ content }` |
| `turn_start` | LLM turn 开始 | - |
| `message_update` | LLM 流式输出 | `{ message, assistantMessageEvent }` |
| `turn_end` | LLM turn 结束 | `{ message, toolResults }` |
| `tool_call` | 工具被调用 | `{ toolName, args }` |
| `tool_result` | 工具返回结果 | `{ toolName, result, isError }` |
| `agent_end` | Agent 完全结束 | - |
| `model_select` | 模型切换 | `{ model }` |

### 6.5 activity-agent 为什么不用 Extension 系统

**原因分析**：

1. **TUI 概念不适用**：`setWidget` / `setFooter` / `setStatus` 是 TUI 概念，Web 不需要
2. **快捷键冲突**：`registerShortcut` 是 TUI 概念，浏览器有自己的键盘事件系统
3. **命令入口不同**：TUI 用 `/command`，Web 用按钮 + 菜单
4. **更轻量的方案**：`customTools` 注入已经能满足 activity-agent 的核心需求

**结论**：activity-agent 选择了"轻量定制 + 自管 Web 状态"而非"重 Extension 架构"，这是合理的工程取舍。

---

## 7. 第六部分：Tool vs Extension 区别与选型

### 7.1 对比矩阵

| 维度 | Tool（工具） | Extension（扩展） |
|------|-------------|------------------|
| **接口** | `ToolDefinition`（`types.ts:426`） | `ExtensionAPI`（`types.ts:1084`） |
| **本质** | 一个 LLM 可调用的函数 | 一个完整插件容器 |
| **形状** | `{ name, description, parameters, execute }` | `(pi: ExtensionAPI) => void` 工厂 |
| **能力数** | 1 个：被 LLM 调用、执行、返回结果 | 5 大类：事件 + Action + 工具 + 命令 + UI |
| **加载方式** | `createAgentSession({ customTools })` | jiti 扫描 `~/.pi/agent/extensions/` |
| **使用方** | LLM（自动选择调用） | 用户/系统（手动触发或事件触发） |
| **生命周期感知** | 无 | 有（订阅 25+ 事件） |
| **UI 能力** | 无（纯函数） | 有（widget/footer/status） |
| **数量** | 1 个文件 = 1 个工具 | 1 个文件 = 1 个 Extension（含多个工具/命令） |
| **使用场景** | 添加 LLM 能力 | 添加跨切面行为（A/B test、埋点、安全审计） |

### 7.2 选型决策树

```
问：我需要添加 LLM 可以调用的能力吗？
  ├─ 是 → 用 Tool（customTools）
  └─ 否 → 问：我需要跨多个事件触发吗？
              ├─ 是 → 用 Extension
              └─ 否 → 问：我需要定制 UI 吗？
                          ├─ 是 → 用 Extension
                          └─ 否 → 直接在 lib/ 里加业务逻辑
```

### 7.3 实际案例

| 需求 | 选择 |
|------|------|
| 让 LLM 理解并记录用户意图 | ✅ Tool（`intent_parse`） |
| 每次 tool_call 后发送埋点 | ✅ Extension（订阅 `tool_call` 事件） |
| 添加一个 `/export` 斜杠命令 | ✅ Extension（`registerCommand`） |
| 改变 LLM 的 system prompt | ✅ ResourceLoader 包装（不是 Tool/Extension） |

---

## 8. 第七部分：完整流程的代码节点映射

### 8.1 端到端流程（用户发消息）

```
┌─────────────────────────────────────────────────────────────────┐
│ Step 1: 浏览器发送 POST 请求                                     │
│   代码: components/ChatInput.tsx                                │
│   行号: (组件内部)                                                │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: Next.js 路由处理                                          │
│   代码: app/api/agent/sessions/[id]/messages/route.ts             │
│   行号: (路由文件)                                                │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 3: 业务逻辑层                                                │
│   代码: lib/rpc-manager.ts                                       │
│   方法: sendMessage(sessionId, text)                             │
│   行号: ~224                                                     │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 4: AgentSession 接收 prompt                                  │
│   代码: @earendil-works/pi-coding-agent                          │
│   文件: core/agent-session.ts                                    │
│   方法: prompt(text)                                             │
│   行号: 962                                                      │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 5: 追加 user entry 到 .jsonl                                  │
│   代码: core/session-manager.ts                                  │
│   方法: appendEntry({ type: 'user', content: text })             │
│   行为: 写入 ~/.pi/agent/sessions/<id>.jsonl                     │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 6: 构建 context                                              │
│   代码: core/agent-session.ts                                    │
│   方法: buildContext()                                           │
│   行号: 1042                                                     │
│   内容: system prompt + 历史消息 + 工具列表                       │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 7: LLM 流式调用                                              │
│   代码: @mariozechner/pi-ai                                      │
│   方法: streamSimple(messages, tools)                            │
│   行为: 发起 HTTP 请求到 LLM provider,流式接收响应                 │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 8a: 如果 LLM 返回 tool_call                                  │
│   代码: core/agent-session.ts                                    │
│   方法: _executeTool(toolCall)                                   │
│   行号: 1450 区域                                                  │
│   行为: 查找工具 → execute(args, ctx) → 追加 tool_result           │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 8b: 如果 LLM 返回 finish_reason=stop                          │
│   代码: core/agent-session.ts                                    │
│   方法: _finalizeTurn()                                          │
│   行为: 追加 assistant message → emit turn_end                    │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 9: 事件发射                                                  │
│   代码: core/event-bus.ts                                        │
│   方法: eventBus.emit('tool_execution_start', { toolName, args })│
│   行为: 所有 listener 被同步调用                                  │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 10: AgentSession.subscribe 回调                              │
│   代码: lib/rpc-manager.ts                                       │
│   方法: session.subscribe((event) => sse.write(event))            │
│   行号: ~175                                                     │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 11: SSE 推送到浏览器                                          │
│   代码: app/api/agent/sessions/[id]/messages/route.ts             │
│   行为: response.write(`data: ${JSON.stringify(event)}\n\n`)      │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 12: 浏览器 EventSource 接收                                   │
│   代码: hooks/useAgentStream.ts                                  │
│   行为: 解析 SSE → 触发 React state 更新                          │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 13: React 重渲染                                            │
│   代码: components/ChatMessages.tsx                              │
│   行为: 把新消息追加到消息列表                                     │
└─────────────────────────────────────────────────────────────────┘
```

### 8.2 关键节点速查表

| 节点 | 库 | 文件 | 方法 | 行号 |
|------|-----|------|------|------|
| SDK 工厂 | pi-coding-agent | core/sdk.ts | `createAgentSession()` | 202 |
| 订阅事件 | pi-coding-agent | core/agent-session.ts | `subscribe()` | 673 |
| 获取工具列表 | pi-coding-agent | core/agent-session.ts | `getAllTools()` | 764 |
| 发送 prompt | pi-coding-agent | core/agent-session.ts | `prompt()` | 962 |
| 中断 | pi-coding-agent | core/agent-session.ts | `abort()` | - |
| 设置模型 | pi-coding-agent | core/agent-session.ts | `setModel()` | - |
| 设置思考 | pi-coding-agent | core/agent-session.ts | `setThinkingLevel()` | 1510 |
| 压缩 | pi-coding-agent | core/agent-session.ts | `compact()` | 1611 |
| 上下文用量 | pi-coding-agent | core/agent-session.ts | `getContextUsage()` | 2929 |
| 加载 Extension | pi-coding-agent | core/resource-loader.ts | `loadExtensions()` | 398 |
| 工具执行 | pi-coding-agent | core/agent-session.ts | `_executeTool()` | ~1450 |
| 自定义工具 | activity-agent | src/tools/activity-tools.ts | `ACTIVITY_TOOLS` | - |
| 注入工具 | activity-agent | lib/rpc-manager.ts | `createAgentSession({ customTools })` | ~325 |
| 多 session 管理 | activity-agent | lib/rpc-manager.ts | `Map<id, session>` | 38 |
| SSE 桥 | activity-agent | lib/rpc-manager.ts | `subscribe → sse.write` | ~175 |

---

## 9. 第八部分：activity-agent 的扩展点分析

### 9.1 三个核心扩展点

#### 9.1.1 customTools 注入（领域能力定制）

**位置**：`lib/rpc-manager.ts:34`（`ACTIVITY_TOOLS = getActivityPlannerTools()`）+ `lib/rpc-manager.ts:363-371`（`createAgentSession` 调用）

**代码**：

```typescript
const ACTIVITY_TOOLS = getActivityPlannerTools();  // 12 个活动规划工具
// ...
const activityToolsList = ACTIVITY_TOOLS;
const resourceLoader = createActivityResourceLoader(cwd, agentDir);
const { session: inner } = await createAgentSession({
  cwd: this.cwd,
  model: this.model,
  customTools: activityToolsList,
  resourceLoader,
});
```

**效果**：**12 个**活动规划工具对 LLM 可见，LLM 可以自动选择调用。每个工具都受 `lib/plan-state.ts` 的 `TOOL_PHASE_RULES` 守卫，跨 phase 调用会返回 `PHASE_GUARD` 错误。

#### 9.1.2 ResourceLoader 包装（系统 prompt 定制）

**位置**：`lib/rpc-manager.ts:13`（`createActivityResourceLoader` 函数定义）+ `lib/rpc-manager.ts:364`（调用点）

**代码**：

```typescript
function createActivityResourceLoader(cwd: string, agentDir: string): ResourceLoader {
  // 包装 DefaultResourceLoader，注入中文 SOP-v2 prompt + 8 阶段工作流规则
  // ...
  return {
    ...inner,
    getSystemPrompt: () => ZH_ACTIVITY_SYSTEM_PROMPT,   // 中文 SOP-v2 prompt
    getAppendSystemPrompt: () => ACTIVITY_RULES,        // 8 阶段 + 1-clarify 规则
  };
}
```

**效果**：所有 LLM 调用的 system prompt 都是中文 + 8 阶段 SOP-v2 工作流指令（单次确认 + 1-clarify 硬限 + auto-planning）。

#### 9.1.3 SSE 桥（协议转换）

**位置**：`lib/rpc-manager.ts:175`

**代码**：

```typescript
const cleanup = session.subscribe((event: AgentSessionEvent) => {
  // 把内部事件转成 SSE 推给浏览器
  const data = `data: ${JSON.stringify(event)}\n\n`;
  controller.enqueue(new TextEncoder().encode(data));
});
```

**效果**：把 stdio 风格的 JSON-RPC 事件流转换为浏览器 SSE 协议。

### 9.2 未使用的 pi-coding-agent 能力

| 能力 | 用途 | activity-agent 状态 |
|------|------|-------------------|
| `Extension` 系统 | TUI 插件 | ❌ 未使用 |
| `registerCommand` | 斜杠命令 | ❌ 未使用 |
| `registerShortcut` | 键盘快捷键 | ❌ 未使用 |
| `setWidget` / `setFooter` | TUI UI | ❌ 未使用（TUI 概念） |
| `compact()` | 自动压缩 | ⚠️ API 暴露但前端未接 |
| `navigateTree()` | 会话树导航 | ⚠️ API 暴露但前端未接 |
| `steer()` / `followUp()` | 队列消息 | ⚠️ API 暴露但前端未接 |
| `setAutoCompactionEnabled()` | 自动压缩开关 | ⚠️ 未实现 |
| `setAutoRetryEnabled()` | 自动重试 | ⚠️ 未实现 |
| Extension `getResource` / `getResourceLoader` | 资源访问 | ❌ 未使用 |
| `setModel` | 运行时切换模型 | ✅ 已使用 |
| `setThinkingLevel` | 思考深度 | ✅ 已使用 |
| `abort` | 中断 | ✅ 已使用 |
| `getAllTools` | 工具列表 | ✅ 已使用 |

### 9.3 三个扩展点的设计评价

| 扩展点 | 设计质量 | 评价 |
|--------|----------|------|
| customTools 注入 | ⭐⭐⭐⭐ | 标准做法，符合官方推荐 |
| ResourceLoader 包装 | ⭐⭐⭐ | 工作良好，但增加了与 DefaultResourceLoader 的耦合 |
| SSE 桥 | ⭐⭐⭐ | 直接有效，但缺少背压控制和重连逻辑 |

---

## 10. 第九部分：改进建议

### 10.1 高优先级（建议立即处理）

#### 10.1.1 `useAgentSession` Hook 拆分

**位置**：`hooks/useAgentSession.ts`（656 行）

**问题**：单文件承担太多职责：
- session 创建/打开/关闭
- 消息流订阅
- 错误处理
- 重试逻辑
- UI 状态同步

**建议**：拆分为 5 个子 Hook：
- `useSessionLifecycle`
- `useSessionStream`
- `useSessionRetry`
- `useSessionError`
- `useSessionState`

#### 10.1.2 消除冗余的 `loadSession` 调用

**位置**：`lib/rpc-manager.ts`

**问题**：每次 `getSession` 都重新 load .jsonl，但 AgentSession 内部已经持有了 SessionManager。

**建议**：直接通过 `session.getSessionManager()` 访问，避免重复 IO。

#### 10.1.3 SessionManager 单例化

**位置**：`lib/rpc-manager.ts:38`（Map 实例）

**问题**：每个 sessionId 都有自己的 SessionManager，但同一 cwd 下可以用共享 SessionManager 读取历史。

**建议**：用 LRU 缓存 + 文件 mtime 失效，避免重复读取。

### 10.2 中优先级（按需处理）

#### 10.2.1 状态管理迁移到 Zustand/Jotai

**问题**：当前用 React Context + useState 组合，跨组件状态同步复杂。

**建议**：评估 Zustand 迁移成本（~3-5 天工作量）。

#### 10.2.2 SSE 重连逻辑

**位置**：`hooks/useAgentStream.ts`

**问题**：当前 SSE 断开后需要手动刷新页面。

**建议**：实现自动重连 + 事件去重（基于 event_id）。

#### 10.2.3 错误边界完善

**位置**：根布局 + 各 page.tsx

**问题**：当前错误处理散落在各 route handler。

**建议**：实现全局 error.tsx + not-found.tsx，标准化错误响应。

#### 10.2.4 暴露 pi-coding-agent 的 compact/navigateTree API

**问题**：API 路由已注册但前端未使用。

**建议**：在 UI 添加"压缩上下文"按钮和"会话树浏览器"组件。

#### 10.2.5 Extension 系统的潜在价值

**问题**：activity-agent 不用 Extension，但如果未来要加"埋点"、"A/B test"、"安全审计"，需要重新设计。

**建议**：预留 Extension 钩子位置（即使不实际加载），例如在 RPCManager 里加 `registerExtension(api => ...)` 方法。

### 10.3 低优先级（未来优化）

- **响应式数据规范化**：`lib/normalize.ts` 缺少单元测试
- **路径处理**：`lib/file-paths.ts` 缺少 Windows 路径兼容
- **国际化**：`messages/*.json` 缺少英文 fallback
- **TypeScript strict 模式**：当前 `tsconfig.json` 未开启 `noUncheckedIndexedAccess`

---

## 11. 第十部分：行号参考速查表

### 11.1 pi-coding-agent 关键行号（v0.75.5 / 0.76.0 源码）

| 类别 | 接口/类/方法 | 文件 | 行号 |
|------|-------------|------|------|
| **Extension API** | `ExtensionAPI` 接口 | `src/core/extensions/types.ts` | 1084 |
| | `registerTool` 方法 | `src/core/extensions/types.ts` | 1133 |
| | `registerCommand` 方法 | `src/core/extensions/types.ts` | 1142 |
| | `sendMessage` 方法 | `src/core/extensions/types.ts` | 1178 |
| **Tool** | `ToolDefinition` 接口 | `src/core/extensions/types.ts` | 426 |
| **Extension 加载** | `loadExtensions` 调用 | `src/core/resource-loader.ts` | 398 |
| | `createExtensionRuntime` | `src/core/resource-loader.ts` | 236 |
| **AgentSession** | `subscribe` 方法 | `src/core/agent-session.ts` | 673 |
| | `getAllTools` 方法 | `src/core/agent-session.ts` | 764 |
| | `getActiveToolNames` 方法 | `src/core/agent-session.ts` | 757 |
| | `setActiveToolsByName` 方法 | `src/core/agent-session.ts` | 783 |
| | `prompt` 方法 | `src/core/agent-session.ts` | 962 |
| | `setThinkingLevel` 方法 | `src/core/agent-session.ts` | 1510 |
| | `compact` 方法 | `src/core/agent-session.ts` | 1611 |
| | `getContextUsage` 方法 | `src/core/agent-session.ts` | 2929 |
| **SDK 工厂** | `createAgentSession` | `src/core/sdk.ts` | 202 |
| | `DefaultResourceLoader` import | `src/core/sdk.ts` | 15 |
| | 默认 fallback | `src/core/sdk.ts` | 217 |

### 11.2 activity-agent 关键行号

| 类别 | 文件 | 行号 | 说明 |
|------|------|------|------|
| **RPC Manager** | `lib/rpc-manager.ts` | 38 | `Map<id, session>` 实例 |
| | `lib/rpc-manager.ts` | 175 | SSE 桥 subscribe |
| | `lib/rpc-manager.ts` | 224 | sendMessage 方法 |
| | `lib/rpc-manager.ts` | 280-322 | createResourceLoader 包装 |
| | `lib/rpc-manager.ts` | 325-331 | createAgentSession 调用 |
| **类型桥** | `lib/pi-types.ts` | (全文) | `AgentSessionLike` 接口 |
| **Tools** | `src/tools/activity-tools.ts` | (全文，718 行) | **12 个**活动规划工具（SOP-v2） |
| **Plan State** | `lib/plan-state.ts` | (全文，297 行) | PlanStateManager: 8 阶段 SOP-v2 状态机 |
| **Tool Wrapper** | `lib/tool-wrapper.ts` | (全文) | retry/timeout/metrics 包装 |
| **POI DB** | `lib/poi-database.ts` | (全文) | 34 POI（22 活动 + 12 餐厅） |
| **Booking** | `lib/booking-service.ts` | (全文) | 真实预订状态机 |

### 11.3 路由文件清单

| 路径 | 文件大小 | 状态 |
|------|---------|------|
| `app/api/skills/search/route.ts` | 454 B | ✅ 桩 + `SkillSearchResult` 导出 |
| `app/api/skills/route.ts` | 255 B | ✅ 桩 |
| `app/api/skills/install/route.ts` | 323 B | ✅ 桩 |
| `app/api/auth/providers/route.ts` | 190 B | ✅ 桩 |
| `app/api/auth/all-providers/route.ts` | 191 B | ✅ 桩 |
| `app/api/auth/login/[provider]/route.ts` | 907 B | ✅ 桩 |
| `app/api/auth/logout/[provider]/route.ts` | 325 B | ✅ 桩 |
| `app/api/auth/api-key/[provider]/route.ts` | 628 B | ✅ 桩 |
| `app/api/default-cwd/route.ts` | 582 B | ✅ **完整实现** |
| `app/api/models-config/test/route.ts` | 310 B | ✅ 桩 |
| `app/api/sessions/new/route.ts` | 236 B | ✅ **410 Gone** |

---

## 附录 A：术语表

| 术语 | 英文 | 定义 |
|------|------|------|
| 扩展 | Extension | pi-coding-agent 的插件机制，可订阅事件、注册工具/命令/快捷键、定制 TUI UI |
| 工具 | Tool | LLM 可调用的函数，通过 `customTools` 注入到 AgentSession |
| 代理会话 | AgentSession | 一次完整的 LLM 对话会话，状态机 + 事件流 |
| 会话管理器 | SessionManager | 管理 `.jsonl` 会话文件的增删改查 |
| 模型注册表 | ModelRegistry | 解析模型 ID 并提供 model object |
| 认证存储 | AuthStorage | API key 持久化（`~/.pi/agent/auth.json`） |
| 资源加载器 | ResourceLoader | 加载 system prompt、skills、extensions、themes |
| 事件总线 | EventBus | AgentSession 内部的发布/订阅事件机制 |
| 服务端推送 | SSE | Server-Sent Events，浏览器单向接收服务器推送 |
| 自定义工具 | customTools | 通过 `createAgentSession({ customTools })` 注入的额外工具 |
| 会话压缩 | Compaction | 当 context 接近窗口上限时，自动总结历史消息释放 token |
| 思考级别 | ThinkingLevel | LLM 推理深度（low/medium/high） |
| Token 用量 | ContextUsage | 当前 prompt 已用 token / 总窗口大小 |
| 斜杠命令 | Command | TUI 中以 `/` 开头的用户命令（与 Extension 配合） |
| 叶子节点 | Leaf Node | 会话树中当前活跃的 entry |

---

## 附录 B：完整路由清单

### B.1 桩实现路由（9 个）

```typescript
// 通用模式
export async function GET() {
  return Response.json(
    { error: "Not implemented" },
    { status: 501 }
  );
}
```

### B.2 完整实现路由（1 个）

`app/api/default-cwd/route.ts`：

```typescript
import { execSync } from "node:child_process";
import os from "node:os";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    let cwd = process.cwd();
    try {
      const result = execSync("pwd", { encoding: "utf-8" }).trim();
      if (result) cwd = result;
    } catch {
      // fall back to process.cwd()
    }
    return Response.json({ cwd, home: os.homedir() });
  } catch (err) {
    return Response.json({ cwd: process.cwd(), home: os.homedir() });
  }
}
```

### B.3 Gone 路由（1 个）

`app/api/sessions/new/route.ts`：

```typescript
export async function POST() {
  return new Response(
    JSON.stringify({
      error: "Gone",
      message: "New sessions should be created via POST /api/agent/sessions",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } }
  );
}
```

---

## 附录 C：状态同步日志（2026-06-06 SOP-v2）

### C.1 背景

本报告原始版本（v1.0）的 §3.2.4 / §8.1 / §9.1 / §11.2 等多处描述基于"5 步工作流 + 6 个工具"的早期实现。2026-06-06 SOP-v2 上线后，工作流升级为 **8 阶段状态机**，工具数从 6 扩到 12。本次同步聚焦于：

- 修正工具数（6 → 12）和工具列表
- 同步 `lib/rpc-manager.ts` 中 `createAgentSession` / `createResourceLoader` 的实际行号
- 反映 `lib/plan-state.ts`（297 行）作为 8 阶段状态机核心模块的存在
- 增加 `lib/tool-wrapper.ts` / `lib/poi-database.ts` / `lib/booking-service.ts` 等新模块

### C.2 同步清单

| 章节 | 原内容 | 同步后 |
|------|--------|--------|
| §1.2 TL;DR | "6 个活动规划 customTools" | **12 个** + SOP-v2 注 |
| §3.1 Layer 3 | 5 个 lib/* 模块 | **11 个 lib/* 模块**（新增 plan-state / tool-wrapper / 4 个服务） |
| §3.2.4 | "6 个工具"（错误工具名） | 12 个工具的完整列表 + phase 守卫说明 |
| §9.1.1 | "6 个"、行号 325-331 | 12 个、行号 34 + 363-371 |
| §9.1.2 | "createResourceLoader"、行号 280-322 | "createActivityResourceLoader"、行号 13 + 364 |
| §11.2 | "6 个活动规划工具" | 12 个 + 新增 plan-state / tool-wrapper / POI / booking |

### C.3 仍未同步的"历史视角"内容

为保留本报告作为"activity-agent 集成演进史"的分析价值，**以下内容保持原始描述不变**：

- §2 "路由对齐工作"（17 个文件差异处理）— 一次性集成工作的快照
- §6 "Extension 概念详解" — 与 activity-agent 是否使用 Extension 系统的对比
- §8.1 "Step 1-13 流程图" — pi-coding-agent 通用流，泛用
- §10 "改进建议" — 10.1/10.2 中的 Hook 拆分、Zustand 迁移、SSE 重连等仍为有效建议

### C.4 同步未覆盖的范围

本次同步**不**涉及：

- 代码层面的实际改动（仅文档同步）
- 验证测试运行（smoke + e2e 在原 commit 中已通过）
- 新功能的实际部署（SOP-v2 已在生产演示中通过 24/24 e2e）

### C.5 关联文档同步状态

| 文档 | 同步状态 |
|------|---------|
| `HANDOFF.md` | ✅ 已存在（SOP-v2 视角） |
| `AGENTS.md` | ✅ 已存在（SOP-v2 视角） |
| `BUSINESS_ANALYSIS_REPORT.md` | ✅ 2026-06-06 同步（§0 状态同步 + §一/§二/§十 更新） |
| `INTEGRATION_REPORT.md` | ✅ 2026-06-06 同步（本附录 + §1.2/§3.1/§3.2.4/§9.1/§11.2 更新） |

---

## 报告结束

**报告作者**：activity-agent 集成分析  
**最后更新**：2026-06-06  
**版本**：v1.1（含 SOP-v2 同步）  
**许可**：内部文档
