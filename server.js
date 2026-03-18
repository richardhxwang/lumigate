const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const dns = require("dns");
const os = require("os");
const { promisify } = require("util");
const { Readable, PassThrough } = require("stream");
const { StringDecoder } = require("string_decoder");
const { createProxyMiddleware } = require("http-proxy-middleware");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
require("dotenv").config();

const { detectPII, getMapping, checkCommand, detectSecrets } = require("./security");
const { registry, executeToolCall, TOOL_SYSTEM_PROMPT } = require("./tools/registry");
const { unifiedRegistry } = require("./tools/unified-registry");
const { createSecurityMiddleware } = require("./middleware/security-middleware");
const { createAuditMiddleware } = require("./middleware/audit-middleware");

const dnsLookup = promisify(dns.lookup);

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// --- TOTP (RFC 6238) — compatible with Google Authenticator, Okta Verify, Authy ---
function base32Decode(str) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  str = str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0;
  const bytes = [];
  for (const c of str) {
    const idx = alpha.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 0xff); }
  }
  return Buffer.from(bytes);
}
function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) { buf[i] = Number(c & 0xffn); c >>= 8n; }
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(code).padStart(6, '0');
}
function verifyTotp(secretBase32, code) {
  const str = String(code).padStart(6, '0');
  const t = Math.floor(Date.now() / 30000);
  for (let i = -1; i <= 1; i++) { if (hotp(secretBase32, t + i) === str) return true; }
  return false;
}
function generateTotpSecret() {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  return [...crypto.randomBytes(20)].map(b => alpha[b % 32]).join('');
}
function totpUri(secret, label, issuer = 'LumiGate') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// --- Structured logging ---
function log(level, msg, ctx = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...ctx }) + "\n");
}

// --- Webhook alerts (non-blocking, fire-and-forget) ---
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;
function sendAlert(type, payload) {
  if (!ALERT_WEBHOOK_URL) return;
  fetch(ALERT_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ts: new Date().toISOString(), gateway: "lumigate", ...payload }),
  }).catch(() => {}); // silent fail — never affects main flow
}

async function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = await new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, (err, buf) => err ? reject(err) : resolve(buf.toString('hex')))
  );
  return { hash, salt };
}

async function verifyPassword(password, storedHash, salt) {
  const { hash } = await hashPassword(password, salt);
  return safeEqual(hash, storedHash);
}

// --- Encryption helpers for API key storage ---
let _derivedEncKey = null;
function deriveEncKey(secret) {
  if (!_derivedEncKey) _derivedEncKey = crypto.scryptSync(secret, 'lumigate-enc-salt', 32);
  return _derivedEncKey;
}

function encryptValue(plaintext, secret) {
  const key = deriveEncKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'ENC:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptValue(stored, secret) {
  if (!stored.startsWith('ENC:')) return stored; // plaintext passthrough
  const key = deriveEncKey(secret);
  const buf = Buffer.from(stored.slice(4), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc, undefined, 'utf8') + decipher.final('utf8');
}

const sessions = new Map();
const MAX_SESSIONS = 10000;
const mfaTokens = new Map(); // mfaToken → {username, role, expiresAt}
setInterval(() => { const now = Date.now(); for (const [k, v] of mfaTokens) if (v.expiresAt < now) mfaTokens.delete(k); }, 60000);

// --- Module system ---
// Modules: usage, budget, multikey, users, audit, metrics, backup, smart, chat
const ALL_MODULES = ["usage", "budget", "multikey", "users", "audit", "metrics", "backup", "smart", "chat"];
const LITE_MODULES = ["usage", "chat", "backup"];
const ENTERPRISE_MODULES = [...ALL_MODULES];
let DEPLOY_MODE = (process.env.DEPLOY_MODE || "lite").toLowerCase();
let modules = new Set(
  DEPLOY_MODE === "enterprise" ? ENTERPRISE_MODULES :
  DEPLOY_MODE === "custom" ? (process.env.MODULES || "").split(",").map(s => s.trim()).filter(Boolean) :
  LITE_MODULES
);
const mod = (name) => modules.has(name);
// isEnterprise is now a getter for runtime switching
let isEnterprise = DEPLOY_MODE === "enterprise";

function applyDeployMode(mode, customModules) {
  DEPLOY_MODE = mode;
  isEnterprise = mode === "enterprise";
  if (mode === "enterprise") modules = new Set(ENTERPRISE_MODULES);
  else if (mode === "custom" && customModules) modules = new Set(customModules.filter(m => ALL_MODULES.includes(m)));
  else modules = new Set(LITE_MODULES);
  console.log(`[HOT SWITCH] Mode: ${DEPLOY_MODE}, modules: ${[...modules].join(",")}`);
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
const PORT = process.env.PORT || 9471;
const startTime = Date.now();

// --- Security: Admin secret & internal chat key ---
const ADMIN_SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(20).toString("hex");
const INTERNAL_CHAT_KEY = crypto.randomBytes(20).toString("hex"); // rotates on restart
const PB_URL = process.env.PB_URL || "http://localhost:8090";

if (!process.env.ADMIN_SECRET) {
  console.log("WARNING: No ADMIN_SECRET set — a temporary secret was generated. Set ADMIN_SECRET in .env for persistence.");
}

// --- Helpers ---
function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || "").split(";").forEach((c) => {
    const [k, ...v] = c.trim().split("=");
    if (k) {
      try { cookies[k.trim()] = decodeURIComponent(v.join("=")); }
      catch { /* ignore malformed cookie value */ }
    }
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

// Validate PocketBase record ID format (15-char alphanumeric)
function isValidPbId(id) {
  return typeof id === 'string' && /^[a-z0-9]{15}$/i.test(id);
}

function pbErrorSummary(data, fallback = "PocketBase request failed") {
  if (!data || typeof data !== "object") return fallback;
  const fieldErrors = Object.entries(data.data || {})
    .map(([field, value]) => {
      if (!value || typeof value !== "object") return null;
      return value.message ? `${field}: ${value.message}` : null;
    })
    .filter(Boolean);
  return fieldErrors[0] || data.error || data.message || fallback;
}

function clampPbMessageContent(content) {
  const s = String(content || "").trim();
  const MAX = 5000;
  if (s.length <= MAX) return s;
  const suffix = "\n\n[Truncated for PocketBase storage]";
  return s.slice(0, MAX - suffix.length).trimEnd() + suffix;
}

const AUTO_CONTINUE_MAX_PASSES = 12;

function shouldAutoContinueFinishReason(reason) {
  const r = String(reason || "").toLowerCase();
  return ["length", "max_tokens", "max_output_tokens", "token_limit", "max_token"].includes(r);
}

function getContinuationPrompt(lang = "en") {
  return lang === "zh"
    ? "继续上一条回答，从刚才中断的地方直接接着写。不要重复已经输出过的内容，不要重述任务，不要加新的开场白。"
    : "Continue the previous answer exactly where you stopped. Do not repeat prior content, do not restate the task, and do not add a new introduction.";
}

async function touchLcSession(sessionId, lcToken) {
  if (!validPbId(sessionId) || !lcToken) return;
  const getResp = await lcPbFetch(`/api/collections/lc_sessions/records/${sessionId}`, {
    headers: { Authorization: `Bearer ${lcToken}` },
  });
  if (!getResp.ok) return;
  const sessionData = await getResp.json();
  const patchBody = {
    title: sessionData.title || "New Chat",
    provider: sessionData.provider || "openai",
    model: sessionData.model || "gpt-4.1-mini",
  };
  if (lcSupportsField("sessions", "updated_at")) patchBody.updated_at = lcNowIso();
  if (sessionData.project) patchBody.project = sessionData.project;
  await lcPbFetch(`/api/collections/lc_sessions/records/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${lcToken}` },
    body: JSON.stringify(patchBody),
  });
}

function pbFilter(expr) {
  return encodeURIComponent(expr);
}

function validateSmartRouting(sr) {
  if (!sr || typeof sr !== "object") return { enabled: false };
  const providerNames = Object.keys(PROVIDERS);
  const result = {
    enabled: sr.enabled === true,
    classifierProvider: providerNames.includes(sr.classifierProvider) ? sr.classifierProvider : "deepseek",
    classifierModel: typeof sr.classifierModel === "string" ? sr.classifierModel.slice(0, 64) : "deepseek-chat",
    candidates: [],
  };
  if (sr.defaultModel && typeof sr.defaultModel === "object"
    && providerNames.includes(sr.defaultModel.provider)
    && typeof sr.defaultModel.model === "string") {
    result.defaultModel = { provider: sr.defaultModel.provider, model: sr.defaultModel.model.slice(0, 64) };
  }
  if (Array.isArray(sr.candidates)) {
    result.candidates = sr.candidates
      .filter(c => c && providerNames.includes(c.provider) && typeof c.model === "string")
      .map(c => ({ provider: c.provider, model: c.model.slice(0, 64) }))
      .slice(0, 20); // max 20 candidates
  }
  return result;
}

// F-03: Check if hostname resolves to a private/internal IP
function isPrivateIP(ip) {
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.0\.0\.0|169\.254\.)/.test(ip)) return true;
  if (ip === "::1" || ip === "[::1]" || ip.startsWith("fe80:") || ip.startsWith("fc00:") || ip.startsWith("fd")) return true;
  if (ip === "169.254.169.254") return true;
  return false;
}

// F-06: Normalize IP for rate-limit keying (handle IPv6-mapped IPv4)
// Prefer CF-Connecting-IP (injected by Cloudflare edge, cannot be spoofed when behind CF).
// Fall back to req.ip (set by Express trust proxy from X-Forwarded-For chain).
// Never trust a raw X-Forwarded-For from the client directly.
function normalizeIP(req) {
  const cfIp = req.headers["cf-connecting-ip"]?.trim();
  const ip = cfIp || req.ip || "unknown";
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

// Per-project rate limiter (in-memory, 1-min buckets)
// Two tiers: project-wide total RPM + per-IP RPM within project
const projectRateBuckets = new Map(); // projectName -> { count, resetAt }
const projectIpRateBuckets = new Map(); // "projectName:ip" -> { count, resetAt }
const projectTokenIssueBuckets = new Map(); // projectName -> { count, resetAt } — limits token generation rate
// Default: max 60 token issuances per project per minute (configurable per project via tokenIssuanceRpm).
// Prevents multi-token bypass: attacker with 1 pk_ cannot issue N tokens to multiply per-token RPM.
const TOKEN_ISSUE_RPM_DEFAULT = 60;
function checkProjectRateLimit(proj, req) {
  const now = Date.now();
  // Tier 1: Per-IP within project (maxRpmPerIp)
  if (proj.maxRpmPerIp && req) {
    const ip = normalizeIP(req);
    const ipKey = `${proj.name}:${ip}`;
    let ipBucket = projectIpRateBuckets.get(ipKey);
    if (!ipBucket || now >= ipBucket.resetAt) {
      ipBucket = { count: 0, resetAt: now + 60000 };
      projectIpRateBuckets.set(ipKey, ipBucket);
    }
    ipBucket.count++;
    if (ipBucket.count > proj.maxRpmPerIp) return { ok: false, reason: "ip" };
  }
  // Tier 2: Project-wide total RPM (maxRpm)
  if (proj.maxRpm) {
    let bucket = projectRateBuckets.get(proj.name);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + 60000 };
      projectRateBuckets.set(proj.name, bucket);
    }
    bucket.count++;
    if (bucket.count > proj.maxRpm) return { ok: false, reason: "project" };
  }
  return { ok: true };
}
// Per-token rate limiting — each ephemeral token has its own RPM bucket
const tokenRateBuckets = new Map(); // tokenStr -> { count, resetAt }
function checkTokenRateLimit(tokenStr, proj) {
  const limit = proj.maxRpmPerToken || proj.maxRpmPerIp; // fallback to per-IP limit
  if (!limit) return { ok: true };
  const now = Date.now();
  let bucket = tokenRateBuckets.get(tokenStr);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60000 };
    tokenRateBuckets.set(tokenStr, bucket);
  }
  bucket.count++;
  if (bucket.count > limit) return { ok: false, reason: "token" };
  return { ok: true };
}

// Cost-based rate limiting — cap USD spend per minute per project
const projectCostBuckets = new Map(); // projectName -> { cost, resetAt }
function checkCostRateLimit(proj) {
  if (!proj.maxCostPerMin) return { ok: true };
  const now = Date.now();
  let bucket = projectCostBuckets.get(proj.name);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { cost: 0, resetAt: now + 60000 };
    projectCostBuckets.set(proj.name, bucket);
  }
  // Check before the request (pre-flight) — block if already over limit
  if (bucket.cost >= proj.maxCostPerMin) return { ok: false, reason: "cost" };
  return { ok: true };
}
function recordCostForRateLimit(projName, cost) {
  const bucket = projectCostBuckets.get(projName);
  if (bucket) bucket.cost += cost;
}

// --- Key cooldown tracker (per-key, in-memory) ---
const keyCooldowns = new Map(); // keyId -> { until, reason, count }
const KEY_COOLDOWN_429_MS = 60_000;  // 60s on rate-limit
const KEY_COOLDOWN_401_MS = 600_000; // 10min on auth failure

function isKeyCooling(keyId) {
  const c = keyCooldowns.get(keyId);
  if (!c) return false;
  if (Date.now() > c.until) { keyCooldowns.delete(keyId); return false; }
  return true;
}

function markKeyCooling(keyId, statusCode) {
  const existing = keyCooldowns.get(keyId) || { count: 0 };
  const count = existing.count + 1;
  const ms = statusCode === 401 ? KEY_COOLDOWN_401_MS : KEY_COOLDOWN_429_MS;
  keyCooldowns.set(keyId, { until: Date.now() + ms, reason: String(statusCode), count });
  if (statusCode === 401 && count >= 3) {
    autoDisableKey(keyId);
    sendAlert("key_disabled", { keyId, reason: "401x3" });
  }
}

function autoDisableKey(keyId) {
  for (const [provName, keys] of Object.entries(providerKeys)) {
    const k = keys.find(k => k.id === keyId);
    if (k) {
      k.enabled = false;
      saveKeys(providerKeys);
      log("warn", "Key auto-disabled after 3x 401", { keyId, provider: provName });
      return;
    }
  }
}

// Cleanup stale buckets every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of projectIpRateBuckets) { if (now >= v.resetAt) projectIpRateBuckets.delete(k); }
  for (const [k, v] of tokenRateBuckets) { if (now >= v.resetAt) tokenRateBuckets.delete(k); }
  for (const [k, v] of projectCostBuckets) { if (now >= v.resetAt) projectCostBuckets.delete(k); }
  for (const [k, v] of keyCooldowns) { if (now > v.until) keyCooldowns.delete(k); }
}, 300000);

// Per-project anomaly detection — auto-suspend on request spike
const projectMinuteHistory = new Map(); // projectName -> [count_per_minute, ...]
function checkProjectAnomaly(proj) {
  if (!proj.anomalyAutoSuspend) return true;
  const now = Date.now();
  let hist = projectMinuteHistory.get(proj.name);
  if (!hist) { hist = { counts: [], currentMin: 0, minStart: now }; projectMinuteHistory.set(proj.name, hist); }
  if (now - hist.minStart >= 60000) {
    hist.counts.push(hist.currentMin);
    if (hist.counts.length > 10) hist.counts.shift(); // keep last 10 minutes
    hist.currentMin = 0;
    hist.minStart = now;
  }
  hist.currentMin++;
  // Suspend if current minute > 5x average of last 10 minutes (and at least 50 req)
  if (hist.counts.length >= 3) {
    const avg = hist.counts.reduce((a, b) => a + b, 0) / hist.counts.length;
    if (avg > 0 && hist.currentMin > Math.max(50, avg * 5)) {
      proj.enabled = false;
      proj.suspendedAt = new Date().toISOString();
      proj.suspendReason = "anomaly_auto_suspend";
      saveProjects(projects);
      rebuildProjectKeyIndex();
      log("warn", "Project auto-suspended (anomaly)", { project: proj.name, reqPerMin: hist.currentMin, avg: avg.toFixed(1) });
      sendAlert("project_suspended", { project: proj.name, reqPerMin: hist.currentMin, avgPerMin: +avg.toFixed(1) });
      return false;
    }
  }
  return true;
}

// Check IP against project allowlist
function checkProjectIP(proj, req) {
  if (!proj.allowedIPs?.length) return true; // no allowlist = allow all
  const ip = normalizeIP(req);
  return proj.allowedIPs.some(allowed => {
    if (allowed.includes('/')) {
      // CIDR match
      return cidrMatch(ip, allowed);
    }
    return ip === allowed;
  });
}
function cidrMatch(ip, cidr) {
  const [range, bits] = cidr.split('/');
  const mask = parseInt(bits, 10);
  if (isNaN(mask)) return ip === range;
  // Only IPv4 CIDR for now
  const ipNum = ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
  const rangeNum = range.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
  const maskNum = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;
  return (ipNum & maskNum) === (rangeNum & maskNum);
}

// HMAC signature verification for project requests
// Client sends: X-Signature, X-Timestamp, X-Nonce (key never sent over wire)
const HMAC_WINDOW_SEC = 300; // 5 min tolerance
const usedNonces = new Map(); // nonce -> expiry timestamp
// Cleanup expired nonces every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [n, exp] of usedNonces) { if (now > exp) usedNonces.delete(n); }
}, 300000);

function verifyHmacSignature(proj, req) {
  const sig = req.headers["x-signature"];
  const ts = req.headers["x-timestamp"];
  const nonce = req.headers["x-nonce"];
  if (!sig || !ts || !nonce) return { ok: false, error: "Missing signature headers (X-Signature, X-Timestamp, X-Nonce)" };
  // Timestamp check (prevent replay)
  const now = Math.floor(Date.now() / 1000);
  const reqTime = parseInt(ts, 10);
  if (isNaN(reqTime) || Math.abs(now - reqTime) > HMAC_WINDOW_SEC) {
    return { ok: false, error: "Request expired or clock skew too large" };
  }
  // Nonce check (prevent replay within window)
  if (usedNonces.has(nonce)) return { ok: false, error: "Duplicate nonce (replay detected)" };
  // Compute expected signature: HMAC-SHA256(projectKey, timestamp + nonce + body)
  const bodyStr = req._rawBody || JSON.stringify(req.body || {});
  const payload = ts + nonce + bodyStr;
  const expected = crypto.createHmac("sha256", proj.key).update(payload).digest("hex");
  if (!safeEqual(sig, expected)) return { ok: false, error: "Invalid signature" };
  // Only mark nonce used after successful verification
  usedNonces.set(nonce, Date.now() + HMAC_WINDOW_SEC * 1000);
  return { ok: true };
}

// Per-user ephemeral tokens
// Token format: { projectName, userId, expiresAt, token }
const EPHEMERAL_TTL_MS = 3600 * 1000; // 1h default, project can override
const MAX_EPHEMERAL_PER_PROJECT = 10000;
let ephemeralTokens = new Map(); // populated from disk after data layer init below

// Cleanup expired tokens every minute
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [t, info] of ephemeralTokens) { if (now > info.expiresAt) { ephemeralTokens.delete(t); changed = true; } }
  if (changed) markTokensDirty();
}, 60000);

// POST /v1/token — exchange project key (or HMAC) for short-lived token
// Body: { userId?: string }  Headers: X-Project-Key or HMAC headers
// Returns: { token, expiresAt, expiresIn }

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
  "api.minimax.io",
]);

// F-04: Allowed upstream paths per provider (prefix match)
const ALLOWED_UPSTREAM_PATHS = {
  openai:     ["/v1/chat/completions", "/v1/embeddings", "/v1/audio/", "/v1/images/", "/v1/models"],
  anthropic:  ["/v1/messages", "/v1/chat/completions"],
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
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const KEYS_FILE = path.join(DATA_DIR, "keys.json");
const TOKENS_FILE = path.join(DATA_DIR, "tokens.json");
const AUDIT_FILE = path.join(DATA_DIR, "audit.jsonl");
const STEALTH_CONF_FILE = path.join(DATA_DIR, "stealth.conf");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const COLLECTOR_TOKENS_FILE = path.join(DATA_DIR, "collector-tokens.json");

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
let projectKeyIndex = new Map();
function rebuildProjectKeyIndex() {
  projectKeyIndex = new Map();
  for (const p of projects) {
    if (p.key) projectKeyIndex.set(p.key, p);
  }
}
rebuildProjectKeyIndex();
let projectsDirty = false;
let projectsSaveTimer = null;
function markProjectsDirty() {
  projectsDirty = true;
  if (!projectsSaveTimer) {
    projectsSaveTimer = setTimeout(() => {
      projectsSaveTimer = null;
      if (projectsDirty) { saveProjects(projects); projectsDirty = false; }
    }, 1000);
  }
}

function loadUsers() {
  try {
    ensureDataDir();
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch (e) { console.error("Failed to load users:", e.message); }
  return [];
}

function saveUsers(list) {
  ensureDataDir();
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

let users = loadUsers();

// --- Settings ---
function loadSettings() {
  try {
    ensureDataDir();
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {}
  return {};
}
function saveSettings(s) {
  ensureDataDir();
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
}
let settings = loadSettings();
// Restore hot-switched mode from settings.json (survives restart)
if (settings.deployMode && settings.deployMode !== DEPLOY_MODE) {
  applyDeployMode(settings.deployMode, settings.customModules);
}

// Stealth conf: ensure file exists so nginx include doesn't fail on startup
function applyStealthConf(enabled) {
  try {
    ensureDataDir();
    fs.writeFileSync(STEALTH_CONF_FILE, enabled ? 'access_log off;\n' : '# stealth off\n');
  } catch (e) { log('warn', 'Failed to write stealth.conf', { err: e.message }); }
}
if (!fs.existsSync(STEALTH_CONF_FILE)) applyStealthConf(!!settings.stealthMode);

// --- Collector token management (multi-account, encrypted, PB backup) ---
// Structure: { deepseek: [{ id, label, credentials: "ENC:...", enabled }], ... }
function loadCollectorTokens() {
  try {
    ensureDataDir();
    if (fs.existsSync(COLLECTOR_TOKENS_FILE)) return JSON.parse(fs.readFileSync(COLLECTOR_TOKENS_FILE, "utf8"));
  } catch (e) { console.error("Failed to load collector tokens:", e.message); }
  return {};
}
function saveCollectorTokens(tokens) {
  ensureDataDir();
  const tmp = COLLECTOR_TOKENS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, COLLECTOR_TOKENS_FILE);
  // Non-blocking PB backup
  backupCollectorTokensToPB(tokens).catch(() => {});
}
let collectorTokens = loadCollectorTokens();

// Collector health state: { providerName: { status: 'ok'|'auth_expired'|'error'|'unknown', lastOk: ts, lastError: ts, error: string } }
const collectorHealth = {};
function setCollectorHealth(name, ok, errorMsg) {
  if (!collectorHealth[name]) collectorHealth[name] = { status: 'unknown', lastOk: 0, lastError: 0, error: '' };
  const h = collectorHealth[name];
  if (ok) { h.status = 'ok'; h.lastOk = Date.now(); h.error = ''; }
  else {
    h.lastError = Date.now();
    h.error = (errorMsg || '').slice(0, 200);
    // Detect auth-specific errors
    const msg = (errorMsg || '').toLowerCase();
    h.status = (msg.includes('401') || msg.includes('403') || msg.includes('expired') || msg.includes('login') || msg.includes('auth') || msg.includes('session') || msg.includes('cookie') || msg.includes('unauthorized'))
      ? 'auth_expired' : 'error';
  }
}

// Get the first enabled account's decrypted credentials for a provider
function getCollectorCredentials(providerName) {
  const accounts = collectorTokens[providerName];
  if (!Array.isArray(accounts)) {
    // Legacy format: single encrypted string → migrate
    if (typeof accounts === 'string') {
      return JSON.parse(decryptValue(accounts, ADMIN_SECRET));
    }
    return null;
  }
  const active = accounts.find(a => a.enabled);
  if (!active) return null;
  return JSON.parse(decryptValue(active.credentials, ADMIN_SECRET));
}

// Check if provider has any collector accounts
function hasCollectorToken(providerName) {
  const accounts = collectorTokens[providerName];
  if (!accounts) return false;
  if (typeof accounts === 'string') return true; // legacy
  return Array.isArray(accounts) && accounts.some(a => a.enabled);
}

// --- PB backup for collector tokens ---
async function backupCollectorTokensToPB(tokens) {
  try {
    const pbToken = await getPbAdminToken();
    if (!pbToken) return; // No PB auth = skip backup silently
    const authHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${pbToken}` };
    const payload = encryptValue(JSON.stringify(tokens), ADMIN_SECRET);
    const list = await lcPbFetch(`/api/collections/lc_collector_backup/records?perPage=1`, {
      headers: authHeaders,
    }).then(r => r.ok ? r.json() : null).catch(() => null);

    if (list && list.items && list.items.length > 0) {
      await lcPbFetch(`/api/collections/lc_collector_backup/records/${list.items[0].id}`, {
        method: "PATCH", headers: authHeaders,
        body: JSON.stringify({ data: payload, updated_at: new Date().toISOString() }),
      });
    } else {
      await lcPbFetch(`/api/collections/lc_collector_backup/records`, {
        method: "POST", headers: authHeaders,
        body: JSON.stringify({ data: payload }),
      });
    }
  } catch {
    // PB backup is best-effort, never block main flow
  }
}

async function restoreCollectorTokensFromPB() {
  const pbToken = await getPbAdminToken();
  const headers = pbToken ? { Authorization: `Bearer ${pbToken}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
  const list = await lcPbFetch(`/api/collections/lc_collector_backup/records?perPage=1`, {
    headers,
  }).then(r => r.json());
  if (!list?.items?.length) throw new Error("No collector backup found in PocketBase");
  const encrypted = list.items[0].data;
  const decrypted = decryptValue(encrypted, ADMIN_SECRET);
  const tokens = JSON.parse(decrypted);
  collectorTokens = tokens;
  saveCollectorTokens(tokens); // save locally (also re-backs-up, but idempotent)
  return { restored: Object.keys(tokens).length };
}

// Provider access mode: "api_key" (default) or "collector"
// Persisted in settings.providerAccessModes = { deepseek: "collector", ... }
function getProviderAccessMode(providerName) {
  return (settings.providerAccessModes || {})[providerName] || "api_key";
}
function setProviderAccessMode(providerName, mode) {
  if (!settings.providerAccessModes) settings.providerAccessModes = {};
  settings.providerAccessModes[providerName] = mode;
  saveSettings(settings);
}

// --- Audit logging (requires "audit" module) ---
// Append-only structured audit log: one JSON object per line
const AUDIT_MAX_SIZE = 10 * 1024 * 1024; // 10MB rotation threshold
function audit(actor, action, target, details) {
  if (!mod("audit")) return; // no-op when audit module disabled
  try {
    ensureDataDir();
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      actor: actor || "system",
      action,
      target: target || null,
      details: details || null,
    }) + "\n";
    // Rotate if file exceeds max size
    try {
      const stat = fs.statSync(AUDIT_FILE);
      if (stat.size > AUDIT_MAX_SIZE) {
        const rotated = AUDIT_FILE + "." + Date.now();
        fs.renameSync(AUDIT_FILE, rotated);
      }
    } catch {}
    fs.appendFileSync(AUDIT_FILE, entry);
  } catch (e) {
    console.error("Audit write failed:", e.message);
  }
}

// --- SLI metrics (M-02, enterprise only) ---
const sli = {
  startedAt: Date.now(),
  requests: { total: 0, success: 0, clientError: 0, serverError: 0, rateLimit: 0 },
  proxy: { total: 0, success: 0, upstreamError: 0, timeout: 0 },
  latency: { sum: 0, count: 0, max: 0 }, // in ms
};

// --- Backup/restore (H-02) ---
function createBackup() {
  ensureDataDir();
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(BACKUP_DIR, `backup-${ts}`);
  fs.mkdirSync(backupPath);
  const files = [PROJECTS_FILE, USAGE_FILE, RATE_FILE, USERS_FILE, SETTINGS_FILE, KEYS_FILE, COLLECTOR_TOKENS_FILE];
  let copied = 0;
  for (const f of files) {
    if (fs.existsSync(f)) {
      fs.copyFileSync(f, path.join(backupPath, path.basename(f)));
      copied++;
    }
  }
  // Prune old backups (keep last 10)
  const backups = fs.readdirSync(BACKUP_DIR).filter(d => d.startsWith("backup-")).sort();
  while (backups.length > 10) {
    const old = backups.shift();
    const oldPath = path.join(BACKUP_DIR, old);
    try { fs.rmSync(oldPath, { recursive: true }); } catch {}
  }
  return { path: `backup-${ts}`, files: copied };
}

function listBackups() {
  ensureDataDir();
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(d => d.startsWith("backup-"))
    .sort().reverse()
    .map(name => {
      const bp = path.join(BACKUP_DIR, name);
      const files = fs.readdirSync(bp);
      return { name, files: files.length, created: name.replace("backup-", "").replace(/-/g, (m, i) => i < 16 ? (i === 10 ? "T" : "-") : ".").slice(0, 19) };
    });
}

function restoreBackup(name) {
  const bp = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(bp) || !name.startsWith("backup-")) throw new Error("Backup not found");
  const files = fs.readdirSync(bp);
  let restored = 0;
  for (const f of files) {
    const dest = path.join(DATA_DIR, f);
    fs.copyFileSync(path.join(bp, f), dest);
    restored++;
  }
  return { restored };
}

// Auto-backup interval (requires "backup" module).
// Lite keeps backup capability with a looser default RPO to minimize background impact.
const AUTO_BACKUP_INTERVAL_MS = process.env.BACKUP_INTERVAL_MS
  ? Number(process.env.BACKUP_INTERVAL_MS)
  : (DEPLOY_MODE === "lite" ? 72 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000);
if (mod("backup")) {
  setInterval(() => {
    try { createBackup(); audit("system", "auto_backup", null, null); }
    catch (e) { console.error("Auto-backup failed:", e.message); }
  }, AUTO_BACKUP_INTERVAL_MS);
}

// --- Multi-key management ---
// keys: { provider: [{ id, label, key(encrypted), project: null|"name", enabled }] }
function loadKeys() {
  try {
    ensureDataDir();
    if (fs.existsSync(KEYS_FILE)) return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  } catch {}
  return {};
}
function saveKeys(k) {
  ensureDataDir();
  const tmp = KEYS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(k, null, 2));
  fs.renameSync(tmp, KEYS_FILE);
}
let providerKeys = loadKeys();

// --- Token persistence (Feature 3) ---
function loadTokens() {
  try {
    ensureDataDir();
    if (fs.existsSync(TOKENS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
      const now = Date.now();
      return Object.entries(raw).filter(([, v]) => v.expiresAt > now);
    }
  } catch (e) { console.error("Failed to load tokens:", e.message); }
  return [];
}
function saveTokens() {
  try {
    ensureDataDir();
    // Exclude privacyMode tokens (noLog: true) — they are in-memory only, never touch disk.
    const obj = Object.fromEntries([...ephemeralTokens].filter(([, v]) => !v.noLog));
    const tmp = TOKENS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, TOKENS_FILE);
  } catch (e) { console.error("Failed to save tokens:", e.message); }
}
let tokensDirty = false;
let tokensSaveTimer = null;
function markTokensDirty() {
  tokensDirty = true;
  if (!tokensSaveTimer) {
    tokensSaveTimer = setTimeout(() => {
      tokensSaveTimer = null;
      if (tokensDirty) { saveTokens(); tokensDirty = false; }
    }, 1000);
  }
}
// Initialize ephemeralTokens from disk (declared earlier as empty Map)
ephemeralTokens = new Map(loadTokens());

// Migrate .env single keys to keys.json on first load
function migrateEnvKeys() {
  let migrated = false;
  for (const [name, cfg] of Object.entries(PROVIDERS)) {
    if (cfg.apiKey && (!providerKeys[name] || providerKeys[name].length === 0)) {
      if (!providerKeys[name]) providerKeys[name] = [];
      providerKeys[name].push({
        id: crypto.randomBytes(8).toString('hex'),
        label: 'Default',
        key: encryptValue(cfg.apiKey, ADMIN_SECRET),
        project: null,
        enabled: true,
      });
      migrated = true;
    }
  }
  if (migrated) saveKeys(providerKeys);
}

// Get the best API key for a provider+project combo
// excludeKeyIds: Set of key IDs to skip (used for failover retry)
function selectApiKey(providerName, projectName, excludeKeyIds = new Set()) {
  const keys = (providerKeys[providerName] || [])
    .filter(k => k.enabled && !isKeyCooling(k.id) && !excludeKeyIds.has(k.id));
  // 1. Project-specific keys first (in order = priority)
  const projKeys = keys.filter(k => k.project === projectName);
  // 2. Public keys (project = null)
  const pubKeys = keys.filter(k => !k.project);
  const ordered = [...projKeys, ...pubKeys];
  if (!ordered.length) return null;
  // Decrypt first available key
  for (const entry of ordered) {
    try {
      return { apiKey: decryptValue(entry.key, ADMIN_SECRET), keyId: entry.id, label: entry.label };
    } catch { continue; }
  }
  return null;
}

// --- Budget helpers ---
function checkBudgetReset(proj) {
  if (!proj.budgetPeriod || !proj.budgetResetAt) return;
  if (new Date() >= new Date(proj.budgetResetAt)) {
    proj.budgetUsedUsd = 0;
    const now = new Date();
    if (proj.budgetPeriod === "monthly") {
      now.setMonth(now.getMonth() + 1);
      now.setDate(1);
      now.setHours(0, 0, 0, 0);
    } else if (proj.budgetPeriod === "daily") {
      now.setDate(now.getDate() + 1);
      now.setHours(0, 0, 0, 0);
    }
    proj.budgetResetAt = now.toISOString();
    markProjectsDirty();
  }
}

function calcRequestCost(providerName, modelId, tokens) {
  const info = getModelInfo(providerName, modelId);
  if (!info?.price) return 0;
  const uncachedInput = Math.max(0, (tokens.input || 0) - (tokens.cacheHit || 0));
  return (uncachedInput / 1e6) * info.price.in
    + ((tokens.cacheHit || 0) / 1e6) * info.price.cacheIn
    + ((tokens.output || 0) / 1e6) * info.price.out;
}

function initBudgetResetAt(period) {
  const now = new Date();
  if (period === "monthly") {
    now.setMonth(now.getMonth() + 1);
    now.setDate(1);
    now.setHours(0, 0, 0, 0);
  } else if (period === "daily") {
    now.setDate(now.getDate() + 1);
    now.setHours(0, 0, 0, 0);
  } else {
    return null;
  }
  return now.toISOString();
}

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
  if (pruned > 0) { markUsageDirty(); console.log(`Pruned ${pruned} days of old usage data`); }
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

let usageSaveTimer = null;
function markUsageDirty() {
  usageDirty = true;
  if (!usageSaveTimer) {
    usageSaveTimer = setTimeout(() => {
      usageSaveTimer = null;
      if (usageDirty) saveUsage();
    }, 1000);
  }
}

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
  markUsageDirty();
  usageCache.ts = 0; summaryCache.ts = 0; // invalidate cache on new data
}

function getModelInfo(provider, modelId) {
  return MODEL_INFO_MAP[provider]?.get(modelId) || null;
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
  if (providerName === "anthropic") {
    // Anthropic: message_start has input, message_delta has output
    let input = 0, cacheHit = 0, output = 0, found = false;
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const j = JSON.parse(line.slice(6).trim());
        if (j.type === "message_start" && j.message?.usage) {
          input = j.message.usage.input_tokens || 0;
          cacheHit = j.message.usage.cache_read_input_tokens || 0;
          found = true;
        }
        if (j.type === "message_delta" && j.usage) {
          output = j.usage.output_tokens || 0;
          found = true;
        }
      } catch {}
    }
    return found ? { input, cacheHit, output } : null;
  }
  // OpenAI-compatible: usage in final chunk (requires stream_options.include_usage)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    try {
      const j = JSON.parse(data);
      if (j.usage) return extractTokens(providerName, JSON.stringify(j));
    } catch {}
  }
  return null;
}

// --- Provider & model config ---
// M-01: Decrypt API keys if encrypted (ENC:...), passthrough plaintext for migration
function decryptEnvKey(envVar) {
  const val = process.env[envVar];
  if (!val) return undefined;
  try { return decryptValue(val, ADMIN_SECRET); } catch { return val; }
}

const KEY_URLS = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  kimi: "https://platform.moonshot.cn/console/api-keys",
  qwen: "https://dashscope.console.aliyun.com/apiKey",
  doubao: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
  gemini: "https://aistudio.google.com/apikey",
  minimax: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
};

const PROVIDERS = {
  openai: { baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com", apiKey: decryptEnvKey("OPENAI_API_KEY"), keyUrl: KEY_URLS.openai },
  anthropic: { baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com", apiKey: decryptEnvKey("ANTHROPIC_API_KEY"), keyUrl: KEY_URLS.anthropic },
  gemini: { baseUrl: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com", apiKey: decryptEnvKey("GEMINI_API_KEY"), keyUrl: KEY_URLS.gemini },
  deepseek: { baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com", apiKey: decryptEnvKey("DEEPSEEK_API_KEY"), keyUrl: KEY_URLS.deepseek },
  kimi: { baseUrl: process.env.KIMI_BASE_URL || "https://api.moonshot.cn", apiKey: decryptEnvKey("KIMI_API_KEY"), keyUrl: KEY_URLS.kimi },
  doubao: { baseUrl: process.env.DOUBAO_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3", apiKey: decryptEnvKey("DOUBAO_API_KEY"), keyUrl: KEY_URLS.doubao },
  qwen: { baseUrl: process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode", apiKey: decryptEnvKey("QWEN_API_KEY"), keyUrl: KEY_URLS.qwen },
  minimax: { baseUrl: process.env.MINIMAX_BASE_URL || "https://api.minimax.io", apiKey: decryptEnvKey("MINIMAX_API_KEY"), keyUrl: KEY_URLS.minimax },
};

// Migrate single .env keys to multi-key store
migrateEnvKeys();

const MODELS = {
  openai: [
    { id: "gpt-4.1-nano", tier: "economy", price: { in: 0.10, cacheIn: 0.025, out: 0.40 }, caps: ["text"], desc: "Classification, extraction, routing — lowest cost, 1M context" },
    { id: "gpt-4.1-mini", tier: "economy", price: { in: 0.40, cacheIn: 0.10, out: 1.60 }, caps: ["text", "image"], desc: "Summarization, simple code gen, 1M context, vision" },
    { id: "gpt-4o-mini-audio-preview", tier: "economy", price: { in: 0.15, cacheIn: 0.075, out: 0.60 }, caps: ["text", "audio"], desc: "Audio input/output preview — voice transcription, speech tasks (audio: $10/M in, $20/M out)" },
    { id: "o3-mini", tier: "economy", price: { in: 1.10, cacheIn: 0.55, out: 4.40 }, caps: ["text"], desc: "Code gen, math reasoning — best value reasoning model" },
    { id: "gpt-5-mini", tier: "standard", price: { in: 0.25, cacheIn: 0.025, out: 2.00 }, caps: ["text", "image"], desc: "GPT-5 lite — everyday coding, writing, analysis" },
    { id: "gpt-4.1", tier: "standard", price: { in: 2.00, cacheIn: 0.50, out: 8.00 }, caps: ["text", "image"], desc: "Instruction following, long docs, function calling, 1M context" },
    { id: "gpt-4o-audio-preview", tier: "standard", price: { in: 2.50, cacheIn: 1.25, out: 10.00 }, caps: ["text", "audio"], desc: "Audio input/output preview — high-accuracy voice understanding (audio: $100/M in, $200/M out)" },
    { id: "o4-mini", tier: "standard", price: { in: 1.10, cacheIn: 0.275, out: 4.40 }, caps: ["text", "image"], desc: "Multi-step tool orchestration, code execution, vision" },
    { id: "o3", tier: "flagship", price: { in: 2.00, cacheIn: 0.50, out: 8.00 }, caps: ["text", "image"], desc: "PhD-level science reasoning, competitive programming, 200K context" },
    { id: "gpt-5", tier: "flagship", price: { in: 0.625, cacheIn: 0.0625, out: 5.00 }, caps: ["text", "image", "audio", "video"], desc: "Native multimodal flagship — image/audio/video input" },
    { id: "gpt-5.4", tier: "flagship", price: { in: 2.50, cacheIn: 0.25, out: 15.00 }, caps: ["text", "image", "audio", "video"], desc: "Most capable GPT — all modalities, latest iteration" },
  ],
  anthropic: [
    { id: "claude-haiku-4-5", tier: "economy", price: { in: 1.00, cacheIn: 0.10, out: 5.00 }, caps: ["text", "image", "pdf"], desc: "Code completion, classification, summarization — sub-second, 200K" },
    { id: "claude-sonnet-4-5", tier: "standard", price: { in: 3.00, cacheIn: 0.30, out: 15.00 }, caps: ["text", "image", "pdf"], desc: "Extended thinking, complex coding, long-form writing" },
    { id: "claude-sonnet-4-6", tier: "flagship", price: { in: 3.00, cacheIn: 0.30, out: 15.00 }, caps: ["text", "image", "pdf"], desc: "Latest Sonnet — frontier intelligence, hybrid reasoning, 200K" },
    { id: "claude-opus-4-6", tier: "flagship", price: { in: 5.00, cacheIn: 0.50, out: 25.00 }, caps: ["text", "image", "pdf"], desc: "Autonomous coding, deep research, 200K analysis" },
  ],
  gemini: [
    { id: "gemini-2.5-flash-lite", tier: "economy", price: { in: 0.10, cacheIn: 0.01, out: 0.40 }, freeRPD: 1500, caps: ["text", "image", "audio"], desc: "High-throughput summarization/classification, audio input — 1500 free/day" },
    { id: "gemini-2.5-flash", tier: "standard", price: { in: 0.30, cacheIn: 0.03, out: 2.50 }, freeRPD: 500, caps: ["text", "image", "audio", "video", "pdf"], desc: "Code gen, math reasoning, 1M context — 500 free/day" },
    { id: "gemini-2.5-pro", tier: "flagship", price: { in: 1.25, cacheIn: 0.125, out: 10.00 }, freeRPD: 25, caps: ["text", "image", "audio", "video", "pdf"], desc: "Multimodal video analysis, 1M context — 25 free/day" },
    { id: "gemini-3.1-flash-lite-preview", tier: "economy", price: { in: 0.25, cacheIn: 0.025, out: 1.50 }, freeRPD: 1500, caps: ["text", "image", "audio", "video"], desc: "Gemini 3.1 — frontier-class at minimum cost, audio/video input — free tier available" },
    { id: "gemini-3-flash-preview", tier: "standard", price: { in: 0.50, cacheIn: 0.05, out: 3.00 }, freeRPD: 500, caps: ["text", "image", "audio", "video"], desc: "Gemini 3 — frontier-class performance vs larger models, audio/video input — free tier available" },
    { id: "gemini-3.1-pro-preview", tier: "flagship", price: { in: 2.00, cacheIn: 0.50, out: 12.00 }, freeRPD: 0, caps: ["text", "image", "video"], desc: "Gemini 3.1 — advanced reasoning, complex problem-solving, 1M context — paid only" },
  ],
  deepseek: [
    { id: "deepseek-chat", tier: "economy", price: { in: 0.28, cacheIn: 0.028, out: 0.42 }, caps: ["text"], desc: "V3.2 — chat, translation, summarization, bulk text, 128K" },
    { id: "deepseek-reasoner", tier: "standard", price: { in: 0.55, cacheIn: 0.14, out: 2.19 }, caps: ["text"], desc: "V3.2 thinking mode — math, competitive programming, CoT reasoning, 128K" },
  ],
  kimi: [
    { id: "moonshot-v1-8k", tier: "economy", price: { in: 0.20, cacheIn: 0.05, out: 2.00 }, caps: ["text"], desc: "Legacy fast chat, 8K context" },
    { id: "kimi-k2", tier: "standard", price: { in: 0.60, cacheIn: 0.15, out: 2.50 }, caps: ["text"], desc: "1T MoE — agentic reasoning, tool calling, 131K context" },
    { id: "kimi-k2-thinking", tier: "standard", price: { in: 0.60, cacheIn: 0.15, out: 2.50 }, caps: ["text"], desc: "K2 deep reasoning — extended thinking, chain-of-thought, 131K" },
    { id: "kimi-k2.5", tier: "flagship", price: { in: 0.60, cacheIn: 0.10, out: 3.00 }, caps: ["text", "image"], desc: "Latest flagship — native multimodal, agent swarm, 256K context" },
  ],
  doubao: [
    { id: "doubao-seed-2.0-mini", tier: "economy", price: { in: 0.028, cacheIn: 0.006, out: 0.28 }, caps: ["text", "image"], desc: "Low latency, 256K context, 4-level thinking" },
    { id: "doubao-seed-2.0-lite", tier: "standard", price: { in: 0.083, cacheIn: 0.017, out: 0.50 }, caps: ["text", "image"], desc: "General production, 256K context, surpasses Seed 1.8" },
    { id: "doubao-seed-2.0-pro", tier: "flagship", price: { in: 0.44, cacheIn: 0.089, out: 2.22 }, caps: ["text", "image"], desc: "Frontier reasoning, 256K context, video understanding" },
  ],
  qwen: [
    { id: "qwen-flash", tier: "economy", price: { in: 0.021, cacheIn: 0.004, out: 0.207 }, caps: ["text"], desc: "Fastest & cheapest Qwen — replaces qwen-turbo, 1M context" },
    { id: "qwen3.5-plus", tier: "standard", price: { in: 0.11, cacheIn: 0.022, out: 0.662 }, caps: ["text", "image"], desc: "Near-max quality, native multimodal (image+video), 1M context" },
    { id: "qwen3-max", tier: "flagship", price: { in: 0.345, cacheIn: 0.069, out: 1.379 }, caps: ["text"], desc: "Best reasoning — complex multi-step tasks, thinking mode, 262K" },
    { id: "qwen-long", tier: "standard", price: { in: 0.069, cacheIn: 0.014, out: 0.276 }, caps: ["text"], desc: "10M context window — book-length document analysis" },
  ],
  minimax: [
    { id: "MiniMax-M2", tier: "economy", price: { in: 0.29, cacheIn: 0.029, out: 1.16 }, caps: ["text"], desc: "Free on Coding Plan — coding, agentic workflows, 196K context" },
    { id: "MiniMax-M2.1", tier: "standard", price: { in: 0.29, cacheIn: 0.029, out: 1.16 }, caps: ["text"], desc: "Coding Plan paid tier — optimized for coding and agentic workflows, 196K" },
    { id: "MiniMax-M2.5", tier: "flagship", price: { in: 0.29, cacheIn: 0.029, out: 1.16 }, caps: ["text"], desc: "Coding Plan paid tier — SOTA coding (SWE-Bench 80.2%), agentic tool use, 200K context" },
    { id: "MiniMax-M1", tier: "flagship", price: { in: 1.00, cacheIn: 0.10, out: 4.00 }, caps: ["text"], desc: "General flagship — requires balance, not included in Coding Plan free tier" },
  ],
};

const MODEL_INFO_MAP = Object.fromEntries(
  Object.entries(MODELS).map(([provider, models]) => [
    provider,
    new Map(models.map((m) => [m.id, m])),
  ])
);

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

// 2b. Trace ID — attach per-request ID, expose in response header
app.use((req, res, next) => {
  req.traceId = req.headers["x-request-id"] || crypto.randomUUID();
  res.setHeader("X-Request-ID", req.traceId);
  next();
});

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

function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const loginLimiter = rateLimit({
  ...rateLimitOpts,
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 login attempts per 15 min
  message: { error: "Too many login attempts" },
});

// Stricter limiter for LumiChat auth endpoints (public-facing, no CF Access)
const LC_AUTH_LIMIT_WINDOW_MS = envPositiveInt("LC_AUTH_LIMIT_WINDOW_MS", 15 * 60 * 1000);
const LC_AUTH_LIMIT_MAX = envPositiveInt("LC_AUTH_LIMIT_MAX", process.env.NODE_ENV === "production" ? 60 : 600);
const lcAuthLimiter = rateLimit({
  ...rateLimitOpts,
  windowMs: LC_AUTH_LIMIT_WINDOW_MS,
  max: LC_AUTH_LIMIT_MAX, // configurable via env; higher default in non-production
  skipSuccessfulRequests: true, // don't punish normal successful logins/health checks
  message: { error: "Too many requests, please try again later" },
});
// Strict registration limiter: 3 per hour per IP + global 20 per hour
const LC_REGISTER_LIMIT_WINDOW_MS = envPositiveInt("LC_REGISTER_LIMIT_WINDOW_MS", 60 * 60 * 1000);
const LC_REGISTER_LIMIT_MAX = envPositiveInt("LC_REGISTER_LIMIT_MAX", 3);
const lcRegisterLimiter = rateLimit({
  ...rateLimitOpts,
  windowMs: LC_REGISTER_LIMIT_WINDOW_MS,
  max: LC_REGISTER_LIMIT_MAX, // keep strict by default, still env configurable
  message: { error: "Registration limit reached, try again later" },
});
let _globalRegCount = 0;
setInterval(() => { _globalRegCount = 0; }, 60 * 60 * 1000); // reset hourly

// 4. Body parser with size limit (F-09: reduced from 100mb)
app.use(express.json({
  limit: "10mb",
  verify: (req, res, buf) => { req._rawBody = buf.toString(); }, // preserve raw body for HMAC
}));

// 5. Request timeout
app.use((req, res, next) => {
  req.setTimeout(120000); // 2 min for AI responses
  next();
});

// 5b. Security middleware — PII/command detection + PB security_events logging
app.use(createSecurityMiddleware({
  pbUrl: process.env.PB_URL || "http://host.docker.internal:8090",
  enabled: true,
  ollamaEnabled: !!process.env.OLLAMA_URL,
  ollamaUrl: process.env.OLLAMA_URL || "http://host.docker.internal:11434",
  ollamaModel: process.env.OLLAMA_MODEL || "qwen2.5:1.5b",
}));

// 5c. Audit middleware — logs significant events to PB audit_log
app.use(createAuditMiddleware({
  pbUrl: process.env.PB_URL || "http://host.docker.internal:8090",
  enabled: mod("audit"),
}));

// 6. SLI metrics tracking (requires "metrics" module)
if (mod("metrics")) {
  app.use((req, res, next) => {
    const start = Date.now();
    sli.requests.total++;
    res.on("finish", () => {
      const ms = Date.now() - start;
      sli.latency.sum += ms;
      sli.latency.count++;
      if (ms > sli.latency.max) sli.latency.max = ms;
      if (res.statusCode >= 500) sli.requests.serverError++;
      else if (res.statusCode === 429) sli.requests.rateLimit++;
      else if (res.statusCode >= 400) sli.requests.clientError++;
      else sli.requests.success++;
    });
    next();
  });
}

// ============================================================
// Auth middleware
// ============================================================
function adminAuth(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.admin_token || req.headers["x-admin-token"];
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  // Raw ADMIN_SECRET = root (for CLI/TUI backward compat)
  if (safeEqual(token, ADMIN_SECRET)) {
    req.userRole = "root";
    req.userName = "_root";
    return next();
  }

  if (!sessions.has(token)) return res.status(401).json({ error: "Unauthorized" });
  const session = sessions.get(token);
  const maxAge = 24 * 60 * 60 * 1000;
  if (Date.now() - session.createdAt > maxAge) {
    sessions.delete(token);
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.userRole = session.role;
  req.userName = session.username;
  // Also store projects the user is linked to (for "user" role)
  if (session.role === "user") {
    const u = users.find(u => u.username === session.username);
    req.userProjects = u?.projects || [];
  }
  return next();
}

// Periodic session cleanup (every 5 min instead of per-request)
setInterval(() => {
  const maxAge = 24 * 60 * 60 * 1000;
  for (const [k, v] of sessions) {
    if (Date.now() - v.createdAt > maxAge) sessions.delete(k);
  }
}, 5 * 60 * 1000);

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.userRole)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

// ── LumiChat auth helpers ─────────────────────────────────────────────────────

// Note: JWT is decoded locally without HMAC signature verification (no PB signing key available).
// This is safe because all PB data operations forward the raw token — PB verifies the signature
// on every call and enforces row-level ownership. The local decode is only used to check expiry
// and gate the AI proxy fast-path. A forged token gains no data access; it can at most consume
// the gateway's shared API quota via the _lumichat rate-limit path.
function validateLcTokenPayload(token) {
  try {
    if (!token || token.split('.').length !== 3) return null;
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (!payload.id || !payload.collectionId) return null; // must be a PB user token
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function requireLcAuth(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.lc_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const payload = validateLcTokenPayload(token);
  if (!payload) return res.status(401).json({ error: 'Session expired' });
  req.lcUser = payload; // { id, email, collectionId, ... }
  req.lcToken = token;
  next();
}

async function verifyLcTokenWithPb(token, expectedUserId) {
  if (!token || !isValidPbId(expectedUserId)) {
    return { ok: false, status: 401, error: "Not authenticated" };
  }
  try {
    const r = await lcPbFetch(`/api/collections/users/records/${expectedUserId}?fields=id`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) return { ok: true };
    const data = await r.json().catch(() => ({}));
    return { ok: false, status: r.status === 403 ? 401 : r.status, error: pbErrorSummary(data, "Session invalid") };
  } catch {
    return { ok: false, status: 503, error: "PocketBase unavailable" };
  }
}

const lcUpload = multer({
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max for video
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => cb(null, `lc-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  }),
});

// ── End LumiChat auth helpers ─────────────────────────────────────────────────

// Check if request has valid admin session — returns role string or false
function getSessionRole(req) {
  const cookies = parseCookies(req);
  const token = cookies.admin_token;
  if (!token) return false;
  if (safeEqual(token, ADMIN_SECRET)) return "root";
  if (!sessions.has(token)) return false;
  const session = sessions.get(token);
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) return false;
  return session.role;
}

function hasAdminSession(req) {
  return !!getSessionRole(req);
}

// ============================================================
// Public routes (no auth)
// ============================================================

// Health check — used by Docker healthcheck
// Check admin auth without requiring it — used by endpoints that return more detail to admins.
// Mirrors adminAuth: checks cookie admin_token and x-admin-token header, including raw ADMIN_SECRET.
function isAdminRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies.admin_token || req.headers["x-admin-token"];
  if (!token) return false;
  if (safeEqual(token, ADMIN_SECRET)) return true;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) return false;
  return true;
}

// Public: { status, uptime } only — enough for monitoring/watchdog.
// Authenticated admin: additionally includes mode, modules, providers (dashboard needs these).
app.get("/health", (req, res) => {
  const base = { status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000) };
  if (!isAdminRequest(req)) return res.json(base);
  const available = Object.entries(PROVIDERS)
    .filter(([name]) => (providerKeys[name] || []).some(k => k.enabled))
    .map(([name]) => name);
  res.json({ ...base, mode: DEPLOY_MODE, modules: [...modules], providers: available, platform: { parse: true, audio: true, vision: true, code: true } });
});

// Public: { name, baseUrl, available } — minimum needed by dashboard UI per CLAUDE.md.
// Authenticated admin: additionally includes keyCount, enabledCount.
app.get("/providers", (req, res) => {
  const admin = isAdminRequest(req);
  res.json(Object.entries(PROVIDERS).map(([name, cfg]) => {
    const allKeys = providerKeys[name] || [];
    const enabledKeys = allKeys.filter(k => k.enabled);
    const mode = getProviderAccessMode(name);
    const isCollector = mode === "collector" && hasCollectorToken(name);
    const entry = { name, baseUrl: cfg.baseUrl, available: enabledKeys.length > 0 || isCollector, accessMode: mode };
    // Collector health signal: clients use this to show auth status
    if (mode === "collector" && collectorHealth[name]) {
      entry.collectorStatus = collectorHealth[name].status; // 'ok' | 'auth_expired' | 'error' | 'unknown'
    }
    if (admin) { entry.keyCount = allKeys.length; entry.enabledCount = enabledKeys.length; }
    return entry;
  }));
});

app.get("/models/:provider", (req, res) => {
  const name = req.params.provider.toLowerCase();
  res.json(MODELS[name] || []);
});

// Collector health signal — lightweight, no admin auth, for any client app
// Returns: { providers: { doubao: { status, lastOk, lastError }, ... } }
app.get("/collector/health", (req, res) => {
  const result = {};
  for (const [name] of Object.entries(PROVIDERS)) {
    if (getProviderAccessMode(name) !== "collector") continue;
    const h = collectorHealth[name];
    result[name] = h
      ? { status: h.status, lastOk: h.lastOk || null, lastError: h.lastError || null, error: h.error || null }
      : { status: hasCollectorToken(name) ? 'unknown' : 'no_credentials', lastOk: null, lastError: null, error: null };
  }
  res.json({ providers: result });
});

// Cache HTML templates at startup (nonce injected per-request)
const _dashboardHtml = fs.existsSync(path.join(__dirname, "public", "index.html"))
  ? fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8") : null;
const _lumichatHtml = fs.existsSync(path.join(__dirname, "public", "lumichat.html"))
  ? fs.readFileSync(path.join(__dirname, "public", "lumichat.html"), "utf8") : null;

// Static files (CSS/JS/images only, HTML served dynamically below)
app.use("/logos", express.static(path.join(__dirname, "public", "logos")));
app.use("/favicon.svg", express.static(path.join(__dirname, "public", "favicon.svg")));
app.use("/lumichat-icon.svg", express.static(path.join(__dirname, "public", "lumichat-icon.svg")));
app.use("/lumichat-libs", express.static(path.join(__dirname, "public", "lumichat-libs")));

// Landing page
app.get("/", (req, res) => {
  const htmlPath = path.join(__dirname, "public", "landing.html");
  if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
  // Fallback: redirect to dashboard if landing page not yet created
  res.redirect("/v1/sys/panel");
});

// Serve dashboard (nonce-CSP injected; 'unsafe-inline' kept as fallback for inline event handlers)
// Rewrite /v1/sys/admin/* → /admin/* so downstream routes handle it directly
// (CF Access bypasses /v1/ but blocks /admin/, so Dashboard uses /v1/sys/admin/ prefix)
app.use((req, res, next) => {
  if (req.url.startsWith("/v1/sys/admin")) {
    req.url = req.url.replace("/v1/sys/admin", "/admin");
    req.originalUrl = req.originalUrl.replace("/v1/sys/admin", "/admin");
  }
  next();
});

app.get("/v1/sys/panel", (req, res) => {
  if (!_dashboardHtml) return res.status(503).send("Dashboard not available");
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader("Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'`
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  const html = _dashboardHtml.replace(/\{\{NONCE\}\}/g, nonce);
  res.send(html);
});

// Old dashboard path — return 404
// /dashboard — no response, don't reveal it exists
app.get("/dashboard", (req, res) => res.status(204).end());

// F-02: Serve chat — requires root/admin session (no key exposed to browser)
app.get("/chat", (req, res) => {
  if (!mod("chat")) return res.redirect("/v1/sys/panel");
  const role = getSessionRole(req);
  if (!role || role === "user") return res.redirect("/v1/sys/panel");
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

// Serve LumiChat interface (nonce injected into HTML for CSP)
app.get("/lumichat", (req, res) => {
  if (!_lumichatHtml) {
    return res.status(503).send("LumiChat not yet deployed");
  }
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader("Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'`
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  // Inject nonce into all <script nonce="{{NONCE}}"> and <style nonce="{{NONCE}}"> placeholders
  const html = _lumichatHtml.replace(/\{\{NONCE\}\}/g, nonce);
  res.send(html);
});

// ============================================================
// Admin auth: login/logout
// ============================================================
app.post("/admin/login", loginLimiter, async (req, res) => {
  const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https" || (req.headers["cf-visitor"] || "").includes("https");
  // Flow 1: ADMIN_SECRET (root)
  if (req.body.secret) {
    if (safeEqual(req.body.secret, ADMIN_SECRET)) {
      // MFA check for root
      if (settings.rootMfaEnabled && settings.rootTotpSecret) {
        const mfaToken = 'mfa_' + crypto.randomBytes(16).toString('hex');
        mfaTokens.set(mfaToken, { username: '_root', role: 'root', expiresAt: Date.now() + 5 * 60 * 1000 });
        return res.json({ success: false, mfaRequired: true, mfaToken });
      }
      const sessionToken = crypto.randomBytes(32).toString('hex');
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      sessions.set(sessionToken, { createdAt: Date.now(), role: "root", username: "_root" });
      res.cookie("admin_token", sessionToken, { httpOnly: true, sameSite: "Strict", secure: isSecure, path: "/", maxAge: 86400000 });
      audit("_root", "login", null, { method: "secret" });
      return res.json({ success: true, role: "root" });
    }
    audit(null, "login_failed", null, { method: "secret", ip: normalizeIP(req) });
    return res.status(401).json({ error: "Invalid admin secret" });
  }
  // Flow 2: username/password
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Credentials required" });
  const user = users.find(u => u.username === username && u.enabled);
  if (!user || !await verifyPassword(password, user.passwordHash, user.salt)) {
    audit(username || null, "login_failed", null, { method: "password", ip: normalizeIP(req) });
    return res.status(401).json({ error: "Invalid credentials" });
  }
  // MFA check for user
  if (user.mfaEnabled && user.totpSecret) {
    const mfaToken = 'mfa_' + crypto.randomBytes(16).toString('hex');
    mfaTokens.set(mfaToken, { username: user.username, role: user.role, expiresAt: Date.now() + 5 * 60 * 1000 });
    return res.json({ success: false, mfaRequired: true, mfaToken });
  }
  const sessionToken = crypto.randomBytes(32).toString('hex');
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  sessions.set(sessionToken, { createdAt: Date.now(), role: user.role, username: user.username });
  res.cookie("admin_token", sessionToken, { httpOnly: true, sameSite: "Strict", secure: isSecure, path: "/", maxAge: 86400000 });
  audit(user.username, "login", null, { method: "password", role: user.role });
  res.json({ success: true, role: user.role });
});

// MFA step-2: verify TOTP code (public — part of login flow)
app.post("/admin/mfa/verify", loginLimiter, (req, res) => {
  const { mfaToken, code } = req.body;
  if (!mfaToken || !code) return res.status(400).json({ error: "mfaToken and code required" });
  const entry = mfaTokens.get(mfaToken);
  if (!entry || entry.expiresAt < Date.now()) {
    mfaTokens.delete(mfaToken);
    return res.status(401).json({ error: "MFA session expired, please login again" });
  }
  let totpSecret;
  if (entry.username === '_root') {
    totpSecret = settings.rootTotpSecret;
  } else {
    const user = users.find(u => u.username === entry.username);
    totpSecret = user?.totpSecret;
  }
  if (!totpSecret || !verifyTotp(totpSecret, code)) {
    audit(entry.username, "mfa_failed", null, { ip: normalizeIP(req) });
    return res.status(401).json({ error: "Invalid authentication code" });
  }
  mfaTokens.delete(mfaToken);
  const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https" || (req.headers["cf-visitor"] || "").includes("https");
  const sessionToken = crypto.randomBytes(32).toString('hex');
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  sessions.set(sessionToken, { createdAt: Date.now(), role: entry.role, username: entry.username });
  res.cookie("admin_token", sessionToken, { httpOnly: true, sameSite: "Strict", secure: isSecure, path: "/", maxAge: 86400000 });
  audit(entry.username, "login", null, { method: "mfa" });
  res.json({ success: true, role: entry.role });
});

app.post("/admin/logout", (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.admin_token;
  if (token) sessions.delete(token);
  const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https" || (req.headers["cf-visitor"] || "").includes("https");
  res.clearCookie("admin_token", { httpOnly: true, sameSite: "Strict", secure: isSecure, path: "/" });
  res.json({ success: true });
});

// Check auth status
app.get("/admin/auth", adminLimiter, (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.admin_token || req.headers["x-admin-token"];
  if (!token) return res.json({ authenticated: false });

  // Raw admin secret
  if (safeEqual(token, ADMIN_SECRET)) {
    return res.json({ authenticated: true, role: "root", username: "_root" });
  }

  if (!sessions.has(token)) return res.json({ authenticated: false });
  const session = sessions.get(token);
  const maxAge = 24 * 60 * 60 * 1000;
  if (Date.now() - session.createdAt > maxAge) {
    sessions.delete(token);
    return res.json({ authenticated: false });
  }
  const resp = { authenticated: true, role: session.role, username: session.username };
  if (session.role === "user") {
    const u = users.find(u => u.username === session.username);
    resp.projects = u?.projects || [];
  }
  res.json(resp);
});

// ============================================================
// Admin routes (all require auth)
// ============================================================
app.use("/admin", adminLimiter, adminAuth);

// --- MFA Management (authenticated) ---
// Generate a new TOTP secret (pendingTotpSecret, not active until confirmed)
app.post("/admin/mfa/setup", (req, res) => {
  const secret = generateTotpSecret();
  const label = req.userName === '_root' ? 'LumiGate Root' : req.userName;
  const uri = totpUri(secret, label);
  // Store pending secret in-memory (not saved until confirmed)
  if (req.userName === '_root') {
    settings._pendingRootTotp = secret;
  } else {
    const user = users.find(u => u.username === req.userName);
    if (!user) return res.status(404).json({ error: "User not found" });
    user._pendingTotp = secret;
  }
  res.json({ secret, otpauthUrl: uri });
});

// Confirm MFA setup by verifying first code — activates MFA
app.post("/admin/mfa/confirm", (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code required" });
  if (req.userName === '_root') {
    const secret = settings._pendingRootTotp;
    if (!secret) return res.status(400).json({ error: "No pending MFA setup. Call /admin/mfa/setup first." });
    if (!verifyTotp(secret, code)) return res.status(401).json({ error: "Invalid code" });
    settings.rootTotpSecret = secret;
    settings.rootMfaEnabled = true;
    delete settings._pendingRootTotp;
    saveSettings(settings);
    audit('_root', 'mfa_enabled', null, {});
    return res.json({ success: true });
  }
  const user = users.find(u => u.username === req.userName);
  if (!user) return res.status(404).json({ error: "User not found" });
  const secret = user._pendingTotp;
  if (!secret) return res.status(400).json({ error: "No pending MFA setup. Call /admin/mfa/setup first." });
  if (!verifyTotp(secret, code)) return res.status(401).json({ error: "Invalid code" });
  user.totpSecret = secret;
  user.mfaEnabled = true;
  delete user._pendingTotp;
  saveUsers(users);
  audit(req.userName, 'mfa_enabled', null, {});
  res.json({ success: true });
});

// Disable MFA (requires current TOTP code to prevent lock-out attacks)
app.delete("/admin/mfa", (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Current TOTP code required to disable MFA" });
  if (req.userName === '_root') {
    if (!settings.rootMfaEnabled || !settings.rootTotpSecret) return res.status(400).json({ error: "MFA is not enabled" });
    if (!verifyTotp(settings.rootTotpSecret, code)) return res.status(401).json({ error: "Invalid code" });
    settings.rootMfaEnabled = false;
    delete settings.rootTotpSecret;
    saveSettings(settings);
    audit('_root', 'mfa_disabled', null, {});
    return res.json({ success: true });
  }
  const user = users.find(u => u.username === req.userName);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (!user.mfaEnabled || !user.totpSecret) return res.status(400).json({ error: "MFA is not enabled" });
  if (!verifyTotp(user.totpSecret, code)) return res.status(401).json({ error: "Invalid code" });
  user.mfaEnabled = false;
  delete user.totpSecret;
  saveUsers(users);
  audit(req.userName, 'mfa_disabled', null, {});
  res.json({ success: true });
});

// Generate QR code image for MFA setup (server-side, no CDN needed)
app.get("/admin/mfa/qr", async (req, res) => {
  const { uri } = req.query;
  if (!uri || !uri.startsWith('otpauth://')) return res.status(400).json({ error: 'Invalid URI' });
  try {
    const QRCode = require('qrcode');
    const dataUrl = await QRCode.toDataURL(uri, { width: 180, margin: 2, color: { dark: '#1c1c1e', light: '#f5f5f7' } });
    res.json({ dataUrl });
  } catch (e) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// Get MFA status for current user
app.get("/admin/mfa/status", (req, res) => {
  if (req.userName === '_root') {
    return res.json({ mfaEnabled: !!settings.rootMfaEnabled });
  }
  const user = users.find(u => u.username === req.userName);
  res.json({ mfaEnabled: !!(user?.mfaEnabled) });
});

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
app.get("/admin/test/:provider", requireRole("root", "admin"), async (req, res) => {
  const name = req.params.provider.toLowerCase();
  const provider = PROVIDERS[name];
  const testKey = selectApiKey(name, null)?.apiKey || provider?.apiKey;
  if (!provider || !testKey) {
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
      Object.assign(headers, anthropicAuthHeaders(testKey));
      url = `${provider.baseUrl}/v1/messages`;
    } else if (name === "gemini") {
      headers["Authorization"] = `Bearer ${testKey}`;
      url = `${provider.baseUrl}/v1beta/openai/chat/completions`;
    } else {
      headers["Authorization"] = `Bearer ${testKey}`;
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
  if (req.userRole === "user") {
    return res.json(projects
      .filter(p => (req.userProjects || []).includes(p.name))
      .map(({ key, ...rest }) => rest));
  }
  res.json(projects);
});

app.post("/admin/projects", requireRole("root", "admin"), (req, res) => {
  const { name, maxBudgetUsd, budgetPeriod, allowedModels, maxRpm, allowedIPs, anomalyAutoSuspend } = req.body;
  if (!validateProjectName(name)) {
    return res.json({ success: false, error: "Invalid project name (max 64 chars, no special chars)" });
  }
  if (projects.find((p) => p.name === name)) {
    return res.json({ success: false, error: "project already exists" });
  }
  const key = "pk_" + crypto.randomBytes(24).toString("hex");
  const project = { name, key, enabled: true, authMode: "hmac", maxRpm: 600, maxRpmPerIp: 30, maxRpmPerToken: 30, maxCostPerMin: 0.5, anomalyAutoSuspend: true, createdAt: new Date().toISOString() };
  // Phase 1a: Budget enforcement
  if (maxBudgetUsd != null && maxBudgetUsd > 0) {
    project.maxBudgetUsd = Number(maxBudgetUsd);
    project.budgetUsedUsd = 0;
    project.budgetPeriod = ["monthly", "daily"].includes(budgetPeriod) ? budgetPeriod : null;
    project.budgetResetAt = initBudgetResetAt(project.budgetPeriod);
  }
  // Phase 1b: Model allowlist
  if (Array.isArray(allowedModels) && allowedModels.length > 0) {
    project.allowedModels = allowedModels.filter(m => typeof m === "string" && m.length > 0);
  }
  // Per-project rate limit
  if (maxRpm != null && maxRpm > 0) project.maxRpm = Math.min(Number(maxRpm), 10000);
  if (req.body.maxRpmPerIp != null && req.body.maxRpmPerIp > 0) project.maxRpmPerIp = Math.min(Number(req.body.maxRpmPerIp), 1000);
  if (req.body.maxRpmPerToken != null && req.body.maxRpmPerToken > 0) project.maxRpmPerToken = Math.min(Number(req.body.maxRpmPerToken), 1000);
  if (req.body.maxCostPerMin != null && req.body.maxCostPerMin > 0) project.maxCostPerMin = Number(req.body.maxCostPerMin);
  // IP allowlist
  if (Array.isArray(allowedIPs) && allowedIPs.length > 0) {
    project.allowedIPs = allowedIPs.filter(ip => typeof ip === "string" && ip.length > 0).slice(0, 50);
  }
  // Anomaly auto-suspend
  if (anomalyAutoSuspend) project.anomalyAutoSuspend = true;
  // Auth mode: key (default), hmac, token
  if (req.body.authMode && ["key", "hmac", "token"].includes(req.body.authMode)) {
    project.authMode = req.body.authMode;
  }
  if (req.body.tokenTtlMinutes > 0) project.tokenTtlMinutes = Math.min(Number(req.body.tokenTtlMinutes), 1440);
  // Smart routing
  if (req.body.smartRouting) {
    project.smartRouting = validateSmartRouting(req.body.smartRouting);
  }
  projects.push(project);
  saveProjects(projects);
  rebuildProjectKeyIndex();
  audit(req.userName, "project_create", name, { budget: project.maxBudgetUsd || null });
  res.json({ success: true, project });
});

app.put("/admin/projects/:name", requireRole("root", "admin"), (req, res) => {
  const proj = projects.find((p) => p.name === req.params.name);
  if (!proj) return res.json({ success: false, error: "project not found" });
  if (req.body.enabled !== undefined) proj.enabled = req.body.enabled;
  if (req.body.newName) {
    if (!validateProjectName(req.body.newName)) {
      return res.json({ success: false, error: "Invalid project name" });
    }
    const newName = req.body.newName;
    if (newName !== proj.name && projects.some(p => p.name === newName)) {
      return res.json({ success: false, error: "Project name already exists" });
    }
    if (newName !== proj.name) {
      const oldName = proj.name;
      proj.name = newName;
      // Cascade: update user project bindings
      for (const u of users) {
        if (Array.isArray(u.projects)) {
          u.projects = u.projects.map(n => n === oldName ? newName : n);
        }
      }
      saveUsers(users);
      // Cascade: update ephemeral tokens
      for (const info of ephemeralTokens.values()) {
        if (info.projectName === oldName) {
          info.projectName = newName;
          info.project = proj; // same object reference, already renamed
        }
      }
      // Cascade: update provider keys linked to this project
      let keysDirty = false;
      for (const k of Object.values(providerKeys).flat()) {
        if (k.project === oldName) { k.project = newName; keysDirty = true; }
      }
      if (keysDirty) saveKeys(providerKeys);
      // Cascade: rename in-memory rate buckets and anomaly history
      const oldBucket = projectRateBuckets.get(oldName);
      if (oldBucket) { projectRateBuckets.delete(oldName); projectRateBuckets.set(newName, oldBucket); }
      const oldIssueBucket = projectTokenIssueBuckets.get(oldName);
      if (oldIssueBucket) { projectTokenIssueBuckets.delete(oldName); projectTokenIssueBuckets.set(newName, oldIssueBucket); }
      for (const [k, v] of projectIpRateBuckets) {
        if (k.startsWith(oldName + ":")) {
          projectIpRateBuckets.delete(k);
          projectIpRateBuckets.set(newName + k.slice(oldName.length), v);
        }
      }
      const oldHistory = projectMinuteHistory.get(oldName);
      if (oldHistory) { projectMinuteHistory.delete(oldName); projectMinuteHistory.set(newName, oldHistory); }
    }
  }
  // Phase 1a: Budget update
  if (req.body.maxBudgetUsd !== undefined) {
    if (req.body.maxBudgetUsd === null || req.body.maxBudgetUsd === 0) {
      delete proj.maxBudgetUsd;
      delete proj.budgetUsedUsd;
      delete proj.budgetPeriod;
      delete proj.budgetResetAt;
    } else {
      proj.maxBudgetUsd = Number(req.body.maxBudgetUsd);
      if (proj.budgetUsedUsd == null) proj.budgetUsedUsd = 0;
    }
  }
  if (req.body.budgetPeriod !== undefined) {
    proj.budgetPeriod = ["monthly", "daily"].includes(req.body.budgetPeriod) ? req.body.budgetPeriod : null;
    proj.budgetResetAt = initBudgetResetAt(proj.budgetPeriod);
  }
  if (req.body.resetBudget === true) {
    proj.budgetUsedUsd = 0;
  }
  // Phase 1b: Model allowlist update
  if (req.body.allowedModels !== undefined) {
    if (req.body.allowedModels === null || (Array.isArray(req.body.allowedModels) && req.body.allowedModels.length === 0)) {
      delete proj.allowedModels;
    } else if (Array.isArray(req.body.allowedModels)) {
      proj.allowedModels = req.body.allowedModels.filter(m => typeof m === "string" && m.length > 0);
    }
  }
  // Per-project rate limit
  if (req.body.maxRpm !== undefined) {
    if (req.body.maxRpm === null || req.body.maxRpm === 0) delete proj.maxRpm;
    else proj.maxRpm = Math.min(Number(req.body.maxRpm), 10000);
  }
  if (req.body.maxRpmPerIp !== undefined) {
    if (req.body.maxRpmPerIp === null || req.body.maxRpmPerIp === 0) delete proj.maxRpmPerIp;
    else proj.maxRpmPerIp = Math.min(Number(req.body.maxRpmPerIp), 1000);
  }
  if (req.body.maxRpmPerToken !== undefined) {
    if (req.body.maxRpmPerToken === null || req.body.maxRpmPerToken === 0) delete proj.maxRpmPerToken;
    else proj.maxRpmPerToken = Math.min(Number(req.body.maxRpmPerToken), 1000);
  }
  if (req.body.maxCostPerMin !== undefined) {
    if (req.body.maxCostPerMin === null || req.body.maxCostPerMin === 0) delete proj.maxCostPerMin;
    else proj.maxCostPerMin = Number(req.body.maxCostPerMin);
  }
  // IP allowlist
  if (req.body.allowedIPs !== undefined) {
    if (req.body.allowedIPs === null || (Array.isArray(req.body.allowedIPs) && req.body.allowedIPs.length === 0)) {
      delete proj.allowedIPs;
    } else if (Array.isArray(req.body.allowedIPs)) {
      proj.allowedIPs = req.body.allowedIPs.filter(ip => typeof ip === "string" && ip.length > 0).slice(0, 50);
    }
  }
  // Coding Plan spending
  if (req.body.subscriptionCountsSpending !== undefined) {
    if (req.body.subscriptionCountsSpending) proj.subscriptionCountsSpending = true;
    else delete proj.subscriptionCountsSpending;
  }
  // Anomaly auto-suspend
  if (req.body.anomalyAutoSuspend !== undefined) {
    if (req.body.anomalyAutoSuspend) proj.anomalyAutoSuspend = true;
    else delete proj.anomalyAutoSuspend;
  }
  // Auth mode
  if (req.body.authMode !== undefined) {
    if (["key", "hmac", "token"].includes(req.body.authMode)) proj.authMode = req.body.authMode;
    else delete proj.authMode;
  }
  if (req.body.tokenTtlMinutes !== undefined) {
    if (req.body.tokenTtlMinutes > 0) proj.tokenTtlMinutes = Math.min(Number(req.body.tokenTtlMinutes), 1440);
    else delete proj.tokenTtlMinutes;
  }
  // Token issuance rate limit (per-project override)
  if (req.body.tokenIssuanceRpm !== undefined) {
    if (req.body.tokenIssuanceRpm > 0) proj.tokenIssuanceRpm = Math.min(Number(req.body.tokenIssuanceRpm), 10000);
    else delete proj.tokenIssuanceRpm;
  }
  // Privacy mode — skip usage logging and token persistence for this project
  if (req.body.privacyMode !== undefined) {
    if (req.body.privacyMode) proj.privacyMode = true;
    else delete proj.privacyMode;
  }
  // Clear suspend state if re-enabling
  if (req.body.enabled === true && proj.suspendReason) {
    delete proj.suspendReason;
    delete proj.suspendedAt;
    projectMinuteHistory.delete(proj.name); // reset anomaly baseline
  }
  // Smart routing update
  if (req.body.smartRouting !== undefined) {
    if (req.body.smartRouting === null || req.body.smartRouting === false) {
      delete proj.smartRouting;
    } else {
      proj.smartRouting = validateSmartRouting(req.body.smartRouting);
    }
  }
  saveProjects(projects);
  rebuildProjectKeyIndex();
  audit(req.userName, "project_update", req.params.name, { fields: Object.keys(req.body) });
  res.json({ success: true, project: proj });
});

app.post("/admin/projects/:name/regenerate", requireRole("root", "admin"), (req, res) => {
  const proj = projects.find((p) => p.name === req.params.name);
  if (!proj) return res.json({ success: false, error: "project not found" });
  proj.key = "pk_" + crypto.randomBytes(24).toString("hex");
  saveProjects(projects);
  rebuildProjectKeyIndex();
  audit(req.userName, "project_regenerate_key", req.params.name);
  res.json({ success: true, project: proj });
});

app.delete("/admin/projects/:name", requireRole("root", "admin"), (req, res) => {
  const idx = projects.findIndex((p) => p.name === req.params.name);
  if (idx === -1) return res.json({ success: false, error: "project not found" });
  projects.splice(idx, 1);
  saveProjects(projects);
  rebuildProjectKeyIndex();
  audit(req.userName, "project_delete", req.params.name);
  res.json({ success: true });
});

// Exchange rate
app.get("/admin/rate", (req, res) => {
  res.json(exchangeRate);
});

// --- Usage API ---
// Build daily count aggregations in a single pass (shared by both endpoints)
function buildDailyCounts(days, perProject) {
  const now = new Date();
  const dailyCounts = {};       // global: { dateKey: { modelKey: count } }
  const projectDailyCounts = {}; // per-project: { dateKey: { project: { modelKey: count } } }
  for (let i = 0; i < days; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    const dayData = usageData[dateKey];
    if (!dayData) continue;
    for (const [proj, models] of Object.entries(dayData)) {
      for (const [modelKey, stats] of Object.entries(models)) {
        if (perProject) {
          if (!projectDailyCounts[dateKey]) projectDailyCounts[dateKey] = {};
          if (!projectDailyCounts[dateKey][proj]) projectDailyCounts[dateKey][proj] = {};
          projectDailyCounts[dateKey][proj][modelKey] = (projectDailyCounts[dateKey][proj][modelKey] || 0) + stats.count;
        } else {
          if (!dailyCounts[dateKey]) dailyCounts[dateKey] = {};
          dailyCounts[dateKey][modelKey] = (dailyCounts[dateKey][modelKey] || 0) + stats.count;
        }
      }
    }
  }
  return { dailyCounts, projectDailyCounts };
}

// Short TTL cache for usage responses (avoids recomputation on rapid dashboard refreshes)
let usageCache = { key: null, data: null, ts: 0 };
let summaryCache = { key: null, data: null, ts: 0 };
const USAGE_CACHE_TTL = 5000; // 5 seconds

app.get("/admin/usage", (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
  const filterProject = req.query.project || "";
  const userProjects = req.userRole === "user" ? new Set(req.userProjects || []) : null;
  const cacheKey = `${days}:${filterProject}:${req.userRole}:${[...(userProjects || [])].join(",")}`;
  const now = Date.now();
  if (usageCache.key === cacheKey && now - usageCache.ts < USAGE_CACHE_TTL) {
    return res.json(usageCache.data);
  }

  const perProject = settings.freeTierMode === "per-project";
  const { dailyCounts, projectDailyCounts } = buildDailyCounts(days, perProject);
  const result = [];
  const nowDate = new Date();

  for (let i = 0; i < days; i++) {
    const d = new Date(nowDate); d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    const dayData = usageData[dateKey];
    if (!dayData) continue;
    for (const [project, models] of Object.entries(dayData)) {
      if (filterProject && project !== filterProject) continue;
      if (userProjects && !userProjects.has(project)) continue;
      for (const [modelKey, stats] of Object.entries(models)) {
        const [provider, ...modelParts] = modelKey.split("/");
        const modelId = modelParts.join("/");
        const info = getModelInfo(provider, modelId);
        const price = info?.price || null;
        const freeRPD = info?.freeRPD || 0;
        const dailyCount = perProject
          ? (projectDailyCounts[dateKey]?.[project]?.[modelKey] || 0)
          : (dailyCounts[dateKey]?.[modelKey] || 0);
        result.push({
          date: dateKey, project, provider, model: modelId,
          ...stats,
          cost: Math.round(calcCost(price, stats, freeRPD, dailyCount) * 1e6) / 1e6,
        });
      }
    }
  }
  usageCache = { key: cacheKey, data: result, ts: now };
  res.json(result);
});

app.get("/admin/usage/summary", (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
  const userProjects = req.userRole === "user" ? new Set(req.userProjects || []) : null;
  const cacheKey = `${days}:${req.userRole}:${[...(userProjects || [])].join(",")}`;
  const now = Date.now();
  if (summaryCache.key === cacheKey && now - summaryCache.ts < USAGE_CACHE_TTL) {
    return res.json(summaryCache.data);
  }

  const nowDate = new Date();
  const byProject = {};
  let totalCost = 0, totalRequests = 0;
  const perProject = settings.freeTierMode === "per-project";
  const { dailyCounts, projectDailyCounts } = buildDailyCounts(days, perProject);

  for (let i = 0; i < days; i++) {
    const d = new Date(nowDate); d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    const dayData = usageData[dateKey];
    if (!dayData) continue;
    for (const [project, models] of Object.entries(dayData)) {
      if (userProjects && !userProjects.has(project)) continue;
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
        const dailyCount = perProject
          ? (projectDailyCounts[dateKey]?.[project]?.[modelKey] || 0)
          : (dailyCounts[dateKey]?.[modelKey] || 0);
        const c = calcCost(price, stats, freeRPD, dailyCount);
        pm.cost += c; p.cost += c; totalCost += c;
      }
    }
  }

  for (const p of Object.values(byProject)) {
    p.cost = Math.round(p.cost * 1e4) / 1e4;
    for (const m of Object.values(p.models)) m.cost = Math.round(m.cost * 1e6) / 1e6;
  }
  const data = { days, totalRequests, totalCost: Math.round(totalCost * 1e4) / 1e4, byProject };
  summaryCache = { key: cacheKey, data, ts: Date.now() };
  res.json(data);
});

// --- Settings API (root only) ---
app.get("/admin/settings", requireRole("root"), (req, res) => {
  const domainApiRegistry = settings.domainApiRegistry && typeof settings.domainApiRegistry === "object"
    ? settings.domainApiRegistry
    : {};
  res.json({
    freeTierMode: settings.freeTierMode || "global",
    deployMode: DEPLOY_MODE,
    modules: [...modules],
    allModules: ALL_MODULES,
    authMode: settings.authMode || "static",
    authEmail: settings.authEmail || "",
    authRotateHours: settings.authRotateHours || 24,
    authLastRotated: settings.authLastRotated || null,
    stealthMode: !!settings.stealthMode,
    // LumiChat approval
    approvalEmail: settings.approvalEmail || "",
    approvalEnabled: settings.approvalEnabled !== false,
    // SMTP (password redacted)
    smtpHost: settings.smtpHost || "",
    smtpPort: settings.smtpPort || 587,
    smtpUser: settings.smtpUser || "",
    smtpFrom: settings.smtpFrom || "",
    smtpTo: settings.smtpTo || "",
    smtpEnabled: !!settings.smtpEnabled,
    smtpHasPassword: !!(settings.smtpPass),
    // AI & Tools
    searchKeywordProvider: settings.searchKeywordProvider || "minimax",
    searchKeywordModel: settings.searchKeywordModel || "MiniMax-M1",
    autoSearchEnabled: settings.autoSearchEnabled !== false,
    toolInjectionEnabled: settings.toolInjectionEnabled !== false,
    lcSoftDeleteEnabled: isLcSoftDeleteEnabled(),
    attachmentSearchMode: getAttachmentSearchMode(),
    domainApiRegistry,
  });
});

app.put("/admin/settings", requireRole("root"), (req, res) => {
  const { freeTierMode, deployMode, enabledModules, authMode, authEmail, authRotateHours, confirmSecret,
          smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom, smtpTo, smtpEnabled,
          stealthMode, approvalEmail, approvalEnabled,
          searchKeywordProvider, searchKeywordModel, autoSearchEnabled, toolInjectionEnabled,
          attachmentSearchMode,
          lcSoftDeleteEnabled, domainApiRegistry } = req.body;
  // Require re-authentication for settings changes
  if (!confirmSecret || !safeEqual(confirmSecret, ADMIN_SECRET)) {
    return res.status(403).json({ error: "Admin secret required to change settings" });
  }
  const changes = {};
  if (freeTierMode && ["global", "per-project"].includes(freeTierMode)) {
    settings.freeTierMode = freeTierMode;
    changes.freeTierMode = freeTierMode;
  }
  // Deploy mode + modules — hot switch, no restart needed
  if (deployMode && ["lite", "enterprise", "custom"].includes(deployMode)) {
    const customMods = Array.isArray(enabledModules) ? enabledModules : undefined;
    applyDeployMode(deployMode, customMods);
    settings.deployMode = deployMode;
    if (customMods) settings.customModules = customMods;
    changes.deployMode = deployMode;
    changes.modules = [...modules];
  } else if (Array.isArray(enabledModules) && DEPLOY_MODE === "custom") {
    applyDeployMode("custom", enabledModules);
    settings.customModules = enabledModules;
    changes.modules = [...modules];
  }
  // Auth mode: static (fixed secret) or rotating (email token)
  if (authMode && ["static", "rotating"].includes(authMode)) {
    settings.authMode = authMode;
    changes.authMode = authMode;
  }
  if (typeof authEmail === "string") {
    settings.authEmail = authEmail.trim();
    changes.authEmail = settings.authEmail;
  }
  if (authRotateHours && Number(authRotateHours) >= 1) {
    settings.authRotateHours = Number(authRotateHours);
    changes.authRotateHours = settings.authRotateHours;
  }
  // Persist deploy mode to .env for Docker restart consistency
  if (changes.deployMode || changes.modules) {
    try {
      const envPath = path.join(__dirname, ".env");
      let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
      if (changes.deployMode) {
        const re = /^DEPLOY_MODE=.*$/m;
        if (re.test(envContent)) envContent = envContent.replace(re, `DEPLOY_MODE=${changes.deployMode}`);
        else envContent += `\nDEPLOY_MODE=${changes.deployMode}`;
      }
      if (changes.deployMode === "custom" && changes.modules) {
        const re = /^MODULES=.*$/m;
        const val = `MODULES=${changes.modules.join(",")}`;
        if (re.test(envContent)) envContent = envContent.replace(re, val);
        else envContent += `\n${val}`;
      }
      fs.writeFileSync(envPath, envContent, { mode: 0o600 });
    } catch (e) { console.error("Failed to persist .env:", e.message); }
  }
  // Stealth mode
  if (stealthMode !== undefined) {
    settings.stealthMode = !!stealthMode;
    applyStealthConf(settings.stealthMode);
    changes.stealthMode = settings.stealthMode;
  }
  // SMTP config (留孔 — 存储但不发送)
  if (typeof smtpHost === "string") { settings.smtpHost = smtpHost.trim(); changes.smtpHost = settings.smtpHost; }
  if (smtpPort) { settings.smtpPort = Number(smtpPort) || 587; changes.smtpPort = settings.smtpPort; }
  if (typeof smtpUser === "string") { settings.smtpUser = smtpUser.trim(); changes.smtpUser = settings.smtpUser; }
  if (typeof smtpPass === "string" && smtpPass) { settings.smtpPass = encryptValue(smtpPass, ADMIN_SECRET); changes.smtpPass = "[redacted]"; }
  if (typeof smtpFrom === "string") { settings.smtpFrom = smtpFrom.trim(); changes.smtpFrom = settings.smtpFrom; }
  if (typeof smtpTo === "string") { settings.smtpTo = smtpTo.trim(); changes.smtpTo = settings.smtpTo; }
  if (smtpEnabled !== undefined) { settings.smtpEnabled = !!smtpEnabled; changes.smtpEnabled = settings.smtpEnabled; }
  if (typeof approvalEmail === "string") { settings.approvalEmail = approvalEmail.trim(); changes.approvalEmail = settings.approvalEmail; }
  if (approvalEnabled !== undefined) { settings.approvalEnabled = !!approvalEnabled; changes.approvalEnabled = settings.approvalEnabled; }
  // AI & Tools
  const validKwProviders = ["minimax", "deepseek", "openai", "gemini", "qwen"];
  const validKwModels = ["MiniMax-M1", "deepseek-chat", "gpt-4.1-nano", "gemini-2.5-flash", "qwen-turbo"];
  if (typeof searchKeywordProvider === "string" && validKwProviders.includes(searchKeywordProvider)) { settings.searchKeywordProvider = searchKeywordProvider; changes.searchKeywordProvider = searchKeywordProvider; }
  if (typeof searchKeywordModel === "string" && validKwModels.includes(searchKeywordModel)) { settings.searchKeywordModel = searchKeywordModel; changes.searchKeywordModel = searchKeywordModel; }
  if (autoSearchEnabled !== undefined) { settings.autoSearchEnabled = !!autoSearchEnabled; changes.autoSearchEnabled = settings.autoSearchEnabled; }
  if (toolInjectionEnabled !== undefined) { settings.toolInjectionEnabled = !!toolInjectionEnabled; changes.toolInjectionEnabled = settings.toolInjectionEnabled; }
  if (typeof attachmentSearchMode === "string" && ["smart", "always", "off", "assistant_decide"].includes(attachmentSearchMode)) {
    settings.attachmentSearchMode = attachmentSearchMode;
    changes.attachmentSearchMode = settings.attachmentSearchMode;
  }
  if (lcSoftDeleteEnabled !== undefined) { settings.lcSoftDeleteEnabled = !!lcSoftDeleteEnabled; changes.lcSoftDeleteEnabled = settings.lcSoftDeleteEnabled; }
  if (domainApiRegistry && typeof domainApiRegistry === "object") {
    const sanitized = {};
    for (const [rawDomainKey, rawDomainSpec] of Object.entries(domainApiRegistry)) {
      const domainKey = String(rawDomainKey || "").trim().toLowerCase();
      if (!domainKey || !rawDomainSpec || typeof rawDomainSpec !== "object") continue;
      const label = String(rawDomainSpec.label || domainKey).slice(0, 80);
      const authAdapter = String(rawDomainSpec.authAdapter || domainKey).trim().toLowerCase();
      const rawCollections = rawDomainSpec.collections && typeof rawDomainSpec.collections === "object" ? rawDomainSpec.collections : {};
      const collections = {};
      for (const [apiCollectionName, configKey] of Object.entries(rawCollections)) {
        const apiName = String(apiCollectionName || "").trim();
        const cfgKey = String(configKey || "").trim();
        if (!apiName || !cfgKey) continue;
        if (!LC_COLLECTION_CONFIG[cfgKey]) continue;
        collections[apiName] = cfgKey;
      }
      if (!Object.keys(collections).length) continue;
      sanitized[domainKey] = { label, authAdapter, collections };
    }
    settings.domainApiRegistry = sanitized;
    changes.domainApiRegistry = Object.keys(sanitized);
  }
  saveSettings(settings);
  audit(req.userName, "settings_update", null, changes);
  res.json({
    success: true,
    settings: {
      freeTierMode: settings.freeTierMode || "global",
      deployMode: DEPLOY_MODE,
      modules: [...modules],
      authMode: settings.authMode || "static",
      authEmail: settings.authEmail || "",
      authRotateHours: settings.authRotateHours || 24,
    }
  });
});

// --- Admin LC Data Ops (root only) ---
app.get("/admin/lc/schema", requireRole("root"), (req, res) => {
  res.json(getDomainApiSchema("lc"));
});

app.get("/admin/lc/trash", requireRole("root"), async (req, res) => {
  if (!isLcSoftDeleteEnabled()) return res.status(400).json({ error: "Soft delete is disabled" });
  const userId = String(req.query.userId || "").trim();
  const collection = String(req.query.collection || "all").trim();
  if (!isValidPbId(userId)) return res.status(400).json({ error: "Valid userId is required" });
  const map = { projects: "projects", sessions: "sessions", messages: "messages", files: "files" };
  const keys = collection === "all" ? Object.keys(map) : [collection];
  const invalid = keys.find((k) => !map[k]);
  if (invalid) return res.status(400).json({ error: `Unsupported collection: ${invalid}` });
  try {
    const pbToken = await getPbAdminToken();
    if (!pbToken) return res.status(503).json({ error: "PocketBase admin auth unavailable" });
    const items = [];
    for (const key of keys) {
      const configKey = map[key];
      const r = await pbListOwnedRecords(configKey, {
        ownerId: userId,
        token: pbToken,
        extraFilters: withSoftDeleteFilters(configKey, { trashOnly: true }),
        sort: ["-deleted_at", "-id"],
        perPage: req.query.perPage ? Number(req.query.perPage) : 100,
      });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json(d);
      for (const item of d.items || []) items.push({ collection: key, ...item });
    }
    items.sort((a, b) => new Date(b.deleted_at || 0).getTime() - new Date(a.deleted_at || 0).getTime());
    res.json({ items, totalItems: items.length });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/admin/lc/trash/restore", requireRole("root"), async (req, res) => {
  if (!isLcSoftDeleteEnabled()) return res.status(400).json({ error: "Soft delete is disabled" });
  const map = { projects: "projects", sessions: "sessions", messages: "messages", files: "files" };
  const collection = String(req.body?.collection || "").trim();
  const id = String(req.body?.id || "").trim();
  const configKey = map[collection];
  if (!configKey) return res.status(400).json({ error: "Unsupported collection" });
  if (!validPbId(id)) return res.status(400).json({ error: "Invalid record ID" });
  try {
    const pbToken = await getPbAdminToken();
    if (!pbToken) return res.status(503).json({ error: "PocketBase admin auth unavailable" });
    const data = await restoreSoftDeletedRecord(configKey, { id, token: pbToken });
    res.json({ success: true, data });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

app.get("/admin/lc/projects/:id/references", requireRole("root"), async (req, res) => {
  const projectId = String(req.params.id || "").trim();
  const userId = String(req.query.userId || "").trim();
  if (!validPbId(projectId)) return res.status(400).json({ error: "Invalid project ID" });
  if (!isValidPbId(userId)) return res.status(400).json({ error: "Valid userId is required" });
  try {
    const pbToken = await getPbAdminToken();
    if (!pbToken) return res.status(503).json({ error: "PocketBase admin auth unavailable" });
    const references = await listReferencingRecords({
      domainKey: "lc",
      sourceCollectionKey: "projects",
      ownerId: userId,
      token: pbToken,
      recordId: projectId,
    });
    res.json({ id: projectId, userId, references });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/admin/lc/projects/:id/remap", requireRole("root"), async (req, res) => {
  const sourceId = String(req.params.id || "").trim();
  const userId = String(req.body?.userId || "").trim();
  const targetId = String(req.body?.targetProjectId || "").trim();
  const deleteSource = !!req.body?.deleteSource;
  if (!validPbId(sourceId) || !validPbId(targetId)) return res.status(400).json({ error: "Invalid source/target project ID" });
  if (!isValidPbId(userId)) return res.status(400).json({ error: "Valid userId is required" });
  try {
    const pbToken = await getPbAdminToken();
    if (!pbToken) return res.status(503).json({ error: "PocketBase admin auth unavailable" });
    const remap = await remapLcProjectReferences({ ownerId: userId, token: pbToken, sourceId, targetId });
    let deleted = false;
    if (deleteSource) {
      await assertNoBlockingReferences({
        domainKey: "lc",
        sourceCollectionKey: "projects",
        ownerId: userId,
        token: pbToken,
        recordId: sourceId,
      });
      const delResp = await lcPbFetch(`/api/collections/lc_projects/records/${sourceId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${pbToken}` },
      });
      if (!delResp.ok) {
        const delData = await delResp.json().catch(() => ({}));
        return res.status(delResp.status).json({ error: pbErrorSummary(delData, "Project delete failed"), remap });
      }
      deleted = true;
    }
    res.json({ success: true, remap, deleted });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// --- Auth token rotation (rotating mode) ---
let rotationTimer = null;
function scheduleTokenRotation() {
  if (rotationTimer) clearTimeout(rotationTimer);
  if (settings.authMode !== "rotating" || !settings.authEmail) return;
  const hours = settings.authRotateHours || 24;
  const lastRotated = settings.authLastRotated ? new Date(settings.authLastRotated).getTime() : 0;
  const nextRotation = lastRotated + hours * 3600000;
  const delay = Math.max(0, nextRotation - Date.now());
  rotationTimer = setTimeout(async () => {
    await rotateAdminToken();
    scheduleTokenRotation(); // schedule next
  }, delay);
  console.log(`Token rotation scheduled in ${Math.round(delay / 60000)}min`);
}

async function rotateAdminToken() {
  const newToken = crypto.randomBytes(32).toString("hex");
  const email = settings.authEmail;
  if (!email) return;
  // Update .env
  try {
    const envPath = path.join(__dirname, ".env");
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const re = /^ADMIN_SECRET=.*$/m;
    if (re.test(envContent)) envContent = envContent.replace(re, `ADMIN_SECRET=${newToken}`);
    else envContent += `\nADMIN_SECRET=${newToken}`;
    fs.writeFileSync(envPath, envContent, { mode: 0o600 });
  } catch (e) { console.error("Failed to write rotated token:", e.message); return; }
  // Send email notification (via simple SMTP or log for manual pickup)
  console.log(`[TOKEN ROTATION] New admin token generated. Sending to ${email}...`);
  settings.authLastRotated = new Date().toISOString();
  settings.pendingRotatedToken = newToken;
  saveSettings(settings);
  // Emit audit event
  audit("system", "token_rotated", null, { email, nextRotation: `${settings.authRotateHours}h` });
  // Note: actual email delivery requires SMTP config. Token is saved to settings for manual retrieval.
  console.log(`[TOKEN ROTATION] New token stored. Restart required to apply. Token preview: ${newToken.slice(0, 8)}...`);
}

// Start rotation schedule if configured
scheduleTokenRotation();

// --- PocketBase admin token (for managing LumiChat user tiers) ---
let _pbAdminToken = null;
let _pbAdminTokenPromise = null;
async function getPbAdminToken() {
  if (_pbAdminToken) return _pbAdminToken;
  if (_pbAdminTokenPromise) return _pbAdminTokenPromise;
  const email = process.env.PB_ADMIN_EMAIL;
  const password = process.env.PB_ADMIN_PASSWORD;
  if (!email || !password) return null;
  _pbAdminTokenPromise = (async () => {
    try {
      const r = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: email, password }),
      });
      if (!r.ok) return null;
      const data = await r.json();
      _pbAdminToken = data.token;
      setTimeout(() => { _pbAdminToken = null; }, 30 * 60 * 1000);
      return _pbAdminToken;
    } catch { return null; }
  })().finally(() => { _pbAdminTokenPromise = null; });
  return _pbAdminTokenPromise;
}

// --- LumiChat Tier Cache ---
const lcTierCache = new Map(); // userId → { tier, byokKeys[], updatedAt }
const LC_TIER_CACHE_TTL = 5 * 60 * 1000;
const TIER_RPM = { basic: 30, premium: 120, selfservice: 60 };
const COLLECTOR_PROVIDERS = ["doubao", "kimi", "qwen"];

async function getLcUserTier(userId, lcToken) {
  if (!isValidPbId(userId)) return { tier: null, byokKeys: [], updatedAt: Date.now() };
  const cached = lcTierCache.get(userId);
  if (cached && Date.now() - cached.updatedAt < LC_TIER_CACHE_TTL) return cached;

  try {
    // Fetch tier from lc_user_settings
    const settingsRes = await fetch(
      `${PB_URL}/api/collections/lc_user_settings/records?filter=user='${userId}'&perPage=1`,
      { headers: { Authorization: lcToken ? `Bearer ${lcToken}` : undefined } }
    );
    const settingsData = await settingsRes.json();
    const tier = settingsData.items?.[0]?.tier || null; // null = pending approval
    const upgradeRequest = settingsData.items?.[0]?.upgrade_request || '';

    // Fetch BYOK keys
    let byokKeys = [];
    if (tier === 'selfservice') {
      const keysRes = await fetch(
        `${PB_URL}/api/collections/lc_user_apikeys/records?filter=user='${userId}'&perPage=50`,
        { headers: { Authorization: lcToken ? `Bearer ${lcToken}` : undefined } }
      );
      const keysData = await keysRes.json();
      byokKeys = (keysData.items || []).map(k => ({
        id: k.id, provider: k.provider, key_encrypted: k.key_encrypted,
        label: k.label, enabled: k.enabled,
      }));
    }

    const entry = { tier, byokKeys, upgradeRequest, updatedAt: Date.now() };
    lcTierCache.set(userId, entry);
    return entry;
  } catch {
    return { tier: null, byokKeys: [], updatedAt: Date.now() }; // fail-closed: pending
  }
}

// --- Admin API: LumiChat User Management ---
app.get("/admin/lc-users", requireRole("root", "admin"), async (req, res) => {
  const pbToken = await getPbAdminToken();
  if (!pbToken) return res.status(500).json({ error: "PB admin auth not configured" });
  try {
    const page = req.query.page || 1;
    const perPage = req.query.perPage || 50;
    const usersRes = await fetch(`${PB_URL}/api/collections/users/records?perPage=${perPage}&page=${page}&sort=-created`, {
      headers: { Authorization: `Bearer ${pbToken}` },
    });
    const usersData = await usersRes.json();

    // Batch fetch tiers from lc_user_settings
    const userIds = (usersData.items || []).map(u => u.id);
    let tierMap = {};
    if (userIds.length) {
      const filter = userIds.map(id => `user='${id}'`).join('||');
      const settingsRes = await lcPbFetch(`/api/collections/lc_user_settings/records?filter=${encodeURIComponent(filter)}&perPage=100`, {
        headers: { Authorization: `Bearer ${pbToken}` },
      });
      const settingsData = await settingsRes.json();
      for (const s of (settingsData.items || [])) {
        tierMap[s.user] = { tier: s.tier || 'basic', settingsId: s.id, upgrade_request: s.upgrade_request || '', upgrade_requested_at: s.upgrade_requested_at || '' };
      }
    }

    const result = (usersData.items || []).map(u => ({
      id: u.id, email: u.email, name: u.name, verified: u.verified,
      created: u.created, avatar: u.avatar,
      tier: tierMap[u.id]?.tier || 'basic',
      settingsId: tierMap[u.id]?.settingsId,
      upgrade_request: tierMap[u.id]?.upgrade_request || '',
      upgrade_requested_at: tierMap[u.id]?.upgrade_requested_at || '',
    }));

    res.json({ items: result, totalItems: usersData.totalItems, totalPages: usersData.totalPages, page: usersData.page });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/admin/lc-users/:id/tier", requireRole("root"), async (req, res) => {
  const { tier, clear_upgrade } = req.body;
  if (!isValidPbId(req.params.id)) return res.status(400).json({ error: "Invalid user id" });
  if (!['basic', 'premium', 'selfservice'].includes(tier)) {
    return res.status(400).json({ error: "tier must be basic, premium, or selfservice" });
  }
  const pbToken = await getPbAdminToken();
  if (!pbToken) return res.status(500).json({ error: "PB admin auth not configured" });

  const userId = req.params.id;
  try {
    // Find or create settings record
    const findRes = await lcPbFetch(`/api/collections/lc_user_settings/records?filter=user='${userId}'&perPage=1`, {
      headers: { Authorization: `Bearer ${pbToken}` },
    });
    const findData = await findRes.json();

    if (findData.items?.length) {
      // Update existing
      const updateBody = { tier, tier_updated: new Date().toISOString() };
      if (clear_upgrade) { updateBody.upgrade_request = ''; updateBody.upgrade_requested_at = ''; }
      await lcPbFetch(`/api/collections/lc_user_settings/records/${findData.items[0].id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${pbToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(updateBody),
      });
    } else {
      // Create new settings record
      await lcPbFetch(`/api/collections/lc_user_settings/records`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pbToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: userId, tier, tier_updated: new Date().toISOString() }),
      });
    }

    // Invalidate cache
    lcTierCache.delete(userId);
    audit(req.userName, "lc_user_tier_change", userId, { tier });
    res.json({ success: true, tier });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/admin/lc-users/:id/decline-upgrade", requireRole("root"), async (req, res) => {
  if (!isValidPbId(req.params.id)) return res.status(400).json({ error: "Invalid user id" });
  const pbToken = await getPbAdminToken();
  if (!pbToken) return res.status(500).json({ error: "PB admin auth not configured" });
  const userId = req.params.id;
  try {
    const findRes = await lcPbFetch(`/api/collections/lc_user_settings/records?filter=user='${userId}'&perPage=1`, {
      headers: { Authorization: `Bearer ${pbToken}` },
    });
    const findData = await findRes.json();
    if (findData.items?.length) {
      await lcPbFetch(`/api/collections/lc_user_settings/records/${findData.items[0].id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${pbToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ upgrade_request: '', upgrade_requested_at: '' }),
      });
    }
    lcTierCache.delete(userId);
    audit(req.userName, "lc_upgrade_declined", userId, {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/admin/lc-subscriptions", requireRole("root", "admin"), async (req, res) => {
  const pbToken = await getPbAdminToken();
  if (!pbToken) return res.status(500).json({ error: "PB admin auth not configured" });
  try {
    const r = await lcPbFetch(`/api/collections/lc_subscriptions/records?perPage=100&sort=-created&expand=user`, {
      headers: { Authorization: `Bearer ${pbToken}` },
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/lc-subscriptions", requireRole("root"), async (req, res) => {
  const { userId, expiresAt, notes } = req.body;
  if (!userId || !expiresAt) return res.status(400).json({ error: "userId and expiresAt required" });
  const pbToken = await getPbAdminToken();
  if (!pbToken) return res.status(500).json({ error: "PB admin auth not configured" });
  try {
    const r = await lcPbFetch(`/api/collections/lc_subscriptions/records`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pbToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: userId, plan: 'premium', status: 'active',
        starts_at: new Date().toISOString(), expires_at: expiresAt,
        notes: notes || '',
      }),
    });
    const data = await r.json();
    // Auto-set tier to premium
    await lcPbFetch(`/api/collections/lc_user_settings/records?filter=user='${userId}'&perPage=1`, {
      headers: { Authorization: `Bearer ${pbToken}` },
    }).then(async findRes => {
      const findData = await findRes.json();
      const url = findData.items?.length
        ? `${PB_URL}/api/collections/lc_user_settings/records/${findData.items[0].id}`
        : `${PB_URL}/api/collections/lc_user_settings/records`;
      await fetch(url, {
        method: findData.items?.length ? 'PATCH' : 'POST',
        headers: { Authorization: `Bearer ${pbToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(findData.items?.length ? {} : { user: userId }), tier: 'premium', tier_updated: new Date().toISOString() }),
      });
    });
    lcTierCache.delete(userId);
    audit(req.userName, "lc_subscription_create", userId, { expiresAt });
    res.json({ success: true, id: data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update API key at runtime + persist to .env (sanitized)
app.post("/admin/key", requireRole("root"), async (req, res) => {
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
    const encKey = encryptValue(safeKey, ADMIN_SECRET);
    const keyRegex = new RegExp(`^${keyName}=.*$`, "m");
    if (keyRegex.test(envContent)) {
      envContent = envContent.replace(keyRegex, `${keyName}=${encKey}`);
    } else {
      envContent += `\n${keyName}=${encKey}`;
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
  audit(req.userName, "provider_key_update", name, { baseUrl: !!safeUrl });
  // Auto-test with cheapest model after key update
  const cheapest = (MODELS[name] || []).find(m => m.tier === "economy") || (MODELS[name] || [])[0];
  if (cheapest) {
    try {
      const testBody = {
        model: cheapest.id,
        messages: [{ role: "user", content: "Say hi in 3 words" }],
        ...(/^(o\d|gpt-5)/.test(cheapest.id) ? { max_completion_tokens: 30 } : { max_tokens: 20 }),
      };
      const headers = { "Content-Type": "application/json" };
      let url;
      if (name === "anthropic") {
        Object.assign(headers, anthropicAuthHeaders(safeKey));
        url = `${PROVIDERS[name].baseUrl}/v1/messages`;
      } else if (name === "gemini") {
        headers["Authorization"] = `Bearer ${safeKey}`;
        url = `${PROVIDERS[name].baseUrl}/v1beta/openai/chat/completions`;
      } else {
        headers["Authorization"] = `Bearer ${safeKey}`;
        url = `${PROVIDERS[name].baseUrl}/v1/chat/completions`;
      }
      const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(testBody), signal: AbortSignal.timeout(10000) });
      const data = await resp.json();
      if (resp.ok) {
        const reply = name === "anthropic" ? (data.content?.[0]?.text || "OK") : (data.choices?.[0]?.message?.content || "OK");
        return res.json({ success: true, message: `${name} key updated`, test: { passed: true, model: cheapest.id, reply: reply.trim() } });
      } else {
        return res.json({ success: true, message: `${name} key updated`, test: { passed: false, model: cheapest.id, error: data.error?.message || "API returned error" } });
      }
    } catch (e) {
      return res.json({ success: true, message: `${name} key updated`, test: { passed: false, model: cheapest.id, error: e.message } });
    }
  }
  res.json({ success: true, message: `${name} key updated` });
});

// --- Key cooldown management (registered BEFORE parameterized :provider routes to avoid shadowing) ---
app.get("/admin/keys/cooldowns", requireRole("root"), (req, res) => {
  const now = Date.now();
  const list = [];
  for (const [keyId, c] of keyCooldowns) {
    if (now <= c.until) {
      list.push({ keyId, reason: c.reason, count: c.count, remainingSec: Math.ceil((c.until - now) / 1000) });
    }
  }
  res.json(list);
});

app.delete("/admin/keys/cooldowns/:keyId", requireRole("root"), (req, res) => {
  const { keyId } = req.params;
  if (!keyCooldowns.has(keyId)) return res.status(404).json({ error: "Key not in cooldown" });
  keyCooldowns.delete(keyId);
  audit(req.userName, "key_cooldown_cleared", keyId);
  res.json({ success: true });
});

// --- Multi-key API (root only) ---
app.get("/admin/keys/:provider", requireModule("multikey"), requireRole("root"), (req, res) => {
  const name = req.params.provider.toLowerCase();
  if (!PROVIDERS[name]) return res.status(404).json({ error: "Unknown provider" });
  const keys = (providerKeys[name] || []).map(k => ({
    id: k.id, label: k.label, project: k.project, enabled: k.enabled,
    keyPreview: (() => { try { const d = decryptValue(k.key, ADMIN_SECRET); return d.slice(0, 6) + '...' + d.slice(-4); } catch { return '***'; } })(),
  }));
  res.json(keys);
});

app.post("/admin/keys/:provider", requireModule("multikey"), requireRole("root"), async (req, res) => {
  const name = req.params.provider.toLowerCase();
  if (!PROVIDERS[name]) return res.status(404).json({ error: "Unknown provider" });
  const { label, apiKey, project } = req.body;
  if (!apiKey || typeof apiKey !== "string") return res.status(400).json({ error: "apiKey required" });
  if (!label || typeof label !== "string") return res.status(400).json({ error: "label required" });
  const safeKey = sanitizeEnvValue(apiKey);
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(safeKey)) return res.status(400).json({ error: "Invalid API key format" });
  if (project && !projects.find(p => p.name === project)) return res.status(400).json({ error: "Project not found" });
  if (!providerKeys[name]) providerKeys[name] = [];
  if (providerKeys[name].length >= 100) return res.status(400).json({ error: "Maximum 100 keys per provider" });
  // Dedup: reject if same key value already exists
  const isDuplicate = providerKeys[name].some(k => {
    try { return safeEqual(decryptValue(k.key, ADMIN_SECRET), safeKey); } catch { return false; }
  });
  if (isDuplicate) return res.status(409).json({ error: "This API key already exists for this provider" });
  const entry = {
    id: crypto.randomBytes(8).toString('hex'),
    label: label.slice(0, 32),
    key: encryptValue(safeKey, ADMIN_SECRET),
    project: project || null,
    enabled: true,
  };
  providerKeys[name].push(entry);
  // Keep PROVIDERS.apiKey in sync (first enabled key)
  try { PROVIDERS[name].apiKey = decryptValue(providerKeys[name].find(k => k.enabled)?.key, ADMIN_SECRET); } catch {}
  saveKeys(providerKeys);
  audit(req.userName, "key_add", name, { label: entry.label, project: entry.project });
  // Auto-test
  const cheapest = (MODELS[name] || []).find(m => m.tier === "economy") || (MODELS[name] || [])[0];
  let test = null;
  if (cheapest) {
    try {
      const testBody = { model: cheapest.id, messages: [{ role: "user", content: "Say hi in 3 words" }], ...(/^(o\d|gpt-5)/.test(cheapest.id) ? { max_completion_tokens: 30 } : { max_tokens: 20 }) };
      const headers = { "Content-Type": "application/json" };
      let url;
      if (name === "anthropic") { Object.assign(headers, anthropicAuthHeaders(safeKey)); url = `${PROVIDERS[name].baseUrl}/v1/messages`; }
      else if (name === "gemini") { headers["Authorization"] = `Bearer ${safeKey}`; url = `${PROVIDERS[name].baseUrl}/v1beta/openai/chat/completions`; }
      else { headers["Authorization"] = `Bearer ${safeKey}`; url = `${PROVIDERS[name].baseUrl}/v1/chat/completions`; }
      const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(testBody), signal: AbortSignal.timeout(10000) });
      const data = await resp.json();
      if (resp.ok) {
        const reply = name === "anthropic" ? (data.content?.[0]?.text || "OK") : (data.choices?.[0]?.message?.content || "OK");
        test = { passed: true, model: cheapest.id, reply: reply.trim() };
      } else {
        test = { passed: false, model: cheapest.id, error: data.error?.message || "API error" };
      }
    } catch (e) { test = { passed: false, error: e.message }; }
  }
  res.json({ success: true, id: entry.id, test });
});

app.put("/admin/keys/:provider/reorder", requireModule("multikey"), requireRole("root"), (req, res) => {
  const name = req.params.provider.toLowerCase();
  const { order } = req.body; // array of key IDs in new order
  if (!Array.isArray(order)) return res.status(400).json({ error: "order array required" });
  const keys = providerKeys[name];
  if (!keys) return res.status(404).json({ error: "Unknown provider" });
  const reordered = [];
  for (const id of order) {
    const k = keys.find(x => x.id === id);
    if (k) reordered.push(k);
  }
  // Append any keys not in the order array
  for (const k of keys) { if (!reordered.includes(k)) reordered.push(k); }
  providerKeys[name] = reordered;
  saveKeys(providerKeys);
  res.json({ success: true });
});

app.put("/admin/keys/:provider/:keyId", requireModule("multikey"), requireRole("root"), (req, res) => {
  const name = req.params.provider.toLowerCase();
  const keys = providerKeys[name];
  if (!keys) return res.status(404).json({ error: "Unknown provider" });
  const entry = keys.find(k => k.id === req.params.keyId);
  if (!entry) return res.status(404).json({ error: "Key not found" });
  if (req.body.label) entry.label = String(req.body.label).slice(0, 32);
  if (req.body.enabled !== undefined) entry.enabled = req.body.enabled === true;
  if (req.body.project !== undefined) entry.project = req.body.project || null;
  try { PROVIDERS[name].apiKey = decryptValue(keys.find(k => k.enabled)?.key, ADMIN_SECRET); } catch { PROVIDERS[name].apiKey = undefined; }
  saveKeys(providerKeys);
  audit(req.userName, "key_update", `${name}/${req.params.keyId}`, { fields: Object.keys(req.body) });
  res.json({ success: true });
});

app.delete("/admin/keys/:provider/:keyId", requireModule("multikey"), requireRole("root"), (req, res) => {
  const name = req.params.provider.toLowerCase();
  if (!providerKeys[name]) return res.status(404).json({ error: "Unknown provider" });
  audit(req.userName, "key_delete", `${name}/${req.params.keyId}`);
  providerKeys[name] = providerKeys[name].filter(k => k.id !== req.params.keyId);
  try { PROVIDERS[name].apiKey = decryptValue(providerKeys[name].find(k => k.enabled)?.key, ADMIN_SECRET); } catch { PROVIDERS[name].apiKey = undefined; }
  saveKeys(providerKeys);
  res.json({ success: true });
});

// --- Collector management (multi-account, encrypted, PB backup) ---
const COLLECTOR_SUPPORTED = ["deepseek", "doubao", "kimi", "qwen"];

// Get collector status for all providers (with per-account info)
app.get("/admin/collector/status", requireRole("root", "admin"), (req, res) => {
  const status = {};
  for (const name of Object.keys(PROVIDERS)) {
    const accounts = collectorTokens[name];
    const accountList = Array.isArray(accounts) ? accounts.map(a => ({
      id: a.id, label: a.label, enabled: a.enabled,
    })) : [];
    status[name] = {
      accessMode: getProviderAccessMode(name),
      collectorSupported: COLLECTOR_SUPPORTED.includes(name),
      hasToken: hasCollectorToken(name),
      accounts: accountList,
      keyUrl: PROVIDERS[name].keyUrl || null,
    };
  }
  let credentialFields = {};
  try { credentialFields = require("./collector").credentialFields; } catch {}
  res.json({ providers: status, credentialFields });
});

// Add collector account (multi-account)
app.post("/admin/collector/accounts/:provider", requireRole("root", "admin"), (req, res) => {
  const name = req.params.provider.toLowerCase();
  if (!PROVIDERS[name]) return res.status(404).json({ error: "Unknown provider" });
  if (!COLLECTOR_SUPPORTED.includes(name)) return res.status(400).json({ error: `Collector not supported for ${name}` });
  const { label, credentials } = req.body;
  if (!credentials || typeof credentials !== "object") return res.status(400).json({ error: "credentials object required" });
  if (!label || typeof label !== "string") return res.status(400).json({ error: "label required" });
  if (!Array.isArray(collectorTokens[name])) collectorTokens[name] = [];
  if (collectorTokens[name].length >= 20) return res.status(400).json({ error: "Maximum 20 accounts per provider" });
  const entry = {
    id: crypto.randomBytes(8).toString('hex'),
    label: label.slice(0, 32),
    credentials: encryptValue(JSON.stringify(credentials), ADMIN_SECRET),
    enabled: true,
  };
  collectorTokens[name].push(entry);
  saveCollectorTokens(collectorTokens);
  audit(req.userName, "collector_account_add", name, { label: entry.label });
  log("info", "Collector account added", { provider: name, label: entry.label });
  res.json({ success: true, id: entry.id });
});

// Update collector account (enable/disable, relabel)
app.put("/admin/collector/accounts/:provider/:accountId", requireRole("root", "admin"), (req, res) => {
  const name = req.params.provider.toLowerCase();
  const accounts = collectorTokens[name];
  if (!Array.isArray(accounts)) return res.status(404).json({ error: "No accounts for this provider" });
  const entry = accounts.find(a => a.id === req.params.accountId);
  if (!entry) return res.status(404).json({ error: "Account not found" });
  if (req.body.label) entry.label = String(req.body.label).slice(0, 32);
  if (req.body.enabled !== undefined) entry.enabled = req.body.enabled === true;
  if (req.body.credentials && typeof req.body.credentials === "object") {
    entry.credentials = encryptValue(JSON.stringify(req.body.credentials), ADMIN_SECRET);
  }
  saveCollectorTokens(collectorTokens);
  audit(req.userName, "collector_account_update", `${name}/${req.params.accountId}`);
  res.json({ success: true });
});

// Delete collector account
app.delete("/admin/collector/accounts/:provider/:accountId", requireRole("root", "admin"), (req, res) => {
  const name = req.params.provider.toLowerCase();
  if (!Array.isArray(collectorTokens[name])) return res.status(404).json({ error: "No accounts" });
  collectorTokens[name] = collectorTokens[name].filter(a => a.id !== req.params.accountId);
  if (collectorTokens[name].length === 0) delete collectorTokens[name];
  saveCollectorTokens(collectorTokens);
  audit(req.userName, "collector_account_delete", `${name}/${req.params.accountId}`);
  res.json({ success: true });
});

// Login: open Chrome login window, detect cookie, auto-close, save credentials
// Persist Collector cookies to survive Chrome restart (session cookies would be lost)
const COLLECTOR_COOKIES_PATH = path.join(__dirname, "data", "collector-cookies.json");
function saveCollectorCookies(provider, cookies) {
  try {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(COLLECTOR_COOKIES_PATH, "utf-8")); } catch {}
    all[provider] = cookies;
    const tmp = COLLECTOR_COOKIES_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(all)); fs.renameSync(tmp, COLLECTOR_COOKIES_PATH);
  } catch (e) { log("warn", "Failed to save collector cookies", { error: e.message }); }
}
async function restoreCollectorCookies() {
  try {
    if (!fs.existsSync(COLLECTOR_COOKIES_PATH)) return;
    const all = JSON.parse(fs.readFileSync(COLLECTOR_COOKIES_PATH, "utf-8"));
    const cdpPort = process.env.CDP_PORT || 9223;
    const cdpHost = process.env.CDP_HOST || 'localhost';
    const { chromium } = require('playwright-core');
    const r = await fetch(`http://${cdpHost}:${cdpPort}/json/version`, { signal: AbortSignal.timeout(3000) });
    const wsUrl = (await r.json()).webSocketDebuggerUrl;
    const browser = await chromium.connectOverCDP(wsUrl);
    const ctx = browser.contexts()[0];
    for (const [provider, cookies] of Object.entries(all)) {
      if (Array.isArray(cookies) && cookies.length) {
        // Convert session cookies to persistent (expire in 30 days)
        const fixed = cookies.map(c => ({ ...c, expires: c.expires === -1 ? (Date.now()/1000 + 30*86400) : c.expires }));
        await ctx.addCookies(fixed).catch(() => {});
        log("info", "Restored collector cookies", { provider, count: fixed.length });
      }
    }
  } catch (e) { log("warn", "Cookie restore failed (Chrome may not be ready)", { error: e.message }); }
}
// Restore cookies 10s after startup (Chrome needs time to start)
setTimeout(() => restoreCollectorCookies(), 10000);

const COLLECTOR_LOGIN_SITES = {
  doubao:  { url: 'https://www.doubao.com/chat/', cookie: 'sessionid', name: '豆包' },
  qwen:   { url: 'https://chat.qwen.ai/',         cookie: 'qwen_session', name: '通义千问' },
  kimi:   { url: 'https://www.kimi.com/',          cookie: 'kimi-auth', name: 'Kimi' },
};
// Login state: background polling runs after login starts
let _loginState = { active: false, provider: null, status: 'idle', page: null, ctx: null };

// Step 1: Start login — navigate Chrome to login page, return immediately
app.post("/admin/collector/login/:provider", requireRole("root", "admin"), async (req, res) => {
  const name = req.params.provider.toLowerCase();
  if (!COLLECTOR_LOGIN_SITES[name]) return res.status(400).json({ error: "Unsupported provider" });
  if (_loginState.active) return res.status(409).json({ error: `Login in progress: ${_loginState.provider}` });

  const site = COLLECTOR_LOGIN_SITES[name];
  const cdpPort = process.env.CDP_PORT || 9223;
  const cdpHost = process.env.CDP_HOST || 'localhost';

  try {
    const { chromium } = require('playwright-core');
    let wsUrl;
    try {
      const r = await fetch(`http://${cdpHost}:${cdpPort}/json/version`, { signal: AbortSignal.timeout(2000) });
      wsUrl = (await r.json()).webSocketDebuggerUrl;
      // CDP WebSocket URL may have localhost — replace with correct host for Docker
      if (cdpHost !== 'localhost') wsUrl = wsUrl.replace('localhost', cdpHost).replace('127.0.0.1', cdpHost);
    } catch {
      return res.status(500).json({ error: "Collector Chrome not running" });
    }

    const browser = await chromium.connectOverCDP(wsUrl);
    const ctx = browser.contexts()[0];

    // Check if already logged in
    const existing = await ctx.cookies([site.url]);
    if (existing.find(c => c.name === site.cookie && c.value.length > 5)) {
      // Already logged in — save directly
      if (!Array.isArray(collectorTokens[name])) collectorTokens[name] = [];
      if (!collectorTokens[name].some(a => a.enabled)) {
        collectorTokens[name].push({
          id: crypto.randomBytes(8).toString('hex'),
          label: req.body?.label || 'Default',
          credentials: encryptValue(JSON.stringify({ cdpPort: Number(cdpPort), cdpHost }), ADMIN_SECRET),
          enabled: true,
        });
        saveCollectorTokens(collectorTokens);
      }
      return res.json({ success: true, status: 'already_logged_in', message: `${site.name} already logged in` });
    }

    // Open login page
    const page = await ctx.newPage();
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

    _loginState = { active: true, provider: name, status: 'waiting', page, ctx, label: req.body?.label || 'Default', cdpPort, cdpHost };

    // Start background polling (non-blocking)
    (async () => {
      const site = COLLECTOR_LOGIN_SITES[name];
      for (let i = 0; i < 300; i++) {
        if (!_loginState.active) return;
        const cookies = await ctx.cookies([site.url]).catch(() => []);
        if (cookies.find(c => c.name === site.cookie && c.value.length > 5)) {
          // Login detected! Save all cookies then close tab immediately
          const allCookies = await ctx.cookies([site.url]).catch(() => []);
          saveCollectorCookies(name, allCookies);
          await page.close().catch(() => {});
          // Update existing account or create (avoid duplicates on re-login)
          if (!Array.isArray(collectorTokens[name])) collectorTokens[name] = [];
          const cred = encryptValue(JSON.stringify({ cdpPort: Number(_loginState.cdpPort), cdpHost: _loginState.cdpHost }), ADMIN_SECRET);
          const existingAcct = collectorTokens[name].find(a => a.enabled);
          if (existingAcct) { existingAcct.credentials = cred; existingAcct.label = _loginState.label; }
          else { collectorTokens[name].push({ id: crypto.randomBytes(8).toString('hex'), label: _loginState.label, credentials: cred, enabled: true }); }
          saveCollectorTokens(collectorTokens);
          setCollectorHealth(name, true);
          audit(null, "collector_login", name, { label: _loginState.label });
          _loginState = { active: false, provider: null, status: 'success' };
          return;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      // Timeout
      await page.close().catch(() => {});
      _loginState = { active: false, provider: null, status: 'timeout' };
    })();

    res.json({ success: true, status: 'waiting', provider: name });
  } catch (e) {
    _loginState = { active: false, provider: null, status: 'error' };
    res.status(500).json({ error: e.message });
  }
});

// Step 2: Poll login status (Dashboard calls this every 2s)
app.get("/admin/collector/login/status", requireRole("root", "admin"), (req, res) => {
  res.json({
    active: _loginState.active,
    provider: _loginState.provider,
    status: _loginState.status, // 'idle' | 'waiting' | 'success' | 'timeout' | 'error'
  });
});

// Cancel ongoing login
app.delete("/admin/collector/login", requireRole("root", "admin"), async (req, res) => {
  if (_loginState.active && _loginState.page) {
    await _loginState.page.close().catch(() => {});
  }
  _loginState = { active: false, provider: null, status: 'idle' };
  res.json({ success: true });
});

// Restore collector tokens from PB backup
app.post("/admin/collector/restore", requireRole("root"), async (req, res) => {
  try {
    const result = await restoreCollectorTokensFromPB();
    audit(req.userName, "collector_restore_from_pb", null, result);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Legacy: save single token (backward compat — converts to multi-account)
app.put("/admin/collector/token/:provider", requireRole("root", "admin"), (req, res) => {
  const name = req.params.provider.toLowerCase();
  if (!PROVIDERS[name]) return res.status(404).json({ error: "Unknown provider" });
  if (!COLLECTOR_SUPPORTED.includes(name)) return res.status(400).json({ error: `Collector not supported for ${name}` });
  const { credentials } = req.body;
  if (!credentials || typeof credentials !== "object") return res.status(400).json({ error: "credentials object required" });
  // Convert to multi-account format
  if (!Array.isArray(collectorTokens[name])) collectorTokens[name] = [];
  const entry = {
    id: crypto.randomBytes(8).toString('hex'),
    label: req.body.label || 'Default',
    credentials: encryptValue(JSON.stringify(credentials), ADMIN_SECRET),
    enabled: true,
  };
  // Replace if only one account, otherwise append
  if (collectorTokens[name].length <= 1) collectorTokens[name] = [entry];
  else collectorTokens[name].push(entry);
  saveCollectorTokens(collectorTokens);
  audit(req.userName, "collector_token_update", name);
  res.json({ success: true, id: entry.id });
});

// Legacy: delete all tokens for provider
app.delete("/admin/collector/token/:provider", requireRole("root", "admin"), (req, res) => {
  const name = req.params.provider.toLowerCase();
  if (!collectorTokens[name]) return res.status(404).json({ error: "No collector token for this provider" });
  delete collectorTokens[name];
  saveCollectorTokens(collectorTokens);
  audit(req.userName, "collector_token_delete", name);
  res.json({ success: true });
});

// Switch provider access mode (api_key / collector)
app.put("/admin/providers/:name/access-mode", requireRole("root", "admin"), (req, res) => {
  const name = req.params.name.toLowerCase();
  if (!PROVIDERS[name]) return res.status(404).json({ error: "Unknown provider" });
  const { mode } = req.body;
  if (!["api_key", "collector"].includes(mode)) return res.status(400).json({ error: "mode must be 'api_key' or 'collector'" });
  if (mode === "collector" && !COLLECTOR_SUPPORTED.includes(name)) {
    return res.status(400).json({ error: `Collector not supported for ${name}` });
  }
  if (mode === "collector" && !hasCollectorToken(name)) {
    return res.status(400).json({ error: "Add a collector account first before switching to collector mode" });
  }
  setProviderAccessMode(name, mode);
  audit(req.userName, "access_mode_change", name, { mode });
  log("info", "Provider access mode changed", { provider: name, mode });
  res.json({ success: true, mode });
});

// --- User Management (root and admin only) ---
app.get("/admin/users", requireModule("users"), requireRole("root", "admin"), (req, res) => {
  res.json(users.map(u => ({ username: u.username, role: u.role, enabled: u.enabled, projects: u.projects || [], createdAt: u.createdAt })));
});

app.post("/admin/users", requireModule("users"), requireRole("root", "admin"), async (req, res) => {
  const { username, password, role, projects: linkedProjects } = req.body;
  if (!username || typeof username !== "string" || !/^[a-zA-Z0-9_]{1,32}$/.test(username)) {
    return res.json({ success: false, error: "Invalid username (1-32 chars, alphanumeric + underscore)" });
  }
  if (!password || password.length < 8) {
    return res.json({ success: false, error: "Password must be at least 8 characters" });
  }
  if (!["admin", "user"].includes(role)) {
    return res.json({ success: false, error: "Role must be 'admin' or 'user'" });
  }
  // H-02: only root can create admin accounts
  if (role === "admin" && req.userRole !== "root") {
    return res.status(403).json({ error: "Only root can create admin accounts" });
  }
  if (users.find(u => u.username === username)) {
    return res.json({ success: false, error: "Username already exists" });
  }
  const { hash, salt } = await hashPassword(password);
  const newUser = { username, passwordHash: hash, salt, role, enabled: true, createdAt: new Date().toISOString() };
  if (role === "user" && Array.isArray(linkedProjects)) {
    newUser.projects = linkedProjects.filter(p => typeof p === "string");
  }
  users.push(newUser);
  saveUsers(users);
  audit(req.userName, "user_create", username, { role });
  res.json({ success: true, user: { username, role, enabled: true, projects: newUser.projects || [], createdAt: newUser.createdAt } });
});

app.put("/admin/users/:username", requireModule("users"), requireRole("root", "admin"), async (req, res) => {
  const user = users.find(u => u.username === req.params.username);
  if (!user) return res.json({ success: false, error: "User not found" });
  // Cannot disable/delete your own account
  if (req.body.enabled === false && user.username === req.userName) {
    return res.status(400).json({ error: "Cannot disable your own account" });
  }
  // Admins cannot modify other admins
  if (req.userRole === "admin" && user.role === "admin" && user.username !== req.userName) {
    return res.status(403).json({ error: "Admins cannot modify other admin accounts" });
  }
  if (req.body.password && req.body.password.length >= 8) {
    const { hash, salt } = await hashPassword(req.body.password);
    user.passwordHash = hash;
    user.salt = salt;
  }
  if (req.body.role && ["admin", "user"].includes(req.body.role)) {
    // H-02: only root can promote to admin
    if (req.body.role === "admin" && req.userRole !== "root") {
      return res.status(403).json({ error: "Only root can assign admin role" });
    }
    user.role = req.body.role;
  }
  if (req.body.enabled !== undefined) {
    user.enabled = req.body.enabled;
    if (!user.enabled) {
      for (const [k, v] of sessions) {
        if (v.username === user.username) sessions.delete(k);
      }
    }
  }
  if (req.body.projects !== undefined) {
    user.projects = Array.isArray(req.body.projects) ? req.body.projects.filter(p => typeof p === "string") : [];
  }
  saveUsers(users);
  audit(req.userName, "user_update", req.params.username, { fields: Object.keys(req.body).filter(k => k !== "password") });
  res.json({ success: true, user: { username: user.username, role: user.role, enabled: user.enabled, projects: user.projects || [], createdAt: user.createdAt } });
});

app.delete("/admin/users/:username", requireModule("users"), requireRole("root", "admin"), (req, res) => {
  if (req.params.username === req.userName) {
    return res.status(400).json({ error: "Cannot delete your own account" });
  }
  const idx = users.findIndex(u => u.username === req.params.username);
  if (idx === -1) return res.json({ success: false, error: "User not found" });
  if (req.userRole === "admin" && users[idx].role === "admin") {
    return res.status(403).json({ error: "Admins cannot delete other admin accounts" });
  }
  const username = users[idx].username;
  users.splice(idx, 1);
  saveUsers(users);
  audit(req.userName, "user_delete", username);
  for (const [k, v] of sessions) {
    if (v.username === username) sessions.delete(k);
  }
  res.json({ success: true });
});

// ============================================================
// Metrics / Audit / Backup APIs
// (metrics+audit are enterprise-oriented; backup also available in lite)
// ============================================================
function requireModule(name) {
  return (req, res, next) => {
    if (!mod(name)) return res.status(404).json({ error: `Module "${name}" not enabled. Set DEPLOY_MODE=enterprise or add to MODULES in .env` });
    next();
  };
}

// M-02: SLI metrics endpoint
app.get("/admin/metrics", requireModule("metrics"), requireRole("root", "admin"), (req, res) => {
  const uptime = Date.now() - sli.startedAt;
  const r = sli.requests;
  const successRate = r.total > 0 ? ((r.success / r.total) * 100).toFixed(2) + "%" : "N/A";
  const avgLatency = sli.latency.count > 0 ? Math.round(sli.latency.sum / sli.latency.count) : 0;
  res.json({
    uptime: Math.floor(uptime / 1000),
    requests: r,
    successRate,
    latency: { avgMs: avgLatency, maxMs: sli.latency.max, samples: sli.latency.count },
    proxy: sli.proxy,
    sessions: sessions.size,
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10,
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 10) / 10,
    },
  });
});

// H-01: Audit log viewer
app.get("/admin/audit", requireModule("audit"), requireRole("root"), (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 1000);
  try {
    if (!fs.existsSync(AUDIT_FILE)) return res.json([]);
    const content = fs.readFileSync(AUDIT_FILE, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    const entries = lines.slice(-limit).reverse().map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    res.json(entries);
  } catch {
    res.json([]);
  }
});

// H-02: Backup/restore API
app.post("/admin/backup", requireModule("backup"), requireRole("root"), (req, res) => {
  try {
    const result = createBackup();
    audit(req.userName, "backup_create", result.path, { files: result.files });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/admin/backups", requireModule("backup"), requireRole("root"), (req, res) => {
  res.json(listBackups());
});

app.post("/admin/restore/:name", requireModule("backup"), requireRole("root"), (req, res) => {
  try {
    const result = restoreBackup(req.params.name);
    audit(req.userName, "backup_restore", req.params.name, { files: result.restored });
    // Reload in-memory state
    projects = loadProjects();
    rebuildProjectKeyIndex();
    users = loadUsers();
    settings = loadSettings();
    providerKeys = loadKeys();
    res.json({ success: true, ...result, message: "Data restored. Usage data will take effect after restart." });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================================================
// Smart Routing — /v1/smart/*
// ============================================================
const SMART_CLASSIFIER_TIMEOUT = 2000; // 2s max for classifier
const SMART_MAX_PREVIEW = 200; // chars of user message sent to classifier

async function classifyRequest(classifierProvider, classifierModel, candidates, userPreview) {
  const provider = PROVIDERS[classifierProvider];
  const classKey = selectApiKey(classifierProvider, "_chat");
  if (!classKey && !provider?.apiKey) return null;
  const classApiKey = classKey?.apiKey || provider.apiKey;

  const candidateList = candidates.map((c, i) => {
    const info = getModelInfo(c.provider, c.model);
    return `${i}: ${c.provider}/${c.model} (${info?.tier || "unknown"}) — ${info?.desc || ""}`;
  }).join("\n");

  const systemPrompt = `You are a request router. Given a task, pick the best model index.
Reply ONLY with JSON: {"pick":<index>}
Models:
${candidateList}
Rules: Pick the cheapest model that can handle the task well. Use flagship only for complex reasoning, math proofs, or multi-step coding. Use economy for simple Q&A, translation, classification.`;

  const body = {
    model: classifierModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Task: ${userPreview}` }
    ],
    temperature: 0,
    max_tokens: 20,
  };

  let url = provider.baseUrl;
  if (classifierProvider === "gemini") url += "/v1beta/openai/chat/completions";
  else if (classifierProvider === "doubao") url += "/chat/completions";
  else url += "/v1/chat/completions";

  const headers = { "Content-Type": "application/json" };
  if (classifierProvider === "anthropic") {
    // Anthropic uses different format; skip for now — use OpenAI-compat providers
    return null;
  }
  headers["Authorization"] = `Bearer ${classApiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMART_CLASSIFIER_TIMEOUT);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || "";
    // Extract tokens for usage tracking
    const usage = data.usage || {};
    const tokens = {
      input: usage.prompt_tokens || 0,
      cacheHit: usage.prompt_cache_hit_tokens || 0,
      output: usage.completion_tokens || 0,
    };
    // Parse pick index
    const match = content.match(/\{\s*"pick"\s*:\s*(\d+)\s*\}/);
    const pickIdx = match ? parseInt(match[1], 10) : null;
    return { pickIdx, tokens };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

app.use("/v1/smart", apiLimiter, async (req, res, next) => {
  // --- Auth: same as normal proxy ---
  let projectName, proj;
  const projectKey =
    req.headers["x-project-key"] ||
    (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");

  if (safeEqual(projectKey, INTERNAL_CHAT_KEY)) {
    projectName = "_chat";
  } else if (["root", "admin"].includes(getSessionRole(req))) {
    projectName = "_chat";
  } else {
    // Resolve: ephemeral token → HMAC → direct key
    let _tokenStr = null;
    if (projectKey.startsWith("et_")) {
      const tokenInfo = ephemeralTokens.get(projectKey);
      if (!tokenInfo || Date.now() > tokenInfo.expiresAt) return res.status(401).json({ error: "Token expired or invalid" });
      proj = tokenInfo.project;
      if (!proj.enabled) return res.status(403).json({ error: "Project disabled" });
      _tokenStr = projectKey;
    } else if (req.headers["x-signature"]) {
      const projId = req.headers["x-project-id"];
      if (projId) {
        const candidate = projects.find(p => p.enabled && p.name === projId && p.authMode === "hmac");
        if (candidate && verifyHmacSignature(candidate, req).ok) proj = candidate;
      }
      if (!proj) return res.status(401).json({ error: "HMAC verification failed" });
    } else {
      proj = ((k) => { const _p = projectKeyIndex.get(k); return _p && _p.enabled ? _p : undefined; })(projectKey);
      if (!proj) return res.status(401).json({ error: "Invalid or missing project key" });
      if (proj.authMode === "hmac") return res.status(403).json({ error: "This project requires HMAC signature authentication" });
    }
    projectName = proj.name;
    if (!checkProjectIP(proj, req)) return res.status(403).json({ error: "IP not allowed for this project" });
    { const rl = checkProjectRateLimit(proj, req); if (!rl.ok) return res.status(429).json({ error: rl.reason === "ip" ? "Per-IP rate limit exceeded for this project" : "Project rate limit exceeded" }); }
    if (_tokenStr) { const trl = checkTokenRateLimit(_tokenStr, proj); if (!trl.ok) return res.status(429).json({ error: "Per-token rate limit exceeded" }); }
    { const crl = checkCostRateLimit(proj); if (!crl.ok) return res.status(429).json({ error: "Project cost rate limit exceeded (USD/min)" }); }
    if (!checkProjectAnomaly(proj)) return res.status(403).json({ error: "Project suspended due to anomalous activity" });
    checkBudgetReset(proj);
    if (proj.maxBudgetUsd != null && (proj.budgetUsedUsd || 0) >= proj.maxBudgetUsd) {
      return res.status(429).json({ error: "Project budget exceeded" });
    }
  }

  // --- Get smart routing config ---
  const routing = proj?.smartRouting;
  if (!routing?.enabled || !routing.candidates?.length) {
    return res.status(400).json({ error: "Smart routing not enabled for this project" });
  }

  // Validate classifier provider has API key
  const classifierProv = routing.classifierProvider;
  const classifierMod = routing.classifierModel;
  if (!PROVIDERS[classifierProv]?.apiKey) {
    return res.status(500).json({ error: "Classifier provider has no API key" });
  }

  // Validate all candidate providers have API keys
  const validCandidates = routing.candidates.filter(c => PROVIDERS[c.provider]?.apiKey);
  if (!validCandidates.length) {
    return res.status(500).json({ error: "No candidate models have configured API keys" });
  }

  // Extract user message preview (security: limit to SMART_MAX_PREVIEW chars)
  const messages = req.body?.messages || [];
  const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
  const userContent = typeof lastUserMsg?.content === "string"
    ? lastUserMsg.content
    : Array.isArray(lastUserMsg?.content)
      ? lastUserMsg.content.filter(p => p.type === "text").map(p => p.text).join(" ")
      : "";
  const preview = userContent.slice(0, SMART_MAX_PREVIEW);

  // --- Classify ---
  const result = await classifyRequest(classifierProv, classifierMod, validCandidates, preview);

  // Track classifier usage
  if (result?.tokens) {
    recordUsage(projectName, classifierProv, classifierMod, result.tokens);
    const classifierCost = calcRequestCost(classifierProv, classifierMod, result.tokens);
    if (proj?.maxBudgetUsd != null) {
      proj.budgetUsedUsd = (proj.budgetUsedUsd || 0) + classifierCost;
      markProjectsDirty();
    }
    if (proj?.maxCostPerMin) recordCostForRateLimit(projectName, classifierCost);
  }

  // Pick target (fallback if classifier fails or returns invalid index)
  let target;
  if (result?.pickIdx != null && result.pickIdx >= 0 && result.pickIdx < validCandidates.length) {
    target = validCandidates[result.pickIdx];
  } else {
    // Fallback: use defaultModel or first candidate
    target = routing.defaultModel && PROVIDERS[routing.defaultModel.provider]?.apiKey
      ? routing.defaultModel
      : validCandidates[0];
  }

  // --- Rewrite request to target provider/model ---
  req.params = { provider: target.provider };
  req.body.model = target.model;
  req.url = req.url.replace(/^\/v1\/smart/, `/v1/${target.provider}`);
  req._proxyProjectName = projectName;
  req._proxyProject = proj;
  // Global stealthMode overrides per-project setting
  if (settings.stealthMode) req._proxyProject = { ...proj, privacyMode: true };

  // Add routing info header
  res.setHeader("X-Smart-Route", `${target.provider}/${target.model}`);

  // --- Inject auth and forward to proxy ---
  const targetProvider = PROVIDERS[target.provider];
  if (target.provider === "anthropic") {
    const authH = anthropicAuthHeaders(targetProvider.apiKey, req.headers["anthropic-beta"]);
    Object.assign(req.headers, authH);
    if (authH["authorization"]) delete req.headers["x-api-key"];
    else delete req.headers["authorization"];
  } else {
    req.headers["authorization"] = `Bearer ${targetProvider.apiKey}`;
  }
  delete req.headers["host"];
  delete req.headers["x-project-key"];

  proxyMiddleware(req, res, next);
});

// ============================================================
// Anthropic OpenAI Compatibility Layer
// Translates /v1/chat/completions ↔ /v1/messages format
// ============================================================
function openaiToAnthropicBody(body) {
  const msgs = body.messages || [];
  const systemParts = msgs
    .filter(m => m.role === "system")
    .map(m => (typeof m.content === "string" ? m.content : (m.content || []).filter(p => p.type === "text").map(p => p.text).join("")));
  const nonSystem = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "system") continue;
    if (m.role === "assistant" && m.tool_calls) {
      // Convert OpenAI tool_calls to Anthropic content blocks
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        let inputObj = {};
        try { inputObj = JSON.parse(tc.function?.arguments || "{}"); } catch {}
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input: inputObj });
      }
      nonSystem.push({ role: "assistant", content: blocks });
    } else if (m.role === "tool") {
      // Convert OpenAI tool result to Anthropic tool_result
      // Group consecutive tool messages into one user message
      const toolResults = [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content || "" }];
      while (i + 1 < msgs.length && msgs[i + 1].role === "tool") {
        i++;
        toolResults.push({ type: "tool_result", tool_use_id: msgs[i].tool_call_id, content: msgs[i].content || "" });
      }
      nonSystem.push({ role: "user", content: toolResults });
    } else {
      nonSystem.push({ role: m.role, content: m.content });
    }
  }
  const out = { model: body.model, messages: nonSystem, max_tokens: body.max_tokens || 1024 };
  if (systemParts.length) out.system = systemParts.join("\n");
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.stream) out.stream = true;
  // Convert OpenAI-format tools to Anthropic format
  if (body.tools && Array.isArray(body.tools)) {
    out.tools = body.tools.map(t => {
      if (t.type === "function" && t.function) {
        return { name: t.function.name, description: t.function.description || "", input_schema: t.function.parameters || { type: "object", properties: {} } };
      }
      return t;
    });
    if (body.tool_choice === "auto") out.tool_choice = { type: "auto" };
    else if (body.tool_choice === "required") out.tool_choice = { type: "any" };
  }
  return out;
}

function anthropicAuthHeaders(apiKey, existingBeta) {
  if (apiKey?.startsWith("sk-ant-oat")) {
    const betas = ["claude-code-20250219", "oauth-2025-04-20"];
    if (existingBeta) betas.unshift(existingBeta);
    return {
      "authorization": `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": [...new Set(betas)].join(","),
      "anthropic-product": "claude-code",
      "x-app": "cli",
      "user-agent": "claude-code/2.1.49 (external, cli)",
    };
  }
  return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
}

function anthropicToOpenaiResponse(data, model) {
  const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  const finishReason = { end_turn: "stop", max_tokens: "length" }[data.stop_reason] || data.stop_reason || "stop";
  return {
    id: data.id || ("chatcmpl-anth-" + Date.now()),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason, logprobs: null }],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
  };
}

async function handleAnthropicCompat(req, res, apiKey, projectName, excludeKeyIds = new Set()) {
  const requestedModel = req.body?.model || "claude-haiku-4-5";
  const isStream = req.body?.stream === true;
  const anthropicBody = openaiToAnthropicBody(req.body);
  const fetchHeaders = { "Content-Type": "application/json", ...anthropicAuthHeaders(apiKey) };
  if (req.traceId) fetchHeaders["x-request-id"] = req.traceId;
  // Do NOT forward Origin/Referer — Anthropic rejects direct-browser CORS requests

  let anthropicResp;
  try {
    anthropicResp = await fetch(`${PROVIDERS.anthropic.baseUrl}/v1/messages`, {
      method: "POST", headers: fetchHeaders, body: JSON.stringify(anthropicBody),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    return res.status(502).json({ error: "Upstream connection error", message: e.message });
  }

  if (!anthropicResp.ok) {
    const status = anthropicResp.status;
    // Key failover on 429/401
    if ((status === 429 || status === 401) && req._selectedKeyId) {
      const currentKeyId = req._selectedKeyId;
      markKeyCooling(currentKeyId, status);
      const nextExclude = new Set([...excludeKeyIds, currentKeyId]);
      const nextKey = selectApiKey("anthropic", projectName || req._proxyProjectName, nextExclude);
      if (nextKey) {
        req._selectedKeyId = nextKey.keyId;
        return handleAnthropicCompat(req, res, nextKey.apiKey, projectName || req._proxyProjectName, nextExclude);
      }
    }
    const errText = await anthropicResp.text();
    let errMsg = errText;
    try { errMsg = JSON.parse(errText)?.error?.message || errText; } catch (_) {}
    return res.status(status).json({ error: errMsg });
  }

  if (isStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    const msgId = "chatcmpl-anth-" + Date.now();
    const created = Math.floor(Date.now() / 1000);
    let inputTokens = 0, outputTokens = 0, buf = "";
    let _anthStreamContent = ""; // accumulate text for tool tag detection
    // Track native tool_use blocks from Anthropic streaming
    const _anthToolBlocks = {}; // index → {id, name, args}
    let _anthCurrentBlockIdx = -1;
    let _anthStopReason = "";
    try {
      for await (const chunk of anthropicResp.body) {
        buf += Buffer.from(chunk).toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data) continue;
          try {
            const ev = JSON.parse(data);
            if (ev.type === "message_start") {
              inputTokens = ev.message?.usage?.input_tokens || 0;
              res.write(`data: ${JSON.stringify({ id: msgId, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }] })}\n\n`);
            } else if (ev.type === "content_block_start") {
              _anthCurrentBlockIdx = ev.index ?? 0;
              if (ev.content_block?.type === "tool_use") {
                _anthToolBlocks[_anthCurrentBlockIdx] = {
                  id: ev.content_block.id || "",
                  name: ev.content_block.name || "",
                  args: "",
                };
              }
            } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
              _anthStreamContent += ev.delta.text || "";
              res.write(`data: ${JSON.stringify({ id: msgId, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: { content: ev.delta.text }, logprobs: null, finish_reason: null }] })}\n\n`);
            } else if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
              // Accumulate native tool_use arguments
              const idx = _anthCurrentBlockIdx;
              if (_anthToolBlocks[idx]) {
                _anthToolBlocks[idx].args += ev.delta.partial_json || "";
              }
            } else if (ev.type === "content_block_stop") {
              // If this block was a tool_use, emit it as OpenAI-format tool_calls delta
              const idx = _anthCurrentBlockIdx;
              if (_anthToolBlocks[idx]) {
                const tc = _anthToolBlocks[idx];
                const tcIdx = Object.keys(_anthToolBlocks).indexOf(String(idx));
                res.write(`data: ${JSON.stringify({ id: msgId, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: { tool_calls: [{ index: tcIdx, id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } }] }, logprobs: null, finish_reason: null }] })}\n\n`);
              }
            } else if (ev.type === "message_delta") {
              outputTokens = ev.usage?.output_tokens || 0;
              _anthStopReason = ev.delta?.stop_reason || "";
              const hasNativeTools = Object.keys(_anthToolBlocks).length > 0;
              const fr = hasNativeTools && _anthStopReason === "tool_use" ? "tool_calls"
                : ({ end_turn: "stop", max_tokens: "length" }[_anthStopReason] || _anthStopReason || "stop");
              res.write(`data: ${JSON.stringify({ id: msgId, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: fr }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } })}\n\n`);
            } else if (ev.type === "message_stop") {
              res.write("data: [DONE]\n\n");
            }
          } catch (_) {}
        }
      }
    } catch (_) {}

    // Execute text-based tool calls in Anthropic streaming (same as other providers)
    const anthContentToScan = _anthStreamContent;
    const anthHasToolTags = /\[TOOL:\w+\]/.test(anthContentToScan) || /<(?:｜DSML｜|︱DSML︱|\|DSML\|)function_calls>/.test(anthContentToScan) || /<(?:minimax:)?tool_call>/.test(anthContentToScan);
    if (anthHasToolTags) {
      try {
        const toolResults = await executeTextToolCalls(anthContentToScan, req._lcUserId || req._proxyProjectName || "api");
        if (toolResults.length > 0 && !res.writableEnded) {
          for (const tr of toolResults) {
            res.write(`event: tool_result\ndata: ${JSON.stringify(tr)}\n\n`);
          }
          log("info", "Anthropic streaming tool results sent", { count: toolResults.length });
        }
      } catch (e) { log("error", "Anthropic streaming tool exec failed", { error: e.message }); }
    }
    res.end();
    const tokens = { input: inputTokens, cacheHit: 0, output: outputTokens };
    if (!req._proxyProject?.privacyMode) recordUsage(req._proxyProjectName, "anthropic", req._isSubscriptionKey ? `${requestedModel}:subscription` : requestedModel, tokens);
    if (req._proxyProject && (!req._isSubscriptionKey || req._proxyProject.subscriptionCountsSpending)) {
      const cost = calcRequestCost("anthropic", requestedModel, tokens);
      if (req._proxyProject.maxBudgetUsd != null) { req._proxyProject.budgetUsedUsd = (req._proxyProject.budgetUsedUsd || 0) + cost; markProjectsDirty(); }
      if (req._proxyProject.maxCostPerMin) recordCostForRateLimit(req._proxyProjectName, cost);
    }
    return;
  }

  // Non-streaming
  let anthropicData = await anthropicResp.json();
  const tokens = { input: anthropicData.usage?.input_tokens || 0, cacheHit: 0, output: anthropicData.usage?.output_tokens || 0 };
  if (!req._proxyProject?.privacyMode) recordUsage(req._proxyProjectName, "anthropic", req._isSubscriptionKey ? `${requestedModel}:subscription` : requestedModel, tokens);
  if (req._proxyProject && (!req._isSubscriptionKey || req._proxyProject.subscriptionCountsSpending)) {
    const cost = calcRequestCost("anthropic", requestedModel, tokens);
    if (req._proxyProject.maxBudgetUsd != null) { req._proxyProject.budgetUsedUsd = (req._proxyProject.budgetUsedUsd || 0) + cost; markProjectsDirty(); }
    if (req._proxyProject.maxCostPerMin) recordCostForRateLimit(req._proxyProjectName, cost);
  }

  // D. Non-streaming tool use execution
  const toolUseBlocks = (anthropicData.content || []).filter(b => b.type === "tool_use");
  if (toolUseBlocks.length > 0) {
    try {
      const toolResults = [];
      for (const block of toolUseBlocks) {
        const toolName = block.name;
        const toolInput = block.input;
        const result = await unifiedRegistry.executeToolCall(toolName, toolInput);

        // F. Tool call logging (async, non-blocking)
        const userId = req._lcUserId || req._tokenUserId;
        const projectId = projectName || req._proxyProjectName;
        const sessionId = req._secSessionId || req.body?.session_id || req.headers?.["x-session-id"] || "";
        getPbAdminToken().then(token => {
          if (!token) return;
          fetch(`${PB_URL}/api/collections/tool_calls/records`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: token },
            body: JSON.stringify({
              user: userId || projectId || "unknown",
              source: req.get("X-Source") || "api",
              tool_name: toolName,
              input_json: JSON.stringify(toolInput),
              output_json: JSON.stringify(result.data || { file: result.filename }),
              status: result.ok ? "success" : "error",
              error_message: result.error || "",
              duration_ms: result.duration || 0,
              session_id: sessionId,
            }),
          }).catch(() => {});
        }).catch(() => {});

        // If tool generated a file, save to PocketBase generated_files collection
        if (result.ok && result.file) {
          try {
            const pbToken = await getPbAdminToken();
            if (pbToken) {
              const boundary = "----FormBoundary" + crypto.randomBytes(8).toString("hex");
              const fieldParts = [];
              fieldParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="filename"\r\n\r\n${result.filename}`);
              fieldParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="mime_type"\r\n\r\n${result.mimeType}`);
              fieldParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="user"\r\n\r\n${userId || projectId || "unknown"}`);
              const headerBuf = Buffer.from(`${fieldParts.join("\r\n")}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${result.filename}"\r\nContent-Type: ${result.mimeType}\r\n\r\n`);
              const footerBuf = Buffer.from(`\r\n--${boundary}--\r\n`);
              const body = Buffer.concat([headerBuf, result.file, footerBuf]);
              fetch(`${PB_URL}/api/collections/generated_files/records`, {
                method: "POST",
                headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, Authorization: pbToken },
                body,
              }).catch(() => {});
            }
          } catch {}
        }

        // Build tool_result content
        if (result.ok) {
          const content = result.file
            ? JSON.stringify({ filename: result.filename, mimeType: result.mimeType, size: result.file.length })
            : JSON.stringify(result.data);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content });
        } else {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ error: result.error }), is_error: true });
        }
      }

      // Send new request to LLM with original messages + assistant tool_use + tool_results
      const followupBody = {
        ...req.body,
        messages: [
          ...(anthropicData._originalMessages || req.body.messages || []),
          { role: "assistant", content: anthropicData.content },
          { role: "user", content: toolResults },
        ],
      };
      // Remove stream override — keep non-streaming
      delete followupBody.stream;

      const followupHeaders = { "Content-Type": "application/json", ...anthropicAuthHeaders(apiKey) };
      if (req.traceId) followupHeaders["x-request-id"] = req.traceId;

      const followupResp = await fetch(`${PROVIDERS.anthropic.baseUrl}/v1/messages`, {
        method: "POST", headers: followupHeaders, body: JSON.stringify(followupBody),
      });

      if (followupResp.ok) {
        anthropicData = await followupResp.json();
        // Track usage for followup
        const followupTokens = { input: anthropicData.usage?.input_tokens || 0, cacheHit: 0, output: anthropicData.usage?.output_tokens || 0 };
        if (!req._proxyProject?.privacyMode) recordUsage(req._proxyProjectName, "anthropic", req._isSubscriptionKey ? `${requestedModel}:subscription` : requestedModel, followupTokens);
      }
    } catch (err) {
      log("error", "Tool use execution failed", { error: err.message, traceId: req.traceId });
      // Fall through — return original response with tool_use blocks
    }
  }

  // Resolve PII placeholders in response before sending to client
  let openaiData = anthropicToOpenaiResponse(anthropicData, requestedModel);
  if (req._secMapping?.hasSecrets()) {
    const mapping = req._secMapping;
    openaiData = JSON.parse(mapping.resolve(JSON.stringify(openaiData)));
  }

  return res.json(openaiData);
}

// ============================================================
// API Proxy — /v1/:provider/*
// ============================================================

// Repair common AI-generated malformed JSON before parsing
function repairJSON(str) {
  let s = str.trim();
  // Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');
  // Try parsing as-is first
  try { JSON.parse(s); return s; } catch {}
  // Count brackets and add missing closing ones
  let opens = 0, openb = 0;
  for (const c of s) { if (c === '{') opens++; if (c === '}') opens--; if (c === '[') openb++; if (c === ']') openb--; }
  while (opens > 0) { s += '}'; opens--; }
  while (openb > 0) { s += ']'; openb--; }
  // Try again
  try { JSON.parse(s); return s; } catch {}
  // Replace single quotes with double (but not inside strings)
  s = s.replace(/'/g, '"');
  try { JSON.parse(s); return s; } catch {}
  return str; // give up, return original
}

// Format tool results server-side — frontend only renders the HTML
function formatToolResult(toolName, data) {
  // Search results → HTML card
  if (toolName === "web_search" && data.results) {
    const items = (data.results || []).slice(0, 6);
    if (items.length === 0) return { html: '<div style="padding:12px;color:#888">No results found</div>' };
    const esc = s => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    let html = '<div style="border:1px solid var(--border,#333);border-radius:12px;overflow:hidden">';
    html += '<div style="padding:10px 14px;background:var(--inp,#2f2f2f);font-size:12px;font-weight:600;color:var(--t3,#888);display:flex;align-items:center;gap:6px"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>Search Results</div>';
    for (const r of items) {
      html += `<div style="padding:10px 14px;border-top:1px solid var(--border,#333)"><a href="${esc(r.url)}" target="_blank" style="color:var(--accent,#10a37f);font-size:14px;font-weight:500;text-decoration:none">${esc(r.title)}</a><div style="font-size:12px;color:var(--t3,#888);margin-top:4px;line-height:1.5">${esc((r.content || "").slice(0, 150))}</div></div>`;
    }
    html += '</div>';
    return { html, query: data.query };
  }

  // Template result → info
  if (data.based_on_template) {
    return { html: `<div style="padding:8px 12px;background:var(--inp,#2f2f2f);border-radius:8px;font-size:13px;color:var(--t2,#ccc)">Based on template: <b>${String(data.based_on_template)}</b></div>`, data };
  }

  // Default — pass through
  return { data };
}

// Shared helper: execute text-based tool calls and upload files to PocketBase
// Supports: [TOOL:name]{json}[/TOOL] and <minimax:tool_call><invoke name="x"><parameter name="y">val</parameter></invoke></minimax:tool_call>
async function executeTextToolCalls(contentText, userId) {
  const results = [];

  // 1. Parse [TOOL:name]{json}[/TOOL] format
  const toolTagRe = /\[TOOL:(\w+)\]([\s\S]*?)\[\/TOOL\]/g;
  let toolMatch;
  while ((toolMatch = toolTagRe.exec(contentText)) !== null) {
    const toolName = toolMatch[1];
    let toolInput = {};
    try { toolInput = JSON.parse(repairJSON(toolMatch[2].trim())); } catch (e) { log("warn", "Tool JSON parse failed", { tool: toolName, error: e.message, raw: toolMatch[2].slice(0,200) }); continue; }
    try {
      const result = await unifiedRegistry.executeToolCall(toolName, toolInput);
      if (result.ok && result.file) {
        let downloadUrl = "";
        try {
          const pbToken = await getPbAdminToken();
          if (pbToken) {
            const fn = (result.filename || "file").replace(/"/g, "_");
            const boundary = "----FB" + crypto.randomBytes(8).toString("hex");
            const headerBuf = Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="filename"\r\n\r\n${fn}\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="mime_type"\r\n\r\n${result.mimeType}\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="user"\r\n\r\n${userId || "api"}\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fn}"\r\nContent-Type: ${result.mimeType}\r\n\r\n`
            );
            const footerBuf = Buffer.from(`\r\n--${boundary}--\r\n`);
            const pbRes = await fetch(`${PB_URL}/api/collections/generated_files/records`, {
              method: "POST",
              headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, Authorization: pbToken },
              body: Buffer.concat([headerBuf, result.file, footerBuf]),
            });
            if (pbRes.ok) { const rec = await pbRes.json(); downloadUrl = `${PB_URL}/api/files/generated_files/${rec.id}/${rec.file}`; }
          }
        } catch {}
        results.push({
          tool: toolName, filename: result.filename, mimeType: result.mimeType,
          size: result.file.length, downloadUrl,
          base64: !downloadUrl ? result.file.toString("base64") : undefined,
          duration: result.duration,
        });
      } else if (result.ok && result.data) {
        // Format data server-side — frontend only renders
        const formatted = formatToolResult(toolName, result.data);
        results.push({ tool: toolName, ...formatted, duration: result.duration });
      }
    } catch (e) { log("warn", "Tool tag execution failed", { tool: toolName, error: e.message }); }
  }
  // 2. Parse DeepSeek DSML tool calls: <｜DSML｜function_calls><｜DSML｜invoke name="x"><｜DSML｜parameter name="y" string="true">val<｜DSML｜parameter>...
  const dsmlRe = /<(?:｜DSML｜|︱DSML︱|\|DSML\|)function_calls>([\s\S]*?)<\/(?:｜DSML｜|︱DSML︱|\|DSML\|)function_calls>/g;
  let dsmlMatch;
  while ((dsmlMatch = dsmlRe.exec(contentText)) !== null) {
    const invokeRe = /<(?:｜DSML｜|︱DSML︱|\|DSML\|)invoke\s+name="(\w+)"[^>]*>([\s\S]*?)<\/(?:｜DSML｜|︱DSML︱|\|DSML\|)invoke>/g;
    let dInvoke;
    while ((dInvoke = invokeRe.exec(dsmlMatch[1])) !== null) {
      const toolName = dInvoke[1];
      const toolInput = {};
      const paramRe = /<(?:｜DSML｜|︱DSML︱|\|DSML\|)parameter\s+name="(\w+)"[^>]*>([\s\S]*?)<(?:｜DSML｜|︱DSML︱|\|DSML\|)parameter>/g;
      let dParam;
      while ((dParam = paramRe.exec(dInvoke[2])) !== null) {
        let val = dParam[2].trim();
        try { val = JSON.parse(val); } catch {}
        toolInput[dParam[1]] = val;
      }
      if (Object.keys(toolInput).length > 0) {
        try {
          const result = await unifiedRegistry.executeToolCall(toolName, toolInput);
          if (result.ok && result.data) {
            const formatted = formatToolResult(toolName, result.data);
            results.push({ tool: toolName, ...formatted, duration: result.duration });
          }
        } catch (e) { log("warn", "DSML tool exec failed", { tool: toolName, error: e.message }); }
      }
    }
  }

  // 3. Parse XML tool calls: <minimax:tool_call><invoke name="x"><parameter name="y">val</parameter></invoke></minimax:tool_call>
  const xmlToolRe = /<(?:minimax:)?tool_call>([\s\S]*?)<\/(?:minimax:)?tool_call>/g;
  let xmlMatch;
  while ((xmlMatch = xmlToolRe.exec(contentText)) !== null) {
    const invokeRe = /<invoke\s+name="(\w+)">([\s\S]*?)<\/invoke>/g;
    let invokeMatch;
    while ((invokeMatch = invokeRe.exec(xmlMatch[1])) !== null) {
      const toolName = invokeMatch[1];
      const toolInput = {};
      const paramRe = /<parameter\s+name="(\w+)">([\s\S]*?)<\/parameter>/g;
      let paramMatch;
      while ((paramMatch = paramRe.exec(invokeMatch[2])) !== null) {
        let val = paramMatch[2].trim();
        try { val = JSON.parse(val); } catch {} // try parsing JSON arrays/objects
        toolInput[paramMatch[1]] = val;
      }
      try {
        const result = await unifiedRegistry.executeToolCall(toolName, toolInput);
        if (result.ok && result.file) {
          let downloadUrl = "";
          try {
            const pbToken = await getPbAdminToken();
            if (pbToken) {
              const fn = (result.filename || "file").replace(/"/g, "_");
              const boundary = "----FB" + crypto.randomBytes(8).toString("hex");
              const headerBuf = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="filename"\r\n\r\n${fn}\r\n--${boundary}\r\nContent-Disposition: form-data; name="mime_type"\r\n\r\n${result.mimeType}\r\n--${boundary}\r\nContent-Disposition: form-data; name="user"\r\n\r\n${userId || "api"}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fn}"\r\nContent-Type: ${result.mimeType}\r\n\r\n`);
              const footerBuf = Buffer.from(`\r\n--${boundary}--\r\n`);
              const pbRes = await fetch(`${PB_URL}/api/collections/generated_files/records`, { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, Authorization: pbToken }, body: Buffer.concat([headerBuf, result.file, footerBuf]) });
              if (pbRes.ok) { const rec = await pbRes.json(); downloadUrl = `${PB_URL}/api/files/generated_files/${rec.id}/${rec.file}`; }
            }
          } catch {}
          results.push({ tool: toolName, filename: result.filename, mimeType: result.mimeType, size: result.file.length, downloadUrl, base64: !downloadUrl ? result.file.toString("base64") : undefined, duration: result.duration });
        } else if (result.ok && result.data) {
          results.push({ tool: toolName, data: result.data, duration: result.duration });
        }
      } catch (e) { log("warn", "XML tool exec failed", { tool: toolName, error: e.message }); }
    }
  }

  return results;
}

// Retry a failed proxy request with a different API key using fetch
async function retryWithFetch(req, res, providerName, keyInfo, excludeIds = new Set()) {
  const provider = PROVIDERS[providerName];
  let subpath = req.path.replace(new RegExp(`^/v1/${providerName}`, "i"), "");
  if (providerName === "gemini") subpath = subpath.replace(/^\/v1\//, "/v1beta/openai/");
  else if (providerName === "doubao") subpath = subpath.replace(/^\/v1\//, "/");
  const url = provider.baseUrl + subpath;

  const headers = { "Content-Type": "application/json" };
  if (providerName === "anthropic") {
    headers["x-api-key"] = keyInfo.apiKey;
    headers["anthropic-version"] = req.headers["anthropic-version"] || "2023-06-01";
    delete headers["authorization"];
  } else {
    headers["authorization"] = `Bearer ${keyInfo.apiKey}`;
  }
  if (req.traceId) headers["x-request-id"] = req.traceId;

  let body = req.body;
  if (body?.stream === true && providerName !== "anthropic") {
    body = { ...body, stream_options: { ...(body.stream_options || {}), include_usage: true } };
  }

  let upstream;
  try {
    upstream = await fetch(url, { method: req.method, headers, body: JSON.stringify(body) });
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: "Upstream connection error", message: e.message });
    return;
  }

  // Chain retry if another key is available
  if ((upstream.status === 429 || upstream.status === 401) && keyInfo.keyId) {
    markKeyCooling(keyInfo.keyId, upstream.status);
    const nextExclude = new Set([...excludeIds, keyInfo.keyId]);
    const nextKey = selectApiKey(providerName, req._proxyProjectName, nextExclude);
    if (nextKey) {
      await retryWithFetch(req, res, providerName, nextKey, nextExclude);
      return;
    }
  }

  // Forward response headers + body
  if (res.headersSent) return;
  const resHeaders = {};
  upstream.headers.forEach((v, k) => { if (k.toLowerCase() !== "transfer-encoding") resHeaders[k] = v; });
  res.writeHead(upstream.status, resHeaders);

  if (upstream.body) {
    const projectName = req._proxyProjectName;
    const modelId = req.body?.model || "unknown";
    const isStreaming = req.body?.stream === true;
    let tail = "";
    let _streamContentBuf = ""; // accumulate AI text content for tool tag detection
    try {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        const str = chunk.toString();
        tail = (tail + str).slice(-8192);
        // Extract content deltas for tool tag detection (SSE streaming)
        if (isStreaming) {
          for (const line of str.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const d = line.slice(6).trim();
            if (d === "[DONE]") continue;
            try { const j = JSON.parse(d); const c = j.choices?.[0]?.delta?.content; if (c) _streamContentBuf += c; } catch {}
          }
        }
        res.write(chunk);
      }
    } catch (_) {}

    // Execute text-based tool calls server-side before closing the response
    const contentToScan = isStreaming ? _streamContentBuf : tail;
    const toolResults = await executeTextToolCalls(contentToScan, req._lcUserId || req._proxyProjectName || "api");
    if (toolResults.length > 0 && isStreaming) {
      for (const tr of toolResults) {
        res.write(`event: tool_result\ndata: ${JSON.stringify(tr)}\n\n`);
      }
    }
    res.end();
    // Track usage
    try {
      let tokens;
      if (isStreaming) {
        tokens = extractTokensFromSSE(providerName, tail);
        if (!tokens) tokens = { input: Math.ceil(JSON.stringify(req.body?.messages || "").length / 4), cacheHit: 0, output: 0 };
      } else {
        tokens = extractTokens(providerName, tail);
      }
      if (!req._proxyProject?.privacyMode) recordUsage(projectName, providerName, req._isSubscriptionKey ? `${modelId}:subscription` : modelId, tokens);
      if ((!req._isSubscriptionKey || req._proxyProject?.subscriptionCountsSpending) && (req._proxyProject?.maxBudgetUsd != null || req._proxyProject?.maxCostPerMin)) {
        const cost = calcRequestCost(providerName, modelId, tokens);
        if (req._proxyProject.maxBudgetUsd != null) { req._proxyProject.budgetUsedUsd = (req._proxyProject.budgetUsedUsd || 0) + cost; markProjectsDirty(); }
        if (req._proxyProject.maxCostPerMin) recordCostForRateLimit(req._proxyProjectName, cost);
      }
    } catch (_) {}
  } else {
    res.end();
  }
}

const proxyMiddleware = createProxyMiddleware({
  router: (req) => {
    const provider = req.params?.provider?.toLowerCase();
    return PROVIDERS[provider]?.baseUrl;
  },
  changeOrigin: true,
  ws: false,
  timeout: 300000,
  proxyTimeout: 300000,
  selfHandleResponse: true,
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
      // Strip browser-origin headers — upstream APIs reject direct-browser CORS requests
      proxyReq.removeHeader("origin");
      proxyReq.removeHeader("referer");
      // Prevent upstream from sending compressed responses — we parse SSE chunks as text
      proxyReq.removeHeader("accept-encoding");
      // Set X-Request-ID BEFORE write() — setHeader() throws after body write flushes headers
      if (req.traceId) proxyReq.setHeader("X-Request-ID", req.traceId);
      if (req.body && ["POST", "PUT", "PATCH"].includes(req.method)) {
        // Inject stream_options for accurate SSE usage tracking (OpenAI-compatible providers)
        const provName = req.params?.provider?.toLowerCase();
        if (req.body.stream === true && provName !== "anthropic") {
          req.body.stream_options = { ...(req.body.stream_options || {}), include_usage: true };
        }
        const bodyData = JSON.stringify(req.body);
        proxyReq.setHeader("Content-Type", "application/json");
        proxyReq.setHeader("Content-Length", Buffer.byteLength(bodyData));
        proxyReq.write(bodyData);
      }
    },
    proxyRes: (proxyRes, req, res) => {
      const providerName = req.params?.provider?.toLowerCase();
      const projectName = req._proxyProjectName;
      const modelId = req.body?.model || "unknown";
      const isStreaming = req.body?.stream === true;
      const statusCode = proxyRes.statusCode;
      const currentKeyId = req._selectedKeyId;

      // Key failover on 429/401 — try next available key
      if ((statusCode === 429 || statusCode === 401) && currentKeyId) {
        markKeyCooling(currentKeyId, statusCode);
        const nextKey = selectApiKey(providerName, projectName, new Set([currentKeyId]));
        if (nextKey) {
          proxyRes.resume(); // drain + discard upstream error body
          req._selectedKeyId = nextKey.keyId;
          retryWithFetch(req, res, providerName, nextKey, new Set([currentKeyId])).catch(err => {
            log("error", "retryWithFetch unhandled error", { error: err.message, traceId: req.traceId });
            if (!res.headersSent) res.status(502).json({ error: "Upstream retry failed" });
          });
          return;
        }
      }

      // Normal path: forward headers + pipe body + track usage
      Object.entries(proxyRes.headers).forEach(([k, v]) => {
        if (k.toLowerCase() !== "transfer-encoding") res.setHeader(k, v);
      });
      res.statusCode = statusCode;

      // For providers that embed <think>...</think> in delta.content (e.g. MiniMax),
      // strip the reasoning block so clients receive clean content only.
      const THINK_STRIP_PROVIDERS = new Set(["minimax"]);
      const needsThinkStrip = THINK_STRIP_PROVIDERS.has(providerName);
      const thinkState = (needsThinkStrip && isStreaming)
        ? { lineBuf: "", inThink: false, thinkBuf: "" }
        : null;
      // For non-streaming: buffer full body, strip think tags on end
      let nonStreamThinkBuf = (needsThinkStrip && !isStreaming) ? "" : null;

      function stripThinkFromSSEChunk(raw) {
        thinkState.lineBuf += raw;
        const lines = thinkState.lineBuf.split("\n");
        thinkState.lineBuf = lines.pop(); // keep incomplete line
        let out = "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) { out += line + "\n"; continue; }
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") { out += line + "\n"; continue; }
          try {
            const j = JSON.parse(payload);
            const delta = j.choices?.[0]?.delta;
            if (delta && typeof delta.content === "string") {
              let content = delta.content;
              // Handle think tags that may span multiple chunks
              if (thinkState.inThink) {
                const end = content.indexOf("</think>");
                if (end !== -1) {
                  thinkState.inThink = false;
                  content = content.slice(end + 8); // skip past </think>
                } else {
                  content = ""; // still inside think block
                }
              }
              if (!thinkState.inThink) {
                const start = content.indexOf("<think>");
                if (start !== -1) {
                  const end = content.indexOf("</think>", start);
                  if (end !== -1) {
                    // Complete think block in this chunk
                    content = content.slice(0, start) + content.slice(end + 8);
                  } else {
                    // Think block starts but doesn't end in this chunk
                    thinkState.inThink = true;
                    content = content.slice(0, start);
                  }
                }
              }
              delta.content = content;
            }
            out += "data: " + JSON.stringify(j) + "\n";
          } catch {
            out += line + "\n"; // pass through unparseable lines
          }
        }
        return out;
      }

      let tail = "";
      let _streamContentBuf = ""; // accumulate full AI text content for tool tag detection
      // Use StringDecoder to safely handle multi-byte UTF-8 chars split across chunk boundaries
      // (critical for Chinese text from Doubao/Qwen/Kimi)
      const utf8Decoder = new StringDecoder("utf8");
      proxyRes.on("data", (chunk) => {
        const str = utf8Decoder.write(chunk);
        tail = (tail + str).slice(-8192);
        // Extract content deltas for tool tag detection (SSE streaming)
        if (isStreaming) {
          for (const line of str.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const d = line.slice(6).trim();
            if (d === "[DONE]") continue;
            try { const j = JSON.parse(d); const c = j.choices?.[0]?.delta?.content; if (c) _streamContentBuf += c; } catch {}
          }
        }
        if (thinkState) {
          const filtered = stripThinkFromSSEChunk(str);
          if (filtered) res.write(filtered);
        } else if (nonStreamThinkBuf !== null) {
          nonStreamThinkBuf += str;
        } else {
          res.write(chunk);
        }
      });
      proxyRes.on("end", () => {
        // Execute text-based tool calls [TOOL:name]{params}[/TOOL] server-side
        const contentToScan = isStreaming ? _streamContentBuf : (nonStreamThinkBuf || "");
        const hasToolTags = /\[TOOL:\w+\]/.test(contentToScan) || /<(?:｜DSML｜|︱DSML︱|\|DSML\|)function_calls>/.test(contentToScan) || /<(?:minimax:)?tool_call>/.test(contentToScan);
        if (hasToolTags) log("info", "Tool tags detected in response", { provider: providerName, contentLen: contentToScan.length });

        // Run async tool execution in a self-contained promise
        const toolExecPromise = hasToolTags
          ? executeTextToolCalls(contentToScan, req._lcUserId || req._proxyProjectName || "api")
              .catch(e => { log("error", "Tool execution failed", { error: e.message }); return []; })
          : Promise.resolve([]);

        toolExecPromise.then(async (toolResults) => {

        if (nonStreamThinkBuf !== null) {
          try {
            const j = JSON.parse(nonStreamThinkBuf);
            for (const choice of (j.choices || [])) {
              if (choice.message && typeof choice.message.content === "string") {
                choice.message.content = choice.message.content.replace(/<think>[\s\S]*?<\/think>\n*/g, "").trimStart();
              }
            }
            res.end(JSON.stringify(j));
          } catch {
            res.end(nonStreamThinkBuf);
          }
        } else if (toolResults.length > 0 && isStreaming && !res.writableEnded) {
          // Send tool results as SSE events (file downloads etc.)
          for (const tr of toolResults) {
            try { res.write(`event: tool_result\ndata: ${JSON.stringify(tr)}\n\n`); } catch {}
          }
          log("info", "Tool results sent to client", { count: toolResults.length });

          // Second-round AI call: let the AI summarize tool results
          try {
            const originalMessages = req.body?.messages || [];
            const toolSummaries = toolResults.map(tr => {
              if (tr.filename) return `[File generated: ${tr.filename} (${tr.size} bytes)]`;
              if (tr.html) return tr.html.replace(/<[^>]*>/g, '').slice(0, 500);
              if (tr.data?.results) return tr.data.results.slice(0, 5).map(r => `${r.title}: ${r.content || ''}`).join('\n');
              return JSON.stringify(tr.data || {}).slice(0, 300);
            }).join('\n\n');

            // Build follow-up messages: original + assistant tool call + tool results
            const cleanAssistantText = contentToScan.replace(/\[TOOL:\w+\][\s\S]*?\[\/TOOL\]/g, '').replace(/<[^<]*?DSML[^>]*>[\s\S]*/g, '').replace(/<(?:minimax:)?tool_call>[\s\S]*/g, '').trim();
            const followUpMessages = [
              ...originalMessages,
              { role: "assistant", content: cleanAssistantText || "I executed the tools." },
              { role: "user", content: `Tool execution results:\n${toolSummaries}\n\nPlease summarize the results for the user in a helpful way. If files were generated, briefly describe what's in them. If search results were returned, summarize the key findings. Respond naturally in the same language as the user's original question.` }
            ];

            const provider = PROVIDERS[providerName];
            const apiKey = req._proxyApiKey || (provider?.apiKey);
            if (apiKey && provider?.baseUrl) {
              const followUpUrl = providerName === "anthropic"
                ? `${provider.baseUrl}/v1/messages`
                : `${provider.baseUrl}/v1/chat/completions`;

              const followUpBody = providerName === "anthropic"
                ? { model: modelId, max_tokens: 1024, stream: true, system: "Summarize tool results concisely.", messages: followUpMessages.filter(m => m.role !== "system").map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })) }
                : { model: modelId, max_tokens: 1024, stream: true, messages: followUpMessages };

              const headers = providerName === "anthropic"
                ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
                : { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };

              const followUpRes = await fetch(followUpUrl, { method: "POST", headers, body: JSON.stringify(followUpBody), signal: AbortSignal.timeout(60000) });

              if (followUpRes.ok && followUpRes.body) {
                const reader = followUpRes.body.getReader();
                const decoder = new TextDecoder();
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  const chunk = decoder.decode(value, { stream: true });
                  if (!res.writableEnded) res.write(chunk);
                }
              }
            }
          } catch (e) {
            log("warn", "Follow-up AI call failed", { error: e.message });
          }
          try { if (!res.writableEnded) res.end(); } catch {}
        } else {
          try { if (!res.writableEnded) res.end(); } catch {}
        }
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
          sli.proxy.total++; sli.proxy.success++;
          if (!req._proxyProject?.privacyMode) recordUsage(projectName, providerName, req._isSubscriptionKey ? `${modelId}:subscription` : modelId, tokens);
          // Phase 1a: Track budget spend (skip for subscription keys — cost not real)
          if (req._proxyProject && (!req._isSubscriptionKey || req._proxyProject?.subscriptionCountsSpending) && (req._proxyProject?.maxBudgetUsd != null || req._proxyProject?.maxCostPerMin)) {
            const cost = calcRequestCost(providerName, modelId, tokens);
            if (req._proxyProject?.maxBudgetUsd != null) {
              req._proxyProject.budgetUsedUsd = (req._proxyProject.budgetUsedUsd || 0) + cost;
              markProjectsDirty();
            }
            if (req._proxyProject.maxCostPerMin) {
              recordCostForRateLimit(req._proxyProjectName, cost);
            }
          }
        } catch (e) {
          log("error", "Usage tracking error", { error: e.message, traceId: req.traceId });
        }
        }); // end toolExecPromise.then
      }); // end proxyRes.on("end")
    },
    error: (err, req, res) => {
      const providerName = req.params?.provider?.toLowerCase() || "unknown";
      log("error", "Proxy error", { provider: providerName, error: err.message, traceId: req.traceId });
      sli.proxy.upstreamError++;
      if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") sli.proxy.timeout++;
      if (!res.headersSent) res.status(502).json({ error: "Proxy error" });
    },
  },
});

// Token exchange endpoint — App uses project key (or HMAC) to get short-lived token
app.post("/v1/token", apiLimiter, (req, res) => {
  const projectKey = req.headers["x-project-key"] || (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const proj = ((k) => { const _p = projectKeyIndex.get(k); return _p && _p.enabled ? _p : undefined; })(projectKey);
  // Critical: HMAC projects must not accept direct key for token exchange —
  // the whole point of HMAC is that the raw key never leaves the client.
  if (proj && proj.authMode === "hmac") {
    return res.status(403).json({ error: "This project requires HMAC signature authentication. Use HMAC headers instead of a direct key to exchange a token." });
  }
  // Also allow HMAC auth for token exchange
  let hmacProj = null;
  if (!proj && req.headers["x-signature"]) {
    const projId = req.headers["x-project-id"];
    if (projId) {
      // Fast path: look up by X-Project-Id (sent by all HMAC clients)
      const candidate = projects.find(p => p.enabled && p.name === projId && p.authMode === "hmac");
      if (candidate && verifyHmacSignature(candidate, req).ok) hmacProj = candidate;
    } else {
      // Fallback: try all HMAC projects (no X-Project-Id sent)
      hmacProj = projects.find(p => p.enabled && p.authMode === "hmac" && verifyHmacSignature(p, req).ok);
    }
  }
  const resolvedProj = proj || hmacProj;
  if (!resolvedProj) return res.status(401).json({ error: "Invalid project key or signature" });

  // Per-project token issuance rate limit — prevents multi-token bypass attack:
  // without this, one pk_ can issue N tokens × maxRpmPerToken RPM = effectively bypass per-token limit.
  { const limit = resolvedProj.tokenIssuanceRpm || TOKEN_ISSUE_RPM_DEFAULT;
    const now = Date.now();
    let tb = projectTokenIssueBuckets.get(resolvedProj.name);
    if (!tb || now >= tb.resetAt) { tb = { count: 0, resetAt: now + 60000 }; projectTokenIssueBuckets.set(resolvedProj.name, tb); }
    tb.count++;
    if (tb.count > limit) return res.status(429).json({ error: "Token issuance rate limit exceeded. Try again in a minute." });
  }

  // Count existing tokens for this project
  let count = 0;
  for (const info of ephemeralTokens.values()) { if (info.projectName === resolvedProj.name) count++; }
  if (count >= MAX_EPHEMERAL_PER_PROJECT) return res.status(429).json({ error: "Too many active tokens" });
  const ttl = (resolvedProj.tokenTtlMinutes || 60) * 60 * 1000;
  const token = "et_" + crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + ttl;
  const userId = req.body?.userId || null;
  const noLog = !!resolvedProj.privacyMode;
  ephemeralTokens.set(token, { projectName: resolvedProj.name, project: resolvedProj, userId, expiresAt, noLog });
  if (!noLog) markTokensDirty();
  if (!noLog) audit(null, "token_issued", resolvedProj.name, { userId, ttlMin: Math.round(ttl / 60000) });
  res.json({ token, expiresAt: new Date(expiresAt).toISOString(), expiresIn: Math.round(ttl / 1000) });
});

// ── OTP: Email Verification ──────────────────────────────────────────────────
const otpStore = new Map(); // lowerEmail → { code, expiresAt, attempts }
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;

setInterval(() => {
  const now = Date.now();
  for (const [email, info] of otpStore) {
    if (now > info.expiresAt) otpStore.delete(email);
  }
}, 5 * 60 * 1000);

function generateOTP() {
  return crypto.randomInt(100000, 1000000).toString();
}

function otpEmailHtml(code) {
  const digits = code.split('');
  const digitBoxes = digits.map(d =>
    `<span style="display:inline-block;width:48px;height:60px;line-height:60px;text-align:center;font-size:32px;font-weight:800;color:#C4805A;background:#FDF7F3;border:2px solid #EDD5C0;border-radius:12px;margin:0 4px;font-family:'SF Mono',Monaco,Menlo,Consolas,monospace;">${d}</span>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>FurNote Verification Code</title>
</head>
<body style="margin:0;padding:0;background:#F5F0EB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F0EB;padding:48px 20px;">
  <tr><td align="center">
  <table width="520" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;border-radius:20px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.10);">

    <!-- Header -->
    <tr><td style="background:linear-gradient(135deg,#D4956A 0%,#B8714E 100%);padding:48px 40px 40px;text-align:center;">
      <div style="font-size:56px;line-height:1;margin-bottom:16px;">🐾</div>
      <div style="color:#fff;font-size:30px;font-weight:800;letter-spacing:-0.5px;margin-bottom:6px;">FurNote</div>
      <div style="display:inline-block;background:rgba(255,255,255,0.18);color:rgba(255,255,255,0.92);font-size:11px;font-weight:600;letter-spacing:4px;padding:5px 14px;border-radius:20px;">毛孩笔记 · PET CARE AI</div>
    </td></tr>

    <!-- Body -->
    <tr><td style="background:#ffffff;padding:48px 40px 36px;">

      <!-- Chinese -->
      <p style="margin:0 0 6px;font-size:24px;font-weight:700;color:#1a1a1a;">你好 👋</p>
      <p style="margin:0 0 6px;font-size:15px;color:#555;line-height:1.75;">感谢注册 FurNote。请在 App 中输入下方验证码完成注册。</p>
      <p style="margin:0 0 32px;font-size:15px;color:#555;line-height:1.75;">验证码 <strong style="color:#C4805A;">10 分钟</strong>内有效，仅限使用一次。</p>

      <!-- Code box -->
      <div style="background:#FDF7F3;border:2px solid #EDD5C0;border-radius:16px;padding:32px 24px;text-align:center;margin-bottom:36px;">
        <div style="font-size:11px;color:#C4A882;letter-spacing:4px;font-weight:700;margin-bottom:20px;text-transform:uppercase;">Verification Code · 验证码</div>
        <div style="white-space:nowrap;">${digitBoxes}</div>
        <div style="margin-top:20px;font-size:12px;color:#C4A882;">⏱&nbsp; Valid for 10 minutes &nbsp;·&nbsp; One-time use only</div>
      </div>

      <!-- Divider -->
      <div style="border-top:1px solid #F0EBE5;margin-bottom:28px;"></div>

      <!-- English -->
      <p style="margin:0 0 6px;font-size:15px;font-weight:600;color:#1a1a1a;">Hi there 👋</p>
      <p style="margin:0 0 28px;font-size:14px;color:#888;line-height:1.75;">Thank you for signing up for FurNote. Enter the code above in the app to complete your registration. This code expires in <strong style="color:#C4805A;">10 minutes</strong> and can only be used once.</p>

      <!-- Security note -->
      <div style="background:#F9F6F3;border-left:3px solid #EDD5C0;border-radius:0 10px 10px 0;padding:14px 18px;">
        <p style="margin:0;font-size:13px;color:#aaa;line-height:1.65;">
          🔒 如果这不是你的操作，请忽略此邮件，你的账号仍然安全。<br>
          <span style="color:#c8c8c8;">If you didn't request this, you can safely ignore this email.</span>
        </p>
      </div>

    </td></tr>

    <!-- Footer -->
    <tr><td style="background:#F0EBE5;padding:24px 40px;text-align:center;border-top:1px solid #E8DDD6;">
      <p style="margin:0 0 6px;font-size:13px;color:#C4A882;font-weight:600;">FurNote · 为每一只毛孩子而生</p>
      <p style="margin:0;font-size:11px;color:#ccc;">© ${new Date().getFullYear()} FurNote &nbsp;·&nbsp; Made with 🧡 for your pets</p>
    </td></tr>

  </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendOtpEmail(toEmail, code) {
  const smtpHost = process.env.SMTP_HOST || (settings.smtp || {}).host;
  const smtpPort = parseInt(process.env.SMTP_PORT || (settings.smtp || {}).port || "587");
  const smtpUser = process.env.SMTP_USER || (settings.smtp || {}).user;
  const smtpPass = process.env.SMTP_PASS || (settings.smtp || {}).pass;
  const smtpFrom = process.env.SMTP_FROM || (settings.smtp || {}).from || `FurNote <${smtpUser}>`;
  const smtpSecure = process.env.SMTP_SECURE === "true" || (settings.smtp || {}).secure || false;

  if (!smtpHost || !smtpUser || !smtpPass) {
    log("warn", "[OTP] SMTP not configured — logging code instead", { toEmail, code });
    return; // dev fallback: code visible in server logs
  }

  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    auth: { user: smtpUser, pass: smtpPass },
  });
  await transporter.sendMail({
    from: smtpFrom,
    to: toEmail,
    subject: `【FurNote】验证码 ${code} · Verification Code`,
    html: otpEmailHtml(code),
  });
  log("info", "[OTP] Email sent", { toEmail });
}

// Send admin notification email (upgrade requests, etc.)
async function sendAdminNotify(subject, htmlBody) {
  if (!settings.smtpEnabled || !settings.smtpHost || !settings.smtpUser || !settings.smtpPass || !settings.smtpTo) {
    log("warn", "[notify] SMTP not configured, skipping email", { subject });
    return;
  }
  try {
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host: settings.smtpHost, port: settings.smtpPort || 587,
      secure: (settings.smtpPort || 587) === 465,
      auth: { user: settings.smtpUser, pass: decryptValue(settings.smtpPass, ADMIN_SECRET) },
    });
    await transporter.sendMail({
      from: settings.smtpFrom || settings.smtpUser,
      to: settings.smtpTo,
      subject, html: htmlBody,
    });
    log("info", "[notify] Email sent", { to: settings.smtpTo, subject });
  } catch (e) { log("error", "[notify] Email failed", { error: e.message }); }
}

function resolveOtpAuth(req) {
  const bearer = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  if (bearer.startsWith("et_")) {
    const info = ephemeralTokens.get(bearer);
    if (info && Date.now() <= info.expiresAt && info.project?.enabled) return info.project;
  }
  if (req.headers["x-signature"]) {
    const projId = req.headers["x-project-id"];
    if (projId) {
      const candidate = projects.find(p => p.enabled && p.name === projId && p.authMode === "hmac");
      if (candidate && verifyHmacSignature(candidate, req).ok) return candidate;
    }
  }
  return null;
}

app.post("/v1/otp/send", apiLimiter, async (req, res) => {
  if (!resolveOtpAuth(req)) return res.status(401).json({ error: "Unauthorized" });
  const { email } = req.body || {};
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ error: "Invalid email" });
  }
  const lowerEmail = email.toLowerCase().trim();
  const code = generateOTP();
  otpStore.set(lowerEmail, { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });
  try {
    await sendOtpEmail(lowerEmail, code);
  } catch (err) {
    log("error", "[OTP] Email send failed", { err: err.message, toEmail: lowerEmail });
    return res.status(500).json({ error: "Failed to send verification email" });
  }
  audit(null, "otp_sent", null, { email: lowerEmail });
  res.json({ ok: true });
});

app.post("/v1/otp/verify", apiLimiter, async (req, res) => {
  if (!resolveOtpAuth(req)) return res.status(401).json({ error: "Unauthorized" });
  const { email, code } = req.body || {};
  if (!email || !code) return res.status(400).json({ error: "Missing email or code" });
  const lowerEmail = email.toLowerCase().trim();
  const stored = otpStore.get(lowerEmail);
  if (!stored) return res.status(400).json({ error: "No OTP found — request a new one" });
  if (Date.now() > stored.expiresAt) {
    otpStore.delete(lowerEmail);
    return res.status(400).json({ error: "OTP expired" });
  }
  stored.attempts += 1;
  if (stored.attempts > OTP_MAX_ATTEMPTS) {
    otpStore.delete(lowerEmail);
    return res.status(400).json({ error: "Too many attempts — request a new code" });
  }
  if (!safeEqual(stored.code, code.toString().trim())) {
    return res.status(400).json({ error: "Invalid code" });
  }
  otpStore.delete(lowerEmail);
  audit(null, "otp_verified", null, { email: lowerEmail });
  res.json({ ok: true });
});

// ── End OTP ──────────────────────────────────────────────────────────────────

// ── LumiChat (lc) routes ──────────────────────────────────────────────────────

// Helper: forward request to PocketBase with optional auth
async function pbFetch(path, options = {}) {
  const url = `${PB_URL}${path}`;
  return fetch(url, options);
}

const PB_LC_PROJECT = (process.env.PB_LC_PROJECT || "lumichat").trim() || "lumichat";
const FILE_PARSER_URL = process.env.FILE_PARSER_URL || "http://lumigate-file-parser:3100";
const GOTENBERG_URL = process.env.GOTENBERG_URL || "http://lumigate-gotenberg:3000";

function toLcProjectPath(path) {
  const p = String(path || "");
  if (p.startsWith(`/api/p/${PB_LC_PROJECT}/`)) return p;
  if (p.startsWith("/api/collections/")) return `/api/p/${PB_LC_PROJECT}${p.slice("/api".length)}`;
  if (p.startsWith("/api/files/")) return `/api/p/${PB_LC_PROJECT}${p.slice("/api".length)}`;
  return p;
}

async function lcPbFetch(path, options = {}) {
  const p = String(path || "");
  const target = toLcProjectPath(p);
  const noFallback = !!options.lcNoFallback;
  const fetchOptions = { ...options };
  delete fetchOptions.lcNoFallback;

  if (target === p) return pbFetch(p, fetchOptions);
  try {
    const scoped = await pbFetch(target, fetchOptions);
    if (scoped.ok || noFallback) return scoped;
  } catch (err) {
    if (noFallback) throw err;
  }
  return pbFetch(p, fetchOptions);
}

const LC_UPLOAD_MIME_BY_EXT = {
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".html": "text/html",
  ".htm": "text/html",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

function lcUploadSafeName(name) {
  return String(name || "file").replace(/["\r\n\0]/g, "_").slice(0, 255);
}

function detectLcUploadMime(filename, fallbackMime) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  const known = LC_UPLOAD_MIME_BY_EXT[ext];
  const fb = String(fallbackMime || "").trim().toLowerCase();
  if (known) {
    if (!fb || fb === "application/octet-stream") return known;
    return fb;
  }
  return fb || "application/octet-stream";
}

function isLcExtractableFile(filename, mimeType) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  const mime = String(mimeType || "").toLowerCase();
  return (
    mime === "application/pdf" ||
    mime.includes("spreadsheetml") ||
    mime.includes("ms-excel") ||
    mime === "text/csv" ||
    mime.includes("wordprocessingml") ||
    mime === "application/msword" ||
    mime.includes("presentationml") ||
    ext === ".pptx" ||
    mime === "text/html" ||
    mime === "text/plain" ||
    mime === "text/markdown"
  );
}

function isLcSpreadsheetFile(filename, mimeType) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  const mime = String(mimeType || "").toLowerCase();
  return (
    mime.includes("spreadsheetml") ||
    mime.includes("ms-excel") ||
    ext === ".xlsx" ||
    ext === ".xls"
  );
}

async function lcSendBufferToFileParser(buffer, filename) {
  const boundary = "----LumiLcParse" + crypto.randomBytes(8).toString("hex");
  const safeName = lcUploadSafeName(filename);
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, buffer, footer]);
  const res = await fetch(`${FILE_PARSER_URL}/parse`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(60000),
  });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, text: "", error: parsed?.error || `file_parser_http_${res.status}` };
  }
  if (!parsed?.ok || typeof parsed.text !== "string") {
    return { ok: false, text: "", error: parsed?.error || "file_parser_invalid_response" };
  }
  return { ok: true, text: parsed.text, error: "" };
}

async function lcConvertToPdfViaGotenberg(buffer, filename) {
  const boundary = "----LumiLcGoten" + crypto.randomBytes(8).toString("hex");
  const safeName = lcUploadSafeName(filename);
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, buffer, footer]);
  const res = await fetch(`${GOTENBERG_URL}/forms/libreoffice/convert`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

function stripHtmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clampExtractedTextForPb(text) {
  const s = String(text || "").trim();
  const MAX = 5000;
  if (s.length <= MAX) return s;
  const suffix = "\n\n[Truncated for lc_files.extracted_text]";
  return s.slice(0, MAX - suffix.length).trimEnd() + suffix;
}

function lcNormalizeExtractedText(text) {
  return String(text || "")
    .replace(/^⚠️[^\n]*\n+/u, "")
    .trim();
}

function lcCleanSpreadsheetExtractedText(text) {
  const normalized = lcNormalizeExtractedText(text);
  if (!normalized) return "";
  const lines = normalized.split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const base = String(raw || "")
      .replace(/[￿�]{3,}/g, " ")
      .replace(/[^\x20-\x7E\u4e00-\u9fff]/g, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
    const line = base;
    if (!line) continue;
    const signal = (line.match(/[A-Za-z0-9\u4e00-\u9fff]/g) || []).length;
    if (signal === 0 || signal < 3) continue;
    const words = line.match(/[A-Za-z]{2,}|\d{2,}|[\u4e00-\u9fff]{2,}/g) || [];
    const hasUsefulToken = words.length > 0;
    const singleTokens = line.match(/\b[A-Za-z]\b/g) || [];
    if (!hasUsefulToken && signal < 8) continue;
    if (singleTokens.length >= 8 && words.length <= 1) continue;
    const punctuationOnly = line.replace(/[A-Za-z0-9\u4e00-\u9fff ]/g, "");
    if (punctuationOnly.length > line.length * 0.45) continue;
    out.push(line);
    if (out.length >= 2000) break;
  }
  return out.join("\n").trim();
}

function lcExtractionQualityScore(text) {
  const s = lcCleanSpreadsheetExtractedText(text) || lcNormalizeExtractedText(text);
  if (!s) return -1e9;
  const len = s.length;
  const badCount = (s.match(/[�￿]/g) || []).length;
  const asciiWordCount = (s.match(/[A-Za-z]{2,}/g) || []).length;
  const digitCount = (s.match(/[0-9]/g) || []).length;
  const cjkCount = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const printableCount = (s.match(/[ -~\n\r\t]/g) || []).length + cjkCount;
  const printableRatio = len ? (printableCount / len) : 0;
  return (
    Math.min(len, 12000) * 0.004 +
    asciiWordCount * 1.4 +
    digitCount * 0.2 +
    cjkCount * 0.12 +
    printableRatio * 25 -
    badCount * 2
  );
}

function lcLooksLikeLowQualityExtraction(text) {
  const s = lcCleanSpreadsheetExtractedText(text) || lcNormalizeExtractedText(text);
  if (!s) return true;
  const badCount = (s.match(/[�￿]/g) || []).length;
  if (badCount >= 40) return true;
  const asciiWordCount = (s.match(/[A-Za-z]{2,}/g) || []).length;
  const cjkCount = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const hasLanguageSignal = asciiWordCount >= 8 || cjkCount >= 20;
  return !hasLanguageSignal;
}

async function extractTextForLcUpload(tmpPath, originalName, mimeType) {
  if (!isLcExtractableFile(originalName, mimeType)) {
    return { text: "", status: "not_supported", error: "", parsedAt: null };
  }
  const ext = path.extname(String(originalName || "")).toLowerCase();
  const mime = String(mimeType || "").toLowerCase();
  const parsedAt = lcNowIso();
  try {
    if (mime === "text/plain" || mime === "text/markdown") {
      const text = clampExtractedTextForPb(fs.readFileSync(tmpPath, "utf8"));
      return { text, status: text ? "ok" : "empty", error: "", parsedAt };
    }
    if (mime === "text/html") {
      const text = clampExtractedTextForPb(stripHtmlToText(fs.readFileSync(tmpPath, "utf8")));
      return { text, status: text ? "ok" : "empty", error: "", parsedAt };
    }
    const buffer = fs.readFileSync(tmpPath);
    if (mime.includes("presentationml") || ext === ".pptx") {
      // Prefer direct PPTX parse; fallback to gotenberg->PDF only when needed.
      const direct = await lcSendBufferToFileParser(buffer, originalName);
      if (direct.ok) {
        const text = clampExtractedTextForPb(direct.text || "");
        return { text, status: text ? "ok" : "empty", error: "", parsedAt };
      }
      const pdfBuf = await lcConvertToPdfViaGotenberg(buffer, originalName);
      if (!pdfBuf) return { text: "", status: "error", error: `pptx_parse_failed:${direct.error || "unknown"}`, parsedAt };
      const fallback = await lcSendBufferToFileParser(pdfBuf, originalName.replace(/\.pptx$/i, ".pdf"));
      if (!fallback.ok) return { text: "", status: "error", error: `pptx_fallback_failed:${fallback.error || "unknown"}`, parsedAt };
      const text = clampExtractedTextForPb(fallback.text || "");
      return { text, status: text ? "ok" : "empty", error: "", parsedAt };
    }
    const parsed = await lcSendBufferToFileParser(buffer, originalName);
    if (isLcSpreadsheetFile(originalName, mimeType)) {
      const isLegacyXls = ext === ".xls" || mime.includes("ms-excel");
      const cleanedDirect = parsed.ok ? lcCleanSpreadsheetExtractedText(parsed.text || "") : "";
      let best = (parsed.ok && cleanedDirect)
        ? { ...parsed, text: cleanedDirect }
        : null;
      const directLowQuality = !best || lcLooksLikeLowQualityExtraction(best.text || "");
      const shouldTryFallbackFirst = isLegacyXls;
      if (shouldTryFallbackFirst || !parsed.ok || directLowQuality) {
        // Fallback for legacy/complex Excel files: convert to PDF then parse.
        const pdfBuf = await lcConvertToPdfViaGotenberg(buffer, originalName);
        if (pdfBuf) {
          const fallback = await lcSendBufferToFileParser(pdfBuf, originalName.replace(/\.(xlsx|xls)$/i, ".pdf"));
          if (fallback.ok) {
            const cleanedFallback = lcCleanSpreadsheetExtractedText(fallback.text || "");
            const fallbackCandidate = cleanedFallback
              ? { ...fallback, text: cleanedFallback }
              : (!lcLooksLikeLowQualityExtraction(fallback.text || "") ? fallback : null);
            if (fallbackCandidate) {
              if (!best) {
                best = fallbackCandidate;
              } else if (shouldTryFallbackFirst) {
                best = fallbackCandidate;
              } else if (lcExtractionQualityScore(fallbackCandidate.text) > lcExtractionQualityScore(best.text) + 1) {
                best = fallbackCandidate;
              }
            }
          } else if (!best) {
            return { text: "", status: "error", error: `sheet_fallback_failed:${fallback.error || "unknown"}`, parsedAt };
          }
        } else if (!best) {
          return { text: "", status: "error", error: `sheet_convert_failed:${parsed.error || "unknown"}`, parsedAt };
        }
      }
      if (!best) return { text: "", status: "error", error: parsed.error || "parse_failed", parsedAt };
      const text = clampExtractedTextForPb(best.text || "");
      return { text, status: text ? "ok" : "empty", error: "", parsedAt };
    }
    if (!parsed.ok) return { text: "", status: "error", error: parsed.error || "parse_failed", parsedAt };
    const text = clampExtractedTextForPb(parsed.text || "");
    return { text, status: text ? "ok" : "empty", error: "", parsedAt };
  } catch (err) {
    log("warn", "lc upload extract failed", { file: originalName, error: err.message });
    return { text: "", status: "error", error: String(err.message || "extract_failed").slice(0, 500), parsedAt };
  }
}

const LC_SCHEMA_AUTO_PATCH = !/^(0|false|no)$/i.test(String(process.env.LC_SCHEMA_AUTO_PATCH || "1"));
const lcDynamicFields = {
  sessions: new Set(),
  messages: new Set(),
  files: new Set(),
};

const LC_REQUIRED_FIELDS = {
  sessions: [
    { name: "created_at", type: "text", max: 0 },
    { name: "updated_at", type: "text", max: 0 },
  ],
  messages: [
    { name: "created_at", type: "text", max: 0 },
    { name: "updated_at", type: "text", max: 0 },
  ],
  files: [
    { name: "original_name", type: "text", max: 0 },
    { name: "ext", type: "text", max: 32 },
    { name: "kind", type: "text", max: 32 },
    { name: "parse_status", type: "text", max: 32 },
    { name: "parse_error", type: "text", max: 5000 },
    { name: "parsed_at", type: "text", max: 0 },
    { name: "created_at", type: "text", max: 0 },
    { name: "updated_at", type: "text", max: 0 },
  ],
};

const LC_BASE_FIELDS = {
  sessions: ["id", "user", "title", "provider", "model", "project"],
  messages: ["id", "session", "role", "content", "file_ids"],
  files: ["id", "session", "user", "file", "mime_type", "size_bytes", "extracted_text"],
};

function seedLcDynamicFieldsFallback() {
  for (const key of Object.keys(lcDynamicFields)) {
    const base = LC_BASE_FIELDS[key] || [];
    const required = (LC_REQUIRED_FIELDS[key] || []).map((f) => f.name);
    lcDynamicFields[key] = new Set([...base, ...required]);
  }
}

seedLcDynamicFieldsFallback();

function lcCollectionNameByKey(configKey) {
  const c = LC_COLLECTION_CONFIG[configKey];
  return c?.name || null;
}

function lcSupportsField(configKey, fieldName) {
  return lcDynamicFields[configKey]?.has(fieldName) || false;
}

function lcDefaultSort(configKey, fallback = ["id"]) {
  if (lcSupportsField(configKey, "created_at")) return ["-created_at", "-id"];
  return fallback;
}

function lcNowIso() {
  return new Date().toISOString();
}

function lcFileKindByMimeOrExt(mimeType, originalName) {
  const mime = String(mimeType || "").toLowerCase();
  const ext = path.extname(String(originalName || "")).toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf" || ext === ".pdf") return "pdf";
  if (mime.includes("spreadsheetml") || mime.includes("ms-excel") || [".xls", ".xlsx", ".csv"].includes(ext)) return "spreadsheet";
  if (mime.includes("wordprocessingml") || mime === "application/msword" || [".doc", ".docx"].includes(ext)) return "document";
  if (mime.includes("presentationml") || ext === ".pptx") return "presentation";
  if (mime === "text/plain" || mime === "text/markdown" || mime === "text/html" || [".txt", ".md", ".html", ".htm"].includes(ext)) return "text";
  return "binary";
}

function buildLcTextField(name, max = 0) {
  return {
    autogeneratePattern: "",
    hidden: false,
    id: `text_${name}_${crypto.randomBytes(4).toString("hex")}`,
    max,
    min: 0,
    name,
    pattern: "",
    presentable: false,
    primaryKey: false,
    required: false,
    system: false,
    type: "text",
  };
}

function buildLcFieldDef(def) {
  if (def.type === "text") return buildLcTextField(def.name, def.max || 0);
  return null;
}

async function ensureLcCollectionFields(configKey, token) {
  const collection = lcCollectionNameByKey(configKey);
  if (!collection) return;
  const q = encodeURIComponent(`name='${collection}'`);
  const listRes = await pbFetch(`/api/collections/_collections/records?filter=${q}&perPage=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) throw new Error(`_collections lookup failed for ${collection}: ${listRes.status}`);
  const listData = await listRes.json();
  const rec = listData.items?.[0];
  if (!rec?.id) throw new Error(`Collection not found: ${collection}`);

  const existing = Array.isArray(rec.fields) ? rec.fields : [];
  const existingNames = new Set(existing.map((f) => f?.name).filter(Boolean));
  const requiredDefs = LC_REQUIRED_FIELDS[configKey] || [];
  const missing = requiredDefs.filter((f) => !existingNames.has(f.name));
  if (missing.length) {
    const newFields = [...existing];
    for (const m of missing) {
      const fd = buildLcFieldDef(m);
      if (fd) newFields.push(fd);
    }
    const patchRes = await pbFetch(`/api/collections/_collections/records/${rec.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: newFields }),
    });
    if (!patchRes.ok) {
      const body = await patchRes.text().catch(() => "");
      throw new Error(`_collections patch failed for ${collection}: ${patchRes.status} ${body.slice(0, 240)}`);
    }
    log("info", "LC schema patched", { collection, added: missing.map((f) => f.name) });
    missing.forEach((f) => existingNames.add(f.name));
  }
  lcDynamicFields[configKey] = existingNames;
}

async function ensureLcSchemaExtensions() {
  if (!LC_SCHEMA_AUTO_PATCH) return;
  try {
    const token = await getPbAdminToken();
    if (!token) {
      log("warn", "LC schema auto-patch skipped (no PB admin token)");
      return;
    }
    for (const key of ["sessions", "messages", "files"]) {
      await ensureLcCollectionFields(key, token);
    }
  } catch (err) {
    // Keep required-field writes available when PB _collections APIs are disabled in custom builds.
    seedLcDynamicFieldsFallback();
    log("warn", "LC schema auto-patch failed", { error: err.message });
  }
}

const PB_DEFAULT_PAGE_SIZE = 100;
const PB_DEFAULT_PROJECT_COLOR = "#6366f1";
const PB_DEFAULT_LC_PROJECT_SORT = 0;
const REFERENCE_SCAN_LIMIT = 25;
const LC_SOFT_DELETE_ENV_DEFAULT = /^(1|true|yes)$/i.test(String(process.env.LC_SOFT_DELETE_ENABLED || ""));
const DELETE_POLICY = Object.freeze({
  SOFT: "soft",
  RESTRICT: "restrict",
  CASCADE: "cascade",
  REMAP: "remap",
});

const LC_COLLECTION_CONFIG = {
  userSettings: {
    name: "lc_user_settings",
    ownerField: "user",
    defaultPerPage: 1,
    filterableFields: ["user", "active_project", "theme", "compact", "default_provider", "default_model", "tier", "upgrade_request"],
    sortableFields: ["id", "user", "theme", "default_provider", "default_model", "tier"],
    writableFields: ["memory", "sensitivity", "presets", "theme", "compact", "active_project", "default_provider", "default_model"],
  },
  projects: {
    name: "lc_projects",
    ownerField: "user",
    defaultPerPage: 100,
    filterableFields: ["id", "user", "name", "color", "sort_order", "deleted_at", "deleted_by", "delete_reason"],
    sortableFields: ["id", "name", "color", "sort_order", "deleted_at"],
    writableFields: ["name", "color", "instructions", "memory", "sort_order", "deleted_at", "deleted_by", "delete_reason"],
  },
  sessions: {
    name: "lc_sessions",
    ownerField: "user",
    defaultPerPage: 100,
    filterableFields: ["id", "user", "title", "provider", "model", "project", "created_at", "updated_at", "deleted_at", "deleted_by", "delete_reason"],
    sortableFields: ["id", "title", "provider", "model", "project", "created_at", "updated_at", "deleted_at"],
    writableFields: ["title", "provider", "model", "project", "created_at", "updated_at", "deleted_at", "deleted_by", "delete_reason"],
  },
  messages: {
    name: "lc_messages",
    ownerField: null,
    defaultPerPage: 200,
    filterableFields: ["id", "session", "role", "created_at", "updated_at", "deleted_at", "deleted_by", "delete_reason"],
    sortableFields: ["id", "session", "role", "created_at", "updated_at", "deleted_at"],
    writableFields: ["session", "role", "content", "file_ids", "created_at", "updated_at", "deleted_at", "deleted_by", "delete_reason"],
  },
  files: {
    name: "lc_files",
    ownerField: "user",
    defaultPerPage: 100,
    filterableFields: ["id", "user", "session", "mime_type", "kind", "parse_status", "created_at", "updated_at", "parsed_at", "deleted_at", "deleted_by", "delete_reason"],
    sortableFields: ["id", "user", "session", "mime_type", "size_bytes", "created_at", "updated_at", "parsed_at", "deleted_at"],
    writableFields: ["session", "user", "mime_type", "size_bytes", "original_name", "ext", "kind", "parse_status", "parse_error", "parsed_at", "extracted_text", "created_at", "updated_at", "deleted_at", "deleted_by", "delete_reason"],
  },
};

const DOMAIN_COLLECTION_POLICIES = {
  lc: {
    projects: {
      deletePolicy: DELETE_POLICY.RESTRICT,
      references: [
        { collectionKey: "sessions", field: "project", label: "sessions", policy: DELETE_POLICY.RESTRICT },
      ],
    },
    sessions: {
      deletePolicy: DELETE_POLICY.CASCADE,
      references: [
        { collectionKey: "messages", field: "session", label: "messages", policy: DELETE_POLICY.CASCADE },
        { collectionKey: "files", field: "session", label: "files", policy: DELETE_POLICY.CASCADE },
      ],
    },
    messages: {
      deletePolicy: DELETE_POLICY.SOFT,
      references: [],
    },
    files: {
      deletePolicy: DELETE_POLICY.SOFT,
      references: [],
    },
  },
};

const DEFAULT_DOMAIN_API_REGISTRY = {
  lc: {
    label: "LumiChat",
    authAdapter: "lc",
    collections: {
      projects: "projects",
      sessions: "sessions",
      messages: "messages",
      files: "files",
      userSettings: "userSettings",
    },
  },
};

function getDomainApiRegistry() {
  const runtime = { ...DEFAULT_DOMAIN_API_REGISTRY };
  const settingsDomains = settings?.domainApiRegistry;
  if (settingsDomains && typeof settingsDomains === "object") {
    for (const [k, v] of Object.entries(settingsDomains)) {
      if (!k || !v || typeof v !== "object") continue;
      const key = String(k).toLowerCase();
      runtime[key] = {
        ...(runtime[key] || {}),
        ...v,
        collections: {
          ...((runtime[key] && runtime[key].collections) || {}),
          ...(v.collections || {}),
        },
      };
    }
  }
  return runtime;
}

function pbQuote(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function buildPbFilterClause(field, operator, value) {
  const op = operator || "=";
  if (value === null) return `${field}${op}null`;
  if (typeof value === "number" || typeof value === "boolean") return `${field}${op}${value}`;
  return `${field}${op}${pbQuote(value)}`;
}

const PB_FILTER_OPERATORS = {
  eq: "=",
  ne: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  contains: "~",
};

function buildPbQuery({
  collection,
  filters = [],
  sort = [],
  perPage = PB_DEFAULT_PAGE_SIZE,
  page,
  fields,
  expand,
}) {
  const params = new URLSearchParams();
  params.set("perPage", String(perPage || PB_DEFAULT_PAGE_SIZE));
  if (page) params.set("page", String(page));
  if (fields?.length) params.set("fields", fields.join(","));
  if (expand?.length) params.set("expand", expand.join(","));
  if (filters.length) params.set("filter", filters.join(" && "));
  if (sort.length) params.set("sort", sort.join(","));
  return `/api/collections/${collection}/records?${params.toString()}`;
}

function pickAllowedFields(input, allowedFields) {
  const out = {};
  for (const key of allowedFields || []) {
    if (input && key in input) out[key] = input[key];
  }
  return out;
}

function getLcCollectionConfig(key) {
  const config = LC_COLLECTION_CONFIG[key];
  if (!config) throw new Error(`Unknown LC collection config: ${key}`);
  return config;
}

function getDomainCollectionPolicy(domainKey, collectionKey) {
  return DOMAIN_COLLECTION_POLICIES[domainKey]?.[collectionKey] || { deletePolicy: DELETE_POLICY.SOFT, references: [] };
}

function getDomainApiSchema(domainKey) {
  const domain = getDomainApiRegistry()[domainKey];
  if (!domain) return null;
  const collections = Object.entries(domain.collections).map(([apiName, configKey]) => {
    const config = getLcCollectionConfig(configKey);
    const policy = getDomainCollectionPolicy(domainKey, apiName);
    return {
      apiName,
      collection: config.name,
      ownerField: config.ownerField || null,
      filterableFields: config.filterableFields || [],
      sortableFields: config.sortableFields || [],
      writableFields: config.writableFields || [],
      deletePolicy: policy.deletePolicy,
      references: (policy.references || []).map((ref) => ({
        collectionKey: ref.collectionKey,
        field: ref.field,
        policy: ref.policy || DELETE_POLICY.RESTRICT,
      })),
    };
  });
  return { domain: domainKey, label: domain.label, softDeleteEnabled: isLcSoftDeleteEnabled(), collections };
}

function isLcSoftDeleteEnabled() {
  if (settings && typeof settings.lcSoftDeleteEnabled === "boolean") return settings.lcSoftDeleteEnabled;
  return LC_SOFT_DELETE_ENV_DEFAULT;
}

function getAttachmentSearchMode() {
  const mode = String(settings?.attachmentSearchMode || "assistant_decide").toLowerCase();
  return ["smart", "always", "off", "assistant_decide"].includes(mode) ? mode : "assistant_decide";
}

function buildPbFiltersFromQuery(configKey, query = {}) {
  const config = getLcCollectionConfig(configKey);
  const filters = [];
  const normalizedQuery = query || {};

  // New query contract:
  // - filter[field][op]=value  (Excel-like per-column operators)
  // Legacy still supported:
  // - field__op=value
  for (const [rawKey, rawValue] of Object.entries(normalizedQuery)) {
    if (rawValue === undefined || rawValue === null || rawValue === "") continue;
    const m = String(rawKey).match(/^filter\[([^\]]+)\]\[([^\]]+)\]$/);
    if (!m) continue;
    const [, field, opKey] = m;
    if (!config.filterableFields?.includes(field)) continue;
    const operator = PB_FILTER_OPERATORS[opKey];
    if (!operator) continue;
    filters.push(buildPbFilterClause(field, operator, rawValue));
  }

  // Fallback/legacy parser
  for (const [rawKey, rawValue] of Object.entries(query)) {
    if (rawValue === undefined || rawValue === null || rawValue === "") continue;
    if (String(rawKey).startsWith("filter[")) continue;
    const [field, opKey = "eq"] = rawKey.split("__");
    if (!config.filterableFields?.includes(field)) continue;
    const operator = PB_FILTER_OPERATORS[opKey];
    if (!operator) continue;
    filters.push(buildPbFilterClause(field, operator, rawValue));
  }
  return filters;
}

function buildPbSortFromQuery(configKey, rawSort) {
  const config = getLcCollectionConfig(configKey);
  if (!rawSort) return [];
  return String(rawSort)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      let desc = part.startsWith("-");
      let field = desc ? part.slice(1) : part;
      if (part.includes(":")) {
        const [f, dir] = part.split(":").map((x) => String(x || "").trim());
        field = f;
        desc = /^desc$/i.test(dir);
      }
      if (!config.sortableFields?.includes(field)) return null;
      return desc ? `-${field}` : field;
    })
    .filter(Boolean);
}

function resolveDomainCollectionConfig(domainKey, apiCollectionName) {
  const domain = getDomainApiRegistry()[domainKey];
  if (!domain) return null;
  const configKey = domain.collections?.[apiCollectionName];
  if (!configKey) return null;
  const config = getLcCollectionConfig(configKey);
  return { domainKey, apiCollectionName, configKey, config, authAdapter: domain.authAdapter || domainKey };
}

const DOMAIN_AUTH_ADAPTERS = {
  lc: {
    middleware: requireLcAuth,
    getContext: (req) => ({ ownerId: req.lcUser?.id, token: req.lcToken }),
  },
};

function domainPbFetch(domainKey, path, options = {}) {
  return String(domainKey || "").toLowerCase() === "lc"
    ? lcPbFetch(path, options)
    : pbFetch(path, options);
}

function requireDomainAuth(req, res, next) {
  const domainKey = String(req.params.domain || "").toLowerCase();
  const domain = getDomainApiRegistry()[domainKey];
  if (!domain) return res.status(404).json({ error: "Unknown domain" });

  const authAdapterName = String(domain.authAdapter || domainKey);
  const adapter = DOMAIN_AUTH_ADAPTERS[authAdapterName];
  if (!adapter || typeof adapter.middleware !== "function") {
    return res.status(501).json({ error: `No auth adapter configured for domain: ${domainKey}` });
  }

  adapter.middleware(req, res, () => {
    req.domainKey = domainKey;
    req.domainAuth = adapter.getContext ? adapter.getContext(req) : {};
    next();
  });
}

async function pbListOwnedRecords(configKey, { ownerId, token, extraFilters = [], sort = [], perPage } = {}) {
  const config = getLcCollectionConfig(configKey);
  const filters = [...extraFilters];
  if (config.ownerField && ownerId) filters.unshift(buildPbFilterClause(config.ownerField, "=", ownerId));
  return lcPbFetch(buildPbQuery({
    collection: config.name,
    filters,
    sort,
    perPage: perPage || config.defaultPerPage || PB_DEFAULT_PAGE_SIZE,
  }), {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function listReferencingRecords({ domainKey, sourceCollectionKey, ownerId, token, recordId }) {
  const policy = getDomainCollectionPolicy(domainKey, sourceCollectionKey);
  const results = [];
  for (const ref of policy.references || []) {
    const response = await pbListOwnedRecords(ref.collectionKey, {
      ownerId,
      token,
      extraFilters: [buildPbFilterClause(ref.field, "=", recordId)],
      perPage: REFERENCE_SCAN_LIMIT,
      sort: ["id"],
    });
    const data = await response.json();
    const items = data.items || [];
    if (items.length) {
      results.push({
        collectionKey: ref.collectionKey,
        label: ref.label || ref.collectionKey,
        field: ref.field,
        policy: ref.policy || DELETE_POLICY.RESTRICT,
        count: items.length,
        sampleIds: items.slice(0, 5).map((item) => item.id),
      });
    }
  }
  return results;
}

async function assertNoBlockingReferences({ domainKey, sourceCollectionKey, ownerId, token, recordId }) {
  const references = await listReferencingRecords({ domainKey, sourceCollectionKey, ownerId, token, recordId });
  const blocking = references.filter((ref) => ref.policy === DELETE_POLICY.RESTRICT || ref.policy === DELETE_POLICY.REMAP);
  if (!blocking.length) return { ok: true, references };
  const summary = blocking
    .map((ref) => `${ref.label}(${ref.count})`)
    .join(", ");
  const err = new Error(`Cannot delete: still referenced by ${summary}`);
  err.status = 409;
  err.references = references;
  throw err;
}

async function remapLcProjectReferences({ ownerId, token, sourceId, targetId }) {
  if (!validPbId(sourceId) || !validPbId(targetId)) {
    const err = new Error("Invalid source or target project ID");
    err.status = 400;
    throw err;
  }
  if (sourceId === targetId) {
    const err = new Error("Source and target project must be different");
    err.status = 400;
    throw err;
  }

  const sessionsResp = await pbListOwnedRecords("sessions", {
    ownerId,
    token,
    extraFilters: [buildPbFilterClause("project", "=", sourceId)],
    perPage: 200,
    sort: ["id"],
  });
  const sessionsData = await sessionsResp.json();
  const sessions = sessionsData.items || [];
  const updatedIds = [];

  for (const session of sessions) {
    const patchResp = await lcPbFetch(`/api/collections/lc_sessions/records/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ project: targetId }),
    });
    if (!patchResp.ok) {
      const patchData = await patchResp.json().catch(() => ({}));
      const err = new Error(pbErrorSummary(patchData, `Failed to remap session ${session.id}`));
      err.status = patchResp.status;
      throw err;
    }
    updatedIds.push(session.id);
  }

  return { updatedCount: updatedIds.length, updatedIds };
}

function isHardDeleteRequested(req) {
  return String(req.query?.hard || "").toLowerCase() === "1" || String(req.query?.hard || "").toLowerCase() === "true";
}

function withSoftDeleteFilters(configKey, { extraFilters = [], includeDeleted = false, trashOnly = false } = {}) {
  const filters = [...extraFilters];
  if (!isLcSoftDeleteEnabled()) return filters;
  const config = getLcCollectionConfig(configKey);
  if (!config.filterableFields?.includes("deleted_at")) return filters;
  if (trashOnly) filters.push(buildPbFilterClause("deleted_at", "!=", ""));
  else if (!includeDeleted) filters.push(buildPbFilterClause("deleted_at", "=", ""));
  return filters;
}

async function softDeleteRecord(configKey, { id, token, userId, reason = "" }) {
  const config = getLcCollectionConfig(configKey);
  const now = new Date().toISOString();
  const payload = {
    deleted_at: now,
    deleted_by: userId || "",
    delete_reason: reason || "",
  };
  const r = await lcPbFetch(`/api/collections/${config.name}/records/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = pbErrorSummary(data, "Soft delete failed");
    const missingField = /deleted_at|deleted_by|delete_reason/i.test(msg);
    const err = new Error(missingField ? "Soft delete fields not found in PocketBase schema. Apply LC soft-delete migration first." : msg);
    err.status = missingField ? 409 : r.status;
    throw err;
  }
  return data;
}

async function restoreSoftDeletedRecord(configKey, { id, token }) {
  const config = getLcCollectionConfig(configKey);
  const payload = { deleted_at: "", deleted_by: "", delete_reason: "" };
  const r = await lcPbFetch(`/api/collections/${config.name}/records/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = pbErrorSummary(data, "Restore failed");
    const missingField = /deleted_at|deleted_by|delete_reason/i.test(msg);
    const err = new Error(missingField ? "Soft delete fields not found in PocketBase schema. Apply LC soft-delete migration first." : msg);
    err.status = missingField ? 409 : r.status;
    throw err;
  }
  return data;
}

function sanitizeLcProjectPayload(input = {}) {
  const body = pickAllowedFields(input, getLcCollectionConfig("projects").writableFields);
  if ("name" in body) body.name = String(body.name || "").trim().slice(0, 100);
  if ("color" in body) body.color = String(body.color || PB_DEFAULT_PROJECT_COLOR).trim() || PB_DEFAULT_PROJECT_COLOR;
  if ("instructions" in body) body.instructions = String(body.instructions || "");
  if ("memory" in body) body.memory = String(body.memory || "");
  if ("sort_order" in body) body.sort_order = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : PB_DEFAULT_LC_PROJECT_SORT;
  return body;
}

async function createLcProjectRecord({ lcToken, userId, input }) {
  const body = sanitizeLcProjectPayload(input);
  if (!body.name) {
    const err = new Error("name required");
    err.status = 400;
    throw err;
  }
  return lcPbFetch("/api/collections/lc_projects/records", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${lcToken}` },
    body: JSON.stringify({
      user: userId,
      name: body.name,
      color: body.color || PB_DEFAULT_PROJECT_COLOR,
      instructions: body.instructions || "",
      memory: body.memory || "",
      sort_order: body.sort_order ?? PB_DEFAULT_LC_PROJECT_SORT,
    }),
  });
}

async function assertLcSessionOwned(sessionId, { ownerId, token }) {
  if (!validPbId(sessionId)) {
    const err = new Error("Invalid session ID");
    err.status = 400;
    throw err;
  }
  const r = await pbListOwnedRecords("sessions", {
    ownerId,
    token,
    extraFilters: [buildPbFilterClause("id", "=", sessionId)],
    perPage: 1,
  });
  const d = await r.json();
  if (!r.ok) {
    const err = new Error(pbErrorSummary(d, "Session check failed"));
    err.status = r.status;
    throw err;
  }
  if (!(d.items || []).length) {
    const err = new Error("Session not owned by current user");
    err.status = 403;
    throw err;
  }
  return d.items[0];
}

async function fetchPbRecordById(configKey, { id, token }) {
  const config = getLcCollectionConfig(configKey);
  const r = await lcPbFetch(`/api/collections/${config.name}/records/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(pbErrorSummary(d, "Record fetch failed"));
    err.status = r.status;
    throw err;
  }
  return d;
}

async function assertRecordOwned(configKey, { id, ownerId, token }) {
  const config = getLcCollectionConfig(configKey);
  const record = await fetchPbRecordById(configKey, { id, token });

  if (config.ownerField) {
    if (String(record?.[config.ownerField] || "") !== String(ownerId || "")) {
      const err = new Error("Record not owned by current user");
      err.status = 403;
      throw err;
    }
    return record;
  }

  // owner-less collections use parent ownership checks
  if (configKey === "messages") {
    await assertLcSessionOwned(record.session, { ownerId, token });
  }
  return record;
}

function buildCreatePayload(configKey, { ownerId, input }) {
  if (configKey === "projects") {
    const body = sanitizeLcProjectPayload(input || {});
    return {
      user: ownerId,
      name: body.name || "New Project",
      color: body.color || PB_DEFAULT_PROJECT_COLOR,
      instructions: body.instructions || "",
      memory: body.memory || "",
      sort_order: body.sort_order ?? PB_DEFAULT_LC_PROJECT_SORT,
    };
  }
  if (configKey === "sessions") {
    const body = pickAllowedFields(input || {}, getLcCollectionConfig("sessions").writableFields);
    return {
      user: ownerId,
      title: String(body.title || "New Chat").slice(0, 200),
      provider: body.provider || "openai",
      model: body.model || "gpt-4.1-mini",
      ...(body.project && validPbId(body.project) ? { project: body.project } : {}),
    };
  }
  if (configKey === "messages") {
    const body = pickAllowedFields(input || {}, getLcCollectionConfig("messages").writableFields);
    return {
      session: body.session,
      role: body.role,
      content: clampPbMessageContent(body.content || ""),
      file_ids: Array.isArray(body.file_ids) ? body.file_ids : [],
    };
  }
  const config = getLcCollectionConfig(configKey);
  const body = pickAllowedFields(input || {}, config.writableFields);
  if (config.ownerField && ownerId) body[config.ownerField] = ownerId;
  return body;
}

function buildUpdatePayload(configKey, { input }) {
  if (configKey === "projects") return sanitizeLcProjectPayload(input || {});
  if (configKey === "messages") {
    const body = {};
    if (typeof input?.content === "string") body.content = clampPbMessageContent(input.content);
    if (Array.isArray(input?.file_ids)) body.file_ids = input.file_ids;
    if (typeof input?.role === "string") body.role = input.role;
    return body;
  }
  if (configKey === "sessions") {
    const body = pickAllowedFields(input || {}, getLcCollectionConfig("sessions").writableFields);
    if (typeof body.title === "string") body.title = body.title.slice(0, 200);
    return body;
  }
  const config = getLcCollectionConfig(configKey);
  return pickAllowedFields(input || {}, config.writableFields);
}

const DOMAIN_REMAP_HANDLERS = {
  lc: {
    projects: async ({ ownerId, token, sourceId, targetId }) => remapLcProjectReferences({ ownerId, token, sourceId, targetId }),
  },
};

// GET /lc/auth/methods → return available auth methods (password + oauth providers)
app.get("/lc/auth/methods", async (req, res) => {
  try {
    const r = await lcPbFetch("/api/collections/users/auth-methods");
    const data = await r.json();
    const providers = {};
    for (const p of (data.oauth2?.providers || [])) {
      providers[p.name] = true;
    }
    res.json({ password: data.password?.enabled !== false, ...providers });
  } catch {
    res.json({ password: true });
  }
});

// GET /api/domains/:domain/schema → expose app-facing collection capabilities through LumiGate
app.get("/api/domains/:domain/schema", (req, res) => {
  const schema = getDomainApiSchema(req.params.domain);
  if (!schema) return res.status(404).json({ error: "Unknown domain" });
  res.json(schema);
});

// GET /api/domains/:domain/:collection → generic domain collection list endpoint
app.get("/api/domains/:domain/:collection", requireDomainAuth, async (req, res) => {
  const domainKey = String(req.domainKey || req.params.domain || "").toLowerCase();
  const apiCollectionName = String(req.params.collection || "");
  const resolved = resolveDomainCollectionConfig(domainKey, apiCollectionName);
  if (!resolved) return res.status(404).json({ error: "Unknown domain collection" });

  try {
    const { configKey } = resolved;
    const ownerId = req.domainAuth?.ownerId;
    const token = req.domainAuth?.token;
    if (!token) return res.status(401).json({ error: "Missing domain auth token" });
    const includeDeleted = String(req.query.include_deleted || "") === "1";
    const trashOnly = String(req.query.trash_only || "") === "1";
    const extraFilters = buildPbFiltersFromQuery(configKey, req.query);

    // Safety guard for messages (ownerField is null): require explicit session filter.
    if (configKey === "messages") {
      const sessionFilterRaw = req.query.session
        || req.query.session__eq
        || req.query["filter[session][eq]"]
        || "";
      const sessionId = String(sessionFilterRaw || "").trim();
      if (!sessionId || !validPbId(sessionId)) {
        return res.status(400).json({ error: "messages query requires session filter" });
      }
      const sessionOwnershipResp = await pbListOwnedRecords("sessions", {
        ownerId,
        token,
        extraFilters: [buildPbFilterClause("id", "=", sessionId)],
        perPage: 1,
      });
      const sessionOwnershipData = await sessionOwnershipResp.json();
      if (!sessionOwnershipResp.ok) return res.status(sessionOwnershipResp.status).json(sessionOwnershipData);
      if (!(sessionOwnershipData.items || []).length) return res.status(403).json({ error: "Session not owned by current user" });
    }

    const r = await pbListOwnedRecords(configKey, {
      ownerId,
      token,
      extraFilters: withSoftDeleteFilters(configKey, { extraFilters, includeDeleted, trashOnly }),
      sort: buildPbSortFromQuery(configKey, req.query.sort) || [],
      perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
    });
    const d = await r.json();
    return res.status(r.status).json(d);
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message });
  }
});

// POST /api/domains/:domain/:collection → generic create endpoint
app.post("/api/domains/:domain/:collection", requireDomainAuth, async (req, res) => {
  const domainKey = String(req.domainKey || req.params.domain || "").toLowerCase();
  const apiCollectionName = String(req.params.collection || "");
  const resolved = resolveDomainCollectionConfig(domainKey, apiCollectionName);
  if (!resolved) return res.status(404).json({ error: "Unknown domain collection" });

  try {
    const { configKey } = resolved;
    const ownerId = req.domainAuth?.ownerId;
    const token = req.domainAuth?.token;
    if (!token) return res.status(401).json({ error: "Missing domain auth token" });

    const payload = buildCreatePayload(configKey, { ownerId, input: req.body || {} });

    if (configKey === "messages") {
      if (!payload.session || !payload.role || !payload.content) {
        return res.status(400).json({ error: "Missing required fields: session, role, content" });
      }
      await assertLcSessionOwned(payload.session, { ownerId, token });
    }

    const config = getLcCollectionConfig(configKey);
    const r = await domainPbFetch(domainKey, `/api/collections/${config.name}/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(d);
    return res.status(r.status).json(d);
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message });
  }
});

// PATCH /api/domains/:domain/:collection/:id → generic update endpoint
app.patch("/api/domains/:domain/:collection/:id", requireDomainAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid ID" });
  const domainKey = String(req.domainKey || req.params.domain || "").toLowerCase();
  const apiCollectionName = String(req.params.collection || "");
  const resolved = resolveDomainCollectionConfig(domainKey, apiCollectionName);
  if (!resolved) return res.status(404).json({ error: "Unknown domain collection" });

  try {
    const { configKey } = resolved;
    const ownerId = req.domainAuth?.ownerId;
    const token = req.domainAuth?.token;
    if (!token) return res.status(401).json({ error: "Missing domain auth token" });

    await assertRecordOwned(configKey, { id: req.params.id, ownerId, token });
    const payload = buildUpdatePayload(configKey, { input: req.body || {} });
    if (!Object.keys(payload).length) return res.status(400).json({ error: "No updatable fields provided" });

    const config = getLcCollectionConfig(configKey);
    if (config.ownerField) delete payload[config.ownerField];
    const r = await domainPbFetch(domainKey, `/api/collections/${config.name}/records/${req.params.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    return res.status(r.status).json(d);
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message });
  }
});

// DELETE /api/domains/:domain/:collection/:id → generic delete endpoint
app.delete("/api/domains/:domain/:collection/:id", requireDomainAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid ID" });
  const domainKey = String(req.domainKey || req.params.domain || "").toLowerCase();
  const apiCollectionName = String(req.params.collection || "");
  const resolved = resolveDomainCollectionConfig(domainKey, apiCollectionName);
  if (!resolved) return res.status(404).json({ error: "Unknown domain collection" });

  try {
    const { configKey } = resolved;
    const ownerId = req.domainAuth?.ownerId;
    const token = req.domainAuth?.token;
    if (!token) return res.status(401).json({ error: "Missing domain auth token" });

    await assertRecordOwned(configKey, { id: req.params.id, ownerId, token });

    if (isLcSoftDeleteEnabled() && !isHardDeleteRequested(req)) {
      const data = await softDeleteRecord(configKey, {
        id: req.params.id,
        token,
        userId: ownerId,
        reason: req.body?.reason || "user_deleted",
      });
      return res.json({ success: true, mode: "soft", data });
    }

    await assertNoBlockingReferences({
      domainKey,
      sourceCollectionKey: apiCollectionName,
      ownerId,
      token,
      recordId: req.params.id,
    });

    const config = getLcCollectionConfig(configKey);
    const r = await domainPbFetch(domainKey, `/api/collections/${config.name}/records/${req.params.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 204 || r.ok) return res.json({ success: true });
    const d = await r.json().catch(() => ({}));
    return res.status(r.status).json(d);
  } catch (e) {
    const body = e.references ? { error: e.message, references: e.references } : { error: e.message };
    return res.status(e.status || 502).json(body);
  }
});

// GET /api/domains/:domain/:collection/:id/references → generic reference inspection
app.get("/api/domains/:domain/:collection/:id/references", requireDomainAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid ID" });
  const domainKey = String(req.domainKey || req.params.domain || "").toLowerCase();
  const apiCollectionName = String(req.params.collection || "");
  const resolved = resolveDomainCollectionConfig(domainKey, apiCollectionName);
  if (!resolved) return res.status(404).json({ error: "Unknown domain collection" });

  try {
    const { configKey } = resolved;
    const ownerId = req.domainAuth?.ownerId;
    const token = req.domainAuth?.token;
    if (!token) return res.status(401).json({ error: "Missing domain auth token" });
    await assertRecordOwned(configKey, { id: req.params.id, ownerId, token });

    const references = await listReferencingRecords({
      domainKey,
      sourceCollectionKey: apiCollectionName,
      ownerId,
      token,
      recordId: req.params.id,
    });
    return res.json({ id: req.params.id, deletePolicy: getDomainCollectionPolicy(domainKey, apiCollectionName).deletePolicy, references });
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message });
  }
});

// POST /api/domains/:domain/:collection/:id/remap → generic remap endpoint
app.post("/api/domains/:domain/:collection/:id/remap", requireDomainAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid ID" });
  const domainKey = String(req.domainKey || req.params.domain || "").toLowerCase();
  const apiCollectionName = String(req.params.collection || "");
  const resolved = resolveDomainCollectionConfig(domainKey, apiCollectionName);
  if (!resolved) return res.status(404).json({ error: "Unknown domain collection" });

  try {
    const { configKey } = resolved;
    const ownerId = req.domainAuth?.ownerId;
    const token = req.domainAuth?.token;
    if (!token) return res.status(401).json({ error: "Missing domain auth token" });
    await assertRecordOwned(configKey, { id: req.params.id, ownerId, token });

    const targetId = req.body?.targetId || req.body?.target_project_id;
    const deleteSource = !!(req.body?.deleteSource || req.body?.delete_source);
    const handler = DOMAIN_REMAP_HANDLERS[domainKey]?.[apiCollectionName];
    if (!handler) return res.status(501).json({ error: "Remap handler not implemented for this collection" });
    const remap = await handler({ ownerId, token, sourceId: req.params.id, targetId });

    let deleted = false;
    if (deleteSource) {
      await assertNoBlockingReferences({
        domainKey,
        sourceCollectionKey: apiCollectionName,
        ownerId,
        token,
        recordId: req.params.id,
      });
      const config = getLcCollectionConfig(configKey);
      const delResp = await domainPbFetch(domainKey, `/api/collections/${config.name}/records/${req.params.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!delResp.ok && delResp.status !== 204) {
        const delData = await delResp.json().catch(() => ({}));
        return res.status(delResp.status).json({ error: pbErrorSummary(delData, "Delete failed after remap"), remap });
      }
      deleted = true;
    }

    return res.json({ success: true, remap, deleted });
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message });
  }
});

// POST /api/domains/:domain/trash/:collection/:id/restore → generic restore endpoint
app.post("/api/domains/:domain/trash/:collection/:id/restore", requireDomainAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid ID" });
  if (!isLcSoftDeleteEnabled()) return res.status(400).json({ error: "Soft delete is disabled" });

  const domainKey = String(req.domainKey || req.params.domain || "").toLowerCase();
  const apiCollectionName = String(req.params.collection || "");
  const resolved = resolveDomainCollectionConfig(domainKey, apiCollectionName);
  if (!resolved) return res.status(404).json({ error: "Unknown domain collection" });

  try {
    const { configKey } = resolved;
    const ownerId = req.domainAuth?.ownerId;
    const token = req.domainAuth?.token;
    if (!token) return res.status(401).json({ error: "Missing domain auth token" });
    await assertRecordOwned(configKey, { id: req.params.id, ownerId, token });
    const data = await restoreSoftDeletedRecord(configKey, { id: req.params.id, token });
    return res.json({ success: true, data });
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message });
  }
});

// Server-side PKCE state store: state → { codeVerifier, provider, redirect, redirectUrl, ts }
// Avoids cookie loss on Safari/mobile during cross-domain OAuth redirect
const oauthStateStore = new Map();
setInterval(() => {
  const cutoff = Date.now() - 600_000;
  for (const [k, v] of oauthStateStore) if (v.ts < cutoff) oauthStateStore.delete(k);
}, 120_000);

function sanitizeOAuthRedirect(input) {
  const fallback = "/lumichat";
  const raw = String(input || "").trim();
  if (!raw) return fallback;

  // allow same-origin relative paths only
  if (raw.startsWith("/")) return raw.startsWith("//") ? fallback : raw;

  // allow explicit custom app schemes only (e.g. lumichat://...)
  const m = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (!m) return fallback;
  const scheme = String(m[1] || "").toLowerCase();
  const allowedSchemes = String(process.env.LUMICHAT_ALLOWED_REDIRECT_SCHEMES || "lumichat")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowedSchemes.includes(scheme) ? raw : fallback;
}

// GET /lc/auth/oauth-start?provider=google&redirect=... → redirect to PB OAuth URL
app.get("/lc/auth/oauth-start", lcAuthLimiter, async (req, res) => {
  const { provider = "google", redirect = "/lumichat" } = req.query;
  const safeRedirect = sanitizeOAuthRedirect(redirect);
  try {
    const r = await lcPbFetch("/api/collections/users/auth-methods");
    const data = await r.json();
    const prov = (data.oauth2?.providers || []).find(p => p.name === provider);
    if (!prov) return res.status(404).json({ error: `Provider ${provider} not configured` });

    const publicBase = process.env.LUMICHAT_PUBLIC_URL ||
      (req.headers["x-forwarded-proto"] && req.headers["x-forwarded-host"]
        ? `${req.headers["x-forwarded-proto"]}://${req.headers["x-forwarded-host"]}`
        : `${req.protocol}://${req.get("host")}`);
    const redirectUrl = `${publicBase}/lc/auth/oauth-callback`;

    // Store PKCE data server-side keyed by PB's state value (Google echoes it back)
    oauthStateStore.set(prov.state, {
      codeVerifier: prov.codeVerifier,
      provider,
      redirect: safeRedirect,
      redirectUrl,
      ts: Date.now(),
    });

    const fullAuthUrl = prov.authUrl + encodeURIComponent(redirectUrl);
    res.redirect(fullAuthUrl);
  } catch (err) {
    res.status(500).json({ error: "OAuth start failed", details: err.message });
  }
});

// GET /lc/auth/oauth-callback?code=...&state=... → exchange code, set lc_token cookie
app.get("/lc/auth/oauth-callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.redirect("/lumichat?oauth_err=missing_code");

  // Look up PKCE data from server-side store using the state Google echoed back
  const stored = oauthStateStore.get(state);
  oauthStateStore.delete(state);

  if (!stored) return res.redirect("/lumichat?oauth_err=session_expired");
  const { provider = "google", codeVerifier = "", redirectUrl = "", redirect = "/lumichat" } = stored;
  const safeRedirect = sanitizeOAuthRedirect(redirect);

  try {
    const r = await lcPbFetch("/api/collections/users/auth-with-oauth2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, code, codeVerifier, redirectUrl }),
    });
    const data = await r.json();
    if (!r.ok) return res.redirect(`/lumichat?oauth_err=${encodeURIComponent(data.message || "auth_failed")}`);

    // Create pending approval for OAuth users (same as register)
    if (data.record?.id && settings.approvalEnabled !== false) {
      const pbToken = await getPbAdminToken();
      if (pbToken) {
        const existing = await lcPbFetch(`/api/collections/lc_user_settings/records?filter=user='${isValidPbId(data.record.id) ? data.record.id : ''}'&perPage=1`, {
          headers: { Authorization: `Bearer ${pbToken}` },
        }).then(r => r.json()).catch(() => ({ items: [] }));
        if (!existing.items?.length) {
          await lcPbFetch(`/api/collections/lc_user_settings/records`, {
            method: "POST", headers: { Authorization: `Bearer ${pbToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ user: data.record.id }),
          }).catch(() => {});
          const approvalTo = settings.approvalEmail || settings.authEmail;
          if (approvalTo) sendApprovalEmail(req, approvalTo, data.record.id, data.record.email || '', data.record.name || '', { ip: normalizeIP(req), country: req.headers['cf-ipcountry'] || '' }).catch(() => {});
        }
      }
    }

    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https" || (req.headers["cf-visitor"] || "").includes("https");
    // For app deep-link schemes (e.g. lumichat://), pass token via URL param
    // since httpOnly cookies aren't accessible from native apps
    if (safeRedirect.includes("://") && !safeRedirect.startsWith("http")) {
      const sep = safeRedirect.includes("?") ? "&" : "?";
      return res.redirect(`${safeRedirect}${sep}token=${encodeURIComponent(data.token)}&oauth=1`);
    }

    res.cookie("lc_token", data.token, {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: isSecure,
      sameSite: "Lax",
      path: "/",
    });
    res.redirect(safeRedirect + "?oauth=1");
  } catch (err) {
    res.redirect(`/lumichat?oauth_err=${encodeURIComponent(err.message)}`);
  }
});

// POST /lc/auth/check-email → check if email exists in PB (for step-based auth UI)
app.post("/lc/auth/check-email", lcAuthLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "Email required" });
    const normalized = String(email).trim().toLowerCase();
    if (!normalized) return res.status(400).json({ error: "Email required" });
    const filter = encodeURIComponent(`email=${pbQuote(normalized)}`);
    const r = await lcPbFetch(`/api/collections/users/records?filter=${filter}&fields=id&perPage=1`);
    if (!r.ok) return res.json({ exists: false });
    const data = await r.json();
    res.json({ exists: (data.totalItems || 0) > 0 });
  } catch { res.json({ exists: false }); }
});

// POST /lc/auth/register → proxy to PB + approval email
app.post("/lc/auth/register", lcAuthLimiter, lcRegisterLimiter, async (req, res) => {
  // Global hourly registration cap
  if (_globalRegCount >= 20) return res.status(429).json({ error: "Too many registrations, try again later" });
  try {
    const r = await lcPbFetch("/api/collections/users/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    if (r.ok && data.id) _globalRegCount++;
    if (r.ok && data.id && settings.approvalEnabled !== false) {
      const pbToken = await getPbAdminToken();
      if (pbToken) {
        await lcPbFetch(`/api/collections/lc_user_settings/records`, {
          method: "POST", headers: { Authorization: `Bearer ${pbToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ user: data.id }),
        }).catch(() => {});
      }
      const approvalTo = settings.approvalEmail || settings.authEmail;
      if (approvalTo) {
        sendApprovalEmail(req, approvalTo, data.id, data.email || req.body.email, data.name || '', { ip: normalizeIP(req), country: req.headers['cf-ipcountry'] || '' }).catch(e => log("warn", "Approval email failed", { error: e.message }));
      }
    }
    res.status(r.status).json(data);
  } catch (err) { res.status(502).json({ error: "PocketBase unavailable" }); }
});

async function sendApprovalEmail(httpReq, toEmail, userId, userEmail, userName, extra = {}) {
  const smtpHost = process.env.SMTP_HOST || settings.smtpHost;
  const smtpUser = process.env.SMTP_USER || settings.smtpUser;
  const smtpPass = process.env.SMTP_PASS || (settings.smtpPass ? decryptValue(settings.smtpPass, ADMIN_SECRET) : undefined);
  const smtpPort = parseInt(process.env.SMTP_PORT || settings.smtpPort || "587");
  const smtpFrom = process.env.SMTP_FROM || settings.smtpFrom || `LumiChat <${smtpUser}>`;
  if (!smtpHost || !smtpUser || !smtpPass) return;
  const token = crypto.randomBytes(16).toString('hex');
  if (!settings._approvalTokens) settings._approvalTokens = {};
  settings._approvalTokens[token] = { userId, userEmail, userName, ip: extra.ip || '', country: extra.country || '', createdAt: Date.now() };
  for (const [k, v] of Object.entries(settings._approvalTokens)) { if (Date.now() - v.createdAt > 86400000) delete settings._approvalTokens[k]; }
  saveSettings(settings);
  // Use PUBLIC_URL env or x-forwarded-host, never localhost in emails
  const publicUrl = process.env.PUBLIC_URL || settings.publicUrl;
  let baseUrl;
  if (publicUrl) {
    baseUrl = publicUrl.replace(/\/$/, "");
  } else {
    const fwdHost = httpReq?.headers?.['x-forwarded-host'] || httpReq?.get?.('host');
    const proto = httpReq?.headers?.['x-forwarded-proto'] === 'https' || httpReq?.secure ? 'https' : 'http';
    baseUrl = fwdHost && !fwdHost.includes('localhost') ? `${proto}://${fwdHost}` : 'https://lumigate.autorums.com';
  }
  const url = `${baseUrl}/lc/admin/approve?token=${token}`;
  const nodemailer = require("nodemailer");
  await nodemailer.createTransport({ host: smtpHost, port: smtpPort, secure: smtpPort === 465, auth: { user: smtpUser, pass: smtpPass } }).sendMail({
    from: smtpFrom, to: toEmail, subject: `LumiChat — New User: ${userEmail}`,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;background:#f5f5f7"><div style="max-width:480px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)"><div style="background:#10a37f;padding:24px 32px;text-align:center"><div style="font-size:20px;font-weight:700;color:#fff">LumiChat</div></div><div style="padding:32px"><h2 style="margin:0 0 8px;font-size:18px;color:#1c1c1e">New User Registration</h2><p style="margin:0 0 20px;color:#666;font-size:14px;line-height:1.6">A new user has requested access. Review and choose a tier to approve, or decline.</p><div style="background:#f8f8f8;border-radius:10px;padding:16px;margin-bottom:24px"><div style="font-size:13px;color:#999;margin-bottom:4px">Email</div><div style="font-size:15px;font-weight:600;color:#1c1c1e">${userEmail}</div>${userName ? `<div style="font-size:13px;color:#999;margin-top:12px;margin-bottom:4px">Name</div><div style="font-size:15px;color:#1c1c1e">${userName}</div>` : ''}${extra.country ? `<div style="font-size:13px;color:#999;margin-top:12px;margin-bottom:4px">Location</div><div style="font-size:15px;color:#1c1c1e">${extra.country}${extra.ip ? ` <span style="color:#999;font-size:13px">(${extra.ip})</span>` : ''}</div>` : ''}</div><a href="${url}" style="display:block;text-align:center;background:#10a37f;color:#fff;text-decoration:none;padding:14px;border-radius:10px;font-size:15px;font-weight:600">Review &amp; Approve / Decline</a><p style="margin:16px 0 0;font-size:12px;color:#999;text-align:center">Link expires in 24h. You can select a tier on the approval page.</p></div></div></body></html>`,
  });
  log("info", "Approval email sent", { to: toEmail, userId, userEmail });
}

app.get("/lc/admin/approve", lcAuthLimiter, async (req, res) => {
  const { token } = req.query;
  if (!token || !settings._approvalTokens?.[token]) {
    return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invalid Link</title></head><body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;background:#f5f5f7"><div style="max-width:480px;margin:60px auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);text-align:center"><div style="background:#10a37f;padding:24px 32px"><div style="font-size:20px;font-weight:700;color:#fff">LumiChat</div></div><div style="padding:32px"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ff9500" stroke-width="2" style="margin-bottom:12px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><h2 style="margin:0 0 8px;color:#1c1c1e">Invalid or Expired Link</h2><p style="color:#666;font-size:14px">This approval link is no longer valid. You can manage users from the LumiGate Dashboard.</p></div></div></body></html>`);
  }
  const { userId, userEmail, userName, ip, country } = settings._approvalTokens[token];
  if (!isValidPbId(userId)) return res.status(400).send('Invalid');
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const safeEmail = esc(userEmail);
  const safeName = userName ? esc(userName) : '';
  const safeCountry = esc(country);
  const safeIp = esc(ip);
  // Show approval page — token is NOT consumed here (only on POST)
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve User — LumiChat</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',system-ui,sans-serif;background:#f5f5f7;padding:40px 20px;-webkit-overflow-scrolling:touch}
.card{max-width:520px;width:100%;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)}
.hdr{background:#10a37f;padding:24px 32px;text-align:center}
.hdr h1{font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.3px}
.bd{padding:32px}
.uinfo{background:#f8f8fa;border-radius:12px;padding:16px 20px;margin-bottom:28px}
.uinfo .lbl{font-size:12px;color:#999;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px}
.uinfo .val{font-size:15px;font-weight:600;color:#1c1c1e}
.uinfo .row+.row{margin-top:14px}
h2{font-size:16px;color:#1c1c1e;margin-bottom:16px;font-weight:600}
.tiers{display:flex;gap:12px;margin-bottom:28px}
.tier{flex:1;border:2px solid #e5e5ea;border-radius:14px;padding:16px 12px;text-align:center;cursor:pointer;transition:all 0.2s ease;position:relative}
.tier:hover{border-color:#10a37f;background:#f0fdf8}
.tier.sel{border-color:#10a37f;background:#f0fdf8;box-shadow:0 0 0 1px #10a37f}
.tier input{position:absolute;opacity:0;pointer-events:none}
.tier .tn{font-size:15px;font-weight:700;color:#1c1c1e;margin-bottom:4px}
.tier .td{font-size:12px;color:#888;line-height:1.4}
.tier .ti{width:36px;height:36px;margin:0 auto 10px;border-radius:10px;display:flex;align-items:center;justify-content:center}
.tier .ti svg{width:20px;height:20px}
.t-b .ti{background:#e8f5e9}.t-p .ti{background:#fff3e0}.t-s .ti{background:#e3f2fd}
.acts{display:flex;gap:12px}
.btn{flex:1;padding:14px;border-radius:12px;font-size:15px;font-weight:600;border:none;cursor:pointer;transition:all 0.15s ease;text-align:center}
.btn:active{transform:scale(0.97)}
.btn-a{background:#10a37f;color:#fff}.btn-a:hover{background:#0d9268}
.btn-a:disabled{background:#b0b0b0;cursor:not-allowed}
.btn-d{background:#f5f5f7;color:#ff3b30;border:1px solid #e5e5ea}.btn-d:hover{background:#fef2f2;border-color:#ff3b30}
.rv{display:none;text-align:center;padding:20px 0}
.rv svg{margin-bottom:12px}
.rv h2{font-size:20px;margin-bottom:6px}
.rv p{color:#666;font-size:14px}
.dur{padding:8px 16px;border:2px solid #e5e5ea;border-radius:10px;font-size:14px;font-weight:500;color:#1c1c1e;cursor:pointer;transition:all 0.15s}
.dur:hover{border-color:#ef6c00;background:#fff8f0}
.dur.dsel{border-color:#ef6c00;background:#fff8f0;color:#ef6c00;font-weight:600}
@media(max-width:500px){.tiers{flex-direction:column}.bd{padding:24px 20px}}
</style></head><body>
<div class="card">
  <div class="hdr"><h1>LumiChat</h1></div>
  <div class="bd">
    <div id="fv">
      <div class="uinfo">
        <div class="row"><div class="lbl">Email</div><div class="val">${safeEmail}</div></div>
        ${safeName ? `<div class="row"><div class="lbl">Name</div><div class="val">${safeName}</div></div>` : ''}
        ${safeCountry ? `<div class="row"><div class="lbl">Location</div><div class="val">${safeCountry}${safeIp ? ` <span style="color:#999;font-size:13px">(${safeIp})</span>` : ''}</div></div>` : ''}
      </div>
      <h2>Select Tier</h2>
      <div class="tiers">
        <label class="tier t-b sel" onclick="sl(this,'basic')">
          <input type="radio" name="tier" value="basic" checked>
          <div class="ti"><svg viewBox="0 0 24 24" fill="none" stroke="#43a047" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/></svg></div>
          <div class="tn">Basic</div>
          <div class="td">Standard access, default rate limits</div>
        </label>
        <label class="tier t-p" onclick="sl(this,'premium')">
          <input type="radio" name="tier" value="premium">
          <div class="ti"><svg viewBox="0 0 24 24" fill="none" stroke="#ef6c00" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></div>
          <div class="tn">Premium</div>
          <div class="td">Higher limits, all models</div>
        </label>
        <label class="tier t-s" onclick="sl(this,'selfservice')">
          <input type="radio" name="tier" value="selfservice">
          <div class="ti"><svg viewBox="0 0 24 24" fill="none" stroke="#1e88e5" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div>
          <div class="tn">Self-Service</div>
          <div class="td">User manages own API keys</div>
        </label>
      </div>
      <div id="dur-wrap" style="display:none;margin-bottom:24px">
        <h2>Premium Duration</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <label class="dur dsel" onclick="sdur(this,'30d')"><input type="radio" name="dur" value="30d" checked style="display:none">1 Month</label>
          <label class="dur" onclick="sdur(this,'90d')"><input type="radio" name="dur" value="90d" style="display:none">3 Months</label>
          <label class="dur" onclick="sdur(this,'365d')"><input type="radio" name="dur" value="365d" style="display:none">1 Year</label>
          <label class="dur" onclick="sdur(this,'forever')"><input type="radio" name="dur" value="forever" style="display:none">No Expiry</label>
        </div>
      </div>
      <div class="acts">
        <button class="btn btn-d" onclick="go('decline')">Decline</button>
        <button class="btn btn-a" id="abtn" onclick="go('approve')">Approve User</button>
      </div>
    </div>
    <div id="rv" class="rv"></div>
  </div>
</div>
<script>
var st='basic',sd='30d';
function sl(el,t){st=t;document.querySelectorAll('.tier').forEach(function(x){x.classList.remove('sel')});el.classList.add('sel');document.getElementById('dur-wrap').style.display=t==='premium'?'block':'none'}
function sdur(el,d){sd=d;document.querySelectorAll('.dur').forEach(function(x){x.classList.remove('dsel')});el.classList.add('dsel')}
function go(action){
  var fv=document.getElementById('fv'),rv=document.getElementById('rv');
  var btns=fv.querySelectorAll('.btn');
  btns.forEach(function(b){b.disabled=true;b.style.opacity='0.6'});
  var payload={token:'${token}',action:action,tier:st};
  if(st==='premium') payload.duration=sd;
  fetch('/lc/admin/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
  .then(function(r){return r.json()})
  .then(function(data){
    fv.style.display='none';rv.style.display='block';
    if(data.ok){
      var links='<div style="display:flex;gap:12px;justify-content:center;margin-top:24px"><a href="/" style="padding:10px 20px;background:#10a37f;color:#fff;border-radius:10px;font-size:14px;font-weight:600;text-decoration:none">Open Dashboard</a><a href="javascript:void(0)" onclick="window.close()" style="padding:10px 20px;background:#f5f5f7;color:#666;border-radius:10px;font-size:14px;font-weight:500;text-decoration:none;border:1px solid #e5e5ea">Close</a></div>';
      if(action==='approve'){
        var tl=st.charAt(0).toUpperCase()+st.slice(1);
        var durLabel='';if(st==='premium'&&sd!=='forever'){var dm={'30d':'1 month','90d':'3 months','365d':'1 year'};durLabel=' ('+dm[sd]+')';}
        rv.innerHTML='<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#10a37f" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><h2>User Approved</h2><p><b>${safeEmail}</b></p><p style="color:#999;font-size:13px;margin-top:4px">Tier: <b>'+tl+'</b>'+durLabel+'</p>'+links;
      }else{
        rv.innerHTML='<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ff3b30" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg><h2>User Declined</h2><p><b>${safeEmail}</b></p><p style="color:#999;font-size:13px;margin-top:4px">Registration has been declined.</p>'+links;
      }
    }else{
      rv.innerHTML='<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ff9500" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><h2>Error</h2><p>'+(data.error||'Something went wrong')+'</p>';
    }
  })
  .catch(function(){
    btns.forEach(function(b){b.disabled=false;b.style.opacity='1'});
    alert('Network error. Please try again.');
  });
}
</script>
</body></html>`);
});

app.post("/lc/admin/approve", express.json(), lcAuthLimiter, async (req, res) => {
  const { token, action, tier, duration } = req.body || {};
  if (!token || !settings._approvalTokens?.[token]) {
    return res.status(400).json({ ok: false, error: "Invalid or expired token. The link may have already been used." });
  }
  const validTiers = ['basic', 'premium', 'selfservice'];
  const validActions = ['approve', 'decline'];
  const validDurations = ['30d', '90d', '365d', 'forever'];
  if (!validActions.includes(action)) return res.status(400).json({ ok: false, error: "Invalid action" });
  if (action === 'approve' && !validTiers.includes(tier)) return res.status(400).json({ ok: false, error: "Invalid tier" });

  const { userId, userEmail } = settings._approvalTokens[token];
  if (!isValidPbId(userId)) return res.status(400).json({ ok: false, error: "Invalid user ID" });

  // Consume the token now (only on POST, not on GET)
  delete settings._approvalTokens[token];
  saveSettings(settings);

  if (action === 'approve') {
    // Calculate tier expiry for premium
    let tierExpires = null;
    if (tier === 'premium' && duration && duration !== 'forever') {
      const days = { '30d': 30, '90d': 90, '365d': 365 }[duration] || 30;
      tierExpires = new Date(Date.now() + days * 86400000).toISOString();
    }

    const pbToken = await getPbAdminToken();
    if (pbToken) {
      const find = await lcPbFetch(`/api/collections/lc_user_settings/records?filter=user='${userId}'&perPage=1`, { headers: { Authorization: `Bearer ${pbToken}` } }).then(r => r.json()).catch(() => ({ items: [] }));
      const ep = find.items?.length
        ? `/api/collections/lc_user_settings/records/${find.items[0].id}`
        : `/api/collections/lc_user_settings/records`;
      const body = { ...(find.items?.length ? {} : { user: userId }), tier, tier_updated: new Date().toISOString() };
      if (tierExpires) body.tier_expires = tierExpires;
      else if (tier === 'premium') body.tier_expires = ''; // forever = no expiry
      await lcPbFetch(ep, { method: find.items?.length ? 'PATCH' : 'POST', headers: { Authorization: `Bearer ${pbToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    lcTierCache.delete(userId);
    audit(null, "lc_user_approved", userId, { email: userEmail, tier, duration: duration || 'forever' });
    return res.json({ ok: true, action: 'approve', tier, duration: duration || 'forever' });
  } else {
    // Decline: remove lc_user_settings and delete the PB user record
    const pbToken = await getPbAdminToken();
    if (pbToken) {
      const find = await lcPbFetch(`/api/collections/lc_user_settings/records?filter=user='${userId}'&perPage=1`, { headers: { Authorization: `Bearer ${pbToken}` } }).then(r => r.json()).catch(() => ({ items: [] }));
      if (find.items?.length) {
        await lcPbFetch(`/api/collections/lc_user_settings/records/${find.items[0].id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${pbToken}` } }).catch(() => {});
      }
      await lcPbFetch(`/api/collections/users/records/${userId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${pbToken}` } }).catch(() => {});
    }
    lcTierCache.delete(userId);
    audit(null, "lc_user_declined", userId, { email: userEmail });
    return res.json({ ok: true, action: 'decline' });
  }
});

// POST /lc/auth/login → PB auth → set httpOnly cookie
app.post("/lc/auth/login", lcAuthLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Missing email or password" });
    const r = await lcPbFetch("/api/collections/users/auth-with-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: email, password }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https" || (req.headers["cf-visitor"] || "").includes("https");
    res.cookie("lc_token", data.token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: "Strict",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
    res.json({ ok: true, record: { id: data.record?.id, email: data.record?.email, name: data.record?.name } });
  } catch (err) {
    res.status(502).json({ error: "PocketBase unavailable" });
  }
});

// POST /lc/auth/logout → clear cookie
app.post("/lc/auth/logout", (req, res) => {
  res.clearCookie("lc_token", { path: "/" });
  res.json({ ok: true });
});

// POST /lc/auth/refresh → call PB auth-refresh to extend session while user is active
app.post("/lc/auth/refresh", requireLcAuth, async (req, res) => {
  try {
    const r = await lcPbFetch("/api/collections/users/auth-refresh", {
      method: "POST",
      headers: { Authorization: `Bearer ${req.lcToken}` },
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https" || (req.headers["cf-visitor"] || "").includes("https");
    res.cookie("lc_token", data.token, {
      httpOnly: true, secure: isSecure, sameSite: "Strict", path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "PocketBase unavailable" });
  }
});

// GET /lc/auth/me → fetch full user record from PB (JWT only has id+email)
app.get("/lc/auth/me", requireLcAuth, async (req, res) => {
  try {
    const r = await lcPbFetch(`/api/collections/users/records/${req.lcUser.id}`, {
      headers: { Authorization: `Bearer ${req.lcToken}` },
    });
    const data = await r.json();
    if (!r.ok) return res.json({ id: req.lcUser.id, email: req.lcUser.email, name: null, avatarUrl: null });
    const avatarUrl = data.avatar
      ? `${PB_URL}/api/files/users/${data.id}/${data.avatar}?thumb=80x80`
      : null;
    res.json({ id: data.id, email: data.email, name: data.name || null, avatarUrl });
  } catch {
    res.json({ id: req.lcUser.id, email: req.lcUser.email, name: null, avatarUrl: null });
  }
});

// PATCH /lc/auth/profile → update display name + avatar
app.patch("/lc/auth/profile", requireLcAuth, lcUpload.single("avatar"), async (req, res) => {
  try {
    const form = new FormData();
    const name = req.body?.name;
    if (typeof name === "string") form.append("name", name.trim().slice(0, 100));
    if (req.file) {
      const blob = new Blob([require("fs").readFileSync(req.file.path)], { type: req.file.mimetype || "image/jpeg" });
      form.append("avatar", blob, req.file.originalname || "avatar.jpg");
      require("fs").unlinkSync(req.file.path);
    }
    const r = await lcPbFetch(`/api/collections/users/records/${req.lcUser.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${req.lcToken}` },
      body: form,
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || "Update failed" });
    const avatarUrl = data.avatar
      ? `${PB_URL}/api/files/users/${data.id}/${data.avatar}?thumb=80x80`
      : null;
    res.json({ id: data.id, email: data.email, name: data.name || null, avatarUrl });
  } catch (e) {
    if (req.file) { try { require("fs").unlinkSync(req.file.path); } catch {} }
    res.status(500).json({ error: e.message });
  }
});

// POST /lc/auth/change-password → change password (requires old password)
app.post("/lc/auth/change-password", requireLcAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: "Missing fields" });
  if (newPassword.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
  try {
    const r = await lcPbFetch(`/api/collections/users/records/${req.lcUser.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.lcToken}` },
      body: JSON.stringify({ oldPassword, password: newPassword, passwordConfirm: newPassword }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || "Password change failed" });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PocketBase record ID validation (15 alphanumeric chars)
const LC_ID_RE = /^[a-zA-Z0-9]{15}$/;
function validPbId(id) { return typeof id === 'string' && LC_ID_RE.test(id); }

// ── LumiChat proxy for /providers and /models (CF Access bypass via /lc/ path) ──
app.get("/lc/providers", requireLcAuth, (req, res) => {
  const admin = isAdminRequest(req);
  res.json(Object.entries(PROVIDERS).map(([name, cfg]) => {
    const allKeys = providerKeys[name] || [];
    const enabledKeys = allKeys.filter(k => k.enabled);
    const mode = getProviderAccessMode(name);
    const isCollector = mode === "collector" && hasCollectorToken(name);
    const entry = { name, baseUrl: cfg.baseUrl, available: enabledKeys.length > 0 || isCollector, accessMode: mode };
    if (mode === "collector" && collectorHealth[name]) entry.collectorStatus = collectorHealth[name].status;
    if (admin) { entry.keyCount = allKeys.length; entry.enabledCount = enabledKeys.length; }
    return entry;
  }));
});
app.get("/lc/models/:provider", requireLcAuth, (req, res) => {
  const name = req.params.provider.toLowerCase();
  res.json(MODELS[name] || []);
});

// ── Collector re-login for LumiChat users ─────────────────────────────────
// Trigger login, poll status, get VNC URL — no admin required
app.post("/lc/collector/login/:provider", requireLcAuth, async (req, res) => {
  const name = req.params.provider.toLowerCase();
  if (!COLLECTOR_LOGIN_SITES[name]) return res.status(400).json({ error: "Unsupported provider" });
  if (_loginState.active) return res.status(409).json({ error: `Login in progress for ${_loginState.provider}` });
  // Reuse the same logic as admin login
  const site = COLLECTOR_LOGIN_SITES[name];
  const cdpPort = process.env.CDP_PORT || 9223;
  const cdpHost = process.env.CDP_HOST || 'localhost';
  try {
    const { chromium } = require('playwright-core');
    let wsUrl;
    try {
      const r = await fetch(`http://${cdpHost}:${cdpPort}/json/version`, { signal: AbortSignal.timeout(2000) });
      wsUrl = (await r.json()).webSocketDebuggerUrl;
      if (cdpHost !== 'localhost') wsUrl = wsUrl.replace('localhost', cdpHost).replace('127.0.0.1', cdpHost);
    } catch { return res.status(500).json({ error: "Chrome not running" }); }
    const browser = await chromium.connectOverCDP(wsUrl);
    const ctx = browser.contexts()[0];
    // Clear old cookies for this site so user sees fresh login page
    await ctx.clearCookies({ domain: new URL(site.url).hostname }).catch(() => {});
    // Open login page
    const page = await ctx.newPage();
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    _loginState = { active: true, provider: name, status: 'waiting', page, ctx, label: 'LumiChat', cdpPort, cdpHost };
    // Background polling — close page immediately on login detection
    (async () => {
      for (let i = 0; i < 180; i++) { // 3 min timeout
        if (!_loginState.active) return;
        const cookies = await ctx.cookies([site.url]).catch(() => []);
        if (cookies.find(c => c.name === site.cookie && c.value.length > 5)) {
          const allCookies = await ctx.cookies([site.url]).catch(() => []);
          saveCollectorCookies(name, allCookies);
          await page.close().catch(() => {});
          // Update existing account or create one (avoid duplicates)
          if (!Array.isArray(collectorTokens[name])) collectorTokens[name] = [];
          const cred = encryptValue(JSON.stringify({ cdpPort: Number(_loginState.cdpPort), cdpHost: _loginState.cdpHost }), ADMIN_SECRET);
          const existing = collectorTokens[name].find(a => a.enabled);
          if (existing) { existing.credentials = cred; }
          else { collectorTokens[name].push({ id: crypto.randomBytes(8).toString('hex'), label: 'LumiChat', credentials: cred, enabled: true }); }
          saveCollectorTokens(collectorTokens);
          setCollectorHealth(name, true);
          _loginState = { active: false, provider: null, status: 'success' };
          return;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      await page.close().catch(() => {});
      _loginState = { active: false, provider: null, status: 'timeout' };
    })();
    res.json({ status: 'waiting', provider: name });
  } catch (e) {
    _loginState = { active: false, provider: null, status: 'error' };
    res.status(500).json({ error: e.message });
  }
});
app.get("/lc/collector/login/status", requireLcAuth, (req, res) => {
  res.json({ active: _loginState.active, provider: _loginState.provider, status: _loginState.status });
});

// ── SearXNG web search ────────────────────────────────────────────────────
// GET /lc/search?q=... → query SearXNG JSON API, return top results
const SEARXNG_URL = process.env.SEARXNG_URL || "http://lumigate-searxng:8080";
app.get("/lc/search", requireLcAuth, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing query" });
  try {
    const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(q)}&format=json&language=auto&safesearch=0`;
    const r = await fetch(url, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`SearXNG ${r.status}`);
    const data = await r.json();
    const results = (data.results || []).slice(0, 8).map(item => ({
      title: item.title || "",
      url: item.url || "",
      content: (item.content || "").slice(0, 400),
      engine: item.engine || "",
    }));
    res.json({ query: q, results });
  } catch (e) {
    res.status(502).json({ error: `Search unavailable: ${e.message}` });
  }
});

// ── GET /lc/suggest → server-side: search SearXNG + call AI → return 4 suggestion questions
// Avoids client-side chained fetches which are brittle (cookie timing, provider selection)
app.get("/lc/suggest", requireLcAuth, async (req, res) => {
  const memory = (req.query.memory || "").slice(0, 500);
  const lang = req.query.lang === "en" ? "en" : "zh";
  log("info", "lc/suggest called", { user: req.lcUser?.email, lang });
  const today = new Date().toLocaleDateString(lang === "en" ? "en-US" : "zh-CN", { year: "numeric", month: "long", day: "numeric" });

  // 1. Fetch news headlines from SearXNG
  let newsSection = "";
  try {
    const searchQ = lang === "en" ? "today trending news tech AI" : "今日热点新闻科技AI";
    const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(searchQ)}&format=json&language=${lang === "en" ? "en" : "auto"}&safesearch=0`;
    const nr = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
    if (nr.ok) {
      const nd = await nr.json();
      const headlines = (nd.results || []).slice(0, 5).map((r, i) => `${i + 1}. ${r.title}`).join("\n");
      if (headlines) newsSection = lang === "en" ? `\nLatest news:\n${headlines}` : `\n最新新闻（来自搜索引擎）：\n${headlines}`;
    }
  } catch { /* ignore — generate without news */ }

  // 2. Pick cheapest available provider + key (check both multi-key store and env fallback)
  const CHEAP = [
    { p: "deepseek", m: "deepseek-chat" },
    { p: "minimax", m: "MiniMax-M1" },
    { p: "qwen", m: "qwen-turbo" },
    { p: "openai", m: "gpt-4.1-nano" },
    { p: "gemini", m: "gemini-2.5-flash-lite" },
  ];
  let pick = null, pickApiKey = null;
  for (const c of CHEAP) {
    const prov = PROVIDERS[c.p];
    if (!prov) continue;
    // prefer multi-key store; fall back to env key
    const keyInfo = selectApiKey(c.p, "_lumichat");
    const apiKey = keyInfo?.apiKey || prov.apiKey;
    if (apiKey) { pick = c; pickApiKey = apiKey; break; }
  }
  if (!pick) return res.status(503).json({ error: "No AI provider available" });

  // 3. Build prompt — language follows UI setting
  const LANG_NAMES = { en: "English", zh: "Chinese (Simplified)", ja: "Japanese", ko: "Korean", fr: "French", de: "German", es: "Spanish" };
  const langName = LANG_NAMES[lang] || "English";
  const memSection = memory ? (lang === "en" ? `\nUser background:\n${memory}` : `\n用户背景信息（全局记忆）：\n${memory}`) : "";
  const prompt = lang !== "zh"
    ? `Today is ${today}. Generate 4 homepage suggestion questions for an AI chat interface.

These are questions the USER would ask the AI, not questions about the AI itself.
Never: "What's your favorite...", "How do you feel about...", "As an AI..."

Good examples (specific, practical, things people actually search):
- "How to handle rate limiting in a REST API?"
- "What was announced at the latest Apple event?"
- "Create a weekly meal prep plan for me"
- "What's the weather like for running today?"

Rules:
- ALL questions MUST be in ${langName}. This is the user's UI language — do not use any other language.
- If user background exists, tailor questions to their job/interests
- Other questions should reference recent news events
- Each question MUST be under 8 words, fits on one line
- Casual tone, like typing in a search bar${memSection}${newsSection}

Output ONLY a JSON array of 4 English strings. No explanation or markdown. Example: ["Latest AI news?","Best Python web framework?","Help me plan a trip","What happened at WWDC?"]`
    : `今天是${today}。为一个 AI 助手对话界面生成 4 个首页推荐问题，供用户点击发起对话。

这些问题是"用户想向 AI 提问的内容"，不是问 AI 自身感受或观点的问题。
绝对禁止："你最喜欢/感兴趣的是什么"、"你怎么看"、"作为AI你如何"——这类问 AI 自己的废话。

好的问题示例（具体、实用、用户真正会问的）：
- "Python 写爬虫被反爬了怎么处理？"
- "苹果最新发布会有哪些亮点？"
- "帮我写一个每日任务清单模板"
- "今天适合出去跑步吗，北京天气怎样？"

要求：
- 如果有用户背景，结合其职业/兴趣生成用户**真正会遇到的问题**（如"某技术怎么用"、"某场景怎么解决"），不是问 AI 对该领域的看法
- 其余问题基于最新新闻事件，问的是"这件事是什么/为什么/有什么影响"
- 每个问题严格不超过 15 个字（中文）或 8 个英文单词，必须一行显示完，绝对不能太长
- 口语化，像真人在搜索框里打的那种${memSection}${newsSection}

只输出一个 JSON 数组，包含 4 个字符串，不要任何解释或 markdown。示例：["问题1","问题2","问题3","问题4"]`;

  // 4. Call AI provider directly
  try {
    const prov = PROVIDERS[pick.p];
    const aiRes = await fetch(`${prov.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${pickApiKey}` },
      body: JSON.stringify({ model: pick.m, messages: [{ role: "user", content: prompt }], max_tokens: 300, temperature: 0.85, stream: false }),
      signal: AbortSignal.timeout(20000),
    });
    if (!aiRes.ok) return res.status(502).json({ error: `AI error ${aiRes.status}` });
    const j = await aiRes.json();
    const text = j.choices?.[0]?.message?.content || "";
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return res.status(502).json({ error: "Bad AI response" });
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr) || arr.length < 2) return res.status(502).json({ error: "Bad AI response" });
    res.json({ suggestions: arr.slice(0, 4).map(s => String(s).trim()).filter(Boolean) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── lc_user_settings ──────────────────────────────────────────────────────
// GET /lc/user/settings → get or create settings record for current user
app.get("/lc/user/settings", requireLcAuth, async (req, res) => {
  try {
    const r = await pbListOwnedRecords("userSettings", { ownerId: req.lcUser.id, token: req.lcToken });
    const d = await r.json();
    const record = d.items?.[0] || null;
    if (record) return res.json(record);
    // Auto-create empty settings for this user
    const cr = await lcPbFetch("/api/collections/lc_user_settings/records", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.lcToken}` },
      body: JSON.stringify({ user: req.lcUser.id, sensitivity: "default", theme: "auto", compact: false, presets: [] }),
    });
    const created = await cr.json();
    res.status(cr.status).json(created);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// PATCH /lc/user/settings → update settings (upsert)
app.patch("/lc/user/settings", requireLcAuth, async (req, res) => {
  try {
    const body = pickAllowedFields(req.body, getLcCollectionConfig("userSettings").writableFields);

    // Find existing record
    const fr = await pbListOwnedRecords("userSettings", { ownerId: req.lcUser.id, token: req.lcToken });
    const fd = await fr.json();
    const existing = fd.items?.[0];

    let r;
    if (existing) {
      r = await lcPbFetch(`/api/collections/lc_user_settings/records/${existing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.lcToken}` },
        body: JSON.stringify(body),
      });
    } else {
      r = await lcPbFetch("/api/collections/lc_user_settings/records", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.lcToken}` },
        body: JSON.stringify({ user: req.lcUser.id, sensitivity: "default", theme: "dark", compact: false, presets: [], ...body }),
      });
    }
    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── lc_projects ───────────────────────────────────────────────────────────
// GET /lc/projects → list user's projects
app.get("/lc/projects", requireLcAuth, async (req, res) => {
  try {
    const r = await pbListOwnedRecords("projects", {
      ownerId: req.lcUser.id,
      token: req.lcToken,
      extraFilters: withSoftDeleteFilters("projects", {
        extraFilters: buildPbFiltersFromQuery("projects", req.query),
        includeDeleted: String(req.query.include_deleted || "") === "1",
      }),
      sort: buildPbSortFromQuery("projects", req.query.sort) || ["sort_order", "id"],
      perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// POST /lc/projects → create project
app.post("/lc/projects", requireLcAuth, async (req, res) => {
  try {
    const r = await createLcProjectRecord({ lcToken: req.lcToken, userId: req.lcUser.id, input: req.body || {} });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// PATCH /lc/projects/:id → update project
app.patch("/lc/projects/:id", requireLcAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid ID" });
  const body = sanitizeLcProjectPayload(req.body || {});
  try {
    const r = await lcPbFetch(`/api/collections/lc_projects/records/${req.params.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.lcToken}` },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// GET /lc/projects/:id/references → inspect dependent records before delete/remap
app.get("/lc/projects/:id/references", requireLcAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const references = await listReferencingRecords({
      domainKey: "lc",
      sourceCollectionKey: "projects",
      ownerId: req.lcUser.id,
      token: req.lcToken,
      recordId: req.params.id,
    });
    res.json({
      id: req.params.id,
      deletePolicy: getDomainCollectionPolicy("lc", "projects").deletePolicy,
      references,
    });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// POST /lc/projects/:id/remap → move dependent sessions to another project before delete
app.post("/lc/projects/:id/remap", requireLcAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const { target_project_id: targetProjectId, delete_source: deleteSource = false } = req.body || {};
    const remap = await remapLcProjectReferences({
      ownerId: req.lcUser.id,
      token: req.lcToken,
      sourceId: req.params.id,
      targetId: targetProjectId,
    });

    let deleted = false;
    if (deleteSource) {
      await assertNoBlockingReferences({
        domainKey: "lc",
        sourceCollectionKey: "projects",
        ownerId: req.lcUser.id,
        token: req.lcToken,
        recordId: req.params.id,
      });
      const delResp = await lcPbFetch(`/api/collections/lc_projects/records/${req.params.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${req.lcToken}` },
      });
      if (!delResp.ok) {
        const delData = await delResp.json().catch(() => ({}));
        return res.status(delResp.status).json({ error: pbErrorSummary(delData, "Project delete failed after remap"), remap });
      }
      deleted = true;
    }

    res.json({ ok: true, remap, deleted });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// DELETE /lc/projects/:id → delete project
app.delete("/lc/projects/:id", requireLcAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    if (isLcSoftDeleteEnabled() && !isHardDeleteRequested(req)) {
      const data = await softDeleteRecord("projects", {
        id: req.params.id,
        token: req.lcToken,
        userId: req.lcUser.id,
        reason: req.body?.reason || "user_deleted",
      });
      return res.json({ success: true, mode: "soft", data });
    }
    await assertNoBlockingReferences({
      domainKey: "lc",
      sourceCollectionKey: "projects",
      ownerId: req.lcUser.id,
      token: req.lcToken,
      recordId: req.params.id,
    });
    const r = await lcPbFetch(`/api/collections/lc_projects/records/${req.params.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${req.lcToken}` },
    });
    res.status(r.status).json({ success: r.ok });
  } catch (e) {
    const body = e.references ? { error: e.message, references: e.references } : { error: e.message };
    res.status(e.status || 502).json(body);
  }
});

// GET /lc/sessions → list user's sessions
app.get("/lc/sessions", requireLcAuth, async (req, res) => {
  try {
    const r = await pbListOwnedRecords("sessions", {
      ownerId: req.lcUser.id,
      token: req.lcToken,
      extraFilters: withSoftDeleteFilters("sessions", {
        extraFilters: buildPbFiltersFromQuery("sessions", req.query),
        includeDeleted: String(req.query.include_deleted || "") === "1",
      }),
      sort: buildPbSortFromQuery("sessions", req.query.sort) || lcDefaultSort("sessions", ["id"]),
      perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch {
    res.status(502).json({ error: "PocketBase unavailable" });
  }
});

// POST /lc/sessions → create session
app.post("/lc/sessions", requireLcAuth, async (req, res) => {
  try {
    const now = lcNowIso();
    const body = {
      user: req.lcUser.id,
      title: req.body?.title || "New Chat",
      provider: req.body?.provider || "openai",
      model: req.body?.model || "gpt-4.1-mini",
    };
    if (lcSupportsField("sessions", "created_at")) body.created_at = now;
    if (lcSupportsField("sessions", "updated_at")) body.updated_at = now;
    if (req.body?.project && validPbId(req.body.project)) body.project = req.body.project;
    const r = await lcPbFetch("/api/collections/lc_sessions/records", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.lcToken}` },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch {
    res.status(502).json({ error: "PocketBase unavailable" });
  }
});

// PATCH /lc/sessions/:id/title → update title
app.patch("/lc/sessions/:id/title", requireLcAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid session ID" });
  try {
    const { title } = req.body || {};
    if (!title || typeof title !== "string") return res.status(400).json({ error: "Missing title" });
    const body = { title: title.slice(0, 200) };
    if (lcSupportsField("sessions", "updated_at")) body.updated_at = lcNowIso();
    const r = await lcPbFetch(`/api/collections/lc_sessions/records/${req.params.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.lcToken}` },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch {
    res.status(502).json({ error: "PocketBase unavailable" });
  }
});

// PATCH /lc/sessions/:id/model → update provider/model
app.patch("/lc/sessions/:id/model", requireLcAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid session ID" });
  try {
    const { provider, model } = req.body || {};
    if (!provider || !model) return res.status(400).json({ error: "Missing provider or model" });
    const body = { provider, model };
    if (lcSupportsField("sessions", "updated_at")) body.updated_at = lcNowIso();
    const r = await lcPbFetch(`/api/collections/lc_sessions/records/${req.params.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.lcToken}` },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch {
    res.status(502).json({ error: "PocketBase unavailable" });
  }
});

// DELETE /lc/sessions/:id → delete session (PB cascades messages + files)
app.delete("/lc/sessions/:id", requireLcAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid session ID" });
  try {
    if (isLcSoftDeleteEnabled() && !isHardDeleteRequested(req)) {
      const data = await softDeleteRecord("sessions", {
        id: req.params.id,
        token: req.lcToken,
        userId: req.lcUser.id,
        reason: req.body?.reason || "user_deleted",
      });
      return res.json({ success: true, mode: "soft", data });
    }
    const r = await lcPbFetch(`/api/collections/lc_sessions/records/${req.params.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${req.lcToken}` },
    });
    if (r.status === 204 || r.ok) return res.json({ ok: true });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch {
    res.status(502).json({ error: "PocketBase unavailable" });
  }
});

// GET /lc/sessions/:id/messages → list messages
app.get("/lc/sessions/:id/messages", requireLcAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid session ID" });
  try {
    const r = await pbListOwnedRecords("messages", {
      token: req.lcToken,
      extraFilters: withSoftDeleteFilters("messages", {
        extraFilters: [buildPbFilterClause("session", "=", req.params.id), ...buildPbFiltersFromQuery("messages", req.query)],
        includeDeleted: String(req.query.include_deleted || "") === "1",
      }),
      sort: buildPbSortFromQuery("messages", req.query.sort) || lcDefaultSort("messages", ["id"]),
      perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch {
    res.status(502).json({ error: "PocketBase unavailable" });
  }
});

// POST /lc/messages → create message record
app.post("/lc/messages", requireLcAuth, async (req, res) => {
  try {
    const { session, role, content, file_ids } = req.body || {};
    if (!session || !role || !content) return res.status(400).json({ error: "Missing required fields" });
    await assertLcSessionOwned(session, { ownerId: req.lcUser.id, token: req.lcToken });
    const now = lcNowIso();
    const body = { session, role, content: clampPbMessageContent(content), file_ids: file_ids || [] };
    if (lcSupportsField("messages", "created_at")) body.created_at = now;
    if (lcSupportsField("messages", "updated_at")) body.updated_at = now;
    const r = await lcPbFetch("/api/collections/lc_messages/records", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.lcToken}` },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      log("warn", "lc message create failed", { status: r.status, role, session, error: pbErrorSummary(data) });
      return res.status(r.status).json({ ...data, error: pbErrorSummary(data, "Message save failed") });
    }
    try {
      await touchLcSession(session, req.lcToken);
    } catch (err) {
      log("warn", "lc session touch failed", { session, error: err.message });
    }
    res.status(r.status).json(data);
  } catch (err) {
    const status = Number(err?.status) || 502;
    const message = err?.message || "PocketBase unavailable";
    log("error", "lc message create exception", { error: err.message, status });
    res.status(status).json({ error: message });
  }
});

// DELETE /lc/messages/:id → delete a message from PB
app.delete("/lc/messages/:id", requireLcAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid message ID" });
  try {
    if (isLcSoftDeleteEnabled() && !isHardDeleteRequested(req)) {
      const data = await softDeleteRecord("messages", {
        id: req.params.id,
        token: req.lcToken,
        userId: req.lcUser.id,
        reason: req.body?.reason || "user_deleted",
      });
      return res.json({ success: true, mode: "soft", data });
    }
    await assertRecordOwned("messages", { id: req.params.id, ownerId: req.lcUser.id, token: req.lcToken });
    const r = await lcPbFetch(`/api/collections/lc_messages/records/${req.params.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${req.lcToken}` },
    });
    if (r.status === 204 || r.ok) return res.json({ success: true });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(Number(err?.status) || 502).json({ error: err?.message || "PocketBase unavailable" });
  }
});

// GET /lc/trash → list soft-deleted records
app.get("/lc/trash", requireLcAuth, async (req, res) => {
  if (!isLcSoftDeleteEnabled()) return res.status(400).json({ error: "Soft delete is disabled. Enable lcSoftDeleteEnabled in settings or set LC_SOFT_DELETE_ENABLED=1" });
  const collectionMap = { projects: "projects", sessions: "sessions", messages: "messages", files: "files" };
  const requested = String(req.query.collection || "all");
  const keys = requested === "all" ? Object.keys(collectionMap) : [requested];
  const invalid = keys.find((k) => !collectionMap[k]);
  if (invalid) return res.status(400).json({ error: `Unsupported trash collection: ${invalid}` });
  try {
    const all = [];
    for (const key of keys) {
      const configKey = collectionMap[key];
      const r = await pbListOwnedRecords(configKey, {
        ownerId: req.lcUser.id,
        token: req.lcToken,
        extraFilters: withSoftDeleteFilters(configKey, { trashOnly: true }),
        sort: ["-deleted_at", "-id"],
        perPage: req.query.perPage ? Number(req.query.perPage) : 100,
      });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json(d);
      for (const item of d.items || []) all.push({ collection: key, ...item });
    }
    all.sort((a, b) => new Date(b.deleted_at || 0).getTime() - new Date(a.deleted_at || 0).getTime());
    res.json({ items: all, totalItems: all.length });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// POST /lc/trash/:collection/:id/restore → restore soft-deleted record
app.post("/lc/trash/:collection/:id/restore", requireLcAuth, async (req, res) => {
  if (!isLcSoftDeleteEnabled()) return res.status(400).json({ error: "Soft delete is disabled. Enable lcSoftDeleteEnabled in settings or set LC_SOFT_DELETE_ENABLED=1" });
  const collectionMap = { projects: "projects", sessions: "sessions", messages: "messages", files: "files" };
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid ID" });
  const configKey = collectionMap[req.params.collection];
  if (!configKey) return res.status(400).json({ error: "Unsupported trash collection" });
  try {
    const data = await restoreSoftDeletedRecord(configKey, { id: req.params.id, token: req.lcToken });
    res.json({ success: true, data });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// PATCH /lc/messages/:id → update message content/file_ids in PB
app.patch("/lc/messages/:id", requireLcAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid message ID" });
  try {
    await assertRecordOwned("messages", { id: req.params.id, ownerId: req.lcUser.id, token: req.lcToken });
    const body = {};
    if (typeof req.body?.content === "string") body.content = clampPbMessageContent(req.body.content);
    if (Array.isArray(req.body?.file_ids)) body.file_ids = req.body.file_ids;
    if (!Object.keys(body).length) return res.status(400).json({ error: "No updatable fields provided" });
    if (lcSupportsField("messages", "updated_at")) body.updated_at = lcNowIso();

    const r = await lcPbFetch(`/api/collections/lc_messages/records/${req.params.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.lcToken}` },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      log("warn", "lc message patch failed", { status: r.status, messageId: req.params.id, error: pbErrorSummary(data) });
      return res.status(r.status).json({ ...data, error: pbErrorSummary(data, "Message update failed") });
    }
    res.status(r.status).json(data);
  } catch (err) {
    const status = Number(err?.status) || 502;
    const message = err?.message || "PocketBase unavailable";
    log("error", "lc message patch exception", { error: err.message, status, messageId: req.params.id });
    res.status(status).json({ error: message });
  }
});

// POST /lc/files → upload file to PB
app.post("/lc/files", requireLcAuth, lcUpload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const tmpPath = req.file.path;
  try {
    const { session } = req.body || {};
    if (!session) { fs.unlink(tmpPath, () => {}); return res.status(400).json({ error: "Missing session" }); }
    await assertLcSessionOwned(session, { ownerId: req.lcUser.id, token: req.lcToken });

    // Stream file to PB without loading into heap (avoids OOM on large uploads)
    const now = lcNowIso();
    const originalName = String(req.file.originalname || "file");
    const fileName = path.basename(originalName).replace(/"/g, '_');
    const ext = path.extname(originalName).toLowerCase();
    const mimeType = detectLcUploadMime(originalName, req.file.mimetype);
    const kind = lcFileKindByMimeOrExt(mimeType, originalName);
    const extraction = await extractTextForLcUpload(tmpPath, originalName, mimeType);
    const boundary = `LumiGate${crypto.randomBytes(8).toString('hex')}`;

    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="session"\r\n\r\n${session}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="user"\r\n\r\n${req.lcUser.id}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="mime_type"\r\n\r\n${mimeType}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="size_bytes"\r\n\r\n${req.file.size}`,
    ];
    if (lcSupportsField("files", "original_name")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="original_name"\r\n\r\n${lcUploadSafeName(originalName)}`);
    if (lcSupportsField("files", "ext")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="ext"\r\n\r\n${ext}`);
    if (lcSupportsField("files", "kind")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}`);
    if (lcSupportsField("files", "parse_status")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="parse_status"\r\n\r\n${extraction.status}`);
    if (lcSupportsField("files", "parse_error")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="parse_error"\r\n\r\n${extraction.error || ""}`);
    if (lcSupportsField("files", "parsed_at")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="parsed_at"\r\n\r\n${extraction.parsedAt || ""}`);
    if (lcSupportsField("files", "created_at")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="created_at"\r\n\r\n${now}`);
    if (lcSupportsField("files", "updated_at")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="updated_at"\r\n\r\n${now}`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="extracted_text"\r\n\r\n${extraction.text}`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const multipartHead = parts.join('\r\n');

    const pt = new PassThrough();
    pt.write(Buffer.from(multipartHead));
    const fileStream = fs.createReadStream(tmpPath);
    fileStream.on('error', e => pt.destroy(e));
    fileStream.on('end', () => { pt.write(Buffer.from(`\r\n--${boundary}--\r\n`)); pt.end(); });
    fileStream.pipe(pt, { end: false });

    // Use direct PB path for stream uploads: scoped->fallback retries cannot safely reuse a consumed stream body.
    const r = await pbFetch("/api/collections/lc_files/records", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${req.lcToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: pt,
      duplex: 'half',
    });
    const data = await r.json();
    fs.unlink(tmpPath, () => {}); // cleanup temp file
    if (!r.ok) return res.status(r.status).json(data);
    // Return file record with accessible URL
    const fileUrl = `/lc/files/serve/${data.id}`;
    res.json({ id: data.id, url: fileUrl, mime_type: mimeType, size_bytes: req.file.size });
  } catch (err) {
    fs.unlink(tmpPath, () => {});
    const status = Number(err?.status) || 500;
    const message = err?.message || "File upload failed";
    log("error", "lcUploadFile error", { error: err.message, status });
    res.status(status).json({ error: message });
  }
});

// GET /lc/files/serve/:id → stream file from PB to browser
app.get("/lc/files/serve/:id", requireLcAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid file ID" });
  try {
    // First get the record to get the filename
    const recR = await lcPbFetch(`/api/collections/lc_files/records/${req.params.id}`, {
      headers: { Authorization: `Bearer ${req.lcToken}` },
    });
    if (!recR.ok) return res.status(recR.status).json({ error: "File not found" });
    const rec = await recR.json();
    // PB file URL: /api/files/{collectionId}/{recordId}/{filename}
    const fileR = await lcPbFetch(`/api/files/lc_files/${rec.id}/${rec.file}`, {
      headers: { Authorization: `Bearer ${req.lcToken}` },
    });
    if (!fileR.ok) return res.status(fileR.status).json({ error: "File fetch failed" });
    res.setHeader("Content-Type", rec.mime_type || "application/octet-stream");
    const safeFileName = path.basename(rec.file || 'download').replace(/"/g, '_');
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}"`);
    // Stream response body
    const readable = Readable.fromWeb(fileR.body);
    readable.on('error', (streamErr) => {
      log('error', 'lcServeFile stream error', { error: streamErr.message });
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    readable.pipe(res);
  } catch (err) {
    log("error", "lcServeFile error", { error: err.message });
    res.status(500).json({ error: "Failed to serve file" });
  }
});

// POST /lc/files/gemini-upload/:pbFileId → upload PB file to Gemini File API
app.post("/lc/files/gemini-upload/:pbFileId", requireLcAuth, async (req, res) => {
  if (!validPbId(req.params.pbFileId)) return res.status(400).json({ error: "Invalid file ID" });
  try {
    // Get file record
    const recR = await lcPbFetch(`/api/collections/lc_files/records/${req.params.pbFileId}`, {
      headers: { Authorization: `Bearer ${req.lcToken}` },
    });
    if (!recR.ok) return res.status(404).json({ error: "File not found" });
    const rec = await recR.json();

    // Fetch file bytes from PB
    const fileR = await lcPbFetch(`/api/files/lc_files/${rec.id}/${rec.file}`, {
      headers: { Authorization: `Bearer ${req.lcToken}` },
    });
    if (!fileR.ok) return res.status(502).json({ error: "Failed to fetch file from PB" });

    // Get Gemini API key
    const geminiKey = selectApiKey("gemini", "_lumichat")?.apiKey || PROVIDERS.gemini?.apiKey;
    if (!geminiKey) return res.status(503).json({ error: "No Gemini key configured" });

    // Stream PB response body directly to Gemini — avoids buffering into heap
    const uploadRes = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=media&key=${geminiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": rec.mime_type || "application/octet-stream",
          "X-Goog-Upload-Protocol": "raw",
        },
        body: fileR.body,
        // @ts-ignore — duplex required for streaming body in Node fetch
        duplex: 'half',
      }
    );
    if (!uploadRes.ok) {
      const errData = await uploadRes.text();
      return res.status(502).json({ error: "Gemini upload failed", details: errData });
    }
    const uploadData = await uploadRes.json();
    const geminiFileUri = uploadData.file?.uri;
    const geminiFileName = uploadData.file?.name; // e.g. "files/abc123"
    if (!geminiFileUri) return res.status(502).json({ error: "Gemini did not return file URI" });

    // Poll until ACTIVE (video processing can take a few seconds)
    const geminiKey2 = (selectApiKey("gemini", "_lumichat") || {}).apiKey || PROVIDERS.gemini?.apiKey;
    let state = uploadData.file?.state || "PROCESSING";
    let attempts = 0;
    while (state !== "ACTIVE" && attempts < 20) {
      await new Promise(r => setTimeout(r, 2000));
      attempts++;
      try {
        const poll = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/${geminiFileName}?key=${geminiKey2}`
        );
        if (poll.ok) {
          const pd = await poll.json();
          state = pd.state || state;
        }
      } catch { /* keep polling */ }
    }
    if (state !== "ACTIVE") return res.status(502).json({ error: `Gemini file not ready (state: ${state})` });

    res.json({ geminiFileUri });
  } catch (err) {
    log("error", "lcGeminiUpload error", { error: err.message });
    res.status(500).json({ error: "Gemini upload failed" });
  }
});

// POST /lc/chat/gemini-native → Gemini native API for video/PDF/audio via File API
// Body: { model, messages (OpenAI fmt), stream }
// Converts file_data parts to Gemini inlineData/fileData format, calls native API
app.post("/lc/chat/gemini-native", requireLcAuth, express.json({ limit: "1mb" }), async (req, res) => {
  const { model = "gemini-2.5-flash", messages = [], stream = false } = req.body || {};

  const geminiKey = (selectApiKey("gemini", "_lumichat") || {}).apiKey || PROVIDERS.gemini?.apiKey;
  if (!geminiKey) return res.status(503).json({ error: "No Gemini key configured" });

  // Convert OpenAI-format messages → Gemini native format
  function convertPart(p) {
    if (typeof p === "string") return { text: p };
    if (p.type === "text") return { text: p.text || "" };
    if (p.type === "image_url") {
      const url = p.image_url?.url || "";
      if (url.startsWith("data:")) {
        const [meta, b64] = url.split(",");
        const mime = meta.replace("data:", "").replace(";base64", "");
        return { inlineData: { mimeType: mime, data: b64 } };
      }
      return { fileData: { mimeType: "image/jpeg", fileUri: url } };
    }
    if (p.type === "file_data") {
      return { fileData: { mimeType: p.file_data?.mime_type || "application/octet-stream", fileUri: p.file_data?.file_uri } };
    }
    if (p.type === "input_audio") {
      return { inlineData: { mimeType: `audio/${p.input_audio?.format || "wav"}`, data: p.input_audio?.data || "" } };
    }
    return { text: JSON.stringify(p) };
  }

  const systemTexts = [];
  const contents = messages
    .filter(m => {
      if (m.role === "system") {
        const text = Array.isArray(m.content)
          ? m.content.map(p => (typeof p === "string" ? p : p?.text || "")).join("\n\n")
          : (m.content || "");
        if (text.trim()) systemTexts.push(text.trim());
        return false;
      }
      return true;
    })
    .map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: Array.isArray(m.content)
        ? m.content.map(convertPart)
        : [{ text: m.content || "" }],
    }));

  const contentSummary = contents.map((m, idx) => ({
    idx,
    role: m.role,
    parts: (m.parts || []).map(p => p.text ? "text" : p.inlineData ? `inline:${p.inlineData.mimeType}` : p.fileData ? `file:${p.fileData.mimeType}` : "unknown"),
  }));
  log("info", "lcGeminiNative request", {
    model,
    stream: !!stream,
    systemCount: systemTexts.length,
    messageCount: contents.length,
    contentSummary,
  });

  const endpoint = stream
    ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${geminiKey}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(systemTexts.length ? { systemInstruction: { parts: [{ text: systemTexts.join("\n\n") }] } } : {}),
        contents,
      }),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      return res.status(upstream.status).json({ error: "Gemini error", details: err.substring(0, 500) });
    }

    if (!stream) {
      const data = await upstream.json();
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
      log("info", "lcGeminiNative response", { model, textPreview: text.slice(0, 160) });
      return res.json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] });
    }

    // SSE streaming — convert Gemini SSE → OpenAI SSE format
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let finalFinishReason = "stop";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          const j = JSON.parse(raw);
          const text = j.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
          const finishReason = j.candidates?.[0]?.finishReason || j.candidates?.[0]?.finish_reason || "";
          if (finishReason) finalFinishReason = String(finishReason).toLowerCase();
          if (text) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
          }
        } catch { /* skip malformed */ }
      }
    }
    log("info", "lcGeminiNative stream completed", { model, finishReason: finalFinishReason });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finalFinishReason === "max_tokens" ? "length" : finalFinishReason }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    log("error", "lcGeminiNative error", { error: err.message });
    if (!res.headersSent) res.status(500).json({ error: "Gemini native request failed" });
    else res.end();
  }
});

// ── Clean Chat Proxy: POST /v1/chat ──────────────────────────────────────────
// Universal endpoint — all apps (LumiChat, FurNote, etc.) get:
//   1. Clean SSE text (no tool tags, no DSML, no XML)
//   2. event: tool_status (grey status text, pre-formatted)
//   3. event: file_download (download card data)
// All tool handling happens server-side. Frontend is just a display.

// --- Pre-search helpers ---
function needsWebSearch(text) {
  if (!text || text.length < 2) return false;
  // Broad detection — if there's any chance the question needs fresh data, search.
  // Better to search unnecessarily than to miss a time-sensitive query.
  return [
    // Explicit search intent
    /搜[索一下]|查[找一下询]|帮我[找查搜]/,
    // Time-sensitive signals (CN)
    /最新|最近|今[天日年]|昨[天日]|本[周月年]|上[周月]|这[几两]天|近[期来日]|目前|现在|当前|实时|刚[刚才]|新出/,
    // Topic signals — likely needs current data (CN)
    /新闻|天气|价格|股[价票]|汇率|发布|上线|更新|升级|版本|政策|法规|赛[事程]|比分|排[名行]|榜|票房|疫情|选举/,
    // Change/trend signals (CN)
    /变化|变动|趋势|走势|动态|进展|消息|情况|怎[么样]样了|有什么/,
    // English equivalents
    /search|look\s?up|latest|current|today|yesterday|this\s(?:week|month|year)|recent|now|just\s|new\s/i,
    /news|weather|price|stock|release|update|version|score|ranking|election/i,
    /what.?(?:happen|change|going\son)|how\smuch|who\s(?:is|won|died)|when\sdid/i,
    // Recommendation/comparison (often need current data)
    /best\s|top\s\d|recommend|comparison|vs\s|versus|alternative|worth\s/i,
    /推荐|对比|哪个好|值得|排行|评测|测评/,
  ].some(p => p.test(text));
}

function extractSearchQuery(text) {
  return text
    .replace(/^(搜索?|查[找询一下]*|帮我|请|search|look\s?up|find\s+me|what is|who is|tell me about)\s*/i, "")
    .slice(0, 200).trim() || text.slice(0, 200);
}

async function executeWebSearchForChat(query, timeRange = "month") {
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&language=auto&safesearch=0${timeRange ? `&time_range=${timeRange}` : ""}`;
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`SearXNG ${r.status}`);
  const data = await r.json();
  return (data.results || []).slice(0, 6).map(item => ({
    title: item.title || "", url: item.url || "", content: (item.content || "").slice(0, 400),
  }));
}

function formatSearchContext(results) {
  if (!results.length) return "";
  return "[Web Search Results]\n" + results.map((r, i) =>
    `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content}`
  ).join("\n\n");
}

// --- Provider URL/headers/body builders ---
function getChatUrl(providerName, provider) {
  const base = provider.baseUrl;
  if (providerName === "anthropic") return `${base}/v1/messages`;
  if (providerName === "gemini") return `${base}/v1beta/openai/chat/completions`;
  if (providerName === "doubao") return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function getChatHeaders(providerName, apiKey) {
  if (providerName === "anthropic") {
    return { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

// Default max output tokens per provider — models that support higher limits get more room
// This prevents long-form generation (file creation, DCF analysis, etc.) from cutting off mid-output
// No max_tokens limit — let each provider use its own maximum
// Only Anthropic requires max_tokens (API mandate)
function getMaxTokens(providerName, model) {
  // Anthropic API requires max_tokens field; use model maximum
  if (providerName === "anthropic") {
    if (/opus/.test(model)) return 32768;
    if (/sonnet-4-6/.test(model)) return 16384;
    if (/sonnet/.test(model)) return 8192;
    return 8192; // haiku etc
  }
  return undefined; // omit → provider uses its own max
}

function buildChatBody(providerName, model, messages, systemPrompt, stream) {
  const maxTok = getMaxTokens(providerName, model);
  if (providerName === "anthropic") {
    const sysMessages = messages.filter(m => m.role === "system");
    const nonSysMessages = messages.filter(m => m.role !== "system");
    let system = sysMessages.map(m => m.content).join("\n\n");
    if (systemPrompt) system = system ? systemPrompt + "\n\n" + system : systemPrompt;
    return {
      model, max_tokens: maxTok, stream,
      system: system || undefined,
      messages: nonSysMessages.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    };
  }
  // OpenAI-compatible providers
  // User's system prompt has highest priority — put server prompts BEFORE it
  const msgs = [...messages];
  if (systemPrompt) {
    const sysMsg = msgs.find(m => m.role === "system");
    if (sysMsg) sysMsg.content = systemPrompt + "\n\n" + (sysMsg.content || "");
    else msgs.unshift({ role: "system", content: systemPrompt });
  }
  return { model, max_tokens: maxTok, stream, messages: msgs, stream_options: stream ? { include_usage: true } : undefined };
}

// Tool tag markers for the clean SSE pipe
const TOOL_TAG_MARKERS = [
  "[TOOL:", "<｜DSML｜function_calls>", "<︱DSML︱function_calls>",
  "<|DSML|function_calls>", "<minimax:tool_call>", "<tool_call>",
];

app.post("/v1/chat", apiLimiter, express.json({ limit: "1mb" }), async (req, res) => {
  const { provider: providerName, model: modelId, messages, stream: wantStream = true } = req.body || {};
  if (!providerName || !modelId || !Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "Missing required fields: provider, model, messages (array)" });
  }
  const provider = PROVIDERS[providerName?.toLowerCase()];
  if (!provider) return res.status(400).json({ error: "Unknown or unsupported provider" });

  // i18n for tool_status messages — follows client lang param or Accept-Language
  const lang = req.body.lang || (req.headers["accept-language"]?.startsWith("zh") ? "zh" : "en");
  const L = lang === "zh"
    ? { searching: q => `正在搜索: ${q}`, searchDone: n => `搜索完成，找到 ${n} 条结果`, processing: "正在处理...", genExcel: t => `正在生成 Excel: ${t}`, genDoc: t => `正在生成文档: ${t}`, genPPT: t => `正在生成 PPT: ${t}`, toolDone: (n, s) => `${n} 已生成 (${s})`, toolLabel: n => ({ web_search:"搜索", generate_spreadsheet:"生成 Excel", generate_document:"生成文档", generate_presentation:"生成 PPT", use_template:"使用模板" }[n] || n.replace(/_/g," ")) }
    : { searching: q => `Searching: ${q}`, searchDone: n => `Found ${n} results`, processing: "Processing...", genExcel: t => `Generating Excel: ${t}`, genDoc: t => `Generating document: ${t}`, genPPT: t => `Generating PPT: ${t}`, toolDone: (n, s) => `${n} generated (${s})`, toolLabel: n => ({ web_search:"Search", generate_spreadsheet:"Generate Excel", generate_document:"Generate document", generate_presentation:"Generate PPT", use_template:"Use template" }[n] || n.replace(/_/g," ")) };

  // ── Auth: LumiChat cookie → admin session → project key/HMAC/token ──
  let projectName, lcUserId;
  const projectKey = req.headers["x-project-key"] || (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const lcCookies = parseCookies(req);
  const lcToken = lcCookies.lc_token;

  if (safeEqual(projectKey, INTERNAL_CHAT_KEY)) {
    projectName = "_chat";
  } else if (["root", "admin"].includes(getSessionRole(req))) {
    projectName = "_chat";
  } else if (!projectKey && lcToken) {
    const lcPayload = validateLcTokenPayload(lcToken);
    if (lcPayload) {
      projectName = "_lumichat";
      if (lcPayload.id) lcUserId = lcPayload.id;
    }
  }
  if (!projectName) {
    if (projectKey.startsWith("et_")) {
      const tokenInfo = ephemeralTokens.get(projectKey);
      if (!tokenInfo || Date.now() > tokenInfo.expiresAt) return res.status(401).json({ error: "Token expired or invalid" });
      if (!tokenInfo.project.enabled) return res.status(403).json({ error: "Project disabled" });
      projectName = tokenInfo.project.name;
    } else if (req.headers["x-signature"]) {
      const projId = req.headers["x-project-id"];
      if (projId) {
        const candidate = projects.find(p => p.enabled && p.name === projId && p.authMode === "hmac");
        if (candidate) {
          const hmacResult = verifyHmacSignature(candidate, req);
          if (!hmacResult.ok) return res.status(401).json({ error: hmacResult.error });
          projectName = candidate.name;
        }
      }
      if (!projectName) return res.status(401).json({ error: "HMAC verification failed" });
    } else {
      const proj = ((k) => { const _p = projectKeyIndex.get(k); return _p && _p.enabled ? _p : undefined; })(projectKey);
      if (!proj) return res.status(401).json({ error: "Invalid or missing credentials" });
      if (proj.authMode === "hmac") return res.status(403).json({ error: "This project requires HMAC signature authentication" });
      projectName = proj.name;
    }
  }

  // Resolve project object for policy checks
  const proj = projects.find(p => p.name === projectName) || {};

  // Per-project model allowlist (data may use either field name)
  const modelAllowlist = proj.allowedModels || proj.modelAllowlist;
  if (modelAllowlist?.length && !modelAllowlist.includes(modelId)) {
    return res.status(403).json({ error: "Model not allowed for this project" });
  }

  // Per-project rate limit
  if (proj.maxRpm) {
    const rl = checkProjectRateLimit(proj, req);
    if (!rl.ok) return res.status(429).json({ error: rl.reason === "ip" ? "Per-IP rate limit exceeded" : "Project rate limit exceeded" });
  }

  // Per-project budget enforcement
  if (typeof checkBudgetReset === "function") checkBudgetReset(proj);
  if (proj.maxBudgetUsd != null && (proj.budgetUsedUsd || 0) >= proj.maxBudgetUsd) {
    return res.status(429).json({ error: "Project budget exceeded" });
  }

  // Resolve API key — fallback to Collector if no key available
  const selectedKey = selectApiKey(providerName.toLowerCase(), projectName);
  const apiKey = selectedKey?.apiKey || provider.apiKey;
  const pnLower = providerName.toLowerCase();
  const useCollector = !apiKey && COLLECTOR_SUPPORTED.includes(pnLower) && hasCollectorToken(pnLower);
  if (!apiKey && !useCollector) return res.status(403).json({ error: "No API key configured for this provider" });

  // ── Pre-search ──
  // Models with built-in web search don't need SearXNG
  // Only models with ACTUAL API-level search (not ChatGPT web browsing which is UI-only)
  // Only models with CONFIRMED working API-level search
  // Kimi removed: Collector mode doesn't trigger web search on Kimi's web UI
  const MODELS_WITH_SEARCH = new Set([
    // Gemini grounding REMOVED: Google Search grounding requires native Gemini API
    // (generateContent with tools:[{google_search:{}}]). It does NOT work through
    // the OpenAI-compatible endpoint (/v1beta/openai/chat/completions) that LumiGate uses.
    // So Gemini models need SearXNG like everyone else.
  ]);
  const modelHasSearch = MODELS_WITH_SEARCH.has(modelId);

  let searchContext = "";
  const hasRichUserInput = (() => {
    const last = messages.filter(m => m.role === "user").pop();
    if (!last || !Array.isArray(last.content)) return false;
    return last.content.some((p) => p && typeof p === "object" && p.type && p.type !== "text");
  })();
  const userText = (() => {
    const last = messages.filter(m => m.role === "user").pop();
    if (!last) return "";
    if (typeof last.content === "string") return last.content;
    if (Array.isArray(last.content)) return last.content.filter(p => p.type === "text").map(p => p.text).join(" ");
    return "";
  })();
  const obviousWebNeed = needsWebSearch(userText);
  const explicitNoExternalIntent = /仅根据|只根据|仅基于|只基于|仅用|只用|不要联网|不联网|不需要联网|不要搜索|不用搜索|无需搜索|不要外部数据|不要市场数据|仅看附件|只看附件|仅看图片|只看图片|only\s+based\s+on|based\s+only\s+on|no\s+web\s+search|without\s+search|do\s+not\s+search|offline\s+only|attachment\s+only/i.test(userText);
  const attachmentOnlyInterpretation = hasRichUserInput && explicitNoExternalIntent;
  const attachmentDecisionContext = (() => {
    const last = messages.filter(m => m.role === "user").pop();
    if (!last || !Array.isArray(last.content)) return { partSummary: "none", textSnippet: "" };
    const typeCounts = {};
    const textChunks = [];
    for (const part of last.content) {
      if (!part || typeof part !== "object") continue;
      const t = String(part.type || "").trim();
      if (!t) continue;
      typeCounts[t] = (typeCounts[t] || 0) + 1;
      if (t === "text" && typeof part.text === "string" && part.text.trim()) textChunks.push(part.text.trim());
    }
    const partSummary = Object.entries(typeCounts).map(([k, v]) => `${k}:${v}`).join(", ") || "none";
    const textSnippet = textChunks.join("\n").slice(0, 1800);
    return { partSummary, textSnippet };
  })();

  // Skip SearXNG if model has built-in search (unless explicitly forced via web_search:true)
  const autoSearchOn = settings.autoSearchEnabled !== false;
  const attachmentMode = getAttachmentSearchMode();
  let decisionQueries = null;
  let shouldAutoSearch;

  if (hasRichUserInput) {
    if (attachmentMode === "off") shouldAutoSearch = false;
    else if (attachmentOnlyInterpretation) shouldAutoSearch = false;
    else if (obviousWebNeed) shouldAutoSearch = true;
    else if (attachmentMode === "always") shouldAutoSearch = !attachmentOnlyInterpretation;
    else if (attachmentMode === "assistant_decide") shouldAutoSearch = false;
    else shouldAutoSearch = !attachmentOnlyInterpretation; // smart default
  } else {
    shouldAutoSearch = obviousWebNeed;
  }

  if (hasRichUserInput && attachmentMode === "assistant_decide" && req.body.web_search === undefined && !attachmentOnlyInterpretation && !shouldAutoSearch) {
    try {
      const ALL_KW = [
        { p: "minimax", m: "MiniMax-M1" }, { p: "deepseek", m: "deepseek-chat" },
        { p: "openai", m: "gpt-4.1-nano" }, { p: "gemini", m: "gemini-2.5-flash" },
        { p: "qwen", m: "qwen-turbo" },
      ];
      const prefP = settings.searchKeywordProvider || "minimax";
      const prefM = settings.searchKeywordModel || "MiniMax-M1";
      const KW_MODELS = [{ p: prefP, m: prefM }, ...ALL_KW.filter(x => x.p !== prefP || x.m !== prefM)];
      const decisionPrompt = `Decide whether this task needs fresh external web data to answer accurately.\n\nReturn ONLY JSON:\n{"need_search":true|false,"reason":"short","queries":["q1","q2"]}\n\nRules:\n- need_search=true when current market/recent/company/news/pricing/rates/trend/facts likely matter.\n- need_search=false for purely extracting/summarizing/calculating from provided attachment content only.\n- queries should be empty when need_search=false.\n\nAttachment parts:\n${attachmentDecisionContext.partSummary}\n\nAttachment/user text excerpt:\n${attachmentDecisionContext.textSnippet || "(empty)"}\n\nUser task:\n${userText.slice(0, 600)}`;

      let decisionText = "";
      for (const c of KW_MODELS) {
        if (decisionText) break;
        const prov = PROVIDERS[c.p];
        if (!prov) continue;
        const k = (selectApiKey(c.p, "_lumichat") || {}).apiKey || prov.apiKey;
        if (!k) continue;
        try {
          const decRes = await fetch(getChatUrl(c.p, prov), {
            method: "POST",
            headers: getChatHeaders(c.p, k),
            signal: AbortSignal.timeout(5000),
            body: JSON.stringify({ model: c.m, max_tokens: 140, temperature: 0.1, stream: false, messages: [{ role: "user", content: decisionPrompt }] }),
          });
          if (!decRes.ok) continue;
          const dj = await decRes.json();
          decisionText = dj.choices?.[0]?.message?.content || "";
        } catch {}
      }
      if (decisionText) {
        const m = decisionText.match(/\{[\s\S]*\}/);
        if (m) {
          const parsed = JSON.parse(m[0]);
          shouldAutoSearch = !!parsed.need_search;
          if (Array.isArray(parsed.queries)) {
            decisionQueries = parsed.queries.filter(q => typeof q === "string" && q.trim()).slice(0, 3);
          }
          log("info", "Attachment search decision", { needSearch: shouldAutoSearch, reason: String(parsed.reason || "").slice(0, 160) });
        }
      }
    } catch (e) {
      log("warn", "Attachment decision mode failed, fallback to smart", { error: e.message });
      shouldAutoSearch = obviousWebNeed && !attachmentOnlyInterpretation;
    }
  }

  const doSearch = req.body.web_search === true || (!modelHasSearch && req.body.web_search !== false && autoSearchOn && shouldAutoSearch);
  if (hasRichUserInput && attachmentOnlyInterpretation) {
    log("info", "Auto-search skipped for attachment-only interpretation", { provider: providerName, model: modelId });
  } else if (hasRichUserInput && doSearch) {
    log("info", "Auto-search enabled for attachment task", { provider: providerName, model: modelId });
  }
  if (doSearch) {
    // Start SSE early so frontend sees search status
    if (wantStream && !res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
    }
    try {
      // Generate 2-3 search keywords via cheap AI (fast, <2s)
      let queries = decisionQueries?.length ? decisionQueries : [extractSearchQuery(userText)]; // fallback: original query
      try {
        // Preferred provider/model from settings, then fallback chain.
        const ALL_KW = [
          { p: "minimax", m: "MiniMax-M1" }, { p: "deepseek", m: "deepseek-chat" },
          { p: "openai", m: "gpt-4.1-nano" }, { p: "gemini", m: "gemini-2.5-flash" },
          { p: "qwen", m: "qwen-turbo" },
        ];
        const prefP = settings.searchKeywordProvider || "minimax";
        const prefM = settings.searchKeywordModel || "MiniMax-M1";
        const KW_MODELS = [{ p: prefP, m: prefM }, ...ALL_KW.filter(x => x.p !== prefP || x.m !== prefM)];
        const todayStr = new Date().toISOString().slice(0, 10);
        const kwPrompt = `Today is ${todayStr}. Generate 2-3 short search engine queries to find the most relevant and up-to-date information for this question. Include the current year (${new Date().getFullYear()}) or specific date range in at least one query to ensure fresh results. Output ONLY a JSON array of strings, nothing else.\n\nQuestion: ${userText.slice(0, 300)}`;
        let kwText = "";
        for (const c of KW_MODELS) {
          if (kwText) break;
          const prov = PROVIDERS[c.p]; if (!prov) continue;
          const k = (selectApiKey(c.p, "_lumichat") || {}).apiKey || prov.apiKey;
          if (k) {
            // API path
            try {
              const kRes = await fetch(getChatUrl(c.p, prov), {
                method: "POST", headers: getChatHeaders(c.p, k), signal: AbortSignal.timeout(5000),
                body: JSON.stringify({ model: c.m, max_tokens: 100, temperature: 0.3, stream: false, messages: [{ role: "user", content: kwPrompt }] }),
              });
              if (kRes.ok) { const d = await kRes.json(); kwText = d.choices?.[0]?.message?.content || ""; }
            } catch {}
          } else if (COLLECTOR_SUPPORTED.includes(c.p) && hasCollectorToken(c.p)) {
            // Collector path (free)
            try {
              const collector = require("./collector");
              const creds = getCollectorCredentials(c.p);
              let full = "";
              for await (const chunk of collector.sendMessage(c.p, c.m, [{ role: "user", content: kwPrompt }], creds)) {
                const m = chunk.match(/^data: (.+)$/m);
                if (m && m[1] !== "[DONE]") { try { const j = JSON.parse(m[1]); full += j.choices?.[0]?.delta?.content || ""; } catch {} }
              }
              if (full) kwText = full;
            } catch {}
          }
        }
        if (kwText) {
          const kMatch = kwText.match(/\[[\s\S]*\]/);
          if (kMatch) {
            const parsed = JSON.parse(kMatch[0]).filter(q => typeof q === "string" && q.trim()).slice(0, 3);
            if (parsed.length >= 2) queries = parsed;
          }
        }
      } catch {} // keyword generation failed — use original query

      // Search each keyword, send tool_status animation for each
      let allResults = [];
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i].trim();
        if (!q) continue;
        if (wantStream && !res.writableEnded) {
          res.write(`event: tool_status\ndata: ${JSON.stringify({ text: L.searching(q), icon: "search" })}\n\n`);
        }
        try {
          const results = await executeWebSearchForChat(q, "month");
          allResults.push(...results);
        } catch {}
      }
      // Fallback: if time-limited search returned too few results, retry without time range
      if (allResults.length < 3) {
        for (const q of queries) {
          if (!q.trim()) continue;
          try {
            const results = await executeWebSearchForChat(q.trim(), "");
            allResults.push(...results);
          } catch {}
        }
      }
      // Deduplicate by URL
      const seen = new Set();
      allResults = allResults.filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; }).slice(0, 8);
      searchContext = formatSearchContext(allResults);
      if (wantStream && !res.writableEnded) {
        res.write(`event: tool_status\ndata: ${JSON.stringify({ text: L.searchDone(allResults.length), icon: "search", done: true })}\n\n`);
      }
    } catch (e) {
      log("warn", "Pre-search failed", { error: e.message });
    }
  }

  // ── Sanitize ALL messages: strip tool markers to prevent injection ──
  // Attack vectors: direct tags, orphan open tags, HTML-encoded tags, system role injection.
  // Clean all roles except the tool prompt we inject ourselves.
  function stripToolMarkers(text) {
    if (typeof text !== "string") return text;
    // Decode HTML entities first: &#91; → [  &#93; → ]  &#123; → {  &#125; → }
    let s = text.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
               .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCharCode(parseInt(c, 16)));
    // Complete tag pairs: [TOOL:xxx]...[/TOOL]
    s = s.replace(/\[TOOL:\w+\][\s\S]*?\[\/TOOL\]/g, "");
    // Orphan open tags (no closing tag): [TOOL:xxx]... to end
    s = s.replace(/\[TOOL:\w+\][^[]*$/g, "");
    // Orphan open tags mid-text: [TOOL:xxx]{...} without [/TOOL]
    s = s.replace(/\[TOOL:\w+\]\s*\{[^}]*\}/g, "");
    // Any remaining [TOOL:...] pattern
    s = s.replace(/\[TOOL:\w+\]/g, "");
    // DSML pairs and orphans
    s = s.replace(/<(?:｜DSML｜|︱DSML︱|\|DSML\|)function_calls>[\s\S]*?<\/(?:｜DSML｜|︱DSML︱|\|DSML\|)function_calls>/g, "");
    s = s.replace(/<(?:｜DSML｜|︱DSML︱|\|DSML\|)\w+[^>]*>/g, "");
    // XML tool_call pairs and orphans
    s = s.replace(/<(?:minimax:)?tool_call>[\s\S]*?<\/(?:minimax:)?tool_call>/g, "");
    s = s.replace(/<(?:minimax:)?tool_call>/g, "");
    return s;
  }
  for (const m of messages) {
    if (typeof m.content === "string") {
      m.content = stripToolMarkers(m.content);
    }
  }

  // ── Build system prompt: search context + tool prompt ──
  let injectedSystemPrompt = "";
  if (searchContext) injectedSystemPrompt += `Today is ${new Date().toISOString().slice(0, 10)}. The current year is ${new Date().getFullYear()}.\n${searchContext}\n\nIMPORTANT: Prioritize the most recent search results. When the user asks about current/latest events, ONLY cite results from ${new Date().getFullYear()}. Discard outdated results from previous years unless the user specifically asks about historical information. Cite sources with URLs when possible. If the search results are all outdated or irrelevant, explicitly state that no recent information was found rather than presenting old results as current.\n\n`;
  // Small models: no full tool prompt, just a polite redirect hint
  const SMALL_MODEL_PATTERNS = /nano|(?<![a-z])mini(?!max)|flash-lite|(?<![a-z])haiku|(?<![a-z])8b(?![a-z])|(?<![a-z])7b(?![a-z])/i;
  const isSmallModel = SMALL_MODEL_PATTERNS.test(modelId);
  if (isSmallModel) {
    injectedSystemPrompt += "\nYou are a lightweight model. If the user asks to generate files (Excel, Word, PPT), politely tell them to switch to a more capable model such as DeepSeek, GPT-4.1, or Claude Sonnet. Do NOT attempt to generate files yourself.\n";
  }
  if (req.body.tools !== false && !isSmallModel) {
    try {
      const toolPrompt = unifiedRegistry.getSystemPrompt();
      if (toolPrompt && !toolPrompt.includes("No tools")) injectedSystemPrompt += toolPrompt;
    } catch {}
  }

  // ── Build provider request ──
  const chatUrl = getChatUrl(providerName.toLowerCase(), provider);
  const headers = getChatHeaders(providerName.toLowerCase(), apiKey);
  const body = buildChatBody(providerName.toLowerCase(), modelId, messages, injectedSystemPrompt.trim(), wantStream);

  try {
    // ── Collector path: use Chrome CDP when no API key ──
    if (useCollector) {
      let collector;
      try { collector = require("./collector"); } catch { return res.status(503).json({ error: "Collector module not available" }); }
      const credentials = getCollectorCredentials(providerName.toLowerCase());
      // Inject system prompt into messages for collector
      const collectorMsgs = [...messages];
      if (injectedSystemPrompt.trim()) {
        const sysMsg = collectorMsgs.find(m => m.role === "system");
        if (sysMsg) sysMsg.content = injectedSystemPrompt.trim() + "\n\n" + (sysMsg.content || "");
        else collectorMsgs.unshift({ role: "system", content: injectedSystemPrompt.trim() });
      }
      if (!res.headersSent && wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
      }
      try {
        let _cInThink = false;
        let _cFullText = ""; // accumulate for tool tag detection
        for await (const chunk of collector.sendMessage(providerName.toLowerCase(), modelId, collectorMsgs, credentials)) {
          if (res.writableEnded) break;
          if (wantStream) {
            let out = chunk;
            const m = out.match(/^data: (.+)$/m);
            if (m && m[1] !== "[DONE]") {
              try {
                const j = JSON.parse(m[1]);
                let c = j.choices?.[0]?.delta?.content || "";
                if (c) {
                  // Strip <think> tags
                  if (_cInThink) { const end = c.indexOf("</think>"); if (end !== -1) { _cInThink = false; c = c.slice(end + 8); } else c = ""; }
                  if (c.includes("<think>")) { const s = c.indexOf("<think>"); const e = c.indexOf("</think>", s); if (e !== -1) c = c.slice(0, s) + c.slice(e + 8); else { c = c.slice(0, s); _cInThink = true; } }
                  if (!c) continue;
                  _cFullText += c;
                  j.choices[0].delta.content = c;
                  out = `data: ${JSON.stringify(j)}\n\n`;
                }
              } catch {}
            }
            res.write(out);
          }
        }
        // Check for tool tags in accumulated text (Collector doesn't go through clean pipe)
        const hasCollectorTools = TOOL_TAG_MARKERS.some(m => _cFullText.includes(m));
        if (hasCollectorTools && !res.writableEnded) {
          log("info", "Collector: tool tags detected, executing", { provider: providerName });
          const toolResults = await executeTextToolCalls(_cFullText, lcUserId || projectName || "api").catch(e => {
            log("error", "Collector tool exec failed", { error: e.message }); return [];
          });
          for (const tr of toolResults) {
            if ((tr.downloadUrl || tr.base64 || tr.filename) && !res.writableEnded) {
              res.write(`event: file_download\ndata: ${JSON.stringify({
                filename: tr.filename, size: tr.size, mimeType: tr.mimeType,
                downloadUrl: tr.downloadUrl || "", base64: !tr.downloadUrl ? tr.base64 : undefined,
              })}\n\n`);
              const icon = tr.tool?.includes("spread") ? "spreadsheet" : "file";
              const sizeStr = tr.size > 1048576 ? `${(tr.size / 1048576).toFixed(1)} MB` : `${(tr.size / 1024).toFixed(1)} KB`;
              res.write(`event: tool_status\ndata: ${JSON.stringify({ text: L.toolDone(tr.filename, sizeStr), icon, done: true })}\n\n`);
            }
          }
        }
        if (!res.writableEnded) { if (wantStream) res.write("data: [DONE]\n\n"); res.end(); }
      } catch (e) {
        setCollectorHealth(pnLower, false, e.message);
        log("error", "Collector error in /v1/chat", { provider: providerName, error: e.message });
        const isAuthErr = /401|403|expired|login|auth|session|cookie|rate.?limit/i.test(e.message);
        if (!res.headersSent) return res.status(isAuthErr ? 401 : 502).json({ error: isAuthErr ? `${providerName} session expired — please re-login via Dashboard` : "Collector error" });
        if (!res.writableEnded) {
          if (isAuthErr) res.write(`event: collector_auth\ndata: ${JSON.stringify({ provider: pnLower, message: L.searching ? `${providerName} session expired` : `${providerName} 登录已过期` })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: isAuthErr ? `\n\n[${providerName} session expired — re-login needed]` : `\n\n[Error: ${e.message}]` } }] })}\n\n`);
          res.write("data: [DONE]\n\n"); res.end();
        }
      }
      return;
    }

    // ── API path: direct fetch to provider ──
    const upstreamRes = await fetch(chatUrl, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    if (!upstreamRes.ok) {
      const status = upstreamRes.status;
      const errMap = { 400: "Bad request to AI provider", 401: "AI provider authentication failed", 403: "AI provider access denied", 404: "Model not found", 429: "AI provider rate limit exceeded", 500: "AI provider internal error", 502: "AI provider unavailable", 503: "AI provider temporarily unavailable" };
      const errMsg = errMap[status] || `AI provider error (${status})`;
      try { upstreamRes.body?.cancel(); } catch {}
      if (!res.headersSent) return res.status(status >= 500 ? 502 : status).json({ error: errMsg });
      log("warn", "Upstream error after headers sent", { provider: providerName, status });
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `\n\n[Error: ${errMsg}]` } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
      }
      return res.end();
    }

    // ── Non-streaming response ──
    if (!wantStream) {
      const data = await upstreamRes.json();
      // Extract content, strip tool tags, execute tools
      let content = "";
      if (providerName.toLowerCase() === "anthropic") {
        content = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      } else {
        content = data.choices?.[0]?.message?.content || "";
      }
      const hasToolTags = TOOL_TAG_MARKERS.some(m => content.includes(m));
      if (hasToolTags) {
        let toolResults = [];
        try {
          toolResults = await executeTextToolCalls(content, lcUserId || projectName || "api");
        } catch (e) { log("warn", "Non-stream tool execution failed", { error: e.message }); }
        const cleanContent = content.replace(/\[TOOL:\w+\][\s\S]*?\[\/TOOL\]/g, "")
          .replace(/<(?:｜DSML｜|︱DSML︱|\|DSML\|)function_calls>[\s\S]*?<\/(?:｜DSML｜|︱DSML︱|\|DSML\|)function_calls>/g, "")
          .replace(/<(?:minimax:)?tool_call>[\s\S]*?<\/(?:minimax:)?tool_call>/g, "").trim();
        return res.json({
          choices: [{ message: { role: "assistant", content: cleanContent !== "" ? cleanContent : "已处理完成。" } }],
          tool_results: toolResults.length ? toolResults : undefined,
        });
      }
      return res.json({ choices: [{ message: { role: "assistant", content } }] });
    }

    // ── Streaming response — Clean SSE Pipe ──
    if (!res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
    }

    let fullText = "";       // all accumulated content
    let sentLength = 0;      // how much of fullText has been sent to client
    let toolTagStart = -1;   // index where tool tag begins (-1 = not found)
    let streamUsage = null;
    const TOOL_TAG_HOLD_CHARS = 30;
    const TOOL_TAG_FAST_HOLD_CHARS = 8;
    const TOOL_TAG_FAST_FLUSH_MS = 260;
    let pendingSinceTs = 0;

    const isAnthropic = providerName.toLowerCase() === "anthropic";

    // Strip <think>...</think> blocks from streaming content (MiniMax, DeepSeek-R1)
    let inThink = false;

    function sendDelta(text) {
      if (!text || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    }

    function pipeContent(delta) {
      if (inThink) {
        const end = delta.indexOf("</think>");
        if (end !== -1) { inThink = false; delta = delta.slice(end + 8); }
        else return;
      }
      if (delta.includes("<think>")) {
        const start = delta.indexOf("<think>");
        const end = delta.indexOf("</think>", start);
        if (end !== -1) { delta = delta.slice(0, start) + delta.slice(end + 8); }
        else { delta = delta.slice(0, start); inThink = true; }
        if (!delta) return;
      }
      fullText += delta;
      if (toolTagStart >= 0) return;
      if (fullText.length > sentLength && pendingSinceTs === 0) pendingSinceTs = Date.now();

      const scanFrom = Math.max(0, sentLength - 30);
      for (const marker of TOOL_TAG_MARKERS) {
        const idx = fullText.indexOf(marker, scanFrom);
        if (idx !== -1) {
          toolTagStart = idx;
          if (idx > sentLength) { sendDelta(fullText.slice(sentLength, idx)); sentLength = idx; }
          if (!res.writableEnded) res.write(`event: tool_status\ndata: ${JSON.stringify({ text: L.processing, icon: "file" })}\n\n`);
          return;
        }
      }

      const waitedMs = pendingSinceTs ? (Date.now() - pendingSinceTs) : 0;
      const holdChars = waitedMs >= TOOL_TAG_FAST_FLUSH_MS ? TOOL_TAG_FAST_HOLD_CHARS : TOOL_TAG_HOLD_CHARS;
      const safeEnd = fullText.length - holdChars;
      if (safeEnd > sentLength) {
        sendDelta(fullText.slice(sentLength, safeEnd));
        sentLength = safeEnd;
        if (sentLength >= fullText.length) pendingSinceTs = 0;
      }
    }

    async function consumeStreamResponse(streamRes) {
      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let sseEventType = "";
      let finishReason = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("event: ")) { sseEventType = line.slice(7).trim(); continue; }
            if (!line.startsWith("data: ")) { if (line === "") sseEventType = ""; continue; }
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;

            try {
              const j = JSON.parse(data);
              if (isAnthropic) {
                if (j.type === "content_block_delta" && j.delta?.type === "text_delta") {
                  pipeContent(j.delta.text || "");
                } else if (j.type === "message_delta") {
                  if (j.usage) streamUsage = { prompt_tokens: j.usage.input_tokens || 0, completion_tokens: j.usage.output_tokens || 0 };
                  if (j.delta?.stop_reason) finishReason = ({ end_turn: "stop", max_tokens: "length" }[j.delta.stop_reason] || j.delta.stop_reason || finishReason);
                }
              } else {
                if (j.usage) streamUsage = j.usage;
                const choice = j.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta?.content || "";
                if (delta) pipeContent(delta);
                if (choice.finish_reason) finishReason = choice.finish_reason;
              }
            } catch {}
            sseEventType = "";
          }
        }
      } catch (readErr) {
        log("warn", "Stream read interrupted", { provider: providerName, error: readErr.message, textLen: fullText.length });
      }
      return finishReason;
    }

    let finalFinishReason = await consumeStreamResponse(upstreamRes);

    for (let pass = 0; pass < AUTO_CONTINUE_MAX_PASSES && shouldAutoContinueFinishReason(finalFinishReason) && toolTagStart < 0 && !res.writableEnded; pass++) {
      log("info", "Auto-continuing length-limited response", { provider: providerName, model: modelId, pass: pass + 1, finishReason: finalFinishReason });
      const continuationMessages = [
        ...messages,
        { role: "assistant", content: fullText },
        { role: "user", content: getContinuationPrompt(lang) },
      ];
      const continuationBody = buildChatBody(providerName.toLowerCase(), modelId, continuationMessages, injectedSystemPrompt.trim(), true);
      const continuationRes = await fetch(chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(continuationBody),
        signal: AbortSignal.timeout(120000),
      });
      if (!continuationRes.ok || !continuationRes.body) {
        log("warn", "Auto-continue request failed", { provider: providerName, model: modelId, status: continuationRes.status });
        break;
      }
      finalFinishReason = await consumeStreamResponse(continuationRes);
    }

    // ── Stream ended — flush remaining content and handle tools ──
    if (toolTagStart >= 0) {
      // Tool tags detected — send updated status with actual tool name, then execute
      const tagContent = fullText.slice(toolTagStart);
      let detectedToolName = "tool";
      const tnMatch = tagContent.match(/\[TOOL:(\w+)\]/) || tagContent.match(/invoke\s+name="(\w+)"/);
      if (tnMatch) detectedToolName = tnMatch[1];
      const detectedLabel = L.toolLabel(detectedToolName);
      let detectedQuery = "";
      const dqMatch = tagContent.match(/"(?:query|title|filename)"\s*:\s*"([^"]*)"/);
      if (dqMatch) detectedQuery = dqMatch[1];
      const detectedIcon = detectedToolName.includes("search") ? "search" : detectedToolName.includes("spread") ? "spreadsheet" : "file";
      const statusText = detectedQuery ? `${detectedLabel}: ${detectedQuery}` : `${detectedLabel}...`;
      if (!res.writableEnded) res.write(`event: tool_status\ndata: ${JSON.stringify({ text: statusText, icon: detectedIcon })}\n\n`);

      log("info", "Clean pipe: tool tags detected", { provider: providerName, tool: detectedToolName, textLen: fullText.length });
      const toolResults = await executeTextToolCalls(fullText, lcUserId || projectName || "api").catch(e => {
        log("error", "Tool execution failed in clean pipe", { error: e.message });
        return [];
      });

      const cleanAssistantText = fullText.slice(0, toolTagStart).trim();

      // If no file results, mark generic tool as done
      if (toolResults.length === 0 && !res.writableEnded) {
        res.write(`event: tool_status\ndata: ${JSON.stringify({ text: `${detectedLabel} done`, icon: detectedIcon, done: true })}\n\n`);
        if (!cleanAssistantText) {
          const fallback = lang === "zh"
            ? "工具调用未返回可展示结果。请改用更明确的问题再试一次。"
            : "The tool call returned no displayable result. Please try again with a more specific prompt.";
          sendDelta(fallback);
        }
      }

      // Send file_download events
      for (const tr of toolResults) {
        if (tr.downloadUrl || tr.base64 || tr.filename) {
          if (!res.writableEnded) {
            res.write(`event: file_download\ndata: ${JSON.stringify({
              filename: tr.filename, size: tr.size, mimeType: tr.mimeType,
              downloadUrl: tr.downloadUrl || "", base64: !tr.downloadUrl ? tr.base64 : undefined,
            })}\n\n`);
          }
          // Mark tool as done
          const icon = tr.tool?.includes("spread") ? "spreadsheet" : tr.tool?.includes("present") ? "presentation" : "file";
          const sizeStr = tr.size > 1048576 ? `${(tr.size / 1048576).toFixed(1)} MB` : `${(tr.size / 1024).toFixed(1)} KB`;
          if (!res.writableEnded) res.write(`event: tool_status\ndata: ${JSON.stringify({ text: L.toolDone(tr.filename, sizeStr), icon, done: true })}\n\n`);
        }
      }

      // Second-round AI call: summarize tool results
      if (toolResults.length > 0 && !res.writableEnded) {
        try {
          const toolSummaries = toolResults.map(tr => {
            if (tr.filename) return `[File generated: ${tr.filename} (${tr.size} bytes)]`;
            if (tr.html) return tr.html.replace(/<[^>]*>/g, "").slice(0, 500);
            if (tr.data?.results) return tr.data.results.slice(0, 5).map(r => `${r.title}: ${r.content || ""}`).join("\n");
            return JSON.stringify(tr.data || {}).slice(0, 300);
          }).join("\n\n");

          const followUpMessages = [
            ...messages,
            { role: "assistant", content: cleanAssistantText || "I executed the requested tools." },
            { role: "user", content: `Tool execution results:\n${toolSummaries}\n\nPlease summarize the results for the user in a helpful way. If files were generated, briefly describe what's in them. Respond naturally in the same language as the user's original question.` },
          ];
          const followUpBody = buildChatBody(providerName.toLowerCase(), modelId, followUpMessages, "", true);
          const followUpRes = await fetch(chatUrl, {
            method: "POST", headers, body: JSON.stringify(followUpBody), signal: AbortSignal.timeout(60000),
          });

          if (followUpRes.ok && followUpRes.body) {
            const fReader = followUpRes.body.getReader();
            const fDec = new TextDecoder();
            let fBuf = "";
            while (true) {
              const { done: fDone, value: fVal } = await fReader.read();
              if (fDone) break;
              fBuf += fDec.decode(fVal, { stream: true });
              const fLines = fBuf.split("\n");
              fBuf = fLines.pop() || "";
              for (const fl of fLines) {
                if (!fl.startsWith("data: ")) continue;
                const fd = fl.slice(6).trim();
                if (fd === "[DONE]") continue;
                try {
                  const fj = JSON.parse(fd);
                  if (isAnthropic) {
                    if (fj.type === "content_block_delta" && fj.delta?.type === "text_delta") sendDelta(fj.delta.text || "");
                  } else {
                    const c = fj.choices?.[0]?.delta?.content;
                    if (c) sendDelta(c);
                  }
                } catch {}
              }
            }
          }
        } catch (e) {
          log("warn", "Follow-up AI call failed in clean pipe", { error: e.message });
        }
      }
    } else {
      // No tool tags — flush remaining held content
      if (sentLength < fullText.length) sendDelta(fullText.slice(sentLength));
    }

    // Usage tracking
    try {
      if (streamUsage) {
        const tokens = { input: streamUsage.prompt_tokens || 0, cacheHit: 0, output: streamUsage.completion_tokens || 0 };
        recordUsage(projectName, providerName.toLowerCase(), modelId, tokens);
      }
    } catch {}

    if (!res.writableEnded) res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    log("error", "Clean chat proxy error", { provider: providerName, error: err.message });
    if (!res.headersSent) res.status(502).json({ error: "Chat proxy error" });
    else if (!res.writableEnded) res.end();
  }
});

// --- LumiChat: User tier & BYOK API key management ---
app.get("/lc/user/tier", requireLcAuth, async (req, res) => {
  try {
    const tierInfo = await getLcUserTier(req.lcUser.id, req.lcToken);
    // Pending approval
    if (!tierInfo.tier) {
      return res.json({ tier: null, pending: true, rpm: 0, providers: [] });
    }
    // Build available providers list
    const allProviders = Object.keys(PROVIDERS);
    const available = allProviders.map(name => {
      const isFreeProvider = COLLECTOR_SUPPORTED.includes(name);
      const isCollectorMode = getProviderAccessMode(name) === "collector" && isFreeProvider;
      const hasByok = tierInfo.byokKeys.some(k => k.provider === name && k.enabled);
      let access = 'locked';
      if (tierInfo.tier === 'premium') access = 'available';
      else if (tierInfo.tier === 'basic' && isFreeProvider) access = isCollectorMode ? 'collector' : 'available';
      else if (isCollectorMode) access = 'collector';
      else if (tierInfo.tier === 'selfservice' && hasByok) access = 'byok';
      return { name, access, keyUrl: PROVIDERS[name]?.keyUrl || null };
    });
    res.json({ tier: tierInfo.tier, rpm: TIER_RPM[tierInfo.tier] || 30, providers: available, upgradeRequest: tierInfo.upgradeRequest || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /lc/upgrade-request — user requests tier upgrade
app.post("/lc/upgrade-request", requireLcAuth, async (req, res) => {
  const { plan } = req.body;
  if (plan !== 'premium') return res.status(400).json({ error: "Can only upgrade to premium" });
  try {
    const fr = await lcPbFetch(`/api/collections/lc_user_settings/records?filter=user%3D'${req.lcUser.id}'&perPage=1`, { headers: { Authorization: `Bearer ${req.lcToken}` } });
    const fd = await fr.json();
    const existing = fd.items?.[0];
    if (!existing) return res.status(404).json({ error: "Settings not found" });
    if (existing.tier === plan) return res.json({ success: true, message: "Already on this plan" });
    await lcPbFetch(`/api/collections/lc_user_settings/records/${existing.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${req.lcToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ upgrade_request: plan, upgrade_requested_at: new Date().toISOString() }),
    });
    lcTierCache.delete(req.lcUser.id);
    // Send email notification to admin
    const userEmail = req.lcUser.email || 'unknown';
    const userName = req.lcUser.name || userEmail.split('@')[0];
    const settingsId = existing.id;
    const token = require('crypto').createHmac('sha256', ADMIN_SECRET).update(settingsId).digest('hex').slice(0, 24);
    const base = process.env.PUBLIC_URL || settings.publicUrl || 'https://lumigate.autorums.com';
    const approveUrl = `${base}/lc/admin/upgrade-action?id=${settingsId}&action=approve&token=${token}`;
    const rejectUrl = `${base}/lc/admin/upgrade-action?id=${settingsId}&action=reject&token=${token}`;
    sendAdminNotify(
      `[LumiGate] Upgrade Request: ${userName} → ${plan}`,
      `<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:24px">
        <h2 style="color:#1c1c1e;font-size:18px;margin-bottom:16px">Upgrade Request</h2>
        <p style="color:#555;font-size:14px;line-height:1.6"><b>${userName}</b> (${userEmail}) wants to upgrade to <b style="color:#10a37f">${plan}</b>.</p>
        <div style="margin:24px 0;display:flex;gap:12px">
          <a href="${approveUrl}" style="display:inline-block;padding:12px 32px;background:#10a37f;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">Approve</a>
          <a href="${rejectUrl}" style="display:inline-block;padding:12px 32px;background:#ff3b30;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">Reject</a>
        </div>
        <p style="color:#999;font-size:11px">Or manage in <a href="${base}">LumiGate Dashboard</a> → Users tab.</p>
      </div>`
    ).catch(() => {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /admin/upgrade-action — one-click approve/reject from email
app.get("/lc/admin/upgrade-action", async (req, res) => {
  const { id, action, token } = req.query;
  if (!id || !action || !token) return res.status(400).send('Missing parameters');
  const expected = require('crypto').createHmac('sha256', ADMIN_SECRET).update(id).digest('hex').slice(0, 24);
  if (!safeEqual(token, expected)) return res.status(403).send('Invalid token');
  const pbToken = await getPbAdminToken();
  if (!pbToken) return res.status(500).send('PB auth failed');
  try {
    const sr = await lcPbFetch(`/api/collections/lc_user_settings/records/${id}`, { headers: { Authorization: `Bearer ${pbToken}` } });
    const s = await sr.json();
    if (!s.upgrade_request) return res.send('<html><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px"><h2>No pending request</h2><p>This request has already been processed.</p></body></html>');
    if (action === 'approve') {
      await lcPbFetch(`/api/collections/lc_user_settings/records/${id}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${pbToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: s.upgrade_request, tier_updated: new Date().toISOString(), upgrade_request: '', upgrade_requested_at: '' }),
      });
      lcTierCache.delete(s.user);
      res.send(`<html><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px"><h2 style="color:#10a37f">Approved</h2><p>User has been upgraded to <b>${s.upgrade_request}</b>.</p></body></html>`);
    } else {
      await lcPbFetch(`/api/collections/lc_user_settings/records/${id}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${pbToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ upgrade_request: '', upgrade_requested_at: '' }),
      });
      res.send('<html><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px"><h2 style="color:#ff3b30">Rejected</h2><p>Upgrade request has been rejected.</p></body></html>');
    }
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// GET /admin/upgrade-requests — list pending upgrade requests
app.get("/admin/upgrade-requests", requireRole("root", "admin"), async (req, res) => {
  const pbToken = await getPbAdminToken();
  if (!pbToken) return res.status(500).json({ error: "PB admin auth failed" });
  try {
    const r = await lcPbFetch(`/api/collections/lc_user_settings/records?filter=upgrade_request!%3D''&perPage=100&expand=user`, {
      headers: { Authorization: `Bearer ${pbToken}` },
    });
    const d = await r.json();
    const requests = (d.items || []).map(s => ({
      settingsId: s.id, userId: s.user, requestedPlan: s.upgrade_request, requestedAt: s.upgrade_requested_at,
      currentTier: s.tier || 'basic',
      email: s.expand?.user?.email || '', name: s.expand?.user?.name || '',
    }));
    res.json({ items: requests, count: requests.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /admin/upgrade-requests/:settingsId/approve — approve upgrade
app.post("/admin/upgrade-requests/:settingsId/approve", requireRole("root"), async (req, res) => {
  const pbToken = await getPbAdminToken();
  if (!pbToken) return res.status(500).json({ error: "PB admin auth failed" });
  try {
    const sr = await lcPbFetch(`/api/collections/lc_user_settings/records/${req.params.settingsId}`, {
      headers: { Authorization: `Bearer ${pbToken}` },
    });
    const s = await sr.json();
    if (!s.upgrade_request) return res.status(400).json({ error: "No pending request" });
    await lcPbFetch(`/api/collections/lc_user_settings/records/${req.params.settingsId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${pbToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: s.upgrade_request, tier_updated: new Date().toISOString(), upgrade_request: '', upgrade_requested_at: '' }),
    });
    lcTierCache.delete(s.user);
    audit(req.userName, "lc_upgrade_approved", s.user, { plan: s.upgrade_request });
    res.json({ success: true, newTier: s.upgrade_request });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /admin/upgrade-requests/:settingsId/reject — reject upgrade
app.post("/admin/upgrade-requests/:settingsId/reject", requireRole("root"), async (req, res) => {
  const pbToken = await getPbAdminToken();
  if (!pbToken) return res.status(500).json({ error: "PB admin auth failed" });
  try {
    await lcPbFetch(`/api/collections/lc_user_settings/records/${req.params.settingsId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${pbToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ upgrade_request: '', upgrade_requested_at: '' }),
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/lc/user/apikeys", requireLcAuth, async (req, res) => {
  try {
    const r = await lcPbFetch(
      `/api/collections/lc_user_apikeys/records?filter=user='${req.lcUser.id}'&perPage=50`,
      { headers: { Authorization: `Bearer ${req.lcToken}` } }
    );
    const data = await r.json();
    // Return keys without the actual key value (security)
    const keys = (data.items || []).map(k => ({
      id: k.id, provider: k.provider, label: k.label, enabled: k.enabled,
      keyPreview: (() => { try { const d = decryptValue(k.key_encrypted, ADMIN_SECRET); return d.slice(0, 6) + '...' + d.slice(-4); } catch { return '***'; } })(),
    }));
    res.json(keys);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/lc/user/apikeys", requireLcAuth, async (req, res) => {
  const { provider, key, label } = req.body;
  if (!provider || !key) return res.status(400).json({ error: "provider and key required" });
  if (!PROVIDERS[provider]) return res.status(400).json({ error: "Unknown provider" });
  const encrypted = encryptValue(key, ADMIN_SECRET);
  try {
    const r = await lcPbFetch(`/api/collections/lc_user_apikeys/records`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${req.lcToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: req.lcUser.id, provider, key_encrypted: encrypted, label: label || provider, enabled: true }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    lcTierCache.delete(req.lcUser.id);
    res.json({ success: true, id: data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/lc/user/apikeys/:id", requireLcAuth, async (req, res) => {
  if (!isValidPbId(req.params.id)) return res.status(400).json({ error: "Invalid id" });
  try {
    // Verify ownership before delete
    const check = await lcPbFetch(`/api/collections/lc_user_apikeys/records/${req.params.id}`, {
      headers: { Authorization: `Bearer ${req.lcToken}` },
    });
    if (!check.ok) return res.status(404).json({ error: "Not found" });
    const rec = await check.json();
    if (rec.user !== req.lcUser.id) return res.status(403).json({ error: "Forbidden" });
    // Delete
    const r = await lcPbFetch(`/api/collections/lc_user_apikeys/records/${req.params.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${req.lcToken}` },
    });
    if (!r.ok) return res.status(r.status).json({ error: "Delete failed" });
    lcTierCache.delete(req.lcUser.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── End LumiChat routes ───────────────────────────────────────────────────────

// ── Agent Platform API routes ─────────────────────────────────────────────────
// Agent Platform API — requires project key or admin session
const platformAuth = async (req, res, next) => {
  const projectKey = req.headers["x-project-key"] || (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  if (safeEqual(projectKey, INTERNAL_CHAT_KEY)) return next();
  if (["root", "admin"].includes(getSessionRole(req))) return next();
  // Check LumiChat token
  const lcCookies = parseCookies(req);
  if (lcCookies.lc_token && validateLcTokenPayload(lcCookies.lc_token)) return next();
  // Check project key
  const proj = ((k) => { const _p = projectKeyIndex.get(k); return _p && _p.enabled ? _p : undefined; })(projectKey);
  if (proj) return next();
  // Check ephemeral token
  if (projectKey.startsWith("et_")) {
    const tokenInfo = ephemeralTokens.get(projectKey);
    if (tokenInfo && Date.now() <= tokenInfo.expiresAt) return next();
  }
  return res.status(401).json({ error: "Authentication required" });
};
app.use("/v1/parse", apiLimiter, platformAuth, require("./routes/parse"));
app.use("/v1/audio", apiLimiter, platformAuth, require("./routes/audio"));
app.use("/v1/vision", apiLimiter, platformAuth, require("./routes/vision"));
app.use("/v1/code", apiLimiter, platformAuth, require("./routes/code"));

// Tool execution endpoint — called by LumiChat frontend when AI returns tool_use
app.post("/v1/tools/execute", apiLimiter, platformAuth, async (req, res) => {
  const { tool_name, tool_input } = req.body;
  if (!tool_name) return res.status(400).json({ ok: false, error: "Missing tool_name" });
  try {
    const result = await unifiedRegistry.executeToolCall(tool_name, tool_input || {});
    if (result.file) {
      // File result — save to PB generated_files and return download URL
      const filename = result.filename || "file";
      const mimeType = result.mimeType || "application/octet-stream";
      try {
        const pbToken = await getPbAdminToken();
        if (pbToken) {
          const boundary = "----FormBoundary" + crypto.randomBytes(8).toString("hex");
          const headerBuf = Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="filename"\r\n\r\n${filename}\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="mime_type"\r\n\r\n${mimeType}\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="user"\r\n\r\n${req._lcUserId || "api"}\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename.replace(/"/g, '_')}"\r\nContent-Type: ${mimeType}\r\n\r\n`
          );
          const footerBuf = Buffer.from(`\r\n--${boundary}--\r\n`);
          const body = Buffer.concat([headerBuf, result.file, footerBuf]);
          const pbRes = await fetch(`${PB_URL}/api/collections/generated_files/records`, {
            method: "POST",
            headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, Authorization: pbToken },
            body,
          });
          if (pbRes.ok) {
            const rec = await pbRes.json();
            const downloadUrl = `${PB_URL}/api/files/generated_files/${rec.id}/${rec.file}`;
            return res.json({ ok: true, data: { filename, mimeType, size: result.file.length, downloadUrl, recordId: rec.id }, duration: result.duration });
          }
        }
      } catch (e) { log("warn", "PB file upload failed", { error: e.message }); }
      // Fallback: return file as base64 if PB upload fails
      return res.json({ ok: true, data: { filename, mimeType, size: result.file.length, base64: result.file.toString("base64") }, duration: result.duration });
    }
    return res.json({ ok: true, data: result.data, duration: result.duration });
  } catch (err) {
    log("error", "Tool execution failed", { tool: tool_name, error: err.message });
    return res.status(500).json({ ok: false, error: "Tool execution failed" });
  }
});
// ── End Agent Platform routes ─────────────────────────────────────────────────

app.use("/v1/:provider", apiLimiter, async (req, res, next) => {
  // Identify project: internal chat key, admin session, project key, or reject
  let projectName;
  const projectKey =
    req.headers["x-project-key"] ||
    (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");

  if (safeEqual(projectKey, INTERNAL_CHAT_KEY)) {
    // Server-internal chat key (never exposed to browser)
    projectName = "_chat";
  } else if (["root", "admin"].includes(getSessionRole(req))) {
    // H-01 fix: only root/admin sessions bypass project policy
    projectName = "_chat";
  } else {
    // 0. LumiChat token (lc_token cookie) — only when no explicit project key is present
    const lcCookies = parseCookies(req);
    const lcToken = lcCookies.lc_token;
    if (!projectKey && lcToken && validateLcTokenPayload(lcToken)) {
      projectName = "_lumichat";
      req._proxyProjectName = "_lumichat";

      // Resolve LumiChat user tier for access control
      const lcPayload = validateLcTokenPayload(lcToken);
      if (lcPayload?.id) {
        try {
          const tierInfo = await getLcUserTier(lcPayload.id, lcToken);
          req._lcTier = tierInfo.tier;
          req._lcByokKeys = tierInfo.byokKeys;
          req._lcUserId = lcPayload.id;
          req._lcToken = lcToken;
        } catch {}
      }
    }

    if (!projectName) {
    // Resolve project via: ephemeral token → HMAC signature → direct key
    let proj = null;

    // 1. Ephemeral token (et_...)
    if (projectKey.startsWith("et_")) {
      const tokenInfo = ephemeralTokens.get(projectKey);
      if (!tokenInfo || Date.now() > tokenInfo.expiresAt) {
        return res.status(401).json({ error: "Token expired or invalid", hint: "Exchange a new token via POST /v1/token" });
      }
      proj = tokenInfo.project;
      if (!proj.enabled) return res.status(403).json({ error: "Project disabled" });
      req._tokenUserId = tokenInfo.userId;
      req._tokenStr = projectKey;
    }
    // 2. HMAC signature (X-Signature header present, no direct key)
    if (!proj && req.headers["x-signature"]) {
      // Identify project by X-Project-Id header
      const projId = req.headers["x-project-id"];
      if (projId) {
        const candidate = projects.find(p => p.enabled && p.name === projId && p.authMode === "hmac");
        if (candidate) {
          const hmacResult = verifyHmacSignature(candidate, req);
          if (!hmacResult.ok) return res.status(401).json({ error: hmacResult.error });
          proj = candidate;
        }
      }
      if (!proj) return res.status(401).json({ error: "HMAC verification failed", hint: "Set X-Project-Id header to project name" });
    }
    // 3. Direct project key (pk_...)
    if (!proj) {
      proj = ((k) => { const _p = projectKeyIndex.get(k); return _p && _p.enabled ? _p : undefined; })(projectKey);
      if (!proj) {
        return res.status(401).json({
          error: "Invalid or missing project key",
          hint: "Set X-Project-Key header or Bearer token",
        });
      }
      // If project requires HMAC, reject direct key usage
      if (proj.authMode === "hmac") {
        return res.status(403).json({ error: "This project requires HMAC signature authentication" });
      }
    }
    projectName = proj.name;

    // Per-project IP allowlist
    if (!checkProjectIP(proj, req)) {
      audit(null, "project_ip_blocked", proj.name, { ip: normalizeIP(req) });
      return res.status(403).json({ error: "IP not allowed for this project" });
    }

    // Per-project rate limit (RPM)
    { const rl = checkProjectRateLimit(proj, req); if (!rl.ok) return res.status(429).json({ error: rl.reason === "ip" ? "Per-IP rate limit exceeded for this project" : "Project rate limit exceeded" }); }

    // Per-token rate limit (RPM per ephemeral token)
    if (req._tokenStr) {
      const trl = checkTokenRateLimit(req._tokenStr, proj);
      if (!trl.ok) return res.status(429).json({ error: "Per-token rate limit exceeded" });
    }

    // Cost-based rate limit (USD/min cap)
    { const crl = checkCostRateLimit(proj); if (!crl.ok) return res.status(429).json({ error: "Project cost rate limit exceeded (USD/min)" }); }

    // Anomaly auto-suspend
    if (!checkProjectAnomaly(proj)) {
      audit(null, "project_anomaly_suspend", proj.name, { ip: normalizeIP(req) });
      return res.status(403).json({ error: "Project suspended due to anomalous activity" });
    }

    // Phase 1b: Model allowlist
    if (proj.allowedModels?.length && req.body?.model) {
      if (!proj.allowedModels.includes(req.body.model)) {
        return res.status(403).json({ error: "Model not allowed for this project" });
      }
    }

    // Phase 1a: Budget enforcement
    checkBudgetReset(proj);
    if (proj.maxBudgetUsd != null && (proj.budgetUsedUsd || 0) >= proj.maxBudgetUsd) {
      sendAlert("budget_exceeded", { project: proj.name, used: proj.budgetUsedUsd, max: proj.maxBudgetUsd });
      return res.status(429).json({ error: "Project budget exceeded" });
    }

    // Stash project ref for budget tracking in onProxyRes
    req._proxyProject = proj;
    } // end if (!projectName) — project resolution block
  } // end else — non-admin/non-internal auth

  const providerName = req.params.provider.toLowerCase();
  const provider = PROVIDERS[providerName];

  // F-10: Don't leak provider list in error response
  if (!provider) {
    return res.status(404).json({ error: "Unknown provider" });
  }

  // --- Tier-based access control for LumiChat users ---
  if (req._proxyProjectName === "_lumichat") {
    // Block unapproved users (no tier = pending approval)
    if (!req._lcTier) {
      return res.status(403).json({ error: "Your account is pending approval. Please wait for admin verification.", pending: true });
    }
    const tier = req._lcTier;
    const isFreeProvider = COLLECTOR_SUPPORTED.includes(providerName);
    const isCollectorProvider = getProviderAccessMode(providerName) === "collector" && isFreeProvider;

    // Basic: only free-tier providers (collector-supported list)
    if (tier === "basic" && !isFreeProvider) {
      return res.status(403).json({
        error: "Upgrade to Premium to access this provider",
        tier: "basic", upgrade: true, provider: providerName,
      });
    }

    // Self-service: collector or BYOK
    if (tier === "selfservice" && !isCollectorProvider) {
      const byokKey = (req._lcByokKeys || []).find(k => k.provider === providerName && k.enabled);
      if (!byokKey) {
        return res.status(403).json({
          error: `Add your own API key for ${providerName} in Settings`,
          tier: "selfservice", needsKey: true, provider: providerName,
          keyUrl: PROVIDERS[providerName]?.keyUrl || null,
        });
      }
      // Use BYOK key instead of gateway key
      req._byokApiKey = decryptValue(byokKey.key_encrypted, ADMIN_SECRET);
    }

    // Per-tier RPM limiting (use Map API for proper cleanup)
    const tierRpm = TIER_RPM[tier] || 30;
    const lcRateKey = `lc_${req._lcUserId}`;
    let bucket = projectRateBuckets.get(lcRateKey);
    if (!bucket) { bucket = { count: 0, resetAt: Date.now() + 60000 }; projectRateBuckets.set(lcRateKey, bucket); }
    if (Date.now() > bucket.resetAt) { bucket.count = 0; bucket.resetAt = Date.now() + 60000; }
    bucket.count++;
    if (bucket.count > tierRpm) {
      return res.status(429).json({ error: "Rate limit exceeded for your subscription tier", tier, limit: tierRpm });
    }
  }

  // --- Collector branch: if provider is in collector mode, route through web collection ---
  if (getProviderAccessMode(providerName) === "collector" && COLLECTOR_SUPPORTED.includes(providerName)) {
    if (!hasCollectorToken(providerName)) {
      return res.status(500).json({ error: `No collector credentials configured for ${providerName}` });
    }
    let credentials;
    try { credentials = getCollectorCredentials(providerName); } catch (e) {
      return res.status(500).json({ error: `Failed to decrypt collector credentials for ${providerName}` });
    }
    const messages = req.body?.messages;
    const modelId = req.body?.model || "";
    const isStream = req.body?.stream !== false;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array required" });
    }
    req._proxyProjectName = projectName;
    let collector;
    try { collector = require("./collector"); } catch { return res.status(503).json({ error: "Collector module not available" }); }
    try {
      if (isStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        for await (const chunk of collector.sendMessage(providerName, modelId, messages, credentials)) {
          if (res.writableEnded) break;
          res.write(chunk);
        }
        res.end();
      } else {
        // Non-stream: collect all chunks and return as single response
        let fullContent = "";
        for await (const chunk of collector.sendMessage(providerName, modelId, messages, credentials)) {
          const parsed = chunk.match(/^data: (.+)$/m);
          if (parsed && parsed[1] !== "[DONE]") {
            try {
              const obj = JSON.parse(parsed[1]);
              const delta = obj.choices?.[0]?.delta?.content;
              if (delta) fullContent += delta;
            } catch {}
          }
        }
        res.json({
          id: `chatcmpl-collector-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{ index: 0, message: { role: "assistant", content: fullContent }, finish_reason: "stop" }],
        });
      }
      setCollectorHealth(providerName, true);
      log("info", "Collector request completed", { provider: providerName, model: modelId, project: projectName });
    } catch (e) {
      setCollectorHealth(providerName, false, e.message);
      log("error", "Collector error", { provider: providerName, error: e.message });
      if (!res.headersSent) res.status(502).json({ error: `Collector error: ${e.message}` });
    }
    return;
  }

  // Select API key: BYOK (self-service) → project-specific → public
  const selectedKey = req._byokApiKey ? null : selectApiKey(providerName, projectName);
  if (!req._byokApiKey && !selectedKey && !provider.apiKey) {
    return res.status(403).json({ error: "Provider has no API key configured" });
  }
  const proxyApiKey = req._byokApiKey || selectedKey?.apiKey || provider.apiKey;
  req._selectedKeyId = selectedKey?.keyId;
  req._isSubscriptionKey = proxyApiKey?.startsWith("sk-ant-oat");

  // F-04: Validate upstream path against allowlist (O-02: normalize like pathRewrite)
  let incomingSubpath = req.path.replace(new RegExp(`^/v1/${providerName}`, "i"), "");
  if (providerName === "gemini") {
    incomingSubpath = incomingSubpath.replace(/^\/v1\//, "/v1beta/openai/");
  } else if (providerName === "doubao") {
    incomingSubpath = incomingSubpath.replace(/^\/v1\//, "/");
  }
  const allowedPaths = ALLOWED_UPSTREAM_PATHS[providerName];
  if (allowedPaths && !allowedPaths.some(p => incomingSubpath.startsWith(p))) {
    return res.status(403).json({ error: "Requested API path is not allowed for this provider" });
  }

  // Stash project name for onProxyRes
  req._proxyProjectName = projectName;

  // ── Tool Schema Injection + PII Detection (before forwarding to LLM) ──────
  const proj = req._proxyProject;
  const isChat = Array.isArray(req.body?.messages);
  const isStreamReq = req.body?.stream === true;

  // B. Tool prompt injection — text-based tool calling via [TOOL:name]{params}[/TOOL] tags
  // Works with ANY model. Server-side proxy handler executes tools after stream ends.
  // Skip for small/economy models that misinterpret tool prompts
  const proxyModelId = req.body?.model || "";
  const SMALL_MODEL_RE = /nano|(?<![a-z])mini(?!max)|flash-lite|(?<![a-z])haiku|(?<![a-z])8b(?![a-z])|(?<![a-z])7b(?![a-z])/i;
  if (isChat && proj?.toolInjection !== false && settings.toolInjectionEnabled !== false && !SMALL_MODEL_RE.test(proxyModelId)) {
    try {
      const toolPrompt = unifiedRegistry.getSystemPrompt();
      if (toolPrompt && !toolPrompt.includes("No tools")) {
        if (providerName === "anthropic") {
          if (typeof req.body.system === "string") {
            req.body.system = req.body.system + "\n\n" + toolPrompt;
          } else if (Array.isArray(req.body.system)) {
            req.body.system.push({ type: "text", text: toolPrompt });
          } else {
            req.body.system = toolPrompt;
          }
        } else {
          const sysMsg = req.body.messages.find(m => m.role === "system");
          if (sysMsg) {
            sysMsg.content = (sysMsg.content || "") + "\n\n" + toolPrompt;
          } else {
            req.body.messages.unshift({ role: "system", content: toolPrompt });
          }
        }
      }
    } catch (err) {
      log("warn", "Tool prompt injection failed", { error: err.message });
    }
  }

  // C. PII Detection + Secret Masking — only for chat requests
  let secMapping = null;
  let sessionId = null;
  if (isChat) {
    // Extract last user message content
    const lastUserMsg = [...req.body.messages].reverse().find(m => m.role === "user");
    const userContent = typeof lastUserMsg?.content === "string"
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg?.content)
        ? lastUserMsg.content.filter(b => b.type === "text").map(b => b.text).join(" ")
        : "";

    if (userContent) {
      const entities = detectPII(userContent);
      if (entities.length > 0) {
        sessionId = req.body.session_id || req.headers["x-session-id"] || req.traceId || crypto.randomUUID();
        secMapping = getMapping(sessionId);
        req._secMapping = secMapping;
        req._secSessionId = sessionId;

        // Register each detected entity and mask in message content
        for (const ent of entities) {
          secMapping.add(ent.value, ent.type);
        }

        // Mask all messages (deep transform)
        req.body.messages = req.body.messages.map(msg => {
          if (typeof msg.content === "string") {
            return { ...msg, content: secMapping.mask(msg.content) };
          }
          if (Array.isArray(msg.content)) {
            return { ...msg, content: msg.content.map(block =>
              block.type === "text" ? { ...block, text: secMapping.mask(block.text) } : block
            )};
          }
          return msg;
        });

        // For streaming: send security_notice SSE event before proxying starts
        if (isStreamReq) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("X-Accel-Buffering", "no");
          res.write(`event: security_notice\ndata: ${JSON.stringify({ message: "\u{1F512} 检测到隐私/密钥信息，正在进行加密处理..." })}\n\n`);
        }

        // E. Security event logging (async, non-blocking)
        const userId = req._lcUserId || req._tokenUserId;
        const projectId = projectName;
        getPbAdminToken().then(token => {
          if (!token) return;
          fetch(`${PB_URL}/api/collections/security_events/records`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: token },
            body: JSON.stringify({
              user: userId || projectId || "unknown",
              source: req.get("X-Source") || "api",
              event_type: "pii_detected",
              severity: entities.some(e => e.score > 0.9) ? "warning" : "info",
              detail_json: JSON.stringify({ count: entities.length, types: entities.map(e => e.type) }),
              session_id: sessionId || "",
              ip_address: req.ip,
            }),
          }).catch(() => {});
        }).catch(() => {});
      }
    }
  }

  // Anthropic OpenAI-compat intercept: /v1/chat/completions → /v1/messages + format translation
  if (providerName === "anthropic" && incomingSubpath === "/v1/chat/completions") {
    handleAnthropicCompat(req, res, proxyApiKey, projectName).catch(err => {
      log("error", "handleAnthropicCompat unhandled error", { error: err.message, traceId: req.traceId });
      if (!res.headersSent) res.status(502).json({ error: "Internal error" });
    });
    return;
  }

  // Inject auth — replace any client-sent auth
  if (providerName === "anthropic") {
    const authH = anthropicAuthHeaders(proxyApiKey, req.headers["anthropic-beta"]);
    Object.assign(req.headers, authH);
    if (!authH["x-api-key"]) delete req.headers["x-api-key"];
    if (!authH["authorization"]) delete req.headers["authorization"];
  } else {
    req.headers["authorization"] = `Bearer ${proxyApiKey}`;
  }
  delete req.headers["host"];
  delete req.headers["x-project-key"];

  proxyMiddleware(req, res, next);
});

// Global error handler — prevent stack trace leakage
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  console.error(`[${req.method} ${req.path}] ${err.message}`);
  if (res.headersSent) return;
  const msg = status === 400 ? "Bad request" : status === 413 ? "Payload too large" : "Internal server error";
  res.status(status).json({ error: msg });
});

// ============================================================
// Start server + graceful shutdown
// ============================================================
const server = app.listen(PORT, "0.0.0.0", () => {
  ensureLcSchemaExtensions();
  const available = Object.entries(PROVIDERS)
    .filter(([name]) => (providerKeys[name] || []).some(k => k.enabled))
    .map(([name]) => name);
  console.log(`LumiGate running on port ${PORT} [${DEPLOY_MODE} mode, modules: ${[...modules].join(",")}]`);
  console.log(`Available providers: ${available.join(", ")}`);
  console.log(`Admin auth: ${process.env.ADMIN_SECRET ? "configured" : "temporary (set ADMIN_SECRET in .env)"}`);

  // M-01: Startup module validation warnings
  const critical = ["audit", "metrics", "backup"];
  const disabled = critical.filter(m => !mod(m));
  if (disabled.length > 0) {
    console.warn(`WARNING: Enterprise modules disabled: ${disabled.join(", ")}. Set DEPLOY_MODE=enterprise to enable all.`);
  }
  if (DEPLOY_MODE === "custom" && modules.size === 0) {
    console.warn("WARNING: DEPLOY_MODE=custom but no MODULES specified. No optional features active.");
  }

  audit("system", "startup", null, { port: PORT, mode: DEPLOY_MODE, modules: [...modules], providers: available });
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
  audit("system", "shutdown", null, { signal, uptime: Math.floor((Date.now() - sli.startedAt) / 1000) });

  // Save data immediately
  if (usageDirty) saveUsage();
  if (projectsDirty) { saveProjects(projects); projectsDirty = false; }
  if (tokensDirty) { saveTokens(); tokensDirty = false; }

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

// Crash-safe: flush dirty data before dying on unhandled errors
function emergencyFlush(reason, err) {
  console.error(`EMERGENCY FLUSH (${reason}):`, err?.message || err);
  try { if (usageDirty) saveUsage(); } catch {}
  try { if (projectsDirty) { saveProjects(projects); projectsDirty = false; } } catch {}
  try { if (tokensDirty) { saveTokens(); tokensDirty = false; } } catch {}
  audit("system", "crash", null, { reason, error: err?.message });
}
process.on("uncaughtException", (err) => { emergencyFlush("uncaughtException", err); process.exit(1); });
process.on("unhandledRejection", (err) => { emergencyFlush("unhandledRejection", err); process.exit(1); });
