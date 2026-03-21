# LumiGate

Self-hosted AI Agent Platform. 8 providers, 26 tools, Deep Search, long-term memory, workflow engine, enterprise security.

## Quick Start

```bash
git clone https://github.com/richardhxwang/lumigate.git && cd lumigate
cp .env.example .env   # add your API keys
docker compose up -d --build
```

Dashboard at `http://localhost:9471`. Chat UI at `http://localhost:9471/lumichat.html`.

Integrated local services started by default:
- PocketBase: `http://localhost:8090`
- Whisper STT: `http://localhost:17863`
- Qdrant Vector DB: `http://localhost:6333`
- SearXNG Web Search: `http://localhost:18780`

First-time PocketBase bootstrap:
1. Open `http://localhost:8090/_/`.
2. Create the first superuser.
3. Put the same credentials into `.env` as `PB_ADMIN_EMAIL` and `PB_ADMIN_PASSWORD` (required for admin-tier and subscription actions in LumiGate).

## Architecture Overview

### Request Flow: POST /v1/chat

```
User sends message
  |
  +-- 1. Auth (6 paths: internal key -> admin cookie -> lc_token -> ephemeral -> HMAC -> project key)
  |
  +-- 2. Memory Recall -> Qdrant vector search -> inject user profile + relevant memories
  |
  +-- 3. Pre-search -> auto-detect if web search needed -> SearXNG (up to 30 results)
  |
  +-- 4. Specialist Mode -> financial analysis pre-computation (if selected)
  |
  +-- 5. System Prompt Assembly (memory + RAG + search + attachments + tools + principles)
  |
  +-- 6. AI Provider Call -> SSE streaming to client
  |
  +-- 7. Tool Detection + Execution -> 24 registered tools
  |
  +-- 8. Tool Results -> file persistence + second AI call for synthesis
  |
  +-- 9. Auto-continue (up to 12 rounds if response truncated)
  |
  +-- 10. Memory Ingest -> extract facts -> store in Qdrant + PocketBase
```

SSE response delivers three event types:

| Event | Purpose |
|-------|---------|
| `data` (default) | Clean text chunks -- render directly |
| `event: tool_status` | Progress hints (e.g. "Generating Excel...") |
| `event: file_download` | File metadata -- render as download card |

Three tool tag formats are supported: DSML (`[TOOL:...]...[/TOOL]`), XML (`<tool name="...">...</tool>`), and Anthropic native `tool_use` blocks. The server normalizes all formats before execution, so any model can use tools regardless of its native calling convention.

### Registered Tools

| Tool | Category | Description |
|------|----------|-------------|
| generate_spreadsheet | File Gen | Excel with formulas via ExcelJS |
| generate_document | File Gen | Word documents |
| generate_presentation | File Gen | PowerPoint slides |
| use_template | File Gen | 224 professional templates across business, finance, HR, and project management |
| fill_template | File Gen | Word/Excel template auto-fill from uploaded data |
| web_search | Search | SearXNG, adaptive 15-30 results with time-aware multi-keyword queries |
| memory_save | Memory | AI proactively saves user facts and preferences |
| memory_search | Memory | AI queries past conversations for context |
| hkex_download | Search | Download HKEX announcements via Chrome CDP |
| parse_file | Parse | PDF/Excel/Word/PPT extraction |
| transcribe_audio | Audio | Whisper speech-to-text |
| vision_analyze | Vision | Image description via Ollama |
| code_run | Code | Python/JS in Docker sandbox |
| sandbox_exec | Code | Shell command execution in sandbox |
| audit_sampling | Audit | MUS/random/stratified (AICPA factor table + 4 resampling modes) |
| benford_analysis | Audit | First-digit / first-two-digit fraud detection + chi-square |
| journal_entry_testing | Audit | 15 standard JET tests with risk scoring |
| variance_analysis | Audit | Period-over-period, budget vs actual, trend, ratio analysis |
| materiality_calculator | Audit | ISA 320 / PCAOB materiality computation |
| reconciliation | Audit | Auto-reconcile two datasets (exact, fuzzy, one-to-many) |
| going_concern_check | Audit | ISA 570 going concern indicators |
| gl_extract | Audit | GL sub-ledger extraction by account code |
| data_cleaning | Audit | 7 cleaning operations for financial data |
| audit_workpaper_fill | Audit | Auto-fill working papers from source documents |
| financial_statement_analyze | Finance | 15 cross-checks + PPE rollforward + depreciation rate reasonableness |
| browser_action | Automation | Playwright browser control via MCP |

