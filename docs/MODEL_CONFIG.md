# 模型配置指南 (Model Configuration)

> **TL;DR — 写错了配置文件 = 改了半天 LLM 都没反应。**
> activity-agent 的 LLM 模型配置分布在 **3 个 JSON 文件**里，各管一摊，不能混用。
> 90% 的用户只需要管前两个文件（`settings.json` + `auth.json`），第 3 个 `models.json` 是给高级场景（自建 OpenAI 兼容服务、微调模型）用的。

---

## 三个文件速查表

| 文件 | 路径 | 权限 | 管什么 | 谁会读它 | 什么时候需要改 |
|---|---|---|---|---|---|
| **settings.json** | `~/.pi/agent/settings.json` | 0644 | **默认** provider + modelId + thinkingLevel | `SettingsManager` | 想换默认模型时 |
| **auth.json** | `~/.pi/agent/auth.json` | **0600** | **内置** provider 的 API key / OAuth token | `AuthStorage.getApiKey()`（**最高优先级**） | 想用 deepseek/openai/anthropic 等**官方** provider 时 |
| **models.json** | `~/.pi/agent/models.json` | 0644 | **自定义** provider / model 定义 + 备用 API key | `ModelRegistry` + `AuthStorage` fallback（最低优先级） | 想接**自建 / 第三方 / 微调**模型时 |

> **常见误区**：把 API key 写进 `models.json` 而不是 `auth.json`。
> 结果：UI 里看得见，但 LLM 调用永远拿不到 key（因为 `auth.json` 优先级更高但没 key）。
> **正解**：内置 provider 的 key 放 `auth.json`，`models.json` 只放自定义 provider。

---

## 实战 1：想用 deepseek（90% 的情况）

### 1.1 找到你的 deepseek API key
去 https://platform.deepseek.com 拿一个 `sk-...` 开头的 key。

### 1.2 写入 `auth.json`
```bash
cat > ~/.pi/agent/auth.json <<'EOF'
{
  "deepseek": {
    "type": "api_key",
    "key": "sk-你的真实key"
  }
}
EOF
chmod 600 ~/.pi/agent/auth.json
```

### 1.3 写入 `settings.json`
```bash
cat > ~/.pi/agent/settings.json <<'EOF'
{
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-v4-flash",
  "defaultThinkingLevel": "high"
}
EOF
```

