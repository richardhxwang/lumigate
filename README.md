# AI API Gateway

A self-hosted, multi-provider AI API gateway with usage tracking, cost estimation, and a built-in dashboard.

One container. All your AI providers behind a single endpoint.

## Architecture

```mermaid
graph LR
  subgraph Clients
    A1[🟢 Your Apps<br/>FurNote, etc.]
    A2[🔵 Built-in Chat]
    A3[🟡 Dashboard]
  end

  subgraph Cloudflare
    CF[☁️ Tunnel + Access<br/>OAuth · WAF]
  end

  subgraph Gateway["🐳 AI API Gateway Container"]
    direction TB
    AUTH[🔐 Auth<br/>Admin Secret · Project Keys]
    RL[⚡ Rate Limiter<br/>Per-IP · Per-Endpoint]
    PROXY[🔀 Proxy Router<br/>Path Rewrite · Header Injection]
    USAGE[📊 Usage Tracker<br/>Cache-Aware · Free Tier]
    ADMIN[⚙️ Admin API<br/>Projects · Keys · Config]
    UI[🖥️ Dashboard UI<br/>Providers · Usage · Cost]
  end

  subgraph Providers["AI Providers"]
    P1[🟦 DeepSeek]
    P2[🟩 OpenAI]
    P3[🟧 Anthropic]
    P4[🟥 Gemini]
    P5[🟪 Kimi]
    P6[🔶 Doubao]
    P7[🔷 Qwen]
    P8[⬡ MiniMax]
  end

  subgraph Storage["📁 Persistent Data"]
    D1[projects.json]
    D2[usage.json]
    D3[exchange-rate.json]
  end

  A1 -->|X-Project-Key| CF
  A2 -->|Internal Key| CF
  A3 -->|Admin Cookie| CF
  CF --> AUTH
  AUTH --> RL --> PROXY
  PROXY --> P1 & P2 & P3 & P4 & P5 & P6 & P7 & P8
  PROXY --> USAGE
  ADMIN --> Storage
  USAGE --> Storage

  style Gateway fill:#1a1a2e,stroke:#16213e,color:#fff
  style Providers fill:#0d1117,stroke:#30363d,color:#fff
  style Cloudflare fill:#f38020,stroke:#f38020,color:#fff
  style Clients fill:#161b22,stroke:#30363d,color:#fff
  style Storage fill:#0d1117,stroke:#30363d,color:#fff
```

## Features

- **Multi-Provider Proxy** — Single `/v1/{provider}/` endpoint routes to DeepSeek, OpenAI, Anthropic, Gemini, Kimi, Doubao, Qwen, MiniMax
- **Project Key Auth** — Unique `X-Project-Key` per project, CRUD via dashboard
- **Usage Tracking** — Per-project, per-model request/token counts with cache hit/miss breakdown
- **Cost Estimation** — Cache-aware pricing (input/cached-input/output), Gemini free tier support, USD/CNY toggle with auto exchange rate
- **Built-in Chat** — SSE streaming chat interface supporting all providers
- **Security** — Admin auth (cookie + token), rate limiting, CORS restriction, input sanitization, graceful shutdown
- **Docker-Native** — Single container, healthcheck, Cloudflare Tunnel ready, volume-persisted data
- **Zero-Downtime Config** — Change API keys, add providers via dashboard without restart

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/richardhxwang/ai-api-gateway.git
cd ai-api-gateway
cp .env.example .env
# Edit .env with your API keys
```

### 2. Create `.env`

```env
# At least one provider key required
DEEPSEEK_API_KEY=sk-xxx
OPENAI_API_KEY=sk-xxx
# ANTHROPIC_API_KEY=sk-ant-xxx
GEMINI_API_KEY=AIzaSyxxx
# KIMI_API_KEY=sk-xxx
# DOUBAO_API_KEY=xxx
# QWEN_API_KEY=sk-xxx
# MINIMAX_API_KEY=xxx

# Server
PORT=3000
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

Dashboard: `http://localhost:3000`
Chat: `http://localhost:3000/chat`

## API Reference

### Proxy Endpoints

All AI provider APIs are accessible via:

```
POST /v1/{provider}/v1/chat/completions
```

**Providers:** `deepseek`, `openai`, `anthropic`, `gemini`, `kimi`, `doubao`, `qwen`, `minimax`

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
| GET | `/admin/auth` | Check auth status |
| GET | `/admin/uptime` | Server uptime |
| GET | `/admin/test/{provider}` | Test provider connection |
| GET | `/admin/projects` | List projects |
| POST | `/admin/projects` | Create project `{ name }` |
| PUT | `/admin/projects/{name}` | Update project |
| DELETE | `/admin/projects/{name}` | Delete project |
| POST | `/admin/projects/{name}/regenerate` | Regenerate key |
| GET | `/admin/usage?days=7` | Detailed usage data |
| GET | `/admin/usage/summary?days=7` | Aggregated usage summary |
| GET | `/admin/rate` | Current USD/CNY exchange rate |
| POST | `/admin/key` | Update provider API key at runtime |

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

3. If the API format differs (like Anthropic), add special handling in the proxy's `pathRewrite` and auth injection sections.

## Security

| Layer | Protection |
|-------|-----------|
| **Cloudflare Access** | Google OAuth for dashboard, bypass for `/v1/*` API paths |
| **Admin Auth** | Cookie + `X-Admin-Token` header, bcrypt-equivalent secret |
| **Project Keys** | 48-char random hex per project, enable/disable/regenerate |
| **Rate Limiting** | 120 req/min proxy, 60 req/min admin, 10/15min login |
| **CORS** | Same-origin only |
| **Input Sanitization** | Project names validated, .env writes sanitized against injection |
| **XSS Prevention** | HTML-escaped user data in dashboard |
| **Graceful Shutdown** | Connection draining, data flush on SIGTERM |
| **Docker Healthcheck** | HTTP `/health` every 30s |

## Project Structure

```
├── server.js            # Express server — proxy, auth, usage tracking, admin API
├── public/
│   ├── index.html       # Dashboard — providers, projects, usage & cost
│   ├── chat.html        # Built-in chat interface with SSE streaming
│   ├── favicon.svg       # Site icon
│   └── logos/            # Provider logo assets
├── data/                 # Persistent state (Docker volume)
│   ├── projects.json     # Project keys
│   ├── usage.json        # Usage & token counts
│   └── exchange-rate.json
├── Dockerfile
├── docker-compose.yml
├── .env                  # API keys & config (git-ignored)
└── .gitignore
```

## License

MIT
