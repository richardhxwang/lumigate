const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const dns = require("dns");
const { promisify } = require("util");
const { createProxyMiddleware } = require("http-proxy-middleware");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const dnsLookup = promisify(dns.lookup);

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const sessions = new Map();

const app = express();
app.disable("x-powered-by");
const PORT = process.env.PORT || 9471;
const startTime = Date.now();

// --- Security: Admin secret & internal chat key ---
const ADMIN_SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(20).toString("hex");
const INTERNAL_CHAT_KEY = crypto.randomBytes(20).toString("hex"); // rotates on restart

if (!process.env.ADMIN_SECRET) {
  console.log("WARNING: No ADMIN_SECRET set — a temporary secret was generated. Set ADMIN_SECRET in .env for persistence.");
}

// --- Helpers ---
function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || "").split(";").forEach((c) => {
    const [k, ...v] = c.trim().split("=");
    if (k) cookies[k.trim()] = decodeURIComponent(v.join("="));
  });
  return cookies;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sanitizeEnvValue(v) {
  return String(v).replace(/[\r\n]/g, "").trim();
}

function validateProjectName(name) {
  if (!name || typeof name !== "string") return false;
  if (name.length > 64) return false;
  if (/[<>"';&|`$\\]/.test(name)) return false;
  return true;
}

// F-03: Check if hostname resolves to a private/internal IP
function isPrivateIP(ip) {
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.0\.0\.0|169\.254\.)/.test(ip)) return true;
  if (ip === "::1" || ip === "[::1]" || ip.startsWith("fe80:") || ip.startsWith("fc00:") || ip.startsWith("fd")) return true;
  if (ip === "169.254.169.254") return true;
  return false;
}

// F-06: Normalize IP for rate-limit keying (handle IPv6-mapped IPv4)
function normalizeIP(req) {
  const forwarded = req.headers["x-forwarded-for"]?.split(",")[0]?.trim();
  const ip = forwarded || req.ip || "unknown";
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

// F-03: Provider hostname allowlist for baseUrl validation
const PROVIDER_HOST_ALLOWLIST = new Set([
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.deepseek.com",
  "api.moonshot.cn",
  "ark.cn-beijing.volces.com",
  "dashscope.aliyuncs.com",
  "api.minimax.chat",
]);

// F-04: Allowed upstream paths per provider (prefix match)
const ALLOWED_UPSTREAM_PATHS = {
  openai:     ["/v1/chat/completions", "/v1/embeddings", "/v1/audio/", "/v1/images/", "/v1/models"],
  anthropic:  ["/v1/messages"],
  gemini:     ["/v1beta/openai/chat/completions", "/v1beta/openai/embeddings"],
  deepseek:   ["/v1/chat/completions"],
  kimi:       ["/v1/chat/completions"],
  doubao:     ["/chat/completions", "/embeddings"],
  qwen:       ["/v1/chat/completions", "/v1/embeddings"],
  minimax:    ["/v1/chat/completions"],
};

// --- Data layer ---
const DATA_DIR = path.join(__dirname, "data");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");
const RATE_FILE = path.join(DATA_DIR, "exchange-rate.json");

let dataDirReady = false;
function ensureDataDir() {
  if (dataDirReady) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  dataDirReady = true;
}

function loadProjects() {
  try {
    ensureDataDir();
    if (fs.existsSync(PROJECTS_FILE)) {
      return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Failed to load projects:", e.message);
  }
  return [];
}

function saveProjects(list) {
  ensureDataDir();
  const tmp = PROJECTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, PROJECTS_FILE);
}

let projects = loadProjects();

// --- Exchange rate ---
const SUPPORTED_CURRENCIES = ["CNY", "EUR", "GBP", "JPY", "KRW", "HKD", "SGD", "AUD", "CAD"];
let exchangeRate = { rates: { CNY: 7.24, EUR: 0.92, GBP: 0.79, JPY: 149.5, KRW: 1330, HKD: 7.82, SGD: 1.34, AUD: 1.53, CAD: 1.36 }, updatedAt: null };

function loadRate() {
  try {
    if (fs.existsSync(RATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(RATE_FILE, "utf8"));
      // Support both old format {USD_CNY} and new format {rates}
      if (saved.rates) {
        exchangeRate = saved;
      } else if (saved.USD_CNY) {
        exchangeRate.rates.CNY = saved.USD_CNY;
        exchangeRate.updatedAt = saved.updatedAt;
      }
    }
  } catch {}
}
loadRate();

async function fetchExchangeRate() {
  try {
    const resp = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await resp.json();
    if (data.result === "success" && data.rates) {
      const rates = {};
      for (const cur of SUPPORTED_CURRENCIES) {
        if (data.rates[cur]) rates[cur] = data.rates[cur];
      }
      exchangeRate = { rates, updatedAt: new Date().toISOString() };
      ensureDataDir();
      const tmp = RATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(exchangeRate, null, 2));
      fs.renameSync(tmp, RATE_FILE);
      console.log(`Exchange rates updated: ${SUPPORTED_CURRENCIES.map(c => `${c}=${rates[c]}`).join(", ")}`);
    }
  } catch (e) {
    console.error("Failed to fetch exchange rate:", e.message);
  }
}