### File Structure

```
server.js              (3,643 lines) -- Init + middleware + route mounting
routes/
  chat.js              (1,615) -- POST /v1/chat core flow
  admin.js             (1,931) -- Admin API (projects, keys, users, collector)
  lumichat.js          (5,655) -- LumiChat endpoints (auth, sessions, files, tiers)
  proxy.js             (458)   -- Generic /v1/:provider proxy passthrough
  knowledge.js         (237)   -- Knowledge Base CRUD + RAG search
  workflow.js          (305)   -- DAG workflow execution + task queue
  observability.js     (216)   -- Trace listing + evaluation + stats
  hkex.js              (158)   -- HKEX announcement download
  template-filler.js   (187)   -- Word/Excel template filling
  parse.js             (294)   -- File parsing (PDF/XLSX/DOCX/PPTX)
  audio.js             (186)   -- Audio transcription
  vision.js            (127)   -- Image analysis
  code.js              (135)   -- Code execution
  sandbox.js           (218)   -- CLI sandbox execution
  plugins.js           (127)   -- Plugin management
  rbac.js              (154)   -- Role-based access control
  versions.js          (97)    -- API versioning
services/
  knowledge/           -- RAG pipeline (BM25, reranker, HyDE, orchestrator, RAGFlow adapter)
  memory/              -- Per-user vector memory (Qdrant + PB) + fact extraction
  workflow/            -- DAG engine + async task queue + workflow store
  observability/       -- Trace collector + evaluator
  financial-analysis/  -- Python analyzers (15 cross-checks)
  financial-engine/    -- Financial computation engine
  pb-schema.js         -- Auto-provision 13 PB collections
  pb-store.js          -- Generic PB CRUD helper
  plugins/             -- Plugin system
  rbac/                -- Role-based access control
  versioning/          -- API version management
tools/
  unified-registry.js  -- Single tool registry (built-in + schema + MCP)
  builtin-handlers.js  -- Doc-gen/search/parse execution
  audit-tools.js       -- 10 audit analytics tools
  hkex-downloader.js   -- HKEX Chrome CDP scraper
  template-filler.js   -- Template auto-fill
  financial-analysis.js -- Python bridge for financial analysis
  mcp-client.js        -- MCP tool server client
  schemas/             -- JSON schema definitions for tools
lumigent/
  runtime.js           -- Parser + dispatcher + agent loop
  trace-store.js       -- In-memory traces + PB callback
  bridges/             -- Tool service connections (internal HTTP, MCP, tool service)
public/
  lumichat.html        (6,325) -- Chat UI
  index.html           -- Dashboard
  traces.html          -- Trace visualization
  workflow-editor.html -- React Flow DAG editor
security/
  index.js             -- PII detection, secret masking, command guard
docker/
  monitoring/          -- Loki, Promtail, Alertmanager configs + 20 alert rules
```

## Features

### Clean Chat Proxy

Single `POST /v1/chat` endpoint for all providers and all apps (LumiChat, FurNote, etc.). Tool tags are intercepted and executed server-side -- clients never see them. Works with any model, no native function calling required. Clients only need a standard EventSource with three event types.

### LumiChat

Built-in chat UI at `/lumichat.html`. Full feature list:

