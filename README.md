# LumiGate

**Self-hosted AI Agent Platform. Multi-provider proxy + tool execution + file parsing + speech-to-text + vision + code sandbox + MCP gateway.**

LumiGate is a self-hosted, multi-provider AI Agent Platform with enterprise security — per-project budgets, model access control, PII detection, secret masking, audit logging, auto-recovery, and MCP tool integration — in a single Node.js process. 8 AI providers, unified tool execution pipeline, and a full chat UI (LumiChat).

Designed to run on a NAS, mini PC, or any edge device.

## Table of Contents

- [Docker Package (Recommended)](#docker-package-recommended)
- [Native Install (for Developers)](#native-install-for-developers)
- [Releases](#releases)
- [Architecture](#architecture)
- [Modular Design](#modular-design)
- [Features](#features)
- [Self-Healing & Data Safety](#self-healing--data-safety)
- [Agent Platform API](#agent-platform-api)
- [API Reference](#api-reference)
- [Security](#security)
- [Performance](#performance)
- [CLI (`lg`)](#cli-lg)
- [Project Structure](#project-structure)
- [Contributing](#contributing)

## Docker Package (Recommended)

Use the prebuilt Docker package without local build.

### One-click install (macOS/Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/richardhxwang/lumigate/main/install-docker-package.sh | bash
```

The installer will:
- detect Docker and install it if missing (supported on macOS/Linux)
- optionally log in to Docker Hub
- pull `richardhwang920/lumigate:latest`
- run the container and verify `/health`

### One-line run (Windows PowerShell)

```powershell
docker run -d --name lumigate -p 9471:9471 -e ADMIN_SECRET=change-me -v "${PWD}\data:/app/data" richardhwang920/lumigate:latest
```

For production, prefer `docker-compose.yml` and mount persistent `data/`.
If your host is ARM64 and the latest image is AMD64-only, add `--platform linux/amd64`.

## Native Install (for Developers)

### One-line guided setup (dependency check)

```bash
curl -fsSL https://raw.githubusercontent.com/richardhxwang/lumigate/main/setup.sh | bash
```

`setup.sh` checks `git`, `docker`, `docker compose`, and `curl`.  
If missing, it can install supported dependencies automatically (may require sudo/admin confirmation).

### Source install

For source-based development, clone the repo and run with Compose:

```bash
git clone https://github.com/richardhxwang/lumigate.git
cd lumigate
cp .env.example .env   # Edit with your API keys
docker compose up -d --build
```

Windows developers should use Docker Desktop + WSL2.  
Open `http://localhost:9471` and log in with your `ADMIN_SECRET`.

## Releases

- Stable tags: `vX.Y.Z`
- Rolling tag: `latest`
- Release notes: see GitHub Releases page for upgrade and compatibility notes


## Architecture

<p align="center">
  <img src="public/architecture.svg" alt="LumiGate Architecture" width="100%"/>
</p>

## Modular Design

LumiGate uses a module system. Choose what you need:

| Mode | Modules | Best For |
|------|---------|----------|
| **Lite** | usage, chat | Personal projects, hobbyists |
| **Enterprise** | All 9 modules | Teams, production, compliance |
| **Custom** | Pick & choose | Tailored deployments |

```bash
# Switch modes
lg mode enterprise
lg restart

# Or pick specific modules
lg config set DEPLOY_MODE custom
lg config set MODULES usage,audit,backup,chat
lg restart
```

### Available Modules

| Module | Description |
|--------|-------------|
| `usage` | Per-project/model token counts & cost tracking |
| `budget` | Per-project spending limits (daily/monthly), auto-reset |
| `multikey` | Multiple API keys per provider with drag-to-reorder priority, per-project key binding |
| `users` | Multi-user RBAC (root/admin/viewer roles) |
| `audit` | Structured JSONL event log, 17 event types |
| `metrics` | SLI counters — requests, errors, latency, memory |
| `backup` | Daily auto-backup, 10-version retention, one-click restore |
| `smart` | Smart routing — auto model selection by task complexity |
| `chat` | Built-in chat UI for testing providers |

## Features

- **Multi-Provider Proxy** — Single `/v1/{provider}/` endpoint routes to OpenAI, Anthropic, Gemini, DeepSeek, Kimi, Doubao, Qwen, MiniMax
- **Anthropic OpenAI Compatibility** — `/v1/anthropic/v1/chat/completions` auto-translates OpenAI request/response format to Anthropic Messages API (streaming + non-streaming). No client changes needed — just swap the provider segment
- **Hot Maintenance** — Nginx serves cached pages during app restarts (zero downtime)
- **RPO ≤ 1s** — 1-second coalesced writes + emergency flush on crash = near-zero data loss
- **Auto-Recovery** — Watchdog detects failures within 10s, auto-restarts containers, handles Docker.raw corruption
- **Dashboard** — 4-tab SPA with Canvas charts, mobile responsive, Apple HIG style
- **CLI & TUI** — `lg` CLI for quick terminal ops, `tui.js` for full-screen dashboard
- **Multi-Currency** — 10 currencies (USD, CNY, EUR, GBP, JPY, KRW, HKD, SGD, AUD, CAD)
- **High Availability** — Cold standby (Plan A, <5MB idle) or hot standby (Plan B) with Cloudflare Tunnel failover
- **External Hardening** — QUIC tunnel protocol, Nginx auto-retry on 502/503, keepalive connection pooling
- **Zero-Downtime Config** — Change API keys, add providers via dashboard without restart
- **Pointer-Events Drag Reorder** — Multi-key priority drag-to-reorder works in Safari and all CSS contexts (replaces HTML5 DnD which fails inside `position:absolute` panels)

## Self-Healing & Data Safety

| Layer | Mechanism |
|-------|-----------|
| **Docker healthcheck** | 5s interval, 2 retries → detects failure in ≤10s |
| **Docker restart policy** | `unless-stopped` → auto-restart on container crash |
| **macOS LaunchDaemon watchdog** | 2s polling, survives Docker daemon crash — see below |
| **Data persistence** | 1s coalesced write-behind (usage, projects), `appendFileSync` (audit) |
| **Emergency flush** | `uncaughtException` / `unhandledRejection` → sync flush before exit |
| **Graceful shutdown** | SIGTERM → flush dirty data → drain connections → exit |
| **Atomic writes** | tmp file + `rename()` on all data files |
| **Network resilience** | QUIC tunnel, Nginx auto-retry 502/503, keepalive pooling |

**RPO: ≤ 1 second.** Even `docker kill` (SIGKILL) loses at most 1 second of data.

### LaunchDaemon Watchdog (macOS)

`restart: unless-stopped` protects against container crashes but **not** against Docker daemon crashes. When Docker Desktop's VM layer (`Docker.raw`) crashes ungracefully, it can wipe the local image cache — containers cannot restart because their image no longer exists, and `restart: unless-stopped` fails silently.

The LaunchDaemon watchdog runs at the **macOS system layer** (survives Docker restarts) and handles full recovery for **both LumiGate and PocketBase**:

1. Detects Docker daemon down or `/health` failure (either service) within **2 seconds**
2. Runs `open -a Docker` and waits up to 2.5 min for Docker Desktop to come up
3. Runs `docker compose up -d --build` in each service's directory (rebuilds image if cache was wiped)
4. Verifies `/health` and sends a crash alert email with one-click **Stop Self-Healing** button

**One-line deploy (macOS, run once):**

```bash
sudo node watchdog-launchd.js --full-install
```

This installs the `lg` CLI symlink and registers the LaunchDaemon — watchdog starts immediately and survives reboots.

**Control:**

```bash
sudo lg kill            # Stop watchdog (prompts sudo automatically)
sudo lg watchdog-install  # Re-enable after kill
```

> **Why `--build`?** LumiGate uses a local Docker build (`build: .` in `docker-compose.yml`) rather than a registry image. This is intentional for self-hosted deployments where you run your own code. After a Docker daemon crash the image cache may be cleared; `--build` reconstructs it from the `Dockerfile` (cached layers are reused when available, so it's fast in normal cases).

## Agent Platform API

LumiGate includes an Agent Platform layer that provides tool execution, file processing, and multimodal capabilities to all connected apps.

### Platform Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/parse` | Parse files (PDF, XLSX, DOCX, PPTX, HTML, TXT, MD) to text |
| POST | `/v1/audio/transcribe` | Speech-to-text via whisper.cpp |
| POST | `/v1/audio/transcriptions` | OpenAI-compatible transcription |
| POST | `/v1/vision/analyze` | Image analysis via Ollama vision model |
| POST | `/v1/code/run` | Execute code in Docker sandbox (Python/JS/Shell) |

### Tool Execution Pipeline

When an AI model returns `tool_use` in its response, LumiGate automatically:
1. Intercepts the tool call
2. Routes to the appropriate executor (built-in, MCP, or custom)
3. Returns results to the model for continued generation
4. Logs execution to PocketBase `tool_calls` collection

Built-in tools: `web_search`, `parse_file`, `transcribe_audio`, `vision_analyze`, `code_run`, `browser_action`, `generate_document`, `generate_presentation`, `generate_spreadsheet`

### Security Pipeline

All requests pass through the security middleware:
- **PII Detection**: Regex patterns (20+ types) + optional Ollama semantic analysis
- **Secret Masking**: Detected secrets replaced with `[SEC_xxx]` placeholders before reaching LLM
- **Command Guard**: 17 rules blocking dangerous shell commands (rm -rf, mkfs, fork bombs, etc.)
- **Audit Logging**: All events written to PocketBase (non-blocking, fire-and-forget)

### MCP Gateway (MCPJungle)

External tools can be added via MCP (Model Context Protocol):
```bash
cd docker/mcp && docker compose up -d
```
Registers Playwright (browser automation) and Filesystem MCP servers. LumiGate auto-discovers and injects MCP tools into LLM requests.

## API Reference

### Proxy Endpoints

```
POST /v1/{provider}/v1/chat/completions
```

**Providers:** `openai`, `anthropic`, `gemini`, `deepseek`, `kimi`, `doubao`, `qwen`, `minimax`

**Auth:** `Authorization: Bearer {ephemeral-token}` (recommended) or `X-Project-Key` header

```bash
# 1. Exchange project key for ephemeral token (HMAC-signed, key never sent)
TOKEN=$(curl -s -X POST https://lumigate.autorums.com/v1/token \
  -H "Content-Type: application/json" \
  -H "X-Project-Id: my-project" \
  -H "X-Signature: $(echo -n "${TIMESTAMP}${NONCE}{}" | openssl dgst -sha256 -hmac "$PROJECT_KEY" -hex | cut -d' ' -f2)" \
  -H "X-Timestamp: $TIMESTAMP" \
  -H "X-Nonce: $NONCE" \
  -d '{}' | jq -r .token)

# 2. Use ephemeral token for API calls
curl -X POST https://lumigate.autorums.com/v1/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model": "gpt-4.1-nano", "messages": [{"role": "user", "content": "Hello"}]}'
```

### Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (status, mode, modules, providers) |
| GET | `/providers` | List all providers and status |
| GET | `/models/{provider}` | List models with pricing |

### Admin Endpoints

| Method | Path | Module | Description |
|--------|------|--------|-------------|
| POST | `/admin/login` | core | Login with `{ secret }` |
| GET | `/admin/projects` | core | List projects |
| POST | `/admin/projects` | core | Create project |
| PUT | `/admin/projects/{name}` | core | Update project |
| DELETE | `/admin/projects/{name}` | core | Delete project |
| GET | `/admin/usage/summary` | usage | Aggregated usage data |
| POST | `/admin/key` | core | Update provider API key |
| GET | `/admin/keys/{provider}` | multikey | List multi-keys |
| GET | `/admin/users` | users | List users |
| GET | `/admin/metrics` | metrics | SLI metrics |
| GET | `/admin/audit` | audit | Audit log entries |
| POST | `/admin/backup` | backup | Create backup |
| GET | `/admin/backups` | backup | List backups |
| POST | `/admin/restore/{name}` | backup | Restore from backup |

## Security

| Layer | Protection |
|-------|-----------|
| **HMAC + Token Auth** | Key never transmitted; HMAC-signed token exchange + short-lived ephemeral tokens |
| **Per-Project Rate Limit** | Independent RPM cap per project (1–10,000 RPM); default 600 RPM for new projects |
| **Per-Token Rate Limit** | RPM cap per ephemeral token — isolates individual users/sessions |
| **Cost Rate Limit** | USD/min spend cap per project — hard ceiling on runaway costs |
| **IP Allowlist** | Per-project IP/CIDR whitelist (up to 50 entries) |
| **Anomaly Auto-Suspend** | Auto-disable project on 5× traffic spike (10-min baseline) |
| **Anti-Replay** | 5-min timestamp window + nonce deduplication on HMAC requests |
| **Session Auth** | Random tokens, 24h expiry, 10k cap, HttpOnly+Secure+SameSite cookies |
| **Timing-Safe Auth** | `crypto.timingSafeEqual` for all secret comparisons |
| **Global Rate Limiting** | 600/min proxy, 120/min admin, 10/15min login (per IP) |
| **SSRF Protection** | Private IP blocklist for provider baseUrl |
| **Security Headers** | CSP, HSTS, X-Content-Type-Options, X-Frame-Options |
| **Docker Hardening** | Non-root user, `.dockerignore` excludes secrets |
| **Audit Trail** | JSONL log, 17+ event types, 10MB rotation |

### Project Auth Modes

| Mode | Key Transmitted | Replay Safe | Best For |
|------|:--------------:|:-----------:|----------|
| **Direct Key** | Yes | No | Server-to-server, internal tools |
| **HMAC Signature** | No | Yes (nonce) | Mobile apps, embedded keys |
| **Ephemeral Token** | Once (exchange) | Token expires | Session-bound access |
| **HMAC + Token** | Never | Yes + expiry | **C-end apps (default)** |

### Auth Security Tests (4/4 passed)

| # | Test | Expected | Actual | Status |
|---|------|----------|--------|--------|
| A-01 | Direct key on HMAC project | 403 | 403 (requires HMAC) | PASS |
| A-02 | HMAC token exchange | 200 + `et_` token | 200 + token (3600s TTL) | PASS |
| A-03 | Ephemeral token proxy request | Auth pass | 200 (proxied to provider) | PASS |
| A-04 | Replay attack (same nonce) | 401 | 401 (duplicate nonce) | PASS |

## Performance

### Stress Tests (Internal)

| Scenario | Requests | Concurrency | QPS | Avg Latency | p95 | p99 | Errors |
|----------|----------|-------------|-----|-------------|-----|-----|--------|
| Health (extreme) | 20,000 | 250 | 12,788 | 19ms | 14ms | 283ms | 0 |
| Health (standard) | 1,000 | 200 | 4,270 | 47ms | — | — | 0 |
| Dashboard | 1,000 | 200 | 2,087 | 96ms | — | — | 0 |
| Peak burst | 5,000 | 500 | 4,978 | 100ms | — | — | 0 |

### Stress Tests (External — Cloudflare Named Tunnel, QUIC)

| Scenario | Requests | Concurrency | QPS | p50 | p99 | Success |
|----------|----------|-------------|-----|-----|-----|---------|
| Heavy (cold) | 1,000 | 50 | 337 | 132ms | 351ms | 98.6% (QUIC cold start) |
| Heavy (warm) | 1,000 | 50 | 383 | 114ms | 316ms | 100% |
| Extreme | 2,000 | 100 | 468 | 184ms | 434ms | 99.95% |
| Burst | 5,000 | 200 | 484 | 369ms | 718ms | 99.98% |
| Sustained 30s | 11,762 | 100 | 388 | 245ms | 569ms | 99.99% |
| **EXTREME** | **10,000** | **500** | **476** | **1,035ms** | **1,836ms** | **99.94%** |

> Tested via Cloudflare QUIC tunnel to SIN edge. All failures are client-side TLS EOF, not server errors.

### Penetration Tests (20/20 passed)

| Category | Tests | Result |
|----------|-------|--------|
| Auth bypass (no login, fake cookie, fake token) | 6 | All blocked (401) |
| Injection (path traversal, XSS, NoSQL, CRLF, null byte) | 6 | All blocked |
| Rate limiting (login brute force, proxy flood) | 3 | 429 triggered correctly |
| Protocol (oversized payload, method tampering, host injection, open redirect) | 5 | All blocked (403/404) |

> Double-layer protection: app-level auth + rate limiting + Cloudflare WAF. See [full report](reviews/review-report-v6-external.md).

### Security Feature Performance Impact

| Metric | Before | After (HMAC + Token + RPM + IP + Anomaly) | Delta |
|--------|--------|---------------------------------------------|-------|
| QPS (2000 req / 100 concurrent) | 2,230 | 2,379 | +6.7% |
| Failed requests | 0 | 0 | — |
| Memory | ~44 MiB | ~45 MiB | +1 MiB |

> All security checks are O(1) in-memory operations. Zero measurable performance impact.

### Chaos & Fault Injection

| Scenario | Method | Result |
|----------|--------|--------|
| Restart under probe (internal) | Stop app 3s → start, continuous health polling | 78/78 OK, 0 errors (Nginx stale cache) |
| Restart under probe (external) | Same via Cloudflare named tunnel | 66/66 OK, 0 errors |
| SIGKILL during write burst | 120 project creates → `kill -9` → restart | valid JSON, 240 projects intact, 0 tmp leftovers |
| Data integrity (RPO ≤1s) | Create project → wait 1.5s → SIGKILL | Data persisted on disk, zero loss |

### Network Hardening

| Layer | Mechanism |
|-------|-----------|
| **Tunnel protocol** | QUIC (multiplexed, 0-RTT reconnect) |
| **Connection pool** | Nginx keepalive 32, 60s timeout, 1000 req/conn |
| **Auto-retry** | `proxy_next_upstream` on 502/503, 2 tries within 3s |
| **Upstream failover** | `max_fails=2 fail_timeout=5s` — fast failure detection |
| **Graceful drain** | Tunnel `grace-period 30s` on shutdown |

### Resource Usage

| Component | Memory |
|-----------|--------|
| App (Node.js, lite) | ~22 MiB |
| App (Node.js, enterprise) | ~27 MiB |
| Nginx | ~10 MiB |
| **Total (enterprise app + nginx)** | **~37 MiB** |

> Runtime memory varies by mode and load. Values above are observed from current container snapshots.

## CLI (`lg`)

LumiGate ships with a full-featured CLI. Install it:

```bash
sudo ln -sf "$(pwd)/cli.sh" /usr/local/bin/lg
```

Just type `lg` to see live status and quick commands:

```
lg v1.0.0 — LumiGate CLI

  ● Online  │  enterprise  │  2d 5h 30m  │  openai, gemini, deepseek

  lg status          Health & providers
  lg config          View/edit config
  lg start           Start containers
  lg restart         Rebuild & restart
  lg logs            Tail logs
  lg projects        Manage projects
  lg usage           Cost & usage
  lg help            All commands
```

### All Commands

| Category | Command | Description |
|----------|---------|-------------|
| **Lifecycle** | `lg setup` | Interactive setup wizard |
| | `lg start` | Start all containers |
| | `lg stop / restart / down` | Stop / rebuild+restart / tear down |
| | `lg update` | Pull latest code + rebuild |
| | `lg logs [service]` | Tail container logs |
| | `lg ps` | Show container status |
| **Config** | `lg config` | Show current config |
| | `lg config set <KEY> <val>` | Set any config (API keys, mode, port, etc.) |
| | `lg config env` | Edit .env file directly |
| | `lg mode [lite\|enterprise\|custom]` | View/switch deploy mode |
| **Gateway** | `lg status` | Health, uptime, providers, watchdog |
| | `lg providers` | List all providers with status |
| | `lg test <provider> [model]` | Test provider connectivity |
| | `lg models <provider>` | List models with pricing |
| | `lg key <provider> <key>` | Update provider API key |
| **Projects** | `lg projects` | List projects |
| | `lg projects add <name>` | Create project + get API key |
| | `lg projects del <name>` | Delete project |
| | `lg usage [days]` | Usage & cost summary |
| **Operations** | `lg backup [create\|list]` | Manage backups |
| | `lg backup restore <name>` | Restore from backup |
| | `lg watchdog-install` | Install LaunchDaemon watchdog (sudo) |
| | `lg kill` | Stop LaunchDaemon watchdog (sudo) |
| | `lg install` | Symlink `lg` to /usr/local/bin |

## Project Structure

```
├── server.js               # Express monolith — proxy, auth, usage, admin API, route mounting
├── security/               # PII detection, secret masking, command guard, Ollama detector
├── tools/                  # Tool registry, unified registry, MCP client, schemas
├── routes/                 # Agent Platform API (parse, audio, vision, code)
├── middleware/             # Security + audit middleware (PB event logging)
├── cli.sh                  # lg CLI — full lifecycle & management tool
├── setup.sh                # One-line installer & onboard wizard
├── watchdog-launchd.js     # macOS LaunchDaemon watchdog (survives Docker crash)
├── nginx/nginx.conf        # Reverse proxy — cache, failover, maintenance
├── public/
│   ├── index.html          # Dashboard SPA (Canvas charts, Apple HIG)
│   ├── lumichat.html       # LumiChat UI (SSE streaming, PocketBase auth)
│   └── chat.html           # Built-in admin chat
├── docker/                 # Additional Docker configs (MCP, whisper)
├── deploy/                 # NAS/Mac Mini split deployment + migration script
├── data/                   # JSON persistence (Docker volume)
├── docker-compose.yml      # Production deployment
├── .env.example            # Config template
└── CLAUDE.md               # AI development guide
```

## Contributing

LumiGate is open source. Issues, pull requests, and feature suggestions are welcome.
Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a PR.

If you find it useful, give it a star!
