# [fix] 修复视觉验收失败与桌面端 sidebar 遮罩误拦截

---

## 1. 元信息

| 字段 | 值 |
|------|-----|
| **日期** | 2026-07-18 |
| **类型** | `fix` |
| **严重度** | `P1 高`（前端验收不通过） |
| **修改文件数** | 4（修改 4） |
| **触发方式** | 人工验收 / Playwright 视觉测试失败后修复 |
| **关联** | `tests/activity-visual.spec.ts` 7/8 → 8/8 |

---

## 2. 问题描述

### 2.1 现象

`npm run test:visual` 初始结果为 8 个用例中 7 个失败，主要表现为：

- 多个用例等待 `Activity Panel` 文本失败
- 主题切换与“刷新偏好”按钮被 `sidebar-overlay-backdrop` 拦截点击
- “空偏好”用例依赖本机已有数据状态，不可重复

### 2.2 根因

1. 右侧活动面板当前 UI 中缺少稳定的 `Activity Panel` 标识，测试脚本前置选择器失效  
2. sidebar 遮罩层在桌面宽度下仍然启用 `pointer-events`，误拦截顶部按钮与偏好面板按钮  
3. Playwright 用例对本机数据状态有隐含假设，没有在测试前自行清理偏好数据

### 2.3 影响范围

- 顶部主题按钮点击
- 用户偏好面板刷新按钮点击
- 视觉验收脚本稳定性

---

## 3. 解决方案

### 3.1 方案选择

把问题拆成“产品修复 + 测试修复”两层：

```text
产品层：
  1. 桌面端禁用 sidebar overlay 拦截
  2. 右侧面板补稳定 heading

测试层：
  3. 选择器改为 exact match
  4. 空状态用例先 reset 偏好
```

### 3.2 修改文件清单

| 文件 | 改法 | 说明 |
|------|------|------|
| `components/AppShell.tsx` | modify | 仅在移动端启用 `sidebar-overlay-backdrop` 的点击拦截 |
| `components/ActivityPanelWrapper.tsx` | modify | 补回稳定的 `Activity Panel` 标题 |
| `tests/activity-visual.spec.ts` | modify | `Activity Panel` 选择器改为精确匹配；空偏好用例先 `reset` |
| `AGENTS.md` | modify | 补充交互 shell / `nvm` / Node 版本差异说明，避免误判 dev server 故障 |

### 3.3 核心逻辑变化

桌面端不再启用 sidebar 遮罩拦截：

```ts
// before
pointerEvents: sidebarOpen ? "auto" : "none"

// after
pointerEvents: isMobileViewport && sidebarOpen ? "auto" : "none"
```

“空偏好”测试变为自清理、可重复：

```ts
// before
await page.goto("/");
await expect(page.locator("text=暂无偏好")).toBeVisible();

// after
await page.request.post("/api/user-preferences", { data: { action: "reset" } });
await page.goto("/");
await expect(page.locator("text=暂无偏好")).toBeVisible();
```

---

## 4. 验证

### 4.1 测试结果

| 测试 | 结果 |
|------|------|
| `node_modules/.bin/tsc --noEmit` | pass |
| `npm run test:visual` | **8/8 pass** |

### 4.2 验收结论

- [x] `Activity Panel` 相关 4 个视觉用例全部恢复通过
- [x] 用户偏好面板 4 个用例全部恢复通过
- [x] 主题切换按钮不再被 overlay 拦截
- [x] 刷新偏好按钮不再被 overlay 拦截
- [x] “空偏好”用例不依赖本机残留数据

---

## 5. 回滚方案

```bash
git revert <本次 commit>
```

回滚影响：桌面端顶部按钮可能再次被 sidebar overlay 拦截，Playwright 视觉验收重新变得不稳定。

---

## 6. 后续改进

- [ ] 为桌面/移动 sidebar 行为补单独的组件级测试
- [ ] 统一整理视觉测试中的页面锚点，避免继续依赖易变文案
