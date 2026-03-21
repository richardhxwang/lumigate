# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

LumiTrade is a sub-module of LumiGate — an AI-assisted SMC/ICT trading platform. Connects to IBKR (stocks, via ib_insync + IB Gateway) and OKX (crypto, via freqtrade), runs Smart Money Concepts strategy analysis with FreqAI ML optimization, integrates news/sentiment (FinBERT + Finnhub), and provides LumiTrader — an independent trading AI assistant.

## Architecture

```
User → LumiTrade UI (FreqUI reskinned at /lumitrade/)
         ├── Trade/Dashboard/Chart+TV/Backtest/LumiTrader/Logs
         ├── Floating LumiTrader panel (every page)
         └── nginx (:9471) proxies to:
              ├── freqtrade (:8080) — crypto trading + FreqUI
              ├── freqtrade-bt (:8080) — backtest webserver instance
              └── LumiGate (server.js) proxies to:
                   ├── Trade Engine (FastAPI :3200) — unified data layer
                   │    ├── connectors/ibkr.py → IB Gateway (:4002)
                   │    ├── connectors/freqtrade.py → freqtrade API
                   │    ├── analytics/ — sessions, mood, RAG, reports
                   │    └── strategies/ — SMC analyzer, backtester
                   ├── FinBERT (:5000) — sentiment analysis
                   └── PocketBase — lumitrade project (11 collections)
```

## How to start

```bash
# Full stack (with LumiGate)
docker compose --profile trade up -d --build

# Rebuild FreqUI after source changes
cd lumitrade/frequi-src && pnpm build
rm -rf ../frequi-custom/installed/assets ../frequi-custom/installed/index.html
cp -r dist/* ../frequi-custom/installed/
docker compose --profile trade up -d --no-deps --force-recreate freqtrade freqtrade-backtest

# Rebuild trade-engine only
docker compose --profile trade up -d --no-deps --build trade-engine

# CRITICAL: always rm old assets before cp (Vite generates new hashed filenames each build)
```

## Containers and ports

| Container | Port | Purpose |
|-----------|------|---------|
| `lumigate-trade-engine` | 3200→18793 | FastAPI — unified API, SMC, risk, connectors |
| `lumigate-freqtrade` | 8080→18790 | Trade mode — live crypto trading |
| `lumigate-freqtrade-bt` | 8080→18795 | Webserver mode — backtesting UI |
| `lumigate-finbert` | 5000→18796 | FinBERT sentiment scoring |
| `lumigate-ibgateway` | 4002, 5900 | IB Gateway (paper), VNC for 2FA |

## Key integration points

**Three layers of proxying:**
1. nginx → FreqUI at `/lumitrade/` (sub_filter rewrites asset paths)
2. nginx → LumiGate at `/v1/trade/*` (platformAuth required)
3. LumiGate → Trade Engine at `:3200` (internal Docker network)

