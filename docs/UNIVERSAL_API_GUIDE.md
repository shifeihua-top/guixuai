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

## 4. 请求结构约定

关键字段：

- `model`：模型标识，建议先通过 `/v1/models` 动态获取
- `messages`：OpenAI 风格消息数组
- `stream`：是否开启流式响应

图片输入约定：

- 通过 `messages[].content[]` 的 `image_url.url` 传入
- 推荐使用 `data:image/...;base64,...` 格式

## 5. 响应结构约定

- 非流式：返回标准 OpenAI `chat.completion`
- 流式：返回 SSE，最终以 `data: [DONE]` 结束

说明：

- 文本任务返回文本内容
- 生成类任务可返回文本、URL 或 Base64 数据，取决于适配器实现

## 6. 常见错误码（示例）

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

## 7. 最佳实践

- 模型列表不要硬编码，始终通过 `/v1/models` 获取
- 生产建议优先使用流式，降低长任务超时风险
- 多账号场景建议实例隔离，避免会话污染
- 对外暴露时务必启用 HTTPS 或隧道
