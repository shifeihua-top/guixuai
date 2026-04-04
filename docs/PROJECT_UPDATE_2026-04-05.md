# 项目更新说明（2026-04-05）

本次更新重点增强了 OpenClaw/MCP 接入体验、登录与安全初始化流程，以及多 Token 的审计可观测能力。

## 1. OpenClaw + MCP 接入增强

- 新增内置 MCP Server（stdio）工具链，统一暴露：
  - `guixuai_list_models`
  - `guixuai_chat_completion`
  - `guixuai_image_edit`
  - `guixuai_get_cookies`
- 提供 OpenClaw Skill 模板文件：`SKILL.md`
- WebUI 系统设置页新增一键复制：
  - `复制 MCP 配置`
  - `复制 OpenClaw 配置+Skill 安装`
- 新增 MCP 输出模式 smoke 测试脚本：
  - `npm run mcp:smoke:image-output`

## 2. 登录与初始化能力

- 首次安装支持 WebUI 引导初始化：
  - 可直接设置管理员账号密码
  - 可手工输入 API Token，或由系统自动生成
- 登录态支持账号密码登录换取 API Token
- 保留登录模式重启能力，便于人工补登录（例如第三方站点会话修复）

## 3. 多 Token 管理能力

- 配置层支持多 Token（`server.authTokens`），并与 `server.auth` 兼容
- WebUI 支持多 Token 可视化增删改、启停、主 Token 选择
- 多 Token 可并行调用，不同调用方可使用不同 token 访问同一网关

## 4. 按 Token 的日志与审计

- 请求历史新增 token 维度记录字段：
  - `token_id`
  - `token_name`
  - `token_masked`
- 历史查询支持按 token 筛选：
  - `GET /admin/history?token=<tokenId>`
- 统计摘要支持按 token 过滤：
  - `GET /admin/history/stats?token=<tokenId>`
- 新增 token 统计接口：
  - `GET /admin/history/tokens`

## 5. 升级后建议验证

1. 在系统设置页配置至少 2 个 token，并保存。
2. 使用不同 token 分别请求 `/v1/chat/completions`。
3. 在“请求记录”页面按 token 过滤，确认统计与记录一致。
4. 在 OpenClaw 中粘贴一键复制的 MCP 配置并导入 `SKILL.md`，执行一次 `guixuai_image_edit`。
