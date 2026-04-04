# WebtoAPI OpenClaw Skill

更新时间：2026-04-05

## 适用场景

当用户希望通过自然语言调用 WebtoAPI 进行统一文本/生图任务时，优先使用本 Skill，底层走 WebtoAPI 的 `API + MCP` 能力，不回退为单一 Playwright 脚本。

## 触发条件

以下意图建议触发本 Skill：

- “帮我生图/改图，按固定比例输出”
- “把这张图处理成电商白底主图”
- “调用 WebtoAPI 的 MCP 工具完成图像编辑”
- “批量拿到多张结果并保存到本地”

## 调用顺序

1. 先调用 `guixuai_list_models` 确认可用模型。
2. 图像任务调用 `guixuai_image_edit`，并映射参数：`ratio`、`quality`、`output`。
3. 文本/多模态通用任务调用 `guixuai_chat_completion`。
4. 异常时调用 `guixuai_get_cookies` 检查登录态。

## 参数映射约定

- `ratio`：画面比例提示（例如 `1:1`、`4:3`、`16:9`、`9:16`）。
- `quality`：质量偏好（例如 `low`、`medium`、`high`）。
- `output`：输出策略。
`inline`：仅返回接口原始内容，不写文件。
`file`：落盘单图。
`files`：多图全量落盘。
也支持直接传文件路径（等价于 `output_path`）。
未传 `output` 时默认按全量结果保存（等价 `files`）。

## 推荐模板

### 图像编辑（含参数映射）

```json
{
  "name": "guixuai_image_edit",
  "arguments": {
    "model": "seedream-4.5",
    "prompt": "改成纯白背景电商主图，主体居中，保留材质细节",
    "image_path": "./input.jpg",
    "ratio": "1:1",
    "quality": "high",
    "output": "files"
  }
}
```

### 文本任务

```json
{
  "name": "guixuai_chat_completion",
  "arguments": {
    "model": "seed-thinking",
    "prompt": "输出一个发布计划，分三阶段",
    "stream": false
  }
}
```

## 登录态处理

首次运行或会话失效时，按以下流程：

1. 调用 `guixuai_get_cookies` 检查 Cookie 数量。
2. 若为 0 或返回 `auth_required`/`403`，在 WebUI 触发登录模式重启并完成人工登录。
3. 登录后再次调用 `guixuai_get_cookies` 验证，再恢复任务。

## 返回结果约定

- 优先保留平台统一返回结构。
- 多图任务返回全量图片信息（`output_paths` + `image_count`）。
- 错误场景保留状态/进度/阶段信息，便于重试与排障。
