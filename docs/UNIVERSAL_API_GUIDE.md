# 通用 API 指南

更新时间：2026-04-03

## 1. 目标

本项目通过浏览器自动化接入多种 Web AI 服务，并统一对外暴露 OpenAI 兼容接口。

你可以将其视为一个“多适配器网关”，上游使用统一协议，下游由不同适配器负责具体执行。

## 2. 基础信息

- Base URL：`http://<host>:3000`
- 鉴权：`Authorization: Bearer <server.auth>`
- 格式：`application/json`

配置文件：

- `data/config.yaml`
- `config.example.yaml`

## 3. 核心接口

### 3.1 获取模型列表

- `GET /v1/models`

用途：返回当前配置下真实可用的模型清单（受实例和适配器配置影响）。

### 3.2 统一对话与生成接口

- `POST /v1/chat/completions`

用途：统一承载文本、多模态以及生成类任务。

### 3.3 查询实例 Cookie

- `GET /v1/cookies`

用途：用于排查登录态和会话问题。

## 4. 快速调用示例

以下示例默认：

- 服务地址：`http://127.0.0.1:3000`
- 鉴权：`Authorization: Bearer sk-your-token`

### 4.1 获取模型列表

```bash
curl -sS http://127.0.0.1:3000/v1/models \
  -H "Authorization: Bearer sk-your-token" | jq .
```

示例响应（节选）：

```json
{
  "object": "list",
  "data": [
    { "id": "seed", "type": "text" },
    { "id": "seedream-4.5", "type": "image" }
  ]
}
```

### 4.2 文本对话（非流式）

```bash
curl -sS http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seed",
    "stream": false,
    "messages": [
      { "role": "user", "content": "用三点介绍这个网关的价值" }
    ]
  }' | jq .
```

示例响应（节选）：

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "..." },
      "finish_reason": "stop"
    }
  ]
}
```

### 4.3 文本对话（流式 SSE）

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seed-thinking",
    "stream": true,
    "messages": [
      { "role": "user", "content": "给我一个发布计划草案" }
    ]
  }'
```

你会持续收到 `data: {...}`，最后一条是：

```text
data: [DONE]
```

### 4.4 图像编辑/图生图

```bash
IMG_B64=$(base64 < ./input.jpg | tr -d '\n')

curl -sS http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-your-token" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"seedream-4.5\",
    \"stream\": false,
    \"messages\": [
      {
        \"role\": \"user\",
        \"content\": [
          { \"type\": \"text\", \"text\": \"改为白底电商正视图，主体居中\" },
          { \"type\": \"image_url\", \"image_url\": { \"url\": \"data:image/jpeg;base64,${IMG_B64}\" } }
        ]
      }
    ]
  }" | jq .
```

说明：

- 结果通常在 `choices[0].message.content`
- 可能是文本、URL 或 `data:image/...;base64,...`

### 4.5 查询指定实例 Cookie

```bash
curl -sS "http://127.0.0.1:3000/v1/cookies?name=browser_default&domain=example.com" \
  -H "Authorization: Bearer sk-your-token" | jq .
```

### 4.6 Python（requests）示例

```python
import requests

BASE_URL = "http://127.0.0.1:3000"
TOKEN = "sk-your-token"
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
}

payload = {
    "model": "seed",
    "stream": False,
    "messages": [
        {"role": "user", "content": "请写一段产品简介"}
    ],
}

resp = requests.post(f"{BASE_URL}/v1/chat/completions", headers=HEADERS, json=payload, timeout=180)
resp.raise_for_status()
data = resp.json()
print(data["choices"][0]["message"]["content"])
```

图生图（Python）示例：

```python
import base64
import requests

BASE_URL = "http://127.0.0.1:3000"
TOKEN = "sk-your-token"
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
}

with open("input.jpg", "rb") as f:
    b64 = base64.b64encode(f.read()).decode("utf-8")

payload = {
    "model": "seedream-4.5",
    "stream": False,
    "messages": [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "改为白底电商正视图"},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
            ],
        }
    ],
}

resp = requests.post(f"{BASE_URL}/v1/chat/completions", headers=HEADERS, json=payload, timeout=300)
resp.raise_for_status()
result = resp.json()["choices"][0]["message"]["content"]
print(result[:120])  # 可能是文本、URL 或 data:image...
```

