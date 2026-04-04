# dou包场景示例（文本与图片生成）

更新时间：2026-04-03

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
- 图像任务建议使用非流式，便于一次性获取结果
- 若出现登录态问题，先通过 `GET /v1/cookies` 排查实例会话