(function initRate() {
  const age = exchangeRate.updatedAt ? Date.now() - new Date(exchangeRate.updatedAt).getTime() : Infinity;
  if (age > 7 * 24 * 60 * 60 * 1000) fetchExchangeRate();
})();
setInterval(fetchExchangeRate, 7 * 24 * 60 * 60 * 1000);

// --- Usage tracking ---
function loadUsage() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Failed to load usage:", e.message);
  }
  return {};
}

let usageData = loadUsage();
let usageDirty = false;

function pruneUsage(maxDays = 365) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  let pruned = 0;
  for (const key of Object.keys(usageData)) {
    if (key < cutoffStr) { delete usageData[key]; pruned++; }
  }
  if (pruned > 0) { usageDirty = true; console.log(`Pruned ${pruned} days of old usage data`); }
}
pruneUsage();
setInterval(pruneUsage, 24 * 60 * 60 * 1000);

function saveUsage() {
  try {
    ensureDataDir();
    const tmp = USAGE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(usageData, null, 2));
    fs.renameSync(tmp, USAGE_FILE);
    usageDirty = false;
  } catch (e) {
    console.error("Failed to save usage:", e.message);
  }
}

setInterval(() => { if (usageDirty) saveUsage(); }, 30000);

function recordUsage(project, provider, model, tokens) {
  const date = new Date().toISOString().slice(0, 10);
  if (!usageData[date]) usageData[date] = {};
  if (!usageData[date][project]) usageData[date][project] = {};
  const key = `${provider}/${model}`;
  if (!usageData[date][project][key]) {
    usageData[date][project][key] = { count: 0, inputTokens: 0, cacheHitTokens: 0, outputTokens: 0 };
  }
  const rec = usageData[date][project][key];
  rec.count++;
  rec.inputTokens += tokens.input || 0;
  rec.cacheHitTokens += tokens.cacheHit || 0;
  rec.outputTokens += tokens.output || 0;
  usageDirty = true;
}

function getModelInfo(provider, modelId) {
  const models = MODELS[provider] || [];
  return models.find((x) => x.id === modelId) || null;
}

function calcCost(price, stats, freeRPD, dailyCount) {
  if (!price) return 0;
  if (freeRPD && dailyCount <= freeRPD) return 0;
  let paidRatio = 1;
  if (freeRPD && dailyCount > freeRPD && stats.count > 0) {
    const paidCount = Math.max(0, stats.count - Math.max(0, freeRPD - (dailyCount - stats.count)));
    paidRatio = paidCount / stats.count;
  }
  const uncachedInput = Math.max(0, (stats.inputTokens || 0) - (stats.cacheHitTokens || 0));
  const raw = (uncachedInput / 1e6) * price.in
    + ((stats.cacheHitTokens || 0) / 1e6) * price.cacheIn
    + ((stats.outputTokens || 0) / 1e6) * price.out;
  return raw * paidRatio;
}

function extractTokens(providerName, body) {
  try {
    const j = typeof body === "string" ? JSON.parse(body) : body;
    if (providerName === "anthropic") {
      const u = j.usage || {};
      return { input: u.input_tokens || 0, cacheHit: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 };
    }
    const u = j.usage || {};
    const cached = u.prompt_tokens_details?.cached_tokens || u.prompt_cache_hit_tokens || 0;
    return { input: u.prompt_tokens || u.total_tokens || 0, cacheHit: cached, output: u.completion_tokens || 0 };
  } catch {
    return { input: 0, cacheHit: 0, output: 0 };
  }
}

function extractTokensFromSSE(providerName, chunks) {
  const lines = chunks.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    try {
      const j = JSON.parse(data);
      if (providerName === "anthropic" && j.type === "message_delta" && j.usage) {
        return { input: 0, cacheHit: 0, output: j.usage.output_tokens || 0 };
      }
      if (j.usage) return extractTokens(providerName, JSON.stringify(j));
    } catch {}
  }
  return null;
}

