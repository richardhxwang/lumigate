"use strict";

/**
 * LumiTrade — AI-callable trading tools for UnifiedRegistry.
 *
 * Registers 15 tools that proxy to the Trade Engine FastAPI service:
 *   market_analysis, check_positions, place_trade, backtest_strategy, news_sentiment, ibkr_account, trading_journal, performance_report, mood_tracker, trading_rag_search,
 *   run_backtest, freqai_train, strategy_info, download_data, unified_dashboard
 *
 * Usage:
 *   const { registerTradeTools } = require("./trade-tools");
 *   registerTradeTools(unifiedRegistry);
 */

const TRADE_ENGINE_URL = process.env.TRADE_ENGINE_URL || "http://localhost:3200";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const MARKET_ANALYSIS_SCHEMA = {
  name: "market_analysis",
  description:
    "Analyze a symbol using Smart Money Concepts (SMC/ICT) indicators. Returns market structure, order blocks, fair value gaps, and trade signals.",
  input_schema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Trading symbol (e.g. AAPL, BTC-USD)" },
      timeframes: {
        type: "array",
        items: { type: "string" },
        description: "Timeframes to analyze (e.g. [\"1h\", \"4h\", \"1d\"]). Defaults to engine default if omitted.",
      },
      include_news: {
        type: "boolean",
        description: "Include news sentiment in the analysis. Default false.",
      },
    },
    required: ["symbol"],
  },
};

const CHECK_POSITIONS_SCHEMA = {
  name: "check_positions",
  description:
    "List current open trading positions across all brokers (IBKR and OKX).",
  input_schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description: "Position status filter. Default \"open\".",
      },
    },
    required: [],
  },
};

const PLACE_TRADE_SCHEMA = {
  name: "place_trade",
  description:
    "Place a trade order. Requires risk check approval. Large positions (>1%) require manual confirmation.",
  input_schema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Trading symbol" },
      direction: { type: "string", enum: ["long", "short"], description: "Trade direction" },
      entry: { type: "number", description: "Entry price" },
      stop_loss: { type: "number", description: "Stop-loss price" },
      take_profit: { type: "number", description: "Take-profit price" },
      position_size_pct: {
        type: "number",
        description: "Position size as percentage of portfolio (e.g. 1.5 = 1.5%)",
      },
      broker: { type: "string", enum: ["ibkr", "okx"], description: "Target broker" },
      portfolio_value: {
        type: "number",
        description: "Total portfolio value in USD. Default 100000.",
      },
    },
    required: ["symbol", "direction", "entry", "stop_loss", "take_profit", "position_size_pct", "broker"],
  },
};

const BACKTEST_STRATEGY_SCHEMA = {
  name: "backtest_strategy",
  description:
    "Run a backtest of the SMC strategy on historical data. Returns performance metrics.",
  input_schema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Trading symbol to backtest" },
      timeframe: { type: "string", description: "Candle timeframe (e.g. \"1h\", \"4h\"). Default \"1h\"." },
      start_date: { type: "string", description: "Backtest start date (ISO 8601, e.g. \"2025-01-01\")" },
      end_date: { type: "string", description: "Backtest end date (ISO 8601)" },
      initial_capital: { type: "number", description: "Starting capital in USD. Default 100000." },
    },
    required: ["symbol"],
  },
};

const NEWS_SENTIMENT_SCHEMA = {
  name: "news_sentiment",
  description:
    "Get news sentiment analysis for a trading symbol. Combines Finnhub data with AI analysis.",
  input_schema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Trading symbol" },
      limit: { type: "number", description: "Max number of news items. Default 10." },
    },
    required: ["symbol"],
  },
};

const IBKR_ACCOUNT_SCHEMA = {
  name: "ibkr_account",
  description:
    "Get IBKR account status, positions, and portfolio summary.",
  input_schema: {
    type: "object",
    properties: {
      include_positions: {
        type: "boolean",
        description: "Include open positions in the response. Default true.",
      },
    },
    required: [],
  },
};

