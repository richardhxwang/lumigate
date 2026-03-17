# LumiGate

**自部署 AI Agent 平台 — 8 家 AI 提供商、干净聊天代理、工具执行、文件生成、224 套模板、企业级安全，一条命令部署。**

LumiGate 从 API 网关发展为完整的 Agent Platform。通过 `POST /v1/chat` 统一端点代理 8 家 AI，服务端自动搜索、生成文件、执行工具。前端只收到干净文字 + 文件下载事件，不碰任何工具逻辑。内置 LumiChat 聊天 UI，支持 SSE 流式、PocketBase 认证、多模态输入。

NAS、mini PC 或任何装了 Docker 的机器都能跑。内存约 37 MiB。

## 快速开始

```bash
git clone https://github.com/richardhxwang/lumigate.git
cd lumigate
cp .env.example .env   # 填入 API key
docker compose up -d --build
# 打开 http://localhost:9471
```

## v4 新功能（Agent Platform）

| 功能 | 说明 |
|------|------|
| **干净聊天代理** | `POST /v1/chat` — 统一端点，前端只收干净文字 + `event: file_download` + `event: tool_status`，所有工具在服务端处理 |
| **工具执行** | AI 输出 `[TOOL:name]{params}[/TOOL]` → 服务端拦截执行 → 标记不到前端。兼容所有模型，不依赖 function calling |
| **文件生成** | 生成真实的 Excel（带公式）、Word、PowerPoint 文件，聊天内直接下载 |
| **224 套模板** | 专业金融模板（DCF、LBO、WACC、Black-Scholes、Goldman）+ 商业文档 + 演示文稿，12 个大类 |
| **安全管线** | PII 检测（20+ 正则 + Ollama 语义）、密钥遮蔽 `[SEC_xxx]`、命令防护（17 条规则）、SSRF 拦截 |
| **LumiChat** | 生产级聊天 UI：SSE 流式 + markdown、文件上传、语音输入、模型切换、PocketBase 认证、移动端适配 |
| **MCP 网关** | MCPJungle 集成 Playwright 浏览器自动化和外部工具服务器 |
| **分布式部署** | NAS (x86) + Mac Mini (ARM) 拆分部署，附迁移脚本 |
| **Whisper 语音** | 本地语音转文字（faster-whisper），Mac 上支持 Metal 加速 |

## 架构

```
                         ┌───────────────────────────────────────────────┐
                         │              LumiGate Server                  │
┌──────────┐            ├───────────────────────────────────────────────┤
│ LumiChat │──cookie──▶ │                                               │
│  (Web)   │            │  POST /v1/chat                                │
├──────────┤            │    ↓ 认证 ─▶ 自动搜索 ─▶ AI 代理              │
│ iOS App  │──HMAC────▶ │    ↓ 干净 SSE 管道（剥离工具标记）            │
├──────────┤            │    ↓ 执行工具 ─▶ file_download 事件            │
│ 任意 App │──Token───▶ │    ↓ AI 续写 ─▶ 只输出干净文字                │
└──────────┘            │                                               │
                         │  前端只收: 干净文字 + tool_status + file_download │
                         └───────┬──────────┬──────────┬────────────────┘
                                 │          │          │
                    ┌────────────┴──┐ ┌─────┴────┐ ┌──┴──────────┐
                    │ 8 家 AI 提供商│ │ 文件生成  │ │ PocketBase  │
                    │ OpenAI       │ │ SearXNG  │ │  (认证/数据) │
                    │ Anthropic    │ │ Whisper  │ └─────────────┘
                    │ Gemini       │ │ Gotenberg│
                    │ DeepSeek     │ └──────────┘
                    │ MiniMax      │
                    │ Kimi/Doubao  │
                    │ Qwen         │
                    └──────────────┘
```

## AI 提供商

| 提供商 | 接入方式 | 模型 |
|--------|---------|------|
| OpenAI | API Key | GPT-4.1, GPT-5, o3, o4-mini |
| Anthropic | API Key | Claude Opus/Sonnet/Haiku 4.x |
| Gemini | API Key | Gemini 2.5 Flash/Pro |
| DeepSeek | API Key | DeepSeek-Chat, DeepSeek-R1 |
| MiniMax | API Key | MiniMax-M1, M2, M2.5 |
| Kimi | Collector | Moonshot 系列 |
| Doubao | Collector | 字节跳动豆包系列 |
| Qwen | Collector | 通义千问系列 |

**Collector 模式**：LumiGate 控制无头 Chrome（CDP 协议）与 AI 提供商的网页端交互。管理员通过 VNC（端口 7900）登录一次，Chrome 记住会话。

## 工具执行

所有 AI 模型都能通过文本标记触发工具，不需要原生 function calling：

```
用户: "生成一个 2025-2029 营收预测 Excel"

AI 输出: [TOOL:generate_spreadsheet]{"title":"营收预测","sheets":[...]}[/TOOL]

服务端: 检测标记 → 执行工具 → 生成 .xlsx → 发送下载链接
前端: 只看到 tool_status + file_download + AI 总结文字
```

