# [improvement] Stage 2 T3 必选认证与会话归属隔离

> `AUTH_MODE=required` 从“有配置骨架”补齐为“可登录、可验收、可隔离”的完整实现。

---

## 1. 元信息

| 字段 | 值 |
|------|-----|
| **日期** | 2026-07-18 |
| **类型** | `improvement` |
| **严重度** | `P1 高` |
| **修改文件数** | 26 |
| **触发方式** | 手动触发 |
| **关联 Issue** | 无 |

---

## 2. 问题描述

### 2.1 现象

虽然仓库已经进入第二阶段并开始做 T3，但 `AUTH_MODE=required` 仍然不能作为完整功能使用：

- 未登录访问首页没有稳定跳转到登录页
- 会话和 `plan_state` 没有按 `userId` 做归属隔离
- 伪造 cookie / 历史 ownerless session 的行为没有在 `required` 模式下被严格拒绝
- 缺少真实登录流和可重复的浏览器验收

### 2.2 根因

根因分成 3 层：

1. **身份来源仍偏向旧链路**  
   多个 API 仍直接走 `X-User-Id > pi_user > OS` 的旧解析，`required` 模式下不会优先把已登录用户解析成签名 session。

2. **持久化层没有把 owner 变成强约束**  
   `plan_state` 虽然已有 `user_id` 列，但 session/plan-state/agent 路由并没有统一基于 owner 做访问控制。

3. **验收链路不完整**  
   没有 seed 用户脚本、没有 `required` 模式 Playwright 验收，导致“功能看起来写了”但不能证明无回归。

### 2.3 影响范围

- 受影响模块：
  - `required` 认证模式
  - `/api/sessions*`、`/api/plan-state/*`、`/api/agent/*`
  - `/api/user-preferences`
  - 顶部身份展示与退出流程
- 不影响已有业务数据结构兼容性
- 如果直接上线旧实现，会造成越权读取和未认证流不稳定，属于高优先级问题

---

## 3. 解决方案

### 3.1 方案选择

候选方案：

1. **直接引入完整第三方认证框架**
2. **沿用现有轻量架构，自建 signed session + owner 校验**
3. **只保留 dev cookie，继续推迟 required 模式**

最终选择方案 2，原因：

- 当前仓库已具备 `users` 表、`plan_states.user_id` 和多用户演进基础
- T3 目标是把 `required` 做到可用，而不是引入更重的框架迁移
- 可以在不破坏现有 `optional/disabled` 兼容性的前提下，最小化落地完整认证闭环

### 3.2 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `lib/auth-mode.ts` | `add` | 抽象 `disabled/optional/required` 模式 |
| `lib/auth-constants.ts` | `add` | 抽出 cookie 常量，避免 Edge middleware 拉入 Node-only 模块 |
| `lib/auth-session.ts` | `add` | signed session token、用户查询、密码 hash/verify |
| `lib/session-ownership.ts` | `add` | 统一 owner 判断与 session 过滤 |
| `lib/user-context.ts` | `modify` | 统一 signed auth / header / cookie / os 解析顺序 |
| `lib/plan-state.ts` | `modify` | `PlanState` 持久化 `userId` |
| `lib/rpc-manager.ts` | `modify` | 启动 session 时同步/修正 `planState.userId` |
| `lib/storage/pg-repos.ts` | `modify` | `plan_states.user_id` upsert/load/listAll 支持 |
| `middleware.ts` | `add` | `required` 模式下页面/API 入口拦截 |
| `app/api/auth/login/route.ts` | `add` | 用户名密码登录，签发 cookie |
| `app/api/auth/logout/route.ts` | `add` | 登出清 cookie |
| `app/login/page.tsx` | `add` | 登录页 |
| `app/api/dev-login/route.ts` | `modify` | `required` 模式下禁用 dev-only 登录 |
| `app/api/whoami/route.ts` | `modify` | 返回 `authed/username/mode/source` |
| `app/api/sessions/route.ts` | `modify` | 列表按 owner 过滤 |
| `app/api/sessions/[id]/route.ts` | `modify` | 单 session 读/改/删做 owner 校验 |
| `app/api/sessions/[id]/context/route.ts` | `modify` | context 读取做 owner 校验 |
| `app/api/plan-state/[id]/route.ts` | `modify` | plan-state 读取做 owner 校验 |
| `app/api/agent/new/route.ts` | `modify` | 新会话绑定当前 userId |
| `app/api/agent/[id]/route.ts` | `modify` | agent 命令和 state 读取做 owner 校验 |
| `app/api/agent/[id]/events/route.ts` | `modify` | SSE 订阅做 owner 校验 |
| `app/api/user-preferences/route.ts` | `modify` | required 模式只接受已解析用户 |
| `components/AppShell.tsx` | `modify` | 顶栏身份态、已登录用户名、退出按钮 |
| `.env.example` | `modify` | 更新 T3 认证模式说明 |
| `scripts/seed-users.ts` | `add` | 写入 `alice/bob` 测试账号 |
| `tests/auth-required.spec.ts` | `add` | 浏览器验收：登录、伪造 cookie、owner 隔离 |
| `scripts/p0-smoke-test.ts` | `modify` | 补 T3 smoke 断言并修复事件耗时断言 flake |
| `package.json` | `modify` | 增加 `seed:users` 命令 |

### 3.3 核心逻辑变化

Before：大量路由仍直接读旧 userId 链路，`required` 模式下没有 owner 强校验。

```ts
const userId = getCurrentUserIdFromRequest(req);
const { session } = await startRpcSession(id, filePath, cwd, userId);
```

After：先解析认证上下文，再用 owner 校验保护 session/plan-state/API。

```ts
const context = resolveUserContext(req);
if (!context.userId) {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
if (!(await canAccessSession(id, context.userId, context.mode))) {
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}
```

Before：middleware 直接依赖带 `node:crypto` 的 auth 实现，Edge Runtime 无法加载。

```ts
import { AUTH_COOKIE_NAME } from "@/lib/auth-session";
```

After：拆出常量文件，middleware 只依赖 Edge-safe 模块。

```ts
import { AUTH_COOKIE_NAME } from "@/lib/auth-constants";
```

---

## 4. 验证

### 4.1 测试结果

| 测试类型 | 结果 |
|---------|------|
| 烟雾测试 | `242/242 pass` |
| 新增测试 | `tests/auth-required.spec.ts 3/3 pass` |
| E2E 测试 | `Playwright 3/3 pass` |
| 手动验证 | 通过 |

### 4.2 验收标准

- [x] 未登录访问 `/` 时，在 `AUTH_MODE=required` 下被重定向到 `/login`
- [x] 错误密码登录失败，正确密码登录成功，退出后回到登录页
- [x] 伪造 `pi_auth` cookie 访问受保护 API 返回 `401`
- [x] `alice` 不能读取 `bob` 的 `plan_state`
- [x] `required` 模式下 `/api/dev-login` 不再可用

---

## 5. 回滚方案

如果需要回滚此变更：

```bash
git revert <auth_commit>
git revert <test_commit>
git revert <docs_commit>
```

回滚影响：`AUTH_MODE=required` 会退回到未完成状态，登录页、signed session、owner 隔离和相关验收脚本一并失效。

---

## 6. 后续改进

- [ ] 评估把 `middleware.ts` 迁移到 Next 16 推荐的 `proxy` 约定
- [ ] 为登录失败、登出成功和身份态增加更明确的 UI 文案
- [ ] 为 `/api/sessions/[id]` 等 owner 校验补更细粒度的 route-level 单测
