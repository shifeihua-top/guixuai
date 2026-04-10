# GuiXuAI (万智归墟)

简体中文 | [English](README_EN.md)

## 项目定位

GuiXuAI 是一个面向浏览器自动化场景的统一 AI API 网关。  
它把多来源的 Web AI 能力封装为统一接口，降低接入复杂度，让业务侧可以用一致协议快速上线。

## 核心能力

- 统一 API：对外提供 OpenAI 兼容接口
- 多实例隔离：支持多账号、多会话并行运行
- 稳定调度：内置队列、重试、故障转移
- 豆包多图极速回传：流式模式下优先返回全部原始生成链接，再补充服务侧处理结果
- 可视化控制：提供 Web 管理界面用于配置、日志与状态查看
- 多 Token 管理：支持并行 token、按 token 调用记录与筛选

## 示例效果

图像编辑场景示例：将实拍门体图处理为白底电商正视图。

### 前后对比

原图（场景图）  
![原图](docs/assets/example-original.jpg)

处理后（白底电商正视图）  
![白底电商正视图示例](docs/assets/example-whitebg-ecommerce.png)

### 处理过程说明

1. 输入原图：使用实拍场景图作为参考图输入。  
2. 指令约束：要求“去背景、纯白底、主体居中、正视图、保留材质细节”。  
3. 图像编辑：通过图像模型执行图生图/编辑流程。  
4. 结果校验：输出电商可用主图，背景杂物已清理，主体完整保留。

## 快速开始

### 环境要求

- Node.js 20+
- pnpm

### 本地运行

```bash
pnpm install
npm run init
npm start
```

首次启动后会自动生成 `data/config.yaml`，你只需配置鉴权密钥并重启服务：

```yaml
server:
  port: 3000
  auth: sk-change-me-to-your-secure-key
```

现在也支持首装引导模式：

- 若检测到默认/空 Token，WebUI 会进入“首次初始化”
- 直接在页面设置管理员账号密码（可选自定义 Token，留空自动生成）
- 完成后自动登录，不再需要手动编辑配置文件
- 系统设置页支持一键复制 MCP 配置和 OpenClaw Skill 安装说明

## Docker 部署

直接拉取并运行：

```bash
docker run -d --name guixuai \
  -p 3000:3000 \
  -v "$(pwd)/data:/app/data" \
  --shm-size=2gb \
  ghcr.io/shifeihua-top/guixuai:latest
```

指定宿主机目录保存数据：

```bash
mkdir -p ./guixuai-data
docker run -d --name guixuai \
  -p 3000:3000 \
  -v "$(pwd)/guixuai-data:/app/data" \
  --restart unless-stopped \
  --shm-size=2gb \
  ghcr.io/shifeihua-top/guixuai:latest
```

或使用：

```bash
docker compose up -d
```

也可以直接使用一键脚本（默认拉取 `ghcr.io/shifeihua-top/guixuai:latest`）：

```bash
npm run docker:deploy
```

常用运维命令：

```bash
npm run docker:status
npm run docker:logs
npm run docker:restart
npm run docker:stop
```

拉取失败报 `denied` 时，可先登录 GHCR 后再部署：

```bash
echo <GHCR_TOKEN> | docker login ghcr.io -u <GHCR_USERNAME> --password-stdin
npm run docker:deploy
```

### Docker 启动后怎么用

容器启动后，先访问：

- Web 管理界面：`http://127.0.0.1:3000/`
- 模型列表：`http://127.0.0.1:3000/v1/models`

带 Token 检查服务状态：

```bash
curl -sS http://127.0.0.1:3000/admin/status \
  -H "Authorization: Bearer sk-your-token"
```

如果部署在其他机器，把 `127.0.0.1:3000` 换成你的服务器 IP 或域名，例如：

- `http://192.168.1.20:3000/`
- `https://ai.example.com/`

### 首次配置流程

