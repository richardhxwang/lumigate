/**
 * routes/trade.js — LumiTrade glue layer
 *
 * Proxies requests between the Node.js LumiGate server and the Python
 * Trade Engine (FastAPI), and provides direct PocketBase access for
 * trade data collections.
 *
 * Factory function pattern — same as lumichat.js.
 */
const express = require("express");
const http = require("http");
const { URL } = require("url");

const TRADE_ENGINE_URL = process.env.TRADE_ENGINE_URL || "http://localhost:3200";
const PB_TRADE_PROJECT = (process.env.PB_TRADE_PROJECT || "lumitrade").trim() || "lumitrade";
const FREQTRADE_URL = process.env.TRADE_FREQTRADE_URL || "http://lumigate-freqtrade:8080";
const FREQTRADE_BT_URL = process.env.TRADE_FREQTRADE_BT_URL || "http://lumigate-freqtrade-bt:8080";
const FREQTRADE_USERNAME = process.env.TRADE_FREQTRADE_USERNAME || "lumitrade";
const FREQTRADE_PASSWORD = process.env.TRADE_FREQTRADE_PASSWORD || "123123@";

module.exports = function createTradeRouter(deps) {
  const router = express.Router();
  const { PB_URL, getPbAdminToken } = deps;

  // ── PocketBase project isolation ──────────────────────────────────────────

  /** Transform plain PB path to project-scoped path: /api/collections/trade_* → /api/p/lumitrade/collections/trade_* */
  function toTradeProjectPath(pbPath) {
    const p = String(pbPath || "");
    if (p.startsWith(`/api/p/${PB_TRADE_PROJECT}/`)) return p;
    if (p.startsWith("/api/collections/")) return `/api/p/${PB_TRADE_PROJECT}${p.slice("/api".length)}`;
    if (p.startsWith("/api/files/")) return `/api/p/${PB_TRADE_PROJECT}${p.slice("/api".length)}`;
    return p;
  }

  /** PocketBase fetch with project scoping + cached admin token */
  async function tradePbFetch(path, options = {}) {
    const p = String(path || "");
    const target = toTradeProjectPath(p);
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };

    // Use cached admin token (shared with server.js, 30-min TTL, coalesced)
    if (!headers["Authorization"] && getPbAdminToken) {
      const adminToken = await getPbAdminToken();
      if (adminToken) headers["Authorization"] = adminToken;
    }

    const fetchOptions = { ...options, headers };
    const url = `${PB_URL}${target}`;

    // Try project-scoped path first, fall back to unscoped if it fails
    if (target !== p) {
      try {
        const scoped = await fetch(url, fetchOptions);
        if (scoped.ok) return scoped;
      } catch { /* fall through to unscoped */ }
      return fetch(`${PB_URL}${p}`, fetchOptions);
    }
    return fetch(url, fetchOptions);
  }

  /** Proxy fetch to Trade Engine */
  async function engineFetch(path, options = {}) {
    const url = `${TRADE_ENGINE_URL}${path}`;
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    return fetch(url, { ...options, headers });
  }

  // ── Engine proxy routes ───────────────────────────────────────────────────

  // GET /v1/trade/health — check trade engine health
  router.get("/health", async (_req, res) => {
    try {
      const r = await engineFetch("/health");
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // POST /v1/trade/analyze — analyze symbol
  router.post("/analyze", async (req, res) => {
    try {
      const r = await engineFetch("/analyze", { method: "POST", body: JSON.stringify(req.body) });
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // POST /v1/trade/risk-check — risk check
  router.post("/risk-check", async (req, res) => {
    try {
      const r = await engineFetch("/risk-check", { method: "POST", body: JSON.stringify(req.body) });
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // POST /v1/trade/execute — execute trade
  router.post("/execute", async (req, res) => {
    try {
      const r = await engineFetch("/execute", { method: "POST", body: JSON.stringify(req.body) });
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // POST /v1/trade/backtest — run backtest
  router.post("/backtest", async (req, res) => {
    try {
      const r = await engineFetch("/backtest", { method: "POST", body: JSON.stringify(req.body) });
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // GET /v1/trade/market/:symbol — market data
  router.get("/market/:symbol", async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      const path = `/market/${encodeURIComponent(req.params.symbol)}${qs ? `?${qs}` : ""}`;
      const r = await engineFetch(path);
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // ── IBKR-specific engine proxy routes ─────────────────────────────────────

  // GET /v1/trade/ibkr/status — IBKR connection status
  router.get("/ibkr/status", async (_req, res) => {
    try {
      const r = await engineFetch("/ibkr/status");
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // GET /v1/trade/ibkr/positions — IBKR positions
  router.get("/ibkr/positions", async (_req, res) => {
    try {
      const r = await engineFetch("/ibkr/positions");
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // GET /v1/trade/ibkr/account — IBKR account summary
  router.get("/ibkr/account", async (_req, res) => {
    try {
      const r = await engineFetch("/ibkr/account");
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // GET /v1/trade/ibkr/history/:symbol — IBKR historical data for symbol
  router.get("/ibkr/history/:symbol", async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      const path = `/ibkr/history/${encodeURIComponent(req.params.symbol)}${qs ? `?${qs}` : ""}`;
      const r = await engineFetch(path);
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // POST /v1/trade/ibkr/order — place IBKR order
  router.post("/ibkr/order", async (req, res) => {
    try {
      const r = await engineFetch("/ibkr/order", { method: "POST", body: JSON.stringify(req.body) });
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // ── Freqtrade proxy routes ──────────────────────────────────────────────

  // GET /v1/trade/freqtrade/status — freqtrade connection + open trades
  router.get("/freqtrade/status", async (req, res) => {
    try {
      const r = await engineFetch("/freqtrade/status");
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // GET /v1/trade/freqtrade/trades — trade history
  router.get("/freqtrade/trades", async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      const r = await engineFetch(`/freqtrade/trades${qs ? `?${qs}` : ""}`);
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // GET /v1/trade/freqtrade/performance — pair performance
  router.get("/freqtrade/performance", async (req, res) => {
    try {
      const r = await engineFetch("/freqtrade/performance");
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // GET /v1/trade/freqtrade/balance — wallet balance
  router.get("/freqtrade/balance", async (req, res) => {
    try {
      const r = await engineFetch("/freqtrade/balance");
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // ── Unified endpoints (IBKR + Crypto combined) ──────────────────────────

  // GET /v1/trade/unified/pairs — all tradeable pairs (crypto + stocks)
  router.get("/unified/pairs", async (req, res) => {
    try {
      const r = await engineFetch("/unified/pairs");
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // GET /v1/trade/unified/positions — merged positions from all brokers
  router.get("/unified/positions", async (req, res) => {
    try {
      const r = await engineFetch("/unified/positions");
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // GET /v1/trade/unified/history — merged trade history
  router.get("/unified/history", async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      const r = await engineFetch(`/unified/history${qs ? `?${qs}` : ""}`);
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // ── PocketBase data routes ────────────────────────────────────────────────

  // GET /v1/trade/signals — list signals
  router.get("/signals", async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      const r = await tradePbFetch(`/api/collections/trade_signals/records${qs ? `?${qs}` : ""}`);
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: "Failed to fetch signals", detail: err.message });
    }
  });

  // GET /v1/trade/positions — list positions
  router.get("/positions", async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      const r = await tradePbFetch(`/api/collections/trade_positions/records${qs ? `?${qs}` : ""}`);
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: "Failed to fetch positions", detail: err.message });
    }
  });

  // GET /v1/trade/history — trade history
  router.get("/history", async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      const r = await tradePbFetch(`/api/collections/trade_history/records${qs ? `?${qs}` : ""}`);
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: "Failed to fetch trade history", detail: err.message });
    }
  });

  // GET /v1/trade/pnl — P&L summary
  router.get("/pnl", async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      const r = await tradePbFetch(`/api/collections/trade_pnl/records${qs ? `?${qs}` : ""}`);
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: "Failed to fetch P&L data", detail: err.message });
    }
  });

  // ── Trading journal ──────────────────────────────────────────────────────

  // GET /v1/trade/journal — list journal entries
  router.get("/journal", async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      const r = await tradePbFetch(`/api/collections/trade_journal/records${qs ? `?${qs}` : ""}`);
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: "Failed to fetch journal", detail: err.message });
    }
  });

  // POST /v1/trade/journal — create/update journal entry
  router.post("/journal", async (req, res) => {
    try {
      const r = await tradePbFetch("/api/collections/trade_journal/records", {
        method: "POST",
        body: JSON.stringify(req.body),
      });
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: "Failed to save journal", detail: err.message });
    }
  });

  // GET /v1/trade/journal/analytics — session/killzone analytics
  router.get("/journal/analytics", async (req, res) => {
    try {
      const r = await engineFetch(`/journal/analytics?${new URLSearchParams(req.query)}`);
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // ── Mood tracking ──────────────────────────────────────────────────────

  // GET /v1/trade/mood/analysis — mood-performance correlation
  router.get("/mood/analysis", async (req, res) => {
    try {
      const r = await engineFetch("/journal/mood-analysis");
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // POST /v1/trade/mood/log — log a mood entry
  router.post("/mood/log", async (req, res) => {
    try {
      const r = await tradePbFetch("/api/collections/trade_mood_logs/records", {
        method: "POST",
        body: JSON.stringify(req.body),
      });
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: "Failed to log mood", detail: err.message });
    }
  });

  // GET /v1/trade/mood/logs — list mood logs
  router.get("/mood/logs", async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      const r = await tradePbFetch(`/api/collections/trade_mood_logs/records${qs ? `?${qs}` : ""}`);
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: "Failed to fetch mood logs", detail: err.message });
    }
  });

  // ── RAG (Retrieval-Augmented Generation) ────────────────────────────────

  // GET /v1/trade/rag/search — search trading RAG
  router.get("/rag/search", async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      const r = await engineFetch(`/rag/search?${qs}`);
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // POST /v1/trade/rag/embed — embed text into trading RAG
  router.post("/rag/embed", async (req, res) => {
    try {
      const r = await engineFetch("/rag/embed", { method: "POST", body: JSON.stringify(req.body) });
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // ── Reports / Analytics ─────────────────────────────────────────────────

  // GET /v1/trade/reports/performance — QuantStats performance metrics
  router.get("/reports/performance", async (req, res) => {
    try {
      const r = await engineFetch("/reports/performance");
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // GET /v1/trade/reports/tearsheet — full HTML tear sheet
  router.get("/reports/tearsheet", async (req, res) => {
    try {
      const r = await engineFetch("/reports/tearsheet");
      const html = await r.text();
      res.setHeader("Content-Type", "text/html");
      res.status(r.status).send(html);
    } catch (err) {
      res.status(502).json({ ok: false, error: "Trade engine unreachable", detail: err.message });
    }
  });

  // ── TradingView webhook ───────────────────────────────────────────────────

  // POST /v1/trade/tv-webhook — receive TradingView alert
  router.post("/tv-webhook", async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object") {
        return res.status(400).json({ ok: false, error: "Invalid payload — expected JSON object" });
      }
      // Require at least a symbol or ticker field
      const symbol = body.symbol || body.ticker;
      if (!symbol) {
        return res.status(400).json({ ok: false, error: "Missing required field: symbol or ticker" });
      }
      // Store in PB trade_signals
      const record = {
        source: "tradingview",
        symbol,
        action: body.action || body.strategy?.order_action || null,
        price: body.price || body.strategy?.order_price || null,
        timeframe: body.timeframe || body.interval || null,
        raw: JSON.stringify(body),
        status: "pending",
      };
      const r = await tradePbFetch("/api/collections/trade_signals/records", {
        method: "POST",
        body: JSON.stringify(record),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        return res.status(r.status).json({ ok: false, error: "Failed to store signal", detail: err });
      }
      const saved = await r.json();
      res.json({ ok: true, signalId: saved.id });
    } catch (err) {
      res.status(500).json({ ok: false, error: "Webhook processing failed", detail: err.message });
    }
  });

  // ── Backtest results from PB (for UI enrichment) ─────────────────────────

  // GET /v1/trade/backtest/pb-results — return PB backtest metadata (version, description, notes, tags)
  router.get("/backtest/pb-results", async (_req, res) => {
    try {
      const r = await tradePbFetch("/api/collections/trade_backtest_results/records?perPage=100");
      if (!r.ok) return res.status(r.status).json({ error: "PB fetch failed" });
      const data = await r.json();
      res.json({ items: data.items || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Backtest results sync ────────────────────────────────────────────────

  // POST /v1/trade/backtest/sync — sync all backtest results from freqtrade-bt into PB
  router.post("/backtest/sync", async (_req, res) => {
    const btAuth = "Basic " + Buffer.from(`${FREQTRADE_USERNAME}:${FREQTRADE_PASSWORD}`).toString("base64");

    // 1. Fetch list of all backtest result files from freqtrade-bt webserver
    let historyList;
    try {
      const r = await fetch(`${FREQTRADE_BT_URL}/api/v1/backtest/history`, {
        headers: { Authorization: btAuth },
      });
      if (!r.ok) {
        const err = await r.text().catch(() => "");
        return res.status(502).json({ ok: false, error: "Failed to list backtest history", detail: err.slice(0, 300) });
      }
      historyList = await r.json();
    } catch (err) {
      return res.status(502).json({ ok: false, error: "freqtrade-bt unreachable", detail: err.message });
    }

    // freqtrade returns an array of { filename, strategy, ... }
    if (!Array.isArray(historyList)) {
      historyList = historyList.data || [];
    }

    const results = { synced: [], skipped: [], errors: [] };

    // 2. For each entry, check if already in PB (by filename), then load + save
    for (const entry of historyList) {
      const filename = entry.filename || entry.file || "";
      const strategyName = entry.strategy || "";

      if (!filename) {
        results.errors.push({ filename: "(unknown)", error: "No filename in history entry" });
        continue;
      }

      try {
        // Check if already saved
        const checkQs = new URLSearchParams({ filter: `filename="${filename}"`, perPage: "1" }).toString();
        const checkRes = await tradePbFetch(`/api/collections/trade_backtest_results/records?${checkQs}`);
        if (checkRes.ok) {
          const checkData = await checkRes.json();
          if ((checkData.items || []).length > 0) {
            results.skipped.push(filename);
            continue;
          }
        }

        // Load full result from freqtrade-bt
        const resultQs = new URLSearchParams({ filename, strategy: strategyName }).toString();
        const detailRes = await fetch(`${FREQTRADE_BT_URL}/api/v1/backtest/history/result?${resultQs}`, {
          headers: { Authorization: btAuth },
        });
        if (!detailRes.ok) {
          const errText = await detailRes.text().catch(() => "");
          results.errors.push({ filename, error: `Failed to load result: ${detailRes.status} ${errText.slice(0, 200)}` });
          continue;
        }
        const fullResult = await detailRes.json();

        // Extract metrics — freqtrade nests: { backtest_result: { strategy: { SMCStrategy: {...} } } }
        const btResult = fullResult.backtest_result || fullResult;
        const stratData = (btResult.strategy && btResult.strategy[strategyName]) || (fullResult.strategy && fullResult.strategy[strategyName]) || {};
        const summary = stratData.results_per_pair
          ? null  // multi-pair — use totals
          : null;
        void summary;  // not used, metrics come from totals below

        const totalMetrics = stratData.total_trades != null ? stratData : {};
        const config = stratData; // strategy data contains timeframe, trading_mode, etc.

        // Determine next version number (count existing + 1)
        const countRes = await tradePbFetch(`/api/collections/trade_backtest_results/records?perPage=1`);
        let totalCount = 0;
        if (countRes.ok) {
          const countData = await countRes.json();
          totalCount = countData.totalItems || 0;
        }
        const version = `v${totalCount + 1}`;

        // Build PB record
        const record = {
          version,
          description: `${strategyName} | ${stratData.trading_mode || "spot"} | ${stratData.backtest_start || "?"} to ${stratData.backtest_end || "?"} | ${stratData.total_trades || 0} trades`,
          strategy_name: strategyName,
          exchange: stratData.exchange || entry.exchange || "",
          trading_mode: stratData.trading_mode || "spot",
          timerange: `${stratData.backtest_start || ""} - ${stratData.backtest_end || ""}`,
          timeframe: stratData.timeframe || entry.timeframe || "",
          total_trades: stratData.total_trades || 0,
          wins: stratData.wins || 0,
          losses: stratData.losses || 0,
          winrate: stratData.winrate != null ? stratData.winrate : 0,
          profit_total_abs: stratData.profit_total_abs || 0,
          profit_total_pct: stratData.profit_total || 0,
          max_drawdown_abs: stratData.max_drawdown_abs || 0,
          max_drawdown_pct: stratData.max_drawdown_account || 0,
          sharpe: stratData.sharpe || 0,
          profit_factor: stratData.profit_factor || 0,
          sortino: stratData.sortino || 0,
          calmar: stratData.calmar || 0,
          avg_duration: stratData.holding_avg || "",
          pairs_count: (stratData.pairlist || []).length || 0,
          tags: [
            stratData.freqaimodel ? "lumilearning" : "pure-smc",
            stratData.trading_mode || "spot",
            stratData.can_short ? "long+short" : "long-only",
          ].filter(Boolean),
          result_json: fullResult,
          filename,
          user_id: "",
        };

        // PB hard limit: 1MB per JSON field. Strip large arrays when over limit.
        const PB_JSON_LIMIT = 900_000; // bytes, safe margin under 1MB
        const STRIP_FIELDS = ["trades", "periodic_breakdown", "daily_profit"];
        function stripLargeFields(obj) {
          if (!obj || typeof obj !== "object") return obj;
          const out = {};
          for (const [k, v] of Object.entries(obj)) {
            if (!STRIP_FIELDS.includes(k)) out[k] = v;
          }
          return out;
        }
        if (JSON.stringify(record.result_json).length > PB_JSON_LIMIT) {
          // Deep-copy to avoid mutating fullResult
          const slim = JSON.parse(JSON.stringify(fullResult));
          // Handle nested backtest_result.strategy.{StrategyName} (freqtrade webserver format)
          if (slim.backtest_result && slim.backtest_result.strategy) {
            const slimStrat = {};
            for (const [sName, sData] of Object.entries(slim.backtest_result.strategy)) {
              slimStrat[sName] = stripLargeFields(sData);
            }
            slim.backtest_result.strategy = slimStrat;
          }
          // Handle flat strategy.{StrategyName} (alternative format)
          if (slim.strategy) {
            const slimStrat = {};
            for (const [sName, sData] of Object.entries(slim.strategy)) {
              slimStrat[sName] = stripLargeFields(sData);
            }
            slim.strategy = slimStrat;
          }
          record.result_json = slim;
          record.description = (record.description || "") + " [large fields stripped: result exceeded 1MB PB limit]";
        }

        const saveRes = await tradePbFetch("/api/collections/trade_backtest_results/records", {
          method: "POST",
          body: JSON.stringify(record),
        });

        if (saveRes.ok) {
          const saved = await saveRes.json();
          results.synced.push({ filename, id: saved.id, version });
        } else {
          const errText = await saveRes.text().catch(() => "");
          results.errors.push({ filename, error: `PB save failed: ${saveRes.status} ${errText.slice(0, 200)}` });
        }
      } catch (err) {
        results.errors.push({ filename, error: err.message });
      }
    }

    res.json({
      ok: true,
      synced: results.synced.length,
      skipped: results.skipped.length,
      errors: results.errors.length,
      detail: results,
    });
  });

  // ── Freqtrade → PocketBase trade history sync ────────────────────────────

  /**
   * Core sync logic: fetch closed trades from freqtrade REST API and upsert
   * them into PocketBase trade_history collection.
   *
   * Deduplication key: freqtrade trade_id stored in signal_id field.
   * Only closed trades (is_open=false) are synced.
   *
   * @param {object} [opts]
   * @param {number} [opts.limit=200]  max trades to fetch per run
   * @returns {{ synced: number, skipped: number, errors: string[] }}
   */
  async function syncFreqtradeTrades({ limit = 200 } = {}) {
    const ftAuth = "Basic " + Buffer.from(`${FREQTRADE_USERNAME}:${FREQTRADE_PASSWORD}`).toString("base64");
    const results = { synced: 0, skipped: 0, errors: [] };

    // 1. Fetch trades from freqtrade REST API
    let trades;
    try {
      const r = await fetch(`${FREQTRADE_URL}/api/v1/trades?limit=${limit}`, {
        headers: { Authorization: ftAuth },
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        throw new Error(`freqtrade API ${r.status}: ${errText.slice(0, 200)}`);
      }
      const data = await r.json();
      // freqtrade returns { trades: [...], trades_count: N, offset: 0, total_trades: N }
      trades = Array.isArray(data) ? data : (data.trades || []);
    } catch (err) {
      results.errors.push(`fetch_trades: ${err.message}`);
      return results;
    }

    // 2. Filter to closed trades only
    const closed = trades.filter((t) => t.is_open === false);

    // 3. For each closed trade, check if already in PB (by signal_id = freqtrade trade_id)
    for (const trade of closed) {
      const tradeId = String(trade.trade_id ?? trade.id ?? "");
      if (!tradeId) {
        results.errors.push(`skipped trade with missing trade_id: ${JSON.stringify(trade).slice(0, 100)}`);
        continue;
      }

      try {
        // Check existence — signal_id holds the freqtrade trade_id
        const checkQs = new URLSearchParams({ filter: `signal_id="ft_${tradeId}"`, perPage: "1" }).toString();
        const checkRes = await tradePbFetch(`/api/collections/trade_history/records?${checkQs}`);
        if (checkRes.ok) {
          const checkData = await checkRes.json();
          if ((checkData.items || []).length > 0) {
            results.skipped++;
            continue;
          }
        }

        // Compute duration in minutes from open_date / close_date
        let durationMinutes = null;
        if (trade.open_date && trade.close_date) {
          const openMs = new Date(trade.open_date).getTime();
          const closeMs = new Date(trade.close_date).getTime();
          if (!isNaN(openMs) && !isNaN(closeMs)) {
            durationMinutes = Math.round((closeMs - openMs) / 60000);
          }
        }

        // Parse entry hour (UTC) for timing context
        let hourUtc = null;
        let dayOfWeek = null;
        if (trade.open_date) {
          const d = new Date(trade.open_date);
          if (!isNaN(d.getTime())) {
            hourUtc = d.getUTCHours();
            dayOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
          }
        }

        // Total fees (open + close)
        const fees = (trade.fee_open_cost || 0) + (trade.fee_close_cost || 0);

        // Build PB record — map freqtrade fields → trade_history schema
        const record = {
          symbol:          trade.pair || "",
          broker:          "freqtrade",
          exchange:        trade.exchange || "",
          direction:       trade.is_short ? "short" : "long",
          entry_price:     trade.open_rate || 0,
          exit_price:      trade.close_rate || 0,
          quantity:        trade.amount || 0,
          pnl:             trade.close_profit_abs ?? null,
          pnl_pct:         trade.close_profit ?? null,
          duration_minutes: durationMinutes,
          entry_time:      trade.open_date || "",
          exit_time:       trade.close_date || "",
          strategy:        trade.strategy || "",
          signal_id:       `ft_${tradeId}`,             // ft_ prefix = freqtrade source
          risk_amount:     trade.stake_amount || 0,
          fees:            fees || 0,
          exit_reason:     trade.exit_reason || trade.sell_reason || "",
          bot_name:        trade.bot_name || "freqtrade",
          trading_mode:    "live",
          hour_utc:        hourUtc,
          day_of_week:     dayOfWeek,
          minutes_in_trade: durationMinutes,
          // Required by schema
          user_id:         "freqtrade_bot",
          notes:           trade.exit_reason ? `exit: ${trade.exit_reason}` : "",
        };

        const saveRes = await tradePbFetch("/api/collections/trade_history/records", {
          method: "POST",
          body: JSON.stringify(record),
        });

        if (saveRes.ok) {
          results.synced++;
        } else {
          const errText = await saveRes.text().catch(() => "");
          results.errors.push(`save trade_id=${tradeId}: PB ${saveRes.status} ${errText.slice(0, 200)}`);
        }
      } catch (err) {
        results.errors.push(`trade_id=${tradeId}: ${err.message}`);
      }
    }

    return results;
  }

  // GET /v1/trade/sync/trades — manually trigger freqtrade → PB trade history sync
  router.get("/sync/trades", async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 200;
    try {
      const results = await syncFreqtradeTrades({ limit });
      res.json({
        ok: true,
        synced: results.synced,
        skipped: results.skipped,
        errors: results.errors.length,
        error_detail: results.errors,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: "Sync failed", detail: err.message });
    }
  });

  // Auto-sync every 5 minutes — only runs when the module is loaded (server start)
  // Delay first run by 30s to let freqtrade container finish starting up
  const SYNC_INTERVAL_MS = 5 * 60 * 1000;
  setTimeout(() => {
    // Run once immediately after the initial delay, then on interval
    syncFreqtradeTrades().catch((err) =>
      console.error("[trade-sync] auto-sync error:", err.message)
    );
    setInterval(() => {
      syncFreqtradeTrades().catch((err) =>
        console.error("[trade-sync] auto-sync error:", err.message)
      );
    }, SYNC_INTERVAL_MS);
  }, 30_000);

  // ── WebSocket proxy ──────────────────────────────────────────────────────
  //
  // Express does not natively handle WebSocket upgrade events on sub-routes.
  // WS upgrade handling must be attached directly to the HTTP server, which
  // is why we export setupTradeWebSocket(server) for the caller (server.js)
  // to invoke after creating the HTTP server instance.
  //
  // This uses raw Node.js http proxying (no `ws` package required).

  /**
   * Attach a WebSocket proxy to the HTTP server for /v1/trade/ws/* paths.
   * Proxies upgrade requests to the Trade Engine's WebSocket endpoint.
   *
   * @param {http.Server} server — the Node.js HTTP server instance
   */
  function setupTradeWebSocket(server) {
    server.on("upgrade", (req, socket, head) => {
      if (!req.url.startsWith("/v1/trade/ws/")) return;

      // Strip the /v1/trade prefix so the engine sees /ws/...
      const targetPath = req.url.replace("/v1/trade", "");

      let targetUrl;
      try {
        targetUrl = new URL(targetPath, TRADE_ENGINE_URL);
      } catch (err) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      const proxyReq = http.request({
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: targetUrl.pathname + targetUrl.search,
        method: "GET",
        headers: {
          ...req.headers,
          host: targetUrl.host,
        },
      });

      proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
        // Forward the upstream 101 response with all headers (incl. Sec-WebSocket-Accept)
        const headerLines = ["HTTP/1.1 101 Switching Protocols"];
        const raw = proxyRes.rawHeaders;
        for (let i = 0; i < raw.length; i += 2) {
          headerLines.push(`${raw[i]}: ${raw[i + 1]}`);
        }
        socket.write(headerLines.join("\r\n") + "\r\n\r\n");

        // Write any buffered head data
        if (proxyHead && proxyHead.length) socket.write(proxyHead);
        if (head && head.length) proxySocket.write(head);

        // Bi-directional pipe
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);

        // Clean up on either side closing
        proxySocket.on("error", () => socket.destroy());
        socket.on("error", () => proxySocket.destroy());
        proxySocket.on("close", () => socket.destroy());
        socket.on("close", () => proxySocket.destroy());
      });

      proxyReq.on("error", (err) => {
        const msg = `Trade Engine WebSocket unreachable: ${err.message}`;
        socket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\n${msg}`);
        socket.destroy();
      });

      // If the engine responds with a non-upgrade HTTP response, reject
      proxyReq.on("response", (res) => {
        const statusLine = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n\r\n`;
        socket.write(statusLine);
        socket.destroy();
      });

      proxyReq.end();
    });
  }

  return { router, tradePbFetch, setupTradeWebSocket };
};