### 可用工具

| 工具 | 说明 |
|------|------|
| `generate_spreadsheet` | Excel 文件，支持公式（VLOOKUP、NPV、IRR、跨表引用） |
| `generate_document` | Word 文档，支持章节、表格、目录、页眉页脚 |
| `generate_presentation` | PowerPoint，支持图表、表格、布局、演讲备注 |
| `use_template` | 从 224 套模板中选择，自动填入数据 |
| `web_search` | SearXNG 网页搜索（`/v1/chat` 自动检测搜索意图，也可 `web_search: true` 显式触发） |
| `parse_file` | 解析 PDF、XLSX、DOCX、PPTX、HTML、CSV 提取文字 |
| `transcribe_audio` | 语音转文字（Whisper） |
| `vision_analyze` | 图片分析（Ollama 视觉模型） |
| `code_run` | Python/JS 沙箱执行（Docker 隔离） |

### 模板库（224 套）

| 分类 | 数量 | 重点模板 |
|------|------|---------|
| DCF 模型 | 13 | Intel DCF、三阶段、FCFF/FCFE、NPV |
| LBO 模型 | 10 | Goldman、Apple、Continental AG、ServiceCo |
| 并购 | 5 | 合并、增厚/摊薄、协同效应 |
| 估值 | 22 | WACC、CAPM、Beta、DuPont、巴菲特模型 |
| 期权 | 29 | Black-Scholes、Greeks、蒙特卡洛、障碍期权 |
| 债券 | 12 | 定价、久期、CMO、MBS |
| 衍生品 | 21 | 互换、CDS、VaR、利率 |
| 房地产 | 13 | 瀑布分配、合资、多户住宅 |
| 创投 | 11 | 股权结构表、VC 估值、LP 模型 |
| 预算 | 20 | 财务计划、现金流、Pro Forma |
| 演示 | 9 | 路演、投资论文、临床试验 |
| 文档 | 8 | NDA、SOW、项目章程、风险登记 |

## LumiChat

内置的生产级聊天 UI，通过 `POST /v1/chat` 与后端通信。前端零工具逻辑，只处理干净文字、状态提示、文件下载三种事件。

- **干净代理架构** — ~60 行 SSE 读取器替代了 250+ 行 agentic loop
- **SSE 流式** — Text node 渲染 + 结束后 markdown，长回复不卡
- **8 家 provider** — 模型搜索、tier 控制、BYOK
- **文件附件** — 图片、PDF、文档（自动解析）
- **语音输入** — 录制 + Whisper 转文字
- **工具下载** — Excel/Word/PPT 服务端生成，聊天内下载卡片
- **PocketBase 认证** — 邮箱密码 + Google OAuth，用户分级
- **移动端适配** — bottom-sheet 选模型、安全区域、手势
- **深色/浅色** — macOS 26 / Apple HIG 风格
- **预设** — 10 个内置 system prompt 模板，自定义预设
- **会话管理** — 历史、搜索、自动标题

## 安全

| 层级 | 防护 |
|------|------|
| **HMAC + Token 认证** | 密钥不传输；HMAC 签名交换 + 临时令牌 |
| **PII 检测** | 20+ 正则规则 + 可选 Ollama 语义分析 |
| **密钥遮蔽** | 检测到的密钥 → `[SEC_xxx]` 占位符，不发给 LLM |
| **命令防护** | 17 条规则拦截 rm -rf、mkfs、fork bomb 等 |
| **SSRF 防护** | 内网 IP/域名黑名单 + DNS 解析校验 |
| **项目级限制** | RPM、预算上限、IP 白名单、模型白名单、异常自动暂停 |
| **速率限制** | 按项目、按 token、按 IP、按费用（USD/分钟） |
| **工具注入防护** | 用户消息中的 `[TOOL:]` 标记在发给 AI 前被清除 |
| **审计日志** | 所有事件 → PocketBase（工具调用、安全事件、认证） |

### 认证方式

| 方式 | 适用场景 |
|------|---------|
| 直接 Key | 服务端对服务端 |
| HMAC 签名 | 移动端 App（密钥不传输） |
| 临时令牌 | 会话级访问 |
| HMAC + 令牌 | **C 端 App（推荐）** |

## 模块化

| 模式 | 模块 | 适用场景 |
|------|------|---------|
| **Lite** | usage, chat | 个人项目 |
| **Enterprise** | 全部 9 个模块 | 团队、合规 |
| **Custom** | 按需选配 | 定制部署 |

```bash
lg mode enterprise && lg restart
```

模块: `usage` · `budget` · `multikey` · `users` · `audit` · `metrics` · `backup` · `smart` · `chat`

## 自恢复

| 层级 | 恢复时间 |
|------|---------|
| Docker 健康检查 | ≤10 秒检测 |
| 容器重启策略 | 自动恢复 |
| macOS LaunchDaemon 看门狗 | Docker 崩了也能恢复 |
| 数据持久化 | RPO ≤ 1 秒（合并写入 + 紧急刷盘） |
| 网络韧性 | QUIC 隧道、Nginx 自动重试、keepalive 连接池 |

