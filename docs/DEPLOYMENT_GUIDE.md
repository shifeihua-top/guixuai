# 部署与运维指南

更新时间：2026-04-03

## 1. 运行方式

支持两种方式：

- 本地源码运行
- Docker 容器运行

## 2. 环境要求

- Node.js >= 20
- 可访问浏览器依赖下载源（首次初始化需要）
- Linux 场景建议安装 `xvfb` + `x11vnc` 以支持虚拟显示

## 3. 本地部署

```bash
pnpm install
npm run init
npm start
```

登录初始化（可选）：

```bash
npm start -- -login
```

## 4. Docker 部署

```bash
docker run -d --name guixuai \
  -p 3000:3000 \
  -v "$(pwd)/data:/app/data" \
  --shm-size=2gb \
  ghcr.io/your-org/guixuai:latest
```

或：

```bash
docker-compose up -d
```

## 5. 生产建议

- 强制开启 API Token 鉴权
- 使用 HTTPS（Nginx/Caddy/网关）
- 限制公网暴露范围（IP 白名单、隧道、WAF）
- 定期轮换鉴权密钥
- 配置日志轮转与磁盘告警

## 6. 诊断建议

- `/admin/status`：服务状态
- `/v1/models`：适配器与模型可用性
- `/v1/cookies`：登录态排查
- WebUI 日志模块：请求与错误回溯
