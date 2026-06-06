# Activity Agent — Handoff Document

> Status as of 2026-06-06. Read this before continuing the project.

## TL;DR

SOP-v2 (8-phase, 12-tool, single-confirm + 1-clarify) is **complete and verified end-to-end** against a real LLM. 17 atomic git commits, 80 files, ~37k LOC. `/activity` UI page shipped with phase progress, plan timeline, tool waterfall, and booking card. 94/94 smoke + 24/24 e2e tests pass. The codebase is in a good state to pause or extend.

A reusable skill capturing the SOP-v2 design pattern has been extracted to `~/.agents/skills/phase-gated-agent/SKILL.md` (see "Reusable artifacts" below).

## What's built

### Backend (verified)
- **8-phase state machine** — `lib/plan-state.ts`. `idle → intent_capture → clarifying → planning → plan_confirm → executing → completed/cancelled`. Explicit `PHASE_TRANSITIONS` DAG.
- **12 custom activity tools** — `src/tools/activity-tools.ts`. Each wrapped with retry/timeout/metrics + phase guard.
- **TOOL_PHASE_RULES** — strict tool-to-phase whitelist. E.g. `reservation_exec: ["executing"]` only. Wrapper returns `PHASE_GUARD` for illegal calls.
- **submitPlan defense** — `intent_parse` body self-validates `submitPlan:true` is only legal in `planning` (layer 3 defense in depth).
- **1-clarify hard limit** — `MAX_CLARIFICATIONS = 1`. `ask_clarification` body rejects the 2nd call.
- **Plan state persistence** — `~/.pi/agent/plan-states/<sessionId>.json` written on every transition via a write queue.
- **Real services** — POI database (34 entries), deterministic weather, route calculator, opening hours parser, booking state machine. All mock APIs designed for swap-in with 高德 / 和风 / 大众点评.

### Frontend (verified)
- **Generic pi-web shell** at `/` — 14 React components, full session management, file viewer, etc. (preexisting, untouched).
- **Activity-specific UI** at `/activity` — NEW. 2-pane layout: chat left, activity panel right.
  - **PhaseProgress** — 8-step horizontal bar with current-phase glow, completed checkmarks, status pill ("turn N · clarification M/1").
  - **PlanTimeline** — vertical timeline of plan legs (departure/transit/activity/meal icons + colors), weather summary, totals (duration/cost/legs).
  - **ToolTimeline** — waterfall of all tool calls with name/icon/args/duration, red BLOCKED badge for `PHASE_GUARD` hits.
  - **BookingCard** — gradient-tinted order confirmation (restaurant/date/time/party/确认码/订单号), extracted from `reservation_exec` / `query_booking` results.
- **API for plan state** — `GET /api/plan-state/[id]`. Powers the UI's 1.5s polling.

### Tests (verified)
- `scripts/p0-smoke-test.ts` — **94/94 pass** (was 90, +2 for `submitPlan` rejection, +2 for `retry_booking` assertions). No API key needed.
- `scripts/e2e-real-llm-test.ts` — **24/24 pass** against `deepseek/deepseek-v4-pro`. Real LLM, real booking, real confirmation code.

## What's NOT done

Out of scope for the current milestone:

- **Real API integration** (高德/和风/大众点评) — mock services work but are deterministic. Needs API keys + ¥ + production hardening.
- **User profile / memory** — no persistence of preferences (素食/无烟/历史去过) across sessions. P1 in `BUSINESS_ANALYSIS_REPORT.md`.
- **Multi-day trip support** — current SOP is single-day. State machine would need extension.
- **Production auth / rate limiting** — dev server only.
- **i18n** — UI is Chinese-only, prompt is Chinese-only.
- **Cost / metrics dashboard** — token usage is collected but not surfaced in the UI.
- **Hard-constraint enforcement** — current constraints (date, budget, party size) are in the prompt. A future "hard mode" should put them in `PlanStateManager` as gates that block `plan_save` if violated.

## Reusable artifacts

- **`~/.agents/skills/phase-gated-agent/SKILL.md`** — Skill capturing the SOP-v2 design pattern. Use it as a starting point for any new agent that needs strict workflow enforcement. Covers: 8-phase design, 3-layer defense (TOOL_PHASE_RULES + PHASE_TRANSITIONS + tool-body self-check), persistence pattern, common pitfalls, and a quick checklist.

