"use strict";

/**
 * services/pb-schema.js — PocketBase collection auto-provisioning.
 *
 * On startup, ensures all required PB collections exist.
 * Uses the PB admin API to check/create collections.
 * Safe to call multiple times — skips already-existing collections.
 */

// ---------------------------------------------------------------------------
// Collection definitions
// ---------------------------------------------------------------------------

const PB_COLLECTIONS = [
  // Knowledge Base
  {
    name: "knowledge_bases",
    type: "base",
    schema: [
      { name: "name", type: "text", required: true },
      { name: "description", type: "text" },
      { name: "embedding_model", type: "text" },
      { name: "embedding_dimension", type: "number" },
      { name: "chunk_strategy", type: "text" },
      { name: "rag_strategy", type: "text" },
      { name: "document_count", type: "number" },
      { name: "chunk_count", type: "number" },
      { name: "owner_id", type: "text" },
      { name: "org_id", type: "text" },
      { name: "config", type: "json" },
      { name: "status", type: "text" },
    ],
  },
  {
    name: "kb_documents",
    type: "base",
    schema: [
      { name: "kb_id", type: "text", required: true },
      { name: "filename", type: "text" },
      { name: "file_type", type: "text" },
      { name: "file_size", type: "number" },
      { name: "chunk_count", type: "number" },
      { name: "status", type: "text" },
      { name: "error_message", type: "text" },
      { name: "metadata", type: "json" },
      { name: "file", type: "file" },
    ],
  },
  // Workflows
  {
    name: "workflows",
    type: "base",
    schema: [
      { name: "name", type: "text", required: true },
      { name: "description", type: "text" },
      { name: "nodes", type: "json" },
      { name: "edges", type: "json" },
      { name: "variables", type: "json" },
      { name: "owner_id", type: "text" },
      { name: "org_id", type: "text" },
      { name: "status", type: "text" },
      { name: "version", type: "text" },
      { name: "published_channel", type: "text" },
    ],
  },
  {
    name: "workflow_executions",
    type: "base",
    schema: [
      { name: "workflow_id", type: "text", required: true },
      { name: "status", type: "text" },
      { name: "input", type: "json" },
      { name: "output", type: "json" },
      { name: "context", type: "json" },
      { name: "current_node", type: "text" },
      { name: "trace", type: "json" },
      { name: "started_by", type: "text" },
      { name: "duration_ms", type: "number" },
      { name: "error", type: "text" },
    ],
  },
  // Traces / Observability
  {
    name: "traces",
    type: "base",
    schema: [
      { name: "trace_id", type: "text", required: true },
      { name: "type", type: "text" },
      { name: "user_id", type: "text", required: true },
      { name: "session_id", type: "text" },
      { name: "status", type: "text" },
      { name: "duration_ms", type: "number" },
      { name: "token_count", type: "number" },
      { name: "cost_usd", type: "number" },
      { name: "spans", type: "json" },
      { name: "metadata", type: "json" },
      { name: "error", type: "text" },
    ],
  },
  {
    name: "trace_evaluations",
    type: "base",
    schema: [
      { name: "trace_id", type: "text", required: true },
      { name: "score", type: "number" },
      { name: "feedback", type: "text" },
      { name: "criteria", type: "text" },
      { name: "evaluator", type: "text" },
      { name: "evaluator_model", type: "text" },
    ],
  },
  // Versions
  {
    name: "entity_versions",
    type: "base",
    schema: [
      { name: "entity_type", type: "text", required: true },
      { name: "entity_id", type: "text", required: true },
      { name: "version", type: "text" },
      { name: "data", type: "json" },
      { name: "message", type: "text" },
      { name: "author", type: "text" },
      { name: "channel", type: "text" },
    ],
  },
  // Plugins
  {
    name: "plugins",
    type: "base",
    schema: [
      { name: "name", type: "text", required: true },
      { name: "description", type: "text" },
      { name: "version", type: "text" },
      { name: "author", type: "text" },
      { name: "plugin_type", type: "text" },
      { name: "schema", type: "json" },
      { name: "endpoint", type: "json" },
      { name: "config", type: "json" },
      { name: "tags", type: "json" },
      { name: "enabled", type: "bool" },
    ],
  },
  // User Memory (long-term per-user RAG memory)
  {
    name: "user_memories",
    type: "base",
    schema: [
      { name: "user_id", type: "text", required: true },
      { name: "category", type: "text" },      // preference, fact, entity, event, relationship
      { name: "text", type: "text" },
      { name: "source_session", type: "text" },
      { name: "entity_id", type: "text" },      // for pet profiles: pet ID
      { name: "entity_type", type: "text" },    // 'pet', 'person', 'place', etc.
      { name: "metadata", type: "json" },
      { name: "embedding_id", type: "text" },   // Qdrant point ID
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  },
  {
    name: "user_profiles",
    type: "base",
    schema: [
      { name: "user_id", type: "text", required: true },
      { name: "profile", type: "json" },        // structured profile summary
      { name: "pet_profiles", type: "json" },   // { petId: { name, breed, age, ... } }
      { name: "last_updated", type: "text" },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  },
  // Tool calls (logged from server.js tool execution pipeline)
  {
    name: "tool_calls",
    type: "base",
    schema: [
      { name: "user", type: "text" },
      { name: "source", type: "text" },
      { name: "tool_name", type: "text", required: true },
      { name: "input_json", type: "text" },
      { name: "output_json", type: "text" },
      { name: "status", type: "text" },
      { name: "error_message", type: "text" },
      { name: "duration_ms", type: "number" },
      { name: "session_id", type: "text" },
    ],
  },
  // Generated files (tool-produced files saved to PB)
  {
    name: "generated_files",
    type: "base",
    schema: [
      { name: "filename", type: "text" },
      { name: "mime_type", type: "text" },
      { name: "user", type: "text" },
      { name: "file", type: "file" },
    ],
  },
  // Security events (PII detection, command guard, etc.)
  {
    name: "security_events",
    type: "base",
    schema: [
      { name: "type", type: "text" },
      { name: "severity", type: "text" },
      { name: "details", type: "text" },
      { name: "detail_json", type: "text" },
      { name: "projectId", type: "text" },
      { name: "user", type: "text" },
      { name: "source", type: "text" },
      { name: "event_type", type: "text" },
      { name: "session_id", type: "text" },
      { name: "ip_address", type: "text" },
      { name: "timestamp", type: "text" },
    ],
  },
  // Audit log (login, project changes, tool executions)
  {
    name: "audit_log",
    type: "base",
    schema: [
      { name: "event_type", type: "text" },
      { name: "user", type: "text" },
      { name: "project", type: "text" },
      { name: "source", type: "text" },
      { name: "success", type: "bool" },
      { name: "detail_json", type: "text" },
      { name: "ip_address", type: "text" },
      { name: "timestamp", type: "text" },
    ],
  },
  // Async tasks
  {
    name: "async_tasks",
    type: "base",
    schema: [
      { name: "task_type", type: "text" },
      { name: "status", type: "text" },
      { name: "payload", type: "json" },
      { name: "result", type: "json" },
      { name: "error", type: "text" },
      { name: "progress", type: "number" },
      { name: "started_by", type: "text" },
      { name: "duration_ms", type: "number" },
      { name: "priority", type: "number" },
    ],
  },

  // ── LumiTrade collections ──────────────────────────────────────────────────
  {
    name: "trade_signals",
    type: "base",
    schema: [
      { name: "symbol", type: "text", required: true },
      { name: "direction", type: "text" },
      { name: "entry_price", type: "number" },
      { name: "stop_loss", type: "number" },
      { name: "take_profit", type: "number" },
      { name: "risk_reward", type: "number" },
      { name: "confidence", type: "number" },
      { name: "timeframe", type: "text" },
      { name: "indicators", type: "json" },
      { name: "source", type: "text" },
      { name: "status", type: "text" },
      { name: "news_sentiment", type: "number" },
      { name: "broker", type: "text" },
      { name: "user_id", type: "text", required: false },
      { name: "action", type: "text" },
      { name: "price", type: "number" },
      { name: "raw", type: "text" },
    ],
  },
  {
    name: "trade_positions",
    type: "base",
    schema: [
      { name: "symbol", type: "text", required: true },
      { name: "broker", type: "text" },
      { name: "direction", type: "text" },
      { name: "quantity", type: "number" },
      { name: "entry_price", type: "number" },
      { name: "current_price", type: "number" },
      { name: "stop_loss", type: "number" },
      { name: "take_profit", type: "number" },
      { name: "unrealized_pnl", type: "number" },
      { name: "realized_pnl", type: "number" },
      { name: "status", type: "text" },
      { name: "opened_at", type: "text" },
      { name: "closed_at", type: "text" },
      { name: "user_id", type: "text", required: true },
      { name: "r_multiple", type: "number" },
      { name: "risk_amount", type: "number" },
      { name: "session", type: "text" },
      { name: "setup_type", type: "text" },
      { name: "notes", type: "text" },

      // === Market Context at Entry ===
      { name: "entry_candle_open", type: "number" },
      { name: "entry_candle_high", type: "number" },
      { name: "entry_candle_low", type: "number" },
      { name: "entry_candle_close", type: "number" },
      { name: "entry_candle_volume", type: "number" },
      { name: "atr_at_entry", type: "number" },            // Average True Range
      { name: "spread_at_entry", type: "number" },         // bid-ask spread
      { name: "volume_ma_ratio", type: "number" },         // volume vs 20-period MA
      { name: "volatility_percentile", type: "number" },   // current vol vs 30d range (0-100)
      { name: "market_structure", type: "text" },          // bullish_trending / bearish_trending / ranging
      { name: "higher_tf_bias", type: "text" },            // 4H/1D trend direction
      { name: "dxy_at_entry", type: "number" },            // Dollar index (for forex/crypto context)

      // === SMC Indicators at Entry ===
      { name: "nearest_ob_distance", type: "number" },     // distance to nearest order block
      { name: "nearest_fvg_distance", type: "number" },    // distance to nearest FVG
      { name: "in_premium_zone", type: "bool" },           // is price in premium (above 50% of range)
      { name: "in_discount_zone", type: "bool" },          // is price in discount
      { name: "bos_count_recent", type: "number" },        // BOS count in last 50 candles
      { name: "choch_count_recent", type: "number" },      // CHoCH count in last 50 candles
      { name: "liquidity_swept_before", type: "bool" },    // was liquidity swept before entry?
      { name: "smc_confluence_score", type: "number" },    // how many SMC factors aligned (0-10)

      // === Portfolio Context at Entry ===
      { name: "portfolio_value_at_entry", type: "number" },
      { name: "position_size_pct", type: "number" },       // % of portfolio
      { name: "open_positions_count", type: "number" },     // how many other positions open
      { name: "news_sentiment_at_entry", type: "number" }, // -1 to 1
    ],
  },
  {
    name: "trade_history",
    type: "base",
    schema: [
      { name: "symbol", type: "text" },
      { name: "broker", type: "text" },
      { name: "direction", type: "text" },
      { name: "entry_price", type: "number" },
      { name: "exit_price", type: "number" },
      { name: "quantity", type: "number" },
      { name: "pnl", type: "number" },
      { name: "pnl_pct", type: "number" },
      { name: "duration_minutes", type: "number" },
      { name: "entry_time", type: "text" },
      { name: "exit_time", type: "text" },
      { name: "strategy", type: "text" },
      { name: "signal_id", type: "text" },
      { name: "user_id", type: "text", required: true },
      { name: "r_multiple", type: "number" },        // P&L in R (risk units)
      { name: "risk_amount", type: "number" },        // USD risked on this trade
      { name: "session", type: "text" },              // london, new_york, asian, overlap, off_hours
      { name: "killzone", type: "text" },             // london_killzone, ny_am_killzone, etc.
      { name: "setup_type", type: "text" },           // ob_fvg, bos_fvg, liquidity_sweep, manual
      { name: "fees", type: "number" },
      { name: "slippage", type: "number" },
      { name: "mood_at_entry", type: "text" },        // calm, anxious, confident, fearful, greedy, excited
      { name: "mood_score", type: "number" },         // -5 to +5
      { name: "news_context", type: "text" },         // news summary at time of entry
      { name: "tags", type: "json" },                 // ["reversal", "trend-follow", "breakout"]
      { name: "notes", type: "text" },                // trader's notes on this trade
      { name: "screenshots", type: "file" },          // chart screenshots
      { name: "grade", type: "text" },                // A/B/C/D/F self-rating

      // === Price Action Context ===
      { name: "entry_candle_open", type: "number" },
      { name: "entry_candle_high", type: "number" },
      { name: "entry_candle_low", type: "number" },
      { name: "entry_candle_close", type: "number" },
      { name: "entry_candle_volume", type: "number" },
      { name: "exit_candle_open", type: "number" },
      { name: "exit_candle_high", type: "number" },
      { name: "exit_candle_low", type: "number" },
      { name: "exit_candle_close", type: "number" },
      { name: "exit_candle_volume", type: "number" },
      { name: "highest_price_during", type: "number" },   // max price while in trade
      { name: "lowest_price_during", type: "number" },    // min price while in trade
      { name: "max_favorable_excursion", type: "number" }, // MFE - best unrealized P&L
      { name: "max_adverse_excursion", type: "number" },   // MAE - worst unrealized P&L
      { name: "mfe_r", type: "number" },                   // MFE in R multiples
      { name: "mae_r", type: "number" },                   // MAE in R multiples

      // === Market Environment at Entry ===
      { name: "atr_at_entry", type: "number" },            // Average True Range
      { name: "spread_at_entry", type: "number" },         // bid-ask spread
      { name: "volume_ma_ratio", type: "number" },         // volume vs 20-period MA
      { name: "volatility_percentile", type: "number" },   // current vol vs 30d range (0-100)
      { name: "market_structure", type: "text" },          // bullish_trending / bearish_trending / ranging
      { name: "higher_tf_bias", type: "text" },            // 4H/1D trend direction
      { name: "dxy_at_entry", type: "number" },            // Dollar index (for forex/crypto context)

      // === SMC Indicators at Entry ===
      { name: "nearest_ob_distance", type: "number" },     // distance to nearest order block
      { name: "nearest_fvg_distance", type: "number" },    // distance to nearest FVG
      { name: "in_premium_zone", type: "bool" },           // is price in premium (above 50% of range)
      { name: "in_discount_zone", type: "bool" },          // is price in discount
      { name: "bos_count_recent", type: "number" },        // BOS count in last 50 candles
      { name: "choch_count_recent", type: "number" },      // CHoCH count in last 50 candles
      { name: "liquidity_swept_before", type: "bool" },    // was liquidity swept before entry?
      { name: "smc_confluence_score", type: "number" },    // how many SMC factors aligned (0-10)

      // === Timing ===
      { name: "day_of_week", type: "text" },               // Mon/Tue/Wed/Thu/Fri
      { name: "hour_utc", type: "number" },                // 0-23
      { name: "minutes_in_trade", type: "number" },        // actual duration
      { name: "candles_in_trade", type: "number" },        // how many candles
      { name: "time_to_tp_minutes", type: "number" },      // how long to reach TP (null if SL hit)
      { name: "time_to_sl_minutes", type: "number" },      // how long to reach SL (null if TP hit)
      { name: "exit_reason", type: "text" },               // tp_hit / sl_hit / trailing_stop / manual / choch_exit / roi

      // === Portfolio Context ===
      { name: "portfolio_value_at_entry", type: "number" },
      { name: "position_size_pct", type: "number" },       // % of portfolio
      { name: "open_positions_count", type: "number" },     // how many other positions open
      { name: "daily_pnl_before_trade", type: "number" },  // P&L already made today before this trade
      { name: "consecutive_wins_before", type: "number" },
      { name: "consecutive_losses_before", type: "number" },

      // === News/Sentiment Context ===
      { name: "news_sentiment_at_entry", type: "number" }, // -1 to 1
      { name: "major_news_within_1h", type: "bool" },      // was there major news nearby?
      { name: "economic_event_within_30m", type: "bool" },  // Finnhub calendar
      { name: "news_headline", type: "text" },             // most relevant headline

      // === RAG Embedding ===
      { name: "trade_summary_text", type: "text" },        // human-readable summary for embedding
      { name: "embedding_id", type: "text" },              // Qdrant vector ID for this trade

      // === Bot / Exchange Context ===
      { name: "bot_name", type: "text" },                  // freqtrade bot name
      { name: "exchange", type: "text" },                  // OKX, IBKR, Binance, etc.
      { name: "trading_mode", type: "text" },              // live / paper / backtest
    ],
  },
  {
    name: "trade_pnl",
    type: "base",
    schema: [
      { name: "date", type: "text", required: true },
      { name: "daily_pnl", type: "number" },
      { name: "cumulative_pnl", type: "number" },
      { name: "win_count", type: "number" },
      { name: "loss_count", type: "number" },
      { name: "win_rate", type: "number" },
      { name: "portfolio_value", type: "number" },
      { name: "max_drawdown", type: "number" },
      { name: "user_id", type: "text", required: true },
      { name: "total_r", type: "number" },            // sum of R for the day
      { name: "avg_r", type: "number" },              // average R per trade
      { name: "largest_win_r", type: "number" },
      { name: "largest_loss_r", type: "number" },
      { name: "session_pnl", type: "json" },          // {london: {pnl, trades, wins}, ny: {...}}
      { name: "killzone_pnl", type: "json" },         // {london_kz: {pnl, trades}, ny_am_kz: {...}}
      { name: "streak", type: "number" },             // positive=win streak, negative=loss streak
      { name: "avg_mood", type: "number" },           // average mood score for the day
      { name: "best_setup", type: "text" },           // best performing setup type
      { name: "worst_setup", type: "text" },
    ],
  },
  {
    name: "trade_news",
    type: "base",
    schema: [
      { name: "symbol", type: "text" },
      { name: "headline", type: "text" },
      { name: "summary", type: "text" },
      { name: "source", type: "text" },
      { name: "url", type: "text" },
      { name: "published_at", type: "text" },
      { name: "finnhub_sentiment", type: "number" },
      { name: "finbert_sentiment", type: "number" },
      { name: "llm_sentiment", type: "number" },
      { name: "final_sentiment", type: "number" },
      { name: "impact", type: "text" },
      { name: "category", type: "text" },
      { name: "processed", type: "bool" },
    ],
  },
  {
    name: "trade_strategies",
    type: "base",
    schema: [
      { name: "name", type: "text", required: true },
      { name: "description", type: "text" },
      { name: "config", type: "json" },
      { name: "is_active", type: "bool" },
      { name: "symbols", type: "json" },
      { name: "timeframes", type: "json" },
      { name: "backtest_results", type: "json" },
      { name: "version", type: "text" },
      { name: "freqai_enabled", type: "bool" },
      { name: "last_backtest_id", type: "text" },
      { name: "user_id", type: "text", required: true },
    ],
  },
  {
    name: "trade_mood_logs",
    type: "base",
    schema: [
      { name: "timestamp", type: "text", required: true },
      { name: "mood_label", type: "text" },           // anxious, calm, greedy, fearful, confident, excited, bored, frustrated, euphoric
      { name: "mood_score", type: "number" },         // -5 to +5
      { name: "energy_level", type: "number" },       // 1-10
      { name: "context", type: "text" },              // before_trade, after_trade, during_session, general
      { name: "trade_id", type: "text" },             // linked trade
      { name: "session", type: "text" },              // which session
      { name: "notes", type: "text" },                // what user said/felt
      { name: "ai_extracted", type: "bool" },         // was this auto-extracted from chat?
      { name: "source_message", type: "text" },       // original LumiChat message that triggered this
      { name: "market_condition", type: "text" },     // trending, ranging, volatile, calm
      { name: "user_id", type: "text", required: true },
      { name: "consecutive_result", type: "text" },        // "3W" or "2L" — streak at time of mood log
    ],
  },
  {
    name: "trade_journal",
    type: "base",
    schema: [
      { name: "date", type: "text", required: true },
      { name: "session", type: "text" },        // london, ny, asian, overlap
      { name: "mood_before", type: "text" },     // user's mood before trading
      { name: "mood_after", type: "text" },      // user's mood after trading
      { name: "notes", type: "text" },           // free-form notes from user
      { name: "ai_summary", type: "text" },      // LLM-generated daily summary
      { name: "trades_count", type: "number" },
      { name: "wins", type: "number" },
      { name: "losses", type: "number" },
      { name: "total_pnl", type: "number" },
      { name: "best_trade", type: "json" },      // {symbol, pnl, entry, exit}
      { name: "worst_trade", type: "json" },
      { name: "session_breakdown", type: "json" }, // {london: {wins, losses, pnl}, ny: {...}, ...}
      { name: "killzone_performance", type: "json" }, // performance by killzone
      { name: "patterns_noted", type: "json" },  // SMC patterns that worked/failed
      { name: "lessons", type: "text" },         // AI-extracted lessons
      { name: "reflection", type: "text" },      // trader's personal reflection
      { name: "lessons_learned", type: "text" }, // concrete takeaways
      { name: "trades_reviewed", type: "json" }, // list of trade IDs reviewed in this journal entry
      { name: "plan_adherence_score", type: "number" }, // 0-10 self-rating on following the plan
      { name: "user_id", type: "text", required: true },
    ],
  },

  // ── LumiTrade backtest results ────────────────────────────────────────
  {
    name: "trade_backtest_results",
    type: "base",
    schema: [
      { name: "version", type: "text", required: true },
      { name: "description", type: "text" },
      { name: "strategy_name", type: "text", required: true },
      { name: "exchange", type: "text" },
      { name: "trading_mode", type: "text" },
      { name: "timerange", type: "text" },
      { name: "timeframe", type: "text" },
      { name: "total_trades", type: "number" },
      { name: "wins", type: "number" },
      { name: "losses", type: "number" },
      { name: "winrate", type: "number" },
      { name: "profit_total_abs", type: "number" },
      { name: "profit_total_pct", type: "number" },
      { name: "max_drawdown_abs", type: "number" },
      { name: "max_drawdown_pct", type: "number" },
      { name: "sharpe", type: "number" },
      { name: "sortino", type: "number" },
      { name: "calmar", type: "number" },
      { name: "profit_factor", type: "number" },
      { name: "avg_duration", type: "text" },
      { name: "pairs_count", type: "number" },
      { name: "notes", type: "text" },
      { name: "tags", type: "json" },
      { name: "result_json", type: "json" },
      { name: "filename", type: "text" },
      { name: "user_id", type: "text" },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  },

  // ── LumiTrader (trading AI assistant) collections ──────────────────────
  {
    name: "lt_sessions",
    type: "base",
    schema: [
      { name: "title", type: "text" },
      { name: "user_id", type: "text", required: true },
      { name: "model", type: "text" },
      { name: "preset", type: "text" },
      { name: "message_count", type: "number" },
      { name: "last_message_at", type: "text" },
      { name: "context_snapshot", type: "json" },
      { name: "messages", type: "json" },
      { name: "pair", type: "text" },
      { name: "exchange", type: "text" },
      { name: "market_type", type: "text" },
    ],
  },
  {
    name: "lt_messages",
    type: "base",
    schema: [
      { name: "session_id", type: "text", required: true },
      { name: "role", type: "text" },
      { name: "content", type: "text" },
      { name: "model", type: "text" },
      { name: "tokens_in", type: "number" },
      { name: "tokens_out", type: "number" },
      { name: "tool_calls", type: "json" },
      { name: "context_data", type: "json" },
    ],
  },
  {
    name: "lt_user_settings",
    type: "base",
    schema: [
      { name: "user_id", type: "text", required: true },
      { name: "chat_style", type: "text" },
      { name: "auto_execute", type: "text" },
      { name: "language", type: "text" },
      { name: "chart_analysis", type: "text" },
      { name: "context_injection", type: "text" },
      { name: "notification_mode", type: "text" },
      { name: "journal_mode", type: "text" },
      { name: "strategy_dev", type: "text" },
      { name: "risk_control", type: "text" },
      { name: "data_scope", type: "text" },
      { name: "history_retention", type: "text" },
      { name: "preferred_model", type: "text" },
      { name: "presets", type: "json" },
      { name: "custom_prompt", type: "text" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Auto-provisioning
// ---------------------------------------------------------------------------

/**
 * Ensure all PB_COLLECTIONS exist. Creates missing ones, skips existing.
 *
 * @param {string} pbUrl - PocketBase base URL (e.g. http://localhost:8090)
 * @param {string} adminToken - PB admin auth token
 * @param {function} [log] - Optional logger (level, msg, ctx)
 * @returns {Promise<{created: string[], skipped: string[], errors: string[]}>}
 */
// Map collection name → PB project ID for project-scoped creation
const COLLECTION_PROJECT_MAP = {
  // LumiGate core
  security_events: "lumigate",
  audit_log: "lumigate",
  tool_calls: "lumigate",
  generated_files: "lumigate",
  async_tasks: "lumigate",
  traces: "lumigate",
  trace_evaluations: "lumigate",
  entity_versions: "lumigate",
  plugins: "lumigate",
  // LumiChat
  user_memories: "lumichat",
  user_profiles: "lumichat",
  // Knowledge / RAG
  knowledge_bases: "lumigate",
  kb_documents: "lumigate",
  // Workflows
  workflows: "lumigate",
  workflow_executions: "lumigate",
  // LumiTrade
  trade_signals: "lumitrade",
  trade_positions: "lumitrade",
  trade_history: "lumitrade",
  trade_pnl: "lumitrade",
  trade_news: "lumitrade",
  trade_strategies: "lumitrade",
  trade_backtest_results: "lumitrade",
  trade_journal: "lumitrade",
  trade_mood_logs: "lumitrade",
  lt_sessions: "lumitrade",
  lt_messages: "lumitrade",
  lt_user_settings: "lumitrade",
};

async function ensureCollections(pbUrl, adminToken, log) {
  const _log = log || (() => {});
  const created = [];
  const skipped = [];
  const errors = [];

  if (!pbUrl || !adminToken) {
    _log("warn", "pb_schema_skip", {
      component: "pb-schema",
      reason: !pbUrl ? "no PB_URL" : "no admin token",
    });
    return { created, skipped, errors };
  }

  // Fetch existing collection names
  let existingNames = new Set();
  try {
    const res = await fetch(`${pbUrl}/api/collections?perPage=500`, {
      headers: { Authorization: adminToken },
    });
    if (res.ok) {
      const data = await res.json();
      existingNames = new Set((data.items || []).map((c) => c.name));
    }
  } catch (err) {
    _log("error", "pb_schema_fetch_failed", {
      component: "pb-schema",
      error: err.message,
    });
    return { created, skipped, errors: ["Failed to fetch existing collections: " + err.message] };
  }

  for (const collection of PB_COLLECTIONS) {
    if (existingNames.has(collection.name)) {
      skipped.push(collection.name);
      continue;
    }

    try {
      const body = {
        name: collection.name,
        type: collection.type || "base",
        fields: collection.schema.map((field) => {
          const f = { name: field.name, type: field.type, required: field.required || false };
          // autodate fields need onCreate/onUpdate
          if (field.type === "autodate") {
            f.onCreate = field.onCreate !== false;
            f.onUpdate = !!field.onUpdate;
            delete f.required;
          }
          return f;
        }),
      };

      // Every collection MUST be mapped to a project — fail loudly if missing
      const project = COLLECTION_PROJECT_MAP[collection.name];
      if (!project) {
        const errMsg = `Collection "${collection.name}" has no project mapping in COLLECTION_PROJECT_MAP. Add it before deploying.`;
        errors.push(errMsg);
        _log("error", "pb_collection_no_project", { component: "pb-schema", collection: collection.name, error: errMsg });
        continue;
      }
      const apiPath = `${pbUrl}/api/p/${project}/collections`;

      const res = await fetch(apiPath, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: adminToken,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        created.push(collection.name);
        _log("info", "pb_collection_created", {
          component: "pb-schema",
          collection: collection.name,
        });
      } else {
        const errText = await res.text().catch(() => "");
        // 400 with "already exists" is OK (race condition)
        if (res.status === 400 && errText.includes("already exists")) {
          skipped.push(collection.name);
        } else {
          errors.push(`${collection.name}: ${res.status} ${errText.slice(0, 200)}`);
          _log("warn", "pb_collection_create_failed", {
            component: "pb-schema",
            collection: collection.name,
            status: res.status,
            error: errText.slice(0, 200),
          });
        }
      }
    } catch (err) {
      errors.push(`${collection.name}: ${err.message}`);
      _log("error", "pb_collection_create_error", {
        component: "pb-schema",
        collection: collection.name,
        error: err.message,
      });
    }
  }

  _log("info", "pb_schema_provisioned", {
    component: "pb-schema",
    created: created.length,
    skipped: skipped.length,
    errors: errors.length,
  });

  return { created, skipped, errors };
}

module.exports = { PB_COLLECTIONS, ensureCollections };
