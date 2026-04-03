# 京东账号登录与商品详情采集方案

更新时间：2026-04-01

## 1. 可行性结论

可行。当前项目已支持新增 `jd` 适配器，通过已登录的京东网页会话采集以下字段：

- 商品名称
- 商品价格
- 商品规格参数
- 商品主图
- 商品详情图

采集入口使用现有 OpenAI 兼容接口：`POST /v1/chat/completions`。

## 2. 已实现能力

代码位置：
- [src/backend/adapter/jd.js](../src/backend/adapter/jd.js)
- [src/backend/pool/Worker.js](../src/backend/pool/Worker.js)

实现点：
- 新增适配器 `jd`
- 新增模型 `jd-product-detail`（文本返回，内容为结构化 JSON 字符串）
- 输入支持直接传京东 URL，或传 JSON 负载（可设置图片数量上限/滚动轮数）
- 定时保活：Worker 空闲时按周期调用适配器 `keepAlive`
- 集中模式：同进程串行执行采集任务（降低并发行为特征）
- 频率控制：每次采集最小间隔 + 抖动

## 3. 配置方式

先在 `data/config.yaml` 增加一个京东 Worker，例如：

```yaml
backend:
  pool:
    instances:
      - name: "browser_default"
        workers:
          - name: "jd_worker"
            type: jd
```

再补充适配器配置（可放在 `backend.adapter.jd`）：

```yaml
backend:
  adapter:
    jd:
      concentratedMode:
        enabled: true
      rateLimit:
        minIntervalMs: 6000
        jitterMs: 2000
      keepAlive:
        enabled: true
        intervalMs: 900000
        jitterMs: 60000
        targetUrl: "https://www.jd.com/"
      collect:
        detailScrollRounds: 10
        detailImageLimit: 80
        mainImageLimit: 10
```

说明：
- `concentratedMode.enabled=true`：串行化执行当前适配器任务。
- `rateLimit`：限制抓取频率，避免高频请求行为。
- `keepAlive.enabled=true`：开启空闲保活，维持登录态活跃。
- `backend.pool.keepAliveTickMs`：Worker 轮询 keepAlive 的检查周期（默认 60000ms）。

## 4. 登录与保活流程

1. 启动登录模式并指定京东 Worker：

```bash
npm start -- -login=jd_worker
```

2. 在弹出的浏览器中手动完成京东登录（扫码/验证）。
3. 关闭登录窗口，服务退出登录模式。
4. 常规启动服务：

```bash
npm start
```

5. 开启 `keepAlive.enabled=true` 后，Worker 空闲时会周期性访问保活地址。

## 5. 采集调用示例

## 5.1 直接传商品链接

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-change-me-to-your-secure-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jd-product-detail",
    "stream": false,
    "messages": [
      { "role": "user", "content": "https://item.jd.com/100012043978.html" }
    ]
  }'
```

## 5.2 JSON 任务参数

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-change-me-to-your-secure-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jd/jd-product-detail",
    "messages": [
      {
        "role": "user",
        "content": "{\"url\":\"https://item.jd.com/100012043978.html\",\"detailImageLimit\":50,\"mainImageLimit\":8,\"detailScrollRounds\":12}"
      }
    ]
  }'
```

## 6. 返回结果结构

返回在 `choices[0].message.content` 中，是 JSON 字符串，字段如下：

- `source`
- `fetchedAt`
- `productUrl`
- `productName`
- `productPrice`
- `specifications`（`[{ key, value }]`）
- `mainImages`（URL 数组）
- `detailImages`（URL 数组）

## 7. 稳定性与风控建议

- 建议单账号单 Worker，避免多 Worker 共用同账号并发操作。
- 建议维持 `concentratedMode.enabled=true` 和合理 `rateLimit`。
- 采集频率不要过高，避免触发登录验证/滑块风控。
- 若页面出现验证，需人工处理后再继续采集。

## 8. 合规提醒

请确保你对目标账号与数据采集行为具备合法授权，并遵守平台服务条款与当地法律法规。
