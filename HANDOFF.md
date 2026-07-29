# Activity Agent — Handoff Document

> Status as of 2026-07-29. Read this before continuing the project.

## TL;DR

SOP-v2 has 23 tools. Final plan submission is token-only: `submit_plan` accepts a summary plus validation/budget tokens, then the server assembles canonical timeline and budget artifacts. Clarification defaults now fail closed unless every required question resolves. **344/344 smoke tests pass** and DeepSeek real-LLM E2E passes **60/60**, with exactly one `submit_plan` call.

A reusable skill capturing the SOP-v2 design pattern has been extracted to `~/.agents/skills/phase-gated-agent/SKILL.md` (see "Reusable artifacts" below).

## What's built

### Backend (verified)
- **8-phase state machine** — `lib/plan-state.ts`. `idle → intent_capture → clarifying → planning → plan_confirm → executing → completed/cancelled`. Explicit `PHASE_TRANSITIONS` DAG.
- **23 custom activity tools** — `src/tools/activity-tools.ts`, including token-only `submit_plan`.
- **TOOL_PHASE_RULES** — strict tool-to-phase whitelist. For example, `commit_itinerary` is only available in `executing`; illegal calls return `PHASE_GUARD`.
- **Canonical submit defense** — `submit_plan` is planning-only and accepts no timeline/budget object. It resolves both from server-owned artifacts by token. Legacy `intent_parse(submitPlan:true)` remains temporarily compatible but uses the same canonical path.
- **Structured 1-clarify flow** — `MAX_CLARIFICATIONS = 1`. Defaults merge by field even for LLM-supplied questions; the UI only enables default submission when every required question has an answer or fallback.
- **Adaptive cost resolution** — unknown ticket/dining costs no longer use fixed ¥100/¥120. `CostResolver` prefers comparable POIs, then city/category priors, then a deliberately wide fallback; every estimate carries range/source/confidence/basis.
- **Plan state persistence** — `~/.pi/agent/plan-states/<sessionId>.json` written on every transition via a write queue.
- **User-preference memory** — `lib/user-preferences.ts`. Per-user JSON at `~/.pi/agent/user-profiles/<userId>.json`. `autoFillIntent()` is called from `intent_parse` when critical fields (date/startTime/partySize/departurePoint/budgetPerPerson) are missing, filling them from the user's learned defaults and reporting `autoFilledFields` in the tool result so the LLM can announce the fill to the user. `recordCompletedSession()` is called from `plan_save` on phase `executing → completed`, appending to the recent-sessions ring buffer (capped at 5, de-duped by sessionId). `refreshFromHistory()` re-derives all defaults from the full plan-state directory (≥50% occurrence threshold) and recomputes favorite restaurants from the booking service.
- **Real-data boundary** — AMap-backed geocoding, POI search/detail, distance matrix and route comparison are selected when configured. Offline smoke tests use an explicit deterministic provider. Weather and third-party ticket/dining prices still need production providers.

### Frontend (verified)
- **Generic pi-web shell** at `/` — 14 React components, full session management, file viewer, etc. (preexisting, untouched).
- **Activity-specific UI** at `/activity` — NEW. 2-pane layout: chat left, activity panel right.
  - **UserPreferencesPanel** (NEW) — right-rail card above the activity panel. Shows learned defaults (人数 / 预算 / 出发地 / 偏好品类 / 饮食限制 / 氛围) as a 2-col grid, stats (方案数 · 预订数 · 上次更新), expandable recent-intents list, and Refresh / Reset buttons. Polls every 5s so the panel updates live as sessions complete.
  - **PhaseProgress** — 8-step horizontal bar with current-phase glow, completed checkmarks, status pill ("turn N · clarification M/1").
  - **ClarificationCard** — inline Stepper for multiple questions with typed date/time/location/number/select controls, custom input and explicit defaults.
  - **PlanTimeline** — vertical timeline of plan legs (departure/transit/activity/meal icons + colors), weather summary, totals (duration/cost/legs).
  - **ToolTimeline** — waterfall of all tool calls with name/icon/args/duration, red BLOCKED badge for `PHASE_GUARD` hits.
  - **PlaceCandidates** — structured POI cards with rating/cost/opening-hours and allowlisted Amap/Dianping links.
  - **BookingCard** — post-confirmation handoff card extracted from `commit_itinerary`, with ICS download, AMap navigation and dining search links. It explicitly does not claim that a reservation was made.
- **APIs** —
  - `GET /api/plan-state/[id]` — UI's 1.5s polling.
  - `GET /api/user-preferences` — read defaults + stats.
  - `PUT /api/user-preferences` — manually edit defaults (partial).
  - `POST /api/user-preferences` — `action=refresh|reset` for full re-derive or full clear.