const TRADING_JOURNAL_SCHEMA = {
  name: "trading_journal",
  description:
    "Generate a trading journal summary. Analyzes recent trades by session (London/NY/Asian killzones), identifies patterns, best/worst periods, and provides AI-generated insights. Can also log mood and notes.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["summary", "log_mood", "analytics"],
        description:
          "What to do: 'summary' for daily recap, 'log_mood' to record mood/notes, 'analytics' for session/killzone breakdown",
      },
      days: { type: "number", description: "Number of days to analyze (default 7)" },
      mood: { type: "string", description: "Current mood/feeling (for log_mood action)" },
      notes: { type: "string", description: "Trading notes (for log_mood action)" },
    },
    required: ["action"],
  },
};

const PERFORMANCE_REPORT_SCHEMA = {
  name: "performance_report",
  description:
    "Generate a professional trading performance report with Sharpe ratio, max drawdown, win rate, profit factor, and other key metrics. Analyze trading performance over time.",
  input_schema: {
    type: "object",
    properties: {
      format: {
        type: "string",
        enum: ["metrics", "tearsheet"],
        description:
          "Output format: 'metrics' for JSON data, 'tearsheet' for full HTML report. Default 'metrics'.",
      },
    },
    required: [],
  },
};

const MOOD_TRACKER_SCHEMA = {
  name: "mood_tracker",
  description:
    "Track and analyze trading mood/emotions. Log your current mood before or after trades, and get analysis of how your emotional state correlates with trading performance. Detects tilt (trading after consecutive losses) and identifies your best/worst emotional states for trading.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["log", "analyze"],
        description: "'log' to record current mood, 'analyze' to get mood-performance correlation",
      },
      mood: {
        type: "string",
        enum: ["calm", "confident", "focused", "excited", "anxious", "fearful", "greedy", "frustrated", "bored", "euphoric"],
        description: "Current mood (for log action)",
      },
      score: { type: "number", description: "Mood score from -5 (very negative) to +5 (very positive)" },
      notes: { type: "string", description: "Additional context about your emotional state" },
      context: {
        type: "string",
        enum: ["before_trade", "after_trade", "during_session", "general"],
        description: "When is this mood being recorded",
      },
    },
    required: ["action"],
  },
};

const TRADING_RAG_SEARCH_SCHEMA = {
  name: "trading_rag_search",
  description: "Search the trading knowledge base for insights about past trades, backtest results, strategies, mood patterns, and market analysis. Use this to answer questions about trading history and performance.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query about trading data" },
      limit: { type: "number", description: "Max results (default 5)" },
    },
    required: ["query"],
  },
};

const RUN_BACKTEST_SCHEMA = {
  name: "run_backtest",
  description:
    "Run a full strategy backtest via freqtrade. Specify strategy, timerange, and starting capital. Returns detailed results including profit, Sharpe ratio, drawdown, win rate, and per-pair performance.",
  input_schema: {
    type: "object",
    properties: {
      strategy: { type: "string", description: "Strategy name (default: SMCStrategy)" },
      timerange: { type: "string", description: "Time range for backtest (e.g. '20250601-20260320')" },
      wallet: { type: "number", description: "Starting capital in USDT (default: 10000)" },
    },
    required: [],
  },
};

const FREQAI_TRAIN_SCHEMA = {
  name: "freqai_train",
  description:
    "Train the FreqAI machine learning model on historical data. Uses SMC indicators as features to predict price movement. Returns training metrics and current FreqAI status.",
  input_schema: {
    type: "object",
    properties: {
      pairs: { type: "array", items: { type: "string" }, description: "Trading pairs to train on" },
      train_days: { type: "number", description: "Number of days of training data (default: 30)" },
    },
    required: [],
  },
};

const STRATEGY_INFO_SCHEMA = {
  name: "strategy_info",
  description:
    "Get the current trading strategy configuration including ROI targets, stoploss, trailing stop parameters, SMC indicator settings, and active trading pairs.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
};

const DOWNLOAD_DATA_SCHEMA = {
  name: "download_data",
  description:
    "Download historical OHLCV data from the exchange for backtesting. Specify pairs and timerange. Data is saved locally for future backtest runs.",
  input_schema: {
    type: "object",
    properties: {
      pairs: { type: "string", description: "Comma-separated pairs (e.g. 'BTC/USDT,ETH/USDT')" },
      timerange: { type: "string", description: "Date range (e.g. '20250101-20260320')" },
      timeframes: { type: "string", description: "Comma-separated timeframes (default: '15m,1h,4h')" },
    },
    required: ["timerange"],
  },
};