- SSE streaming with real-time markdown rendering, syntax highlighting, and KaTeX math support
- Collapsible thinking blocks for chain-of-thought models
- Canvas/Artifacts side panel for code and document previews
- Text selection menu (Ask / Explain / Translate)
- Source chips linking to search results
- Drag-and-drop file upload with inline chips
- Voice input via Whisper transcription and TTS playback (language-aware, clean newline handling)
- Adaptive web search (auto-detect + manual toggle)
- 10 built-in system presets (Coder, Professional, Translator, etc.) with custom preset support (up to 8)
- Slash commands: `/deep-search` (multi-round research), `/hkex` (filing search modal), and more
- Background task cards: frosted-glass progress UI for long-running tasks (Deep Search, Financial Analysis, HKEX Download, Agent Loop) with real-time steps, progress bar, and collapsible detail
- Mid-stream messaging (new messages queue without aborting the current stream)
- Persistent session management with conversation history
- PocketBase-backed auth with JWT token refresh
- Mobile-responsive layout with dark/light theme
- Rotating tips bar on the welcome screen

### RAG and Memory

- **RAGFlow integration** (primary, via `--profile rag`) with self-built fallback pipeline (BM25, vector reranker, HyDE query transform)
- **GPT-style long-term memory**: two AI-driven tools -- `memory_save` (AI proactively saves user facts, preferences, and context) and `memory_search` (AI queries past conversations for relevant information). Background auto-extraction after each conversation + periodic profile summarization. All memories stored in Qdrant with per-user isolation
- **Automatic recall**: relevant memories injected before each chat turn (< 100ms vector search), giving the AI persistent context across sessions
- **FurNote pet profile API**: sync pet health data as persistent user memory
- **Knowledge Base management**: create KBs, upload documents, search across multiple KBs via `/v1/knowledge` endpoints

### Workflow Engine

- Visual drag-and-drop DAG editor (`/workflow-editor.html`) built with React Flow
- 7 node types: `llm`, `tool`, `condition`, `parallel`, `code`, `human_approval`, `template`
- Async task queue with configurable concurrency and priority
- Template interpolation (`{{variable}}`) across all node inputs
- Human-in-the-loop: pause workflow at approval nodes, resume via API
- Workflow store with persistence and purge scheduling

### Audit Tools

10 professional audit analytics tools:

- **Sampling**: MUS with AICPA factor table + 4 resampling modes, random, stratified
- **Benford's Law**: first-digit and first-two-digit distribution with chi-square test
- **Journal Entry Testing**: 15 standard JET tests with risk scoring
- **Variance Analysis**: period-over-period, budget vs actual, trend, ratio
- **Materiality**: ISA 320 / PCAOB materiality computation
- **Reconciliation**: auto-reconcile two datasets (exact, fuzzy, one-to-many matching)
- **Going Concern**: ISA 570 indicators check
- **GL Extraction**: sub-ledger extraction by account code
- **Data Cleaning**: 7 cleaning operations for financial data
- **Working Paper Auto-Fill**: populate audit templates from source documents

### Financial Analysis

- 15 programmatic cross-checks (balance sheet equation, inventory, loans, AR aging, PPE rollforward, etc.)
- Depreciation rate reasonableness by asset category
- Specialist mode in chat: upload financial statements, get automated pre-analysis injected into the AI prompt
- Python-based analysis engine with JSON bridge
- PDF table extraction: pdftotext-layout primary + optional Docling enhanced parser

### Smart Web Search

Contextual web search integrated into the chat pipeline:

- Auto-detects whether search is needed before sending to AI provider
- Configurable keyword model (default: MiniMax for cost efficiency) generates time-aware multi-keyword queries
- Self-hosted SearXNG with adaptive result count (15-30)
- Default one-month time range with all-time fallback
- Deduplication and freshness-prioritized context injection
- **Search synthesis**: explicit synthesis instructions ensure the AI produces coherent, cited answers instead of raw link dumps

### Deep Search

Multi-round iterative research triggered by the `/deep-search` slash command (GPT Deep Research style):

- Decomposes complex questions into sub-queries, researches each independently across multiple rounds
- Uses cost-efficient models (DeepSeek / GPT-4.1-mini) for research rounds, then a high-capability model for final synthesis
- Produces structured Markdown reports with inline citations and source links
- Progress shown in a real-time background task card with per-step status updates

