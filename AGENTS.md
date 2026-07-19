# Activity Agent - Development Notes

## Quick Start

```bash
npm run dev                  # port 30142
```

```bash
docker compose up -d --build # app + postgres + redis
```

| Check                                             | Command                            |
| ------------------------------------------------- | ---------------------------------- |
| Typecheck                                         | `node_modules/.bin/tsc --noEmit` |
| Unit + integration smoke (no API key)             | `npm run test:smoke`             |
| Real LLM e2e — one-shot (auto-starts dev server) | `npm run e2e`                    |
| Real LLM e2e — manual (server must be running)   | `npm run e2e:real`               |
| Playwright visual                                 | `npm run test:visual`            |

**Docker quick start (`AUTH_MODE=required`)**

1. `docker compose up -d --build`
2. 把宿主机 pi 凭证复制进 app 容器绑定的 named volume：
   `docker cp ~/.pi/agent/auth.json $(docker compose ps -q app):/home/nextjs/.pi/agent/auth.json`
3. 如需默认模型/自定义 provider，再复制：
   `docker cp ~/.pi/agent/settings.json $(docker compose ps -q app):/home/nextjs/.pi/agent/settings.json`
   `docker cp ~/.pi/agent/models.json $(docker compose ps -q app):/home/nextjs/.pi/agent/models.json`
4. **复制后必须修权限或重启 app**（`auth.json` 常见是 `0600`，直接 `docker cp` 后可能变成 root/node 拥有，`nextjs` 进程读不到）：
   `docker compose exec app sh -lc 'chown nextjs:nodejs /home/nextjs/.pi/agent/auth.json /home/nextjs/.pi/agent/settings.json /home/nextjs/.pi/agent/models.json 2>/dev/null || true && chmod 600 /home/nextjs/.pi/agent/auth.json 2>/dev/null || true && chmod 644 /home/nextjs/.pi/agent/settings.json /home/nextjs/.pi/agent/models.json 2>/dev/null || true'`
   或者直接：
   `docker compose restart app`
5. 浏览器打开 `http://localhost:30142/`，应先跳转 `/login`

容器模式下，pi SDK 仍然读取同一套 3 文件：

- `/home/nextjs/.pi/agent/settings.json`
- `/home/nextjs/.pi/agent/auth.json`
- `/home/nextjs/.pi/agent/models.json`

原则不变：默认模型改 `settings.json`，内置 provider key 改 `auth.json`，自定义 provider 改 `models.json`。

## CI (GitHub Actions)

Workflow file: **`.github/workflows/ci.yml`**

<!-- TODO: replace OWNER/REPO with actual GitHub path after first push -->

[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)

Two jobs:

| Job            | Triggers                          | Needs secrets          | What it runs                              | Timeout |
| -------------- | --------------------------------- | ---------------------- | ----------------------------------------- | ------- |
| **lint** | every push + PR                   | ❌                     | `tsc --noEmit` + `npm run test:smoke` | 5 min   |
| **e2e**  | push to`main` + manual dispatch | ✅`DEEPSEEK_API_KEY` | full LLM e2e (auto-starts dev server)     | 10 min  |

**Setup after first `git push`**:

1. Go to repo **Settings → Secrets and variables → Actions**
2. Click **New repository secret**
3. Name: `DEEPSEEK_API_KEY`, Value: your `sk-...` from https://platform.deepseek.com
4. Done — next push to main will run e2e automatically

**Swap provider**: edit `.github/workflows/ci.yml` lines 76-83 (`Write deepseek config` step) and the `env:` block above. Pattern is identical for any built-in provider (see [`docs/MODEL_CONFIG.md`](docs/MODEL_CONFIG.md) §实战 2).

**Save API credits on PRs**: e2e is intentionally gated to `push` events on `main` + manual `workflow_dispatch`. PRs only run `lint`. Use **Actions → CI → Run workflow** to force an e2e on a PR branch.

## Model Configuration — 3 Files, Not 1

**改错了文件 = 改半天 LLM 没反应。** LLM 模型配置分布在 3 个文件里（不是 1 个）：

| 文件                               | 管什么                                     | 什么时候改                                        |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `~/.pi/agent/settings.json`      | 默认 provider + modelId                    | 想换默认模型时                                    |
| `~/.pi/agent/auth.json` (0600)   | **内置** provider 的 API key         | 想用 deepseek/openai/anthropic 等官方 provider 时 |
| `~/.pi/agent/models.json` (可选) | **自定义** provider/model + 备用 key | 想接自建 / 第三方 / 微调模型时                    |