首次打开 WebUI 后，按下面顺序完成初始化：

1. 打开 `http://你的地址:3000/`
2. 进入“首次初始化”页面
3. 设置管理员账号和密码
4. 设置 API Token
   留空会自动生成一个安全 Token
5. 完成初始化后自动登录
6. 进入“系统设置”继续补充业务配置、实例、适配器登录态等

建议至少完成这两项：

- 配置一个你自己保存的 API Token，方便别的系统稳定调用
- 在 WebUI 中完成对应平台账号登录态初始化，例如 dou包、Gemini、Sora、JD 等

### 给别的系统和程序调用

本项目对外提供 OpenAI 兼容接口，调用方式和常见 OpenAI SDK/网关基本一致。

你只需要准备两项：

- Base URL：`http://你的地址:3000`
- Bearer Token：初始化时设置或自动生成的 API Token

最常用的两个接口：

- `GET /v1/models`：先获取当前可用模型
- `POST /v1/chat/completions`：文本、图片、生成任务统一入口

先测试模型列表：

```bash
curl -sS http://127.0.0.1:3000/v1/models \
  -H "Authorization: Bearer sk-your-token"
```

再测试一次最简单的文本调用：

```bash
curl -sS http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seed",
    "stream": false,
    "messages": [
      { "role": "user", "content": "只回复：测试通过" }
    ]
  }'
```

### 其他程序接入示例

Python：

```python
import requests

BASE_URL = "http://127.0.0.1:3000"
TOKEN = "sk-your-token"

resp = requests.post(
    f"{BASE_URL}/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
    },
    json={
        "model": "seed",
        "stream": False,
        "messages": [
            {"role": "user", "content": "只回复：测试通过"}
        ],
    },
    timeout=180,
)

print(resp.json())
```

JavaScript / Node.js：

```js
const resp = await fetch("http://127.0.0.1:3000/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: "Bearer sk-your-token",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "seed",
    stream: false,
    messages: [
      { role: "user", content: "只回复：测试通过" }
    ]
  })
});

const data = await resp.json();
console.log(data);
```

### 给第三方平台接 OpenAI SDK

如果你的程序支持“自定义 OpenAI Base URL”，通常这样填：

- Base URL：`http://127.0.0.1:3000/v1`
- API Key：`sk-your-token`

例如：

- Dify
- FastGPT
- OpenWebUI
- Ragflow
- n8n
- 自研后端服务
- 各类支持 OpenAI 协议的桌面客户端或插件

如果第三方平台需要“模型名”，不要手填猜测，先请求 `/v1/models`，再从返回结果里选择实际可用模型。

### 本地 3000 端口无法访问时怎么排查

如果执行 `docker run` 后打不开 `http://127.0.0.1:3000/`，通常是下面几类原因：

1. 容器根本没有启动成功
2. 宿主机 `3000` 端口已被其他程序占用
3. 容器已启动，但服务进程在容器内退出或进入安全模式
4. 你访问的不是部署机器本机，或者被防火墙/安全组拦截

先看容器状态：

```bash
docker ps -a --filter name=guixuai
```

如果状态不是 `Up`，直接看日志：

```bash
docker logs --tail 200 guixuai
```

最常见的判断方式：

- 如果看到 `Bind for 0.0.0.0:3000 failed` 或类似报错：说明宿主机 `3000` 已被占用  
  处理方式：换端口重新启动，例如 `-p 3100:3000`
- 如果容器不断退出：说明容器内服务启动失败  
  处理方式：优先看 `docker logs guixuai`
- 如果日志里有 `HTTP 服务器已启动，端口: 3000`：说明容器内服务已经起来了  
  此时重点检查宿主机端口映射、防火墙和访问地址
- 如果日志里有 `进入安全模式`：说明 WebUI 可打开，但 OpenAI API 暂不可用  
  处理方式：打开 WebUI 完成配置修复，再重启容器

检查宿主机端口映射：

