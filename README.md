# LumiGate

**Self-hosted AI Agent Platform — 8 providers, clean chat proxy, tool execution, file generation, 224 templates, enterprise security, one command to deploy.**

LumiGate 从 AI API 网关发展为完整的 **Agent Platform**。通过统一的 `POST /v1/chat` 端点代理 8 家 AI 提供商，服务端自动执行工具（Excel/Word/PPT 生成、网页搜索、文件解析、图像识别、代码沙箱），内置 224 套专业金融模板。前端只收到干净文字 + 文件下载事件，不接触任何工具逻辑。附带 LumiChat — 生产级聊天 UI，支持 SSE 流式、PocketBase 认证、多模态输入。

Runs on a NAS, mini PC, or any machine with Docker. ~37 MiB total memory.

## Quick Start

```bash
git clone https://github.com/richardhxwang/lumigate.git
cd lumigate
cp .env.example .env   # Add your API keys
docker compose up -d --build
# Open http://localhost:9471
```

Or use the prebuilt Docker image:
```bash
docker run -d --name lumigate -p 9471:9471 -e ADMIN_SECRET=change-me -v "${PWD}/data:/app/data" richardhwang920/lumigate:latest
```

## What's New in v4 (Agent Platform)

| Capability | Description |
|------------|-------------|
| **Clean Chat Proxy** | `POST /v1/chat` — 统一端点，前端只收干净文字 + `event: file_download` + `event: tool_status`。所有工具处理在服务端完成 |
| **Tool Execution** | AI 输出 `[TOOL:name]{params}[/TOOL]` 标记 → 服务端拦截执行 → 标记不会到达前端。兼容所有模型，不依赖 function calling |
| **File Generation** | Generate real Excel (.xlsx with formulas), Word (.docx), PowerPoint (.pptx) files. Download directly from chat |
| **224 Templates** | Professional finance templates (DCF, LBO, WACC, Black-Scholes, Goldman models) + business documents + presentations across 12 categories |
| **Security Pipeline** | PII detection (20+ patterns + Ollama semantic), secret masking `[SEC_xxx]`, command guard (17 rules), SSRF protection |
| **LumiChat** | Full chat UI: SSE streaming with live markdown, file upload, voice input, model switching, PocketBase auth, mobile responsive |
| **MCP Gateway** | MCPJungle integration for Playwright browser automation and external tool servers |
| **Multi-Deploy** | Split Docker Compose for NAS (x86) + Mac Mini (ARM), migration script included |
| **Whisper STT** | Local speech-to-text server (faster-whisper), runs on Mac with Metal acceleration |

## Architecture

```
                         ┌───────────────────────────────────────────────┐
                         │              LumiGate Server                  │
┌──────────┐            ├───────────────────────────────────────────────┤
│ LumiChat │──cookie──▶ │                                               │
│  (Web)   │            │  POST /v1/chat                                │
├──────────┤            │    ↓ Auth ─▶ Pre-search ─▶ AI Proxy           │
│ iOS App  │──HMAC────▶ │    ↓ Clean SSE Pipe (strip tool tags)         │
├──────────┤            │    ↓ Tool Execute ─▶ file_download events      │
│ Any App  │──Token───▶ │    ↓ Resume AI ─▶ clean text only             │
└──────────┘            │                                               │
                         │  前端只收: 干净文字 + tool_status + file_download │
                         └───────┬──────────┬──────────┬────────────────┘
                                 │          │          │
                    ┌────────────┴──┐ ┌─────┴────┐ ┌──┴──────────┐
                    │ 8 AI Providers│ │ Doc-Gen  │ │ PocketBase  │
                    │ OpenAI       │ │ SearXNG  │ │ (Auth/Data) │
                    │ Anthropic    │ │ Whisper  │ └─────────────┘
                    │ Gemini       │ │ Gotenberg│
                    │ DeepSeek     │ └──────────┘
                    │ MiniMax      │
                    │ Kimi/Doubao  │
                    │ Qwen         │
                    └──────────────┘
```

## Providers

| Provider | Mode | Models |
|----------|------|--------|
| OpenAI | API Key | GPT-4.1, GPT-4o, o3, o4-mini |
| Anthropic | API Key | Claude Opus/Sonnet/Haiku 4.x |
| Gemini | API Key | Gemini 2.5 Flash/Pro |
| DeepSeek | API Key | DeepSeek-Chat, DeepSeek-R1 |
| MiniMax | API Key | MiniMax-M1, M2, M2.5 |
| Kimi | Collector | Moonshot models |
| Doubao | Collector | ByteDance models |
| Qwen | Collector | Tongyi Qwen models |

