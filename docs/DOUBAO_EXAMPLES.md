# dou包场景示例（文本、图片与视频生成）

更新时间：2026-04-05

本示例面向已启用 `doubao_text` 与 `doubao` 适配器的场景，统一通过 OpenAI 兼容接口调用。

## 1. 前置条件

请确保在 `data/config.yaml` 中启用对应 Worker，例如：

```yaml
backend:
  pool:
    instances:
      - name: "browser_default"
        workers:
          - name: "doubao_text_worker"
            type: doubao_text
          - name: "doubao_image_worker"
            type: doubao
```

并确保该实例完成过 dou包 网页登录态初始化。

## 2. 文本生成示例

可用文本模型示例：

- `seed`
- `seed-thinking`
- `seed-pro`
- `seed-super`（超能模式）

调用示例：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-change-me-to-your-secure-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seed-thinking",
    "stream": false,
    "messages": [
      { "role": "user", "content": "用三点总结浏览器自动化网关的价值" }
    ]
  }'
```

## 3. 文生图示例

可用图片模型示例：

- `seedream5.0Lite`
- `seedream-4.5`
- `seedream-4.0`
- `seedream-3.0`

调用示例：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-change-me-to-your-secure-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedream-4.5",
    "stream": false,
    "messages": [
      { "role": "user", "content": "生成一张科技感产品海报，蓝黑配色，简洁构图" }
    ]
  }'
```

## 4. 图生图示例

图片输入使用 `data:image/...;base64,...`：

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
          { "type": "text", "text": "保留主体，改成浅灰背景电商主图风格" },
          { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,你的Base64" } }
        ]
      }
    ]
  }'
```

## 5. AI 抠图示例

`ai-cutout` 模型要求必须传图（`imagePolicy: required`）。

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
          { "type": "text", "text": "抠出主体，保持边缘自然" },
          { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,你的Base64" } }
        ]
      }
    ]
  }'
```

## 6. 建议

- 先调用 `GET /v1/models` 动态确认当前可用模型
- 图像任务若追求“最快可见结果”，建议使用流式模式
- 若出现登录态问题，先通过 `GET /v1/cookies` 排查实例会话

## 6.1 流式多图极速返回（推荐）

`doubao` 生图在流式模式下支持“先全量原始链接，再补充服务处理图”：

1. 第一阶段：快速返回本轮全部原始候选链接（`source_image_n` / `source_video_n`）
2. 第二阶段：继续下载并返回服务侧可直接展示的媒体（`service_image_n` / `service_video_n`）

调用示例：

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-change-me-to-your-secure-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedream-4.5",
    "stream": true,
    "messages": [
      { "role": "user", "content": "生成4张同主题不同构图的客厅效果图" }
    ]
  }'
```

说明：

- 首个 SSE chunk 通常先返回多条 `source_image_*` 链接，便于业务侧第一时间拿到完整原始结果
- 后续 chunk 返回 `service_image_*`（data URL）用于直接预览
- WebUI 接口测试预览已支持解析并展示上述全量返回格式

## 7. 视频生成示例（豆包图像模式切换“视频”）

可用视频模型示例：

- `seedance-2.0-fast`
- `doubao-video-seedance-2.0-fast`（别名）

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-change-me-to-your-secure-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedance-2.0-fast",
    "stream": false,
    "messages": [
      { "role": "user", "content": "生成一个 5 秒科技感粒子旋转视频，深蓝背景，镜头缓慢推进" }
    ]
  }'
```

## 8. 超能模式示例（长任务）

超能模式会执行更长时间任务，返回文本结果，并在有交付链接时附带“任务交付”列表：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-change-me-to-your-secure-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seed-super",
    "stream": false,
    "messages": [
      { "role": "user", "content": "分析新能源车行业趋势并输出可执行周报模板，若有交付文件请附上" }
    ]
  }'
```

相关超时配置（可选）：

```yaml
backend:
  adapter:
    doubao:
      imageTimeoutMs: 420000
      superTaskTimeoutMs: 900000
```

说明：

- 超能模式会在日志中持续输出进度阶段（避免长时间无反馈）
- 当页面长时间稳定无变化时，会主动检查当前结果并尽量返回已完成内容
- 为避免输入框遮挡底部操作区，适配器会在结果整理前自动上滚视图后再提取内容
- 已支持两种超能模式界面：
  - 对话单栏结果
  - 左侧任务/文件 + 右侧文件正文（分栏模式，自动尝试抓取右侧下载交付线索）
