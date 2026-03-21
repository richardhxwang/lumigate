# LumiTrade

**AI-powered SMC/ICT trading platform** — LumiGate sub-module. Crypto via freqtrade (OKX), stocks via IBKR. AI-driven analysis, risk management, and trade execution.

[![Strategy](https://img.shields.io/badge/strategy-SMC%2FICT-blue)](#)
[![FreqAI](https://img.shields.io/badge/ML-LightGBM-green)](#)
[![Backtest](https://img.shields.io/badge/backtest-166%25%20(2yr)-brightgreen)](#)
[![Telegram](https://img.shields.io/badge/telegram-bot-blue)](#)

---

## What it does

- **SMC Strategy** (SMCStrategy.py) — BOS/CHoCH for structure, OB+FVG for entries, liquidity sweeps for confirmation
- **FreqAI / LumiLearning** — LightGBM ML model (107 features) filters SMC signals, predicts 12-candle forward returns
- **LumiTrader AI** — Opus 4.6-powered trading assistant (scored 4.83/5 on 46-test evaluation)
- **Trade Sentinel** — AI scans market every 15 minutes, pushes alerts via Telegram
- **Telegram Bot** — full trading terminal: `/ai`, `/analysis`, `/status`, `/signals`, `/risk`, `/news`, `/model`
- **Risk Engine** — max 2% position, 3% daily circuit breaker, R:R >= 2:1, news blackout

## Architecture

```
User ──→ Telegram Bot ──→ LumiGate (Node.js) ──→ Trade Engine (FastAPI)
         FreqUI (Vue)                              ├── SMC Analyzer
         LumiChat                                  ├── Risk Manager
                                                   ├── Freqtrade Connector
                                                   ├── IBKR Connector
                                                   ├── News Pipeline (Finnhub → FinBERT → LLM)
                                                   └── Trading RAG (Qdrant)
```

## Containers

| Container | Port | Purpose |
|-----------|------|---------|
| lumigate | 9471 | Node.js — API proxy, LumiTrader chat, Telegram webhook |
| trade-engine | 3200 | FastAPI — SMC analysis, risk, connectors, news |
| freqtrade | 18790 | Crypto trading (dry run / live) |
| freqtrade-pure | 18791 | Pure SMC bot (no FreqAI) |
| freqtrade-bt | 18795 | Backtest webserver |
| finbert | 18796 | FinBERT sentiment scoring |
| ibgateway | 4002 | IB Gateway (paper / live) |

## Quick start

```bash
# Start everything (with LumiGate)
docker compose --profile trade up -d --build

# Rebuild FreqUI after changes
cd lumitrade/frequi-src && pnpm build
rm -rf ../frequi-custom/installed/assets ../frequi-custom/installed/index.html
cp -r dist/* ../frequi-custom/installed/
docker compose --profile trade up -d --no-deps --force-recreate freqtrade
```

## Backtest results

| Mode | Period | Trades | Profit | WR% | Sharpe | DD | PF |
|------|--------|--------|--------|-----|--------|-----|-----|
| Futures 2yr | 2024-03 ~ 2026-03 | 1,869 | +$16,673 (+167%) | 55.0% | 11.18 | -$1,439 | 2.03 |
| Futures 6mo | 2025-09 ~ 2026-03 | 1,122 | +$10,636 (+106%) | 56.1% | 37.74 | -$553 | — |
| Spot 6mo | 2025-09 ~ 2026-03 | 563 | +$1,224 (+12.2%) | 47.4% | 5.49 | -$695 | 1.35 |

## LumiTrader AI test score

| Category | Score | Average |
|----------|-------|---------|
| Data Accuracy | 36/40 | 4.5/5 |
| SMC/ICT Concepts | 40/40 | 5.0/5 |
| Strategy Analysis | 40/40 | 5.0/5 |
| Risk Compliance | 29/30 | 4.83/5 |
| Live Signals | 49/50 | 4.90/5 |
| News + Comprehensive | 28/30 | 4.67/5 |
| **Total** | **222/230** | **4.83/5** |

## Telegram commands

| Command | Description |
|---------|-------------|
| `/ai [question]` | AI analysis (free-form text also works) |
| `/analysis` | Scan all pairs for trading opportunities |
| `/status` | Current positions |
| `/signals` | Active SMC signals |
| `/risk` | Risk status check |
| `/news` | Latest news + sentiment |
| `/profit` | P&L stats |
| `/balance` | Account balance |
| `/model [name]` | Switch AI model (opus/sonnet/haiku/gpt4o) |
| `/journal` | Daily trading summary |
| `/optimize` | Strategy optimization suggestions |

## Key files

| File | Purpose |
|------|---------|
| `routes/lumitrader.js` | LumiTrader AI chat, Telegram bot, Trade Sentinel |
| `routes/trade.js` | API proxy, PB sync, news fetch, backtest sync |
| `tools/trade-tools.js` | 15 AI tools (market_analysis, place_trade, etc.) |
| `trade-engine/main.py` | FastAPI — 31 endpoints |
| `trade-engine/news/sentiment.py` | Finnhub + FinBERT + LLM pipeline |
| `trade-engine/risk/manager.py` | Non-negotiable risk rules |
| `trade-engine/lumitrader_prompts.py` | System prompt + ICT/SMC knowledge |
| `freqtrade/user_data/strategies/SMCStrategy.py` | Trading strategy |
| `freqtrade/config.json` | Bot config (exchange, pairs, FreqAI) |
| `frequi-src/` | FreqUI Vue source (LumiTrade skin) |
| `DATA-ARCHITECTURE.md` | Complete 5-layer data architecture reference |

## Data storage

- **PocketBase** — 13 collections (trade_signals, trade_history, trade_backtest_results, lt_sessions, lt_notifications, etc.)
- **freqtrade SQLite** — trades, orders, pair locks, custom data
- **Qdrant** — trading RAG (lumitrade_rag collection, 256-dim)
- **Filesystem** — FreqAI models, OHLCV data, backtest results