**经验法则**：

1. 改默认模型 = `settings.json`
2. 改 API key = `auth.json`（**不是** `models.json`）
3. 改模型行为 / 加自定义 provider = `models.json`

**完整指南**（含 5 大坑的排查步骤、22+ provider 速查表、OAuth 流程、models.json schema）：看 [`docs/MODEL_CONFIG.md`](docs/MODEL_CONFIG.md)。

**为什么是 3 个文件？** pi-coding-agent 把 "**默认配置**" 和 "**凭证**" 拆开（`settings.json` + `auth.json`），又为高级用户留了 "**自定义 provider**" 扩展点（`models.json`）。`AuthStorage.getApiKey()` 有 5 级 fallback 链，**`auth.json` 永远赢** `models.json`。

## Workflow: SOP-v2 (8 phases, single-confirm, 1-clarify)

```
                          ┌─→ clarifying (MAX 1) ─┐
                          │                        │
[user msg] → intent_capture ───────────────────┐    │
                                ↓              │    │
                            planning (auto) ←──┘    │
                                ↓                   │
                          plan_confirm ⭐ ONLY confirmation point
                                ↓ confirm
                            executing → completed
```

**Hard constraints:**

- **Single user confirmation** at `plan_confirm` (no intermediate "is this OK?")
- **1-clarify limit** — `ask_clarification` can be invoked at most once per session
- **Auto-planning** — LLM calls `get_weather` / `search_*` / `check_opening_hours` / `compute_route` without user interaction
- **Phase guard** — every tool wrapped with `guardToolCallWithActive`, illegal-phase calls return `PHASE_GUARD` error

## 12 Tools (by phase)

| Phase       | Tool                    | Role                                                                          |
| ----------- | ----------------------- | ----------------------------------------------------------------------------- |
| 1 intent    | `intent_parse`        | Record structured intent**OR** submit final plan (`submitPlan: true`) |
| 1 intent    | `ask_clarification`   | 1-shot clarifying question (硬限 1)                                           |
| 2 planning  | `get_weather`         | Weather forecast for the day                                                  |
| 2 planning  | `search_activities`   | Activity POI query (real DB, 22 POIs)                                         |
| 2 planning  | `search_restaurants`  | Restaurant POI query (real DB, 12 POIs)                                       |
| 2 planning  | `check_opening_hours` | Verify POI is open at planned time                                            |
| 2 planning  | `compute_route`       | Transit time between POIs (auto walking/transit/driving)                      |
| 3 execution | `reservation_exec`    | Real restaurant booking (state machine)                                       |
| 3 execution | `query_booking`       | Check order status                                                            |
| 3 execution | `retry_booking`       | Retry failed order                                                            |
| persist     | `plan_save`           | Save final plan                                                               |
| persist     | `plan_load`           | Load historical plan                                                          |

## Architecture

```
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.pi/agent/sessions/   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │   advancePlanPhase(msg) ─────▶│ transition plan state
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Custom Tools**: 12 activity planning tools registered via `customTools` in `rpc-manager.ts`.
**System Prompt**: Chinese single-confirm SOP prompt from `src/prompts/activity-planner.ts`.

## File Map

```
app/api/
  auth/login/route.ts            POST username/password → signed session cookie
  auth/logout/route.ts           POST clear signed session cookie
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  plan-state/[id]/route.ts        GET plan state for /activity UI
  files/[...path]/route.ts        GET file contents for viewer
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/POST — read/write ~/.pi/agent/models.json
  user-preferences/route.ts       GET/PUT/POST — read/edit/refresh user preference memory
  dev-login/route.ts              GET/POST/DELETE — set/clear pi_user cookie (dev-only)

app/
  layout.tsx            Root layout, dark/light theme bootstrap
  login/page.tsx        Required-auth login page
  page.tsx              Main pi-web shell (SessionSidebar + ChatWindow + FileViewer)
  activity/page.tsx     Activity-specific UI: SOP-v2 phase progress + tool timeline + plan + booking
  globals.css           CSS variables (light + dark), shared styles

