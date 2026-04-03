# MCP 接入指南（OpenClaw / 通用 MCP 客户端）

更新时间：2026-04-03

本项目已提供可直接运行的 MCP Server（stdio 模式）：

- `scripts/mcp/server.mjs`

它会把现有 HTTP API 封装为 MCP tools，便于 OpenClaw 或其他支持 MCP 的客户端调用。

## 1. 已封装工具

- `voidhub_list_models`
  - 对应：`GET /v1/models`
- `voidhub_chat_completion`
  - 对应：`POST /v1/chat/completions`
- `voidhub_image_edit`
  - 对应：`POST /v1/chat/completions`（图像编辑封装）
- `voidhub_get_cookies`
  - 对应：`GET /v1/cookies`

## 2. 启动方式

```bash
npm run mcp:start
```

或：

```bash
node scripts/mcp/server.mjs
```

## 3. 必要环境变量

- `VOIDHUB_BASE_URL`：默认 `http://127.0.0.1:3000`
- `VOIDHUB_API_TOKEN`：服务鉴权 token（必填）

示例：

```bash
VOIDHUB_BASE_URL=http://127.0.0.1:3000 \
VOIDHUB_API_TOKEN=sk-your-token \
node scripts/mcp/server.mjs
```

## 4. OpenClaw / 通用客户端配置示例

你可以在 MCP 配置里加入：

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

## 5. 调用建议

- 先调用 `voidhub_list_models` 获取模型
- 文本任务优先用 `voidhub_chat_completion`
- 图像任务优先用 `voidhub_image_edit`
- 若会话异常，用 `voidhub_get_cookies` 排查

## 6. 常见问题

- 报错 `VOIDHUB_API_TOKEN is required`
  - 未配置 `VOIDHUB_API_TOKEN`
- 报错 `HTTP 401`
  - token 无效或服务鉴权配置已变更
- 报错连接失败
  - 检查 `VOIDHUB_BASE_URL` 与服务是否已启动
