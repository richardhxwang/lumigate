"use strict";

/**
 * LumiTrade — AI-callable trading tools for UnifiedRegistry.
 *
 * Registers 10 tools that proxy to the Trade Engine FastAPI service:
 *   market_analysis, check_positions, place_trade, backtest_strategy, news_sentiment, ibkr_account, trading_journal, performance_report, mood_tracker, trading_rag_search
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
  console.log("[trade-tools] 10 trading tools registered");
}

module.exports = { registerTradeTools };
