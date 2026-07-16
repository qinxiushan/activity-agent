# [bug] 修复 PlanStateManager.persist() 静默吞错误和写队列链断裂

---

## 1. 元信息

| 字段 | 值 |
|------|-----|
| **日期** | 2026-07-16 |
| **类型** | `bug` |
| **严重度** | `P0 阻断`（数据一致性） |
| **修改文件数** | 1 |
| **触发方式** | pi-agent 设计分析报告（docs/pi-agent-design-analysis.md §7.2） |

---

## 2. 问题描述

### 2.1 现象

plan-state.json 与 session JSONL 文件可能在进程崩溃后不一致：
- JSONL 记录了某个 event，但 plan-state.json 未更新
- 或 plan-state.json 已更新，但 JSONL 缺少对应 event

### 2.2 根因

两个独立的 bug：

**问题 A：异步 writeQueue 链断裂**

```typescript
// persist() 使用链式 .then() 串行化异步写入
this.writeQueue = this.writeQueue.then(async () => {
  try { ... } catch (e) { console.error(...) }  // ← 吞掉错误！
});
return this.writeQueue;
```

如果某次写入失败，`catch` 吞掉错误后 `Promise.resolve(undefined)`。下一个 `.then()` 仍然执行，但 `this.state` 可能已被后续操作修改，导致写入旧数据或写入错乱。更严重的是——**调用者不知道写入失败**。

**问题 B：异步写入有时间窗口**

`writeFile` 是异步操作。`await this.persist()` 返回时数据尚未落盘（仅加入 Event Loop）。如果此时进程崩溃，plan-state.json 可能为空或为旧数据，但 `transition()` 的上层已经认为操作完成。

```
时间线：
transition() 修改内存 state
  └─ persist() 开始：fs.writeFile (async)
     └─ return { ok: true }          ← 上层认为已持久化
        ... 进程在这里崩溃 ...        ← ⚠️ 数据未落盘
        fs.writeFile 的回调从未执行
```

### 2.3 影响范围

- 进程崩溃（OOM / SIGKILL / 节点宕机）后恢复的 session
- 写队列中被跳过但未通知的后续 transition
- 不常发生，但发生时难以排查

---

## 3. 解决方案

### 3.1 方案选择

| 方案 | 描述 | 结论 |
|------|------|------|
| **A: 同步写** | 用 `writeFileSync` + `mkdirSync` 替换异步写队列 | ✅ plan-state JSON < 10KB，同步写 < 1ms，零丢失窗口 |
| **B: 保持异步 + 修复错误传播** | 保留 writeQueue 但移除 silent catch | ❌ 仍存在异步时间窗口 |
| **C: 双写（JSONL + plan-state）** | 每次 persist 同时写 JSONL custom entry | ❌ 需要 SessionManager 引用，增加耦合 |

### 3.2 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `lib/plan-state.ts` | `modify` | 删除 `writeQueue` 字段；`persist()` 改为同步写；错误向上传播 |

### 3.3 核心逻辑变化

**Before**:

```typescript
private writeQueue: Promise<void> = Promise.resolve();

private async persist(): Promise<void> {
  this.writeQueue = this.writeQueue.then(async () => {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(this.state), "utf-8");
    } catch (e) {
      console.error(`persist failed:`, e);  // 🔴 吞掉错误
    }
  });
  return this.writeQueue;
}

// transition 中：
await this.persist(); // 返回时数据未必落盘
```

**After**:

```typescript
// 无 writeQueue，无异步 Promise 链

private persist(): void {
  try {
    mkdirSync(this.storageDir, { recursive: true });
    writeFileSync(file, JSON.stringify(this.state, null, 2), "utf-8");
  } catch (e) {
    console.error(`persist failed:`, e);
    throw e;  // ✅ 错误向上传播
  }
}

// transition 中：
this.persist(); // 同步写，调用返回时数据已落盘
```

---

## 4. 验证

### 4.1 测试结果

| 测试类型 | 结果 |
|---------|------|
| 烟雾测试 | 125/125 pass |

### 4.2 验收标准

- [x] `persist()` 使用 `writeFileSync` + `mkdirSync`（同步）
- [x] `writeQueue` 字段已删除
- [x] 错误向上传播（`throw e`），不再被静默吞掉
- [x] `transition()` 调用 `this.persist()` 不再 `await`（同步方法）

---

## 5. 回滚方案

```bash
git revert HEAD --no-edit
```

回滚影响：恢复异步 writeQueue，重新引入丢失窗口和链断裂风险。

---

## 6. 后续改进

- [ ] 考虑增加 plan-state 的写入校验和（如写入后立即 `readFileSync` 验证 JSON 可解析）
- [ ] 长期方案：将 plan-state 存入 session JSONL 的 custom entry，消除双文件不一致风险