### Tests (verified)
- `scripts/p0-smoke-test.ts` — **344/344 pass**, including clarification defaults, token-only canonical submission, artifact invalidation, retry limiting and legacy budget rendering compatibility. No API key needed.
- `tests/activity-visual.spec.ts` — Playwright visual regression (light + dark + sample prompt + 7 phase labels). Now also includes 4 new tests for the `User Preferences Panel` (empty state, refresh button POST, dark mode contrast, recent-intents toggle).
- `scripts/e2e-real-llm-test.ts` — **60/60 pass** with sparse-input clarification, adaptive budget, exactly one token-only `submit_plan`, and structured confirmation.

## What's NOT done

Out of scope for the current milestone:

- **Multi-day trip support** — current SOP is single-day. State machine would need extension.
- **Production auth / rate limiting** — dev server only, no rate limits. v3 userId: X-User-Id header > pi_user cookie > `os.userInfo().username` (cookie set/cleared via `/api/dev-login` — NOT real auth, no password/token). For production, replace with proper auth.
- **i18n** — UI is Chinese-only, prompt is Chinese-only.
- **Cost / metrics dashboard** — token usage is collected but not surfaced in the UI.
- **Hard-constraint enforcement** — current constraints (date, budget, party size) are in the prompt. A future "hard mode" should put them in `PlanStateManager` as gates that block `plan_save` if violated.

## Reusable artifacts

- **`~/.agents/skills/phase-gated-agent/SKILL.md`** — Skill capturing the SOP-v2 design pattern. Use it as a starting point for any new agent that needs strict workflow enforcement. Covers: 8-phase design, 3-layer defense (TOOL_PHASE_RULES + PHASE_TRANSITIONS + tool-body self-check), persistence pattern, common pitfalls, and a quick checklist.

- **`lib/plan-state.ts` + `src/tools/activity-tools.ts`** — Drop-in reference implementation. Adapt the 23 tools to your domain while keeping the phase machine and token-only artifact handoff.

- **`lib/user-preferences.ts` + `components/UserPreferencesPanel.tsx`** — Reference pattern for cross-session memory: derive defaults from history (≥50% threshold), auto-fill on intake, record on completion, expose manual refresh/reset via API. Drop-in for any SOP-driven agent that wants to reduce clarification rounds.