### HKEX Filing Search

`/hkex` slash command opens a search modal for Hong Kong Exchange announcements:

- Autocomplete by stock code, English name, or Chinese name (Traditional Chinese)
- Filter by date range and announcement category
- Downloads selected announcements as a ZIP file
- Powered by the official HKEX API with Chrome CDP for file retrieval

### Security

- **Auth**: 4 modes -- Direct Key, HMAC Signature, Ephemeral Token, HMAC + Token combo (key never transmitted)
- **PII detection**: 20+ regex patterns covering emails, phone numbers, SSNs, credit cards. Optional Ollama-based semantic analysis
- **Secret masking**: `[SEC_xxx]` placeholders in LLM context, originals restored only for server-side tool execution
- **Command guard**: 17 rules block dangerous shell commands in AI output before tool execution
- **SSRF protection**: private IP ranges and internal hostnames blocked at DNS resolution layer
- **Tool injection prevention**: user messages scanned for embedded tool tags to prevent prompt injection
- **Per-project limits**: RPM rate limiting, daily/monthly budget caps, IP allowlist (up to 50 CIDRs), model allowlist, anomaly auto-suspend (5x traffic spike trigger)
- **Audit trail**: all security events and API calls logged to PocketBase (`security_events`, `audit_log`)
- **MFA**: TOTP-based two-factor auth for admin dashboard (Google Authenticator / Authy compatible)

### Observability

- Full-chain tracing with visualization dashboard (`/traces.html`)
- 20 Loki alert rules with Chinese diagnostic messages and fix suggestions
- Telegram multi-channel alerts: critical (immediate delivery) and warning (batched)
- Structured JSON logging with in-memory buffer (configurable, default 1200 entries)
- Error aggregation reports via `npm run logs:errors`
- Alertmanager UI at `http://localhost:19093`

### MCP Gateway

MCPJungle + Playwright for browser automation and external tool server integration. Enables LumiGate to call external MCP-compatible tool servers and orchestrate browser-based workflows.

## Providers

| Provider | Auth | Example Models |
|----------|------|----------------|
| OpenAI | API Key | GPT-5, GPT-5.4, o3, o4-mini |
| Anthropic | API Key | Claude Opus 4.6, Sonnet 4.6 |
| Gemini | API Key | Gemini 3.1 Pro/Flash, 2.5 Flash/Pro |
| DeepSeek | API Key | DeepSeek-Chat V3.2, Reasoner |
| MiniMax | API Key | MiniMax-M2.5, M2, M1 |
| Kimi | Collector | Kimi K2.5, K2 |
| Doubao | Collector | Doubao Seed 2.0 Pro/Lite/Mini |
| Qwen | Collector | Qwen 3.5 Plus, Qwen 3 Max |

Collector providers (Kimi, Doubao, Qwen) use headless Chrome via CDP. Admin logs in once through VNC; Chrome maintains the session. Cookies persist across container restarts. Session health is shown on the dashboard.

## Auth Modes

| Mode | Mechanism | Best For |
|------|-----------|----------|
| Direct Key | `X-Project-Key` header | Server-to-server |
| HMAC Signature | Client signs request; key never transmitted | Mobile apps |
| Ephemeral Token | Short-lived token via `POST /v1/token` | Session-bound access |
| HMAC + Token | HMAC to exchange, token for requests | **Client apps (recommended)** |

### Auth Headers / Cookies

- Platform API: `X-Project-Key` (or HMAC/token flow)
- Admin API: `admin_token` cookie (or `X-Admin-Token`)
- LumiChat API: `lc_token` cookie

## Deploy Modes

| Mode | Modules | Use Case |
|------|---------|----------|
| Lite | usage, chat, backup | Personal use |
| Enterprise | All 9 modules | Teams, compliance |
| Custom | Pick and choose via `MODULES` env var | Tailored setups |

### Module System

Runtime module system. Each module can be enabled or disabled without restarting -- data files are always loaded, modules only gate their endpoints.

