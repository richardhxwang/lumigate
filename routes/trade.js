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
