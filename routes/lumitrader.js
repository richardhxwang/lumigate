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

当前市场上下文会自动注入到每次对话中。`;

module.exports = function createLumiTraderRouter(deps) {
  const router = express.Router();
  const {
    PB_URL,
    getPbAdminToken,
    TRADE_ENGINE_URL,
  } = deps;

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

  async function fetchTradingContext() {
    const ctx = { positions: null, pnl: null, signals: null };
    const tasks = [
      engineFetch("/positions").then(r => r.ok ? r.json() : null).catch(() => null),
      engineFetch("/pnl").then(r => r.ok ? r.json() : null).catch(() => null),
      engineFetch("/signals?limit=5").then(r => r.ok ? r.json() : null).catch(() => null),
    ];

    const [positions, pnl, signals] = await Promise.all(tasks);
    ctx.positions = positions;
    ctx.pnl = pnl;
    ctx.signals = signals;
    return ctx;
  }

  function formatTradingContext(ctx) {
    const parts = [];

    if (ctx.positions && Array.isArray(ctx.positions.items) && ctx.positions.items.length > 0) {
      const posLines = ctx.positions.items.map(p =>
        `  ${p.symbol} ${p.direction || "?"} qty:${p.quantity || "?"} uPnL:${p.unrealized_pnl ?? "?"}`
      );
      parts.push(`[Open Positions]\n${posLines.join("\n")}`);
    } else {
      parts.push("[Open Positions] None");
    }

    if (ctx.pnl) {
      const p = ctx.pnl;
      parts.push(`[P&L] today:${p.daily_pnl ?? "?"} cumulative:${p.cumulative_pnl ?? "?"} win_rate:${p.win_rate ?? "?"}`);
    }

    if (ctx.signals && Array.isArray(ctx.signals.items) && ctx.signals.items.length > 0) {
      const sigLines = ctx.signals.items.slice(0, 5).map(s =>
        `  ${s.symbol} ${s.direction || "?"} confidence:${s.confidence ?? "?"} entry:${s.entry_price ?? "?"}`
      );
      parts.push(`[Recent Signals]\n${sigLines.join("\n")}`);
    }

    if (parts.length === 0) return "";
    return "\n\n--- Current Market Context ---\n" + parts.join("\n") + "\n--- End Context ---";
  }

  // ── POST /lumitrader/chat — Main chat endpoint ───────────────────────────

  router.post("/lumitrader/chat", express.json({ limit: "2mb" }), async (req, res) => {
    try {
      const { messages, model, provider, stream } = req.body;
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "messages array required" });
      }

      // Fetch trading context and prepend to system prompt
      let contextBlock = "";
      try {
        const ctx = await fetchTradingContext();
        contextBlock = formatTradingContext(ctx);
      } catch { /* context fetch is best-effort */ }

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

      // Proxy to LumiGate /v1/chat
      const upstreamBody = {
        messages: outMessages,
        model: model || "gpt-4o",
        provider: provider || "openai",
        stream: wantStream,
      };

      const upstreamRes = await fetch(`${LUMIGATE_INTERNAL_URL}/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-App-Source": "lumitrade",
          "X-Internal-Chat": process.env.INTERNAL_CHAT_KEY || "",
        },
        body: JSON.stringify(upstreamBody),
      });

      if (!wantStream) {
        // Non-streaming: forward JSON response
        const data = await upstreamRes.json();
        return res.status(upstreamRes.status).json(data);
      }

      // Streaming: pipe SSE
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const readable = upstreamRes.body;
      if (!readable) {
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      // Node fetch returns a web ReadableStream; pipe to response
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
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: "LumiTrader chat failed", detail: err.message });
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      }
    }
  });

  // ── GET /lumitrader/settings — Get user trading preferences ───────────────

  router.get("/lumitrader/settings", async (req, res) => {
    try {
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: "userId required" });

      const r = await tradePbFetch(
        `/api/collections/lt_user_settings/records?filter=(user='${userId}')&perPage=1`
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

  router.post("/lumitrader/settings", express.json(), async (req, res) => {
    try {
      const { userId, settings } = req.body;
      if (!userId) return res.status(400).json({ error: "userId required" });
      if (!settings || typeof settings !== "object") return res.status(400).json({ error: "settings object required" });

      // Check if record exists
      const existing = await tradePbFetch(
        `/api/collections/lt_user_settings/records?filter=(user='${userId}')&perPage=1`
      );
      const existingData = existing.ok ? await existing.json() : { items: [] };
      const existingRecord = existingData.items?.[0];

      let r;
      if (existingRecord) {
        // Update existing
        r = await tradePbFetch(`/api/collections/lt_user_settings/records/${existingRecord.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ...settings, user: userId }),
        });
      } else {
        // Create new
        r = await tradePbFetch("/api/collections/lt_user_settings/records", {
          method: "POST",
          body: JSON.stringify({ ...settings, user: userId }),
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

  router.get("/lumitrader/sessions", async (req, res) => {
    try {
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: "userId required" });

      const page = parseInt(req.query.page) || 1;
      const perPage = Math.min(parseInt(req.query.perPage) || 20, 50);

      const r = await tradePbFetch(
        `/api/collections/lt_sessions/records?filter=(user='${userId}')&sort=-updated&page=${page}&perPage=${perPage}`
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

  router.post("/lumitrader/sessions", express.json(), async (req, res) => {
    try {
      const { userId, title } = req.body;
      if (!userId) return res.status(400).json({ error: "userId required" });

      const r = await tradePbFetch("/api/collections/lt_sessions/records", {
        method: "POST",
        body: JSON.stringify({
          user: userId,
          title: title || "New Trading Chat",
          messages: "[]",
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

  return { router };
};
