# 豆包 API 调用全量说明（WebtoAPI）

更新时间：2026-03-29

## 1. 说明与范围

本项目并不是直接调用“豆包官方开放平台 REST API”，而是通过浏览器自动化接入 [豆包网页](https://www.doubao.com/chat/)，并对外提供 **OpenAI 兼容接口**。

你在业务侧只需要调用本项目的 `/v1/*` 接口即可。

## 2. 基础信息

- Base URL：`http://<你的服务器IP>:3000`
- 鉴权：`Authorization: Bearer <server.auth>`
- Content-Type：`application/json`

配置位置：
- [data/config.yaml](/Users/shifeihua/WebtoAPI/data/config.yaml)
- [config.example.yaml](/Users/shifeihua/WebtoAPI/config.example.yaml)

必须启用的 Worker（豆包）：
- `type: doubao_text`（文本）
- `type: doubao`（图片/抠图）

## 3. 对外接口总览

### 3.1 GET `/v1/models`

用途：获取当前服务实际可用模型（由当前 Worker 和 modelFilter 决定）。

请求示例：

```bash
curl http://127.0.0.1:3000/v1/models \
  -H "Authorization: Bearer sk-change-me-to-your-secure-key"
```

响应结构（示意）：

```json
{
  "object": "list",
  "data": [
    {
      "id": "seed",
      "object": "model",
      "created": 1710000000,
      "owned_by": "internal_server",
      "image_policy": "optional",
      "type": "text"
    },
    {
      "id": "doubao_text/seed",
      "object": "model",
      "created": 1710000000,
      "owned_by": "doubao_text",
      "image_policy": "optional",
      "type": "text"
    }
  ]
}
```

注意：
- 同一模型会同时出现“短 ID”和“带前缀 ID”（例如 `seed` 与 `doubao_text/seed`），两种都可用。

### 3.2 POST `/v1/chat/completions`

用途：统一入口，支持：
- 豆包文本对话
- 豆包文生图/图生图
- 豆包 AI 抠图（`ai-cutout`）

请求体关键字段：
- `model`：模型名（建议先从 `/v1/models` 获取）
- `messages`：必填，OpenAI 风格
- `stream`：可选，`true` 使用 SSE 流式

### 3.3 GET `/v1/cookies`

用途：读取当前浏览器实例中的 Cookie（用于排查登录态）。

Query 参数：
- `name`：实例名（例如 `browser_default`）
- `domain`：按域名过滤（例如 `doubao.com`）

请求示例：

```bash
curl "http://127.0.0.1:3000/v1/cookies?name=browser_default&domain=doubao.com" \
  -H "Authorization: Bearer sk-change-me-to-your-secure-key"
```

## 4. 豆包模型清单（当前代码）

文本（`doubao_text`）：
- `seed`
- `seed-thinking`
- `seed-pro`

图片（`doubao`）：
- `ai-cutout`（AI 抠图，必须上传参考图）
- `seedream-4.5`
- `seedream-4.0`
- `seedream-3.0`

说明：
- 每个模型通常同时支持两种写法：`<model>` 与 `<adapter>/<model>`。
- 例如：`ai-cutout` 和 `doubao/ai-cutout`。

## 5. `/v1/chat/completions` 详细调用规则

### 5.1 消息与图片规则

- `messages` 不能为空，否则报 `NO_MESSAGES`。
- 必须至少有一条 `role=user`，否则报 `NO_USER_MESSAGES`。
- 图片必须放在 `messages[].content[]` 里的 `image_url.url`。
- 图片 URL 仅支持 `data:image/...;base64,...`（data URL）。
- 服务端会将上传图片转码为 JPG 临时文件后再投喂网页。

### 5.2 文本模型（`type=text`）行为

当 `model` 是文本模型时：
- 会构建“虚拟上下文”：
  - system 消息置顶
  - 最后一条 user 之前的消息作为历史
  - 最后一条 user 作为当前输入
- 历史消息中的图片会转换成 `[图片N]` 占位符并上传。

### 5.3 图片模型（`type=image`）行为

当 `model` 是图片模型时：
- 只读取 **最后一条 user 消息** 作为本次生成输入。
- 按 `image_policy` 校验是否允许/要求参考图：
  - `required`：必须有图（`ai-cutout`）
  - `optional`：可有可无（`seedream-*`）
  - `forbidden`：不能带图

### 5.4 图片数量限制

配置项：`queue.imageLimit`

规则：
- 实际网页最多支持 10 张。
- 若 `imageLimit <= 10`，超限直接报错 `TOO_MANY_IMAGES`。
- 若 `imageLimit > 10`，超过 10 的图片会被静默忽略。

## 6. 返回格式

### 6.1 非流式（`stream=false`）

标准 OpenAI ChatCompletion：

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1710000000,
  "model": "ai-cutout",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "data:image/jpeg;base64,/9j/4AAQSk..."
      },
      "finish_reason": "stop"
    }
  ]
}
```

说明：
- 文本模型：`content` 是文本。
- 图片模型/抠图：`content` 是 `data:image/...;base64,...`。

### 6.2 流式（`stream=true`）

- Content-Type: `text/event-stream`
- 服务端会发送心跳（配置 `server.keepalive.mode`）
- 最终返回 1 个 completion chunk + `data: [DONE]`

## 7. 错误码（高频）

- `UNAUTHORIZED`：鉴权失败
- `BROWSER_NOT_INITIALIZED`：浏览器池未就绪
- `SERVER_BUSY`：非流式队列满
- `NO_MESSAGES`：缺少 messages
- `NO_USER_MESSAGES`：没有 user 消息
- `TOO_MANY_IMAGES`：图片超限
- `INVALID_MODEL`：模型不存在或当前后端不支持
- `IMAGE_REQUIRED`：模型要求上传参考图（如 `ai-cutout`）
- `IMAGE_FORBIDDEN`：模型不支持图输入
- `GENERATION_FAILED`：网页侧生成失败
- `INTERNAL_ERROR`：服务内部错误

错误返回格式（统一）：

```json
{
  "error": {
    "message": "错误描述",
    "type": "invalid_request_error",
    "code": "INVALID_MODEL"
  }
}
```

## 8. 实战示例

### 8.1 豆包文本

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-change-me-to-your-secure-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seed",
    "stream": false,
    "messages": [
      { "role": "user", "content": "写一个 30 字的自我介绍" }
    ]
  }'
```

