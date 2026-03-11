# LumiGate

**Enterprise-grade AI gateway. 24 MB footprint. One command to deploy.**

LumiGate is a self-hosted, multi-provider AI API gateway with modular enterprise features — per-project budgets, model access control, token-level cost tracking, audit logging, auto-recovery, and high-availability failover — in a single Node.js process with zero external dependencies. No database, no Redis, no DevOps team required.

Designed to run on a NAS, mini PC, or any edge device where every megabyte counts.

## Table of Contents

- [Quick Start](#quick-start)
- [CLI (`lg`)](#cli-lg)
- [Architecture](#architecture)
- [Modular Design](#modular-design)
- [Features](#features)
- [Self-Healing & Data Safety](#self-healing--data-safety)
- [API Reference](#api-reference)
- [Security](#security)
- [Performance](#performance)
- [Project Structure](#project-structure)
- [Contributing](#contributing)

## Quick Start

```bash
# One-line install
curl -fsSL https://raw.githubusercontent.com/richardhxwang/lumigate/main/setup.sh | bash

# Or manually
git clone https://github.com/richardhxwang/lumigate.git && cd lumigate
cp .env.example .env   # Edit with your API keys
docker compose up -d --build
```

Open `http://localhost:9471` and log in with your `ADMIN_SECRET`.

## Docker Package (Recommended)

Use prebuilt Docker image instead of local build:

```bash
docker pull richardhxwang/lumigate:latest
docker run -d --name lumigate \
  -p 9471:9471 \
  -e ADMIN_SECRET=change-me \
  -v "$(pwd)/data:/app/data" \
  richardhxwang/lumigate:latest
```

For production, use `docker-compose.yml` and mount persistent `data/`.

## Releases

- Stable tags: `vX.Y.Z`
- Rolling tag: `latest`
- Release notes: see GitHub Releases page for upgrade and compatibility notes

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
| | `lg watchdog start\|stop\|log` | Auto-recovery daemon |
| | `lg install` | Symlink `lg` to /usr/local/bin |

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
| `multikey` | Multiple API keys per provider with priority |
| `users` | Multi-user RBAC (root/admin/viewer roles) |
| `audit` | Structured JSONL event log, 17 event types |
| `metrics` | SLI counters — requests, errors, latency, memory |
| `backup` | Daily auto-backup, 10-version retention, one-click restore |
| `smart` | Smart routing — auto model selection by task complexity |
| `chat` | Built-in chat UI for testing providers |

## Features

- **Multi-Provider Proxy** — Single `/v1/{provider}/` endpoint routes to OpenAI, Anthropic, Gemini, DeepSeek, Kimi, Doubao, Qwen, MiniMax
- **Hot Maintenance** — Nginx serves cached pages during app restarts (zero downtime)
- **RPO ≤ 1s** — 1-second coalesced writes + emergency flush on crash = near-zero data loss
- **Auto-Recovery** — Watchdog detects failures within 10s, auto-restarts containers, handles Docker.raw corruption
- **Dashboard** — 4-tab SPA with Canvas charts, mobile responsive, Apple HIG style
- **CLI & TUI** — `lg` CLI for quick terminal ops, `tui.js` for full-screen dashboard
- **Multi-Currency** — 10 currencies (USD, CNY, EUR, GBP, JPY, KRW, HKD, SGD, AUD, CAD)
- **High Availability** — Cold standby (Plan A, <5MB idle) or hot standby (Plan B) with Cloudflare Tunnel failover
- **External Hardening** — QUIC tunnel protocol, Nginx auto-retry on 502/503, keepalive connection pooling
- **Zero-Downtime Config** — Change API keys, add providers via dashboard without restart

## Self-Healing & Data Safety

| Layer | Mechanism |
|-------|-----------|
| **Docker healthcheck** | 5s interval, 2 retries → detects failure in ≤10s |
| **Docker restart policy** | `unless-stopped` → auto-restart on crash |
| **Watchdog daemon** | 5s polling via Docker socket, auto `docker start`, Docker.raw corruption recovery |
| **Data persistence** | 1s coalesced write-behind (usage, projects), `appendFileSync` (audit) |
| **Emergency flush** | `uncaughtException` / `unhandledRejection` → sync flush before exit |
| **Graceful shutdown** | SIGTERM → flush dirty data → drain connections → exit |
| **Atomic writes** | tmp file + `rename()` on all data files |
| **Network resilience** | QUIC tunnel, Nginx auto-retry 502/503, keepalive pooling |

**RPO: ≤ 1 second.** Even `docker kill` (SIGKILL) loses at most 1 second of data.

## API Reference

### Proxy Endpoints

```
POST /v1/{provider}/v1/chat/completions
```

**Providers:** `openai`, `anthropic`, `gemini`, `deepseek`, `kimi`, `doubao`, `qwen`, `minimax`

**Auth:** `X-Project-Key` header or `Authorization: Bearer {project-key}`

```bash
curl -X POST https://lumigate.autorums.com/v1/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Project-Key: pk_your_project_key" \
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
| **Session Auth** | Random tokens, 24h expiry, 10k cap, HttpOnly+Secure+SameSite cookies |
| **Timing-Safe Auth** | `crypto.timingSafeEqual` for all secret comparisons |
| **Rate Limiting** | 600/min proxy, 120/min admin, 10/15min login |
| **SSRF Protection** | Private IP blocklist for provider baseUrl |
| **Security Headers** | CSP, HSTS, X-Content-Type-Options, X-Frame-Options |
| **Docker Hardening** | Non-root user, `.dockerignore` excludes secrets |
| **Audit Trail** | JSONL log, 17 event types, 10MB rotation |

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
| App (Node.js) | ~18 MiB |
| Nginx | ~10 MiB |
| **Total** | **~28 MiB** |

## Project Structure

```
├── server.js               # Express monolith — proxy, auth, usage, admin API
├── cli.sh                  # lg CLI — full lifecycle & management tool
├── setup.sh                # One-line installer & onboard wizard
├── watchdog.sh             # Auto-recovery daemon (<10s detection)
├── tui.js                  # Full-screen terminal dashboard
├── nginx/nginx.conf        # Reverse proxy — cache, failover, maintenance
├── public/
│   ├── index.html          # Dashboard SPA (Canvas charts, Apple HIG)
│   └── chat.html           # Built-in chat with SSE streaming
├── failover/               # HA configs (cold/hot standby)
├── reviews/                # Review reports & test results
├── data/                   # JSON persistence (Docker volume)
├── docker-compose.yml      # Nginx + Express + Cloudflare Tunnel
├── .env.example            # Config template
└── CLAUDE.md               # AI development guide
```

## Contributing

LumiGate is open source. Issues, pull requests, and feature suggestions are welcome.
Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a PR.

If you find it useful, give it a star!
