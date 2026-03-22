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
const FREQTRADE_PASSWORD = process.env.TRADE_FREQTRADE_PASSWORD || "changeme";

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

  // GET /v1/trade/economic-calendar — upcoming high-impact economic events
  router.get("/economic-calendar", async (req, res) => {
    try {
      const qs = req.query.minutes_ahead ? `?minutes_ahead=${req.query.minutes_ahead}` : "";
      const r = await engineFetch(`/economic-calendar${qs}`);
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

  // PATCH /v1/trade/backtest/pb-results/:id — update a backtest record (notes, tags, etc.)
  router.patch("/backtest/pb-results/:id", async (req, res) => {
    try {
      const r = await tradePbFetch(`/api/collections/trade_backtest_results/records/${req.params.id}`, {
        method: "PATCH",
        body: JSON.stringify(req.body),
      });
      if (!r.ok) return res.status(r.status).json({ error: "PB update failed" });
      res.json(await r.json());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Backtest results sync ────────────────────────────────────────────────

  /**
   * Core backtest sync logic: fetch all backtest results from freqtrade-bt
   * and upsert them into PocketBase trade_backtest_results collection.
   * Deduplication key: filename.
   * @returns {{ synced: object[], skipped: string[], errors: object[] }}
   */
  async function syncBacktestResults() {
    const btAuth = "Basic " + Buffer.from(`${FREQTRADE_USERNAME}:${FREQTRADE_PASSWORD}`).toString("base64");
    const results = { synced: [], skipped: [], errors: [] };

    // 1. Fetch list of all backtest result files from freqtrade-bt webserver
    let historyList;
    try {
      const r = await fetch(`${FREQTRADE_BT_URL}/api/v1/backtest/history`, {
        headers: { Authorization: btAuth },
      });
      if (!r.ok) {
        const err = await r.text().catch(() => "");
        results.errors.push({ filename: "(list)", error: `Failed to list backtest history: ${r.status} ${err.slice(0, 300)}` });
        return results;
      }
      historyList = await r.json();
    } catch (err) {
      results.errors.push({ filename: "(list)", error: `freqtrade-bt unreachable: ${err.message}` });
      return results;
    }

    // freqtrade returns an array of { filename, strategy, ... }
    if (!Array.isArray(historyList)) {
      historyList = historyList.data || [];
    }

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
        // If strategyName is empty/missing, pick the first key from the strategy dict
        let resolvedStrategy = strategyName;
        if (!resolvedStrategy && btResult.strategy && typeof btResult.strategy === "object") {
          resolvedStrategy = Object.keys(btResult.strategy)[0] || "";
        }
        if (!resolvedStrategy && fullResult.strategy && typeof fullResult.strategy === "object") {
          resolvedStrategy = Object.keys(fullResult.strategy)[0] || "";
        }
        const stratData = (btResult.strategy && btResult.strategy[resolvedStrategy]) || (fullResult.strategy && fullResult.strategy[resolvedStrategy]) || {};

        // Determine next version number (count existing + 1)
        const countRes = await tradePbFetch(`/api/collections/trade_backtest_results/records?perPage=1`);
        let totalCount = 0;
        if (countRes.ok) {
          const countData = await countRes.json();
          totalCount = countData.totalItems || 0;
        }
        const version = `v${totalCount + 1}`;

        // Build PB record
        // Field mapping: freqtrade may use winning_trades/losing_trades or wins/losses
        const totalTrades = stratData.total_trades || 0;
        const wins = stratData.winning_trades ?? stratData.wins ?? 0;
        const losses = stratData.losing_trades ?? stratData.losses ?? 0;
        // Prefer freqtrade's own winrate (full precision); fall back to calculated
        const winrate = stratData.winrate ?? (totalTrades > 0 ? +(wins / totalTrades).toFixed(6) : 0);

        const record = {
          version,
          description: `${resolvedStrategy} | ${stratData.trading_mode || "spot"} | ${stratData.backtest_start || "?"} to ${stratData.backtest_end || "?"} | ${totalTrades} trades`,
          strategy_name: resolvedStrategy,
          exchange: stratData.exchange || entry.exchange || "",
          trading_mode: stratData.trading_mode || "spot",
          timerange: `${stratData.backtest_start || ""} - ${stratData.backtest_end || ""}`,
          timeframe: stratData.timeframe || entry.timeframe || "",
          total_trades: totalTrades,
          wins,
          losses,
          winrate,
          profit_total_abs: stratData.profit_total_abs || 0,
          profit_total_pct: stratData.profit_total || 0,
          max_drawdown_abs: stratData.max_drawdown_abs || 0,
          max_drawdown_pct: stratData.max_drawdown_account || 0,
          sharpe: stratData.sharpe || 0,
          profit_factor: stratData.profit_factor || 0,
          sortino: stratData.sortino || 0,
          calmar: stratData.calmar || 0,
          cagr: stratData.cagr || 0,
          avg_duration: stratData.holding_avg || "",
          pairs_count: (stratData.pairlist || []).length || 0,
          tags: [
            stratData.freqaimodel ? "lumilearning" : "pure-smc",
            stratData.trading_mode || "spot",
            (stratData.can_short || stratData.trading_mode === "futures") ? "long+short" : "long-only",
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

    return results;
  }

  // POST /v1/trade/backtest/sync — manually trigger backtest results sync
  router.post("/backtest/sync", async (_req, res) => {
    try {
      const results = await syncBacktestResults();
      res.json({
        ok: true,
        synced: results.synced.length,
        skipped: results.skipped.length,
        errors: results.errors.length,
        detail: results,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: "Backtest sync failed", detail: err.message });
    }
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

  // NOTE: Trade history auto-sync is now handled by trade-engine (Python) which
  // syncs ALL bots every 5 min via MultiBotConnector. The Node.js syncFreqtradeTrades()
  // only queries a single bot and is kept as a manual fallback endpoint.

  // Auto-sync backtest results every 10 minutes
  // Delay first run by 60s to let freqtrade-bt container finish starting up
  const BT_SYNC_INTERVAL_MS = 10 * 60 * 1000;
  setTimeout(() => {
    syncBacktestResults().then((r) => {
      if (r.synced.length > 0 || r.errors.length > 0)
        console.log(`[bt-sync] auto: synced=${r.synced.length} skipped=${r.skipped.length} errors=${r.errors.length}`);
    }).catch((err) =>
      console.error("[bt-sync] auto-sync error:", err.message)
    );
    setInterval(() => {
      syncBacktestResults().then((r) => {
        if (r.synced.length > 0 || r.errors.length > 0)
          console.log(`[bt-sync] auto: synced=${r.synced.length} skipped=${r.skipped.length} errors=${r.errors.length}`);
      }).catch((err) =>
        console.error("[bt-sync] auto-sync error:", err.message)
      );
    }, BT_SYNC_INTERVAL_MS);
  }, 60_000);

  // ── Periodic news fetch + FinBERT auto-scoring ────────────────────────────
  //
  // Calls trade-engine POST /analyze for the top 5 pairs by volume every 15min.
  // Only top-5 to stay within Finnhub free-tier rate limits (60 req/min).
  // A 2s delay between pairs adds a safety margin.
  // All errors are caught individually — one failing pair never stops the rest.

  const NEWS_PAIRS = ["BTC", "ETH", "SOL", "BNB", "XRP"];
  const NEWS_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

  async function fetchNewsForAllPairs() {
    console.log(`[trade-news] fetching news for ${NEWS_PAIRS.length} pairs...`);
    let totalArticles = 0;
    let totalScored = 0;

    for (const symbol of NEWS_PAIRS) {
      try {
        const resp = await engineFetch("/analyze", {
          method: "POST",
          body: JSON.stringify({ symbol, include_news: true, timeframes: [] }),
        });
        const data = await resp.json().catch(() => ({}));
        const articles = data?.news_count ?? data?.articles_saved ?? 0;
        const scored = data?.finbert_scored ?? data?.sentiment_count ?? 0;
        totalArticles += articles;
        totalScored += scored;
        console.log(`[trade-news] ${symbol}: ${articles} articles, ${scored} scored`);
      } catch (err) {
        console.error(`[trade-news] ${symbol} error: ${err.message}`);
      }
      // 2s delay between pairs — Finnhub free tier: 60 req/min
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    console.log(`[trade-news] done: ${totalArticles} articles saved, ${totalScored} scored`);
    return { articles: totalArticles, scored: totalScored };
  }

  // Initial run delayed by 60s to let all containers (trade-engine, FinBERT) warm up
  setTimeout(() => {
    fetchNewsForAllPairs().catch((err) =>
      console.error("[trade-news] initial run error:", err.message)
    );
    setInterval(() => {
      fetchNewsForAllPairs().catch((err) =>
        console.error("[trade-news] interval error:", err.message)
      );
    }, NEWS_INTERVAL_MS);
  }, 60_000);

  // GET /v1/trade/news/fetch — manually trigger news fetch + FinBERT scoring
  router.get("/news/fetch", async (req, res) => {
    try {
      const results = await fetchNewsForAllPairs();
      res.json({ ok: true, ...results });
    } catch (err) {
      res.status(500).json({ ok: false, error: "News fetch failed", detail: err.message });
    }
  });

  // POST /v1/trade/news/rss — manually trigger RSS feed collection
  router.post("/news/rss", async (req, res) => {
    try {
      const resp = await engineFetch("/news/rss", { method: "POST" });
      const data = await resp.json();
      res.json({ ok: true, ...data });
    } catch (err) {
      res.status(500).json({ ok: false, error: "RSS fetch failed", detail: err.message });
    }
  });

  // GET /v1/trade/news/rss/sources — list configured RSS sources
  router.get("/news/rss/sources", async (req, res) => {
    try {
      const resp = await engineFetch("/news/rss/sources");
      const data = await resp.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: "RSS sources list failed", detail: err.message });
    }
  });

  // POST /v1/trade/news/lunarcrush — manually trigger LunarCrush social sentiment collection
  router.post("/news/lunarcrush", async (req, res) => {
    try {
      const body = req.body?.coins ? JSON.stringify(req.body.coins) : null;
      const resp = await engineFetch("/news/lunarcrush", {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body,
      });
      const data = await resp.json();
      res.json({ ok: true, ...data });
    } catch (err) {
      res.status(500).json({ ok: false, error: "LunarCrush fetch failed", detail: err.message });
    }
  });

  // GET /v1/trade/news/lunarcrush/status — check LunarCrush collector status
  router.get("/news/lunarcrush/status", async (req, res) => {
    try {
      const resp = await engineFetch("/news/lunarcrush/status");
      const data = await resp.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: "LunarCrush status check failed", detail: err.message });
    }
  });

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
