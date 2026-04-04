# MCP 接入指南（OpenClaw / 通用 MCP 客户端）

更新时间：2026-04-05

本项目已提供可直接运行的 MCP Server（stdio 模式）：

- `scripts/mcp/server.mjs`

它会把现有 HTTP API 封装为 MCP tools，便于 OpenClaw 或其他支持 MCP 的客户端调用。

## 1. 已封装工具

- `guixuai_list_models`
  - 对应：`GET /v1/models`
- `guixuai_chat_completion`
  - 对应：`POST /v1/chat/completions`
- `guixuai_image_edit`
  - 对应：`POST /v1/chat/completions`（图像编辑封装）
  - 参数增强：支持 `ratio`、`quality`、`output`
- `guixuai_get_cookies`
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

- `GUIXUAI_BASE_URL`：默认 `http://127.0.0.1:3000`
- `GUIXUAI_API_TOKEN`：服务鉴权 token（必填）

示例：

```bash
GUIXUAI_BASE_URL=http://127.0.0.1:3000 \
GUIXUAI_API_TOKEN=sk-your-token \
node scripts/mcp/server.mjs
```

## 4. OpenClaw / 通用客户端配置示例

你可以在 MCP 配置里加入：

```json
{
  "mcpServers": {
    "guixuai": {
      "command": "node",
      "args": ["/Users/shifeihua/WebtoAPI/scripts/mcp/server.mjs"],
      "env": {
        "GUIXUAI_BASE_URL": "http://127.0.0.1:3000",
        "GUIXUAI_API_TOKEN": "sk-your-token"
      }
    }
  }
}
```

补充：如果你使用内置 WebUI，可以在「系统设置」直接使用：

- `复制 MCP 配置`
- `复制 OpenClaw 配置+Skill 安装`

来快速完成 OpenClaw 的接入初始化。

## 5. 调用建议

- 先调用 `guixuai_list_models` 获取模型
- 文本任务优先用 `guixuai_chat_completion`
- 图像任务优先用 `guixuai_image_edit`，并使用 `ratio/quality/output` 统一参数
- 若会话异常，用 `guixuai_get_cookies` 排查

`output` 支持：

- `inline`：仅返回接口原始内容，不落盘
- `file`：落盘单图
- `files`：多图全量落盘
- 也可直接传文件路径（等价于 `output_path`）
- 未传 `output` 时默认保留全量结果（等价 `files`）

## 6. MCP 工具调用示例

以下为 MCP 客户端中常见的 `tools/call` 参数示例（`name` + `arguments`）：

### 6.1 获取模型

```json
{
  "name": "guixuai_list_models",
  "arguments": {}
}
```

### 6.2 文本生成（prompt 简写）

```json
{
  "name": "guixuai_chat_completion",
  "arguments": {
    "model": "seed-thinking",
    "prompt": "用三点总结这个网关的价值",
    "stream": false
  }
}
```

### 6.3 多模态消息（messages 完整结构）

```json
{
  "name": "guixuai_chat_completion",
  "arguments": {
    "model": "seedream-4.5",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "改成白底电商主图，主体居中" },
          { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,你的Base64" } }
        ]
      }
    ]
  }
}
```

### 6.4 本地图生图（MCP 自动读图）

```json
{
  "name": "guixuai_image_edit",
  "arguments": {
    "model": "seedream-4.5",
    "prompt": "保留主体，改为纯白背景",
    "image_path": "./input.jpg",
    "ratio": "1:1",
    "quality": "high",
    "output": "files",
    "output_path": "./data/test_outputs/mcp_result.jpg"
  }
}
```

返回中会包含：

- `output_path`：首张图路径
- `output_paths`：实际落盘路径数组
- `image_count`：模型返回图片数
- `saved_count`：实际保存图片数

### 6.5 Cookie 排查

```json
{
  "name": "guixuai_get_cookies",
  "arguments": {
    "name": "browser_default",
    "domain": "jd.com"
  }
}
```

## 7. 常见问题

- 报错 `GUIXUAI_API_TOKEN is required`
  - 未配置 `GUIXUAI_API_TOKEN`
- 报错 `HTTP 401`
  - token 无效或服务鉴权配置已变更
- 报错连接失败
  - 检查 `GUIXUAI_BASE_URL` 与服务是否已启动

## 8. 自动验证（output 模式）

可用内置 smoke 脚本一次验证 `inline/file/files` 三种输出行为：

```bash
GUIXUAI_BASE_URL=http://127.0.0.1:3000 \
GUIXUAI_API_TOKEN=sk-your-token \
npm run mcp:smoke:image-output -- \
  --model seedream-4.5 \
  --prompt "改成白底电商主图，主体居中" \
  --image ./input.jpg
```

可选参数：

- `--modes inline,file,files`：指定验证模式（默认三种全跑）
- `--ratio 1:1`、`--quality high`：统一参数映射验证
- `--out-dir ./data/test_outputs/mcp_smoke`：输出目录