```bash
docker ps --filter name=guixuai --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

正常情况下你应该看到类似：

```text
0.0.0.0:3000->3000/tcp
```

如果宿主机 `3000` 已被占用，推荐改成：

```bash
docker rm -f guixuai
docker run -d --name guixuai \
  -p 3100:3000 \
  -v "$(pwd)/guixuai-data:/app/data" \
  --restart unless-stopped \
  --shm-size=2gb \
  ghcr.io/shifeihua-top/guixuai:latest
```

然后访问：

```text
http://127.0.0.1:3100/
```

如果你是在另一台机器上访问，还需要确认：

- 服务器防火墙已放行对应端口
- 云服务器安全组已放行对应端口
- 访问地址使用的是服务器真实 IP / 域名，不是容器内地址

### 公网部署 + Nginx 反代

推荐做法：

1. 容器只监听本机端口，例如 `127.0.0.1:3000`
2. 对外只开放 `80/443`
3. 用 Nginx 统一做 HTTPS、域名和反向代理

示例启动方式：

```bash
mkdir -p ./guixuai-data
docker run -d --name guixuai \
  -p 127.0.0.1:3000:3000 \
  -v "$(pwd)/guixuai-data:/app/data" \
  --restart unless-stopped \
  --shm-size=2gb \
  ghcr.io/shifeihua-top/guixuai:latest
```

Nginx 站点示例：

```nginx
server {
    listen 80;
    server_name ai.example.com;

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }
}
```

配置完成后：

1. 将域名 `ai.example.com` 解析到你的服务器 IP
2. `nginx -t` 检查配置
3. `systemctl reload nginx` 或重载 Nginx
4. 再用 Certbot / ACME 补上 HTTPS

公网部署后，用户访问：

- WebUI：`https://ai.example.com/`
- 模型列表：`https://ai.example.com/v1/models`
- 推理接口：`https://ai.example.com/v1/chat/completions`

第三方系统接入时填写：

- Base URL：`https://ai.example.com/v1`
- API Key：你的 `sk-...` Token

## API 概览

- `GET /v1/models`：获取可用模型
- `POST /v1/chat/completions`：统一推理与生成入口
- `GET /v1/cookies`：排查会话状态
- `npm run mcp:start`：启动 MCP Server（stdio）

请求鉴权：

```http
Authorization: Bearer <server.auth>
```

## MCP 快速接入

项目内置 MCP Server，可用于 OpenClaw / 通用 MCP 客户端：

```bash
GUIXUAI_BASE_URL=http://127.0.0.1:3000 \
GUIXUAI_API_TOKEN=sk-your-token \
npm run mcp:start
```

OpenClaw Skill 示例文件（可直接复用）：

- [OpenClaw Skill 模板](SKILL.md)
- `npm run mcp:smoke:image-output`：自动验证 MCP 图像 `output` 模式（inline/file/files）

补充：
- 在 WebUI「系统设置」点击 `复制 OpenClaw 配置+Skill 安装`，会自动带上当前项目绝对路径。
- 复制内容中已包含 Skill 解释、导入路径和可选的一键复制命令，可直接照着执行。

## 文档导航

- [文档总览](docs/README.md)
- [项目更新说明（2026-04-05）](docs/PROJECT_UPDATE_2026-04-05.md)
- [通用 API 指南](docs/UNIVERSAL_API_GUIDE.md)
- [MCP 接入指南](docs/MCP_GUIDE.md)
- [部署与运维指南](docs/DEPLOYMENT_GUIDE.md)
- [适配器开发指南](docs/ADAPTER_GUIDE.md)
- [dou包场景示例](docs/DOUBAO_EXAMPLES.md)
- [电商场景扩展示例](docs/JD_AUTOMATION.md)

## 安全建议

- 生产环境务必启用强鉴权密钥
- 对公网访问启用 HTTPS 或隧道
- 定期轮换密钥并限制管理端暴露范围
