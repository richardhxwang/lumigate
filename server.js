const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { createProxyMiddleware } = require("http-proxy-middleware");
require("dotenv").config();

const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const startTime = Date.now();

// Project keys storage
const PROJECTS_FILE = path.join(__dirname, "data", "projects.json");

function loadProjects() {
  try {
    const dir = path.dirname(PROJECTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(PROJECTS_FILE)) {
      return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Failed to load projects:", e.message);
  }
  return [];
}

function saveProjects(projects) {
  const dir = path.dirname(PROJECTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

let projects = loadProjects();

// --- Exchange rate ---
const RATE_FILE = path.join(__dirname, "data", "exchange-rate.json");
let exchangeRate = { USD_CNY: 7.24, updatedAt: null };

function loadRate() {
  try {
    if (fs.existsSync(RATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(RATE_FILE, "utf8"));
      if (saved.USD_CNY) exchangeRate = saved;
    }
  } catch {}
}
loadRate();

async function fetchExchangeRate() {
  try {
    const resp = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await resp.json();
    if (data.result === "success" && data.rates?.CNY) {
      exchangeRate = { USD_CNY: data.rates.CNY, updatedAt: new Date().toISOString() };
      const dir = path.dirname(RATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(RATE_FILE, JSON.stringify(exchangeRate, null, 2));
      console.log(`Exchange rate updated: 1 USD = ${exchangeRate.USD_CNY} CNY`);
    }
  } catch (e) {
    console.error("Failed to fetch exchange rate:", e.message);
  }
}

// Fetch on startup if stale (>7 days), then weekly
(function initRate() {
  const age = exchangeRate.updatedAt ? Date.now() - new Date(exchangeRate.updatedAt).getTime() : Infinity;
  if (age > 7 * 24 * 60 * 60 * 1000) fetchExchangeRate();
})();
setInterval(fetchExchangeRate, 7 * 24 * 60 * 60 * 1000);

// --- Usage tracking ---
const USAGE_FILE = path.join(__dirname, "data", "usage.json");

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

function saveUsage() {
  try {
    const dir = path.dirname(USAGE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usageData, null, 2));
    usageDirty = false;
  } catch (e) {
    console.error("Failed to save usage:", e.message);
  }
}

// Flush usage to disk every 30s if dirty
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

// calcCost: freeRPD = free requests/day for this model, dailyCount = how many used today
function calcCost(price, stats, freeRPD, dailyCount) {
  if (!price) return 0;
  // If all requests fall within free tier, cost is 0
  if (freeRPD && dailyCount <= freeRPD) return 0;
  // If partially free: ratio of paid requests
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

// Extract token usage from provider API response body
function extractTokens(providerName, body) {
  try {
    const j = typeof body === "string" ? JSON.parse(body) : body;
    if (providerName === "anthropic") {
      const u = j.usage || {};
      return {
        input: (u.input_tokens || 0),
        cacheHit: (u.cache_read_input_tokens || 0),
        output: (u.output_tokens || 0),
      };
    }
    // OpenAI / DeepSeek / Gemini (OpenAI-compatible)
    const u = j.usage || {};
    const cached = u.prompt_tokens_details?.cached_tokens
      || u.prompt_cache_hit_tokens || 0;
    return {
      input: (u.prompt_tokens || u.total_tokens || 0),
      cacheHit: cached,
      output: (u.completion_tokens || 0),
    };
  } catch {
    return { input: 0, cacheHit: 0, output: 0 };
  }
}

// For streaming SSE, extract usage from last data chunks
function extractTokensFromSSE(providerName, chunks) {
  // Walk backwards through chunks to find usage data
  const lines = chunks.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    try {
      const j = JSON.parse(data);
      // Anthropic message_delta has usage
      if (providerName === "anthropic" && j.type === "message_delta" && j.usage) {
        return { input: 0, cacheHit: 0, output: j.usage.output_tokens || 0 };
      }
      // OpenAI/DeepSeek: last chunk sometimes has usage
      if (j.usage) {
        return extractTokens(providerName, JSON.stringify(j));
      }
    } catch {}
  }
  return null;
}

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Serve dashboard
app.use(express.static(path.join(__dirname, "public")));

// Provider configuration - add new providers here
const PROVIDERS = {
  deepseek: {
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
  },
  openai: {
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com",
    apiKey: process.env.OPENAI_API_KEY,
  },
  anthropic: {
    baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  gemini: {
    baseUrl:
      process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com",
    apiKey: process.env.GEMINI_API_KEY,
  },
};

// Models per provider — price in $/M tokens: { in, cacheIn, out }
// cacheIn = price when prompt cache hits (DeepSeek/OpenAI/Anthropic/Gemini all support)
const MODELS = {
  deepseek: [
    { id: "deepseek-chat", tier: "economy", price: { in: 0.27, cacheIn: 0.018, out: 1.10 }, caps: ["text"], desc: "中英文对话/翻译/摘要/批量文本处理" },
    { id: "deepseek-reasoner", tier: "flagship", price: { in: 0.55, cacheIn: 0.14, out: 2.19 }, caps: ["text"], desc: "数学证明/竞赛题/代码debug，CoT深度推理链" },
  ],
  openai: [
    { id: "gpt-4.1-nano", tier: "economy", price: { in: 0.10, cacheIn: 0.025, out: 0.40 }, caps: ["text"], desc: "分类/提取/路由分发，最低成本，1M上下文" },
    { id: "gpt-4.1-mini", tier: "economy", price: { in: 0.40, cacheIn: 0.10, out: 1.60 }, caps: ["text", "image"], desc: "摘要/客服/简单代码生成，1M上下文，支持图片识别" },
    { id: "o3-mini", tier: "economy", price: { in: 1.10, cacheIn: 0.55, out: 4.40 }, caps: ["text"], desc: "代码生成/数学推理，推理模型中性价比最高" },
    { id: "gpt-5-mini", tier: "standard", price: { in: 0.25, cacheIn: 0.0625, out: 2.00 }, caps: ["text", "image"], desc: "GPT-5轻量版，日常编程/写作/分析，速度与智能均衡" },
    { id: "gpt-4.1", tier: "standard", price: { in: 2.00, cacheIn: 0.50, out: 8.00 }, caps: ["text", "image"], desc: "指令遵循/长文档处理/函数调用，1M上下文，支持图片识别" },
    { id: "o4-mini", tier: "standard", price: { in: 1.10, cacheIn: 0.275, out: 4.40 }, caps: ["text", "image"], desc: "多步工具编排/代码执行/复杂函数调用链，支持视觉" },
    { id: "o3", tier: "flagship", price: { in: 2.00, cacheIn: 0.50, out: 8.00 }, caps: ["text", "image"], desc: "PhD级科学推理/竞赛编程/研究分析，200K上下文" },
    { id: "gpt-5", tier: "flagship", price: { in: 1.25, cacheIn: 0.3125, out: 10.00 }, caps: ["text", "image", "audio", "video"], desc: "原生多模态旗舰，支持图片/音频/视频输入，超长上下文" },
    { id: "gpt-5.4", tier: "flagship", price: { in: 2.50, cacheIn: 0.625, out: 15.00 }, caps: ["text", "image", "audio", "video"], desc: "GPT系最强，全模态输入，最新迭代顶级智能" },
  ],
  anthropic: [
    { id: "claude-haiku-4-5-20251001", tier: "economy", price: { in: 0.80, cacheIn: 0.08, out: 4.00 }, caps: ["text", "image", "pdf"], desc: "代码补全/分类标注/文本摘要，亚秒响应，200K上下文" },
    { id: "claude-sonnet-4-5-20250514", tier: "standard", price: { in: 3.00, cacheIn: 0.30, out: 15.00 }, caps: ["text", "image", "pdf"], desc: "扩展思考/复杂编程/长文写作，代码能力行业标杆" },
    { id: "claude-opus-4-6", tier: "flagship", price: { in: 15.00, cacheIn: 1.50, out: 75.00 }, caps: ["text", "image", "pdf"], desc: "自主编程/深度研究/200K长文分析，最强推理与长期记忆" },
  ],
  gemini: [
    { id: "gemini-2.5-flash-lite", tier: "economy", price: { in: 0.075, cacheIn: 0.01875, out: 0.30 }, freeRPD: 1500, caps: ["text", "image"], desc: "高并发摘要/分类/提取，批量pipeline首选，1500次/天免费" },
    { id: "gemini-2.5-flash", tier: "standard", price: { in: 0.15, cacheIn: 0.0375, out: 0.60 }, freeRPD: 500, caps: ["text", "image", "audio", "video", "pdf"], desc: "代码生成/数学推理/思考模型，1M上下文，500次/天免费" },
    { id: "gemini-2.5-pro", tier: "flagship", price: { in: 1.25, cacheIn: 0.3125, out: 10.00 }, freeRPD: 25, caps: ["text", "image", "audio", "video", "pdf"], desc: "多模态视频分析/1M长上下文，25次/天免费" },
  ],
};

// Chat page
app.get("/chat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

// Health check
app.get("/health", (req, res) => {
  const available = Object.entries(PROVIDERS)
    .filter(([, cfg]) => cfg.apiKey)
    .map(([name]) => name);
  res.json({ status: "ok", providers: available });
});

// List available providers
app.get("/providers", (req, res) => {
  const providers = Object.entries(PROVIDERS).map(([name, cfg]) => ({
    name,
    available: !!cfg.apiKey,
    baseUrl: cfg.baseUrl,
  }));
  res.json(providers);
});

// List models per provider
app.get("/models/:provider", (req, res) => {
  const name = req.params.provider.toLowerCase();
  res.json(MODELS[name] || []);
});

// Admin: uptime
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

// Admin: test provider connection
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
    // o-series and gpt-5+ require max_completion_tokens instead of max_tokens
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
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(testBody),
    });
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
      // Record test usage
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
  if (!name) return res.json({ success: false, error: "name required" });
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
  if (req.body.newName) proj.name = req.body.newName;
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
  const days = parseInt(req.query.days) || 30;
  const filterProject = req.query.project;
  const now = new Date();
  const result = [];

  // Pre-compute daily counts per model for Gemini free tier
  const dailyCounts = {}; // dateKey -> modelKey -> total count across all projects
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
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
    const d = new Date(now);
    d.setDate(d.getDate() - i);
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

// Usage summary: aggregated totals
app.get("/admin/usage/summary", (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const now = new Date();
  const byProject = {};
  let totalCost = 0, totalRequests = 0;

  // Pre-compute daily counts per model for Gemini free tier
  const dailyCounts = {}; // dateKey -> modelKey -> total count
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
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
    const d = new Date(now);
    d.setDate(d.getDate() - i);
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

// Admin: update API key at runtime + persist to .env
app.post("/admin/key", (req, res) => {
  const { provider, apiKey, baseUrl } = req.body;
  if (!provider || !apiKey) {
    return res.json({ success: false, error: "provider and apiKey required" });
  }
  const name = provider.toLowerCase();
  if (!PROVIDERS[name]) {
    return res.json({ success: false, error: `Unknown provider: ${name}` });
  }
  PROVIDERS[name].apiKey = apiKey;
  if (baseUrl) PROVIDERS[name].baseUrl = baseUrl;

  // Persist to .env
  try {
    const envPath = path.join(__dirname, ".env");
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const keyName = `${name.toUpperCase()}_API_KEY`;
    const keyRegex = new RegExp(`^${keyName}=.*$`, "m");
    if (keyRegex.test(envContent)) {
      envContent = envContent.replace(keyRegex, `${keyName}=${apiKey}`);
    } else {
      envContent += `\n${keyName}=${apiKey}`;
    }
    if (baseUrl) {
      const urlName = `${name.toUpperCase()}_BASE_URL`;
      const urlRegex = new RegExp(`^${urlName}=.*$`, "m");
      if (urlRegex.test(envContent)) {
        envContent = envContent.replace(urlRegex, `${urlName}=${baseUrl}`);
      } else {
        envContent += `\n${urlName}=${baseUrl}`;
      }
    }
    fs.writeFileSync(envPath, envContent);
  } catch (e) {
    console.error("Failed to persist .env:", e.message);
  }
  res.json({ success: true, message: `${name} key updated` });
});

// Universal proxy: /v1/provider/chat/completions -> provider's API
app.use("/v1/:provider", (req, res, next) => {
  // Identify project
  let projectName = "_chat"; // default for built-in chat
  if (projects.length > 0) {
    const projectKey =
      req.headers["x-project-key"] ||
      (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    const referer = req.headers["referer"] || "";
    const isSameOrigin =
      referer.includes("/chat") &&
      (referer.startsWith(`http://localhost`) ||
        referer.startsWith(`http://127.0.0.1`) ||
        referer.includes(req.headers["host"]));
    if (!isSameOrigin) {
      const proj = projects.find((p) => p.key === projectKey && p.enabled);
      if (!proj) {
        return res.status(401).json({
          error: "Invalid or missing project key",
          hint: "Set X-Project-Key header or Bearer token",
        });
      }
      projectName = proj.name;
    }
  }

  const providerName = req.params.provider.toLowerCase();
  const provider = PROVIDERS[providerName];

  if (!provider) {
    return res.status(404).json({
      error: `Unknown provider: ${providerName}`,
      available: Object.keys(PROVIDERS),
    });
  }

  if (!provider.apiKey) {
    return res.status(403).json({
      error: `Provider '${providerName}' has no API key configured`,
    });
  }

  // Extract model from request body for usage tracking
  const modelId = req.body?.model || "unknown";
  const isStreaming = req.body?.stream === true;

  // Inject auth header
  if (providerName === "anthropic") {
    req.headers["x-api-key"] = provider.apiKey;
    req.headers["anthropic-version"] = req.headers["anthropic-version"] || "2023-06-01";
  } else {
    req.headers["authorization"] = `Bearer ${provider.apiKey}`;
  }

  delete req.headers["host"];

  const proxy = createProxyMiddleware({
    target: provider.baseUrl,
    changeOrigin: true,
    pathRewrite: (pathStr) => {
      const stripped = pathStr.replace(`/v1/${providerName}`, "");
      if (providerName === "gemini") {
        return stripped.replace(/^\/v1\//, "/v1beta/openai/");
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
        // Capture response body to extract token usage
        let chunks = "";
        proxyRes.on("data", (chunk) => { chunks += chunk.toString(); });
        proxyRes.on("end", () => {
          try {
            let tokens;
            if (isStreaming) {
              tokens = extractTokensFromSSE(providerName, chunks);
              // If SSE didn't have usage, estimate from input
              if (!tokens) {
                const inputText = JSON.stringify(req.body?.messages || "");
                tokens = { input: Math.ceil(inputText.length / 4), cacheHit: 0, output: 0 };
              }
            } else {
              tokens = extractTokens(providerName, chunks);
            }
            recordUsage(projectName, providerName, modelId, tokens);
          } catch (e) {
            console.error("Usage tracking error:", e.message);
          }
        });
      },
      error: (err, req, res) => {
        console.error(`Proxy error [${providerName}]:`, err.message);
        if (!res.headersSent) {
          res.status(502).json({ error: "Proxy error", detail: err.message });
        }
      },
    },
  });

  proxy(req, res, next);
});

app.listen(PORT, "0.0.0.0", () => {
  const available = Object.entries(PROVIDERS)
    .filter(([, cfg]) => cfg.apiKey)
    .map(([name]) => name);
  console.log(`AI API Proxy running on port ${PORT}`);
  console.log(`Available providers: ${available.join(", ")}`);
});

// Save usage on shutdown
process.on("SIGTERM", () => { if (usageDirty) saveUsage(); process.exit(0); });
process.on("SIGINT", () => { if (usageDirty) saveUsage(); process.exit(0); });