**Collector mode**: LumiGate controls a headless Chrome (via CDP) to interact with provider web UIs. Admin logs in once via VNC (port 7900), Chrome remembers the session.

## Tool Execution

Any AI model can trigger tools by outputting text tags — no native function calling needed:

```
User: "Generate a revenue forecast Excel for 2025-2029"

AI outputs: [TOOL:generate_spreadsheet]{"title":"Revenue Forecast","sheets":[...]}[/TOOL]

Server: detects tag → executes tool → generates .xlsx → sends download link
```

### Available Tools

| Tool | Description |
|------|-------------|
| `generate_spreadsheet` | Excel with formulas (VLOOKUP, NPV, IRR, cross-sheet refs) |
| `generate_document` | Word docs with sections, tables, TOC, headers/footers |
| `generate_presentation` | PowerPoint with charts, tables, layouts, speaker notes |
| `use_template` | Pick from 224 professional templates, fill with data |
| `web_search` | SearXNG 网页搜索（`/v1/chat` 自动检测搜索意图，也可 `web_search: true` 显式触发） |
| `parse_file` | Extract text from PDF, XLSX, DOCX, PPTX, HTML, CSV |
| `transcribe_audio` | Speech-to-text (Whisper) |
| `vision_analyze` | Image analysis (Ollama vision models) |
| `code_run` | Python/JS sandbox execution (Docker isolated) |

### Template Library (224 templates)

| Category | Count | Highlights |
|----------|-------|------------|
| DCF Models | 13 | Intel DCF, Three-Stage, FCFF/FCFE, NPV |
| LBO Models | 10 | Goldman, Apple, Continental AG, ServiceCo |
| M&A | 5 | Merger, Accretion/Dilution, Synergy |
| Valuation | 22 | WACC, CAPM, Beta, DuPont, Warren Buffett |
| Options | 29 | Black-Scholes, Greeks, Monte Carlo, Barrier |
| Bonds | 12 | Valuation, Duration, CMO, MBS |
| Derivatives | 21 | Swaps, CDS, VaR, Interest Rate |
| Real Estate | 13 | Waterfall, JV, Multifamily |
| Startup/VC | 11 | Cap table, VC valuation, LP model |
| Budgeting | 20 | Financial plans, Cash flow, Proforma |
| Presentations | 9 | Pitch deck, Investment thesis, Clinical trial |
| Documents | 8 | NDA, SOW, Project charter, Risk register |

## LumiChat

内置的生产级聊天 UI，通过 `POST /v1/chat` 与后端通信。前端零工具逻辑 — 只处理干净文字、状态提示、文件下载三种事件。

- **Clean Proxy 架构** — 前端 ~60 行 SSE 读取器替代了原来 250+ 行的 agentic loop
- **SSE 流式** — Text node 渲染 + 结束后 markdown，长回复不卡
- **8 家 provider** — 模型搜索、tier 控制、BYOK
- **文件附件** — 图片、PDF、文档（自动解析）
- **语音输入** — 麦克风录制 + Whisper 转文字
- **工具下载** — Excel/Word/PPT 服务端生成，聊天内下载卡片
- **PocketBase 认证** — 邮箱密码 + Google OAuth，用户分级
- **移动端适配** — bottom-sheet 选模型、安全区域、手势
- **深色/浅色** — macOS 26 / Apple HIG 风格
- **预设** — 10 个内置 system prompt 模板，自定义预设
- **会话管理** — 历史、搜索、自动标题

## Security

| Layer | Protection |
|-------|-----------|
| **HMAC + Token Auth** | Key never transmitted; HMAC-signed exchange + ephemeral tokens |
| **PII Detection** | 20+ regex patterns + optional Ollama semantic analysis |
| **Secret Masking** | Detected secrets → `[SEC_xxx]` placeholders before LLM |
| **Command Guard** | 17 rules blocking rm -rf, mkfs, fork bombs, etc. |
| **SSRF Protection** | Private IP/hostname blocklist with DNS resolution check |
| **Per-Project Limits** | RPM, budget cap, IP allowlist, model allowlist, anomaly auto-suspend |
| **Rate Limiting** | Per-project, per-token, per-IP, cost-based (USD/min) |
| **Audit Trail** | All events → PocketBase (tool calls, security events, auth) |

### Auth Modes