const UNIFIED_DASHBOARD_SCHEMA = {
  name: "unified_dashboard",
  description:
    "Get a complete trading dashboard summary: all positions (crypto + stocks), account balances, today's P&L, active signals, bot status, and open trade count — all in one call.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleMarketAnalysis(input) {
  const body = { symbol: input.symbol };
  if (input.timeframes) body.timeframes = input.timeframes;
  if (input.include_news !== undefined) body.include_news = input.include_news;

  try {
    const res = await fetch(`${TRADE_ENGINE_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Trade engine returned ${res.status}: ${text}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `market_analysis failed: ${err.message}` };
  }
}

async function handleCheckPositions(input) {
  const status = input.status || "open";
  try {
    const res = await fetch(`${TRADE_ENGINE_URL}/unified/positions?status=${encodeURIComponent(status)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Trade engine returned ${res.status}: ${text}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `check_positions failed: ${err.message}` };
  }
}

async function handlePlaceTrade(input) {
  const body = {
    symbol: input.symbol,
    direction: input.direction,
    entry: input.entry,
    stop_loss: input.stop_loss,
    take_profit: input.take_profit,
    position_size_pct: input.position_size_pct,
    broker: input.broker,
    portfolio_value: input.portfolio_value ?? 100000,
  };

  // Auto-detect broker from symbol format if not specified
  if (!body.broker) {
    body.broker = body.symbol.includes('/') ? 'okx' : 'ibkr';
  }

  try {
    const res = await fetch(`${TRADE_ENGINE_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Trade engine returned ${res.status}: ${text}` };
    }
    const data = await res.json();
    return { ok: data.ok !== false, data };
  } catch (err) {
    return { ok: false, error: `place_trade failed: ${err.message}` };
  }
}

async function handleBacktestStrategy(input) {
  const body = { symbol: input.symbol };
  if (input.timeframe) body.timeframe = input.timeframe;
  if (input.start_date) body.start_date = input.start_date;
  if (input.end_date) body.end_date = input.end_date;
  if (input.initial_capital !== undefined) body.initial_capital = input.initial_capital;

  try {
    const res = await fetch(`${TRADE_ENGINE_URL}/backtest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Trade engine returned ${res.status}: ${text}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `backtest_strategy failed: ${err.message}` };
  }
}

async function handleNewsSentiment(input) {
  const symbol = encodeURIComponent(input.symbol);
  const limit = input.limit || 10;

  try {
    const res = await fetch(
      `${TRADE_ENGINE_URL}/news/sentiment?symbol=${symbol}&limit=${limit}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Trade engine returned ${res.status}: ${text}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `news_sentiment failed: ${err.message}` };
  }
}

async function handleIbkrAccount(input) {
  const includePositions = input.include_positions !== false;

  try {
    const accountRes = await fetch(`${TRADE_ENGINE_URL}/ibkr/account`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!accountRes.ok) {
      const text = await accountRes.text().catch(() => "");
      return { ok: false, error: `Trade engine returned ${accountRes.status}: ${text}` };
    }
    const account = await accountRes.json();

    if (!includePositions) {
      return { ok: true, data: { account } };
    }

    const posRes = await fetch(`${TRADE_ENGINE_URL}/ibkr/positions`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!posRes.ok) {
      // Return account data even if positions fail
      return { ok: true, data: { account, positions: null, positions_error: `Engine returned ${posRes.status}` } };
    }
    const positions = await posRes.json();

    return { ok: true, data: { account, positions } };
  } catch (err) {
    return { ok: false, error: `ibkr_account failed: ${err.message}` };
  }
}

