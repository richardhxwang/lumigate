# LumiGate

**Self-hosted AI Agent Platform — 8 providers, clean chat proxy, tool execution, file generation, 224 templates, enterprise security, one command to deploy.**

LumiGate evolved from an API gateway into a full Agent Platform. The unified `POST /v1/chat` endpoint proxies 8 AI providers, automatically searches the web, generates files, and executes tools — all server-side. Clients only receive clean text + file download events, with zero tool logic on the frontend. Ships with LumiChat — a production chat UI with SSE streaming, PocketBase auth, and multimodal input.

Runs on a NAS, mini PC, or any machine with Docker. ~37 MiB total memory.

## Quick Start

```bash
git clone https://github.com/richardhxwang/lumigate.git
cd lumigate
cp .env.example .env   # Add your API keys
docker compose up -d --build
# Open http://localhost:9471
```

## What's New in v4.1 (Clean Chat Proxy)

| Feature | Description |
|---------|-------------|
| **Clean Chat Proxy** | `POST /v1/chat` — single endpoint, clients only receive clean text + `event: file_download` + `event: tool_status`. All tools handled server-side |
| **Tool Execution** | AI outputs `[TOOL:name]{params}[/TOOL]` → server intercepts & executes → tags never reach frontend. Works with ANY model, no function calling needed |
| **File Generation** | Real Excel (.xlsx with formulas), Word (.docx), PowerPoint (.pptx). Download directly from chat |
| **224 Templates** | Professional finance templates (DCF, LBO, WACC, Black-Scholes, Goldman) + business docs + presentations, 12 categories |
| **Security Pipeline** | PII detection (20+ regex + Ollama semantic), secret masking `[SEC_xxx]`, command guard (17 rules), SSRF protection, tool injection prevention |
| **LumiChat** | Production chat UI: SSE streaming + markdown, file upload, voice input, model switching, PocketBase auth, mobile responsive |
| **MCP Gateway** | MCPJungle + Playwright browser automation and external tool servers |
| **Multi-Deploy** | Split Docker Compose for NAS (x86) + Mac Mini (ARM), migration script included |
| **Whisper STT** | Local speech-to-text (faster-whisper), Mac Metal acceleration |

## Architecture

```
                         ┌───────────────────────────────────────────────┐
                         │              LumiGate Server                  │
┌──────────┐            ├───────────────────────────────────────────────┤
│ LumiChat │──cookie──▶ │                                               │
│  (Web)   │            │  POST /v1/chat                                │
├──────────┤            │    ↓ Auth → Pre-search → AI Proxy             │
│ iOS App  │──HMAC────▶ │    ↓ Clean SSE Pipe (strip tool tags)         │
├──────────┤            │    ↓ Tool Execute → file_download events       │
│ Any App  │──Token───▶ │    ↓ Resume AI → clean text only              │
└──────────┘            │                                               │
                         │  Clients receive: text + tool_status + file_download │
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
| OpenAI | API Key | GPT-4.1, GPT-5, o3, o4-mini |
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

Server: detects tag → executes tool → generates .xlsx → sends download event
Client: only sees tool_status + file_download + AI summary text
```

### Available Tools

| Tool | Description |
|------|-------------|
| `generate_spreadsheet` | Excel with formulas (VLOOKUP, NPV, IRR, cross-sheet refs) |
| `generate_document` | Word docs with sections, tables, TOC, headers/footers |
| `generate_presentation` | PowerPoint with charts, tables, layouts, speaker notes |
| `use_template` | Pick from 224 professional templates, fill with data |
| `web_search` | SearXNG web search (auto-detected by `/v1/chat`, or explicit `web_search: true`) |
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

Built-in production chat UI. Communicates via `POST /v1/chat`. Zero tool logic on frontend — only handles clean text, status hints, and file downloads.

- **Clean Proxy architecture** — ~60 line SSE reader replaced 250+ line agentic loop
- **SSE streaming** — Text node rendering during stream, markdown on completion
- **8 providers** — model search, tier control, BYOK
- **File attachments** — images, PDFs, documents (auto-parsed)
- **Voice input** — microphone recording + Whisper transcription
- **Tool downloads** — Excel/Word/PPT generated server-side, download cards in chat
- **PocketBase auth** — email/password + Google OAuth, user tiers
- **Mobile responsive** — bottom-sheet model picker, safe area, touch gestures
- **Dark/Light mode** — macOS 26 / Apple HIG design
- **Presets** — 10 built-in system prompt templates, custom presets
- **Sessions** — conversation history, search, auto-title

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
| **Tool Injection Prevention** | `[TOOL:]` markers in user messages stripped before AI call |
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
| /health (500 concurrent, public internet) | 658 | 0 |
| /v1/chat streaming (200 concurrent) | 14.7 | 0 |
| /v1/chat non-streaming (200 concurrent) | 18.9 | 0 |
| Multi-provider mixed (150 concurrent, 3 providers) | 143 combined | 0 |