lib/
  auth-constants.ts        auth cookie name shared by node + edge runtime
  auth-mode.ts             disabled / optional / required auth mode parser
  auth-session.ts          signed auth token + password verify + user lookup
  rpc-manager.ts           AgentSessionWrapper + startRpcSession
                           + advancePlanPhase (idle/completed/cancelled → intent_capture;
                                                clarifying → planning;
                                                plan_confirm → executing/planning/intent_capture)
                           + shutdownRpcSessions() for T4 graceful stop
  plan-state.ts            8-phase state machine, tool-phase rules,
                           getMissingCriticalFields, MAX_CLARIFICATIONS=1
  poi-database.ts          34 POIs (22 activities + 12 restaurants) across 北京/上海/深圳
                           + Haversine distance + 4D scoring
  booking-service.ts       Real booking state machine
                           (pending → processing → confirmed/failed → notified)
  weather-service.ts       Mock weather (deterministic by date+city hash)
  route-service.ts         Haversine + transit time (walking/transit/driving)
  opening-hours-service.ts Parse opening hours string + open/close check
  tool-wrapper.ts          Generic retry/timeout/fallback/metrics wrapper
  user-preferences.ts      Cross-session memory: defaults derived from history,
                           + autoFillIntent() called by intent_parse when critical
                           fields are missing; recordCompletedSession() called by
                           plan_save on phase → completed
  user-context.ts          userId resolution: X-User-Id header > pi_user cookie >
                           os.userInfo().username > DEFAULT_USER_ID;
                           getCurrentUserId() for tools (no req context),
                           getCurrentUserIdFromRequest(req) for API routes
  session-ownership.ts     session / plan-state owner checks for required auth
  session-reader.ts        parse .jsonl; getModelList/getDefaultModel
  types.ts                 shared TypeScript types
  normalize.ts             normalizeToolCalls()
  agent-client.ts          client-side fetch helper for /api/agent/[id]
  pi-types.ts              AgentSessionLike interface

src/
  tools/
    activity-tools.ts      12 ToolDefinitions + per-tool P0 wrappers
    tool-utils.ts          Response helpers
  prompts/
    activity-planner.ts    Chinese system prompt
                           (single-confirm + SOP boundaries + thinking limits)

components/
  activity/                Activity-specific UI (used by /activity page)
    PhaseProgress.tsx      8-step horizontal progress with active-phase highlight
    PlanTimeline.tsx       Vertical timeline of plan legs (departure/transit/activity/meal)
    ToolTimeline.tsx       Tool call waterfall with name/icon/duration
    BookingCard.tsx        Order confirmation card (extracted from reservation_exec result)
    ActivityPanel.tsx      Composes the four components
  UserPreferencesPanel.tsx Right-rail card showing learned defaults (party size,
                           budget, departure, …) + stats + recent sessions.
                           Refresh / reset buttons hit /api/user-preferences.
hooks/
  useActivitySession.ts    Minimal SSE + plan-state polling hook (separate from useAgentSession)

scripts/
  p0-smoke-test.ts         Unit + integration tests (242 assertions, no API)
  e2e-real-llm-test.ts     Real LLM end-to-end test (requires API key)
  seed-users.ts            Idempotent seed for alice/bob test accounts

docker/
  entrypoint.sh            Run migrations + seed users, then start standalone app

Repo root:
  Dockerfile               multi-stage standalone build for app container
  docker-compose.yml       full stack: app + postgres + redis
  docker-compose.dev.yml   infra-only dev stack (postgres + redis)