- **`lib/plan-state.ts` + `src/tools/activity-tools.ts`** — Drop-in reference implementation. Adapt the 12 tools to your domain (replace POI/weather/booking with your domain's data + side effects), keep the phase machine.

- **`scripts/e2e-real-llm-test.ts` + `hooks/useActivitySession.ts`** — E2E test + UI hook pattern. The HTTP-client-e2e sidesteps the `pi-coding-agent@0.75.5` CJS exports issue (its `package.json` exports only `"import"`, no CJS condition — `tsx@4.x` CJS register fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`).

## Key files (for a new contributor)

| What | Where |
|---|---|
| Phase machine | `lib/plan-state.ts` |
| 12 tool definitions | `src/tools/activity-tools.ts` |
| Tool wrapper (retry/timeout/metrics) | `lib/tool-wrapper.ts` |
| LLM prompt | `src/prompts/activity-planner.ts` |
| Session orchestration (agent start, advancePlanPhase) | `lib/rpc-manager.ts` |
| API for plan state (UI polling) | `app/api/plan-state/[id]/route.ts` |
| Activity UI page | `app/activity/page.tsx` |
| Activity panel components | `components/activity/*.tsx` |
| Activity session hook (SSE + poll) | `hooks/useActivitySession.ts` |
| Smoke test | `scripts/p0-smoke-test.ts` |
| E2E test | `scripts/e2e-real-llm-test.ts` |
| Project knowledge base | `AGENTS.md` |
| Tech report | `INTEGRATION_REPORT.md` (1175 lines) |
| PRD gap analysis | `BUSINESS_ANALYSIS_REPORT.md` (666 lines) |

## Critical gotchas (read these before changing anything)

1. **Phase guard must run BEFORE the tool body.** `guardToolCallWithActive` is called from the tool wrapper's `beforeExecute`. If you accidentally call it from inside the body, side effects may already have happened.

2. **The plan state file is the source of truth for the UI.** The UI polls `~/.pi/agent/plan-states/<sessionId>.json` directly. The in-memory `PlanStateManager.current` may diverge if a write is in flight. The file is always the latest *persisted* state.

3. **`intent_parse(submitPlan:true)` from `plan_confirm` or `executing` is a BUG.** Not just discouraged — actively rejected. The fix is in `src/tools/activity-tools.ts` (layer 3) and `TOOL_PHASE_RULES` (layer 1). Don't relax either.

4. **`reservation_exec` must NEVER be allowed in `plan_confirm`.** Original bug discovered during e2e testing — LLM would call it before user confirms. The fix is in `TOOL_PHASE_RULES.reservation_exec: ["executing"]`. Don't add `plan_confirm` to that list.

5. **`MAX_CLARIFICATIONS = 1` is HARD.** Don't raise it without rethinking the SOP — the prompt and the user experience both assume exactly one clarification round.

6. **`tsx@4.x` cannot directly import `pi-coding-agent@0.75.5`** (CJS exports issue). E2E test is an HTTP client. Any new test that imports the SDK directly will fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

7. **Template literal escape gotcha in prompt.** Inside a JS template literal (backtick-wrapped), backticks MUST be escaped as `\``. Unescaped backticks close the outer string. The Chinese SOP prompt has multiple `phase: \`xxx\`` references that the LLM-parser later copies. If you edit the prompt and lose the escape, tsc will fail with a confusing error.

8. **`tsconfig.tsbuildinfo` is gitignored** (it's a build artifact). Delete it manually before `tsc --noEmit` if you see stale type errors.

9. **The dev server is running** (pid stored in `/tmp/next-dev.log` startup, port 30142). To restart: `pkill -f "next dev" && nohup npm run dev > /tmp/next-dev.log 2>&1 &`.

## Test commands

```bash
# Type check
node_modules/.bin/tsc --noEmit                # exit 0

# Smoke (no API key, ~5s)
npx tsx scripts/p0-smoke-test.ts              # 94/94 pass

# E2E (real LLM, ~2 min for 2 turns)
# Requires: dev server running + auth.json with API key + settings.json with default model
npm run e2e:real                              # 24/24 pass
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