| Module | Purpose |
|--------|---------|
| `usage` | Request counting, per-provider/model tracking, auto-pruning at 365 days |
| `budget` | Per-project spend enforcement with daily or monthly caps |
| `multikey` | Multiple API keys per provider with rotation and failover |
| `users` | User management, approval flow, role-based access |
| `audit` | Structured event logging to PocketBase |
| `metrics` | Latency histograms, error rates, provider health scoring |
| `backup` | Scheduled backup and restore, PocketBase sync for collector tokens |
| `smart` | Intelligent routing -- model fallback, cost optimization, load balancing |
| `chat` | LumiChat UI serving and session management |

## API Reference

### Quick Example

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

Optional fields: `web_search` (bool, auto-detected if omitted), `tools` (bool, default true), `specialist_mode` (string), `specialist_category` (string).

### Public / System

| Method | Path | Notes |
|--------|------|-------|
| GET | `/health` | Health + module/provider detail for admin |
| GET | `/providers` | Provider availability |
| GET | `/models/:provider` | Models for provider |
| GET | `/collector/health` | Collector runtime status |

### Gateway / Platform APIs

| Method | Path | Notes |
|--------|------|-------|
| POST | `/v1/chat` | Unified streaming chat API |
| POST | `/platform/parse` | File parsing (PDF/XLSX/DOCX/PPTX/HTML/TXT/MD) |
| POST | `/platform/audio/transcribe` | Audio transcription (native path) |
| POST | `/platform/audio/transcriptions` | OpenAI-compatible transcription |
| POST | `/platform/vision/analyze` | Vision/image analysis |
| POST | `/platform/code/run` | Code runtime execution |
| POST | `/platform/sandbox/exec` | CLI sandbox execution |
| POST | `/platform/tools/execute` | Server-side tool execution |
| POST | `/platform/lumigent/execute` | Lumigent tool execution |
| GET | `/platform/lumigent/tools` | Lumigent tool catalog |
| GET | `/platform/lumigent/traces` | Lumigent execution traces |
| POST | `/v1/token` | Ephemeral token issuance |
| POST | `/v1/otp/send` | OTP send |
| POST | `/v1/otp/verify` | OTP verify |

### Knowledge Base

| Method | Path | Notes |
|--------|------|-------|
| POST | `/v1/knowledge` | Create knowledge base |
| GET | `/v1/knowledge` | List knowledge bases |
| GET | `/v1/knowledge/:id` | Get KB detail + stats |
| DELETE | `/v1/knowledge/:id` | Delete knowledge base |
| POST | `/v1/knowledge/:id/documents` | Add document (text or file, up to 50MB) |
| GET | `/v1/knowledge/:id/documents` | List documents |
| DELETE | `/v1/knowledge/:id/documents/:docId` | Remove document |
| POST | `/v1/knowledge/:id/search` | Search within one KB |
| POST | `/v1/knowledge/search` | Search across multiple KBs |

### Workflows

| Method | Path | Notes |
|--------|------|-------|
| POST | `/v1/workflows` | Create workflow |
| GET | `/v1/workflows` | List workflows |
| GET | `/v1/workflows/:id` | Get workflow detail |
| PUT | `/v1/workflows/:id` | Update workflow |
| DELETE | `/v1/workflows/:id` | Delete workflow |
| POST | `/v1/workflows/:id/run` | Execute workflow |
| POST | `/v1/workflows/:id/resume` | Resume paused workflow (after human approval) |
| GET | `/v1/tasks` | List task queue |
| GET | `/v1/tasks/:id` | Get task status |

### Traces / Observability

| Method | Path | Notes |
|--------|------|-------|
| GET | `/v1/traces` | List traces (filter by userId, type, status, date range) |
| GET | `/v1/traces/stats` | Aggregate stats (groupBy, date range) |
| GET | `/v1/traces/days` | List available trace days |
| GET | `/v1/traces/:id` | Get trace detail |

### User Memory

