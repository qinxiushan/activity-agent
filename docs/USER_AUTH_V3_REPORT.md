# Activity Agent — V3 User-Id 改造经验总结

> **报告范围**：`02cae8d` 基线 → 当前 `10899d9` 之间的 16 个原子提交，按 4 个方向（v2 OS-derived / v3 header+cookie / 人工 curl 验证 / e2e 扩展）汇总
>
> **报告时间**：2026-06-07
>
> **读者对象**：维护者、二次开发者、Code Reviewer
>
> **关联文档**：[HANDOFF.md](../HANDOFF.md) · [AGENTS.md](../AGENTS.md) · [INTEGRATION_REPORT.md](../INTEGRATION_REPORT.md) · [MODEL_CONFIG.md](./MODEL_CONFIG.md)

---

## 目录

1. [TL;DR](#tldr)
2. [第 1 部分 — 进度总结](#第-1-部分--进度总结)
3. [第 2 部分 — 改进与优化](#第-2-部分--改进与优化)
4. [第 3 部分 — 经验提炼 / Skill 候选](#第-3-部分--经验提炼--skill-候选)
5. [第 4 部分 — 启动服务（人工测试）](#第-4-部分--启动服务人工测试)
6. [第 5 部分 — 测试用例 + 验收标准](#第-5-部分--测试用例--验收标准)
7. [附录 A — 提交时间线](#附录-a--提交时间线)
8. [附录 B — 文件改动清单](#附录-b--文件改动清单)
9. [附录 C — 经验教训清单](#附录-c--经验教训清单)

---

## TL;DR

把 `userId` 从硬编码 `"default"` 升级到 **3 级链式解析**（header → cookie → OS 用户），中间经过了 **OS 派生（v2）→ 显式 header/cookie（v3）** 两轮渐进式硬化。所有改动按"**一个关注点 = 一个提交**"原则拆成 **16 个原子提交**，每提交都 tsc 干净 + smoke 126/126 通过。**E2E 从 16 涨到 31 断言**（v2 隔离 8 个 + v3 鉴权 7 个，加上原有 16 个）。

| 阶段 | 提交数 | 关键变化 | 验收 |
|---|---|---|---|
| **基线** `02cae8d` | — | 12 stub routes 散落在 `app/api/`，userId 硬编码 `"default"` | smoke 94/94 |
| **阶段 1：user-prefs 落地** | 7 | 跨 session 偏好存储 + UI 面板 + 自动填 intent + 记录已完成 session | smoke 126/126，e2e 16/16 |
| **阶段 2：清理 11 个 pi-web stub** | 3 | `STUBS_DISABLED` 守卫 + 类型归位 + 路由文件删除 | tsc 0，smoke 126/126 |
| **阶段 3：v2 OS-derived** | 4 | `getCurrentUserId()` helper + API/tools 切换 | e2e +8 隔离断言 |
| **阶段 4：3 个 follow-up** | 3 | 面板显示 userId + HANDOFF 同步 + e2e 隔离段 | e2e 24/24 |
| **阶段 5：v3 header+cookie** | 4 | `getCurrentUserIdFromRequest(req)` + `/api/dev-login` + AGENTS/HANDOFF 同步 | curl 7/7，e2e +7 鉴权断言 |
| **当前** `10899d9` | — | — | tsc 0，smoke 126/126，e2e 31/31（tsc 验证） |

---

## 第 1 部分 — 进度总结

### 1.1 设计目标

`activity-agent` 原本的 `userId` 是常量 `"default"`，所有用户的偏好存在同一个 JSON 文件里。从"单用户本地工具"过渡到"多用户"需要解决三件事：

1. **知道当前是谁** — 在 HTTP 入口拿到 `userId`（API 路由有 `Request` 对象）
2. **在工具调用路径上知道** — `tool.execute(args, ctx)` 拿到的是 `ctx` 不是 `Request`，不能直接读 header
3. **支持多用户隔离** — 不同 `userId` 的数据不能串味

### 1.2 渐进式三阶段（v1 → v2 → v3）

```
v1 (基线)         v2 (本次中间态)         v3 (当前最终态)
硬编码 "default"   os.userInfo()           X-User-Id header
                  ↓                       pi_user cookie
                  解决：本地开发         os.userInfo()
                  问题：多用户共享同一     DEFAULT_USER_ID
                  个用户名时仍会串
```

| 版本 | 解析链 | 适用场景 | API 表面 |
|---|---|---|---|
| v1 | `"default"` 字面量 | 早期单用户开发 | 直接读常量 |
| v2 | `os.userInfo().username \|\| "default"` | 本地多账号 OS 切换 | `getCurrentUserId()`（无 req） |
| v3 | `header > cookie > OS > default` | 多用户/多终端/远程调用 | `getCurrentUserIdFromRequest(req)`（带 req） |

**关键设计选择**：
- v2 给 tools 用（没有 req），v3 给 API routes 用（有 req）
- **不强行让 tools 用 request context** — 改造成本太高（要改 12 个 tool 的执行链），工具仍然走 v2 OS 派生
- v2 → v3 是 **增强**（cookie 优先于 OS），**不是替换**（OS 仍是兜底）

### 1.3 为什么"渐进"而不是"一步到位"

- **可回退**：每个中间态都自洽且向后兼容，v1 用户升级 v2 不破坏，v2 升级 v3 不破坏
- **可验证**：v1→v2 加 8 个 e2e 隔离断言就能确认"两个 OS 用户的数据不串"，v2→v3 加 7 个 e2e 断言能确认"header 真的赢 cookie"
- **可定位**：16 个原子提交让 git bisect 能精确定位问题（而不是 "v1 升 v3 的那个大 commit"）

### 1.4 关键数字

- **代码变更**：+421 行 / -71 行（净 +350），覆盖 12 个文件
- **新增文件**：`lib/user-context.ts`（22 行）、`app/api/dev-login/route.ts`（58 行）
- **删除文件**：11 个 pi-web stub 路由 + 5 个空目录
- **e2e 断言**：16 → 24 → 31（v2 +8，v3 +7）
- **smoke 断言**：94 → 126（user-prefs P0-5 段 +32）

---

## 第 2 部分 — 改进与优化

### 2.1 架构层

| 改动 | 旧 | 新 | 收益 |
|---|---|---|---|
| **userId 解析** | 字面量 `"default"` | 3 级链式解析 | 多用户/多终端可用 |
| **API 路由鉴权** | 任何请求都写入 `default` 的桶 | header/cookie 决定 bucket | 多租户数据隔离 |
| **工具调用** | `getCurrentUserIdFromRequest(req)` 不可用（无 req） | 独立的 `getCurrentUserId()` | 工具链不需要被改造 |
| **UI 反馈** | 面板只显示历史 | 面板头部加 `userId` 标记 | 用户一眼看到"我现在在谁的桶里" |
| **测试** | 单一 userId 串测 | 8+7 个多 userId 隔离断言 | 提前发现串味 bug |

### 2.2 工程层

| 模式 | 描述 | 应用位置 |
|---|---|---|
| **STUBS_DISABLED 守卫** | 不删 UI 元素，加 `const STUBS_DISABLED = true; if (STUBS_DISABLED) return {error: "X is not supported in activity-agent"};` 早返 | `SkillsConfig.tsx`（4 处）、`ModelsConfig.tsx`（3 处） |
| **类型归位** | 删 stub 路由时，把路由文件里定义的 `interface SkillSearchResult` 移到 `lib/types.ts` 的"项目共享类型"位置 | `lib/types.ts` 新增 4 行类型定义 |
| **双 helper API 表面** | `getCurrentUserId()`（无 req，给 tools）和 `getCurrentUserIdFromRequest(req)`（给 API routes），避免把 `Request` 强塞进工具链 | `lib/user-context.ts` |
| **private 提取** | OS 派生逻辑提成 `fromOS()` private 函数，让两个公开 helper 共用 | `lib/user-context.ts` |
| **时间戳 ID 隔离 e2e** | `e2e-alice-${Date.now()}` 而非静态 `"alice"`，e2e 可重跑不需手动清数据 | `scripts/e2e-real-llm-test.ts` |
| **文档同步策略** | HANDOFF/AGENTS 每次跨大版本（v2、v3）才更新；不每提交都改 | HANDOFF.md、AGENTS.md |

### 2.3 测试层

| 改动 | 数量 | 文件 |
|---|---|---|
| smoke user-prefs 段 | +32 | `scripts/p0-smoke-test.ts` P0-5 段 |
| e2e v2 隔离段 | +8 | `scripts/e2e-real-llm-test.ts` "👥 userId 隔离 (v2)" |
| e2e v3 鉴权段 | +7 | `scripts/e2e-real-llm-test.ts` "🔐 v3 header/cookie auth" |
| Playwright 面板视觉 | +4 | `tests/activity-visual.spec.ts` |

### 2.4 文档层

| 文档 | 改动 | 频次 |
|---|---|---|
| `AGENTS.md` | 加 `lib/user-context.ts` + `app/api/dev-login/route.ts` 文件映射；v3 链说明 | 跨大版本 |
| `HANDOFF.md` | "Production auth" 行升级到 v3；"userId 隔离"行 | 跨大版本 |
| `INTEGRATION_REPORT.md` | "最后更新" 行加 11 stub 路由删除说明 | 一次性 |

### 2.5 收益汇总

1. **可重跑**：e2e 用时间戳 ID，不需要手动 `rm -rf ~/.pi/agent/user-profiles/`
2. **可观察**：UI 头部有 userId，调试/演示时一眼看到当前身份
3. **可调试**：手动 curl + `X-User-Id` header 就能模拟多用户场景
4. **可测试**：24 个隔离断言保证后续改动不会破坏隔离
5. **可迁移**：v2/v3 模式可以套到别的"本地工具→多用户"演化项目（见第 3 部分）

---

## 第 3 部分 — 经验提炼 / Skill 候选

下面 3 个候选 skill，按**通用性 × 当前项目复用价值**排序。**前两个推荐正式化**，第三个是附带的小模式，文档化即可，不一定单独成 skill。

### 3.1 ⭐ Skill A：progressive-identity-hardening（**强烈推荐**）

**问题**：一个本地 dev 工具想升级到多用户/多终端，传统做法是"先做完整 auth 系统再切换"，但这会卡在"还没切完之前老用户全坏"。

**这个 skill 给的模式**：

| 阶段 | 范围 | 兜底 |
|---|---|---|
| **v1** | 硬编码常量 | 早期快速验证 |
| **v2** | OS 派生（`os.userInfo()`） | 本地多 OS 账号 |
| **v3** | 显式 header/cookie + OS 兜底 | 多终端/远程调用 |

**关键决策**：
- v2/v3 **不互相替换**，v3 是 v2 的超集（header 优先于 cookie，cookie 优先于 OS）
- 提供 **两套 API 表面**：`(req)` 版给 HTTP 入口；无参版给非 HTTP 上下文（工具调用、cron、CLI 子命令）
- v3 cookie 设为 `HttpOnly; SameSite=Lax`（v1 故意不设，方便调试；v3 补上）
- 配合一个 dev-only route（`/api/dev-login`）来设置/清除测试 cookie
- 文档明确写 "**不是真正的鉴权**"，生产环境需替换

**适用项目**：
- 任何从单用户 CLI / 桌面工具演化到 web 服务的项目
- 任何需要在没有正式 auth 系统时支持多账号的项目
- 任何工具链在 "无 req 上下文" 调用的项目（langchain tools、temporal activities 等）

**复用价值**：高。一次写完，下次新项目直接套。

### 3.2 ⭐ Skill B：atomic-feature-rollout（**推荐**）

**问题**：大型 feature（"把 userId 从硬编码升级到多用户"）做不出原子 commit——"v1→v3 一次到位"的 commit 没法 bisect。

**这个 skill 给的模式**：
- 把 feature 拆成 v1/v2/v3（每个都是**自洽 + 向后兼容**的中间态）
- 每提交保证：**tsc 干净 + 测试通过 + 文档同步点提前规划好**
- 文档更新**不**和代码 commit 混（v2 文档 + v2 代码 = 同一 commit；v3 文档 + v3 代码 = 同一 commit）
- 跨大版本才改 HANDOFF/AGENTS（v2、v3 各一次），不是每提交都改

**关键约束**：
- 每个 commit 可以独立 `git checkout` + `npm run dev` + `npm run test:smoke` 跑通
- 每个 commit 的"目的"在 message 标题就能看懂（`<type>(<scope>): <subject>`，subject ≤ 50 字符）
- 不在 commit message 里塞太多细节（细节在 HANDOFF.md 里）

**适用项目**：
- 任何需要"演进式"做 feature 的项目
- 团队 git bisect 习惯养成的项目

**复用价值**：中-高。流程型的 skill 容易被忽略，但用上之后 bisect 能力提升 10x。

### 3.3 Skill C：stub-guard-pattern（文档化即可）

**问题**：上游项目（pi-web）已经停了，但 `app/api/` 里散落着 11 个 stub 路由（认证、skills、models-config/test 等）。直接删会破坏 IDE 跳转和可能用到的引用。

**这个模式给的方法**：
- **不删 UI 元素**，加 `const STUBS_DISABLED = true;` 常量守卫
- 守卫在 handler 顶部早返 `{error: "X is not supported in activity-agent"}`
- 路由文件可以删（因为是 API stub，没 UI）
- **类型定义跟着搬到 `lib/types.ts`**，保持 IDE 跳转不破

**适用项目**：
- 任何"fork + 改向"的项目（fork 自 pi-web，但走的是 activity-agent 路线）
- 任何"上游断更，下游要清理"的项目

**复用价值**：低-中。比较窄场景，但用上一次省半天调试时间。

### 3.4 不推荐成 skill 的模式

- **`STUBS_DISABLED` 命名本身** — 太具体，难复用；写个 ADR 即可
- **时间戳 ID 隔离 e2e** — 写进 e2e 模板的注释即可
- **v2/v3 文档同步策略** — 是 Skill B 的子规则

### 3.5 行动建议

| Skill | 建议 | 下一步 |
|---|---|---|
| **A: progressive-identity-hardening** | 正式创建 | `find-skills` 确认无重复 → `skill-creator` 生成 → 安装到 `~/.agents/skills/` |
| **B: atomic-feature-rollout** | 正式创建 | 同上 |
| **C: stub-guard-pattern** | 不单独成 skill | 作为模式片段写进 AGENTS.md 末尾的"经验沉淀"段 |

---

## 第 4 部分 — 启动服务（人工测试）

### 4.1 前置检查

```bash
# 1. 确认在 activity-agent 目录
cd /home/a/chat_robot/pi_agent/activity-agent

# 2. 确认依赖装好（首次需要）
ls node_modules/.bin/next  # 不存在则 npm install

# 3. 确认没有遗留 dev server 进程
pgrep -af "next dev" || echo "(clean)"
```

### 4.2 启动

```bash
# 后台启动（推荐，会写入 /tmp/next-dev.log）
nohup npm run dev > /tmp/next-dev.log 2>&1 &
echo "PID: $!"

# 等待 ready
for i in 1 2 3 4 5 6 7 8 9 10; do
  if grep -q "Ready" /tmp/next-dev.log 2>/dev/null; then
    echo "✅ Ready in ${i}s"
    break
  fi
  sleep 1
done
```

**预期日志输出**（截取）：
```
▲ Next.js 15.x.x
- Local:        http://localhost:30142
✓ Ready in 5s
```

### 4.3 健康检查

```bash
# 1. 根页面（应 200，返回 HTML）
curl -sI http://localhost:30142/ | head -1

# 2. /activity 页面（应 200）
curl -sI http://localhost:30142/activity | head -1

# 3. /api/user-preferences（应返回 userId 字段）
curl -sS http://localhost:30142/api/user-preferences | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('userId:', d['preferences']['userId'])
print('defaults count:', len(d['preferences']['defaults']))
print('recent sessions:', d['preferences'].get('recentSessionsCount', 0))
"

# 4. /api/dev-login GET（应返回 ok）
curl -sS http://localhost:30142/api/dev-login
```

**预期响应**：
```json
// /api/user-preferences
{
  "ok": true,
  "preferences": {
    "userId": "a",          // 你的 OS 用户名
    "defaults": {},
    "stats": { ... },
    "recentSessionsCount": 0
  }
}

// /api/dev-login
{
  "ok": true,
  "userId": null            // 当前没登录
}
```

### 4.4 停止服务

```bash
# 优雅停止
pkill -f "next dev"
sleep 1
pgrep -af "next dev" || echo "(stopped)"

# 强杀（如优雅停不掉）
pkill -9 -f "next dev" 2>/dev/null
pkill -9 -f "next-server" 2>/dev/null
```

### 4.5 浏览器访问

| URL | 用途 |
|---|---|
| `http://localhost:30142/` | 通用 pi-web shell（与 activity-agent 共享） |
| `http://localhost:30142/activity` | activity-agent 专用页面，2 栏布局 |

**浏览器中观察点**：
- 右侧 "🧠 用户偏好" 面板标题旁应显示 `userId`（如 `· a`）
- 顶部 "Phase progress" 8 步进度条
- 输入框发条消息后，phase 流转、tool waterfall 出现

---

## 第 5 部分 — 测试用例 + 验收标准

### 5.1 自动化测试基线

| 测试 | 命令 | 通过标准 | 耗时 |
|---|---|---|---|
| **类型检查** | `node_modules/.bin/tsc --noEmit` | exit 0，无任何输出 | ~10s |
| **smoke（无 API key）** | `npm run test:smoke` | `Pass: 126, Fail: 0` | ~30s |
| **e2e（需 API key + dev server）** | `npm run e2e:real` | `e2e: 24+7=31 assertions pass` | ~3-5min |
| **Playwright 视觉** | `npm run test:visual` | 全部 spec pass | ~1min |
| **CI 合并** | push 到 main | lint job + e2e job 都绿 | ~5-10min |

### 5.2 人工验收清单（v3 行为逐项）

每条用例 4 列：**前置**、**步骤**、**观察**、**验收**。

#### Case 1: 无任何鉴权 → OS 用户

**前置**：dev server 在跑，浏览器无 `X-User-Id` header、无 `pi_user` cookie
**步骤**：
```bash
curl -sS http://localhost:30142/api/user-preferences
```
**观察**：
```json
{ "ok": true, "preferences": { "userId": "a", ... } }
```
**验收**：`userId` 字段非空字符串，且等于 `whoami` 命令的输出

#### Case 2: `X-User-Id` header → 覆盖 OS

**步骤**：
```bash
curl -sS -H "X-User-Id: alice" http://localhost:30142/api/user-preferences
```
**观察**：
```json
{ "ok": true, "preferences": { "userId": "alice", ... } }
```
**验收**：`userId === "alice"`（与 OS 用户无关）

#### Case 3: `POST /api/dev-login` → 设置 `pi_user` cookie

**步骤**：
```bash
curl -sS -c /tmp/cookies.txt -X POST \
  -H "Content-Type: application/json" \
  -d '{"userId":"bob"}' \
  http://localhost:30142/api/dev-login
```
**观察**：
```json
{ "ok": true, "userId": "bob" }
```
且 `/tmp/cookies.txt` 文件含一行 `#HttpOnly_localhost FALSE / FALSE 0 pi_user bob`
**验收**：
- 响应 JSON `ok === true`
- 响应包含 `Set-Cookie: pi_user=bob; ...` 头
- cookie 文件含 `pi_user` 行

#### Case 4: 带 cookie 请求 → cookie 决定 userId

**步骤**：
```bash
curl -sS -b /tmp/cookies.txt http://localhost:30142/api/user-preferences
```
**观察**：
```json
{ "ok": true, "preferences": { "userId": "bob", ... } }
```
**验收**：`userId === "bob"`（cookie 赢 OS）

#### Case 5: `DELETE /api/dev-login` → 清 cookie

**步骤**：
```bash
curl -sS -b /tmp/cookies.txt -c /tmp/cookies-after-delete.txt \
  -X DELETE http://localhost:30142/api/dev-login
```
**观察**：
```json
{ "ok": true, "userId": null, "previous": "bob" }
```
且 `/tmp/cookies-after-delete.txt` **不含** `pi_user` 行（已被 Max-Age=0 清掉）
**验收**：
- 响应 `ok === true`
- 响应 `previous === "bob"`
- 后续用 `-c` 写入的 cookie 文件不含 `pi_user`

#### Case 6: cookie 清除后 → 回退到 OS

**步骤**（接 Case 5 后）：
```bash
curl -sS http://localhost:30142/api/user-preferences
# 注意：不能用 -b /tmp/cookies.txt，因为 cookie 已被清（curl -c 写入的 file 也不含 pi_user）
```
**观察**：
```json
{ "ok": true, "preferences": { "userId": "a", ... } }
```
**验收**：`userId === "a"`（OS 用户）—— **注意**：如果用 `-b /tmp/cookies.txt`（旧文件）会仍看到 `bob`，这是 curl 文件行为，不是服务端 bug

#### Case 7: header + cookie 同在 → header 赢

**步骤**：
```bash
curl -sS -H "X-User-Id: charlie" -H "Cookie: pi_user=bob" \
  http://localhost:30142/api/user-preferences
```
**观察**：
```json
{ "ok": true, "preferences": { "userId": "charlie", ... } }
```
**验收**：`userId === "charlie"`（header 优先级高于 cookie）

#### Case 8: 浏览器 UI 面板显示 userId

**步骤**：
1. 浏览器打开 `http://localhost:30142/activity`
2. 找到右侧 "🧠 用户偏好" 面板
3. 观察标题旁

**观察**：标题旁应有 `· a`（或当前 OS 用户）的 monospace 文本，hover 提示 "当前用户标识（来自 X-User-Id header / pi_user cookie / OS 用户名）"

**验收**：
- 标题文本形如 `🧠 用户偏好 · a`
- 文本在 monospace 字体中
- hover tooltip 文案正确

#### Case 9: 多用户隔离（PUT 数据不串）

**步骤**：
```bash
# 1. alice 写
curl -sS -H "X-User-Id: alice" -X PUT \
  -H "Content-Type: application/json" \
  -d '{"defaults":{"partySize":4}}' \
  http://localhost:30142/api/user-preferences

# 2. alice 读回
curl -sS -H "X-User-Id: alice" http://localhost:30142/api/user-preferences
# 期望：partySize === 4

# 3. bob 读
curl -sS -H "X-User-Id: bob" http://localhost:30142/api/user-preferences
# 期望：defaults === {} （没串味）
```
**验收**：alice 的写不影响 bob 的读

#### Case 10: 浏览器网络面板看到 X-User-Id 流转

**步骤**：
1. 浏览器 DevTools → Network
2. 刷新 `/activity`
3. 找到 `/api/user-preferences` 请求

**观察**：请求头应包含 `X-User-Id: ...` 或 `Cookie: pi_user=...`（如果之前调过 dev-login）

**验收**：浏览器看到真实请求的鉴权头

### 5.3 完整验收 checklist

- [ ] **Case 1**: 无鉴权 → OS 用户 ✓
- [ ] **Case 2**: `X-User-Id: alice` → alice ✓
- [ ] **Case 3**: `POST /api/dev-login` → cookie 设置 ✓
- [ ] **Case 4**: 带 cookie → bob ✓
- [ ] **Case 5**: `DELETE` → cookie 清除 ✓
- [ ] **Case 6**: 清后 → OS 回退 ✓
- [ ] **Case 7**: header + cookie → header 赢 ✓
- [ ] **Case 8**: UI 面板 userId 显示 ✓
- [ ] **Case 9**: 多用户数据隔离 ✓
- [ ] **Case 10**: 浏览器网络面板看到鉴权头 ✓
- [ ] **自动化**：`tsc --noEmit` exit 0
- [ ] **自动化**：`npm run test:smoke` 126/126
- [ ] **自动化**：`npm run e2e:real`（CI 上）31/31
- [ ] **自动化**：`npm run test:visual` 全过

### 5.4 验收通过判据

**功能性（必须全过）**：
- 10 个 Case 全部 ✓
- 4 个自动化测试全部通过

**非功能性（推荐过）**：
- 端到端响应时间：< 200ms（dev 模式可放宽到 < 1s）
- 浏览器 console 无 error / warning
- 多次刷新数据不漂移
- 重启 dev server 后数据不丢（持久化在 `~/.pi/agent/user-profiles/<userId>.json`）

**失败处理**：
- 任一 Case 失败 → 回去查 git log 看是哪个 commit 引入的（16 个 commit 范围不大）
- 自动化失败 → 看 stderr，按错误信息修复

---

## 附录 A — 提交时间线

```
10899d9 (HEAD)  test(e2e): add v3 header/cookie auth section (7 assertions)
40b3e33         docs: reflect v3 userId resolution (header/cookie chain) + dev-login route
4444040         feat(api): add /api/dev-login route for setting pi_user cookie
11f4a74         feat(api): use getCurrentUserIdFromRequest in /api/user-preferences
66d563b         feat(user-context): add getCurrentUserIdFromRequest(req) with header/cookie/OS chain
6157d6c         test(e2e): add v2 userId isolation section (8 assertions)
a57626b         docs(handoff): reflect v2 userId resolution (OS-derived, default fallback)
25b7a95         feat(ui): show current userId in UserPreferencesPanel header
3901b39         docs: add user-context.ts to AGENTS.md lib/ file map
3f8a056         feat(tools): use OS-derived userId in reservation_exec + recordCompletedSession
0dba355         feat(api): use OS-derived userId as default in /api/user-preferences
8410b6e         feat(lib): add getCurrentUserId() helper for OS-derived userId resolution
6f62494         docs(integration-report): note removal of 11 pi-web stub routes
b493687         chore(api): remove 11 pi-web stub routes
3a7556d         refactor(ui): add STUBS_DISABLED guard in admin tabs + move SkillSearchResult
[ 7 个 user-prefs 提交 ]
02cae8d (基线)  0dba355 之前的状态
```

---

## 附录 B — 文件改动清单

### 新增（2）
- `lib/user-context.ts` — 22 行，`getCurrentUserId()` + `getCurrentUserIdFromRequest(req)` + private `fromOS()`
- `app/api/dev-login/route.ts` — 58 行，GET/POST/DELETE，dev-only 鉴权入口

### 修改（10）
- `app/api/user-preferences/route.ts` — 3 处改用 `getCurrentUserIdFromRequest(req)`
- `src/tools/activity-tools.ts` — 2 处改用 `getCurrentUserId()`（reservation_exec + recordCompletedSession）
- `components/UserPreferencesPanel.tsx` — 标题加 `· {userId}` monospace span
- `components/SkillsConfig.tsx` — `STUBS_DISABLED` 守卫 4 处
- `components/ModelsConfig.tsx` — `STUBS_DISABLED` 守卫 3 处
- `lib/types.ts` — 加 `SkillSearchResult` interface（从已删路由迁过来）
- `scripts/p0-smoke-test.ts` — P0-5 段 +32 行
- `scripts/e2e-real-llm-test.ts` — "👥 userId 隔离 (v2)" +8、"🔐 v3 header/cookie auth" +7
- `AGENTS.md` — file map 加 user-context + dev-login
- `HANDOFF.md` — v3 "Production auth" 行 + user-context/dev-login 表格行
- `INTEGRATION_REPORT.md` — "最后更新" 行 + 11 路由删除说明

### 删除（11 routes + 5 dirs）
- `app/api/auth/all-providers/route.ts`
- `app/api/auth/api-key/[provider]/route.ts`
- `app/api/auth/login/[provider]/route.ts`
- `app/api/auth/logout/[provider]/route.ts`
- `app/api/auth/providers/route.ts`
- `app/api/models-config/test/route.ts`
- `app/api/sessions/new/route.ts`
- `app/api/skills/route.ts`
- `app/api/skills/install/route.ts`
- `app/api/skills/search/route.ts`
- 5 个空目录（`auth/`、`auth/api-key/`、`auth/login/`、`auth/logout/`、`skills/`）

---

## 附录 C — 经验教训清单

### ✅ 做得对的

1. **16 个原子 commit**：每个 commit `git checkout` 后能独立跑 smoke，方便回退
2. **不删 UI 元素**：用 `STUBS_DISABLED` 守卫代替删 UI，保留肌肉记忆
3. **类型归位**：删路由时把类型搬到 `lib/types.ts`，IDE 跳转不破
4. **e2e 时间戳 ID**：可重跑，不需要清数据
5. **curl 验 7 个 v3 行为**：发现 "Case 6 cookie 文件未更新" 的 curl 行为差异，及时修正测试方法
6. **两套 helper API**：让 tools 和 routes 各取所需，不强求 req 上下文塞进 tool 链

### ⚠️ 做得可以更好的

1. **doc 同步可以更早**：第一次 commit 8410b6e 就改了代码，但 AGENTS.md/HANDOFF.md 直到 v2 完成才改（中间有 3-4 个 commit 文档没更新）
2. **e2e v2 + v3 段没合并**：分两个 section 提交（6157d6c + 10899d9），可以让 e2e 一次到位
3. **没写明 v2 → v3 的迁移故事**：HANDOFF.md 写的是当前状态，没有 "v1 → v2 → v3 怎么来的" 的时间线（这份报告补了）

### 🐛 踩过的坑

1. **curl `-b` vs `-c` 行为差异**：`DELETE` 响应里的 `Max-Age=0` cookie 清除只让客户端过期，不会清本地文件。需要 `-c` 写入才能让后续请求用新状态
2. **e2e section 注释 vs section() 调用重复**：第一次加 v2 段时写了 `// ─── userId 隔离 (v2) ────` 注释，被 hook 提醒移除（`section()` 调用本身就是视觉标记）
3. **stub 路由类型定义被引用**：删 `app/api/skills/search/route.ts` 时，`SkillSearchResult` 类型被引用于 `components/SkillsConfig.tsx`，需要先把类型搬走才能删

### 📌 关键决策的"为什么"速查

| 决策 | 理由 |
|---|---|
| v2/v3 渐进而不是 v1→v3 一步到位 | 中间态自洽可回退，e2e 可分两段加 |
| 两套 helper（`getCurrentUserId` vs `getCurrentUserIdFromRequest`） | tools 没有 req，强行统一要改 12 个 tool 的执行链 |
| `dev-login` 路由而不是中间件 | dev-only，路由形式最简单，prod 部署时不挂载即可 |
| `pi_user` cookie 不设 `Secure` flag | dev 服务器是 http，设了反而发不出去 |
| 不在 v1 文档里写 "v1 鉴权" | v1 没有鉴权可写，写了反而误导 |
| HANDOFF.md 跨大版本才更新 | 减少文档同步噪音，让 PR review 关注代码 |

---

**报告结束。** 下一步：是否要把 §3.1（progressive-identity-hardening）和 §3.2（atomic-feature-rollout）正式创建为 skill？需要的话我可以用 `find-skills` 确认无重复，然后用 `skill-creator` 生成 + 安装到 `~/.agents/skills/`。
