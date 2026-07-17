# [improvement] T1 健康检查端点 - /health + /health/ready

> 第一阶段开发计划（docs/分析报告/04）T1 任务交付
> 配合 K8s/Docker 编排前置条件

---

## 1. 元信息

| 字段 | 值 |
|------|-----|
| **日期** | 2026-07-17 |
| **类型** | `improvement` |
| **严重度** | `P2 中`（生产化前置） |
| **修改文件数** | 4 (3 新增 + 1 修改) |
| **触发方式** | 第一阶段开发计划 |
| **关联 Issue** | docs/分析报告/04-第一阶段开发计划.md T1 |

---

## 2. 问题描述

### 2.1 现象

activity-agent 没有任何健康检查端点，无法对接 K8s livenessProbe/readinessSidecar 或 Docker HEALTHCHECK：

- `kubectl get pods` 无法判断 Pod 是否健康
- K8s readinessProbe 缺失 → 流量可能路由到尚未初始化的 Pod
- K8s livenessProbe 缺失 → 死锁的 Pod 不会被自动重启
- 监控告警系统无法探测服务存活

### 2.2 根因

原项目是 Next.js Route Handler 风格，未设计 probe 端点：
- `app/api/` 下只有 sessions/agent/plan-state 等业务端点
- 没有 `/health` `/health/ready` `/health/metrics` 这类 K8s 约定端点

### 2.3 影响范围

- 单进程 demo：无影响（手动观察）
- 多节点 K8s 部署：**阻断**（无法上线）
- 监控告警：无法接入

---

## 3. 解决方案

### 3.1 方案选择

| 方案 | 描述 | 结论 |
|------|------|------|
| **A: 用 Next.js Route Handler 自定义** | 在 `app/api/health/route.ts` 写一个简单 GET | ✅ 选此方案。无需第三方库，与现有 API 风格一致 |
| **B: 引入 `next-health-check` 包** | npm 装一个 | ❌ 过度设计，3 行代码的事 |
| **C: 用 Express 包装层** | 自定义 Server 暴露 health | ❌ 项目用 App Router Route Handler，不一致 |

### 3.2 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `lib/health.ts` | `add` | 健康检查核心逻辑：liveness + readiness 检测 |
| `app/api/health/route.ts` | `add` | `/api/health` liveness 端点（200 always） |
| `app/api/health/ready/route.ts` | `add` | `/api/health/ready` readiness 端点（200/503） |
| `scripts/p0-smoke-test.ts` | `modify` | 删除 P0-1 refactor 遗留的 `getActivityPlannerTools(mgr3)` 调用（typo），新增 15 个 health 端点测试 |

### 3.3 核心逻辑变化

**新增 `lib/health.ts`**（140 行）：

```typescript
// 4 个核心检查
export async function runReadinessChecks(): Promise<HealthCheckResult> {
  // 并行检查 4 个目录可写
  const dirChecks = await Promise.all(
    REQUIRED_DIRS.map((name) => checkDirWritable(path.join(PI_AGENT_DIR, name)))
  );
  // 内存使用 < 90% 阈值
  // 返回结构化 { ok, latencyMs, checks, details }
}

// Liveness 仅返回 process.uptime + version
export function runLivenessCheck(): LivenessResult {
  return {
    status: "ok",
    uptime: Math.round(process.uptime()),
    version: process.env.npm_package_version ?? "0.2.0",
    timestamp: new Date().toISOString(),
  };
}
```

**新增 `/api/health`**（极简）：

```typescript
export async function GET() {
  return NextResponse.json(runLivenessCheck());
  // 永远 200，除非进程崩了
}
```

**新增 `/api/health/ready`**（条件性 503）：

```typescript
export async function GET() {
  const result = await runReadinessChecks();
  return NextResponse.json(
    { status: result.ok ? "ready" : "not_ready", ...result },
    { status: result.ok ? 200 : 503 }
  );
}
```

**修复 P0-1 refactor 遗留 typo**：

```diff
- const toolsWithPlan = getActivityPlannerTools(mgr3);
+ const tools = getActivityPlannerTools();
```

`toolsWithPlan` 变量定义后从未使用，且 `getActivityPlannerTools` 在 P0-1 AsyncLocalStorage refactor 后已改为无参函数（`mgr3` 不再合法）。

---

## 4. 验证

### 4.1 测试结果

| 测试类型 | 结果 |
|---------|------|
| TypeScript 编译 | `tsc --noEmit` pass (无 type error) |
| 烟雾测试 | 140/140 pass (125 原 + 15 新增 health 端点测试) |
| 端到端 curl | `/api/health` 返回 200, 32ms |
| 端到端 curl | `/api/health/ready` 返回 200, 19ms, 5 项检查全过 |
| 失败注入测试 | `chmod 555 plan-states` → 503 + `plan_states_dir_writable: false` |
| 恢复测试 | `chmod 755 plan-states` → 200 |
| 回归测试 | `/api/sessions` `/api/models` `/api/whoami` `/` 全部 200 |

### 4.2 验收标准

- [x] `GET /api/health` 返回 200 + `{ status, uptime, version, timestamp }`
- [x] `GET /api/health/ready` 全部检查通过时返回 200 + `{ status: "ready", checks, details }`
- [x] `GET /api/health/ready` 任一检查失败时返回 503 + `{ status: "not_ready" }`
- [x] `/health` 响应时间 < 100ms（实测 32ms）
- [x] `/health/ready` 响应时间 < 1s（实测 19ms-50ms）
- [x] 不引入新依赖（只用 node:fs, node:os, node:process）
- [x] 140/140 smoke 测试通过
- [x] `tsc --noEmit` 通过
- [x] 不破坏现有任何 API 端点