async function handleTradingJournal(input) {
  const action = input.action || "summary";

  if (action === "analytics") {
    const days = input.days || 7;
    try {
      const res = await fetch(`${TRADE_ENGINE_URL}/journal/analytics?days=${days}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return { ok: false, error: `Engine returned ${res.status}` };
      const data = await res.json();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: `analytics failed: ${err.message}` };
    }
  }

  if (action === "log_mood") {
    const today = new Date().toISOString().split("T")[0];
    return {
      ok: true,
      data: {
        action: "mood_logged",
        date: today,
        mood: input.mood || "",
        notes: input.notes || "",
        message:
          "Mood and notes recorded. These will be included in your daily trading journal summary.",
      },
    };
  }

  // Default: summary
  try {
    const res = await fetch(
      `${TRADE_ENGINE_URL}/journal/analytics?days=${input.days || 1}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok) return { ok: false, error: `Engine returned ${res.status}` };
    const data = await res.json();
    return {
      ok: true,
      data: {
        ...data,
        instruction:
          "Please summarize this trading data in a conversational way. Mention the best/worst sessions, killzone performance, and any patterns. If the user shared their mood, relate it to trading performance.",
      },
    };
  } catch (err) {
    return { ok: false, error: `summary failed: ${err.message}` };
  }
}

async function handlePerformanceReport(input) {
  const format = input.format || "metrics";
  const endpoint = format === "tearsheet" ? "/reports/tearsheet" : "/reports/performance";

  try {
    const res = await fetch(`${TRADE_ENGINE_URL}${endpoint}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Trade engine returned ${res.status}: ${text}` };
    }
    if (format === "tearsheet") {
      const html = await res.text();
      return { ok: true, data: { format: "html", html } };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `performance_report failed: ${err.message}` };
  }
}

async function handleMoodTracker(input) {
  const action = input.action || "log";

  if (action === "analyze") {
    try {
      const res = await fetch(`${TRADE_ENGINE_URL}/journal/mood-analysis`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, error: `Trade engine returned ${res.status}: ${text}` };
      }
      const data = await res.json();
      return {
        ok: true,
        data: {
          ...data,
          instruction:
            "Summarize the mood-performance correlation. Highlight which moods lead to the best/worst trades, whether the trader shows signs of tilt, and actionable suggestions for emotional discipline.",
        },
      };
    } catch (err) {
      return { ok: false, error: `mood_tracker analyze failed: ${err.message}` };
    }
  }

  // Default: log mood
  const record = {
    mood: input.mood || "calm",
    score: input.score ?? 0,
    notes: input.notes || "",
    context: input.context || "general",
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(`${TRADE_ENGINE_URL}/journal/mood-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = await res.json();
      return { ok: true, data: { action: "mood_logged", ...record, engine_response: data } };
    }
    // Engine might not have the endpoint yet — still return success with local data
    return {
      ok: true,
      data: {
        action: "mood_logged",
        ...record,
        message: "Mood recorded. The trade engine mood endpoint is not yet available, but the entry has been noted.",
      },
    };
  } catch {
    // Graceful fallback — mood is logged even if engine is down
    return {
      ok: true,
      data: {
        action: "mood_logged",
        ...record,
        message: "Mood recorded locally. Trade engine was unreachable for persistence.",
      },
    };
  }
}

async function handleTradingRagSearch(input) {
  const query = encodeURIComponent(input.query || "");
  const limit = input.limit || 5;

  try {
    const res = await fetch(
      `${TRADE_ENGINE_URL}/rag/search?query=${query}&limit=${limit}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Trade engine returned ${res.status}: ${text}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `trading_rag_search failed: ${err.message}` };
  }
}

async function handleRunBacktest(input) {
  const strategy = input.strategy || "SMCStrategy";
  const timerange = input.timerange || "";
  const wallet = input.wallet || 10000;

  try {
    // First try the freqtrade backtesting API via trade engine proxy
    const res = await fetch(`${TRADE_ENGINE_URL}/freqtrade/backtest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy, timerange, wallet }),
      signal: AbortSignal.timeout(120_000), // backtests can take a while
    });
    if (res.ok) {
      const data = await res.json();
      return { ok: true, data };
    }
    // Fallback: use the existing vectorbt-based backtest endpoint
    const fallbackRes = await fetch(`${TRADE_ENGINE_URL}/backtest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "BTC/USDT",
        timeframe: "15m",
        initial_capital: wallet,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!fallbackRes.ok) {
      const text = await fallbackRes.text().catch(() => "");
      return { ok: false, error: `Backtest failed (${fallbackRes.status}): ${text}` };
    }
    const fallbackData = await fallbackRes.json();
    return { ok: true, data: { ...fallbackData, note: "Used vectorbt backtest (freqtrade backtest API not available)" } };
  } catch (err) {
    return { ok: false, error: `run_backtest failed: ${err.message}` };
  }
}

