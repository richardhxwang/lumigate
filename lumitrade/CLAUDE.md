# LumiTrade — Dev Guide

## What this is

LumiTrade is a sub-module of LumiGate — an AI-assisted SMC/ICT trading platform. Connects to IBKR (via ib_insync + IB Gateway) and OKX (via freqtrade), runs Smart Money Concepts strategy analysis, integrates news/sentiment (FinBERT + Finnhub), and sends alerts via Telegram. Scope: semi-automatic trading (signals + small-position auto-execution with human override).

**Status**: Phase 1 built. Trade Engine, freqtrade, FinBERT, IB Gateway containers all defined and deployable. IBKR credentials not yet configured (paper trading ready). Freqtrade running OKX dry-run.

## File structure

```
lumitrade/
  CLAUDE.md                    # this file
  PLAN.md                      # full architecture spec + implementation roadmap
  .env.example                 # env var template for standalone NAS deployment
  docker-compose.yml           # standalone compose (NAS deployment, 3 services)
  trade-engine/                # Python FastAPI service (:3200)
    main.py                    # FastAPI app — all endpoints, WebSocket manager, lifespan
    config.py                  # pydantic-settings, env vars prefixed TRADE_
    requirements.txt           # smartmoneyconcepts, ib_insync, httpx, etc.
    Dockerfile
    pb_collections.py          # 6 PB collection schemas + auto-provisioning
    strategies/
      smc_strategy.py          # SMCAnalyzer — wraps smart-money-concepts library
      backtester.py            # vectorbt-based SMC backtest runner
    risk/
      manager.py               # RiskManager — position size, daily loss, R:R checks
    news/
      sentiment.py             # Finnhub + FinBERT + LLM sentiment pipeline
    connectors/
      ibkr.py                  # IBKRConnector — async ib_insync wrapper (connect, positions, orders, history)
      freqtrade.py             # FreqtradeConnector — REST API client (JWT auth, status, trades, balance)
    notifications/
      telegram.py              # TelegramNotifier — signal/trade/risk alerts via Telegram bot
    analytics/
      sessions.py              # SessionAnalyzer — ICT killzone/session/day-of-week P&L breakdown
  freqtrade/                   # Crypto trading bot
    config.json                # dry_run mode, OKX exchange, 4 pairs, API server on :8080
    Dockerfile                 # extends freqtradeorg/freqtrade:stable + smartmoneyconcepts
    docker-compose.freqtrade.yml  # standalone compose for NAS deployment
    user_data/
      strategies/
        SMCStrategy.py         # freqtrade Strategy class — 3-tier entry (BOS+OB+FVG, BOS+FVG, FVG+liq sweep)
      logs/freqtrade.log
      tradesv3.sqlite          # freqtrade trade database
  finbert/
    server.py                  # Flask sentiment scoring endpoint (:5000)
    Dockerfile

../docker-compose.yml          # parent compose — trade profile adds 4 containers (trade-engine, freqtrade, finbert, ib-gateway)
../routes/trade.js             # Node.js glue layer — proxies to trade-engine, PB data access, WebSocket proxy, TV webhook
../tools/trade-tools.js        # 7 AI tools registered in UnifiedRegistry
../public/lumitrade.html       # Trading UI — FreqUI iframe + LumiChat floating window + splash animation
../services/pb-schema.js       # modified — includes trade collection schemas
../nginx/nginx.conf            # modified — trade route proxying
```

## How to start

**With LumiGate (recommended):**
```bash
docker compose --profile trade up -d --build
```
This starts 4 containers alongside existing LumiGate services:
- `lumigate-trade-engine` (:3200, exposed at 127.0.0.1:18793)
- `lumigate-freqtrade` (:8080, FreqUI at 127.0.0.1:18790)
- `lumigate-finbert` (:5000)
- `lumigate-ibgateway` (:4001 live, :4002 paper, :5900 VNC)

**Standalone freqtrade (NAS deployment):**
```bash
cd lumitrade/freqtrade && docker compose -f docker-compose.freqtrade.yml up -d
```

**Standalone all (NAS deployment):**
```bash
cd lumitrade && cp .env.example .env  # fill in credentials
docker compose up -d --build
```

## Containers and ports

| Container | Port | Description |
|-----------|------|-------------|
| `lumigate-trade-engine` | 3200 (internal), 18793 (host) | FastAPI — SMC analysis, risk mgmt, broker routing |
| `lumigate-freqtrade` | 8080 (internal), 18790 (host) | Freqtrade bot + FreqUI |
| `lumigate-finbert` | 5000 | FinBERT sentiment analysis |
| `lumigate-ibgateway` | 4001 (live), 4002 (paper), 5900 (VNC) | IB Gateway — IBKR paper trading (not yet configured with credentials) |

