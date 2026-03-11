# LumiGate

**Enterprise-grade AI gateway. 24 MB footprint.**

LumiGate is a self-hosted, multi-provider AI API gateway that delivers enterprise features — per-project budgets, model access control, token-level cost tracking, and high-availability failover — in a single Node.js process with zero external dependencies. No database, no Redis, no DevOps team required.

Designed to run on a NAS, mini PC, or any edge device where every megabyte counts.

## Architecture

<p align="center">
  <img src="public/architecture.svg" alt="LumiGate Architecture" width="100%"/>
</p>

## Features

- **Multi-Provider Proxy** — Single `/v1/{provider}/` endpoint routes to OpenAI, Anthropic, Gemini, DeepSeek, Kimi, Doubao, Qwen, MiniMax
- **Hot Maintenance** — Nginx reverse proxy serves cached pages & maintenance responses during app restarts
- **Project Key Auth** — Unique `X-Project-Key` per project, CRUD via dashboard
- **Per-Project Budget** — Set USD spending limits per project (daily/monthly/lifetime), auto-reset, 429 when exceeded
- **Per-Project Model Allowlist** — Restrict which models each project key can access
- **Usage Tracking** — Per-project, per-model request/token counts with cache hit/miss breakdown
- **Cost Estimation** — Cache-aware pricing (input/cached-input/output), Gemini free tier support, multi-currency (USD, CNY, EUR, GBP, JPY, KRW, HKD, SGD, AUD, CAD)
- **Dashboard** — 4-tab SPA with Canvas charts, mobile responsive, Apple HIG style
- **Built-in Chat** — SSE streaming chat interface supporting all providers
- **CLI & TUI** — Terminal tools (`cli.sh` for quick commands, `tui.js` for full-screen interface)
- **Security** — Session-based auth, timing-safe key comparison, SSRF protection, rate limiting, CORS, CSP, HSTS, input sanitization
- **Audit Logging** — Structured JSONL audit trail for all admin operations (login, project/key/user changes, backups, startup/shutdown)
- **SLI Metrics** — Real-time request/error/latency counters via `/admin/metrics`
- **Backup & Restore** — One-click backup/restore API with daily auto-backup, 10-version retention, hot reload on restore
- **Docker-Native** — Nginx + Express + Cloudflare Tunnel, healthcheck, volume-persisted data
- **Zero-Downtime Config** — Change API keys, add providers via dashboard without restart
- **High Availability** — Cold standby (Plan A, <5MB idle) or hot standby (Plan B) failover with automatic Cloudflare Tunnel switchover

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/richardhxwang/lumigate.git
cd lumigate
cp .env.example .env
# Edit .env with your API keys
```

### 2. Create `.env`

```env
# At least one provider key required
OPENAI_API_KEY=sk-xxx
DEEPSEEK_API_KEY=sk-xxx
# ANTHROPIC_API_KEY=sk-ant-xxx
# GEMINI_API_KEY=AIzaSyxxx
# KIMI_API_KEY=sk-xxx
# DOUBAO_API_KEY=xxx
# QWEN_API_KEY=sk-xxx
# MINIMAX_API_KEY=xxx

# Server
PORT=9471
ADMIN_SECRET=your-admin-password

# Cloudflare Tunnel (optional)
# CF_TUNNEL_TOKEN_AIGATEWAY=xxx
```

### 3. Run

```bash
# With Docker (recommended)
docker compose up -d --build

# Or directly
npm install
node server.js
```

### 4. Open the Dashboard

Go to `http://localhost:9471` and log in with your `ADMIN_SECRET`.

From the dashboard you can:
- **Providers** — View status, test connections, update API keys at runtime (no restart needed)
- **Projects** — Create project keys for your apps, enable/disable/regenerate
- **Usage** — Monitor per-project and per-model usage, cost breakdown with currency selector
- **Chat** — Test any provider/model at `http://localhost:9471/chat`

## API Reference

### Proxy Endpoints

