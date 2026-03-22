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
const LUMITRADE_PROJECT_KEY = process.env.LUMITRADE_PROJECT_KEY || "";
const FT_USERNAME = process.env.TRADE_FREQTRADE_USERNAME || "lumitrade";
const FT_PASSWORD = process.env.TRADE_FREQTRADE_PASSWORD || "changeme";
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
    if (!data.ok) {
      // Telegram HTML parse error → retry as plain text
      if (data.description?.includes("can't parse entities")) {
        const plainBody = { chat_id: body.chat_id, text: text.replace(/<[^>]+>/g, "") };
        const retry = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(plainBody),
        });
        const retryData = await retry.json();
        if (!retryData.ok) console.error("[lumitrader][telegram] plain text retry failed:", retryData.description);
        return retryData.ok;
      }
      console.error("[lumitrader][telegram] send failed:", data.description);
    }
    return data.ok;
  } catch (err) {
    console.error("[lumitrader][telegram] error:", err.message);
    return false;
  }
}

const TRADING_SYSTEM_PROMPT = `你是 LumiTrader，一个专业的 SMC/ICT 交易 AI 助手，服务于 LumiTrade 平台。
你可以用中文或英文回答，跟随用户的语言偏好。

## 你的实时数据源

每次对话自动注入以下 trading context（在消息末尾的 --- Current Trading Context --- 区块）：

| 数据块 | 标签 | 内容 |
|--------|------|------|
| 全部 Bot 状态 | [All Bots Status] | 6个 freqtrade bot 的在线状态、各自盈亏、open trades（Group A=标准, Group B=杠杆） |
| 持仓 | [Open Positions] | PB 记录的持仓（symbol/方向/入场价/SL/TP/uPnL/R值/SMC评分/结构/HTF bias） |
| 盈亏 | [P&L] | 当日/累计 PnL、胜率、连胜/连亏、最大回撤、平均R、最佳setup、各session PnL |
| 新闻 | [Recent News] | 最近10条新闻（含 finnhub/finbert/final 情绪评分、影响级别、分类） |
| 历史交易 | [Recent Trades] | 最近15笔交易（PnL/R值/MFE/MAE/setup类型/SMC评分/session/killzone/情绪/新闻情绪） |
| 情绪日志 | [Recent Mood] | 最近5条情绪记录（mood_label/score/energy/市场状况/连胜连亏/备注） |
| 交易日志 | [Journal Entries] | 最近8条日志（session/mood变化/plan执行评分/反思/lessons/AI总结） |
| 策略配置 | [Strategy Config] | 当前策略名/时间框架/trading_mode/dry_run/stoploss/trailing/ROI/FreqAI配置/交易对 |
| 信号 | [Recent Signals] | 最近5个交易信号（方向/置信度/入场价/SL/TP/R:R/时间框架/来源/新闻情绪） |
| 回测结果 | [Backtest Results from PB] | 最近3次回测（策略/交易数/胜率/利润/Sharpe/Sortino/Calmar/PF/回撤/时间范围） |
| 回测历史 | [Backtest History] | freqtrade 回测文件列表 |
| RAG 知识 | [Relevant Knowledge] | 与用户问题相关的知识库检索结果 |

**你必须主动引用这些数据来支撑分析和建议。** 不要泛泛而谈，用具体数字说话。

## 风控规则（绝对不可违反，任何建议都必须符合）

| 规则 | 限制 | 触发后果 |
|------|------|----------|
| 单笔最大仓位 | 2% of portfolio | 超过则拒绝/警告 |
| 日亏损熔断 | 3% | 触发后锁定交易30分钟，必须提醒用户 |
| 最多持仓数 | 5 | 满仓时不建议新开仓 |
| 最低 R:R | 2:1 | 低于此比例的入场一律不推荐 |
| 新闻黑窗期 | 重大新闻前30分钟 | 不开新仓 |

**检查流程**：每次给交易建议前，先检查 [P&L] 的 daily_pnl 是否接近 -3%，[Open Positions] 是否已有5个持仓，当前时间是否在新闻黑窗期内。如果任何风控条件触发，必须在回答最开头用醒目方式警告。

## 如何综合使用注入数据

### 给交易建议时的分析流程
1. **看大方向**：[Strategy Config] 的 HTF bias + [Recent Signals] 的方向 → 确定 bias
2. **看当前状态**：[Live Bot Status] 是否在线 + dry_run 模式 → 确定是实盘还是模拟
3. **看风控**：[P&L] 当日亏损 + [Open Positions] 持仓数 → 是否还能开仓
4. **看情绪**：[Recent Mood] 最新 mood_score → 如果 <4 或连亏 >=3，主动建议休息
5. **看新闻**：[Recent News] 的情绪评分 → 是否有重大利空/利多
6. **看历史验证**：[Recent Trades] 同类 setup 的历史胜率 + [Backtest Results] 的策略表现 → 验证建议可靠性
7. **看行为模式**：[Journal Entries] 的 plan_adherence_score + lessons → 是否有重复犯错

### 新闻情绪评分解读
情绪评分范围 -1.0 到 +1.0：
- **> +0.5**：强看涨信号，可作为入场的额外确认
- **+0.2 ~ +0.5**：温和看涨，中性偏多
- **-0.2 ~ +0.2**：中性，新闻不构成方向性影响
- **-0.5 ~ -0.2**：温和看跌，谨慎对待多头
- **< -0.5**：强看跌信号，多头应考虑减仓或不入场
- 优先看 final_sentiment（综合评分），其次 finbert（模型评分），最后 finnhub（API评分）
- 多条新闻情绪一致时，信号更强；情绪分歧时，降低置信度
- impact 字段：high > medium > low，high impact 新闻的情绪权重更大

### 回测数据引用规则
- [Backtest Results from PB] 是历史回测，**不是实盘**。引用时必须标注"回测数据显示..."
- 用回测来验证建议的可靠性：如果推荐某个 setup，查看回测中该策略的 WR/Sharpe/PF
- 回测 WR > 55% + Sharpe > 1.0 + PF > 1.5 → 策略有统计优势
- 回测 max_drawdown 要和风控规则匹配（日亏损 3% 限制）
- 回测样本量 < 30 笔交易时，统计意义不足，要明确说明
- **永远不要把回测数据当成实盘交易记录展示**

### 杠杆使用指导
**可以考虑杠杆的情况（仅限 futures 模式）：**
- 策略回测 Sharpe > 2.0 且 max_drawdown < 10%
- 当前 WR > 60% 且连胜 >= 3
- 高置信 Tier 1 信号（BOS/CHoCH + OB + FVG 三重 confluence + MTF 对齐）
- 新闻情绪强烈一致（> +0.5 或 < -0.5）
- 即使如此，杠杆不超过 3x，且仓位按杠杆倍数缩小（3x 杠杆 → 仓位从 2% 降到 0.7%）

**绝对不建议杠杆的情况：**
- 当日已有亏损（daily_pnl < 0）
- mood_score < 5 或连亏 >= 2
- 新闻情绪和交易方向矛盾
- 回测 max_drawdown > 15%
- [Strategy Config] 显示 dry_run: true（模拟盘不需要杠杆讨论）
- 用户是新手或没有明确表示理解杠杆风险

## 重要：区分数据来源
- [Live Bot Status] = 实时交易状态。dry_run 模式下所有交易都是模拟的，必须明确告知
- [Open Positions] = PB 记录的持仓，可能包含测试数据
- [Backtest Results] = 回测数据，不是实盘
- [Recent Trades] = 历史成交，检查 exit_reason 判断是正常退出还是止损

## 回答格式
- **结论先行**：第一句话就是答案/建议/操作，不要先铺垫
- 例如："建议不要入场。原因：..." 而不是 "让我分析一下...综上所述建议不要入场"
- 用表格和数字展示分析结果
- 关键数据加粗或用数字精确引用
- 风控警告放在最前面，用醒目格式

## 当前策略实现 (SMCStrategy.py)
- 时间框架: 15m 入场, 1h+4h 确认 (via informative_pairs)
- SMC 指标: smart-money-concepts 库 (BOS, CHoCH, OB, FVG, Liquidity, Swing H/L)
- 入场条件: BOS/CHoCH + 价格在 OB 区域 + FVG 存在 + 流动性足够
- 退出条件: CHoCH 反转信号 (use_exit_signal=True)
- Stoploss: -7.7% (固定), Trailing: +20.1%启动 +20.3%偏移
- Minimal ROI: 0分钟30.6%, 109分钟10.7%, 273分钟3.9%, 625分钟0%
- FreqAI (LumiLearning): LightGBM 预测12根K线前瞻收益, 作为入场过滤器
- 当前模式: spot, long-only (can_short=False)
- Hyperopt 优化过: swing_length=5, ob_strength_min=0.381

## 沟通风格
- 中英双语，跟随用户语言
- 数据为主，简洁直接
- 关键时刻关心交易者状态（连亏后主动问情绪，mood_score 低时建议休息）
- 发现行为模式问题时直接指出（FOMO、报复性交易、过度交易）`;

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
      ftStatus: null, ftConfig: null, news: null, econCalendar: null,
      allBotsStatus: null,
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

    const ftAuth = "Basic " + Buffer.from(`${FT_USERNAME}:${FT_PASSWORD}`).toString("base64");

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
      timed("pb/backtest_results", tradePbFetch("/api/collections/trade_backtest_results/records?perPage=10").then(r => r.ok ? r.json() : null)),
      // NEW: freqtrade live status
      timed("engine/ft-status", engineFetch("/freqtrade/status").then(r => r.ok ? r.json() : null)),
      // NEW: freqtrade config (strategy params)
      timed("engine/ft-config", engineFetch("/freqtrade/config").then(r => r.ok ? r.json() : null)),
      // NEW: recent news from PB
      timed("pb/trade_news", tradePbFetch("/api/collections/trade_news/records?perPage=10").then(r => r.ok ? r.json() : null)),
      // Fear & Greed Index (latest record with source="fear_greed")
      timed("pb/fear_greed", tradePbFetch(`/api/collections/trade_news/records?perPage=1&filter=${encodeURIComponent('news_source="fear_greed"')}`).then(r => r.ok ? r.json() : null)),
      // Economic calendar — upcoming high-impact events (news blackout data)
      timed("engine/econ-calendar", engineFetch("/economic-calendar?minutes_ahead=120").then(r => r.ok ? r.json() : null)),
      // All bots status (6 bots: 3 standard + 3 leveraged)
      timed("engine/all-bots", engineFetch("/freqtrade/all-bots-status").then(r => r.ok ? r.json() : null)),
    ];

    const [positions, pnl, signals, history, journal, mood, rag, backtestHistory, backtestResultsPB, ftStatus, ftConfig, news, fearGreed, econCalendar, allBotsStatus] = await Promise.all(tasks);
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
    ctx.fearGreed = fearGreed?.items?.[0] || null;
    ctx.econCalendar = econCalendar;
    ctx.allBotsStatus = allBotsStatus;

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
        econCalendar: ctx.econCalendar?.total ?? null,
        allBotsOnline: ctx.allBotsStatus?.online_count ?? null,
        allBotsTotalTrades: ctx.allBotsStatus?.total_open_trades ?? null,
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

    // 1. All Bots Status (6 bots: Group A standard + Group B leveraged)
    if (ctx.allBotsStatus && Array.isArray(ctx.allBotsStatus.bots)) {
      const botLines = [];
      botLines.push(`  ${ctx.allBotsStatus.online_count}/${ctx.allBotsStatus.bots.length} bots online, ${ctx.allBotsStatus.total_open_trades} total open trades`);
      for (const bot of ctx.allBotsStatus.bots) {
        if (!bot.online) {
          botLines.push(`  [${bot.group}] ${bot.name}: OFFLINE`);
          continue;
        }
        const profitStr = bot.profit
          ? `profit:${bot.profit.profit_all_coin ?? "?"}USDT (${bot.profit.profit_all_percent ?? "?"}%) closed:${bot.profit.trade_count ?? "?"}`
          : "profit:N/A";
        botLines.push(`  [${bot.group}] ${bot.name}: ${profitStr} open:${bot.trade_count}`);
        // Show up to 4 open trades per bot
        if (Array.isArray(bot.open_trades) && bot.open_trades.length > 0) {
          bot.open_trades.slice(0, 4).forEach(t => {
            botLines.push(`    ${t.pair} ${t.is_short ? "short" : "long"} profit:${t.profit_abs?.toFixed(2) ?? "?"}USDT (${((t.profit_ratio || 0) * 100).toFixed(1)}%) dur:${t.trade_duration || "?"}`);
          });
          if (bot.open_trades.length > 4) botLines.push(`    ... +${bot.open_trades.length - 4} more trades`);
        }
      }
      parts.push(`[All Bots Status]\n${botLines.join("\n")}`);
    } else if (ctx.ftStatus) {
      // Fallback: old single-bot status (if all-bots endpoint unavailable)
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

    // 4a. Fear & Greed Index (top-level market sentiment)
    if (ctx.fearGreed) {
      const fg = ctx.fearGreed;
      // Extract value from headline "Fear & Greed Index: 73 (Greed)"
      const match = (fg.headline || "").match(/Fear & Greed Index:\s*(\d+)\s*\(([^)]+)\)/);
      if (match) {
        const val = parseInt(match[1], 10);
        const cls = match[2];
        let comment = "";
        if (val >= 75) comment = "market is greedy — watch for corrections";
        else if (val >= 55) comment = "market leans greedy — stay disciplined";
        else if (val >= 45) comment = "market is neutral";
        else if (val >= 25) comment = "market leans fearful — potential opportunities";
        else comment = "extreme fear — contrarian buy signals possible";
        parts.push(`[Market Sentiment] Fear & Greed Index = ${val} (${cls}) — ${comment}`);
      }
    }

    // 4b. Economic Calendar — upcoming high-impact events
    if (ctx.econCalendar && Array.isArray(ctx.econCalendar.events) && ctx.econCalendar.events.length > 0) {
      const lines = ctx.econCalendar.events.slice(0, 8).map(ev => _f([
        `  ${ev.event}`,
        ev.country ? `(${ev.country})` : null,
        ev.minutes_until != null ? `in ${Math.round(ev.minutes_until)}min` : null,
        ev.estimate ? `est:${ev.estimate}` : null,
        ev.prev ? `prev:${ev.prev}` : null,
        ev.actual ? `actual:${ev.actual}` : null,
      ]));
      const blackoutNote = ctx.econCalendar.blackout_active
        ? ` — NEWS BLACKOUT ACTIVE (no new positions within ${ctx.econCalendar.blackout_minutes}min of event)`
        : "";
      parts.push(`[Upcoming Economic Events (${ctx.econCalendar.total})${blackoutNote}]\n${lines.join("\n")}`);
    }

    // 4c. Recent News
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

    // 5. Recent Trades (PB)
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

    // 6. Recent Mood
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

    // 7. Journal Entries
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

    // 8. Strategy Config
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
      // Entry signal grading (3-tier SMC entry system)
      lines.push(`  entry_signals: Primary (BOS/CHoCH+OB+FVG), Fallback (BOS/CHoCH+FVG), Minimal (FVG+liq_swept)`);
      parts.push(`[Strategy Config]\n${lines.join("\n")}`);
    }

    // 9. Recent Signals
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

    // 10. Backtest Results (PB) — cross-strategy comparison (up to 10 results)
    const btPB = ctx.backtestResultsPB;
    if (Array.isArray(btPB) && btPB.length > 0) {
      // Group by strategy for cross-bot comparison
      const byStrategy = {};
      for (const r of btPB) {
        const name = r.strategy_name || "Unknown";
        if (!byStrategy[name]) byStrategy[name] = [];
        byStrategy[name].push(r);
      }
      const strategyNames = Object.keys(byStrategy);
      const lines = btPB.slice(0, 10).map(r => _f([
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
      const header = strategyNames.length > 1
        ? `[Backtest Results — ${strategyNames.length} strategies: ${strategyNames.join(", ")}]`
        : `[Backtest Results from PB]`;
      parts.push(`${header}\n${lines.join("\n")}`);
    }

    // 11. Backtest History (freqtrade file list)
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
        model: model || "claude-sonnet-4-6",
        provider: provider || "anthropic",
        stream: true, // always stream internally
        tools: false, // LumiTrader has its own RAG context — disable /v1/chat agent tools to avoid Anthropic 400 errors
      };

      const upstreamRes = await fetch(`${LUMIGATE_INTERNAL_URL}/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-App-Source": "lumitrade",
          "X-Project-Key": INTERNAL_CHAT_KEY || LUMITRADE_PROJECT_KEY || "",
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
        tools: false, // Sentinel scan doesn't need agent tools
      };

      const upstreamRes = await fetch(`${LUMIGATE_INTERNAL_URL}/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-App-Source": "lumitrade",
          "X-Project-Key": INTERNAL_CHAT_KEY || LUMITRADE_PROJECT_KEY || "",
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
          const severityIcon = { critical: "\ud83d\udd34", warning: "\u26a0\ufe0f", info: "\u2139\ufe0f" }[alert.severity] || "\ud83d\udcca";
          let tgMsg = `${severityIcon} <b>${escHtml(alert.title)}</b>\n\n${escHtml(alert.message)}`;

          if (alert.trade_plan) {
            const tp = alert.trade_plan;
            const dir = (tp.direction || "").toLowerCase() === "long" ? "\u2b06\ufe0f\u505a\u591a" : "\u2b07\ufe0f\u505a\u7a7a";
            tgMsg += `\n\n\ud83c\udfaf <b>\u4ea4\u6613\u8ba1\u5212</b>\n`;
            tgMsg += `<b>${tp.symbol}</b> ${dir}\n`;
            tgMsg += `\u5165\u573a: ${tp.entry} | \u6b62\u635f: ${tp.sl} | \u6b62\u76c8: ${tp.tp}\n`;
            tgMsg += `\u4ed3\u4f4d: ${tp.risk_pct}%`;
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

  function escHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function mdToTelegram(text) {
    // 1. Escape HTML entities first to prevent Telegram parse errors (e.g. "< -3%" → "&lt; -3%")
    text = escHtml(text);
    // Tables → emoji + bold label format (Telegram pre blocks are too narrow for tables)
    text = text.replace(/(\|[^\n]+\|\n\|[-| :]+\|\n(?:\|[^\n]+\|\n?)+)/g, (table) => {
      const rows = table.trim().split("\n").filter(r => !r.match(/^\|[-| :]+\|$/));
      const cells = rows.map(r => r.split("|").filter(c => c.trim()).map(c => c.trim()));
      if (cells.length === 0) return table;
      const headers = cells[0];
      const dataRows = cells.slice(1);
      if (dataRows.length === 0) return table;
      // Format each data row as "header: value" pairs
      return dataRows.map(row => {
        return row.map((c, i) => {
          const label = headers[i] || "";
          return label ? `<b>${label}:</b> ${c}` : c;
        }).filter(Boolean).join("  |  ");
      }).join("\n");
    });
    // Bold
    text = text.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
    // Italic
    text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
    // Code blocks → keep short code blocks, but not for data display
    text = text.replace(/```[\s\S]*?```/g, (m) => {
      const inner = m.slice(3, -3).replace(/^\w+\n/, "").trim();
      // If it looks like data (has colons/pipes), format as plain text
      if (inner.includes("|") || (inner.split("\n").length > 2 && inner.includes(":"))) {
        return inner;
      }
      return "<pre>" + inner + "</pre>";
    });
    // Inline code
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Headers → bold
    text = text.replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>");
    // Bullet points: - or * at line start → bullet
    text = text.replace(/^[\s]*[-*]\s+/gm, "  \u2022 ");
    return text;
  }

  async function callAiForTelegram(chatId, userMessage, overrideModel) {
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
          "X-Project-Key": INTERNAL_CHAT_KEY || LUMITRADE_PROJECT_KEY || "",
        },
        body: JSON.stringify({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          model: overrideModel || getTgModel(chatId),
          provider: resolveProvider(overrideModel || getTgModel(chatId)),
          stream: true,
          tools: false, // LumiTrader Telegram has its own RAG context — disable agent tools
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
        await sendTelegram("(\u65e0\u54cd\u5e94)", { chatId });
      }
    } catch (err) {
      await sendTelegram(`\u274c \u9519\u8bef: ${err.message}`, { chatId });
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

  // Telegram format instruction appended to all AI prompts for clean output
  const TG_FORMAT_HINT = `

格式要求（你的回复将显示在 Telegram，不支持 markdown 表格）：
- 不要用 markdown 表格（| 分隔符），Telegram 无法正确显示
- 用 emoji + 粗体标签 + 换行来组织信息，例如：
  **BTC/USDT**
  方向: 做多 | 入场: 67,000
  止损: 65,500 | 止盈: 70,000
- 所有标签用中文（方向、入场价、止损、止盈、盈亏、余额、胜率 等）
- 关键数字用粗体
- 用 emoji 分隔不同区块（📊📡⚠️📰💰🎯📈📉✅❌🟢🔴）
- 简洁直接，不要长段落`;

  async function handleSignalsCommand(chatId) {
    await sendTyping(chatId);
    await callAiForTelegram(chatId, `列出当前所有活跃的 SMC 交易信号。对每个信号列出：交易对、方向（做多/做空）、信号类型、时间、信号强度/Tier。如果没有活跃信号就说"无活跃信号"。${TG_FORMAT_HINT}`);
  }

  async function handleRiskCommand(chatId) {
    await sendTyping(chatId);
    await callAiForTelegram(chatId, `报告当前风控状态，用以下格式逐项列出（每项用 🟢 正常 或 🔴 警告）：
- 日亏损: X% / 3% 上限
- 持仓数: X/5
- 杠杆使用情况
- 新闻黑窗期: 有/无
- 熔断状态: 已触发/未触发
- 情绪评分: X/10
- 连胜/连亏: X${TG_FORMAT_HINT}`);
  }

  async function handleNewsCommand(chatId) {
    await sendTyping(chatId);
    await callAiForTelegram(chatId, `总结最近的市场新闻和情绪。格式：
1. 先给出整体情绪判断（偏多/偏空/中性 + 分数）
2. 列出每条重要新闻，格式：📈/📉 + 标题 + 情绪分数 + 影响级别
3. 如果有 Fear & Greed 数据，单独列出
4. 说明对当前持仓的影响${TG_FORMAT_HINT}`);
  }

  async function handleJournalCommand(chatId) {
    await sendTyping(chatId);
    await callAiForTelegram(chatId, `生成今天的交易日志总结：
- 交易次数、胜负
- 盈亏金额和百分比
- 最佳/最差交易
- 情绪变化趋势
- 关键经验教训${TG_FORMAT_HINT}`);
  }

  async function handleOptimizeCommand(chatId) {
    await sendTyping(chatId);
    await callAiForTelegram(chatId, `分析我的策略和回测结果，给出 3 个具体的优化建议，按优先级排序。包括参数调整、风控改进、交易对选择。每个建议用编号 + emoji 标记。${TG_FORMAT_HINT}`);
  }

  async function handleAnalysisCommand(chatId) {
    await sendTyping(chatId);
    await callAiForTelegram(chatId, `综合所有可用数据（SMC 结构、新闻情绪、当前持仓、回测表现、时段、风控状态、bot 状态），分析当前是否有交易机会。

如果有机会，对每个 pair 用以下格式：
🎯 **BTC/USDT**
  方向: 做多
  入场: 67,000 | 止损: 65,500 | 止盈: 70,000
  R:R: 3.3 | 仓位: 1.5% | 置信度: 高
  Tier: 1 (BOS+OB+FVG)

如果没有好机会就直说，不要勉强。先说结论。${TG_FORMAT_HINT}`);
  }

  // ── Freqtrade Telegram proxy — call freqtrade REST API, format in Chinese ──

  const FT_AUTH = "Basic " + Buffer.from(`${FT_USERNAME}:${FT_PASSWORD}`).toString("base64");
  const FT_URL = TRADE_ENGINE_URL || "http://localhost:3200";

  async function ftApiCall(path) {
    try {
      const r = await engineFetch(path);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  async function handleFreqtradeStatus(chatId) {
    // Try all-bots endpoint first
    const allBots = await ftApiCall("/freqtrade/all-bots-status");
    if (allBots && Array.isArray(allBots.bots)) {
      let msg = "\ud83d\udcca <b>Bot \u72b6\u6001</b>\n";
      for (const bot of allBots.bots) {
        const icon = bot.online ? "\ud83d\udfe2" : "\ud83d\udd34";
        const mode = bot.dry_run !== false ? "Dry Run" : "Live";
        msg += `\n${icon} <b>${bot.name}</b> | ${mode}\n`;
        if (!bot.online) { msg += "  \u79bb\u7ebf\n"; continue; }
        const tradeCount = bot.trade_count ?? 0;
        const maxTrades = bot.max_open_trades ?? "?";
        msg += `  \u6301\u4ed3: ${tradeCount}/${maxTrades}\n`;
        if (bot.profit) {
          const totalPnl = Number(bot.profit.profit_all_coin ?? 0);
          const sign = totalPnl >= 0 ? "+" : "";
          msg += `  \u603b\u76c8\u4e8f: ${sign}${totalPnl.toFixed(2)} USDT\n`;
        }
        // Show open trades
        if (Array.isArray(bot.open_trades) && bot.open_trades.length > 0) {
          msg += "\n";
          for (const t of bot.open_trades.slice(0, 4)) {
            const dir = t.is_short ? "\u2b07\ufe0f\u7a7a" : "\u2b06\ufe0f\u591a";
            const pnl = t.profit_abs != null ? (t.profit_abs >= 0 ? "+" : "") + Number(t.profit_abs).toFixed(2) : "?";
            const pct = t.profit_ratio != null ? (t.profit_ratio * 100).toFixed(1) + "%" : "";
            msg += `  <b>${t.pair}</b> ${dir}\n`;
            msg += `    \u76c8\u4e8f: ${pnl} USDT (${pct})\n`;
            msg += `    \u5165\u573a: ${t.open_rate || "?"} | \u65f6\u957f: ${t.trade_duration || "?"}\n`;
          }
          if (bot.open_trades.length > 4) msg += `  ... +${bot.open_trades.length - 4} \u7b14\n`;
        }
      }
      await sendTelegram(msg, { chatId });
      return;
    }

    // Fallback: single bot status
    const data = await ftApiCall("/freqtrade/status");
    if (!data || (Array.isArray(data) && data.length === 0)) {
      await sendTelegram("\ud83d\udcca <b>Bot \u72b6\u6001</b>\n\n\u5f53\u524d\u6ca1\u6709\u5f00\u4ed3\u4ea4\u6613", { chatId });
      return;
    }
    const trades = Array.isArray(data) ? data : (data.open_trades || []);
    if (trades.length === 0) {
      await sendTelegram("\ud83d\udcca <b>Bot \u72b6\u6001</b>\n\n\u5f53\u524d\u6ca1\u6709\u5f00\u4ed3\u4ea4\u6613", { chatId });
      return;
    }
    let msg = `\ud83d\udcca <b>\u5f53\u524d\u6301\u4ed3 (${trades.length})</b>\n`;
    for (const t of trades.slice(0, 10)) {
      const dir = t.is_short ? "\u2b07\ufe0f\u7a7a" : "\u2b06\ufe0f\u591a";
      const pnl = t.profit_abs != null ? (t.profit_abs >= 0 ? "+" : "") + Number(t.profit_abs).toFixed(2) : "?";
      const pct = t.profit_ratio != null ? (t.profit_ratio * 100).toFixed(1) + "%" : "";
      msg += `\n<b>${t.pair}</b> ${dir}\n`;
      msg += `  \u76c8\u4e8f: ${pnl} USDT (${pct})\n`;
      msg += `  \u5165\u573a\u4ef7: ${t.open_rate || "?"} | \u65f6\u957f: ${t.trade_duration || "?"}\n`;
    }
    await sendTelegram(msg, { chatId });
  }

  async function handleFreqtradeProfit(chatId) {
    const data = await ftApiCall("/freqtrade/performance");
    const balance = await ftApiCall("/freqtrade/balance");
    const pnlRecord = await tradePbFetch("/api/collections/trade_pnl/records?perPage=1").then(r => r.ok ? r.json() : null).catch(() => null);
    const pnl = pnlRecord?.items?.[0] || null;

    let msg = "\ud83d\udcb0 <b>\u76c8\u4e8f\u7edf\u8ba1</b>\n\n";

    // P&L summary from PB
    if (pnl) {
      const daily = Number(pnl.daily_pnl ?? 0);
      const dailySign = daily >= 0 ? "+" : "";
      const cumul = Number(pnl.cumulative_pnl ?? 0);
      const cumulSign = cumul >= 0 ? "+" : "";
      msg += `\u4eca\u65e5: ${dailySign}$${daily.toFixed(2)}\n`;
      msg += `\u7d2f\u8ba1: ${cumulSign}$${cumul.toFixed(2)}\n`;
      if (pnl.win_rate != null) msg += `\u80dc\u7387: ${pnl.win_rate}%`;
      if (pnl.win_count != null && pnl.loss_count != null) msg += ` (${pnl.win_count}\u80dc ${pnl.loss_count}\u8d1f)`;
      msg += "\n";
      if (pnl.streak != null) {
        const s = Number(pnl.streak);
        msg += `\u8fde\u7eed: ${s > 0 ? "\u2705\u8fde\u80dc" + s : s < 0 ? "\u274c\u8fde\u4e8f" + Math.abs(s) : "\u65e0"}\n`;
      }
      if (pnl.max_drawdown != null) msg += `\u6700\u5927\u56de\u64a4: ${pnl.max_drawdown}%\n`;
    } else {
      msg += "\u4eca\u65e5: $0 (0%)\n\u7d2f\u8ba1: $0 (0%)\n\u80dc\u7387: -- (\u65e0\u4ea4\u6613)\n";
    }

    // Balance info
    if (balance) {
      const cur = balance.currency || "USDT";
      msg += `\n\ud83c\udfe6 <b>\u8d26\u6237</b>\n`;
      msg += `\u603b\u8d44\u4ea7: ${Number(balance.total || 0).toLocaleString("en-US", {maximumFractionDigits: 2})} ${cur}\n`;
      msg += `\u53ef\u7528: ${Number(balance.free || 0).toLocaleString("en-US", {maximumFractionDigits: 2})} ${cur}\n`;
    }

    // Per-pair performance
    if (Array.isArray(data) && data.length > 0) {
      msg += `\n\ud83d\udcc8 <b>\u4ea4\u6613\u5bf9\u8868\u73b0</b>\n`;
      for (const p of data.slice(0, 10)) {
        const pnlVal = Number(p.profit_abs || 0);
        const icon = pnlVal >= 0 ? "\ud83d\udfe2" : "\ud83d\udd34";
        const sign = pnlVal >= 0 ? "+" : "";
        msg += `${icon} ${p.pair}: ${sign}${pnlVal.toFixed(2)} USDT (${p.count || 0}\u7b14)\n`;
      }
    }

    await sendTelegram(msg, { chatId });
  }

  async function handleFreqtradeBalance(chatId) {
    const data = await ftApiCall("/freqtrade/balance");
    if (!data) {
      await sendTelegram("\ud83c\udfe6 <b>\u8d26\u6237\u4f59\u989d</b>\n\n\u26a0\ufe0f \u65e0\u6cd5\u83b7\u53d6\u4f59\u989d\u4fe1\u606f", { chatId });
      return;
    }
    const cur = data.currency || "USDT";
    const total = Number(data.total || 0);
    const free = Number(data.free || 0);
    const used = Number(data.used || 0);
    const usedPct = total > 0 ? ((used / total) * 100).toFixed(1) : "0";

    let msg = `\ud83c\udfe6 <b>\u8d26\u6237\u4f59\u989d</b>\n\n`;
    msg += `\u603b\u8d44\u4ea7: <b>${total.toLocaleString("en-US", {maximumFractionDigits: 2})} ${cur}</b>\n`;
    msg += `\u53ef\u7528: ${free.toLocaleString("en-US", {maximumFractionDigits: 2})} ${cur}\n`;
    msg += `\u5df2\u7528: ${used.toLocaleString("en-US", {maximumFractionDigits: 2})} ${cur} (${usedPct}%)\n`;

    if (data.currencies) {
      const nonZero = data.currencies.filter(x => x.balance > 0);
      if (nonZero.length > 0) {
        msg += `\n\ud83d\udcb1 <b>\u5e01\u79cd\u660e\u7ec6</b>\n`;
        for (const c of nonZero.slice(0, 10)) {
          const bal = Number(c.balance);
          const est = Number(c.est_stake || 0);
          msg += `  ${c.currency}: ${bal.toFixed(4)} (\u2248 ${est.toFixed(2)} ${cur})\n`;
        }
      }
    }
    await sendTelegram(msg, { chatId });
  }

  async function handleFreqtradeCommand(chatId, action, successMsg) {
    try {
      const r = await engineFetch(`/freqtrade/${action}`, { method: "POST" });
      await sendTelegram(r.ok ? `\u2705 ${successMsg}` : `\u274c \u64cd\u4f5c\u5931\u8d25: ${action}`, { chatId });
    } catch (err) {
      await sendTelegram(`\u274c \u64cd\u4f5c\u5931\u8d25: ${err.message}`, { chatId });
    }
  }

  // ── Per-chat model preference ────────────────────────────────────────────
  const _tgModelPref = {}; // chatId → model name
  const TG_MODELS = {
    "opus": "claude-opus-4-6",
    "sonnet": "claude-sonnet-4-6",
    "haiku": "claude-haiku-4-5-20251001",
    "gpt4o": "gpt-4o",
    "gpt5": "gpt-5",
    "gpt-5": "gpt-5",
    "gpt5.4": "gpt-5.4",
    "gpt-5.4": "gpt-5.4",
    "o4-mini": "o4-mini",
    "o4mini": "o4-mini",
    "deepseek": "deepseek-chat",
  };

  function getTgModel(chatId) {
    return _tgModelPref[chatId] || "claude-sonnet-4-6";
  }

  function resolveProvider(modelId) {
    const m = (modelId || "").toLowerCase();
    if (m.startsWith("gpt") || m.startsWith("o4") || m.startsWith("o3") || m.startsWith("o1")) return "openai";
    if (m.startsWith("deepseek")) return "deepseek";
    if (m.startsWith("gemini")) return "gemini";
    if (m.startsWith("qwen")) return "qwen";
    return "anthropic";
  }

  // ── Telegram webhook — handles slash commands and button callbacks ─────────

  router.post("/lumitrader/telegram/webhook", express.json(), async (req, res) => {
    res.json({ ok: true }); // respond immediately to Telegram

    try {
      const update = req.body;

      // Handle slash commands and free-form chat
      if (update.message?.text) {
        const text = update.message.text.trim();
        const chatId = update.message.chat.id;

        if (text === "/ai" || text.startsWith("/ai ")) {
          const query = text.slice(3).trim();
          if (!query) {
            await sendTelegram("\ud83e\udde0 <b>AI \u667a\u80fd\u5206\u6790</b>\n\n\u9009\u62e9\u5feb\u6377\u95ee\u9898\uff0c\u6216\u76f4\u63a5\u53d1\u6587\u5b57\u63d0\u95ee:", {
              chatId,
              replyMarkup: { inline_keyboard: [
                [{ text: "\ud83d\udcca \u5e02\u573a\u5206\u6790", callback_data: "ai:\u73b0\u5728\u5e02\u573a\u600e\u4e48\u6837" }, { text: "\ud83c\udfaf \u5165\u573a\u5efa\u8bae", callback_data: "ai:\u73b0\u5728\u9002\u5408\u5f00\u4ed3\u5417" }],
                [{ text: "\u26a0\ufe0f \u98ce\u63a7\u68c0\u67e5", callback_data: "ai:\u6211\u7684\u98ce\u63a7\u72b6\u6001\u5982\u4f55" }, { text: "\ud83d\udcf0 \u65b0\u95fb\u60c5\u7eea", callback_data: "ai:\u6700\u8fd1\u65b0\u95fb\u60c5\u7eea\u5982\u4f55" }],
              ] },
            });
          } else {
            await handleAiCommand(chatId, query);
          }
        } else if (text === "/signals") {
          await sendTelegram("\ud83d\udce1 <b>\u4ea4\u6613\u4fe1\u53f7</b>\n\n\u9009\u62e9\u8981\u67e5\u770b\u7684\u4ea4\u6613\u5bf9:", {
            chatId,
            replyMarkup: { inline_keyboard: [
              [{ text: "BTC", callback_data: "signals:BTC" }, { text: "ETH", callback_data: "signals:ETH" }, { text: "SOL", callback_data: "signals:SOL" }],
              [{ text: "\u5168\u90e8\u4fe1\u53f7", callback_data: "signals:all" }],
            ] },
          });
        } else if (text === "/risk") {
          await handleRiskCommand(chatId);
        } else if (text === "/news") {
          await handleNewsCommand(chatId);
        } else if (text === "/journal") {
          await handleJournalCommand(chatId);
        } else if (text === "/optimize") {
          await handleOptimizeCommand(chatId);
        } else if (text === "/analysis") {
          await handleAnalysisCommand(chatId);
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
        } else if (text === "/model" || text.startsWith("/model ")) {
          const arg = text.slice(6).trim().toLowerCase();
          if (!arg) {
            const current = getTgModel(chatId);
            await sendTelegram(`\ud83e\udd16 <b>\u5f53\u524d\u6a21\u578b:</b> ${current}\n\n\u70b9\u51fb\u6309\u94ae\u5207\u6362:`, {
              chatId,
              replyMarkup: { inline_keyboard: [
                [{ text: `Claude Opus${current === "claude-opus-4-6" ? " ✓" : ""}`, callback_data: "model:claude-opus-4-6" }, { text: `Claude Sonnet${current === "claude-sonnet-4-6" ? " ✓" : ""}`, callback_data: "model:claude-sonnet-4-6" }],
                [{ text: `GPT-5.4${current === "gpt-5.4" ? " ✓" : ""}`, callback_data: "model:gpt-5.4" }, { text: `GPT-4o${current === "gpt-4o" ? " ✓" : ""}`, callback_data: "model:gpt-4o" }],
                [{ text: `DeepSeek${current === "deepseek-chat" ? " ✓" : ""}`, callback_data: "model:deepseek-chat" }, { text: `Haiku${current === "claude-haiku-4-5-20251001" ? " ✓" : ""}`, callback_data: "model:claude-haiku-4-5-20251001" }],
              ] },
            });
          } else if (TG_MODELS[arg]) {
            _tgModelPref[chatId] = TG_MODELS[arg];
            await sendTelegram(`\u2705 \u5df2\u5207\u6362\u6a21\u578b: <b>${TG_MODELS[arg]}</b>`, { chatId });
          } else {
            await sendTelegram(`\u274c \u672a\u77e5\u6a21\u578b: ${escHtml(arg)}\n\u53ef\u9009: ${Object.keys(TG_MODELS).join(", ")}`, { chatId });
          }
        } else if (text === "/help") {
          await sendTelegram(
            "\ud83e\udd16 <b>LumiTrader \u6307\u4ee4</b>\n\n" +
            "\ud83e\udde0 <b>AI \u5206\u6790</b>\n" +
            "/ai [\u95ee\u9898] \u2014 AI \u667a\u80fd\u5206\u6790\n" +
            "/signals \u2014 \u5f53\u524d\u4ea4\u6613\u4fe1\u53f7\n" +
            "/risk \u2014 \u98ce\u63a7\u72b6\u6001\u68c0\u67e5\n" +
            "/news \u2014 \u6700\u65b0\u65b0\u95fb\u60c5\u7eea\n" +
            "/journal \u2014 \u4eca\u65e5\u4ea4\u6613\u603b\u7ed3\n" +
            "/optimize \u2014 \u7b56\u7565\u4f18\u5316\u5efa\u8bae\n" +
            "/analysis \u2014 \u626b\u63cf\u5f53\u524d\u4ea4\u6613\u673a\u4f1a\n" +
            "/model [\u540d\u79f0] \u2014 \u5207\u6362 AI \u6a21\u578b\n\n" +
            "\ud83d\udcca <b>\u4ea4\u6613\u63a7\u5236</b>\n" +
            "/status \u2014 Bot \u72b6\u6001 + \u6301\u4ed3\n" +
            "/profit \u2014 \u76c8\u4e8f\u7edf\u8ba1\n" +
            "/balance \u2014 \u8d26\u6237\u4f59\u989d\n" +
            "/start \u2014 \u542f\u52a8\u4ea4\u6613\n" +
            "/stop \u2014 \u505c\u6b62\u4ea4\u6613\n" +
            "/help \u2014 \u663e\u793a\u6b64\u5e2e\u52a9\n\n" +
            "\ud83d\udcac <i>\u76f4\u63a5\u53d1\u6587\u5b57 = \u548c AI \u5bf9\u8bdd\uff08\u4e0d\u9700\u8981\u52a0 /ai\uff09</i>",
            {
              chatId,
              replyMarkup: { inline_keyboard: [
                [{ text: "🤖 AI 分析", callback_data: "cmd:/ai" }, { text: "📊 信号", callback_data: "cmd:/signals" }],
                [{ text: "⚠️ 风控", callback_data: "cmd:/risk" }, { text: "📰 新闻", callback_data: "cmd:/news" }],
                [{ text: "🔧 切换模型", callback_data: "cmd:/model" }, { text: "📈 状态", callback_data: "cmd:/status" }],
              ] },
            }
          );
        } else if (!text.startsWith("/")) {
          // Non-slash text → treat as AI chat
          await handleAiCommand(chatId, text);
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

        if (data.startsWith("model:")) {
          const modelId = data.slice(6);
          _tgModelPref[chatId] = modelId;
          await sendTelegram(`\u2705 \u5df2\u5207\u6362\u6a21\u578b: <b>${modelId}</b>`, { chatId });
        } else if (data.startsWith("ai:")) {
          const query = data.slice(3);
          await sendTelegram(`\ud83e\udde0 \u6b63\u5728\u5206\u6790: <i>${escHtml(query)}</i>`, { chatId });
          await handleAiCommand(chatId, query);
        } else if (data.startsWith("signals:")) {
          const pair = data.slice(8);
          if (pair === "all") {
            await handleSignalsCommand(chatId);
          } else {
            await sendTyping(chatId);
            await callAiForTelegram(chatId, `列出 ${pair} 的当前 SMC 交易信号，包括方向、入场价、止损、止盈、R:R、置信度。用表格格式。`);
          }
        } else if (data.startsWith("cmd:")) {
          const cmd = data.slice(4);
          if (cmd === "/ai") {
            await sendTelegram("\ud83e\udde0 <b>AI \u667a\u80fd\u5206\u6790</b>\n\n\u9009\u62e9\u5feb\u6377\u95ee\u9898\uff0c\u6216\u76f4\u63a5\u53d1\u6587\u5b57\u63d0\u95ee:", {
              chatId,
              replyMarkup: { inline_keyboard: [
                [{ text: "\ud83d\udcca \u5e02\u573a\u5206\u6790", callback_data: "ai:\u73b0\u5728\u5e02\u573a\u600e\u4e48\u6837" }, { text: "\ud83c\udfaf \u5165\u573a\u5efa\u8bae", callback_data: "ai:\u73b0\u5728\u9002\u5408\u5f00\u4ed3\u5417" }],
                [{ text: "\u26a0\ufe0f \u98ce\u63a7\u68c0\u67e5", callback_data: "ai:\u6211\u7684\u98ce\u63a7\u72b6\u6001\u5982\u4f55" }, { text: "\ud83d\udcf0 \u65b0\u95fb\u60c5\u7eea", callback_data: "ai:\u6700\u8fd1\u65b0\u95fb\u60c5\u7eea\u5982\u4f55" }],
              ] },
            });
          } else if (cmd === "/signals") {
            await sendTelegram("\ud83d\udce1 <b>\u4ea4\u6613\u4fe1\u53f7</b>\n\n\u9009\u62e9\u8981\u67e5\u770b\u7684\u4ea4\u6613\u5bf9:", {
              chatId,
              replyMarkup: { inline_keyboard: [
                [{ text: "BTC", callback_data: "signals:BTC" }, { text: "ETH", callback_data: "signals:ETH" }, { text: "SOL", callback_data: "signals:SOL" }],
                [{ text: "\u5168\u90e8\u4fe1\u53f7", callback_data: "signals:all" }],
              ] },
            });
          } else if (cmd === "/model") {
            const current = getTgModel(chatId);
            await sendTelegram(`\ud83e\udd16 <b>\u5f53\u524d\u6a21\u578b:</b> ${current}\n\n\u70b9\u51fb\u6309\u94ae\u5207\u6362:`, {
              chatId,
              replyMarkup: { inline_keyboard: [
                [{ text: `Claude Opus${current === "claude-opus-4-6" ? " ✓" : ""}`, callback_data: "model:claude-opus-4-6" }, { text: `Claude Sonnet${current === "claude-sonnet-4-6" ? " ✓" : ""}`, callback_data: "model:claude-sonnet-4-6" }],
                [{ text: `GPT-5.4${current === "gpt-5.4" ? " ✓" : ""}`, callback_data: "model:gpt-5.4" }, { text: `GPT-4o${current === "gpt-4o" ? " ✓" : ""}`, callback_data: "model:gpt-4o" }],
                [{ text: `DeepSeek${current === "deepseek-chat" ? " ✓" : ""}`, callback_data: "model:deepseek-chat" }, { text: `Haiku${current === "claude-haiku-4-5-20251001" ? " ✓" : ""}`, callback_data: "model:claude-haiku-4-5-20251001" }],
              ] },
            });
          } else if (cmd === "/risk") {
            await handleRiskCommand(chatId);
          } else if (cmd === "/news") {
            await handleNewsCommand(chatId);
          } else if (cmd === "/status") {
            await handleFreqtradeStatus(chatId);
          }
        } else if (data.startsWith("execute:")) {
          await sendTelegram("\u23f3 \u6267\u884c\u4e2d...", { chatId });
          // TODO: parse trade plan from data and execute via trade-engine
        } else if (data.startsWith("reject:")) {
          await sendTelegram("\u274c \u5df2\u53d6\u6d88", { chatId });
        }
      }
    } catch (err) {
      console.error("[telegram] webhook error:", err.message);
    }
  });

  return { router };
};