### 4.3 人工 review（已完成）

| 步骤 | 操作 | 实际结果 |
|------|------|----------|
| 1 | `curl /api/health` | 200, `{status,uptime:14,version:"0.2.0",timestamp}` |
| 2 | `curl /api/health/ready` | 200, `latencyMs:18`, 5 项检查全 true, `activeSessions:1` |
| 3 | `chmod 555 ~/.pi/agent/plan-states` | 503, `plan_states_dir_writable:false`（其他仍 true） |
| 4 | `chmod 755 ~/.pi/agent/plan-states` | 200 |
| 5 | `curl /api/sessions` `/api/models` `/api/whoami` `/` | 全部 200 |
| 6 | 浏览器访问 `/` | Activity Agent UI 正常加载（SOP-v2 阶段进度可见） |

---

## 5. 回滚方案

```bash
git revert HEAD --no-edit
# 删除 4 个文件：
# - lib/health.ts
# - app/api/health/route.ts
# - app/api/health/ready/route.ts
# 恢复 scripts/p0-smoke-test.ts
```

回滚影响：
- K8s probe 端点消失，但 K8s 部署本身在阶段 2 才做，阶段 1 无实际影响
- smoke 测试从 140 降回 125
- 业务功能无影响

---

## 6. 后续改进

- [ ] T4 阶段将 `/api/metrics` 端点加上（Prometheus 4 个核心 metric）
- [ ] 阶段 2 引入 PG/Redis 后，`/api/health/ready` 新增数据库连接检查
- [ ] K8s manifest 模板：在 `helm/templates/` 加 livenessProbe/readinessProbe 引用这两个端点

---

# v1.1 · Hotfix · 内存阈值误判 → 改用 RSS + 硬编码上限

> 用户在 2026-07-17 02:53 实测发现 `/api/health/ready` 返回 503
> 根因：`memory_under_threshold: false` 误判（76MB 使用 / 80MB "limit" = 95%）
> 修法：用 `process.memoryUsage().rss` + 硬编码 1.5GB 替代 `heapUsed / heapTotal`

---

## v1.1.1 元信息

| 字段 | 值 |
|------|-----|
| **日期** | 2026-07-17 |
| **类型** | `bug fix` |
| **严重度** | `P1 高`（503 误报导致 K8s readiness 失败） |
| **修改文件数** | 1 |
| **触发方式** | 用户手动 curl 测试发现 |

---

## v1.1.2 问题描述

### 现象

dev server 正常运行（`heapUsed: 76MB`），但 `/api/health/ready` 返回 503：
```json
{
  "status": "not_ready",
  "checks": {
    "memory_under_threshold": false,
    ...
  },
  "details": { "memoryUsedMb": 76, "memoryLimitMb": 80 }
}
```

### 根因

```typescript
// v1.0 错误实现
const usedMb = Math.round(memUsage.heapUsed / 1024 / 1024);
const limitMb = Math.round(memUsage.heapTotal / 1024 / 1024) || 1500;
```

`process.memoryUsage().heapTotal` **不是上限**，是 V8 **当前已 commit 的堆大小**（V8 启动时只 commit 几十 MB 初始堆，随使用增长）。

| 状态 | heapUsed | heapTotal | 比例 | 误判 |
|------|----------|-----------|------|------|
| dev server 启动 | 76 MB | 80 MB | 95% | ❌ not_ready |
| 实际安全水平 | 76 MB | ~1.5GB | 5% | ✅ 应该 ready |

### 影响范围

- 阶段 1 demo：阻塞健康检查，但 dev 模式手动刷新即可
- K8s 部署：readinessProbe 失败 → Pod 永远不进 Service Endpoints → 流量永远不到该 Pod（**生产级阻断**）

---

## v1.1.3 解决方案

```diff
+ const MEMORY_HARD_LIMIT_MB = 1536;

  function getMemoryUsage(): { usedMb: number; limitMb: number } {
    const memUsage = process.memoryUsage();
-   const usedMb = Math.round(memUsage.heapUsed / 1024 / 1024);
-   const limitMb = Math.round(memUsage.heapTotal / 1024 / 1024) || 1500;
+   const usedMb = Math.round(memUsage.rss / 1024 / 1024);
+   return { usedMb, limitMb: MEMORY_HARD_LIMIT_MB };
  }
```

**关键变化**：
1. `heapUsed` → `rss`（实际常驻内存，含 native 分配，更能反映真实占用）
2. `heapTotal` → `MEMORY_HARD_LIMIT_MB = 1536`（硬编码 1.5GB 绝对上限）
3. 阶段 2 会改为可配置（环境变量 `MEMORY_LIMIT_MB`）

---

## v1.1.4 验证

| 测试 | v1.0 结果 | v1.1 结果 |
|------|-----------|-----------|
| dev server `heapUsed: 76MB` | 503 ❌ | — |
| dev server `rss: 613MB` | — | 200 ✅ |
| 比例 | 95%（误判） | 40%（正确） |
| `tsc --noEmit` | pass | pass |
| smoke 140/140 | pass | pass |
| 回归测试 | pass | pass |

**教训**：写 health check 时不要用 `heapTotal` 这种"会动态变化的中间值"做比例分母。要用绝对硬上限或 `rss` vs 配置的固定值。
- [ ] 可选：`/api/health/startup` 启动探针（区分启动期 vs 运行期）