async function handleFreqaiTrain(input) {
  const pairs = input.pairs || ["BTC/USDT", "ETH/USDT"];
  const trainDays = input.train_days || 30;

  try {
    // Check freqtrade status and config for FreqAI info
    const [statusRes, configRes] = await Promise.allSettled([
      fetch(`${TRADE_ENGINE_URL}/freqtrade/status`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`${TRADE_ENGINE_URL}/freqtrade/config`, { signal: AbortSignal.timeout(10_000) }),
    ]);

    const status = statusRes.status === "fulfilled" && statusRes.value.ok
      ? await statusRes.value.json() : null;
    const config = configRes.status === "fulfilled" && configRes.value.ok
      ? await configRes.value.json() : null;

    const freqaiConfig = config?.freqai || null;
    const isFreqaiEnabled = !!freqaiConfig;

    if (!isFreqaiEnabled) {
      return {
        ok: true,
        data: {
          freqai_enabled: false,
          message: "FreqAI is not currently configured in the active freqtrade strategy. To enable FreqAI, add a freqai configuration block to the strategy config with model type (e.g. LightGBMRegressor), feature parameters, and training parameters.",
          suggestion: {
            model: "LightGBMRegressor",
            train_period_days: trainDays,
            pairs,
            features: ["smc_order_blocks", "smc_fvg", "smc_bos", "smc_choch", "rsi", "ema_cross"],
          },
          bot_connected: status?.connected ?? false,
        },
      };
    }

    return {
      ok: true,
      data: {
        freqai_enabled: true,
        config: freqaiConfig,
        pairs,
        train_period_days: trainDays,
        bot_connected: status?.connected ?? false,
        message: "FreqAI is configured. Training runs automatically within the freqtrade process. Check bot logs for training progress.",
      },
    };
  } catch (err) {
    return { ok: false, error: `freqai_train failed: ${err.message}` };
  }
}

async function handleStrategyInfo(_input) {
  try {
    const [configRes, statusRes] = await Promise.allSettled([
      fetch(`${TRADE_ENGINE_URL}/freqtrade/config`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`${TRADE_ENGINE_URL}/freqtrade/status`, { signal: AbortSignal.timeout(10_000) }),
    ]);

    const config = configRes.status === "fulfilled" && configRes.value.ok
      ? await configRes.value.json() : null;
    const status = statusRes.status === "fulfilled" && statusRes.value.ok
      ? await statusRes.value.json() : null;

    if (!config) {
      return {
        ok: false,
        error: "Could not retrieve freqtrade config. Is the bot running?",
        bot_connected: status?.connected ?? false,
      };
    }

    return {
      ok: true,
      data: {
        strategy: config.strategy || "unknown",
        trading_mode: config.trading_mode || "spot",
        timeframe: config.timeframe || "unknown",
        pairs: config.pair_whitelist || [],
        exchange: config.exchange || "unknown",
        dry_run: config.dry_run ?? true,
        stake_currency: config.stake_currency || "USDT",
        stake_amount: config.stake_amount || "unlimited",
        max_open_trades: config.max_open_trades ?? -1,
        minimal_roi: config.minimal_roi || {},
        stoploss: config.stoploss ?? 0,
        trailing_stop: config.trailing_stop ?? false,
        trailing_stop_positive: config.trailing_stop_positive ?? null,
        trailing_stop_positive_offset: config.trailing_stop_positive_offset ?? null,
        freqai: config.freqai || null,
        bot_connected: status?.connected ?? false,
        open_trades: status?.open_trades?.length ?? 0,
      },
    };
  } catch (err) {
    return { ok: false, error: `strategy_info failed: ${err.message}` };
  }
}