| Method | Path | Notes |
|--------|------|-------|
| GET | `/lc/memory/recall` | Recall memories for current user |
| POST | `/lc/memory/ingest` | Manually ingest a memory fact |
| GET | `/fn/memory/profile/:userId` | FurNote pet profile retrieval |
| POST | `/fn/memory/profile/:userId` | FurNote pet profile update |

### HKEX / Template Fill

| Method | Path | Notes |
|--------|------|-------|
| POST | `/v1/hkex/download` | Download HKEX announcements via Chrome CDP |
| POST | `/v1/tools/fill-template` | Auto-fill Word/Excel templates from data |

### Admin Auth / MFA

| Method | Path |
|--------|------|
| POST | `/admin/login` |
| POST | `/admin/mfa/verify` |
| POST | `/admin/logout` |
| GET | `/admin/auth` |
| POST | `/admin/mfa/setup` |
| POST | `/admin/mfa/confirm` |
| DELETE | `/admin/mfa` |
| GET | `/admin/mfa/qr` |
| GET | `/admin/mfa/status` |

### Admin Control Plane

| Method | Path | Notes |
|--------|------|-------|
| GET | `/admin/projects` | List projects |
| POST | `/admin/projects` | Create project |
| PUT | `/admin/projects/:name` | Update project |
| DELETE | `/admin/projects/:name` | Delete project |
| POST | `/admin/projects/:name/regenerate` | Regenerate project key |
| GET | `/admin/usage` | Usage data |
| GET | `/admin/usage/summary` | Usage summary |
| GET | `/admin/settings` | Global settings |
| PUT | `/admin/settings` | Update settings |
| GET | `/admin/metrics` | Metrics data |
| GET | `/admin/audit` | Audit log |
| POST | `/admin/backup` | Trigger backup |
| GET | `/admin/backups` | List backups |
| POST | `/admin/restore/:name` | Restore backup |
| GET | `/admin/keys/:provider` | List API keys |
| POST | `/admin/keys/:provider` | Add API key |
| PUT | `/admin/keys/:provider/reorder` | Reorder keys |
| PUT | `/admin/keys/:provider/:keyId` | Update key |
| DELETE | `/admin/keys/:provider/:keyId` | Delete key |
| GET | `/admin/lc-users` | LumiChat user management |
| GET | `/admin/lc-subscriptions` | Subscription management |
| GET | `/admin/collector/status` | Collector status |

### Domain APIs (Config-driven)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/domains/:domain/schema` | Domain schema/capabilities |
| GET | `/api/domains/:domain/:collection` | Generic list with Excel-style filters |
| POST | `/api/domains/:domain/:collection` | Generic create |
| PATCH | `/api/domains/:domain/:collection/:id` | Generic update |
| DELETE | `/api/domains/:domain/:collection/:id` | Generic delete (soft/hard policy) |

Query contract: `filter[field][op]=value` (supports `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`), `sort=field:asc,field2:desc`, `perPage`, `include_deleted=1`, `trash_only=1`.

### LumiChat Auth / Data

| Method | Path | Notes |
|--------|------|-------|
| POST | `/lc/auth/login` | Login |
| POST | `/lc/auth/register` | Register |
| POST | `/lc/auth/logout` | Logout |
| POST | `/lc/auth/refresh` | Refresh token |
| GET | `/lc/auth/me` | Current user profile |
| PATCH | `/lc/auth/profile` | Update profile |
| GET | `/lc/sessions` | List sessions |
| POST | `/lc/sessions` | Create session |
| DELETE | `/lc/sessions/:id` | Delete session |
| GET | `/lc/sessions/:id/messages` | Get messages |
| POST | `/lc/messages` | Save message |
| POST | `/lc/files` | Upload file |
| GET | `/lc/files/serve/:id` | Serve file |
| GET | `/lc/providers` | Provider list for UI |
| GET | `/lc/models/:provider` | Model list for UI |
| GET | `/lc/user/tier` | User tier info |
| GET | `/lc/user/apikeys` | BYOK key management |

## Docker Services