Bottleneck is upstream AI API latency (~2-8s per request), not LumiGate. Memory: ~37 MiB (enterprise app + nginx). Security features: zero performance impact.

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

### Clean Chat Proxy (recommended for all apps)

```bash
curl -N -X POST http://localhost:9471/v1/chat \
  -H "Content-Type: application/json" \
  -H "X-Project-Key: $KEY" \
  -d '{
    "provider": "deepseek",
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Generate Excel: quarterly sales"}],
    "stream": true
  }'
```

**Request fields:**

| Field | Type | Description |
|-------|------|-------------|
| `provider` | string | Required. openai / anthropic / gemini / deepseek / minimax / qwen / kimi / doubao |
| `model` | string | Required. Model ID |
| `messages` | array | Required. OpenAI format |
| `stream` | bool | Recommended true |
| `web_search` | bool | Optional. true = force search, false = disable, omit = auto-detect |
| `tools` | bool | Optional. Default true, false = no tool prompt injection |

**SSE response (3 event types):**

```
data: {"choices":[{"delta":{"content":"text"}}]}         # Clean text, render directly
event: tool_status
data: {"text":"Generating Excel...","icon":"spreadsheet"} # Status hint (grey text)
event: file_download
data: {"filename":"report.xlsx","size":8019,...}           # File download card
data: [DONE]
```

**Auth:** Project Key / HMAC / Ephemeral Token / LumiChat Cookie — all supported.

### Raw Proxy

```bash
# Direct upstream API pass-through, no tool processing
curl -X POST http://localhost:9471/v1/{provider}/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"gpt-4.1-nano","messages":[{"role":"user","content":"Hello"}]}'
```

### Agent Platform

```bash
# Execute tool directly
curl -X POST http://localhost:9471/v1/tools/execute \
  -H "X-Project-Key: $KEY" \
  -d '{"tool_name":"generate_spreadsheet","tool_input":{"title":"Model","sheets":[...]}}'

# Parse file
curl -X POST http://localhost:9471/v1/parse -F file=@document.pdf

# Transcribe audio
curl -X POST http://localhost:9471/v1/audio/transcribe -F file=@recording.wav
```

## Project Structure

```
├── server.js               # Express server — proxy, auth, tools, 6000+ lines
├── security/               # PII detection, secret masking, command guard, SSRF validator
├── tools/                  # Unified registry, MCP client, 224 template catalog
├── routes/                 # Agent API (parse, audio, vision, code)
├── middleware/             # Security + audit middleware
├── collector/              # Chrome CDP web collection (kimi/doubao/qwen)
├── public/
│   ├── lumichat.html       # LumiChat — chat UI (4000+ lines)
│   └── index.html          # Dashboard SPA
├── templates/              # 224 financial/business templates
├── whisper-server/         # Local Whisper STT (Python, faster-whisper)
├── doc-gen/                # Document generation microservice
├── docker-compose.yml      # Production: nginx + app + searxng + doc-gen + gotenberg
├── deploy/                 # NAS/Mac split deployment + migrate.sh
└── tests/                  # Playwright E2E tests
```

## Deployment

| Target | Setup |
|--------|-------|
| **Single machine** | `docker compose up -d --build` |
| **NAS + Mac Mini** | `deploy/nas/` + `deploy/mac/` split configs |
| **Migration** | `deploy/migrate.sh` — copies data, PB, tunnels |

## Test Results

| Suite | Result |
|-------|--------|
| /v1/chat multi-provider (DeepSeek, OpenAI, Gemini) | 3/3 PASS |
| /v1/chat auto search detection (CN + EN) | PASS |
| /v1/chat file generation (Excel, Word) | PASS |
| /v1/chat tool tag stripping (no leaks) | PASS |
| Security: auth bypass (no key / fake / HMAC / expired) | 4/4 PASS |
| Security: injection (path traversal / shell / XSS / SSRF) | PASS |
| Security: model allowlist + budget cap | PASS |
| Security: tool marker injection prevention | PASS |
| Security: rate limiting | PASS |
| Public internet E2E (lumigate.autorums.com) | PASS |
| Stress: 200 concurrent /v1/chat, zero errors | PASS |