All AI provider APIs are accessible via:

```
POST /v1/{provider}/v1/chat/completions
```

**Providers:** `openai`, `anthropic`, `gemini`, `deepseek`, `kimi`, `doubao`, `qwen`, `minimax`

**Authentication:** Include `X-Project-Key` header or `Authorization: Bearer {project-key}`

```bash
curl -X POST https://your-gateway.com/v1/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Project-Key: pk_your_project_key" \
  -d '{
    "model": "gpt-4.1-nano",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (used by Docker) |
| GET | `/providers` | List all providers and status |
| GET | `/models/{provider}` | List models for a provider |

### Admin Endpoints (require auth)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/login` | Login with `{ secret }`, sets cookie |
| POST | `/admin/logout` | Clear auth cookie |
| GET | `/admin/auth` | Check auth status |
| GET | `/admin/uptime` | Server uptime |
| GET | `/admin/test/{provider}` | Test provider connection |
| GET | `/admin/projects` | List projects |
| POST | `/admin/projects` | Create project `{ name, maxBudgetUsd?, budgetPeriod?, allowedModels? }` |
| PUT | `/admin/projects/{name}` | Update project (budget, models, enabled, rename) |
| DELETE | `/admin/projects/{name}` | Delete project |
| POST | `/admin/projects/{name}/regenerate` | Regenerate key |
| GET | `/admin/usage?days=7` | Detailed usage data |
| GET | `/admin/usage/summary?days=7` | Aggregated usage summary |
| GET | `/admin/rate` | Current exchange rates (multi-currency) |
| POST | `/admin/key` | Update provider API key at runtime |
| GET | `/admin/metrics` | SLI metrics (requests, latency, memory) |
| GET | `/admin/audit?limit=N` | Audit log (last N entries, root only) |
| POST | `/admin/backup` | Create manual backup (root only) |
| GET | `/admin/backups` | List backups (root only) |
| POST | `/admin/restore/{name}` | Restore from backup (root only) |

## Adding a New Provider

If the provider uses an OpenAI-compatible API format, add it in `server.js`:

1. Add to `PROVIDERS`:
```javascript
newprovider: {
  baseUrl: process.env.NEWPROVIDER_BASE_URL || "https://api.newprovider.com",
  apiKey: process.env.NEWPROVIDER_API_KEY,
},
```

2. Add models to `MODELS`:
```javascript
newprovider: [
  { id: "model-name", tier: "standard", price: { in: 1.0, cacheIn: 0.25, out: 2.0 }, caps: ["text"], desc: "Description" },
],
```

3. Add `NEWPROVIDER_API_KEY=xxx` to `.env` and `.env.example`.

4. If the API format differs (like Anthropic), add special handling in the proxy's `pathRewrite` and auth injection sections.

> **Tip:** You can also add or update API keys at runtime from the Dashboard's Providers tab — no restart required.

## Security

