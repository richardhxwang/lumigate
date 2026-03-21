/**
 * routes/lumitrader.js — LumiTrader AI Chat Backend
 *
 * Trading-specific AI chat endpoint, independent from LumiChat.
 * Auto-injects trading context (positions, P&L, signals) before each message.
 * Uses PB project: lumitrade, token tracking: _lumitrade.
 *
 * Factory function pattern — same as trade.js / lumichat.js.
 */
const express = require("express");

const TRADE_ENGINE_URL_DEFAULT = "http://localhost:3200";
const PB_TRADE_PROJECT = (process.env.PB_TRADE_PROJECT || "lumitrade").trim() || "lumitrade";
const LUMIGATE_INTERNAL_URL = process.env.LUMIGATE_INTERNAL_URL || "http://localhost:9471";
const TG_BOT_TOKEN = process.env.LUMITRADER_TELEGRAM_TOKEN || process.env.TRADE_TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.LUMITRADER_TELEGRAM_CHAT_ID || process.env.TRADE_TELEGRAM_CHAT_ID || "";

// ── Telegram send helper ──────────────────────────────────────────────────

async function sendTelegram(text, options = {}) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return false;
  try {
    const body = {
      chat_id: options.chatId || TG_CHAT_ID,
      text,
      parse_mode: options.parseMode || "HTML",
    };
    if (options.replyMarkup) body.reply_markup = JSON.stringify(options.replyMarkup);
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) console.error("[lumitrader][telegram] send failed:", data.description);
    return data.ok;
  } catch (err) {
    console.error("[lumitrader][telegram] error:", err.message);
    return false;
  }
}

const TRADING_SYSTEM_PROMPT = `你是 LumiTrader，一个专业的 SMC/ICT 交易 AI 助手。

你的能力：
- 分析行情（SMC 结构：BOS/CHoCH/OB/FVG/Liquidity）
- 管理持仓（查看/下单/平仓，支持 crypto 和美股）
- 跑回测和优化策略（freqtrade + vectorbt）
- 记录交易日志和情绪
- 分析交易表现（session/killzone/mood 关联）
- 控制 freqtrade（所有 CLI 命令）
- 提供 ICT/SMC 教学

风控规则（不可违反）：
- 单笔最大仓位 2%
- 日亏损熔断 3%
- 最多 5 个持仓
- R:R 至少 2:1

当前市场上下文会自动注入到每次对话中。

## 重要：区分数据来源
- 上下文中的 [Backtest Results] 是回测数据，不是实盘。回答时必须明确标注"回测数据"
- [Live Bot Status] 才是实时交易状态
- [Open Positions] 如果来自 PB 测试数据，要说明
- 当 bot 处于 dry_run 模式时，所有"交易"都是模拟的，要明确告知用户
- 永远不要把回测数据当成实盘交易记录展示

## 当前策略实现 (SMCStrategy.py)
- 时间框架: 15m 入场, 1h+4h 确认 (via informative_pairs)
- SMC 指标: smart-money-concepts 库 (BOS, CHoCH, OB, FVG, Liquidity, Swing H/L)
- 入场条件: BOS/CHoCH + 价格在 OB 区域 + FVG 存在 + 流动性足够
- 退出条件: CHoCH 反转信号 (use_exit_signal=True)
- Stoploss: -7.7% (固定), Trailing: +20.1%启动 +20.3%偏移
- Minimal ROI: 0分钟30.6%, 109分钟10.7%, 273分钟3.9%, 625分钟0%
- FreqAI (LumiLearning): LightGBM 预测12根K线前瞻收益, 作为入场过滤器
- 当前模式: spot, long-only (can_short=False)
- Hyperopt 优化过: swing_length=5, ob_strength_min=0.381`;