**FreqUI customization:** Source at `frequi-src/`, built output mounted at `frequi-custom/installed/` into freqtrade container. Key customizations:
- `index.html` — splash animation, favicon, localStorage migration
- `src/components/layout/NavBar.vue` — LumiTrade branding, nav items
- `src/styles/tailwind.css` — frosted glass, Apple fonts, border-radius
- `src/plugins/primevue.ts` — green accent (#10a37f) theme preset
- `src/main.ts` — auto-login via `/lumitrade/auto-auth`
- `vite.config.ts` — `base: '/lumitrade/'`

**PocketBase:** All trade collections in `lumitrade` PB project. Schema defined in `services/pb-schema.js` using `fields` key (NOT `schema` — PB 0.23+ breaking change). Collections auto-created on LumiGate startup. Project isolation via `toTradeProjectPath()` in `routes/trade.js`.

**FreqUI asset paths:** Vite CSS preloads use absolute `/assets/` paths. nginx has a fallback `location /assets/` proxying to freqtrade. Vue Router base is `/lumitrade/`.

## API structure (30+ endpoints)

```
/v1/trade/                    — Node.js proxy layer (routes/trade.js)
  /health, /analyze, /risk-check, /execute, /backtest
  /unified/pairs              — merged crypto + stock pair list
  /unified/positions          — combined positions from all brokers
  /unified/history            — merged trade history
  /freqtrade/{status,trades,performance,balance,config,backtest,download-data}
  /ibkr/{status,positions,account,history/:symbol,order}
  /signals, /positions, /history, /pnl  — PocketBase CRUD
  /journal, /journal/analytics          — trading journal + session analytics
  /mood/{analysis,log,logs}             — mood tracking
  /rag/{search,embed}                   — Qdrant RAG
  /reports/{performance,tearsheet}      — QuantStats
  /tv-webhook                           — TradingView alerts
  /ws/market, /ws/signals               — WebSocket feeds

/lumitrader/                  — LumiTrader AI assistant (routes/lumitrader.js)
  /chat                       — POST, auto-injects trading context
  /settings                   — GET/POST user preferences
  /sessions                   — GET/POST chat history
```

## AI tools (15, in tools/trade-tools.js)

market_analysis, check_positions, place_trade, backtest_strategy, news_sentiment, ibkr_account, trading_journal, performance_report, mood_tracker, trading_rag_search, run_backtest, freqai_train, strategy_info, download_data, unified_dashboard

Auto-detection: symbols with `/` route to freqtrade (crypto), others to IBKR (stocks).

## LumiTrader (trading AI assistant)

Independent from LumiChat. Uses same PB project (lumitrade) but separate:
- Token tracking: `_lumitrade` (via `X-App-Source: lumitrade` header)
- Collections: `lt_sessions`, `lt_messages`, `lt_user_settings`
- RAG: `lumitrade_rag` Qdrant collection (256-dim, hash-based pseudo-embeddings)
- System prompt: `trade-engine/lumitrader_prompts.py` (SYSTEM_PROMPT, PRESETS, QUICK_COMMANDS)
- 4 presets: Analyst, Risk Manager, Journal Coach, Strategy Dev

## FreqAI integration

Dockerfile uses `freqtradeorg/freqtrade:stable_freqai`. Config in `freqtrade/config.json` under `freqai` key. SMCStrategy has 4 feature engineering methods using SMC indicators as ML features. LightGBM regressor predicts 12-candle forward returns.

## Risk management (non-negotiable)

Enforced in `trade-engine/risk/manager.py`. Cannot be loosened:
- Max position: 2%, Max daily loss: 3% (circuit breaker), Max positions: 5
- Min R:R: 2:1, News blackout: 30min, Auto-exec limit: 1%

## Key env vars

Trade Engine uses `TRADE_` prefix (pydantic-settings). Critical:
- `TRADE_PB_URL` + `TRADE_PB_ADMIN_EMAIL` + `TRADE_PB_ADMIN_PASSWORD` — PB auth
- `TRADE_FINNHUB_API_KEY` — news/sentiment
- `TRADE_FREQTRADE_PASSWORD` — freqtrade REST API auth (basic auth, NOT JWT)
- `TRADE_IBKR_HOST` / `TRADE_IBKR_PORT` — IB Gateway connection
- `IBKR_USERNAME` / `IBKR_PASSWORD` — IB Gateway login (HK region, jts.ini mounted)

## Known issues and gotchas

- **PB sort param**: PB 0.23+ rejects `sort: "-created"` — causes 400. Omit sort params.
- **PB schema key**: Use `fields` not `schema` in collection definitions.
- **PB project isolation**: Collections MUST be in lumitrade PB project. Create project in `pocketbase/pb_data/projects.json` BEFORE creating collections.
- **FreqUI asset cache**: Browser aggressively caches old JS/CSS. nginx sends `Cache-Control: no-store` on `/lumitrade/` HTML.
- **Vite build output**: Always `rm -rf` old assets before `cp -r dist/*`. Stale files with old hashes accumulate otherwise.
- **Freqtrade auth**: Use HTTP Basic Auth, NOT JWT token login. FreqtradeConnector uses `auth=(username, password)`.
- **OKX WebSocket**: Blocked by GFW. Config has `enable_ws: false`, uses REST polling.
- **IB Gateway region**: Must use `Region=hk` in jts.ini for HK accounts. Without it, login fails silently.
- **Docker PB pull**: `pocketbase/pocketbase:latest` not on Docker Hub. Use `--no-deps` when starting trade containers.
- **Trade engine PB access**: Uses `host.docker.internal:8090` (cross-network), needs `extra_hosts` in compose.

## Parent project files modified

- `server.js` — trade tools registration, lumitrader route mounting, `/lumitrade/auto-auth`
- `routes/trade.js` — 30+ proxy routes with PB project scoping
- `routes/lumitrader.js` — LumiTrader AI chat backend
- `tools/trade-tools.js` — 15 AI tools
- `services/pb-schema.js` — 11 trade collections (use `fields` key)
- `nginx/nginx.conf` — `/lumitrade/`, `/assets/`, `/lumitrade/bt/api/`, WebSocket proxy
- `docker-compose.yml` — 5 containers under `--profile trade`
- `public/lumichat.html` — `X-App-Source` header support, `frame-ancestors 'self'`