> **重要**：`defaultModel` 必须是 `ModelRegistry` 已知存在的 model id。`deepseek-v4-flash` / `deepseek-v4-pro` 是 deepseek 官方模型，会被内置 registry 识别。
> 不知道有哪些内置模型？看 [实战 4](#实战-4查询当前系统识别了哪些模型)。

### 1.4 验证
```bash
curl -s http://localhost:30142/api/models | python3 -m json.tool
```
应该看到：
```json
{
  "defaultModel": { "provider": "deepseek", "modelId": "deepseek-v4-flash" },
  "modelList": [ { "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "provider": "deepseek" } ]
}
```

### 1.5 跑端到端测试
```bash
# 终端 1
npm run dev

# 终端 2
npm run e2e:real
```
预期：24/24 通过，exit 0，耗时 1-2 分钟（取决于 LLM 响应速度）。

---

## 实战 2：想用其他内置 provider（openai / anthropic / google / 等）

把 provider 名字换掉即可。`AuthStorage` + `ModelRegistry` 知道所有 pi-coding-agent v0.75 内置的 20+ 个 provider。

| Provider | 写入 `auth.json` 的 key 名 | 常见 modelId |
|---|---|---|
| DeepSeek | `deepseek` | `deepseek-v4-flash` / `deepseek-v4-pro` |
| OpenAI | `openai` | `gpt-4o` / `gpt-4o-mini` / `o3-mini` |
| Anthropic | `anthropic` | `claude-sonnet-4-6` / `claude-opus-4-6` |
| Google | `google` | `gemini-2.0-flash` / `gemini-2.5-pro` |
| Moonshot (Kimi) | `moonshotai` | `moonshot-v1-128k` |
| 智谱 GLM | `zai` | `glm-4-plus` |
| 通义千问 | `qwen` | `qwen-max` |
| 等等 | 看 `/api/models` 输出的 `provider` 字段 | 看 `/api/models` 输出的 `id` 字段 |

OAuth 订阅登录的（ChatGPT Plus / Claude Pro / GitHub Copilot）：
- 不要写 `auth.json`，Web UI 里点 "Login" 走 OAuth 流程
- OAuth token 会自动写进 `auth.json`（type 是 `"oauth"`）

---

## 实战 3：想用自建 / 第三方 / 微调模型（高级场景）

**需要用 `models.json`**。典型场景：
- 接公司内网部署的 OpenAI 兼容服务（baseUrl 自定义）
- 接 vLLM / Ollama / LM Studio 本地部署
- 用某个 provider 的微调版本
- 临时给某个 provider 改 baseUrl / 加自定义 header

### 3.1 创建 `models.json`
```bash
cat > ~/.pi/agent/models.json <<'EOF'
{
  "providers": {
    "my-custom-provider": {
      "baseUrl": "https://my-llm.example.com/v1",
      "apiKey": "sk-custom-key-or-env-var",
      "api": "openai-completions",
      "models": [
        {
          "id": "my-finetuned-llama-3-70b",
          "name": "My Finetuned Llama",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
EOF
```

> **字段参考**：`api` 可选 `openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`。
> 详细 schema 看 `node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts`。

### 3.2 在 `settings.json` 里指向它
```json
{
  "defaultProvider": "my-custom-provider",
  "defaultModel": "my-finetuned-llama-3-70b"
}
```

### 3.3 API key 也能从环境变量读
`models.json` 里 `"apiKey": "MY_ENV_VAR"` 会自动从 `process.env.MY_ENV_VAR` 读。
前缀 `!` 触发 shell 命令取 key（高阶用法，不建议）。

---

## 实战 4：查询当前系统识别了哪些模型

dev server 跑起来后（`npm run dev`）：

```bash
# 列出所有可用模型（含内置 + 自定义）
curl -s http://localhost:30142/api/models | python3 -m json.tool

# 只看默认模型
curl -s http://localhost:30142/api/models | jq '.defaultModel'

# 列出当前所有支持的 provider key 名
curl -s http://localhost:30142/api/auth/api-key-providers 2>/dev/null | jq
```

或者直接看 Web UI：访问 `http://localhost:30142/` → 顶部 "Activity Planner" 旁的模型下拉。

---

## 故障排查（5 大坑）

### 坑 1：写完 key 但 LLM 不响应
**症状**：UI 上看到模型，但发消息后 `tool_execution_end` 一直不来 / 报 `PHASE_GUARD` / 报 `ECONNREFUSED`。

**检查顺序**：
```bash
# 1. 确认 dev server 跑得起来
npm run dev

# 2. 确认 /api/models 能看到你配的模型
curl -s http://localhost:30142/api/models | jq '.defaultModel'

# 3. 确认 auth.json 权限是 600（有些 SDK 会拒绝其他权限）
stat -c '%a %n' ~/.pi/agent/auth.json   # 期望 600

# 4. 确认 key 格式正确（deepseek 是 sk- 开头，openai 也是 sk- 开头）
cat ~/.pi/agent/auth.json
```

### 坑 2：改完没生效
**原因**：`AuthStorage` 和 `ModelRegistry` 启动时读一次配置，dev server 不会热重载。
**解决**：重启 `npm run dev`。

### 坑 3：两个文件都写了同一 provider
**优先级**：`auth.json` > `models.json` 的 fallback。
如果你在 `auth.json` 写了 `{"deepseek": {"key": "sk-OLD"}}`，又想在 `models.json` 覆盖？
**覆盖不了** — `auth.json` 永远赢。要换 key 直接改 `auth.json`。

### 坑 4：`defaultModel` 写错了 model id
**症状**：`/api/models` 返回的 `defaultModel.modelId` 是空字符串。
**原因**：你写了一个 pi-coding-agent 不知道的 model id。
**解决**：用 `curl /api/models | jq '.modelList[].id'` 看有哪些合法 id，写其中一个。

### 坑 5：ModelsConfig UI 改了不生效
**症状**：在 Web UI 的 "Models" 弹窗里改了 provider 配置，点 Save 后 LLM 行为没变。
**原因**：那个 UI 是编辑 **`models.json`**（自定义 provider 用）的，不是 `settings.json`/`auth.json`。
**解决**：
- 想换默认模型 → 编辑 `settings.json` 或在 Web UI 顶部的模型下拉里选
- 想换 API key → 编辑 `auth.json`（或点 "Disconnect" → 重新填）
- 想加自定义 provider → 才用 ModelsConfig UI 编辑 `models.json`

---

## 配置文件位置参考

```bash
# 用户级配置根目录
~/.pi/                     # 父目录
~/.pi/agent/               # agent 相关
~/.pi/agent/settings.json  # 1. 默认 provider + model
~/.pi/agent/auth.json      # 2. API key（0600 权限）
~/.pi/agent/models.json    # 3. 自定义 provider/model（可选）
~/.pi/agent/sessions/      # session log（自动生成）
~/.pi/agent/plan-states/   # plan state 快照（自动生成）
~/.pi/agent/bookings/      # 预订状态（自动生成）

# 项目级配置
<project>/.pi/             # 如果有项目级 .pi 目录，会覆盖用户级
```

---

## 经验法则（TL;DR — 永远记住这 3 句话）

1. **改默认模型 = `settings.json`**（`defaultProvider` + `defaultModel`）
2. **改 API key = `auth.json`**（`{"provider名": {"type": "api_key", "key": "sk-..."}}`）
3. **改模型行为 / 加自定义 provider = `models.json`**（接自建 LLM 时才用）

**搞混了？** 跑一次 `curl -s http://localhost:30142/api/models | jq '.defaultModel'` 看看系统认的是哪个，定位问题。

---

## 附录：相关源码位置

| 角色 | 文件 | 关键行 |
|---|---|---|
| API: 读 settings.json | `app/api/models/route.ts` | L30-35 `SettingsManager.create()` |
| API: 读 auth.json | `app/api/models/route.ts` | L15-22 `AuthStorage.create()` + `ModelRegistry.create()` |
| API: 读/写 models.json | `app/api/models-config/route.ts` | L9-27 `getModelsPath()` |
| UI: 编辑 models.json | `components/ModelsConfig.tsx` | L1417 header, L1346 PUT 调用 |
| Loader: auth.json 优先级 | `node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.d.ts` | L124-130 `getApiKey` 5 级 fallback |
| Loader: models.json 自定义 | `node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts` | L29 `ModelRegistry.create(authStorage, modelsJsonPath?)` |
| E2E 测试 | `scripts/e2e-real-llm-test.ts` | L103-125 `loadModel()` 通过 `/api/models` 拿默认模型 |

---

*最后更新：2026-06-07 — 当时端到端测试 `npm run e2e:real` 用 deepseek 配置 24/24 通过。*