### 8.2 豆包文生图（Seedream）

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-change-me-to-your-secure-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedream-4.5",
    "stream": false,
    "messages": [
      { "role": "user", "content": "一张电商风格白底产品图，软光，高细节" }
    ]
  }'
```

### 8.3 豆包图生图

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-change-me-to-your-secure-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedream-4.5",
    "stream": false,
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "保留主体，改成浅灰背景的商品主图风格" },
          { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,你的Base64" } }
        ]
      }
    ]
  }'
```

### 8.4 豆包 AI 抠图

`ai-cutout` 必须带图，不需要复杂 prompt：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-change-me-to-your-secure-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ai-cutout",
    "stream": false,
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "抠出主体" },
          { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,你的Base64" } }
        ]
      }
    ]
  }'
```

## 9. 抠图后去水印（已接入）

当配置 `backend.postprocess.watermarkRemover.enabled: true` 时：
- 所有图片结果（包括 `ai-cutout`）都会自动执行一次 watermark-remover 后处理。
- 若后处理失败，会自动回退原图，不影响主流程返回。

配置段示例：

```yaml
backend:
  postprocess:
    watermarkRemover:
      enabled: true
      command: "/Users/shifeihua/WebtoAPI/.venv-wm/bin/watermark-remover"
      method: "opencv"
      confidence: 0.5
      padding: 6
      corner: "bottom-right"
      cornerWidth: 0.1
      cornerHeight: 0.06
      forceCorner: true
      cornerBlend: 0.72
```

## 10. 关键实现文件（便于后续维护）

- [src/server/api/openai/routes.js](/Users/shifeihua/WebtoAPI/src/server/api/openai/routes.js)
- [src/server/api/openai/parse.js](/Users/shifeihua/WebtoAPI/src/server/api/openai/parse.js)
- [src/server/respond.js](/Users/shifeihua/WebtoAPI/src/server/respond.js)
- [src/server/errors.js](/Users/shifeihua/WebtoAPI/src/server/errors.js)
- [src/backend/adapter/doubao_text.js](/Users/shifeihua/WebtoAPI/src/backend/adapter/doubao_text.js)
- [src/backend/adapter/doubao.js](/Users/shifeihua/WebtoAPI/src/backend/adapter/doubao.js)
- [src/server/postprocess/watermarkRemover.js](/Users/shifeihua/WebtoAPI/src/server/postprocess/watermarkRemover.js)
