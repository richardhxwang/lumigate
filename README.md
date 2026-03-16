# LumiGate

**Self-hosted AI Agent Platform — 8 providers, tool execution, file generation, 224 templates, enterprise security, one command to deploy.**

LumiGate started as an AI API gateway and evolved into a full **Agent Platform**. It proxies 8 AI providers through a single endpoint, executes tools server-side (Excel/Word/PPT generation, web search, file parsing, vision, code sandbox), manages 224 professional financial templates, and ships with LumiChat — a production chat UI with SSE streaming, PocketBase auth, and multimodal input.

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
| **Tool Execution** | AI models output `[TOOL:name]{params}[/TOOL]` tags, server executes tools automatically. Works with ANY model — no native function calling required |
| **File Generation** | Generate real Excel (.xlsx with formulas), Word (.docx), PowerPoint (.pptx) files. Download directly from chat |
| **224 Templates** | Professional finance templates (DCF, LBO, WACC, Black-Scholes, Goldman models) + business documents + presentations across 12 categories |
| **Security Pipeline** | PII detection (20+ patterns + Ollama semantic), secret masking `[SEC_xxx]`, command guard (17 rules), SSRF protection |
| **LumiChat** | Full chat UI: SSE streaming with live markdown, file upload, voice input, model switching, PocketBase auth, mobile responsive |
| **MCP Gateway** | MCPJungle integration for Playwright browser automation and external tool servers |
| **Multi-Deploy** | Split Docker Compose for NAS (x86) + Mac Mini (ARM), migration script included |
| **Whisper STT** | Local speech-to-text server (faster-whisper), runs on Mac with Metal acceleration |

## Architecture

```
                         ┌──────────────────────────────────────────────┐
                         │              LumiGate Server                 │
┌──────────┐            ├──────────────────────────────────────────────┤
│ LumiChat │──cookie──▶ │                                              │
│  (Web)   │            │  Request ─▶ [Auth] ─▶ [PII Detect] ─▶       │
├──────────┤            │           ─▶ [Rate Limit] ─▶ [AI Proxy]      │
│ iOS App  │──HMAC────▶ │           ─▶ [Tool Execute] ─▶ Response      │
├──────────┤            │                                              │
│ Any App  │──Token───▶ │  Tools: Excel/Word/PPT │ Search │ Parse     │
└──────────┘            │         Vision │ Code Sandbox │ MCP          │
                         └───────┬──────────┬──────────┬───────────────┘
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
| `web_search` | SearXNG web search |
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

Full-featured chat UI built into LumiGate:

- **SSE streaming** with live markdown rendering and blinking cursor
- **8-provider model switching** with search and tier-based access
- **File attachments** — images, PDFs, documents (auto-parsed)
- **Voice input** — microphone recording with Whisper transcription
- **Tool downloads** — Excel/Word/PPT generated server-side, download cards in chat
- **PocketBase auth** — email/password + Google OAuth, user tiers, admin approval
- **Mobile responsive** — bottom-sheet model picker, safe area support, touch gestures
- **Dark/Light mode** — macOS 26 / Apple HIG design language
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

### Proxy
```bash
# All providers via single endpoint pattern
curl -X POST http://localhost:9471/v1/{provider}/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"gpt-4.1-nano","messages":[{"role":"user","content":"Hello"}]}'
```

### Agent Platform
```bash
# Execute any tool
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
| Provider connectivity (5 API providers) | 5/5 PASS |
| File generation (XLSX, DOCX, PPTX, search, template) | 6/6 PASS |
| Security (auth, SSRF, injection, shell) | 10/10 PASS |
| Image upload + vision | PASS |
| Voice input UI | PASS |
| Playwright E2E (all providers) | 5/5 PASS |

## Contributing

Issues, pull requests, and feature suggestions are welcome.
Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a PR.