- **`scripts/e2e-real-llm-test.ts` + `hooks/useActivitySession.ts`** — E2E test + UI hook pattern. The HTTP-client-e2e sidesteps the `pi-coding-agent@0.75.5` CJS exports issue (its `package.json` exports only `"import"`, no CJS condition — `tsx@4.x` CJS register fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`).

## Key files (for a new contributor)

| What | Where |
|---|---|
| Phase machine | `lib/plan-state.ts` |
| Structured clarification contract | `lib/clarification.ts` |
| Clarification UI | `components/activity/ClarificationCard.tsx` |
| Adaptive cost resolver | `lib/cost-resolver.ts` |
| Budget ledger | `lib/budget-service.ts` |
| 23 tool definitions | `src/tools/activity-tools.ts` |
| Tool wrapper (retry/timeout/metrics) | `lib/tool-wrapper.ts` |
| LLM prompt | `src/prompts/activity-planner.ts` |
| Session orchestration (agent start, advancePlanPhase) | `lib/rpc-manager.ts` |
| User-preference memory (auto-fill + record) | `lib/user-preferences.ts` |
| User-context (header/cookie/OS userId chain) | `lib/user-context.ts` |
| API for plan state (UI polling) | `app/api/plan-state/[id]/route.ts` |
| API for user preferences (GET/PUT/refresh/reset) | `app/api/user-preferences/route.ts` |
| API for dev login (set/clear pi_user cookie) | `app/api/dev-login/route.ts` |
| Activity UI page | `app/activity/page.tsx` |
| Activity panel components | `components/activity/*.tsx` |
| User-preferences panel | `components/UserPreferencesPanel.tsx` |
| Activity session hook (SSE + poll) | `hooks/useActivitySession.ts` |
| Smoke test | `scripts/p0-smoke-test.ts` |
| Playwright visual test | `tests/activity-visual.spec.ts` |
| E2E test | `scripts/e2e-real-llm-test.ts` |
| Project knowledge base | `AGENTS.md` |
| Tech report | `INTEGRATION_REPORT.md` (1175 lines) |
| PRD gap analysis | `BUSINESS_ANALYSIS_REPORT.md` (666 lines) |

## Critical gotchas (read these before changing anything)

1. **Phase guard must run BEFORE the tool body.** `guardToolCallWithActive` is called from the tool wrapper's `beforeExecute`. If you accidentally call it from inside the body, side effects may already have happened.

2. **The plan state file is the source of truth for the UI.** The UI polls `~/.pi/agent/plan-states/<sessionId>.json` directly. The in-memory `PlanStateManager.current` may diverge if a write is in flight. The file is always the latest *persisted* state.

3. **New flows must use `submit_plan`, never `intent_parse(submitPlan:true)`.** The legacy path is compatibility-only. Do not reintroduce LLM-owned copies of timeline or budgetBreakdown.

4. **`commit_itinerary` must NEVER be allowed in `plan_confirm`.** It freezes the plan and generates delivery artifacts, so it must remain `executing`-only after the structured confirmation command.

5. **`MAX_CLARIFICATIONS = 1` is HARD.** Don't raise it without rethinking the SOP — the prompt and the user experience both assume exactly one clarification round.

6. **`tsx@4.x` cannot directly import `pi-coding-agent@0.75.5`** (CJS exports issue). E2E test is an HTTP client. Any new test that imports the SDK directly will fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

7. **Template literal escape gotcha in prompt.** Inside a JS template literal (backtick-wrapped), backticks MUST be escaped as `\``. Unescaped backticks close the outer string. The Chinese SOP prompt has multiple `phase: \`xxx\`` references that the LLM-parser later copies. If you edit the prompt and lose the escape, tsc will fail with a confusing error.

8. **`tsconfig.tsbuildinfo` is gitignored** (it's a build artifact). Delete it manually before `tsc --noEmit` if you see stale type errors.

9. **Do not assume the dev server is running.** Check port 30142 before starting it; automation should use the repository's nvm-compatible interactive-shell command so it does not accidentally select Node 18.

## Test commands

```bash
# Type check
node_modules/.bin/tsc --noEmit                # exit 0

# Smoke (no API key)
npm run test:smoke                            # 344/344 pass

# E2E (real LLM; includes clarification + full plan/confirm)
# Requires: dev server running + auth.json with API key + settings.json with default model
npm run e2e
```

## Progress judgment

**The 8-phase SOP-v2 backend + /activity UI are DONE.** The system has been verified end-to-end. There is no unfixed bug. There is no half-built feature in flight.

**What is open is "what to build next"**, not "how to finish what we started."

## Recommended next steps (prioritized)

| # | Task | Value | Effort | Why |
|---|---|---|---|---|
| 1 | **Wire `/activity` into the main nav** at `/` | High | Low | Users can't discover the activity UI right now. Add a link in the top bar of `AppShell.tsx`. 5 lines of code. |
| 2 | **Dark mode for `/activity`** | Medium | Low | The page already uses CSS variables; just needs `useTheme` from `hooks/useTheme.ts`. 10 lines. |
| 3 | **Add a Playwright screenshot test** | Medium | Medium | Visual regression coverage. Requires `sudo npx playwright install chrome`. |
| 4 | **User profile / preferences** (P1 from BUSINESS_ANALYSIS_REPORT) | High | High | Personalize the SOP — 素食 / 无烟 / 历史去过. Long-term value but significant scope. |
| 5 | **Real API integration** (高德/和风/大众点评) | High | Very high | Productionize. Needs API keys, real-time constraints, error budgets. Multi-week. |
| 6 | **Multi-day trip support** | Medium | High | Extend the state machine. Worth doing only if use case is real. |

**My recommendation: pause and ship as a v0.1 internal demo.** The 1-2-3 set is a "polish what we have" sprint (½ day). Tasks 4-6 are "build the next thing" — each is its own project.

## Re-opening the work

To resume:

```bash
cd /home/a/chat_robot/pi_agent/activity-agent

# Verify state
git log --oneline | head -5     # should show 17 commits ending in c3b805a
git status                      # should be clean
node_modules/.bin/tsc --noEmit  # should exit 0
npx tsx scripts/p0-smoke-test.ts # 94/94

# Restart dev server if needed
pkill -f "next dev" 2>/dev/null
nohup npm run dev > /tmp/next-dev.log 2>&1 &
# wait ~5s, then: curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:30142/activity
```

If you want to extend the SOP (add a new phase, new tool, new transition), start by reading `lib/plan-state.ts` (the source of truth for the state machine), then update `TOOL_PHASE_RULES` and `PHASE_TRANSITIONS`, then add the tool definition in `src/tools/activity-tools.ts`, then add a smoke test assertion. The smoke test is your contract — if it passes, the SOP is still consistent.

If you want to extend the UI, start by reading `components/activity/ActivityPanel.tsx` (the composer), then add a new card, then mount it in `ActivityPanel`.

If something breaks, run `npx tsx scripts/p0-smoke-test.ts` first — it catches 80% of regressions in <5 seconds.
