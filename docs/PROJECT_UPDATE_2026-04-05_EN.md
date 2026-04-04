# Project Update Notes (2026-04-05)

This release focuses on OpenClaw/MCP onboarding, secure first-run login setup, and per-token observability for auditing.

## 1. OpenClaw + MCP Integration Improvements

- Built-in MCP server (stdio) with unified tools:
  - `guixuai_list_models`
  - `guixuai_chat_completion`
  - `guixuai_image_edit`
  - `guixuai_get_cookies`
- Added OpenClaw skill template: `SKILL.md`
- New one-click copy actions in WebUI server settings:
  - `Copy MCP Config`
  - `Copy OpenClaw Config + Skill Install`
- Added MCP output-mode smoke test:
  - `npm run mcp:smoke:image-output`

## 2. Login and Initialization

- First-run WebUI onboarding now supports:
  - Setting admin username/password directly in UI
  - Providing custom API token or auto-generating one
- Password login now returns API token for admin sessions
- Login-mode restart workflow remains available for manual re-auth/session recovery

## 3. Multi-Token Controls

- Config-level multi-token support via `server.authTokens` (compatible with `server.auth`)
- WebUI supports visual add/edit/remove/enable/disable and primary token selection
- Multiple tokens can call the same gateway in parallel

## 4. Token-Aware Logs and Auditing

- Request history now records token dimensions:
  - `token_id`
  - `token_name`
  - `token_masked`
- History list filter by token:
  - `GET /admin/history?token=<tokenId>`
- Stats filter by token:
  - `GET /admin/history/stats?token=<tokenId>`
- Token usage/stats endpoint:
  - `GET /admin/history/tokens`

## 5. Post-Upgrade Validation Checklist

1. Configure at least two tokens in server settings and save.
2. Send `/v1/chat/completions` requests with different tokens.
3. Verify token filter + stats in request history page.
4. Paste one-click MCP config into OpenClaw, import `SKILL.md`, and run `guixuai_image_edit`.