module.exports = function createLumiTraderRouter(deps) {
  const router = express.Router();
  const {
    PB_URL,
    getPbAdminToken,
    TRADE_ENGINE_URL,
    INTERNAL_CHAT_KEY,
    parseCookies,
    validateAuthToken,
  } = deps;

  // ── Auth middleware ───────────────────────────────────────────────────────

  // lcAuth — validates PB auth_token cookie; populates req.user and req.authToken
  const lcAuth = (req, res, next) => {
    const cookies = parseCookies ? parseCookies(req) : {};
    const token = cookies.auth_token;
    if (!token) return res.status(401).json({ error: "Not authenticated" });
    const payload = validateAuthToken ? validateAuthToken(token) : null;
    if (!payload) return res.status(401).json({ error: "Session expired" });
    req.user = payload;
    req.authToken = token;
    next();
  };

  // chatAuth — accepts either an internal server key OR a valid auth_token cookie
  const chatAuth = (req, res, next) => {
    const projectKey = req.headers["x-project-key"];
    if (projectKey && INTERNAL_CHAT_KEY && projectKey === INTERNAL_CHAT_KEY) return next();
    return lcAuth(req, res, next);
  };

  const engineUrl = TRADE_ENGINE_URL || TRADE_ENGINE_URL_DEFAULT;

  // ── PocketBase project isolation ──────────────────────────────────────────

  function toProjectPath(pbPath) {
    const p = String(pbPath || "");
    if (p.startsWith(`/api/p/${PB_TRADE_PROJECT}/`)) return p;
    if (p.startsWith("/api/collections/")) return `/api/p/${PB_TRADE_PROJECT}${p.slice("/api".length)}`;
    if (p.startsWith("/api/files/")) return `/api/p/${PB_TRADE_PROJECT}${p.slice("/api".length)}`;
    return p;
  }

  async function tradePbFetch(path, options = {}) {
    const p = String(path || "");
    const target = toProjectPath(p);
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };

    if (!headers["Authorization"] && getPbAdminToken) {
      const adminToken = await getPbAdminToken();
      if (adminToken) headers["Authorization"] = adminToken;
    }

    const fetchOptions = { ...options, headers };
    const url = `${PB_URL}${target}`;

    if (target !== p) {
      try {
        const scoped = await fetch(url, fetchOptions);
        if (scoped.ok) return scoped;
      } catch { /* fall through to unscoped */ }
      return fetch(`${PB_URL}${p}`, fetchOptions);
    }
    return fetch(url, fetchOptions);
  }

  // ── Trade Engine fetch ────────────────────────────────────────────────────

  async function engineFetch(path, options = {}) {
    const url = `${engineUrl}${path}`;
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    return fetch(url, { ...options, headers });
  }

  // ── Trading context fetcher ───────────────────────────────────────────────

  async function fetchTradingContext(userMessage, userId) {
    const ctx = {
      positions: null, pnl: null, signals: null, history: null, journal: null,
      mood: null, rag: null, backtestHistory: null, backtestResultsPB: null,
      ftStatus: null, ftConfig: null, news: null,
    };
    const timings = {};
    // User filter only for multi-user collections (lt_sessions, lt_user_settings).
    // Bot-generated trade data (history, journal, mood, pnl) should be visible
    // to any authenticated user — it's a single-tenant trading system.
    const userFilter = userId ? `&filter=(user_id='${userId}')` : '';

    const timed = (label, promise) => {
      const start = Date.now();
      return promise
        .then(r => { timings[label] = { ms: Date.now() - start, ok: true }; return r; })
        .catch(e => { timings[label] = { ms: Date.now() - start, ok: false, err: e.message }; return null; });
    };

    const ftAuth = "Basic " + Buffer.from("lumitrade:123123@").toString("base64");

    const tasks = [
      timed("engine/positions", engineFetch("/positions").then(r => r.ok ? r.json() : null)),
      // Trade data: try user-scoped first, fallback to unscoped if empty (single-tenant friendly)
      timed("pb/trade_pnl", tradePbFetch(`/api/collections/trade_pnl/records?perPage=1${userFilter}`).then(r => r.ok ? r.json() : null).then(d => d?.items?.length ? d : tradePbFetch("/api/collections/trade_pnl/records?perPage=1").then(r => r.ok ? r.json() : null))),
      timed("engine/signals", engineFetch("/signals?limit=5").then(r => r.ok ? r.json() : null)),
      timed("pb/trade_history", tradePbFetch(`/api/collections/trade_history/records?perPage=15${userFilter}`).then(r => r.ok ? r.json() : null).then(d => d?.items?.length ? d : tradePbFetch("/api/collections/trade_history/records?perPage=15").then(r => r.ok ? r.json() : null))),
      timed("pb/trade_journal", tradePbFetch(`/api/collections/trade_journal/records?perPage=8${userFilter}`).then(r => r.ok ? r.json() : null).then(d => d?.items?.length ? d : tradePbFetch("/api/collections/trade_journal/records?perPage=8").then(r => r.ok ? r.json() : null))),
      timed("pb/trade_mood_logs", tradePbFetch(`/api/collections/trade_mood_logs/records?perPage=5${userFilter}`).then(r => r.ok ? r.json() : null).then(d => d?.items?.length ? d : tradePbFetch("/api/collections/trade_mood_logs/records?perPage=5").then(r => r.ok ? r.json() : null))),
      timed("engine/rag", userMessage
        ? engineFetch(`/rag/search?q=${encodeURIComponent(userMessage)}&limit=3`).then(r => r.ok ? r.json() : null)
        : Promise.resolve(null)),
      timed("ft-bt/history", fetch("http://lumigate-freqtrade-bt:8080/api/v1/backtest/history", {
        headers: { Authorization: ftAuth },
      }).then(r => r.ok ? r.json() : null)),
      timed("pb/backtest_results", tradePbFetch("/api/collections/trade_backtest_results/records?perPage=3&sort=-created").then(r => r.ok ? r.json() : null)),
      // NEW: freqtrade live status
      timed("engine/ft-status", engineFetch("/freqtrade/status").then(r => r.ok ? r.json() : null)),
      // NEW: freqtrade config (strategy params)
      timed("engine/ft-config", engineFetch("/freqtrade/config").then(r => r.ok ? r.json() : null)),
      // NEW: recent news from PB
      timed("pb/trade_news", tradePbFetch("/api/collections/trade_news/records?perPage=10&sort=-created").then(r => r.ok ? r.json() : null)),
    ];

    const [positions, pnl, signals, history, journal, mood, rag, backtestHistory, backtestResultsPB, ftStatus, ftConfig, news] = await Promise.all(tasks);
    ctx.positions = positions;
    ctx.pnl = pnl?.items?.[0] || null;
    ctx.signals = signals;
    ctx.history = history;
    ctx.journal = journal;
    ctx.mood = mood;
    ctx.rag = rag;
    ctx.backtestHistory = backtestHistory;
    ctx.backtestResultsPB = backtestResultsPB?.items || null;
    ctx.ftStatus = ftStatus;
    ctx.ftConfig = ftConfig;
    ctx.news = news?.items || null;

    // Chain logging
    const chainLog = {
      timestamp: new Date().toISOString(), userId,
      userQuery: (userMessage || "").slice(0, 100), timings,
      dataCounts: {
        positions: Array.isArray(ctx.positions?.items) ? ctx.positions.items.length : (ctx.positions ? "non-array" : null),
        pnl: ctx.pnl ? "yes" : null,
        signals: Array.isArray(ctx.signals?.items) ? ctx.signals.items.length : null,
        history: ctx.history?.items?.length ?? null,
        journal: ctx.journal?.items?.length ?? null,
        mood: ctx.mood?.items?.length ?? null,
        rag: Array.isArray(ctx.rag?.results) ? ctx.rag.results.length : null,
        backtestHistory: Array.isArray(ctx.backtestHistory) ? ctx.backtestHistory.length : null,
        backtestResultsPB: Array.isArray(ctx.backtestResultsPB) ? ctx.backtestResultsPB.length : null,
        ftStatus: ctx.ftStatus ? "yes" : null,
        ftConfig: ctx.ftConfig ? "yes" : null,
        news: Array.isArray(ctx.news) ? ctx.news.length : null,
      },
    };
    console.log("[lumitrader][chain] fetchTradingContext:", JSON.stringify(chainLog));
    const fs = require("fs");
    fs.appendFileSync("/tmp/lumitrader-chain.log", JSON.stringify(chainLog, null, 2) + "\n---\n");
    return ctx;
  }

  // Helper: build line with only non-null fields
  function _f(parts) { return parts.filter(Boolean).join(" "); }

  function formatTradingContext(ctx) {
    const parts = [];

    // 1. Live Bot Status (freqtrade)
    if (ctx.ftStatus) {
      const st = ctx.ftStatus;
      const lines = [];
      if (st.connected === false) {
        lines.push("  Bot offline");
      } else if (Array.isArray(st.open_trades)) {
        if (st.profit) lines.push(`  bot_profit: today:${st.profit.profit_all_coin ?? "?"}USDT (${st.profit.profit_all_percent ?? "?"}%) closed_trades:${st.profit.trade_count ?? "?"}`);
        if (st.open_trades.length > 0) {
          st.open_trades.slice(0, 8).forEach(t => {
            lines.push(`  ${t.pair} ${t.is_short ? "short" : "long"} profit:${t.profit_abs?.toFixed(2) ?? "?"}USDT (${((t.profit_ratio || 0) * 100).toFixed(1)}%) dur:${t.trade_duration || "?"}`);
          });
        } else {
          lines.push("  No open trades on bot");
        }
      } else if (Array.isArray(st)) {
        // freqtrade /status returns array of open trades directly
        if (st.length > 0) {
          st.slice(0, 8).forEach(t => {
            lines.push(`  ${t.pair} ${t.is_short ? "short" : "long"} profit:${t.profit_abs?.toFixed(2) ?? "?"}USDT (${((t.profit_ratio || 0) * 100).toFixed(1)}%) dur:${t.trade_duration || "?"}`);
          });
        } else {
          lines.push("  No open trades on bot");
        }
      }
      if (lines.length > 0) parts.push(`[Live Bot Status]\n${lines.join("\n")}`);
    }

    // 2. Open Positions (PB) — enriched
    if (ctx.positions && Array.isArray(ctx.positions.items) && ctx.positions.items.length > 0) {
      const posLines = ctx.positions.items.map(p => _f([
        `  ${p.symbol} ${p.direction || "?"}`,
        `qty:${p.quantity || "?"}`,
        p.entry_price ? `entry:${p.entry_price}` : null,
        p.stop_loss ? `SL:${p.stop_loss}` : null,
        p.take_profit ? `TP:${p.take_profit}` : null,
        `uPnL:${p.unrealized_pnl ?? "?"}`,
        p.r_multiple != null ? `R:${p.r_multiple}` : null,
        p.smc_confluence_score != null ? `smc:${p.smc_confluence_score}/10` : null,
        p.market_structure ? `struct:${p.market_structure}` : null,
        p.higher_tf_bias ? `htf:${p.higher_tf_bias}` : null,
        p.position_size_pct != null ? `size:${p.position_size_pct}%` : null,
        p.opened_at ? `opened:${p.opened_at}` : null,
      ]));
      parts.push(`[Open Positions]\n${posLines.join("\n")}`);
    } else {
      parts.push("[Open Positions] None");
    }

    // 3. P&L — enriched (from PB trade_pnl)
    if (ctx.pnl) {
      const p = ctx.pnl;
      const pnlLine = _f([
        "[P&L]",
        p.date ? `date:${p.date}` : null,
        `today:${p.daily_pnl ?? "?"}`,
        `cumulative:${p.cumulative_pnl ?? "?"}`,
        p.portfolio_value != null ? `portfolio:${p.portfolio_value}` : null,
        `WR:${p.win_rate ?? "?"}%`,
        p.win_count != null ? `W:${p.win_count}` : null,
        p.loss_count != null ? `L:${p.loss_count}` : null,
        p.max_drawdown != null ? `DD:${p.max_drawdown}` : null,
        p.total_r != null ? `total_R:${p.total_r}` : null,
        p.avg_r != null ? `avg_R:${p.avg_r}` : null,
        p.streak != null ? `streak:${p.streak > 0 ? "+" : ""}${p.streak}` : null,
        p.best_setup ? `best_setup:${p.best_setup}` : null,
        p.session_pnl ? `session_pnl:${JSON.stringify(p.session_pnl)}` : null,
      ]);
      parts.push(pnlLine);
    }

    // 4. Recent News — NEW
    if (Array.isArray(ctx.news) && ctx.news.length > 0) {
      const lines = ctx.news.slice(0, 10).map(n => _f([
        `  [${(n.published_at || n.created || "?").slice(0, 16)}]`,
        n.symbol || "GENERAL",
        `| ${(n.headline || "?").slice(0, 70)}`,
        n.finnhub_sentiment != null ? `finnhub:${n.finnhub_sentiment}` : null,
        n.finbert_sentiment != null ? `finbert:${n.finbert_sentiment}` : null,
        n.final_sentiment != null ? `final:${n.final_sentiment}` : null,
        n.impact ? `impact:${n.impact}` : null,
        n.category ? `cat:${n.category}` : null,
      ]));
      parts.push(`[Recent News (${ctx.news.length})]\n${lines.join("\n")}`);
    }

    // 5. Recent Signals — enriched
    if (ctx.signals && Array.isArray(ctx.signals.items) && ctx.signals.items.length > 0) {
      const sigLines = ctx.signals.items.slice(0, 5).map(s => _f([
        `  ${s.symbol} ${s.direction || "?"}`,
        `confidence:${s.confidence ?? "?"}`,
        `entry:${s.entry_price ?? "?"}`,
        s.stop_loss ? `SL:${s.stop_loss}` : null,
        s.take_profit ? `TP:${s.take_profit}` : null,
        s.risk_reward ? `R:R:${s.risk_reward}` : null,
        s.timeframe ? `tf:${s.timeframe}` : null,
        s.source ? `src:${s.source}` : null,
        s.status ? `status:${s.status}` : null,
        s.news_sentiment != null ? `news:${s.news_sentiment}` : null,
      ]));
      parts.push(`[Recent Signals]\n${sigLines.join("\n")}`);
    }

    // 6. Recent Trades (PB) — enriched
    const histItems = ctx.history?.items;
    if (Array.isArray(histItems) && histItems.length > 0) {
      const lines = histItems.slice(0, 15).map(t => _f([
        `  ${t.symbol || "?"} ${t.direction || "?"}`,
        `pnl:${t.pnl ?? "?"}`,
        t.r_multiple != null ? `R:${t.r_multiple}` : null,
        t.entry_price && t.exit_price ? `entry:${t.entry_price}→${t.exit_price}` : null,
        t.exit_reason ? `exit:${t.exit_reason}` : null,
        t.mfe_r != null ? `mfe_r:${t.mfe_r}` : null,
        t.mae_r != null ? `mae_r:${t.mae_r}` : null,
        t.setup_type ? `setup:${t.setup_type}` : null,
        t.smc_confluence_score != null ? `smc:${t.smc_confluence_score}/10` : null,
        t.grade ? `grade:${t.grade}` : null,
        t.session ? `session:${t.session}` : null,
        t.killzone ? `kz:${t.killzone}` : null,
        t.mood_at_entry ? `mood:${t.mood_at_entry}${t.mood_score != null ? `(${t.mood_score})` : ""}` : null,
        t.news_sentiment_at_entry != null ? `news:${t.news_sentiment_at_entry}` : null,
        t.day_of_week ? `dow:${t.day_of_week}` : null,
        t.hour_utc != null ? `h:${t.hour_utc}` : null,
        t.exit_time || t.created || "",
      ]));
      parts.push(`[Recent Trades (last ${lines.length})]\n${lines.join("\n")}`);
    }

    // 7. Recent Mood — enriched
    const moodItems = ctx.mood?.items;
    if (Array.isArray(moodItems) && moodItems.length > 0) {
      const lines = moodItems.slice(0, 5).map(m => _f([
        `  [${m.created || "?"}] ${m.mood_label || "?"}`,
        `score:${m.mood_score ?? "?"}`,
        m.energy_level != null ? `energy:${m.energy_level}` : null,
        m.context ? `ctx:${m.context}` : null,
        m.market_condition ? `mkt:${m.market_condition}` : null,
        m.consecutive_result ? `streak:${m.consecutive_result}` : null,
        m.notes ? `| ${m.notes.slice(0, 60)}` : null,
      ]));
      parts.push(`[Recent Mood]\n${lines.join("\n")}`);
    }

    // 8. Journal Entries — enriched
    const journalItems = ctx.journal?.items;
    if (Array.isArray(journalItems) && journalItems.length > 0) {
      const lines = journalItems.slice(0, 8).map(j => _f([
        `  [${j.date || j.created || "?"}]`,
        j.session ? `session:${j.session}` : null,
        `mood:${j.mood_before || "?"}→${j.mood_after || "?"}`,
        j.plan_adherence_score != null ? `plan:${j.plan_adherence_score}/10` : null,
        `| ${(j.notes || j.reflection || "").slice(0, 80)}`,
        j.lessons_learned ? `| lessons: ${j.lessons_learned.slice(0, 60)}` : null,
        j.ai_summary ? `| ai: ${j.ai_summary.slice(0, 60)}` : null,
      ]));
      parts.push(`[Journal Entries]\n${lines.join("\n")}`);
    }

    // 9. Strategy Config — NEW
    if (ctx.ftConfig) {
      const c = ctx.ftConfig;
      const lines = [];
      lines.push(_f([`  strategy:${c.strategy || "?"}`, `tf:${c.timeframe || "?"}`, `mode:${c.trading_mode || "spot"}`, `dry_run:${c.dry_run ?? "?"}`]));
      lines.push(_f([`  stoploss:${c.stoploss ?? "?"}`, c.trailing_stop ? `trailing:yes(pos:${c.trailing_stop_positive} offset:${c.trailing_stop_positive_offset})` : "trailing:no"]));
      if (c.minimal_roi) lines.push(`  ROI:${JSON.stringify(c.minimal_roi)}`);
      lines.push(`  max_open_trades:${c.max_open_trades ?? "?"}`);
      if (c.exchange?.name) lines.push(`  exchange:${c.exchange.name}`);
      const wl = c.exchange?.pair_whitelist;
      if (Array.isArray(wl)) lines.push(`  whitelist:${wl.length} pairs (${wl.slice(0, 5).join(", ")}${wl.length > 5 ? "..." : ""})`);
      if (c.freqai) {
        const fa = c.freqai;
        lines.push(`  freqai: ${fa.enabled ? 'enabled' : 'disabled'} model:${c.freqaimodel || '?'}`);
        if (fa.feature_parameters) {
          const fp = fa.feature_parameters;
          lines.push(`  features: periods:${JSON.stringify(fp.indicator_periods_candles || [])} tfs:${JSON.stringify(fp.include_timeframes || [])} shifts:${fp.include_shifted_candles || 0}`);
          const periods = (fp.indicator_periods_candles || []).length;
          const tfs = (fp.include_timeframes || []).length;
          const shifts = (fp.include_shifted_candles || 0) + 1;
          const approxFeatures = periods * tfs * shifts * 3 + 7; // 3 base (close/vol/hl) + 7 SMC
          lines.push(`  ~${approxFeatures} features, train:${fa.train_period_days || '?'}d, predict:${fa.feature_parameters?.label_period_candles || '?'} candles forward`);
        }
      }
      parts.push(`[Strategy Config]\n${lines.join("\n")}`);
    }

    // 10. Backtest Results (PB) — enriched
    const btPB = ctx.backtestResultsPB;
    if (Array.isArray(btPB) && btPB.length > 0) {
      const lines = btPB.slice(0, 3).map(r => _f([
        `  ${r.version || "?"}`,
        `| ${r.strategy_name || "?"}`,
        `| trades:${r.total_trades ?? "?"}`,
        r.wins != null && r.losses != null ? `(W:${r.wins} L:${r.losses})` : null,
        `profit:${r.profit_total_abs ?? "?"}USDT`,
        r.profit_total_pct != null ? `(${(Number(r.profit_total_pct) * 100).toFixed(1)}%)` : null,
        `WR:${r.winrate != null ? (Number(r.winrate) * 100).toFixed(1) : "?"}%`,
        `sharpe:${r.sharpe ?? "?"}`,
        r.sortino != null ? `sortino:${r.sortino}` : null,
        r.calmar != null ? `calmar:${r.calmar}` : null,
        r.profit_factor != null ? `PF:${r.profit_factor}` : null,
        `DD:${r.max_drawdown_abs ?? "?"}USDT`,
        r.max_drawdown_pct != null ? `(${(Number(r.max_drawdown_pct) * 100).toFixed(1)}%)` : null,
        r.avg_duration ? `avg_dur:${r.avg_duration}` : null,
        r.pairs_count != null ? `pairs:${r.pairs_count}` : null,
        r.timerange ? `range:${r.timerange}` : null,
        r.trading_mode ? `mode:${r.trading_mode}` : null,
        `tags:${JSON.stringify(r.tags || [])}`,
      ]));
      parts.push(`[Backtest Results from PB]\n${lines.join("\n")}`);
    }

    // 11. Backtest History (freqtrade files)
    const btHistory = ctx.backtestHistory;
    if (Array.isArray(btHistory) && btHistory.length > 0) {
      const lines = btHistory.slice(0, 3).map(b =>
        `  ${b.filename || "?"} | ${b.strategy || "?"} ${b.timeframe || "?"}`
      );
      parts.push(`[Backtest History (${btHistory.length} total)]\n${lines.join("\n")}`);
    }

    // 12. RAG Knowledge
    const ragResults = ctx.rag?.results;
    if (Array.isArray(ragResults) && ragResults.length > 0) {
      const lines = ragResults
        .filter(r => r.score > 0.5)
        .slice(0, 3)
        .map(r => `  [${r.category || r.type || "?"}] ${r._text || r.title || "?"}`);
      if (lines.length > 0) parts.push(`[Relevant Knowledge]\n${lines.join("\n")}`);
    }

    if (parts.length === 0) return "";
    return "\n\n--- Current Trading Context ---\n" + parts.join("\n") + "\n--- End Context ---";
  }

  // ── POST /lumitrader/chat — Main chat endpoint ───────────────────────────

  router.post("/lumitrader/chat", chatAuth, express.json({ limit: "2mb" }), async (req, res) => {
    try {
      const { messages, model, provider, stream } = req.body;
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "messages array required" });
      }

      // Fetch trading context and prepend to system prompt
      // Use last user message for RAG search; scope PB queries to the authenticated user
      const userId = req.user?.id || '';
      const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
      const userQuery = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
      let contextBlock = "";
      try {
        const ctx = await fetchTradingContext(userQuery, userId);
        contextBlock = formatTradingContext(ctx);
        const fs = require("fs");
        fs.appendFileSync("/tmp/lumitrader-debug.log", `[${new Date().toISOString()}] context sources: ` +
          JSON.stringify({positions:!!ctx.positions,pnl:!!ctx.pnl,btHistory:Array.isArray(ctx.backtestHistory)?ctx.backtestHistory.length:"null",btPB:Array.isArray(ctx.backtestResultsPB)?ctx.backtestResultsPB.length:"null",contextLen:contextBlock.length}) + "\n" +
          "contextBlock: " + contextBlock.slice(0, 500) + "\n---\n"
        );
        console.log("[lumitrader] context sources:",
          "positions:", !!ctx.positions,
          "pnl:", !!ctx.pnl,
          "signals:", !!ctx.signals,
          "history:", !!ctx.history,
          "journal:", !!ctx.journal,
          "mood:", !!ctx.mood,
          "rag:", !!ctx.rag,
          "btHistory:", Array.isArray(ctx.backtestHistory) ? ctx.backtestHistory.length : "null",
          "btPB:", Array.isArray(ctx.backtestResultsPB) ? ctx.backtestResultsPB.length : "null"
        );
        console.log("[lumitrader] contextBlock length:", contextBlock.length);
        if (contextBlock.length < 50) console.log("[lumitrader] WARNING: context nearly empty!", contextBlock);
      } catch (ctxErr) {
        console.error("[lumitrader] context fetch error:", ctxErr.message);
      }

      const systemPrompt = TRADING_SYSTEM_PROMPT + contextBlock;

      // Build messages: inject system prompt
      const outMessages = [...messages];
      const existingSys = outMessages.findIndex(m => m.role === "system");
      if (existingSys >= 0) {
        outMessages[existingSys] = {
          ...outMessages[existingSys],
          content: systemPrompt + "\n\n" + (outMessages[existingSys].content || ""),
        };
      } else {
        outMessages.unshift({ role: "system", content: systemPrompt });
      }

      const wantStream = stream !== false;

      // Always use streaming internally — /v1/chat non-streaming mode
      // truncates responses when tools are invoked. Streaming collects
      // the full AI response including post-tool-execution text.
      const upstreamBody = {
        messages: outMessages,
        model: model || "gpt-4o",
        provider: provider || "openai",
        stream: true, // always stream internally
      };

      const upstreamRes = await fetch(`${LUMIGATE_INTERNAL_URL}/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-App-Source": "lumitrade",
          "X-Project-Key": INTERNAL_CHAT_KEY || "",
        },
        body: JSON.stringify(upstreamBody),
      });

      const readable = upstreamRes.body;
      if (!readable) {
        if (wantStream) {
          res.setHeader("Content-Type", "text/event-stream");
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        return res.json({ choices: [{ message: { role: "assistant", content: "" } }] });
      }

      if (wantStream) {
        // Client wants streaming: pipe SSE through
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const reader = readable.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (res.writableEnded) break;
            res.write(decoder.decode(value, { stream: true }));
          }
        } catch (pipeErr) {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: pipeErr.message })}\n\n`);
          }
        } finally {
          if (!res.writableEnded) {
            res.write("data: [DONE]\n\n");
            res.end();
          }
        }
      } else {
        // Client wants JSON: collect full SSE stream, extract text
        const reader = readable.getReader();
        const decoder = new TextDecoder();
        let fullText = "";
        try {
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // Parse SSE lines
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // keep incomplete line
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const payload = line.slice(6).trim();
                if (payload === "[DONE]") continue;
                try {
                  const chunk = JSON.parse(payload);
                  // OpenAI-style SSE: choices[0].delta.content
                  const delta = chunk.choices?.[0]?.delta?.content;
                  if (delta) fullText += delta;
                  // Also handle direct content field
                  if (chunk.content) fullText += chunk.content;
                } catch { /* skip non-JSON lines */ }
              }
            }
          }
        } catch (collectErr) {
          console.error("[lumitrader] stream collect error:", collectErr.message);
        }
        return res.json({
          choices: [{
            message: { role: "assistant", content: fullText || "(No response generated)" },
            finish_reason: "stop",
          }],
        });
      }
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: "LumiTrader chat failed", detail: err.message });
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      }
    }
  });

  // ── Trade Sentinel — proactive AI scanner ─────────────────────────────

  async function tradeSentinel() {
    console.log("[sentinel] running scan...");
    try {
      // 1. Fetch all trading context (no user filter — system-level scan)
      const ctx = await fetchTradingContext("market scan", "");
      const contextBlock = formatTradingContext(ctx);

      if (contextBlock.length < 50) {
        console.log("[sentinel] skip: no context data");
        return;
      }

      // 2. Build sentinel prompt
      const sentinelPrompt = `你是 LumiTrader 后台哨兵 (Trade Sentinel)。你正在执行定期市场扫描。

分析以下交易上下文数据，检查是否有以下情况需要报告：

1. **入场机会**: 是否有 Tier 1/2 的 SMC 入场信号 (BOS/CHoCH + OB + FVG confluence)
2. **持仓风险**: 是否有持仓接近止损、DD 接近熔断线(3%)、或高度相关的持仓
3. **新闻影响**: 是否有 high impact 新闻可能影响当前持仓或策略
4. **策略异常**: 连亏检测、偏离回测预期、过度交易
5. **情绪预警**: 情绪分数过低、连续负面情绪

返回 JSON 格式 (不要返回其他内容):
{
  "action": "none" 或 "alert",
  "alerts": [
    {
      "type": "signal" | "risk" | "news" | "anomaly" | "mood",
      "severity": "critical" | "warning" | "info",
      "title": "简短标题",
      "message": "详细描述",
      "trade_plan": null 或 { "symbol": "BTC/USDT", "direction": "long", "entry": 67000, "sl": 65500, "tp": 70000, "risk_pct": 1.5 }
    }
  ]
}

如果一切正常没有需要报告的，返回 {"action": "none", "alerts": []}`;

      // 3. Call LumiGate /v1/chat with sentinel prompt (always stream internally)
      const upstreamBody = {
        messages: [
          { role: "system", content: sentinelPrompt + contextBlock },
          { role: "user", content: "执行定期扫描" },
        ],
        model: "claude-sonnet-4-6",  // Use Sonnet for cost efficiency on routine scans
        provider: "anthropic",
        stream: true,
      };

      const upstreamRes = await fetch(`${LUMIGATE_INTERNAL_URL}/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-App-Source": "lumitrade",
          "X-Project-Key": INTERNAL_CHAT_KEY || "",
        },
        body: JSON.stringify(upstreamBody),
      });

      // Collect streamed response
      const reader = upstreamRes.body?.getReader();
      if (!reader) { console.log("[sentinel] no response body"); return; }
      const decoder = new TextDecoder();
      let fullText = "";
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload);
              const delta = chunk.choices?.[0]?.delta?.content;
              if (delta) fullText += delta;
              if (chunk.content) fullText += chunk.content;
            } catch {}
          }
        }
      }

      // 4. Parse AI response
      let result;
      try {
        // Extract JSON from response (may have markdown code fences)
        const jsonMatch = fullText.match(/\{[\s\S]*\}/);
        result = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: "none", alerts: [] };
      } catch {
        console.log("[sentinel] failed to parse AI response:", fullText.slice(0, 200));
        return;
      }

      console.log("[sentinel] result:", result.action, "alerts:", result.alerts?.length || 0);

      // 5. Process alerts
      if (result.action === "alert" && Array.isArray(result.alerts) && result.alerts.length > 0) {
        for (const alert of result.alerts) {
          // Save to PB lt_notifications
          try {
            await tradePbFetch("/api/collections/lt_notifications/records", {
              method: "POST",
              body: JSON.stringify({
                type: alert.type || "analysis",
                severity: alert.severity || "info",
                title: alert.title || "Trade Alert",
                message: alert.message || "",
                trade_plan: alert.trade_plan || null,
                read: false,
              }),
            });
          } catch {}

          // Format Telegram message
          const severityIcon = { critical: "🔴", warning: "⚠️", info: "ℹ️" }[alert.severity] || "📊";
          let tgMsg = `${severityIcon} <b>${alert.title}</b>\n\n${alert.message}`;

          if (alert.trade_plan) {
            const tp = alert.trade_plan;
            tgMsg += `\n\n📈 Trade Plan:\n${tp.symbol} ${tp.direction?.toUpperCase()}\nEntry: ${tp.entry}  SL: ${tp.sl}  TP: ${tp.tp}\nRisk: ${tp.risk_pct}%`;
          }

          // Always send to Telegram
          await sendTelegram(tgMsg);
        }
      }
    } catch (err) {
      console.error("[sentinel] error:", err.message);
    }
  }

  // Sentinel scheduler — adaptive frequency
  let sentinelInterval = null;
  const SENTINEL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes default

  setTimeout(() => {
    console.log("[sentinel] starting periodic scan (every 15min)");
    tradeSentinel(); // first run
    sentinelInterval = setInterval(tradeSentinel, SENTINEL_INTERVAL_MS);
  }, 90_000); // 90s startup delay (after news fetch at 60s)

  // ── GET /lumitrader/settings — Get user trading preferences ───────────────

  router.get("/lumitrader/settings", lcAuth, async (req, res) => {
    try {
      const userId = req.user.id;

      const r = await tradePbFetch(
        `/api/collections/lt_user_settings/records?filter=(user_id='${userId}')&perPage=1`
      );
      if (!r.ok) {
        const err = await r.text().catch(() => "");
        return res.status(r.status).json({ error: "Failed to fetch settings", detail: err });
      }
      const data = await r.json();
      const record = data.items?.[0] || null;
      res.json({ ok: true, settings: record });
    } catch (err) {
      res.status(500).json({ error: "Settings fetch failed", detail: err.message });
    }
  });

  // ── POST /lumitrader/settings — Save user trading preferences ─────────────

  router.post("/lumitrader/settings", lcAuth, express.json(), async (req, res) => {
    try {
      const userId = req.user.id;
      const { settings } = req.body;
      if (!settings || typeof settings !== "object") return res.status(400).json({ error: "settings object required" });

      // Check if record exists
      const existing = await tradePbFetch(
        `/api/collections/lt_user_settings/records?filter=(user_id='${userId}')&perPage=1`
      );
      const existingData = existing.ok ? await existing.json() : { items: [] };
      const existingRecord = existingData.items?.[0];

      let r;
      if (existingRecord) {
        // Update existing
        r = await tradePbFetch(`/api/collections/lt_user_settings/records/${existingRecord.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ...settings, user_id: userId }),
        });
      } else {
        // Create new
        r = await tradePbFetch("/api/collections/lt_user_settings/records", {
          method: "POST",
          body: JSON.stringify({ ...settings, user_id: userId }),
        });
      }

      if (!r.ok) {
        const err = await r.text().catch(() => "");
        return res.status(r.status).json({ error: "Failed to save settings", detail: err });
      }
      const saved = await r.json();
      res.json({ ok: true, settings: saved });
    } catch (err) {
      res.status(500).json({ error: "Settings save failed", detail: err.message });
    }
  });

  // ── GET /lumitrader/sessions — List chat sessions ─────────────────────────

  router.get("/lumitrader/sessions", lcAuth, async (req, res) => {
    try {
      const userId = req.user.id;

      const page = parseInt(req.query.page) || 1;
      const perPage = Math.min(parseInt(req.query.perPage) || 20, 50);

      const r = await tradePbFetch(
        `/api/collections/lt_sessions/records?filter=(user_id='${userId}')&sort=-updated&page=${page}&perPage=${perPage}`
      );
      if (!r.ok) {
        const err = await r.text().catch(() => "");
        return res.status(r.status).json({ error: "Failed to fetch sessions", detail: err });
      }
      const data = await r.json();
      res.json({ ok: true, ...data });
    } catch (err) {
      res.status(500).json({ error: "Sessions fetch failed", detail: err.message });
    }
  });

  // ── POST /lumitrader/sessions — Create a chat session ─────────────────────

  router.post("/lumitrader/sessions", lcAuth, express.json(), async (req, res) => {
    try {
      const userId = req.user.id;
      const { title } = req.body;

      const r = await tradePbFetch("/api/collections/lt_sessions/records", {
        method: "POST",
        body: JSON.stringify({
          user_id: userId,
          title: title || "New Trading Chat",
          messages: [],
        }),
      });

      if (!r.ok) {
        const err = await r.text().catch(() => "");
        return res.status(r.status).json({ error: "Failed to create session", detail: err });
      }
      const created = await r.json();
      res.json({ ok: true, session: created });
    } catch (err) {
      res.status(500).json({ error: "Session create failed", detail: err.message });
    }
  });

  // ── Telegram command handlers ─────────────────────────────────────────────

  function mdToTelegram(text) {
    // Tables → monospace pre blocks
    text = text.replace(/(\|[^\n]+\|\n\|[-| :]+\|\n(?:\|[^\n]+\|\n?)+)/g, (table) => {
      const rows = table.trim().split("\n").filter(r => !r.match(/^\|[-| :]+\|$/));
      const cells = rows.map(r => r.split("|").filter(c => c.trim()).map(c => c.trim()));
      if (cells.length === 0) return table;
      const colW = [];
      for (const row of cells) row.forEach((c, i) => { colW[i] = Math.max(colW[i] || 0, c.replace(/<[^>]+>/g, "").length); });
      return "<pre>" + cells.map(row => row.map((c, i) => c.replace(/<[^>]+>/g, "").padEnd(colW[i] || 0)).join("  ")).join("\n") + "</pre>";
    });
    // Bold
    text = text.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
    // Italic
    text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
    // Code blocks
    text = text.replace(/```[\s\S]*?```/g, (m) => "<pre>" + m.slice(3, -3).trim() + "</pre>");
    // Inline code
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Headers → bold
    text = text.replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>");
    return text;
  }

  async function callAiForTelegram(chatId, userMessage) {
    // Keep typing indicator alive while AI thinks
    const typingTimer = setInterval(() => sendTyping(chatId), 4000);
    try {
      const ctx = await fetchTradingContext(userMessage, "");
      const contextBlock = formatTradingContext(ctx);
      const systemPrompt = TRADING_SYSTEM_PROMPT + contextBlock;

      const upstreamRes = await fetch(`${LUMIGATE_INTERNAL_URL}/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-App-Source": "lumitrade",
          "X-Project-Key": INTERNAL_CHAT_KEY || "",
        },
        body: JSON.stringify({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          stream: true,
        }),
      });

      // Stream and send in chunks — each section (split by \n\n) sent as separate message
      const reader = upstreamRes.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let fullText = "";
      let sseBuffer = "";
      let lastSentLen = 0;
      const CHUNK_THRESHOLD = 300; // send every ~300 chars or on double newline

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload);
              const delta = chunk.choices?.[0]?.delta?.content;
              if (delta) fullText += delta;
              if (chunk.content) fullText += chunk.content;
            } catch {}
          }
        }

        // Check if we have a complete section to send (double newline = paragraph break)
        const unsent = fullText.slice(lastSentLen);
        const breakIdx = unsent.lastIndexOf("\n\n");
        if (breakIdx > CHUNK_THRESHOLD) {
          const chunk = unsent.slice(0, breakIdx).trim();
          if (chunk) {
            const formatted = mdToTelegram(chunk);
            await sendTelegram(formatted, { chatId });
            lastSentLen += breakIdx + 2;
          }
        }
      }

      // Send remaining text
      const remaining = fullText.slice(lastSentLen).trim();
      if (remaining) {
        const formatted = mdToTelegram(remaining);
        if (formatted.length > 4000) {
          // Split long remaining into 4000-char chunks
          for (let i = 0; i < formatted.length; i += 4000) {
            await sendTelegram(formatted.slice(i, i + 4000), { chatId });
          }
        } else {
          await sendTelegram(formatted, { chatId });
        }
      }
      if (fullText.length === 0) {
        await sendTelegram("(No response)", { chatId });
      }
    } catch (err) {
      await sendTelegram(`Error: ${err.message}`, { chatId });
    } finally {
      clearInterval(typingTimer);
    }
  }

  async function sendTyping(chatId) {
    if (!TG_BOT_TOKEN) return;
    try {
      await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId || TG_CHAT_ID, action: "typing" }),
      });
    } catch {}
  }

  async function handleAiCommand(chatId, query) {
    await sendTyping(chatId);
    await callAiForTelegram(chatId, query);
  }

  async function handleSignalsCommand(chatId) {
    await sendTyping(chatId);
    await callAiForTelegram(chatId, "列出当前所有活跃的 SMC 交易信号，包括方向、入场价、止损、止盈、R:R、置信度。用表格格式。");
  }

  async function handleRiskCommand(chatId) {
    await sendTyping(chatId);
    await callAiForTelegram(chatId, "报告当前的风控状态：日亏损%、持仓数、最大回撤、连胜/连亏、情绪评分。有没有接近熔断线？");
  }

  async function handleNewsCommand(chatId) {
    await sendTyping(chatId);
    await callAiForTelegram(chatId, "总结最近的市场新闻和情绪。有没有 high impact 的新闻需要注意？对当前持仓有什么影响？");
  }

  async function handleJournalCommand(chatId) {
    await sendTyping(chatId);
    await callAiForTelegram(chatId, "生成今天的交易日志总结：交易次数、胜负、P&L、最佳/最差交易、情绪变化、经验教训。");
  }

  async function handleOptimizeCommand(chatId) {
    await sendTyping(chatId);
    await callAiForTelegram(chatId, "分析我的策略和回测结果，给出 3 个具体的优化建议，按优先级排序。包括参数调整、风控改进、pair 选择。");
  }

  // ── Freqtrade Telegram proxy — call freqtrade REST API, format in Chinese ──

  const FT_AUTH = "Basic " + Buffer.from("lumitrade:123123@").toString("base64");
  const FT_URL = TRADE_ENGINE_URL || "http://localhost:3200";

  async function ftApiCall(path) {
    try {
      const r = await engineFetch(path);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  async function handleFreqtradeStatus(chatId) {
    const data = await ftApiCall("/freqtrade/status");
    if (!data || (Array.isArray(data) && data.length === 0)) {
      await sendTelegram("当前没有开仓交易", { chatId });
      return;
    }
    const trades = Array.isArray(data) ? data : (data.open_trades || []);
    if (trades.length === 0) {
      await sendTelegram("当前没有开仓交易", { chatId });
      return;
    }
    let msg = `<b>当前持仓 (${trades.length})</b>\n\n`;
    for (const t of trades.slice(0, 10)) {
      const dir = t.is_short ? "空" : "多";
      const pnl = t.profit_abs != null ? (t.profit_abs >= 0 ? "+" : "") + Number(t.profit_abs).toFixed(2) : "?";
      const pct = t.profit_ratio != null ? (t.profit_ratio * 100).toFixed(1) + "%" : "?";
      const dur = t.trade_duration || "?";
      msg += `<b>${t.pair}</b> ${dir}\n`;
      msg += `  盈亏: ${pnl} USDT (${pct})\n`;
      msg += `  持仓时间: ${dur}\n`;
      msg += `  入场价: ${t.open_rate || "?"}\n\n`;
    }
    await sendTelegram(msg, { chatId });
  }

  async function handleFreqtradeProfit(chatId) {
    const data = await ftApiCall("/freqtrade/performance");
    const balance = await ftApiCall("/freqtrade/balance");
    let msg = "<b>盈亏统计</b>\n\n";
    if (balance) {
      msg += `总资产: ${Number(balance.total || 0).toLocaleString("en-US", {maximumFractionDigits: 2})} ${balance.currency || "USDT"}\n`;
      msg += `可用: ${Number(balance.free || 0).toLocaleString("en-US", {maximumFractionDigits: 2})} ${balance.currency || "USDT"}\n\n`;
    }
    if (Array.isArray(data) && data.length > 0) {
      msg += "<b>交易对表现:</b>\n";
      for (const p of data.slice(0, 10)) {
        const pnl = Number(p.profit_abs || 0);
        const sign = pnl >= 0 ? "+" : "";
        msg += `  ${p.pair}: ${sign}${pnl.toFixed(2)} USDT (${p.count || 0} 笔)\n`;
      }
    } else {
      msg += "暂无交易记录";
    }
    await sendTelegram(msg, { chatId });
  }

  async function handleFreqtradeBalance(chatId) {
    const data = await ftApiCall("/freqtrade/balance");
    if (!data) {
      await sendTelegram("无法获取余额信息", { chatId });
      return;
    }
    let msg = "<b>账户余额</b>\n\n";
    msg += `总资产: ${Number(data.total || 0).toLocaleString("en-US", {maximumFractionDigits: 2})} ${data.currency || "USDT"}\n`;
    msg += `可用余额: ${Number(data.free || 0).toLocaleString("en-US", {maximumFractionDigits: 2})} ${data.currency || "USDT"}\n`;
    msg += `已用: ${Number(data.used || 0).toLocaleString("en-US", {maximumFractionDigits: 2})} ${data.currency || "USDT"}\n`;
    if (data.currencies) {
      msg += "\n<b>币种明细:</b>\n";
      for (const c of data.currencies.filter(x => x.balance > 0).slice(0, 10)) {
        msg += `  ${c.currency}: ${Number(c.balance).toFixed(4)} (${Number(c.est_stake || 0).toFixed(2)} USDT)\n`;
      }
    }
    await sendTelegram(msg, { chatId });
  }

  async function handleFreqtradeCommand(chatId, action, successMsg) {
    try {
      const r = await engineFetch(`/freqtrade/${action}`, { method: "POST" });
      await sendTelegram(r.ok ? successMsg : `操作失败: ${action}`, { chatId });
    } catch (err) {
      await sendTelegram(`操作失败: ${err.message}`, { chatId });
    }
  }

  // ── Telegram webhook — handles slash commands and button callbacks ─────────

  router.post("/lumitrader/telegram/webhook", express.json(), async (req, res) => {
    res.json({ ok: true }); // respond immediately to Telegram

    try {
      const update = req.body;

      // Handle slash commands
      if (update.message?.text) {
        const text = update.message.text.trim();
        const chatId = update.message.chat.id;

        if (text === "/ai" || text.startsWith("/ai ")) {
          const query = text.slice(3).trim() || "快速分析当前市场状态，给出建议";
          await handleAiCommand(chatId, query);
        } else if (text === "/signals") {
          await handleSignalsCommand(chatId);
        } else if (text === "/risk") {
          await handleRiskCommand(chatId);
        } else if (text === "/news") {
          await handleNewsCommand(chatId);
        } else if (text === "/journal") {
          await handleJournalCommand(chatId);
        } else if (text === "/optimize") {
          await handleOptimizeCommand(chatId);
        } else if (text === "/status") {
          await handleFreqtradeStatus(chatId);
        } else if (text === "/profit") {
          await handleFreqtradeProfit(chatId);
        } else if (text === "/balance") {
          await handleFreqtradeBalance(chatId);
        } else if (text === "/start") {
          await handleFreqtradeCommand(chatId, "start", "交易已启动");
        } else if (text === "/stop") {
          await handleFreqtradeCommand(chatId, "stop", "交易已停止");
        } else if (text === "/help") {
          await sendTelegram(
            "<b>LumiTrader 指令</b>\n\n" +
            "<b>AI 分析:</b>\n" +
            "/ai [问题] — AI 智能分析\n" +
            "/signals — 当前交易信号\n" +
            "/risk — 风控状态检查\n" +
            "/news — 最新新闻情绪\n" +
            "/journal — 今日交易总结\n" +
            "/optimize — 策略优化建议\n\n" +
            "<b>交易控制:</b>\n" +
            "/status — 当前持仓状态\n" +
            "/profit — 盈亏统计\n" +
            "/balance — 账户余额\n" +
            "/start — 启动交易\n" +
            "/stop — 停止交易\n" +
            "/help — 显示此帮助",
            { chatId }
          );
        }
      }

      // Handle callback queries (inline keyboard button presses)
      if (update.callback_query) {
        const data = update.callback_query.data;
        const chatId = update.callback_query.message.chat.id;
        // Acknowledge the callback
        try {
          await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: update.callback_query.id }),
          });
        } catch {}

        if (data.startsWith("execute:")) {
          await sendTelegram("Executing...", { chatId });
          // TODO: parse trade plan from data and execute via trade-engine
        } else if (data.startsWith("reject:")) {
          await sendTelegram("Rejected.", { chatId });
        }
      }
    } catch (err) {
      console.error("[telegram] webhook error:", err.message);
    }
  });

  return { router };
};