// --- Provider & model config ---
const PROVIDERS = {
  openai: { baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com", apiKey: process.env.OPENAI_API_KEY },
  anthropic: { baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com", apiKey: process.env.ANTHROPIC_API_KEY },
  gemini: { baseUrl: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com", apiKey: process.env.GEMINI_API_KEY },
  deepseek: { baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com", apiKey: process.env.DEEPSEEK_API_KEY },
  kimi: { baseUrl: process.env.KIMI_BASE_URL || "https://api.moonshot.cn", apiKey: process.env.KIMI_API_KEY },
  doubao: { baseUrl: process.env.DOUBAO_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3", apiKey: process.env.DOUBAO_API_KEY },
  qwen: { baseUrl: process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode", apiKey: process.env.QWEN_API_KEY },
  minimax: { baseUrl: process.env.MINIMAX_BASE_URL || "https://api.minimax.chat", apiKey: process.env.MINIMAX_API_KEY },
};

const MODELS = {
  openai: [
    { id: "gpt-4.1-nano", tier: "economy", price: { in: 0.10, cacheIn: 0.025, out: 0.40 }, caps: ["text"], desc: "Classification, extraction, routing — lowest cost, 1M context" },
    { id: "gpt-4.1-mini", tier: "economy", price: { in: 0.40, cacheIn: 0.10, out: 1.60 }, caps: ["text", "image"], desc: "Summarization, simple code gen, 1M context, vision" },
    { id: "o3-mini", tier: "economy", price: { in: 1.10, cacheIn: 0.55, out: 4.40 }, caps: ["text"], desc: "Code gen, math reasoning — best value reasoning model" },
    { id: "gpt-5-mini", tier: "standard", price: { in: 0.25, cacheIn: 0.0625, out: 2.00 }, caps: ["text", "image"], desc: "GPT-5 lite — everyday coding, writing, analysis" },
    { id: "gpt-4.1", tier: "standard", price: { in: 2.00, cacheIn: 0.50, out: 8.00 }, caps: ["text", "image"], desc: "Instruction following, long docs, function calling, 1M context" },
    { id: "o4-mini", tier: "standard", price: { in: 1.10, cacheIn: 0.275, out: 4.40 }, caps: ["text", "image"], desc: "Multi-step tool orchestration, code execution, vision" },
    { id: "o3", tier: "flagship", price: { in: 2.00, cacheIn: 0.50, out: 8.00 }, caps: ["text", "image"], desc: "PhD-level science reasoning, competitive programming, 200K context" },
    { id: "gpt-5", tier: "flagship", price: { in: 1.25, cacheIn: 0.3125, out: 10.00 }, caps: ["text", "image", "audio", "video"], desc: "Native multimodal flagship — image/audio/video input" },
    { id: "gpt-5.4", tier: "flagship", price: { in: 2.50, cacheIn: 0.625, out: 15.00 }, caps: ["text", "image", "audio", "video"], desc: "Most capable GPT — all modalities, latest iteration" },
  ],
  anthropic: [
    { id: "claude-haiku-4-5-20251001", tier: "economy", price: { in: 0.80, cacheIn: 0.08, out: 4.00 }, caps: ["text", "image", "pdf"], desc: "Code completion, classification, summarization — sub-second, 200K" },
    { id: "claude-sonnet-4-5-20250514", tier: "standard", price: { in: 3.00, cacheIn: 0.30, out: 15.00 }, caps: ["text", "image", "pdf"], desc: "Extended thinking, complex coding, long-form writing" },
    { id: "claude-opus-4-6", tier: "flagship", price: { in: 15.00, cacheIn: 1.50, out: 75.00 }, caps: ["text", "image", "pdf"], desc: "Autonomous coding, deep research, 200K analysis" },
  ],
  gemini: [
    { id: "gemini-2.5-flash-lite", tier: "economy", price: { in: 0.075, cacheIn: 0.01875, out: 0.30 }, freeRPD: 1500, caps: ["text", "image"], desc: "High-throughput summarization/classification — 1500 free/day" },
    { id: "gemini-2.5-flash", tier: "standard", price: { in: 0.15, cacheIn: 0.0375, out: 0.60 }, freeRPD: 500, caps: ["text", "image", "audio", "video", "pdf"], desc: "Code gen, math reasoning, 1M context — 500 free/day" },
    { id: "gemini-2.5-pro", tier: "flagship", price: { in: 1.25, cacheIn: 0.3125, out: 10.00 }, freeRPD: 25, caps: ["text", "image", "audio", "video", "pdf"], desc: "Multimodal video analysis, 1M context — 25 free/day" },
  ],
  deepseek: [
    { id: "deepseek-chat", tier: "economy", price: { in: 0.27, cacheIn: 0.018, out: 1.10 }, caps: ["text"], desc: "Chat, translation, summarization, bulk text processing" },
    { id: "deepseek-reasoner", tier: "flagship", price: { in: 0.55, cacheIn: 0.14, out: 2.19 }, caps: ["text"], desc: "Math proofs, competitive programming, CoT deep reasoning" },
  ],
  kimi: [
    { id: "moonshot-v1-8k", tier: "economy", price: { in: 1.67, cacheIn: 0.42, out: 1.67 }, caps: ["text"], desc: "Fast chat, 8K context" },
    { id: "moonshot-v1-32k", tier: "standard", price: { in: 3.33, cacheIn: 0.83, out: 3.33 }, caps: ["text"], desc: "Long document QA, 32K context" },
    { id: "moonshot-v1-128k", tier: "standard", price: { in: 8.33, cacheIn: 2.08, out: 8.33 }, caps: ["text"], desc: "Ultra-long context, 128K window" },
    { id: "kimi-k2", tier: "flagship", price: { in: 8.33, cacheIn: 2.08, out: 8.33 }, caps: ["text", "image"], desc: "Latest flagship — agentic coding, multi-step reasoning" },
  ],
  doubao: [
    { id: "doubao-1.5-lite-32k", tier: "economy", price: { in: 0.04, cacheIn: 0.01, out: 0.08 }, caps: ["text"], desc: "Ultra-low cost, 32K context — ideal for bulk tasks" },
    { id: "doubao-1.5-pro-32k", tier: "standard", price: { in: 0.11, cacheIn: 0.03, out: 0.28 }, caps: ["text", "image"], desc: "Balanced performance, 32K context, vision" },
    { id: "doubao-1.5-pro-256k", tier: "flagship", price: { in: 0.69, cacheIn: 0.17, out: 1.25 }, caps: ["text", "image"], desc: "Long-context flagship, 256K window, vision" },
  ],
  qwen: [
    { id: "qwen-turbo", tier: "economy", price: { in: 0.04, cacheIn: 0.01, out: 0.08 }, caps: ["text"], desc: "Fast and cheap — classification, extraction, simple QA" },
    { id: "qwen-plus", tier: "standard", price: { in: 0.11, cacheIn: 0.03, out: 0.28 }, caps: ["text", "image"], desc: "Balanced — coding, analysis, 128K context, vision" },
    { id: "qwen-max", tier: "flagship", price: { in: 0.28, cacheIn: 0.07, out: 0.83 }, caps: ["text", "image"], desc: "Most capable Qwen — complex reasoning, long-form writing" },
    { id: "qwen-long", tier: "standard", price: { in: 0.07, cacheIn: 0.02, out: 0.14 }, caps: ["text"], desc: "10M context window — book-length document analysis" },
  ],
  minimax: [
    { id: "MiniMax-Text-01", tier: "standard", price: { in: 0.40, cacheIn: 0.10, out: 1.10 }, caps: ["text"], desc: "256K context, strong at structured output and function calling" },
    { id: "MiniMax-Text-01-128k", tier: "economy", price: { in: 0.20, cacheIn: 0.05, out: 0.55 }, caps: ["text"], desc: "128K context, cost-efficient variant" },
  ],
};

// ============================================================
// Middleware stack
// ============================================================

// 1. Connection tracking for graceful shutdown
const activeConnections = new Set();
app.use((req, res, next) => {
  activeConnections.add(res);
  res.on("close", () => activeConnections.delete(res));
  next();
});

// 2. CORS — only allow same origin (dashboard/chat)
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (same-origin, curl, server-to-server)
    if (!origin) return cb(null, true);
    cb(null, false);
  },
  credentials: true,
}));

// 3. Rate limiting
const rateLimitOpts = {
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: normalizeIP,
  validate: { keyGeneratorIpFallback: false }, // F-06: our normalizeIP handles IPv6
};

const apiLimiter = rateLimit({
  ...rateLimitOpts,
  windowMs: 60 * 1000,
  max: 600, // 600 req/min per IP — sized for AI-driven apps with burst traffic
  message: { error: "Too many requests, please try again later" },
});

const adminLimiter = rateLimit({
  ...rateLimitOpts,
  windowMs: 60 * 1000,
  max: 120, // 120 req/min for admin endpoints
});

const loginLimiter = rateLimit({
  ...rateLimitOpts,
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 login attempts per 15 min
  message: { error: "Too many login attempts" },
});

// 4. Body parser with size limit (F-09: reduced from 100mb)
app.use(express.json({ limit: "10mb" }));

// 5. Request timeout
app.use((req, res, next) => {
  req.setTimeout(120000); // 2 min for AI responses
  next();
});

// ============================================================
// Auth middleware
// ============================================================
function adminAuth(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.admin_token || req.headers["x-admin-token"];
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  // F-07: Accept raw ADMIN_SECRET directly (for CLI/TUI)
  if (safeEqual(token, ADMIN_SECRET)) return next();

  // Accept session token
  if (!sessions.has(token)) return res.status(401).json({ error: "Unauthorized" });
  const created = sessions.get(token);
  const maxAge = 24 * 60 * 60 * 1000;
  if (Date.now() - created > maxAge) {
    sessions.delete(token);
    return res.status(401).json({ error: "Unauthorized" });
  }
  // Clean up expired sessions
  for (const [k, v] of sessions) {
    if (Date.now() - v > maxAge) sessions.delete(k);
  }
  return next();
}

// Check if request has valid admin session (non-middleware, returns boolean)
function hasAdminSession(req) {
  const cookies = parseCookies(req);
  const token = cookies.admin_token;
  if (!token) return false;
  if (safeEqual(token, ADMIN_SECRET)) return true;
  if (!sessions.has(token)) return false;
  const created = sessions.get(token);
  return (Date.now() - created) <= 24 * 60 * 60 * 1000;
}

// ============================================================
// Public routes (no auth)
// ============================================================

// Health check — used by Docker healthcheck
app.get("/health", (req, res) => {
  const available = Object.entries(PROVIDERS)
    .filter(([, cfg]) => cfg.apiKey)
    .map(([name]) => name);
  res.json({ status: "ok", providers: available, uptime: Math.floor((Date.now() - startTime) / 1000) });
});

app.get("/providers", (req, res) => {
  res.json(Object.entries(PROVIDERS).map(([name, cfg]) => ({
    name,
    baseUrl: cfg.baseUrl,
    available: !!cfg.apiKey,
  })));
});

app.get("/models/:provider", (req, res) => {
  const name = req.params.provider.toLowerCase();
  res.json(MODELS[name] || []);
});

// Static files (CSS/JS/images only, HTML served dynamically below)
app.use("/logos", express.static(path.join(__dirname, "public", "logos")));
app.use("/favicon.svg", express.static(path.join(__dirname, "public", "favicon.svg")));

// Serve dashboard — inject nothing (auth handled by cookie)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// F-02: Serve chat — requires admin session (no key exposed to browser)
app.get("/chat", (req, res) => {
  if (!hasAdminSession(req)) {
    return res.redirect("/");
  }
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

// ============================================================
// Admin auth: login/logout
// ============================================================
app.post("/admin/login", loginLimiter, (req, res) => {
  if (safeEqual(req.body.secret, ADMIN_SECRET)) {
    const sessionToken = crypto.randomBytes(32).toString('hex');
    sessions.set(sessionToken, Date.now());
    res.cookie("admin_token", sessionToken, { httpOnly: true, sameSite: "Strict", secure: true, path: "/", maxAge: 86400000 });
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Invalid admin secret" });
});

app.post("/admin/logout", (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.admin_token;
  if (token) sessions.delete(token);
  res.clearCookie("admin_token", { httpOnly: true, sameSite: "Strict", secure: true, path: "/" });
  res.json({ success: true });
});

// Check auth status
app.get("/admin/auth", adminLimiter, (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.admin_token || req.headers["x-admin-token"];
  if (!token || !sessions.has(token)) return res.json({ authenticated: false });
  const created = sessions.get(token);
  const maxAge = 24 * 60 * 60 * 1000;
  if (Date.now() - created > maxAge) {
    sessions.delete(token);
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true });
});

// ============================================================
// Admin routes (all require auth)
// ============================================================
app.use("/admin", adminLimiter, adminAuth);

app.get("/admin/uptime", (req, res) => {
  const ms = Date.now() - startTime;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  let uptime;
  if (d > 0) uptime = `${d}d ${h % 24}h ${m % 60}m`;
  else if (h > 0) uptime = `${h}h ${m % 60}m`;
  else uptime = `${m}m ${s % 60}s`;
  res.json({ uptime, startedAt: new Date(startTime).toISOString() });
});

// Test provider
app.get("/admin/test/:provider", async (req, res) => {
  const name = req.params.provider.toLowerCase();
  const provider = PROVIDERS[name];
  if (!provider || !provider.apiKey) {
    return res.json({ success: false, error: `Provider '${name}' not available` });
  }
  const start = Date.now();
  try {
    const defaultModel = MODELS[name]?.[0]?.id || "gpt-4o-mini";
    const modelId = req.query.model || defaultModel;
    const useCompletionTokens = /^(o\d|gpt-5)/.test(modelId);
    const testBody = {
      model: modelId,
      messages: [{ role: "user", content: "Say hi in 3 words" }],
      ...(useCompletionTokens ? { max_completion_tokens: 30 } : { max_tokens: 20 }),
    };
    const headers = { "Content-Type": "application/json" };
    let url;
    if (name === "anthropic") {
      headers["x-api-key"] = provider.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      url = `${provider.baseUrl}/v1/messages`;
    } else if (name === "gemini") {
      headers["Authorization"] = `Bearer ${provider.apiKey}`;
      url = `${provider.baseUrl}/v1beta/openai/chat/completions`;
    } else {
      headers["Authorization"] = `Bearer ${provider.apiKey}`;
      url = `${provider.baseUrl}/v1/chat/completions`;
    }
    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(testBody) });
    const data = await resp.json();
    const latency = Date.now() - start;
    if (resp.ok) {
      let reply, model;
      if (name === "anthropic") {
        reply = data.content?.[0]?.text || "OK";
        model = data.model || testBody.model;
      } else {
        reply = data.choices?.[0]?.message?.content || "OK";
        model = data.model || testBody.model;
      }
      const tokens = extractTokens(name, data);
      recordUsage("_test", name, modelId, tokens);
      res.json({ success: true, model, reply: reply.trim(), latency });
    } else {
      res.json({ success: false, error: data.error?.message || JSON.stringify(data), latency });
    }
  } catch (e) {
    res.json({ success: false, error: e.message, latency: Date.now() - start });
  }
});

// --- Project Keys CRUD ---
app.get("/admin/projects", (req, res) => {
  res.json(projects);
});

app.post("/admin/projects", (req, res) => {
  const { name } = req.body;
  if (!validateProjectName(name)) {
    return res.json({ success: false, error: "Invalid project name (max 64 chars, no special chars)" });
  }
  if (projects.find((p) => p.name === name)) {
    return res.json({ success: false, error: "project already exists" });
  }
  const key = "pk_" + crypto.randomBytes(24).toString("hex");
  const project = { name, key, enabled: true, createdAt: new Date().toISOString() };
  projects.push(project);
  saveProjects(projects);
  res.json({ success: true, project });
});

app.put("/admin/projects/:name", (req, res) => {
  const proj = projects.find((p) => p.name === req.params.name);
  if (!proj) return res.json({ success: false, error: "project not found" });
  if (req.body.enabled !== undefined) proj.enabled = req.body.enabled;
  if (req.body.newName) {
    if (!validateProjectName(req.body.newName)) {
      return res.json({ success: false, error: "Invalid project name" });
    }
    proj.name = req.body.newName;
  }
  saveProjects(projects);
  res.json({ success: true, project: proj });
});

app.post("/admin/projects/:name/regenerate", (req, res) => {
  const proj = projects.find((p) => p.name === req.params.name);
  if (!proj) return res.json({ success: false, error: "project not found" });
  proj.key = "pk_" + crypto.randomBytes(24).toString("hex");
  saveProjects(projects);
  res.json({ success: true, project: proj });
});

app.delete("/admin/projects/:name", (req, res) => {
  const idx = projects.findIndex((p) => p.name === req.params.name);
  if (idx === -1) return res.json({ success: false, error: "project not found" });
  projects.splice(idx, 1);
  saveProjects(projects);
  res.json({ success: true });
});

// Exchange rate
app.get("/admin/rate", (req, res) => {
  res.json(exchangeRate);
});

// --- Usage API ---
app.get("/admin/usage", (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
  const filterProject = req.query.project;
  const now = new Date();
  const result = [];

  const dailyCounts = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    const dayData = usageData[dateKey];
    if (!dayData) continue;
    dailyCounts[dateKey] = {};
    for (const [, models] of Object.entries(dayData)) {
      for (const [modelKey, stats] of Object.entries(models)) {
        dailyCounts[dateKey][modelKey] = (dailyCounts[dateKey][modelKey] || 0) + stats.count;
      }
    }
  }

  for (let i = 0; i < days; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    const dayData = usageData[dateKey];
    if (!dayData) continue;
    for (const [project, models] of Object.entries(dayData)) {
      if (filterProject && project !== filterProject) continue;
      for (const [modelKey, stats] of Object.entries(models)) {
        const [provider, ...modelParts] = modelKey.split("/");
        const modelId = modelParts.join("/");
        const info = getModelInfo(provider, modelId);
        const price = info?.price || null;
        const freeRPD = info?.freeRPD || 0;
        const dailyCount = dailyCounts[dateKey]?.[modelKey] || 0;
        result.push({
          date: dateKey, project, provider, model: modelId,
          ...stats,
          cost: Math.round(calcCost(price, stats, freeRPD, dailyCount) * 1e6) / 1e6,
        });
      }
    }
  }
  res.json(result);
});

app.get("/admin/usage/summary", (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
  const now = new Date();
  const byProject = {};
  let totalCost = 0, totalRequests = 0;

  const dailyCounts = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    const dayData = usageData[dateKey];
    if (!dayData) continue;
    dailyCounts[dateKey] = {};
    for (const [, models] of Object.entries(dayData)) {
      for (const [modelKey, stats] of Object.entries(models)) {
        dailyCounts[dateKey][modelKey] = (dailyCounts[dateKey][modelKey] || 0) + stats.count;
      }
    }
  }

  for (let i = 0; i < days; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    const dayData = usageData[dateKey];
    if (!dayData) continue;
    for (const [project, models] of Object.entries(dayData)) {
      if (!byProject[project]) byProject[project] = { requests: 0, inputTokens: 0, cacheHitTokens: 0, outputTokens: 0, cost: 0, models: {} };
      const p = byProject[project];
      for (const [modelKey, stats] of Object.entries(models)) {
        const [provider, ...modelParts] = modelKey.split("/");
        const modelId = modelParts.join("/");
        p.requests += stats.count;
        p.inputTokens += stats.inputTokens;
        p.cacheHitTokens += stats.cacheHitTokens || 0;
        p.outputTokens += stats.outputTokens;
        totalRequests += stats.count;
        if (!p.models[modelKey]) p.models[modelKey] = { count: 0, inputTokens: 0, cacheHitTokens: 0, outputTokens: 0, cost: 0 };
        const pm = p.models[modelKey];
        pm.count += stats.count;
        pm.inputTokens += stats.inputTokens;
        pm.cacheHitTokens += stats.cacheHitTokens || 0;
        pm.outputTokens += stats.outputTokens;
        const info = getModelInfo(provider, modelId);
        const price = info?.price || null;
        const freeRPD = info?.freeRPD || 0;
        const dailyCount = dailyCounts[dateKey]?.[modelKey] || 0;
        const c = calcCost(price, stats, freeRPD, dailyCount);
        pm.cost += c; p.cost += c; totalCost += c;
      }
    }
  }

  for (const p of Object.values(byProject)) {
    p.cost = Math.round(p.cost * 1e4) / 1e4;
    for (const m of Object.values(p.models)) m.cost = Math.round(m.cost * 1e6) / 1e6;
  }
  res.json({ days, totalRequests, totalCost: Math.round(totalCost * 1e4) / 1e4, byProject });
});