| Service | Container | Port | Purpose |
|---------|-----------|------|---------|
| lumigate | lumigate | 9471 (internal) | Main gateway + Collector Chrome |
| nginx | lumigate-nginx | 9471 (exposed) | Reverse proxy + health fallback |
| pocketbase | lumigate-pocketbase | 8090 | Database (users, sessions, files, audit) |
| file-parser | lumigate-file-parser | 3100 | File parsing (PDF/XLSX/DOCX/PPTX) |
| doc-gen | lumigate-doc-gen | 3101 | Document generation (Excel/Word/PPT) |
| searxng | lumigate-searxng | 8080 | Web search engine |
| whisper | lumigate-whisper | 17863 | Speech-to-text |
| qdrant | lumigate-qdrant | 6333 | Vector search (memory + RAG) |
| gotenberg | lumigate-gotenberg | 3000 | Office-to-PDF conversion (legacy .xls) |
| cloudflare | cloudflare-lumigate | -- | Tunnel to public domain |

Optional services (enabled via Docker profiles):

| Service | Container | Port | Profile | Purpose |
|---------|-----------|------|---------|---------|
| ragflow | lumigate-ragflow | 9380 | `rag` | RAG engine (primary) |
| docling-parser | lumigate-docling | 3102 | `enhanced` | Enhanced PDF parsing |
| loki | lumigate-loki | 19410 | `observability` | Log aggregation |
| promtail | lumigate-promtail | -- | `observability` | Log shipper |
| alertmanager | lumigate-alertmanager | 19093 | `observability` | Alert routing + Telegram |

Enable optional profiles:

```bash
docker compose --profile rag up -d --build           # RAGFlow
docker compose --profile enhanced up -d --build       # Docling parser
docker compose --profile observability up -d --build  # Loki + Promtail + Alertmanager
```

## Observability Stack

Enable the optional Loki + Promtail + Alertmanager stack:

```bash
docker compose --profile observability up -d loki promtail alertmanager
```

20 preloaded Loki alert rules with Chinese diagnostic messages and fix suggestions.

Telegram push (optional):
1. Add to `.env`: `ALERT_TELEGRAM_BOT_TOKEN` and `ALERT_TELEGRAM_CHAT_ID`
2. Restart: `docker compose --profile observability restart alertmanager`

Terminal alert watch:
```bash
./scripts/watch_alerts.sh
```

Error aggregation report:
```bash
npm run logs:errors
```

## Configuration

Most settings are configurable through the Dashboard (Settings page) without editing config files:

| Setting | Description |
|---------|-------------|
| Search keyword model | Which provider/model generates search keywords (default: MiniMax) |
| Auto search | Toggle automatic web search detection |
| Tool injection guard | Enable/disable scanning of user messages for embedded tool tags |
| SMTP settings | Outbound email for user approval notifications |
| Approval flow | Require admin approval for new user registrations |
| Deploy mode | Switch between Lite, Enterprise, and Custom module sets at runtime |

Environment variables (`.env`):

```bash
DEPLOY_MODE=lite                  # lite | enterprise | custom
MODULES=usage,chat,audit          # only used when DEPLOY_MODE=custom
ADMIN_SECRET=your-secret          # dashboard admin password
PB_URL=http://pocketbase:8090     # PocketBase instance URL
PB_ADMIN_EMAIL=admin@example.com  # PB superuser email
PB_ADMIN_PASSWORD=change-me       # PB superuser password
QDRANT_URL=http://lumigate-qdrant:6333  # Qdrant vector DB
RAGFLOW_API_KEY=...               # RAGFlow API key (if using --profile rag)
CF_TUNNEL_TOKEN_LUMIGATE=...      # Cloudflare tunnel token (optional)
```

## File Parsing Priority

Parsing priority and behavior:
- Excel (`.xls`/`.xlsx`) -- first priority. Direct parse via file-parser; legacy `.xls` falls back to Gotenberg (convert to PDF) then re-parses.
- PDF -- second priority.
- Word (`.docx`/`.doc`) -- third.
- PPTX -- lower priority.

PocketBase file metadata fields: `original_name`, `ext`, `kind`, `parse_status`, `parse_error`, `parsed_at`.

## License

MIT