```

## Activity UI (`/activity` page)

A purpose-built UI for activity planning — separate from the generic pi-web shell
at `/`. Goes to the URL in your dev server: [http://localhost:30142/activity](http://localhost:30142/activity).

**Layout**: 2-pane (chat left · activity panel right)

**Activity panel** (right side) shows:

1. **Phase progress** — 8-step horizontal bar (idle → intent_capture → clarifying → planning → plan_confirm → executing → completed), current phase highlighted, "turn N · clarification M/1" status
2. **Booking card** — appears in `executing`/`completed` phase, extracted from `reservation_exec` / `query_booking` results (restaurant / date / time / 确认码 / 订单号)
3. **Plan timeline** — vertical timeline of plan legs (departure 🚌 / transit 🚇 / activity 🎯 / meal 🍴 / rest ☕), weather summary, totals (duration / cost / legs)
4. **Tool timeline** — waterfall of all tool calls with name/icon/args/duration/BLOCKED badge for `PHASE_GUARD` hits

**Why separate page**: The pi-web shell at `/` is a generic coding-agent UI. The
`/activity` page is a vertical slice that visualizes the SOP-v2 workflow end-to-end
(phase progress, plan, booking, tool calls), which is the actual product we're
shipping.

**Data sources**:

- SSE: `/api/agent/[id]/events` (tool_execution_start/end, message_end)
- Plan state polling: `/api/plan-state/[id]` (every 1.5s)
- Session create: `/api/agent/new`

## Session + Plan State Persistence

| File        | Location                                                        | Format        |
| ----------- | --------------------------------------------------------------- | ------------- |
| Session log | `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl` | JSONL events  |
| Plan state  | `~/.pi/agent/plan-states/<sessionId>.json`                    | JSON snapshot |

Plan state tracks: `phase`, `turnCount`, `clarificationCount`, `intent`, `plan`, `history`.

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path"}
{"type":"model_change","provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","message":{"role":"user","content":"..."}}
{"type":"message","message":{"role":"assistant","content":[...],"toolCalls":[...]}}
```

## Key Design Differences from pi-web