// Update API key at runtime + persist to .env (sanitized)
app.post("/admin/key", async (req, res) => {
  const { provider, apiKey, baseUrl } = req.body;
  if (!provider || !apiKey) {
    return res.json({ success: false, error: "provider and apiKey required" });
  }
  const name = provider.toLowerCase();
  if (!PROVIDERS[name]) {
    return res.json({ success: false, error: `Unknown provider: ${name}` });
  }
  const safeKey = sanitizeEnvValue(apiKey);
  const safeUrl = baseUrl ? sanitizeEnvValue(baseUrl) : null;

  if (!/^[a-zA-Z0-9_\-\.]+$/.test(safeKey)) {
    return res.status(400).json({ success: false, error: "Invalid API key format — only alphanumeric, underscore, hyphen, and dot allowed" });
  }
  // F-03: Validate baseUrl with URL parsing, hostname allowlist, and DNS resolution
  if (safeUrl) {
    let parsed;
    try {
      parsed = new URL(safeUrl);
    } catch {
      return res.status(400).json({ success: false, error: "Invalid baseUrl — malformed URL" });
    }
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
      return res.status(400).json({ success: false, error: "Invalid baseUrl — must use https:// (except localhost)" });
    }
    // Hostname allowlist: only known provider hosts or localhost
    if (parsed.hostname !== "localhost" && !PROVIDER_HOST_ALLOWLIST.has(parsed.hostname)) {
      return res.status(400).json({
        success: false,
        error: `Invalid baseUrl — hostname '${parsed.hostname}' is not in the provider allowlist. Allowed: ${[...PROVIDER_HOST_ALLOWLIST].join(", ")}`,
      });
    }
    // DNS resolution check: block private IPs (prevents DNS rebinding)
    if (parsed.hostname !== "localhost") {
      try {
        const { address } = await dnsLookup(parsed.hostname);
        if (isPrivateIP(address)) {
          return res.status(400).json({ success: false, error: "Invalid baseUrl — resolves to a private/internal IP address" });
        }
      } catch {
        return res.status(400).json({ success: false, error: "Invalid baseUrl — DNS resolution failed" });
      }
    }
  }

  PROVIDERS[name].apiKey = safeKey;
  if (safeUrl) PROVIDERS[name].baseUrl = safeUrl;

  try {
    const envPath = path.join(__dirname, ".env");
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const keyName = `${name.toUpperCase()}_API_KEY`;
    const keyRegex = new RegExp(`^${keyName}=.*$`, "m");
    if (keyRegex.test(envContent)) {
      envContent = envContent.replace(keyRegex, `${keyName}=${safeKey}`);
    } else {
      envContent += `\n${keyName}=${safeKey}`;
    }
    if (safeUrl) {
      const urlName = `${name.toUpperCase()}_BASE_URL`;
      const urlRegex = new RegExp(`^${urlName}=.*$`, "m");
      if (urlRegex.test(envContent)) {
        envContent = envContent.replace(urlRegex, `${urlName}=${safeUrl}`);
      } else {
        envContent += `\n${urlName}=${safeUrl}`;
      }
    }
    // F-05: Write with strict permissions (owner read/write only)
    fs.writeFileSync(envPath, envContent, { mode: 0o600 });
  } catch (e) {
    console.error("Failed to persist .env:", e.message);
  }
  res.json({ success: true, message: `${name} key updated` });
});