| Mode | Best For |
|------|----------|
| Direct Key | Server-to-server |
| HMAC Signature | Mobile apps (key never transmitted) |
| Ephemeral Token | Session-bound access |
| HMAC + Token | **C-end apps (recommended)** |

## Modular Design

| Mode | Modules | Best For |
|------|---------|----------|
| **Lite** | usage, chat | Personal projects |
| **Enterprise** | All 9 modules | Teams, compliance |
| **Custom** | Pick & choose | Tailored deployments |

```bash
lg mode enterprise && lg restart
```

Modules: `usage` · `budget` · `multikey` · `users` · `audit` · `metrics` · `backup` · `smart` · `chat`

## Self-Healing

| Layer | Recovery Time |
|-------|---------------|
| Docker healthcheck | ≤10s detection |
| Container restart policy | Automatic |
| macOS LaunchDaemon watchdog | Survives Docker daemon crash |
| Data persistence | RPO ≤ 1 second (coalesced writes + emergency flush) |
| Network resilience | QUIC tunnel, Nginx auto-retry, keepalive pooling |

## Performance

| Scenario | QPS | Errors |
|----------|-----|--------|
| Health (extreme, 250 concurrent) | 12,788 | 0 |
| Dashboard (200 concurrent) | 2,087 | 0 |
| External via Cloudflare QUIC (500 concurrent) | 476 | 0.06% |

Memory: ~37 MiB (enterprise app + nginx). Security features: zero performance impact.

## CLI

```bash
sudo ln -sf "$(pwd)/cli.sh" /usr/local/bin/lg
```

```
lg status          Health & providers
lg mode enterprise Switch mode
lg projects        Manage projects
lg usage           Cost summary
lg backup create   Create backup
lg logs            Tail logs
lg restart         Rebuild & restart
```

## API Reference

### Clean Chat Proxy（推荐）

所有 App 统一用这个端点。前端只处理 3 种 SSE 事件，不需要知道工具/搜索的存在。

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
data: {"text":"正在生成 Excel...","icon":"spreadsheet"}  # 状态提示（灰色小字）
event: file_download
data: {"filename":"报告.xlsx","size":8019,...}            # 文件下载卡
data: [DONE]
```

**认证方式：** Project Key / HMAC / Ephemeral Token / LumiChat Cookie，全部支持。

### Raw Proxy（直通代理）
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

## Project Structure

```
├── server.js               # Express server — proxy, auth, tools, 5800+ lines
├── security/               # PII detection, secret masking, command guard, SSRF validator
├── tools/                  # Unified registry, MCP client, 224 template catalog
├── routes/                 # Agent API (parse, audio, vision, code)
├── middleware/             # Security + audit middleware
├── collector/              # Web collection via Chrome CDP (kimi/doubao/qwen)
├── public/
│   ├── lumichat.html       # LumiChat — full chat UI (4000+ lines)
│   └── index.html          # Dashboard SPA
├── templates/              # 224 financial/business templates
├── whisper-server/         # Local Whisper STT (Python, faster-whisper)
├── doc-gen/                # Document generation microservice
├── docker-compose.yml      # Production: nginx + app + searxng + doc-gen + gotenberg
├── deploy/                 # NAS/Mac split deployment + migrate.sh
└── tests/                  # Playwright E2E tests (file upload, providers, media)
```

## Deployment Options

| Target | Setup |
|--------|-------|
| **Single machine** | `docker compose up -d --build` |
| **NAS + Mac Mini** | `deploy/nas/` + `deploy/mac/` split configs |
| **Migration** | `deploy/migrate.sh` — copies data, PB, tunnels |

## Test Results

| Suite | Result |
|-------|--------|
| `/v1/chat` 多 provider (DeepSeek, OpenAI, Gemini) | 3/3 PASS |
| `/v1/chat` 搜索自动检测 (中文+英文) | PASS |
| `/v1/chat` 文件生成 (Excel, Word) | PASS |
| `/v1/chat` 工具标记剥离（无泄露） | PASS |
| 安全：认证绕过 (无key/假key/HMAC/expired token) | 4/4 PASS |
| 安全：注入 (路径遍历/shell/XSS/SSRF) | PASS |
| 安全：model 白名单 + budget cap | PASS |
| 安全：工具标记注入防护 | PASS |
| 安全：速率限制 | PASS |
| 公网 (lumigate.autorums.com) 端到端 | PASS |

## Contributing

Issues, pull requests, and feature suggestions are welcome.
Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a PR.