- **12 custom activity tools** (vs pi-web's coding tools)
- **Real POI database** (34 entries) replaces LLM-fabricated recommendations
- **Real booking state machine** replaces mock reservation
- **Phase guard** wraps every tool to enforce workflow
- **Tool wrapper** provides retry/timeout/fallback for resilience
- **8-state machine** with single-confirm UX (vs 5-step confirm-each)
- **Auto-planning phase** — LLM does weather/POI/route without user
- No built-in coding tools (read, bash, edit, write, etc.)

## Verification Recipes

### Smoke test (no API key)

```bash
npx tsx scripts/p0-smoke-test.ts
# Expected: 90/90 pass, exit 0
```

### Real LLM e2e (HTTP client — requires configured model + API key + running dev server)

The e2e script is an **HTTP client** that drives the Next.js dev server via
`fetch()` and SSE. This sidesteps a known issue: `pi-coding-agent`'s `exports`
field has no CJS condition, so `npx tsx`'s CJS register can't load it at
runtime. The HTTP client has zero `lib/` imports — it talks to the public API
surface only.

```bash
# 1. Make sure a model is configured (and its provider has working credentials)
cat ~/.pi/agent/models.json

# 2. Start the dev server in one terminal
npm run dev                              # port 30142

# 3. Run the e2e test in another terminal
npm run e2e:real
# (equivalent to: ./node_modules/.bin/tsx scripts/e2e-real-llm-test.ts)
```

Override server URL if needed: `E2E_SERVER=http://localhost:30142 npm run e2e:real`.

The e2e test:

1. Reads `~/.pi/agent/models.json` (first model entry)
2. Pings `${SERVER_BASE}/api/sessions` to confirm dev server is up
3. POSTs to `/api/agent/new` with `{ type: "prompt", cwd: <temp>, message, provider, modelId }`
4. Opens SSE stream to `/api/agent/[id]/events`, collects `tool_execution_*` + `message_end`
5. Polls `/api/agent/[id]` waiting for `isStreaming: false`
6. Asserts: `intent_parse` called, at least one `search_*` called, all SOP tools called (`get_weather`, `compute_route`, `check_opening_hours`), no premature `reservation_exec`
7. Reads `~/.pi/agent/plan-states/<sessionId>.json` to verify final phase = `plan_confirm` and all 5 critical intent fields captured
8. POSTs to `/api/agent/[id]` with `{ type: "prompt", message: "确认" }`
9. Waits for second turn idle
10. Asserts: phase transitioned to `executing`, `reservation_exec` called
11. Prints: tool call sequence, plan state history, captured intent, captured plan, assistant text snippets
12. DELETEs `/api/sessions/[id]` to clean up

Exit codes:

- `0` — all assertions pass
- `1` — at least one assertion failed
- `2` — preflight failed (no model / dev server unreachable)
- `3` — runtime error (LLM crashed, HTTP error)

## Repository Rules

- **`docs/` is local-only**: Never commit files under `docs/`. This directory is already
  in `.gitignore`, so it's enforced technically — the rule here is to make the intent
  explicit. `docs/` holds personal study notes, retrospectives, project analyses,
  and learning materials. They are not part of the shipped product. If you see a
  warning about `git add -f`, that's expected — the `.gitignore` is doing its job.
  If you must reference a doc from code (e.g. `AGENTS.md`), the doc must live
  outside `docs/` and be committed normally.
- If the above rule changes in the future, update `.gitignore` accordingly.

## Debugging Rules — 模型行为异常时先查什么

模型回复异常（thinking 不输出、工具不加载、system prompt 不生效、token 用量异常）时，
**第一步永远是检查 pi SDK 的三份配置文件**，不要直接跳进代码逻辑排查。

## Shell / Node 环境注意事项

本仓库的 `next dev` 依赖 **Node >= 20.9.0**。当前机器同时存在两套 Node：

- 系统 Node：`/usr/bin/node`（可能是 `v18.x`）
- `nvm` Node：`~/.nvm/versions/node/...`（当前开发环境实测为 `v22.18.0`）

**关键坑点**：`~/.bashrc` 在非交互 shell 中会提前 `return`，导致后面的 `nvm` 初始化不执行。因此：

- 你手工打开终端运行 `npm run dev` 可能正常（交互 shell，会加载 `nvm`）
- 自动化代理/脚本若直接跑 `npm run dev`，可能会误用系统 Node 18，随后报 Next.js 版本不满足

排查时先看：

```bash
which node
node -v
```

若需要复现和人工终端一致的环境，优先用交互式 shell 执行：

```bash
bash -ic 'node -v && npm run dev'
```

### 必须检查的 3 个文件

| 文件 | 查什么 | 典型问题 |
|------|--------|---------|
| `~/.pi/agent/settings.json` | `defaultProvider` / `defaultModel` / `defaultThinkingLevel` | thinking 被关掉 (`"off"`)、模型指向错误的 provider |
| `~/.pi/agent/models.json` | 自定义 provider 的 model 列表和配置 | 模型不可用、参数不对 |
| `~/.pi/agent/auth.json` | API key 是否正确配置 | 401/403、无权限调用 |

> 这三个文件是 pi SDK 的"全局开关"——每行都可能直接影响所有 session 的行为。
> 详细说明见 [`docs/MODEL_CONFIG.md`](docs/MODEL_CONFIG.md)。

### 读 JSONL 要读全

分析 session 行为时，不要只看 `message` entry。必须检查**上下文 entry**：
- `thinking_level_change` → 模型是否会产出 thinking
- `model_change` → 当前用的什么模型（是否支持 thinking）
- `compaction` → 上下文是否被压缩（可能丢失设定）

JSONL 是 append-only 的完整事件日志——前面的 entry 决定了后面消息的行为。

### 兜底值规则：默认值应该是"启用"而非"禁用"

任何枚举/开关类字段的 `??` fallback 都必须是"开启"或"自动"，绝不能是"关闭"。
例：`thinkingLevel ?? "off"`（❌） → `thinkingLevel ?? "auto"`（✅）。
不清楚用什么值时，给用户最好的体验（打开），而不是最差的体验（关闭）。

## Changelog Convention

Every bug fix, improvement, refactor, security patch, or performance optimization
**must** have a corresponding changelog document.

### File location

`docs/changelog/YYYYMMDD-short-description.md`

### Template

Copy from `docs/changelog/0000-TEMPLATE.md` and fill in all sections:

| Section     | Required  | Content                                   |
| ----------- | --------- | ----------------------------------------- |
| 1. 元信息   | ✅        | Date, Type, Severity, Files Changed       |
| 2. 问题描述 | ✅        | 现象、根因、影响范围                      |
| 3. 解决方案 | ✅        | 方案选择、文件清单、核心逻辑 before/after |
| 4. 验证     | ✅        | 测试结果、验收标准                        |
| 5. 回滚方案 | ✅        | 回滚命令、影响                            |
| 6. 后续改进 | ⚠️ 可选 | 待跟进的 TODO                             |

### Rules

1. **One changelog per fix/improvement** — don't batch unrelated changes
2. **Write immediately after code change** — before running the next task
3. **Before/after code snippets required** — show the key logic change, not file diffs
4. **Severity drives urgency**:
   - `P0 阻断`: system down, must fix immediately
   - `P1 高`: feature broken, fix within the day
   - `P2 中`: non-critical bug, fix within the week
   - `P3 低`: cosmetic/nice-to-have, backlog
5. **Verify before committing** — smoke test must pass before changelog is finalized

### First entry

See `docs/changelog/20260716-remove-global-planstate-singleton.md` for the
canonical example.