// ============================================================
// API Proxy — /v1/:provider/*
// ============================================================
const proxyMiddleware = createProxyMiddleware({
  router: (req) => {
    const provider = req.params?.provider?.toLowerCase();
    return PROVIDERS[provider]?.baseUrl;
  },
  changeOrigin: true,
  ws: false,
  timeout: 120000,
  proxyTimeout: 120000,
  pathRewrite: (pathStr, req) => {
    const providerName = req.params?.provider?.toLowerCase();
    const stripped = pathStr.replace(`/v1/${providerName}`, "");
    if (providerName === "gemini") {
      return stripped.replace(/^\/v1\//, "/v1beta/openai/");
    }
    // Doubao/Qwen base URL already includes API version prefix
    if (providerName === "doubao") {
      return stripped.replace(/^\/v1\//, "/");
    }
    return stripped;
  },
  on: {
    proxyReq: (proxyReq, req) => {
      if (req.body && ["POST", "PUT", "PATCH"].includes(req.method)) {
        const bodyData = JSON.stringify(req.body);
        proxyReq.setHeader("Content-Type", "application/json");
        proxyReq.setHeader("Content-Length", Buffer.byteLength(bodyData));
        proxyReq.write(bodyData);
      }
    },
    proxyRes: (proxyRes, req) => {
      const providerName = req.params?.provider?.toLowerCase();
      const projectName = req._proxyProjectName;
      const modelId = req.body?.model || "unknown";
      const isStreaming = req.body?.stream === true;

      let tail = '';
      proxyRes.on("data", (chunk) => {
        const str = chunk.toString();
        tail = (tail + str).slice(-8192);
      });
      proxyRes.on("end", () => {
        try {
          let tokens;
          if (isStreaming) {
            tokens = extractTokensFromSSE(providerName, tail);
            if (!tokens) {
              const inputText = JSON.stringify(req.body?.messages || "");
              tokens = { input: Math.ceil(inputText.length / 4), cacheHit: 0, output: 0 };
            }
          } else {
            tokens = extractTokens(providerName, tail);
          }
          recordUsage(projectName, providerName, modelId, tokens);
        } catch (e) {
          console.error("Usage tracking error:", e.message);
        }
      });
    },
    error: (err, req, res) => {
      const providerName = req.params?.provider?.toLowerCase() || "unknown";
      console.error(`Proxy error [${providerName}]:`, err.message);
      if (!res.headersSent) res.status(502).json({ error: "Proxy error" });
    },
  },
});

app.use("/v1/:provider", apiLimiter, (req, res, next) => {
  // Identify project: internal chat key, admin session, project key, or reject
  let projectName;
  const projectKey =
    req.headers["x-project-key"] ||
    (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");

  if (safeEqual(projectKey, INTERNAL_CHAT_KEY)) {
    // Server-internal chat key (never exposed to browser)
    projectName = "_chat";
  } else if (hasAdminSession(req)) {
    // F-02: Admin session cookie (from /chat page)
    projectName = "_chat";
  } else {
    // F-01: Always enforce project-key validation (removed projects.length bypass)
    const proj = projects.find(p => p.enabled && safeEqual(p.key, projectKey));
    if (!proj) {
      return res.status(401).json({
        error: "Invalid or missing project key",
        hint: "Set X-Project-Key header or Bearer token",
      });
    }
    projectName = proj.name;
  }

  const providerName = req.params.provider.toLowerCase();
  const provider = PROVIDERS[providerName];

  // F-10: Don't leak provider list in error response
  if (!provider) {
    return res.status(404).json({ error: "Unknown provider" });
  }
  if (!provider.apiKey) {
    return res.status(403).json({ error: "Provider has no API key configured" });
  }

  // F-04: Validate upstream path against allowlist
  const incomingSubpath = req.path.replace(new RegExp(`^/v1/${providerName}`, "i"), "");
  const allowedPaths = ALLOWED_UPSTREAM_PATHS[providerName];
  if (allowedPaths && !allowedPaths.some(p => incomingSubpath.startsWith(p))) {
    return res.status(403).json({ error: "Requested API path is not allowed for this provider" });
  }

  // Stash project name for onProxyRes
  req._proxyProjectName = projectName;

  // Inject auth — replace any client-sent auth
  if (providerName === "anthropic") {
    req.headers["x-api-key"] = provider.apiKey;
    req.headers["anthropic-version"] = req.headers["anthropic-version"] || "2023-06-01";
    delete req.headers["authorization"];
  } else {
    req.headers["authorization"] = `Bearer ${provider.apiKey}`;
  }
  delete req.headers["host"];
  delete req.headers["x-project-key"];

  proxyMiddleware(req, res, next);
});

// Global error handler — prevent stack trace leakage
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  console.error(`[${req.method} ${req.path}] ${err.message}`);
  res.status(status).json({ error: status === 400 ? "Bad request" : "Internal server error" });
});

// ============================================================
// Start server + graceful shutdown
// ============================================================
const server = app.listen(PORT, "0.0.0.0", () => {
  const available = Object.entries(PROVIDERS)
    .filter(([, cfg]) => cfg.apiKey)
    .map(([name]) => name);
  console.log(`AI API Gateway running on port ${PORT}`);
  console.log(`Available providers: ${available.join(", ")}`);
  console.log(`Admin auth: ${process.env.ADMIN_SECRET ? "configured" : "temporary (set ADMIN_SECRET in .env)"}`);
});

// Track raw TCP connections for graceful shutdown
const connections = new Set();
server.on("connection", (conn) => {
  connections.add(conn);
  conn.on("close", () => connections.delete(conn));
});

let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down gracefully...`);

  // Save data immediately
  if (usageDirty) saveUsage();

  // Stop accepting new connections
  server.close(() => {
    console.log("All connections drained, exiting");
    process.exit(0);
  });

  // Give existing connections 10s to finish
  setTimeout(() => {
    console.log(`Forcing shutdown — ${connections.size} connections remaining`);
    connections.forEach((c) => c.destroy());
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