## 性能

| 场景 | QPS | 错误率 |
|------|-----|-------|
| /health（250 并发） | 12,788 | 0 |
| 仪表盘（200 并发） | 2,087 | 0 |
| 公网 Cloudflare QUIC（500 并发） | 476 | 0.06% |
| /v1/chat 非流式（100 并发） | 16.5 | 0 |
| /v1/chat 流式（50 并发） | 14.9 | 0 |

内存约 37 MiB（企业版 app + nginx）。安全功能零性能损耗。

## CLI

```bash
sudo ln -sf "$(pwd)/cli.sh" /usr/local/bin/lg
```

```
lg status          健康状态 + 提供商
lg mode enterprise 切换模式
lg projects        管理项目
lg usage           费用汇总
lg backup create   创建备份
lg logs            查看日志
lg restart         重建并重启
```

## API 文档

### 干净聊天代理（推荐所有 App 使用）

```bash
curl -N -X POST http://localhost:9471/v1/chat \
  -H "Content-Type: application/json" \
  -H "X-Project-Key: $KEY" \
  -d '{
    "provider": "deepseek",
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "生成Excel：季度销售表"}],
    "stream": true
  }'
```

**请求参数：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider` | string | 必填。openai / anthropic / gemini / deepseek / minimax / qwen / kimi / doubao |
| `model` | string | 必填。模型 ID |
| `messages` | array | 必填。OpenAI 格式 |
| `stream` | bool | 推荐 true |
| `web_search` | bool | 可选。true = 强制搜索，false = 禁止，不传 = 自动检测 |
| `tools` | bool | 可选。默认 true，false = 不注入工具提示 |

**SSE 响应（3 种事件）：**

```
data: {"choices":[{"delta":{"content":"文字"}}]}        # 干净文字，直接渲染
event: tool_status
data: {"text":"正在生成 Excel...","icon":"spreadsheet"}  # 状态提示
event: file_download
data: {"filename":"报告.xlsx","size":8019,...}            # 文件下载卡
data: [DONE]
```

**认证方式：** Project Key / HMAC / Ephemeral Token / LumiChat Cookie 全部支持。

### 直通代理

```bash
# 直通上游 API，不做工具处理
curl -X POST http://localhost:9471/v1/{provider}/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"gpt-4.1-nano","messages":[{"role":"user","content":"Hello"}]}'
```

### Agent Platform

```bash
# 直接执行工具
curl -X POST http://localhost:9471/v1/tools/execute \
  -H "X-Project-Key: $KEY" \
  -d '{"tool_name":"generate_spreadsheet","tool_input":{"title":"Model","sheets":[...]}}'

# 解析文件
curl -X POST http://localhost:9471/v1/parse -F file=@document.pdf

# 语音转文字
curl -X POST http://localhost:9471/v1/audio/transcribe -F file=@recording.wav
```

## 项目结构

```
├── server.js               # Express 主服务 — 代理、认证、工具，6000+ 行
├── security/               # PII 检测、密钥遮蔽、命令防护、SSRF 校验
├── tools/                  # 统一工具注册、MCP 客户端、224 套模板
├── routes/                 # Agent API（解析、语音、视觉、代码）
├── middleware/             # 安全 + 审计中间件
├── collector/              # Chrome CDP 网页采集（kimi/doubao/qwen）
├── public/
│   ├── lumichat.html       # LumiChat — 聊天 UI（4000+ 行）
│   └── index.html          # 仪表盘 SPA
├── templates/              # 224 套金融/商业模板
├── whisper-server/         # 本地 Whisper STT（Python, faster-whisper）
├── doc-gen/                # 文件生成微服务
├── docker-compose.yml      # 生产环境: nginx + app + searxng + doc-gen + gotenberg
├── deploy/                 # NAS/Mac 拆分部署 + migrate.sh
└── tests/                  # Playwright E2E 测试
```

## 部署方式

| 目标 | 方法 |
|------|------|
| **单机** | `docker compose up -d --build` |
| **NAS + Mac Mini** | `deploy/nas/` + `deploy/mac/` 拆分配置 |
| **迁移** | `deploy/migrate.sh` — 复制数据、PB、隧道 |

## 测试结果

| 测试 | 结果 |
|------|------|
| /v1/chat 多 provider（DeepSeek、OpenAI、Gemini） | 3/3 通过 |
| /v1/chat 搜索自动检测（中文+英文） | 通过 |
| /v1/chat 文件生成（Excel、Word） | 通过 |
| /v1/chat 工具标记剥离（无泄露） | 通过 |
| 安全：认证绕过（无key/假key/HMAC/过期token） | 4/4 通过 |
| 安全：注入（路径遍历/shell/XSS/SSRF） | 通过 |
| 安全：model 白名单 + 预算上限 | 通过 |
| 安全：工具标记注入防护 | 通过 |
| 安全：速率限制 | 通过 |
| 公网端到端（lumigate.autorums.com） | 通过 |