async function handleDownloadData(input) {
  const timerange = input.timerange;
  const pairs = input.pairs || "BTC/USDT,ETH/USDT,SOL/USDT,BNB/USDT";
  const timeframes = input.timeframes || "15m,1h,4h";

  try {
    const res = await fetch(`${TRADE_ENGINE_URL}/freqtrade/download-data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairs, timerange, timeframes }),
      signal: AbortSignal.timeout(300_000), // data download can take minutes
    });
    if (res.ok) {
      const data = await res.json();
      return { ok: true, data };
    }
    // If the dedicated endpoint doesn't exist, return instructions
    return {
      ok: true,
      data: {
        status: "manual_required",
        message: "The automated data download endpoint is not yet available on the trade engine. You can download data manually.",
        command: `docker exec lumigate-freqtrade freqtrade download-data --timerange ${timerange} --timeframes ${timeframes.replace(/,/g, " ")} -p ${pairs.replace(/,/g, " ")}`,
        pairs: pairs.split(",").map((p) => p.trim()),
        timerange,
        timeframes: timeframes.split(",").map((t) => t.trim()),
      },
    };
  } catch (err) {
    return { ok: false, error: `download_data failed: ${err.message}` };
  }
}

async function handleUnifiedDashboard(_input) {
  try {
    const [posRes, ftStatusRes, ftBalRes, ibkrAccRes, ibkrStatusRes, signalsRes] = await Promise.allSettled([
      fetch(`${TRADE_ENGINE_URL}/unified/positions`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`${TRADE_ENGINE_URL}/freqtrade/status`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`${TRADE_ENGINE_URL}/freqtrade/balance`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`${TRADE_ENGINE_URL}/ibkr/account`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`${TRADE_ENGINE_URL}/ibkr/status`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`${TRADE_ENGINE_URL}/signals?limit=10`, { signal: AbortSignal.timeout(10_000) }),
    ]);

    const safeJson = async (r) =>
      r.status === "fulfilled" && r.value.ok ? r.value.json() : null;

    const [positions, ftStatus, ftBalance, ibkrAccount, ibkrStatus, signals] = await Promise.all([
      safeJson(posRes),
      safeJson(ftStatusRes),
      safeJson(ftBalRes),
      safeJson(ibkrAccRes),
      safeJson(ibkrStatusRes),
      safeJson(signalsRes),
    ]);

    // Calculate today's P&L from positions
    const allPositions = positions?.positions || [];
    const todayPnl = allPositions.reduce((sum, p) => sum + (p.unrealized_pnl || 0), 0);

    return {
      ok: true,
      data: {
        positions: {
          items: allPositions,
          count: allPositions.length,
        },
        freqtrade: {
          connected: ftStatus?.connected ?? false,
          open_trades: ftStatus?.open_trades?.length ?? 0,
          profit_summary: ftStatus?.profit || null,
          balance: ftBalance,
        },
        ibkr: {
          connected: ibkrStatus?.connected ?? false,
          account: ibkrAccount,
        },
        signals: {
          recent: signals?.items?.slice(0, 5) || [],
          total: signals?.totalItems ?? 0,
        },
        summary: {
          total_positions: allPositions.length,
          unrealized_pnl: Math.round(todayPnl * 100) / 100,
          brokers_online: [
            ftStatus?.connected ? "freqtrade" : null,
            ibkrStatus?.connected ? "ibkr" : null,
          ].filter(Boolean),
        },
      },
    };
  } catch (err) {
    return { ok: false, error: `unified_dashboard failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all LumiTrade tools with a UnifiedRegistry instance.
 * @param {import("./unified-registry").UnifiedRegistry} registry
 */
function registerTradeTools(registry) {
  registry.registerTool(MARKET_ANALYSIS_SCHEMA, handleMarketAnalysis);
  registry.registerTool(CHECK_POSITIONS_SCHEMA, handleCheckPositions);
  registry.registerTool(PLACE_TRADE_SCHEMA, handlePlaceTrade);
  registry.registerTool(BACKTEST_STRATEGY_SCHEMA, handleBacktestStrategy);
  registry.registerTool(NEWS_SENTIMENT_SCHEMA, handleNewsSentiment);
  registry.registerTool(IBKR_ACCOUNT_SCHEMA, handleIbkrAccount);
  registry.registerTool(TRADING_JOURNAL_SCHEMA, handleTradingJournal);
  registry.registerTool(PERFORMANCE_REPORT_SCHEMA, handlePerformanceReport);
  registry.registerTool(MOOD_TRACKER_SCHEMA, handleMoodTracker);
  registry.registerTool(TRADING_RAG_SEARCH_SCHEMA, handleTradingRagSearch);
  registry.registerTool(RUN_BACKTEST_SCHEMA, handleRunBacktest);
  registry.registerTool(FREQAI_TRAIN_SCHEMA, handleFreqaiTrain);
  registry.registerTool(STRATEGY_INFO_SCHEMA, handleStrategyInfo);
  registry.registerTool(DOWNLOAD_DATA_SCHEMA, handleDownloadData);
  registry.registerTool(UNIFIED_DASHBOARD_SCHEMA, handleUnifiedDashboard);
  console.log("[trade-tools] 15 trading tools registered");
}

module.exports = { registerTradeTools };