### 4.7 JavaScript（fetch）示例

```javascript
const BASE_URL = "http://127.0.0.1:3000";
const TOKEN = "sk-your-token";

const body = {
  model: "seed-thinking",
  stream: false,
  messages: [{ role: "user", content: "给我一个项目上线 checklist" }],
};

const resp = await fetch(`${BASE_URL}/v1/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

if (!resp.ok) {
  throw new Error(await resp.text());
}

const data = await resp.json();
console.log(data.choices?.[0]?.message?.content);
```

流式 SSE（JavaScript）最小示例：

```javascript
const resp = await fetch("http://127.0.0.1:3000/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: "Bearer sk-your-token",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "seed-thinking",
    stream: true,
    messages: [{ role: "user", content: "输出 5 条营销文案" }],
  }),
});

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta?.content || "";
      if (delta) process.stdout.write(delta);
    } catch (_) {}
  }
}
```

### 4.8 可运行脚本（仓库内置）

Python 非流式示例：

```bash
python3 scripts/examples/python_chat.py \
  --token sk-your-token \
  --model seed \
  --prompt "写三条商品卖点"
```

Python 图生图示例：

```bash
python3 scripts/examples/python_chat.py \
  --token sk-your-token \
  --model seedream-4.5 \
  --prompt "改为白底电商主图，主体居中" \
  --image ./input.jpg
```

JavaScript 流式示例：

```bash
node scripts/examples/js_stream.mjs \
  --token sk-your-token \
  --model seed-thinking \
  --prompt "输出 5 条营销文案"
```

### 4.9 MCP 快速接入示例

本项目内置 MCP Server，可将 HTTP API 以 MCP tools 形式暴露给支持 MCP 的客户端：

```bash
VOIDHUB_BASE_URL=http://127.0.0.1:3000 \
VOIDHUB_API_TOKEN=sk-your-token \
npm run mcp:start
```

客户端配置示例（节选）：

```json
{
  "mcpServers": {
    "voidhub": {
      "command": "node",
      "args": ["/Users/shifeihua/WebtoAPI/scripts/mcp/server.mjs"],
      "env": {
        "VOIDHUB_BASE_URL": "http://127.0.0.1:3000",
        "VOIDHUB_API_TOKEN": "sk-your-token"
      }
    }
  }
}
```

MCP `tools/call` 参数示例（文本任务）：

```json
{
  "name": "voidhub_chat_completion",
  "arguments": {
    "model": "seed-thinking",
    "prompt": "用三点介绍这个网关",
    "stream": false
  }
}
```

更多示例见 `MCP_GUIDE.md`。

## 5. 请求结构约定

关键字段：

- `model`：模型标识，建议先通过 `/v1/models` 动态获取
- `messages`：OpenAI 风格消息数组
- `stream`：是否开启流式响应

图片输入约定：

- 通过 `messages[].content[]` 的 `image_url.url` 传入
- 推荐使用 `data:image/...;base64,...` 格式

## 6. 响应结构约定

- 非流式：返回标准 OpenAI `chat.completion`
- 流式：返回 SSE，最终以 `data: [DONE]` 结束

说明：

- 文本任务返回文本内容
- 生成类任务可返回文本、URL 或 Base64 数据，取决于适配器实现

## 7. 常见错误码（示例）

- `UNAUTHORIZED`
- `INVALID_MODEL`
- `NO_MESSAGES`
- `NO_USER_MESSAGES`
- `SERVER_BUSY`
- `INTERNAL_ERROR`

统一错误格式：

```json
{
  "error": {
    "message": "错误描述",
    "type": "invalid_request_error",
    "code": "INVALID_MODEL"
  }
}
```

典型错误排查示例：

```bash
curl -i -sS http://127.0.0.1:3000/v1/models
```

若未带 token，通常返回 `401` + `UNAUTHORIZED`。

## 8. 最佳实践

- 模型列表不要硬编码，始终通过 `/v1/models` 获取
- 生产建议优先使用流式，降低长任务超时风险
- 多账号场景建议实例隔离，避免会话污染
- 对外暴露时务必启用 HTTPS 或隧道