| Layer | Protection |
|-------|-----------|
| **Cloudflare Access** | Google OAuth for dashboard, bypass for `/v1/*` API paths |
| **Session Auth** | Random session tokens (not raw secret), 24h expiry, 10k cap with FIFO eviction, HttpOnly + Secure + SameSite cookies |
| **Timing-Safe Auth** | `crypto.timingSafeEqual` for all secret and key comparisons |
| **Project Keys** | 48-char random hex per project, enable/disable/regenerate |
| **Rate Limiting** | 600 req/min proxy, 120 req/min admin, 10/15min login |
| **Anti-Spoofing** | Nginx overrides `X-Forwarded-For` with `$remote_addr`, prevents rate limit bypass |
| **SSRF Protection** | Private IPs, cloud metadata, and internal addresses blocked in baseUrl |
| **CORS** | Same-origin only |
| **Input Sanitization** | Project names validated, `.env` writes sanitized, JSON body capped at 10MB |
| **Path Allowlist** | Per-provider upstream path validation, normalized to match proxy rewrite rules |
| **XSS Prevention** | HTML-escaped user data, no stack traces in error responses |
| **Security Headers** | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Content-Security-Policy`, `Strict-Transport-Security`, no `X-Powered-By` |
| **Docker Hardening** | Non-root user, `.dockerignore` excludes secrets, `server_tokens off` |
| **Audit Trail** | Structured JSONL audit log, 17 event types, 10MB auto-rotation, query API |
| **Backup/Restore** | Daily auto-backup, 10-version retention, one-click restore with hot reload |
| **Graceful Shutdown** | Connection draining, atomic data flush on SIGTERM |

### Penetration Test Results

All endpoints tested against authentication bypass, injection, path traversal, SSRF, rate limit bypass, and information leakage. Results:

| Category | Tests | Result |
|----------|-------|--------|
| Authentication (brute force, fake tokens, SQL injection) | 5 | All PASS |
| Rate limit bypass (X-Forwarded-For spoofing) | 2 | All PASS |
| Path traversal & injection (XSS, command injection) | 3 | All PASS |
| Information leakage (API keys, stack traces, CORS) | 5 | All PASS |
| SSRF via baseUrl | 1 | PASS (private IP blocklist) |
| Cookie security (HttpOnly, Secure, SameSite) | 2 | All PASS |
| Input validation (oversized payload, prototype pollution) | 4 | All PASS |

## Performance

Designed to run on lightweight hardware (NAS, mini PC) while supporting enterprise-grade traffic (~10k DAU).

### Optimizations

- **Single proxy instance** — One shared `http-proxy-middleware` with connection pooling, not per-request
- **SSE tail buffer** — Only retains last 8KB of streaming responses for usage parsing (not full body)
- **Gzip compression** — 70% size reduction (62KB → 19KB dashboard)
- **In-memory caching** — Chat HTML cached at startup, one-time data directory check
- **Usage query cache** — 5-second TTL response cache for analytics endpoints, auto-invalidated on writes
- **Atomic writes** — All data files use tmp+rename pattern to prevent corruption
- **Auto-pruning** — Usage data older than 365 days is automatically cleaned up
- **Session cap** — 10k max sessions with FIFO eviction, prevents unbounded memory growth
- **Nginx keepalive** — Connection pool to upstream, eliminates per-request TCP handshake

### Benchmark (Apple Mac mini M4, Docker)

| Scenario | Concurrency | QPS | Avg Latency | Errors |
|----------|-------------|-----|-------------|--------|
| Health check | 200 | 4,270 | 47ms | 0% |
| Dashboard (62KB gzipped) | 200 | 2,087 | 96ms | 0% |
| Peak burst | 500 | 4,978 | 100ms | 0% |
| Auth rejection (proxy path) | 200 | 4,240 | 47ms | 0% |

**Resource usage:** ~24MB total (App 14MB + Nginx 10MB). Stable under sustained load with bounded session memory.

## Project Structure

```
├── server.js            # Express server — proxy, auth, usage tracking, admin API
├── nginx/
│   └── nginx.conf       # Reverse proxy — cache, failover, maintenance pages
├── public/
│   ├── index.html       # Dashboard — 4-tab SPA with Canvas charts
│   ├── chat.html        # Built-in chat interface with SSE streaming
│   ├── architecture.svg # Architecture diagram
│   ├── favicon.svg      # Site icon
│   └── logos/           # Provider logo assets (128×128 PNG)
├── cli.sh               # CLI tool — status, providers, test, usage
├── tui.js               # TUI tool — full-screen terminal dashboard
├── data/                # Persistent state (Docker volume)
│   ├── projects.json    # Project keys
│   ├── usage.json       # Usage & token counts
│   └── exchange-rate.json
├── package.json
├── Dockerfile
├── docker-compose.yml   # Nginx + Express + Cloudflare Tunnel
├── .env                 # API keys & config (git-ignored)
├── .env.example         # Template for .env
└── .gitignore
```

## License

MIT
