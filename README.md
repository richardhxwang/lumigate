# LumiGate

**自托管 AI Agent 平台** — 8 个 AI 提供商、26 个工具、深度搜索、长期记忆、工作流引擎、企业级安全。

[![Self-Hosted](https://img.shields.io/badge/self--hosted-yes-brightgreen)](#)
[![Docker](https://img.shields.io/badge/docker-compose-blue)](#)
[![Providers](https://img.shields.io/badge/providers-8-orange)](#providers)
[![Tools](https://img.shields.io/badge/tools-26-purple)](#tools)
[![Port](https://img.shields.io/badge/port-9471-lightgrey)](#)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Client Layer                                │
│                                                                      │
│   LumiChat    FurNote    Whenever    REST / SDK    MCP Clients      │
│  (built-in)  (iOS pet)  (iOS rem.)  (server-side)  (external)      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTPS / SSE
┌──────────────────────────────▼──────────────────────────────────────┐
│                          Gateway Layer                               │
│                                                                      │
│   Auth (HMAC / Token / Key)   RPM Limit   Budget Cap   IP ACL      │
│   PII Detection   Secret Masking   Command Guard   SSRF Block       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                       Intelligence Layer                             │
│                                                                      │
│   Agent Runtime  (Plan → Execute → Observe → Reflect, 12 rounds)   │
│   Native Function Calling  +  Prompt Fallback  (any model)         │
│   Deep Search   GPT-style Memory   RAG / Knowledge Base            │
│   Financial Analysis (Casting)   Audit Analytics   Workflow DAG    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                         Provider Layer                               │
│                                                                      │
│   OpenAI   Anthropic   Gemini   DeepSeek   MiniMax                 │
│   Kimi (Collector)   Doubao (Collector)   Qwen (Collector)         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                           Tool Layer                                 │
│                                                                      │
│   SearXNG (web search)   Whisper (STT)   Edge TTS   Docling        │
│   Docker Sandbox (code)   Doc-Gen (Excel/Word/PPT)   224 Templates │
│   HKEX CDP Scraper   MCP Gateway (Playwright)   Audit Engine       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                           Data Layer                                 │
│                                                                      │
│   PocketBase (users, sessions, files, audit, security events)      │
│   Qdrant (vector memory + RAG)   Loki / Promtail / Alertmanager    │
│   JSON file store (projects, usage, keys) — atomic writes          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Request Flow

Single endpoint `POST /v1/chat` handles every conversation turn:

```
User Message
     │
     ├─ 1. Auth ──────────── 6 paths: internal key → admin cookie → lc_token
     │                                → ephemeral token → HMAC → project key
     │
     ├─ 2. Memory Recall ─── Qdrant vector search → inject user profile + facts
     │
     ├─ 3. Pre-Search ─────── auto-detect if web needed → SearXNG (15-30 results)
     │
     ├─ 4. Specialist Mode ── financial pre-computation (if enabled)
     │
     ├─ 5. Prompt Assembly ── memory + RAG + search results + attachments + tools
     │
     ├─ 6. Provider Call ──── SSE streaming → client
     │
     ├─ 7. Tool Detection ─── DSML / XML / native tool_use  (any model works)
     │        │
     │        └─ Execute → file_download card / search / code / audit / ...
     │
     ├─ 8. Auto-continue ──── up to 12 rounds if response truncated
     │
     └─ 9. Memory Ingest ──── extract facts → Qdrant + PocketBase (background)
```

SSE events sent to client:

| Event | Content |
|-------|---------|
| `data` (default) | Clean text chunk — render directly |
| `event: tool_status` | Progress hint, e.g. "Generating Excel..." |
| `event: file_download` | File metadata — render as download card |

---

## Features

### Intelligence

- **Deep Search** — `/deep-search` slash command; decomposes query into sub-queries, multi-round research across SearXNG, synthesizes a cited Markdown report (GPT Deep Research style)
- **GPT-style Memory** — `memory_save` / `memory_search` tools; background auto-extraction after each turn; relevant memories injected in < 100 ms via Qdrant
- **RAG / Knowledge Base** — create KBs, upload docs, vector search; RAGFlow integration (optional `--profile rag`) with self-built BM25 + reranker + HyDE fallback
- **Financial Analysis (Casting)** — 15 programmatic cross-checks (balance sheet, PPE rollforward, AR aging, depreciation reasonableness, etc.); upload statements, get pre-analysis injected into prompt
- **Workflow Engine** — visual DAG editor (`/workflow-editor.html`); 7 node types including `human_approval`; async task queue; `{{variable}}` template interpolation

### LumiChat UI  (`/lumichat.html`)

- SSE streaming — rAF text-node approach, smooth at any response length
- Collapsible thinking blocks for chain-of-thought models
- Canvas / Artifacts side panel for code and document previews
- Background task cards — frosted-glass progress UI for Deep Search, Financial Analysis, HKEX Download, Agent Loop
- Text selection menu: Ask / Explain / Translate
- Source chips linking to search results
- Drag-and-drop file upload with inline chips; encrypted upload
- Voice input (Whisper STT) + TTS playback (Edge TTS, language-aware)
- **26 slash commands** including `/deep-search`, `/hkex`, `/cast`, and more
- **HKEX Filing Search** — `/hkex` opens autocomplete modal (stock code / EN / 繁中); filter by date + category; download as ZIP
- 10 built-in system presets + up to 8 custom presets
- Mid-stream queuing: new messages queue without aborting the current stream
- PocketBase auth with JWT keepalive; persistent sessions and history
- Dark / light theme; mobile-responsive layout

### Tools (26 registered)

| Category | Tools |
|----------|-------|
| File Gen | `generate_spreadsheet`, `generate_document`, `generate_presentation`, `use_template` (224 templates), `fill_template` |
| Search | `web_search` (SearXNG, adaptive 15-30 results), `hkex_download` (Chrome CDP) |
| Memory | `memory_save`, `memory_search` |
| Parse | `parse_file` (PDF/Excel/Word/PPT), `transcribe_audio` (Whisper), `vision_analyze` (Ollama) |
| Code | `code_run` (Docker sandbox — Python/JS), `sandbox_exec` (shell) |
| Audit | `audit_sampling`, `benford_analysis`, `journal_entry_testing`, `variance_analysis`, `materiality_calculator`, `reconciliation`, `going_concern_check`, `gl_extract`, `data_cleaning`, `audit_workpaper_fill` |
| Finance | `financial_statement_analyze` (15 cross-checks) |
| Automation | `browser_action` (Playwright via MCP) |

### Security

- **4 auth modes**: Direct Key, HMAC Signature (key never transmitted), Ephemeral Token, HMAC + Token combo
- **PII detection**: 20+ regex patterns + optional Ollama semantic analysis
- **Secret masking**: `[SEC_xxx]` placeholders in LLM context; originals restored only for server-side execution
- **Command guard**: 17 rules block dangerous shell commands before execution
- **SSRF protection**: private IP ranges and internal hostnames blocked at DNS layer
- **Per-project limits**: RPM, daily/monthly budget caps, IP allowlist (50 CIDRs), model allowlist, anomaly auto-suspend (5x spike)
- **MFA**: TOTP for admin dashboard (Google Authenticator / Authy)
- **Audit trail**: all events → PocketBase `security_events` + `audit_log`

### Observability

- Full-chain tracing + visualization (`/traces.html`)
- Optional Loki + Promtail + Alertmanager stack (`--profile observability`)
- 20 preloaded alert rules with Chinese diagnostic messages and fix suggestions
- Telegram multi-channel alerts (critical: immediate, warning: batched)
- `npm run logs:errors` — error aggregation report

---

## Quick Start

```bash
git clone https://github.com/richardhxwang/lumigate.git && cd lumigate
cp .env.example .env          # add your API keys
docker compose up -d --build
```

- Dashboard: `http://localhost:9471`
- Chat UI: `http://localhost:9471/lumichat.html`
- PocketBase admin: `http://localhost:8090/_/`

**First-time PocketBase setup:** create the first superuser at `http://localhost:8090/_/`, then put the same credentials into `.env` as `PB_ADMIN_EMAIL` and `PB_ADMIN_PASSWORD`.

### Optional profiles

```bash
docker compose --profile rag up -d --build            # RAGFlow (primary RAG engine)
docker compose --profile enhanced up -d --build       # Docling (enhanced PDF parsing)
docker compose --profile observability up -d --build  # Loki + Promtail + Alertmanager
```

---

## Configuration

### Key environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEPLOY_MODE` | `lite` | `lite` / `enterprise` / `custom` |
| `MODULES` | — | Module list when `DEPLOY_MODE=custom` |
| `ADMIN_SECRET` | — | Dashboard admin password |
| `PB_URL` | `http://pocketbase:8090` | PocketBase URL |
| `PB_ADMIN_EMAIL` | — | PocketBase superuser email |
| `PB_ADMIN_PASSWORD` | — | PocketBase superuser password |
| `QDRANT_URL` | `http://lumigate-qdrant:6333` | Vector DB URL |
| `RAGFLOW_API_KEY` | — | RAGFlow API key (if `--profile rag`) |
| `CF_TUNNEL_TOKEN_LUMIGATE` | — | Cloudflare tunnel token (optional) |

### Deploy modes

| Mode | Modules | Use Case |
|------|---------|----------|
| `lite` | usage, chat, backup | Personal use |
| `enterprise` | All 9 modules | Teams, compliance |
| `custom` | Pick via `MODULES` env var | Tailored setups |

### Docker services

| Service | Port | Purpose |
|---------|------|---------|
| lumigate | 9471 | Main gateway + Collector Chrome |
| nginx | 9471 (exposed) | Reverse proxy + health fallback |
| pocketbase | 8090 | Database (users, sessions, files, audit) |
| file-parser | 3100 | File parsing (PDF/XLSX/DOCX/PPTX) |
| doc-gen | 3101 | Document generation (Excel/Word/PPT) |
| searxng | 8080 | Web search engine |
| whisper | 17863 | Speech-to-text |
| qdrant | 6333 | Vector search (memory + RAG) |
| gotenberg | 3000 | Office-to-PDF conversion |
| cloudflare | — | Tunnel to public domain |

---

## Providers

| Provider | Auth Method | Example Models |
|----------|-------------|----------------|
| OpenAI | API Key | GPT-5, o3, o4-mini |
| Anthropic | API Key | Claude Opus 4.6, Sonnet 4.6 |
| Gemini | API Key | Gemini 3.1 Pro/Flash, 2.5 Flash |
| DeepSeek | API Key | DeepSeek-Chat V3.2, Reasoner |
| MiniMax | API Key | MiniMax-M2.5, M2 |
| Kimi | Collector (CDP) | Kimi K2.5, K2 |
| Doubao | Collector (CDP) | Doubao Seed 2.0 Pro/Lite |
| Qwen | Collector (CDP) | Qwen 3.5 Plus, Qwen 3 Max |

**Collector providers** (Kimi, Doubao, Qwen) use headless Chrome via CDP. Admin logs in once through VNC; Chrome maintains the session across container restarts.

---

## API Guide

See **[docs/API_GUIDE.md](docs/API_GUIDE.md)** for full endpoint documentation, request/response schemas, auth mode details, and SSE event format.

---

## License

MIT