## API endpoints

All under `/v1/trade/` prefix (Node.js `routes/trade.js` proxying to trade-engine):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/trade/health` | Health check (trade-engine status) |
| POST | `/v1/trade/analyze` | SMC analysis on symbol across timeframes |
| POST | `/v1/trade/risk-check` | Validate trade against risk rules |
| POST | `/v1/trade/execute` | Execute trade (auto or manual confirm) |
| POST | `/v1/trade/backtest` | Run SMC backtest via vectorbt |
| GET | `/v1/trade/market/:symbol` | Market data for symbol |
| GET | `/v1/trade/freqtrade/status` | Freqtrade connection + open trades + profit |
| GET | `/v1/trade/freqtrade/trades` | Freqtrade completed trade history |
| GET | `/v1/trade/freqtrade/performance` | Freqtrade per-pair performance |
| GET | `/v1/trade/freqtrade/balance` | Freqtrade exchange balance |
| GET | `/v1/trade/ibkr/status` | IBKR connection status |
| GET | `/v1/trade/ibkr/positions` | IBKR open positions |
| GET | `/v1/trade/ibkr/account` | IBKR account summary (balance, P&L, buying power) |
| GET | `/v1/trade/ibkr/history/:symbol` | IBKR historical OHLCV bars |
| POST | `/v1/trade/ibkr/order` | Place IBKR order (mandatory risk check) |
| GET | `/v1/trade/signals` | List signals from PB |
| GET | `/v1/trade/positions` | List positions from PB |
| GET | `/v1/trade/history` | Trade history from PB |
| GET | `/v1/trade/pnl` | P&L summary from PB |
| GET | `/v1/trade/journal` | List journal entries from PB |
| POST | `/v1/trade/journal` | Create/update journal entry |
| GET | `/v1/trade/journal/analytics` | Session/killzone analytics (via trade-engine) |
| POST | `/v1/trade/tv-webhook` | TradingView webhook receiver |
| WS | `/v1/trade/ws/market` | Real-time market data feed (price_update, signal, position_update) |
| WS | `/v1/trade/ws/signals` | Real-time SMC signal feed |

## AI tools (7, registered in UnifiedRegistry)

Defined in `tools/trade-tools.js`, callable from LumiChat:

1. **market_analysis** — SMC analysis on a symbol (OB, FVG, BOS, CHoCH, signals)
2. **check_positions** — List current open positions across brokers
3. **place_trade** — Execute trade with mandatory risk check (>1% requires confirmation)
4. **backtest_strategy** — Run SMC backtest on historical data
5. **news_sentiment** — Get news sentiment score for a symbol (Finnhub + FinBERT)
6. **ibkr_account** — Get IBKR account status, positions, portfolio summary
7. **trading_journal** — Session/killzone analytics, daily recap, mood logging

## PocketBase collections (6)

Defined in `trade-engine/pb_collections.py`, auto-provisioned on startup. Plus `trade_journal` accessed via `routes/trade.js`.

- `trade_signals` — SMC signals (symbol, direction, entry/SL/TP, confidence, source, status)
- `trade_positions` — Open/closed positions (broker, quantity, unrealized/realized P&L)
- `trade_history` — Completed trades (entry/exit prices, P&L, duration, strategy)
- `trade_pnl` — Daily P&L snapshots (cumulative, win rate, drawdown)
- `trade_news` — News articles with multi-layer sentiment (Finnhub + FinBERT + LLM)
- `trade_strategies` — Strategy configs and backtest results
- `trade_journal` — Trading journal entries (mood, notes) [accessed via routes/trade.js]

## Telegram notifications

Bot: LumigateAlertBot. Sends HTML-formatted alerts for:
- New SMC signals (direction, entry, SL/TP, R:R, confidence)
- Trade executions (symbol, action, quantity, broker, status)
- Risk alerts (rule violated, detail)

Configured via `TRADE_TELEGRAM_BOT_TOKEN` and `TRADE_TELEGRAM_CHAT_ID`.

## Freqtrade config

- **dry_run: true** — no real trading, simulated with $10,000 wallet
- OKX configured for **data fetching only** (OHLCV), not live execution
- 4 pairs: BTC/USDT, ETH/USDT, SOL/USDT, BNB/USDT
- Timeframe: 15m (with 1h and 4h informative pairs)
- API server enabled on :8080 (FreqUI + REST, JWT auth)
- Strategy: `SMCStrategy` — 3-tier entry system:
  - Tier 1 (strict): BOS/CHoCH + Order Block + FVG confluence
  - Tier 2 (moderate): BOS/CHoCH + FVG
  - Tier 3 (reversal): FVG + liquidity sweep
- Exit: bearish CHoCH (change of character)
- Custom stoploss: dynamic swing-low based SL
- Trailing stop: 1% positive, 2% offset

## IBKR connector

`trade-engine/connectors/ibkr.py` — async wrapper around `ib_insync`:
- Connection management (connect/disconnect/status)
- Account summary (NetLiquidation, BuyingPower, UnrealizedPnL, etc.)
- Position listing
- Historical OHLCV bars (configurable duration, bar size, security type)
- Order placement (MKT/LMT/STP) with pre-order risk check
- Supports STK and CASH/Forex contracts
- IB Gateway container: `ghcr.io/gnzsnz/ib-gateway:stable`, paper mode default, VNC on :5900

## Session analytics (ICT killzones)

`trade-engine/analytics/sessions.py` — analyzes trades by:
- **Sessions**: Asian (00-08 UTC), London (07-16 UTC), New York (12-21 UTC), Off-hours
- **Killzones**: Asian, London KZ (07-10), NY AM KZ (12-15), NY PM KZ (15-17), London-NY overlap (12-16)
- **Breakdowns**: hourly P&L heatmap, day-of-week performance, best/worst trade
- **Auto-insights**: identifies best session, best killzone, best/worst day, win rate warnings

## WebSocket

Trade-engine provides two WS endpoints via `ConnectionManager`:
- `/ws/market` — subscribes to symbols, pushes `price_update` every 3s (placeholder data for now)
- `/ws/signals` — pushes new SMC signals as generated (placeholder every 10s for testing)

Node.js `routes/trade.js` proxies WS upgrade requests from `/v1/trade/ws/*` to trade-engine.

## Risk management (non-negotiable defaults)

- Max position size: 2% of portfolio
- Max daily loss: 3% (circuit breaker)
- Max open positions: 5
- Min risk:reward ratio: 2:1
- News blackout: 30 min before major events
- Auto-execution limit: 1% (larger positions require manual confirmation)

## Frontend: lumitrade.html

Located at `public/lumitrade.html`:
- FreqUI iframe (full-width, full-height)
- LumiChat floating window (bottom-right, collapsible)
- Splash animation on load
- Light/dark theme (persisted in `lt_theme` localStorage)
- Follows LumiGate UI style (frosted glass, macOS HIG)

## Key env vars

Trade Engine (prefix `TRADE_`):
- `TRADE_PB_URL` — PocketBase URL (default: `http://pocketbase:8090`)
- `TRADE_FINNHUB_API_KEY` — Finnhub API for news/sentiment/calendar
- `TRADE_TELEGRAM_BOT_TOKEN` / `TRADE_TELEGRAM_CHAT_ID` — alert notifications
- `TRADE_LUMIGATE_URL` / `TRADE_LUMIGATE_PROJECT_KEY` — LumiGate AI access for deep sentiment
- `TRADE_FREQTRADE_URL` / `TRADE_FREQTRADE_USERNAME` / `TRADE_FREQTRADE_PASSWORD` — freqtrade REST API
- `TRADE_IBKR_HOST` / `TRADE_IBKR_PORT` / `TRADE_IBKR_CLIENT_ID` — IBKR connection

IBKR (IB Gateway container):
- `IBKR_USERNAME` / `IBKR_PASSWORD` — IBKR credentials
- `IBKR_TRADING_MODE` — `paper` or `live` (default: paper)
- `IBKR_READ_ONLY` — `yes` or `no` (default: yes)
- `IBKR_VNC_PASSWORD` — VNC password for IB Gateway UI

OKX (via Freqtrade env override):
- `OKX_API_KEY` / `OKX_API_SECRET` / `OKX_PASSPHRASE` — OKX credentials

## Key constraints

- All trading tools must register in LumiGate's UnifiedRegistry (AI-callable from chat)
- Parent project rules apply: see `../CLAUDE.md` for LumiGate conventions (atomic writes, port 9471, no secret logging, etc.)
- Trade Engine runs on port 3200 internally, accessed via Node.js proxy at `/v1/trade/*`
- Risk management defaults are non-negotiable minimums (can tighten but not loosen)
- PocketBase data access in `routes/trade.js` uses project-scoped paths (`/api/p/lumitrade/collections/...`) with fallback to unscoped

## Parent project modifications

Files modified/added in `ai-api-proxy/` for LumiTrade integration:
- `docker-compose.yml` — added 4 containers under `--profile trade`
- `routes/trade.js` — Node.js glue layer (new file)
- `tools/trade-tools.js` — 7 AI tools (new file)
- `public/lumitrade.html` — trading UI (new file)
- `services/pb-schema.js` — trade collection schemas
- `nginx/nginx.conf` — trade route proxying
- `server.js` — `TRADE_ENGINE_URL` env var, route mounting
