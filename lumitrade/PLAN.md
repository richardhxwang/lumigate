# LumiTrade — AI-Powered Trading Platform

## Overview

LumiTrade is a sub-module of LumiGate that provides AI-assisted trading capabilities. It connects to multiple brokers/exchanges, collects market data, executes SMC/ICT-based trading strategies, and integrates news/sentiment analysis.

**Scope**: Semi-automatic (signals + small-position auto-execution with human override)
**Frontend**: Dual — LumiChat chat-based interaction + standalone professional trading UI
**Backend**: Runs inside LumiGate Docker, shares the same AI/tool infrastructure

---

## Broker/Exchange Connections

| Platform | Type | Library | Stars | Status |
|----------|------|---------|-------|--------|
| **IBKR** | Stocks/Futures/Options | [ib_insync](https://github.com/erdewit/ib_insync) (4.4k★) | Mature, actively maintained | Python, async |
| **OKX** | Crypto | [CCXT](https://github.com/ccxt/ccxt) (41.4k★) | 110+ exchanges, very active | Python/JS/PHP |
| **MetaTrader 5** | Forex | Official `MetaTrader5` package | Official | Windows only (needs Wine/Docker on Mac) |
| **TradingView** | Signals | Webhook receiver | N/A | Incoming POST webhooks |

### MT5 on Mac Solutions
- **Option A**: Docker container with Wine + MT5 (heaviest but most reliable)
- **Option B**: Run MT5 on a Windows VPS, connect via ZeroMQ bridge
- **Option C**: Use MT5 Web Terminal API (limited functionality)

---

## Trading Strategy: SMC/ICT

### Core Library
**[smart-money-concepts](https://github.com/joshyattridge/smart-money-concepts)** — 1.1k★, Python

Provides:
- Order Blocks (OB) detection
- Fair Value Gaps (FVG)
- Break of Structure (BOS)
- Change of Character (CHoCH)
- Swing Highs/Lows
- Liquidity sweeps
- Premium/Discount zones

Issues: ~10 open issues (2025), some about OB detection accuracy. Active discussions. Usable but may need customization.

### Strategy Logic
```
1. Identify market structure (trending/ranging) via BOS/CHoCH
2. Wait for liquidity sweep (stop hunt)
3. Identify Order Block in premium/discount zone
4. Wait for FVG confirmation
5. Entry at OB + FVG overlap
6. SL below/above swing point
7. TP at opposing liquidity pool
```

### Alternative/Supplementary Libraries
| Library | Stars | Description |
|---------|-------|-------------|
| [SMC-Algo-Trading](https://github.com/vlex05/SMC-Algo-Trading) | ~200 | SMC bot framework, under development |
| [smc_quant](https://github.com/starckyang/smc_quant) | ~100 | SMC for ETH market |
| [TA-Lib](https://github.com/TA-Lib/ta-lib-python) | 10k+ | Traditional technical indicators (supplement SMC) |

---

## News & Sentiment Collection

### Data Sources

| Source | Method | Library/API |
|--------|--------|-------------|
| **Financial news** | RSS + API | [Marketaux API](https://www.marketaux.com/), [NewsAPI](https://newsapi.org/) |
| **TradingView** | Premium alerts + webhooks | Already have Premium subscription |
| **Social media (Twitter/X)** | API or scraping | [snscrape](https://github.com/JustAnotherArchiworker/snscrape) or X API |
| **Reddit** | API | [PRAW](https://github.com/praw-dev/praw) (9k★) |
| **SearXNG** | Already deployed | Existing LumiGate service |
| **HKEX announcements** | Chrome CDP | Already built (`tools/hkex-downloader.js`) |

### Sentiment Analysis
| Tool | Stars | Description |
|------|-------|-------------|
| **[FinBERT](https://github.com/ProsusAI/finBERT)** | 3k+ | BERT fine-tuned for financial sentiment |
| **VADER** | Built into NLTK | Rule-based, good for social media |
| **LumiGate AI** | N/A | Use existing LLM (DeepSeek/GPT) for sentiment analysis via /v1/chat |

### Approach
Use LumiGate's existing AI infrastructure: feed news/tweets to LLM → structured sentiment output → store in Qdrant for retrieval → feed into trading decisions.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    LumiGate Docker                        │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  LumiChat    │  │  LumiTrade   │  │  LumiTrade    │  │
│  │  (chat UI)   │  │  (pro UI)    │  │  Engine       │  │
│  │  /lumichat   │  │  /lumitrade  │  │  (Python)     │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────┘  │
│         │                  │                  │           │
│  ┌──────┴──────────────────┴──────────────────┴────────┐ │
│  │              LumiGate Server (Node.js)               │ │
│  │                                                      │ │
│  │  routes/trade.js  — Trading API endpoints            │ │
│  │  tools/trade-tools.js — AI-callable trading tools    │ │
│  │  services/trade/  — Strategy engine + connectors     │ │
│  └──────┬────────────────┬────────────────┬────────────┘ │
│         │                │                │               │
│  ┌──────┴──┐  ┌──────────┴─────┐  ┌──────┴────────────┐ │
│  │ Qdrant  │  │  PocketBase    │  │  External APIs     │ │
│  │(signals │  │(trade history, │  │  IBKR / OKX / MT5  │ │
│  │ memory) │  │ positions, P&L)│  │  TradingView WH    │ │
│  └─────────┘  └────────────────┘  └────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Key Components

#### 1. `services/trade/engine.py` — Strategy Engine (Python)
- Uses `smart-money-concepts` for SMC indicators
- Connects to IBKR via `ib_insync`, OKX via `ccxt`
- Runs on a schedule (1m/5m/15m/1h candle intervals)
- Outputs signals to Node.js via HTTP or stdin/stdout

#### 2. `services/trade/connectors/`
- `ibkr.py` — IBKR TWS API connection (ib_insync)
- `okx.py` — OKX via CCXT
- `mt5.py` — MT5 via ZeroMQ bridge or native package
- `tv_webhook.py` — TradingView webhook receiver

#### 3. `services/trade/news.py` — News & Sentiment Collector
- Scheduled fetching from multiple sources
- LLM-based sentiment analysis via LumiGate API
- Store in Qdrant for RAG retrieval during trading decisions

#### 4. `routes/trade.js` — Trading API
```
POST /v1/trade/signal      — Submit manual signal
GET  /v1/trade/signals      — List recent signals
GET  /v1/trade/positions    — Current positions
POST /v1/trade/execute      — Execute a trade
GET  /v1/trade/history      — Trade history
GET  /v1/trade/pnl          — P&L report
POST /v1/trade/backtest     — Run strategy backtest
GET  /v1/trade/market/:symbol — Real-time market data
POST /v1/trade/tv-webhook   — TradingView alert webhook
```

#### 5. `tools/trade-tools.js` — AI-Callable Trading Tools
Registered in UnifiedRegistry so AI can call them from chat:
- `market_analysis` — Analyze a symbol with SMC indicators
- `place_order` — Place a trade (with confirmation)
- `check_positions` — List current positions
- `backtest_strategy` — Run backtest on historical data
- `news_sentiment` — Get sentiment for a symbol

#### 6. Frontend

**LumiChat integration**: Trading tab/panel in LumiChat for chat-based interaction
- "Analyze AAPL using SMC" → AI runs analysis → shows chart + signals
- "What's the sentiment on BTC?" → News collection → summary

**Standalone `lumitrade.html`**: Professional trading interface
- K-line chart: [TradingView Lightweight Charts](https://github.com/nicehash/lightweight-charts) (9k★)
- Order book / positions panel
- Signal history with SMC annotations (OB, FVG, BOS marked on chart)
- P&L dashboard
- News feed with sentiment scores

### PB Collections
```
trade_signals    — Signal records (symbol, direction, entry, sl, tp, status)
trade_positions  — Open/closed positions
trade_history    — Execution log
trade_pnl        — Daily/weekly P&L snapshots
trade_news       — Collected news with sentiment scores
trade_strategies — Saved strategy configurations
```

---

## Implementation Phases

### Phase 1: Data Collection + Signals (No Execution)
- [ ] IBKR market data connection (ib_insync)
- [ ] OKX market data connection (CCXT)
- [ ] SMC indicator calculation (smart-money-concepts)
- [ ] Signal generation (no auto-execution)
- [ ] Telegram signal alerts
- [ ] TradingView webhook receiver
- [ ] News collection (SearXNG + RSS)
- [ ] PB collections for signals/news

### Phase 2: Backtesting + UI
- [ ] Historical data storage
- [ ] Backtest engine (vectorbt or custom)
- [ ] lumitrade.html with K-line chart
- [ ] Signal visualization on chart
- [ ] Performance metrics dashboard

### Phase 3: Semi-Auto Execution
- [ ] Order execution via IBKR/OKX
- [ ] Position management (SL/TP)
- [ ] Risk management (max position size, daily loss limit)
- [ ] Circuit breaker (auto-stop on X% daily loss)
- [ ] Human approval mode (signal → notification → confirm → execute)

### Phase 4: MT5 + Advanced
- [ ] MT5 integration (Wine/Docker or bridge)
- [ ] Multi-timeframe analysis
- [ ] Correlation analysis across markets
- [ ] AI-enhanced entry/exit timing
- [ ] Portfolio-level risk management

---

## Risk Management (Built-in, Non-negotiable)

| Rule | Default | Configurable |
|------|---------|-------------|
| Max position size | 2% of portfolio | Yes |
| Max daily loss | 3% | Yes |
| Max open positions | 5 | Yes |
| Circuit breaker | Stop all trading after 3% daily loss | Yes |
| Slippage guard | Cancel if slippage > 0.5% | Yes |
| News blackout | No new positions 30min before major events | Yes |

---

## Dependencies Summary

All existing/open-source — zero wheels to reinvent:

| Component | Library | Purpose |
|-----------|---------|---------|
| SMC indicators | smart-money-concepts | Order blocks, FVG, BOS, CHoCH |
| IBKR connection | ib_insync | Stock/futures/options trading |
| Crypto exchanges | CCXT | OKX + 100 other exchanges |
| MT5 | MetaTrader5 / ZeroMQ bridge | Forex |
| K-line chart | TradingView Lightweight Charts | Frontend charting |
| Sentiment | FinBERT + LumiGate LLM | News analysis |
| Backtesting | vectorbt (7k★) or backtrader | Strategy validation |
| News | SearXNG + NewsAPI + PRAW | Data collection |
| Storage | PocketBase + Qdrant | Existing infrastructure |
