# Activity Agent - Development Notes

## Quick Start

```bash
npm run dev                  # port 30142
```

| Check | Command |
|-------|---------|
| Typecheck | `node_modules/.bin/tsc --noEmit` |
| Unit + integration smoke (no API key) | `npm run test:smoke` |
| Real LLM e2e — one-shot (auto-starts dev server) | `npm run e2e` |
| Real LLM e2e — manual (server must be running) | `npm run e2e:real` |
| Playwright visual | `npm run test:visual` |

## CI (GitHub Actions)

Workflow file: **`.github/workflows/ci.yml`**

<!-- TODO: replace OWNER/REPO with actual GitHub path after first push -->
[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)

Two jobs:

| Job | Triggers | Needs secrets | What it runs | Timeout |
|---|---|---|---|---|
| **lint** | every push + PR | ❌ | `tsc --noEmit` + `npm run test:smoke` | 5 min |
| **e2e** | push to `main` + manual dispatch | ✅ `DEEPSEEK_API_KEY` | full LLM e2e (auto-starts dev server) | 10 min |

**Setup after first `git push`**:

1. Go to repo **Settings → Secrets and variables → Actions**
2. Click **New repository secret**
3. Name: `DEEPSEEK_API_KEY`, Value: your `sk-...` from https://platform.deepseek.com
4. Done — next push to main will run e2e automatically

**Swap provider**: edit `.github/workflows/ci.yml` lines 76-83 (`Write deepseek config` step) and the `env:` block above. Pattern is identical for any built-in provider (see [`docs/MODEL_CONFIG.md`](docs/MODEL_CONFIG.md) §实战 2).

**Save API credits on PRs**: e2e is intentionally gated to `push` events on `main` + manual `workflow_dispatch`. PRs only run `lint`. Use **Actions → CI → Run workflow** to force an e2e on a PR branch.

## Model Configuration — 3 Files, Not 1

**改错了文件 = 改半天 LLM 没反应。** LLM 模型配置分布在 3 个文件里（不是 1 个）：

| 文件 | 管什么 | 什么时候改 |
|---|---|---|
| `~/.pi/agent/settings.json` | 默认 provider + modelId | 想换默认模型时 |
| `~/.pi/agent/auth.json` (0600) | **内置** provider 的 API key | 想用 deepseek/openai/anthropic 等官方 provider 时 |
| `~/.pi/agent/models.json` (可选) | **自定义** provider/model + 备用 key | 想接自建 / 第三方 / 微调模型时 |

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

| Phase | Tool | Role |
|-------|------|------|
| 1 intent | `intent_parse` | Record structured intent **OR** submit final plan (`submitPlan: true`) |
| 1 intent | `ask_clarification` | 1-shot clarifying question (硬限 1) |
| 2 planning | `get_weather` | Weather forecast for the day |
| 2 planning | `search_activities` | Activity POI query (real DB, 22 POIs) |
| 2 planning | `search_restaurants` | Restaurant POI query (real DB, 12 POIs) |
| 2 planning | `check_opening_hours` | Verify POI is open at planned time |
| 2 planning | `compute_route` | Transit time between POIs (auto walking/transit/driving) |
| 3 execution | `reservation_exec` | Real restaurant booking (state machine) |
| 3 execution | `query_booking` | Check order status |
| 3 execution | `retry_booking` | Retry failed order |
| persist | `plan_save` | Save final plan |
| persist | `plan_load` | Load historical plan |

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

app/
  layout.tsx            Root layout, dark/light theme bootstrap
  page.tsx              Main pi-web shell (SessionSidebar + ChatWindow + FileViewer)
  activity/page.tsx     Activity-specific UI: SOP-v2 phase progress + tool timeline + plan + booking
  globals.css           CSS variables (light + dark), shared styles

lib/
  rpc-manager.ts           AgentSessionWrapper + startRpcSession
                           + advancePlanPhase (idle/completed/cancelled → intent_capture;
                                                clarifying → planning;
                                                plan_confirm → executing/planning/intent_capture)
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
hooks/
  useActivitySession.ts    Minimal SSE + plan-state polling hook (separate from useAgentSession)

scripts/
  p0-smoke-test.ts         Unit + integration tests (94 assertions, no API)
  e2e-real-llm-test.ts     Real LLM end-to-end test (requires API key)
```

## Activity UI (`/activity` page)

A purpose-built UI for activity planning — separate from the generic pi-web shell
at `/`. Goes to the URL in your dev server: <http://localhost:30142/activity>.

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

| File | Location | Format |
|------|----------|--------|
| Session log | `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl` | JSONL events |
| Plan state | `~/.pi/agent/plan-states/<sessionId>.json` | JSON snapshot |

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
