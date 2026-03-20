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
const { mcpClient } = require("./tools/mcp-client");
const { registerAuditTools } = require("./tools/audit-tools");
registerAuditTools();
const { registerTemplateFiller } = require("./tools/template-filler");
registerTemplateFiller();
const {
  LumigentRuntime,
  LumigentTraceStore,
  registerBuiltinLumigentTools,
  createInternalHttpBridge,
  createMcpBridge,
  createToolServiceBridge,
  createGeneratedFilePersister,
} = require("./lumigent");
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
const LOG_BUFFER_LIMIT = Math.max(200, Number(process.env.LOG_BUFFER_LIMIT || 1200));
const recentLogs = [];
function appendRecentLog(entry) {
  recentLogs.push(entry);
  if (recentLogs.length > LOG_BUFFER_LIMIT) recentLogs.splice(0, recentLogs.length - LOG_BUFFER_LIMIT);
}
function getRecentLogs({ limit = 200, level, component } = {}) {
  const normLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
  return recentLogs
    .filter(item => (!level || item.level === level) && (!component || item.component === component))
    .slice(-normLimit);
}
function log(level, msg, ctx = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...ctx };
  appendRecentLog(entry);
  process.stdout.write(JSON.stringify(entry) + "\n");
}
function logParamChange(scope, actor, changes, extra = {}) {
  if (!changes || typeof changes !== "object" || !Object.keys(changes).length) return;
  log("info", "parameter_change", {
    component: "settings",
    scope,
    actor: actor || "system",
    changes,
    ...extra,
  });
}

// --- Webhook alerts (non-blocking, fire-and-forget) ---
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;
function sendAlert(type, payload) {
  if (!ALERT_WEBHOOK_URL) return;
  fetch(ALERT_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ts: new Date().toISOString(), gateway: "lumigate", ...payload }),
  }).catch(e => log("warn", "alert_webhook_failed", { component: "alerts", type, error: e.message }));
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
const PB_LC_PROJECT = (process.env.PB_LC_PROJECT || "lumichat").trim() || "lumichat";
const FILE_PARSER_URL = process.env.FILE_PARSER_URL || "http://lumigate-file-parser:3100";

// --- Shared PocketBase helpers (used by admin, lumichat, chat, proxy routes) ---
async function pbFetch(pbPath, options = {}) {
  const url = `${PB_URL}${pbPath}`;
  return fetch(url, options);
}
function toLcProjectPath(pbPath) {
  const p = String(pbPath || "");
  if (p.startsWith(`/api/p/${PB_LC_PROJECT}/`)) return p;
  if (p.startsWith("/api/collections/")) return `/api/p/${PB_LC_PROJECT}${p.slice("/api".length)}`;
  if (p.startsWith("/api/files/")) return `/api/p/${PB_LC_PROJECT}${p.slice("/api".length)}`;
  return p;
}
async function lcPbFetch(pbPath, options = {}) {
  const p = String(pbPath || "");
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
function validPbId(id) { return typeof id === 'string' && /^[a-zA-Z0-9]{15}$/.test(id); }

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
  return String(content || "");
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
  if (_lcExports.lcSupportsField?.("sessions", "updated_at")) patchBody.updated_at = (_lcExports.lcNowIso?.() || new Date().toISOString());
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
  projectKeyIndex.clear();
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
let _lastSavedSettingsSnapshot = null;
function saveSettings(s) {
  const prev = _lastSavedSettingsSnapshot ? JSON.parse(_lastSavedSettingsSnapshot) : {};
  ensureDataDir();
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
  const nextSnapshot = JSON.stringify(s);
  _lastSavedSettingsSnapshot = nextSnapshot;
  try {
    const next = JSON.parse(nextSnapshot);
    const changedKeys = [...new Set([...Object.keys(prev || {}), ...Object.keys(next || {})])]
      .filter(key => JSON.stringify(prev?.[key]) !== JSON.stringify(next?.[key]));
    if (changedKeys.length) {
      const changes = {};
      for (const key of changedKeys) changes[key] = { before: prev?.[key], after: next?.[key] };
      logParamChange("system", "saveSettings", changes, { component: "settings", route: "settings.json" });
    }
  } catch {}
}
let settings = loadSettings();
try { _lastSavedSettingsSnapshot = JSON.stringify(settings || {}); } catch { _lastSavedSettingsSnapshot = "{}"; }
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
  backupCollectorTokensToPB(tokens).catch(e => log("warn", "pb_write_failed", { component: "collector", collection: "collector_tokens_backup", error: e.message }));
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
    { id: "doubao-seed-2-0-mini-260215", tier: "economy", price: { in: 0.03, cacheIn: 0.006, out: 0.31 }, caps: ["text", "image"], desc: "Low latency, 256K context, high-concurrency & cost-sensitive" },
    { id: "doubao-seed-2-0-lite-260215", tier: "standard", price: { in: 0.09, cacheIn: 0.017, out: 0.53 }, caps: ["text", "image"], desc: "General production, 256K context, balanced quality & speed" },
    { id: "doubao-seed-2-0-pro-260215", tier: "flagship", price: { in: 0.47, cacheIn: 0.089, out: 2.37 }, caps: ["text", "image"], desc: "Frontier reasoning, 256K context, complex agents & research" },
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
    { id: "MiniMax-M2.5", tier: "standard", price: { in: 0.29, cacheIn: 0.029, out: 1.16 }, caps: ["text"], desc: "Coding Plan paid tier — SOTA coding (SWE-Bench 80.2%), agentic tool use, 200K context" },
    { id: "MiniMax-M2.7", tier: "flagship", price: { in: 0.50, cacheIn: 0.05, out: 2.00 }, caps: ["text", "thinking"], desc: "Self-evolving model — 30-50% of RL research workflow, advanced reasoning, 200K context" },
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

// 4. Body parser limit (configurable; default raised for large chat payloads)
app.use(express.json({
  limit: process.env.BODY_JSON_LIMIT || "256mb",
  verify: (req, res, buf) => { req._rawBody = buf.toString(); }, // preserve raw body for HMAC
}));

// 5. Request timeout
app.use((req, res, next) => {
  req.setTimeout(Number(process.env.REQUEST_TIMEOUT_MS || 300000)); // default 5 min for large file parse + chat
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
  res.json({ ...base, mode: DEPLOY_MODE, modules: [...modules], providers: available, platform: { parse: true, audio: true, vision: true, code: true, tts: true } });
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

function readPublicHtml(filename) {
  const htmlPath = path.join(__dirname, "public", filename);
  if (!fs.existsSync(htmlPath)) return null;
  return fs.readFileSync(htmlPath, "utf8");
}

// Static files (CSS/JS/images only, HTML served dynamically below)
app.use("/logos", express.static(path.join(__dirname, "public", "logos")));
app.use("/favicon.svg", express.static(path.join(__dirname, "public", "favicon.svg")));
app.use("/lumichat-icon.svg", express.static(path.join(__dirname, "public", "lumichat-icon.svg")));
app.use("/lumichat-apple-touch.png", express.static(path.join(__dirname, "public", "lumichat-apple-touch.png")));
app.use("/lumichat-icon-192.png", express.static(path.join(__dirname, "public", "lumichat-icon-192.png")));
app.use("/lumichat-icon-512.png", express.static(path.join(__dirname, "public", "lumichat-icon-512.png")));
app.use("/manifest.json", express.static(path.join(__dirname, "public", "manifest.json")));
app.use("/lumichat-libs", express.static(path.join(__dirname, "public", "lumichat-libs")));
app.use("/lumichat-ext", express.static(path.join(__dirname, "public", "lumichat-ext")));

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
  const dashboardHtml = readPublicHtml("index.html");
  if (!dashboardHtml) return res.status(503).send("Dashboard not available");
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader("Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'`
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  const html = dashboardHtml.replace(/\{\{NONCE\}\}/g, nonce);
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
  const lumichatHtml = readPublicHtml("lumichat.html");
  if (!lumichatHtml) {
    return res.status(503).send("LumiChat not yet deployed");
  }
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader("Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; img-src 'self' data: blob: https://www.google.com https://*.googleusercontent.com; media-src 'self' blob:; connect-src 'self' https://accounts.google.com https://oauth2.googleapis.com https://www.googleapis.com; frame-src https://accounts.google.com; frame-ancestors 'none'`
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  // Inject nonce into all <script nonce="{{NONCE}}"> and <style nonce="{{NONCE}}"> placeholders
  const html = lumichatHtml.replace(/\{\{NONCE\}\}/g, nonce);
  res.send(html);
});

// Serve LumiTrade interface (nonce injected into HTML for CSP)
app.get("/lumitrade", (req, res) => {
  const lumitradeHtml = readPublicHtml("lumitrade.html");
  if (!lumitradeHtml) {
    return res.status(503).send("LumiTrade not yet deployed");
  }
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader("Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; img-src 'self' data: blob: https://www.google.com; media-src 'self' blob:; connect-src 'self' wss: ws:; frame-src 'self'; frame-ancestors 'none'`
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  const html = lumitradeHtml.replace(/\{\{NONCE\}\}/g, nonce);
  res.send(html);
});

// --- Collector supported providers (shared with admin + proxy) ---
const COLLECTOR_SUPPORTED = ["deepseek", "doubao", "kimi", "qwen"];

// Short TTL cache for usage responses (shared with admin routes for invalidation)
let usageCache = { key: null, data: null, ts: 0 };
let summaryCache = { key: null, data: null, ts: 0 };

// Collector login state (shared with admin routes and LC user routes)
const COLLECTOR_LOGIN_SITES = {
  doubao:  { url: 'https://www.doubao.com/chat/', cookie: 'sessionid', name: '豆包' },
  qwen:   { url: 'https://chat.qwen.ai/',         cookie: 'qwen_session', name: '通义千问' },
  kimi:   { url: 'https://www.kimi.com/',          cookie: 'kimi-auth', name: 'Kimi' },
};
const _loginStateRef = { current: { active: false, provider: null, status: 'idle', page: null, ctx: null } };

// ============================================================
// Admin routes — extracted to routes/admin.js
// ============================================================
const _adminResult = require('./routes/admin')({
  // Middleware & limiters
  adminLimiter,
  loginLimiter,
  adminAuth,
  requireRole,
  // Auth helpers
  safeEqual,
  parseCookies,
  getSessionRole,
  normalizeIP,
  verifyPassword,
  hashPassword,
  verifyTotp,
  generateTotpSecret,
  totpUri,
  // Encryption
  encryptValue,
  decryptValue,
  sanitizeEnvValue,
  // State
  sessions,
  MAX_SESSIONS,
  mfaTokens,
  ADMIN_SECRET,
  PROVIDERS,
  MODELS,
  PROVIDER_HOST_ALLOWLIST,
  startTime,
  sli,
  AUDIT_FILE,
  PB_URL,
  __dirname,
  // Data access (getters for mutable state)
  getProjects: () => projects,
  setProjects: (v) => { projects.length = 0; projects.push(...v); },
  getUsers: () => users,
  setUsers: (v) => { users.length = 0; users.push(...v); },
  getSettings: () => settings,
  setSettings: (v) => { Object.keys(settings).forEach(k => delete settings[k]); Object.assign(settings, v); },
  getProviderKeys: () => providerKeys,
  setProviderKeys: (v) => { Object.keys(providerKeys).forEach(k => delete providerKeys[k]); Object.assign(providerKeys, v); },
  getCollectorTokens: () => collectorTokens,
  setCollectorTokens: (v) => { Object.keys(collectorTokens).forEach(k => delete collectorTokens[k]); Object.assign(collectorTokens, v); },
  getUsageData: () => usageData,
  getExchangeRate: () => exchangeRate,
  usageCache,
  summaryCache,
  // Data persistence
  saveProjects,
  loadProjects,
  rebuildProjectKeyIndex,
  saveUsers,
  loadUsers,
  saveSettings,
  loadSettings,
  saveKeys,
  loadKeys,
  saveCollectorTokens,
  // Project helpers
  validateProjectName,
  initBudgetResetAt,
  validateSmartRouting,
  isPrivateIP,
  markProjectsDirty,
  projectRateBuckets,
  projectTokenIssueBuckets,
  projectIpRateBuckets,
  projectMinuteHistory,
  ephemeralTokens,
  // Key management
  selectApiKey,
  keyCooldowns,
  markKeyCooling,
  // Provider helpers
  anthropicAuthHeaders,
  extractTokens,
  recordUsage,
  calcCost,
  getModelInfo,
  getProviderAccessMode,
  setProviderAccessMode,
  hasCollectorToken,
  setCollectorHealth,
  // Collector
  collectorHealth,
  restoreCollectorTokensFromPB,
  COLLECTOR_SUPPORTED,
  COLLECTOR_LOGIN_SITES,
  loginStateRef: _loginStateRef,
  // Module system
  mod,
  modules,
  ALL_MODULES,
  DEPLOY_MODE_REF: () => DEPLOY_MODE,
  applyDeployMode,
  applyStealthConf,
  // Audit & logging
  audit,
  log,
  logParamChange,
  getRecentLogs,
  // Backup
  createBackup,
  listBackups,
  restoreBackup,
  // PocketBase
  getPbAdminToken,
  lcPbFetch,
  isValidPbId,
  validPbId,
  pbErrorSummary,
  isLcSoftDeleteEnabled: (...a) => _lcExports.isLcSoftDeleteEnabled?.(...a),
  getAttachmentSearchMode: (...a) => _lcExports.getAttachmentSearchMode?.(...a),
  getDomainApiSchema: (...a) => _lcExports.getDomainApiSchema?.(...a),
  pbListOwnedRecords: (...a) => _lcExports.pbListOwnedRecords?.(...a),
  withSoftDeleteFilters: (...a) => _lcExports.withSoftDeleteFilters?.(...a),
  restoreSoftDeletedRecord: (...a) => _lcExports.restoreSoftDeletedRecord?.(...a),
  listReferencingRecords: (...a) => _lcExports.listReferencingRecords?.(...a),
  assertNoBlockingReferences: (...a) => _lcExports.assertNoBlockingReferences?.(...a),
  remapLcProjectReferences: (...a) => _lcExports.remapLcProjectReferences?.(...a),
  get LC_COLLECTION_CONFIG() { return _lcExports.LC_COLLECTION_CONFIG; },
  get lcTierCache() { return lcTierCache; },
});
app.use(_adminResult.router);

// Late-binding container for lumichat.js exports (populated after mount below)
let _lcExports = {};

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
        const toolResults = await lumigentRuntime.executeTextToolCalls(anthContentToScan, req._lcUserId || req._proxyProjectName || "api");
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
        const result = await lumigentRuntime.executeToolCall(toolName, toolInput);

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
          }).catch(e => log("warn", "pb_write_failed", { component: "tools", collection: "tool_calls", tool: toolName, error: e.message }));
        }).catch(e => log("warn", "pb_write_failed", { component: "tools", collection: "tool_calls", reason: "no_token", error: e.message }));

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
              }).catch(e => log("warn", "pb_write_failed", { component: "tools", collection: "generated_files", filename: result.filename, error: e.message }));
            }
          } catch (e) { log("warn", "pb_write_failed", { component: "tools", collection: "generated_files", error: e.message }); }
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

const persistGeneratedToolFile = createGeneratedFilePersister({
  getPbAdminToken,
  pbUrl: PB_URL,
});

const lumigentTraceStore = new LumigentTraceStore({ limit: 300 });
const lumigentInternalHttpBridge = createInternalHttpBridge({
  port: PORT,
  authKey: INTERNAL_CHAT_KEY,
});
const lumigentMcpBridge = createMcpBridge({ client: mcpClient });
const lumigentToolServiceBridge = createToolServiceBridge({ executeBuiltinTool: executeToolCall });

registerBuiltinLumigentTools(unifiedRegistry, {
  toolService: lumigentToolServiceBridge,
  internalHttp: lumigentInternalHttpBridge,
  mcp: lumigentMcpBridge,
});

// Register HKEX filing download tool
try {
  const { registerHKEXTool } = require("./tools/hkex-downloader");
  registerHKEXTool(unifiedRegistry);
} catch (e) {
  log("warn", "HKEX tool registration skipped", { error: e.message });
}

// Register LumiTrade trading tools
try {
  const { registerTradeTools } = require("./tools/trade-tools");
  registerTradeTools(unifiedRegistry);
  log("info", "LumiTrade tools registered");
} catch (e) {
  log("warn", "LumiTrade tool registration skipped", { error: e.message });
}

const lumigentRuntime = new LumigentRuntime({
  registry: unifiedRegistry,
  logger: log,
  persistFile: persistGeneratedToolFile,
  traceStore: lumigentTraceStore,
});

// ── PocketBase Store + Schema Provisioning ──────────────────────────────────
const { PBStore } = require("./services/pb-store");
const { ensureCollections } = require("./services/pb-schema");

const pbStore = new PBStore({ pbUrl: PB_URL, getAdminToken: getPbAdminToken, log });

// Auto-create missing PB collections on startup (async, non-blocking)
(async () => {
  try {
    const adminToken = await getPbAdminToken();
    if (adminToken) {
      const result = await ensureCollections(PB_URL, adminToken, log);
      if (result.created.length > 0) {
        log("info", "PB collections provisioned", { created: result.created });
      }
      if (result.errors.length > 0) {
        log("warn", "PB collection provisioning errors", { errors: result.errors });
      }
    }
  } catch (err) {
    log("warn", "PB schema provisioning skipped", { error: err.message });
  }
})();

// ── Knowledge Base / RAG service ─────────────────────────────────────────────
const { createKnowledgeService } = require("./services/knowledge");
const knowledgeService = createKnowledgeService({
  qdrantUrl: process.env.QDRANT_URL || "http://lumigate-qdrant:6333",
  qdrantApiKey: process.env.QDRANT_API_KEY,
  embeddingProvider: process.env.EMBEDDING_PROVIDER || "openai",
  embeddingApiKey: process.env.OPENAI_API_KEY,
  embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
  fileParserUrl: FILE_PARSER_URL,
  pbStore,
  log,
});
const knowledgeManager = knowledgeService.manager;

// ── RAGFlow integration (primary RAG backend, optional) ─────────────────────
const { RAGFlowClient } = require("./services/knowledge/ragflow-client");
const { RAGAdapter } = require("./services/knowledge/rag-adapter");

const ragflowClient = process.env.RAGFLOW_URL
  ? new RAGFlowClient({
      baseUrl: process.env.RAGFLOW_URL,
      apiKey: process.env.RAGFLOW_API_KEY || "",
      log,
    })
  : null;
const ragAdapter = new RAGAdapter({
  ragflowClient,
  knowledgeManager,
  log,
});
// Init is async — fire and forget at startup, adapter degrades gracefully
ragAdapter.init().catch((e) =>
  log("warn", "RAGAdapter init error (non-fatal)", { component: "rag-adapter", error: e.message })
);

// ── User Memory service (per-user long-term RAG memory) ──────────────────────
const { createUserMemoryService } = require("./services/memory");

/**
 * Lightweight LLM fetch for memory fact extraction / profile summarization.
 * Uses DeepSeek (cheapest) or falls back to OpenAI.
 */
async function memoryLlmFetch(messages, { temperature = 0, maxTokens = 1024 } = {}) {
  // Try providers in order of cost: deepseek → openai → gemini
  const providers = ["deepseek", "openai", "gemini"];
  const defaultModels = {
    deepseek: "deepseek-chat",
    openai: "gpt-4o-mini",
    gemini: "gemini-2.0-flash",
  };

  for (const provName of providers) {
    const keyInfo = selectApiKey(provName, "_memory");
    if (!keyInfo) continue;

    const prov = PROVIDERS[provName];
    if (!prov) continue;

    let url, headers, body;
    if (provName === "gemini") {
      url = `${prov.baseUrl}/v1beta/openai/chat/completions`;
    } else {
      url = `${prov.baseUrl}/v1/chat/completions`;
    }
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${keyInfo.apiKey}`,
    };
    body = {
      model: defaultModels[provName],
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || "";
      if (text) return text;
    } catch {
      continue;
    }
  }
  throw new Error("memoryLlmFetch: no provider available");
}

let userMemory = null;
try {
  userMemory = createUserMemoryService({
    qdrantUrl: process.env.QDRANT_URL || "http://lumigate-qdrant:6333",
    qdrantApiKey: process.env.QDRANT_API_KEY,
    embeddingProvider: process.env.EMBEDDING_PROVIDER || "openai",
    embeddingApiKey: process.env.OPENAI_API_KEY,
    embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    pbStore,
    llmFetch: memoryLlmFetch,
    log,
  });
  log("info", "User memory service initialized", { component: "user-memory" });
} catch (err) {
  log("warn", "User memory service init failed (non-fatal)", { component: "user-memory", error: err.message });
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
    const toolResults = await lumigentRuntime.executeTextToolCalls(contentToScan, req._lcUserId || req._proxyProjectName || "api");
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
          ? lumigentRuntime.executeTextToolCalls(contentToScan, req._lcUserId || req._proxyProjectName || "api")
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

// ============================================================
// LumiChat, Chat Proxy, and Provider Proxy — extracted routes
// ============================================================
const { analyzeFinancialStatements } = require("./tools/financial-analysis");

const _lcResult = require('./routes/lumichat')({
  PB_URL,
  DATA_DIR,
  ADMIN_SECRET,
  PROVIDERS,
  MODELS,
  COLLECTOR_SUPPORTED,
  COLLECTOR_LOGIN_SITES,
  settings,
  log,
  audit,
  safeEqual,
  encryptValue,
  decryptValue,
  isValidPbId,
  pbErrorSummary,
  clampPbMessageContent,
  validateLcTokenPayload,
  requireLcAuth,
  requireFnAuth: undefined, // defined inside lumichat.js (FurNote auth — not yet wired externally)
  requireRole,
  adminAuth,
  isAdminRequest,
  lcAuthLimiter,
  lcRegisterLimiter,
  lcUpload,
  apiLimiter,
  getLcUserTier,
  lcTierCache,
  TIER_RPM,
  getLcFileSandboxPolicy: () => settings.lcFileSandboxPolicy || { trustedUsers: [], uploadEnabled: false, uploadTrustedBypass: false },
  touchLcSession,
  getPbAdminToken,
  selectApiKey,
  getProviderAccessMode,
  hasCollectorToken,
  saveCollectorTokens,
  setCollectorHealth,
  saveSettings,
  logParamChange,
  providerKeys,
  collectorTokens,
  collectorHealth,
  analyzeFinancialStatements,
  normalizeIP,
  saveCollectorCookies: (...a) => _adminResult.saveCollectorCookies?.(...a),
  sendAdminNotify,
  _getLoginState: () => _loginStateRef.current,
  _setLoginState: (v) => { _loginStateRef.current = v; },
  _getGlobalRegCount: () => _globalRegCount,
  _setGlobalRegCount: (v) => { _globalRegCount = v; },
  // Passed through to chat router
  INTERNAL_CHAT_KEY,
  getSessionRole,
  parseCookies,
  projects,
  projectKeyIndex,
  ephemeralTokens,
  verifyHmacSignature,
  checkBudgetReset,
  getCollectorCredentials,
  lumigentRuntime,
  recordUsage,
  shouldAutoContinueFinishReason,
  getContinuationPrompt,
  AUTO_CONTINUE_MAX_PASSES,
  _collector: () => { try { return require("./collector"); } catch { return null; } },
  userMemory,
});
app.use(_lcResult.router);
_lcExports = _lcResult; // populate late-binding container for admin routes

// NOTE: /v1/chat is mounted inside lumichat.js (routes/chat.js required there).
// Do NOT duplicate-mount here — lumichat.js's mount handles it.

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
// Mount platform routes at BOTH /platform/* (actual consumers) and /v1/* (legacy)
const parseRouter = require("./routes/parse");
const audioRouter = require("./routes/audio");
const visionRouter = require("./routes/vision");
const codeRouter = require("./routes/code");
const ttsRouter = require("./routes/tts");
app.use("/platform/parse", apiLimiter, platformAuth, parseRouter);
app.use("/platform/audio", apiLimiter, platformAuth, audioRouter);
app.use("/platform/audio", apiLimiter, platformAuth, ttsRouter);   // TTS: /platform/audio/tts
app.use("/platform/vision", apiLimiter, platformAuth, visionRouter);
app.use("/platform/code", apiLimiter, platformAuth, codeRouter);
app.use("/v1/parse", apiLimiter, platformAuth, parseRouter);
app.use("/v1/audio", apiLimiter, platformAuth, audioRouter);
app.use("/v1/audio", apiLimiter, platformAuth, ttsRouter);         // TTS: /v1/audio/tts
app.use("/v1/vision", apiLimiter, platformAuth, visionRouter);
app.use("/v1/code", apiLimiter, platformAuth, codeRouter);
app.use(apiLimiter, platformAuth, require("./routes/knowledge").createRouter({ manager: knowledgeManager, log }));

// ── LumiTrade API routes ──────────────────────────────────────────────────────
let _tradeResult = null;
try {
  _tradeResult = require("./routes/trade")({ PB_URL, getPbAdminToken });
  app.use("/v1/trade", apiLimiter, platformAuth, _tradeResult.router);
  log("info", "LumiTrade routes mounted at /v1/trade/*");
} catch (e) {
  log("warn", "LumiTrade routes not loaded", { error: e.message });
}

// Template filler REST endpoint
const templateFillerRouter = require("./routes/template-filler");
app.use("/platform/tools", apiLimiter, platformAuth, templateFillerRouter);
app.use("/v1/tools", apiLimiter, platformAuth, templateFillerRouter);

const lumigentToolsHandler = async (_req, res) => {
  try {
    const tools = await unifiedRegistry.getSchemas();
    res.json({ ok: true, runtime: "lumigent", tools });
  } catch (err) {
    log("error", "Lumigent tool listing failed", { error: err.message });
    res.status(500).json({ ok: false, error: "Lumigent tool listing failed" });
  }
};
const lumigentTracesHandler = async (req, res) => {
  try {
    res.json({ ok: true, runtime: "lumigent", traces: lumigentTraceStore.list(req.query.limit || 50) });
  } catch (err) {
    log("error", "Lumigent trace listing failed", { error: err.message });
    res.status(500).json({ ok: false, error: "Lumigent trace listing failed" });
  }
};
const lumigentExecuteHandler = async (req, res) => {
  const { tool_name, tool_input } = req.body || {};
  if (!tool_name) return res.status(400).json({ ok: false, error: "Missing tool_name" });
  try {
    const result = await lumigentRuntime.executeToolCall(tool_name, tool_input || {});
    return res.json({ ok: !!result.ok, result });
  } catch (err) {
    log("error", "Lumigent direct execute failed", { tool: tool_name, error: err.message });
    return res.status(500).json({ ok: false, error: "Lumigent execute failed" });
  }
};
app.get("/v1/lumigent/tools", apiLimiter, platformAuth, lumigentToolsHandler);
app.get("/v1/lumigent/traces", apiLimiter, platformAuth, lumigentTracesHandler);
app.post("/v1/lumigent/execute", apiLimiter, platformAuth, lumigentExecuteHandler);
app.get("/platform/lumigent/tools", apiLimiter, platformAuth, lumigentToolsHandler);
app.get("/platform/lumigent/traces", apiLimiter, platformAuth, lumigentTracesHandler);
app.post("/platform/lumigent/execute", apiLimiter, platformAuth, lumigentExecuteHandler);

// Tool execution endpoint — called by LumiChat frontend when AI returns tool_use
const toolExecuteHandler = async (req, res) => {
  const { tool_name, tool_input } = req.body;
  if (!tool_name) return res.status(400).json({ ok: false, error: "Missing tool_name" });
  try {
    const result = await lumigentRuntime.executeToolCall(tool_name, tool_input || {});
    if (result.file) {
      // File result — save to PB generated_files and return download URL
      const filename = result.filename || "file";
      const mimeType = result.mimeType || "application/octet-stream";
      try {
        const downloadUrl = await persistGeneratedToolFile({ userId: req._lcUserId || "api", filename, mimeType, file: result.file });
        if (downloadUrl) return res.json({ ok: true, data: { filename, mimeType, size: result.file.length, downloadUrl }, duration: result.duration });
      } catch (e) { log("warn", "PB file upload failed", { error: e.message }); }
      // Fallback: return file as base64 if PB upload fails
      return res.json({ ok: true, data: { filename, mimeType, size: result.file.length, base64: result.file.toString("base64") }, duration: result.duration });
    }
    return res.json({ ok: true, data: result.data, duration: result.duration });
  } catch (err) {
    log("error", "Tool execution failed", { tool: tool_name, error: err.message });
    return res.status(500).json({ ok: false, error: "Tool execution failed" });
  }
};
app.post("/v1/tools/execute", apiLimiter, platformAuth, toolExecuteHandler);
app.post("/platform/tools/execute", apiLimiter, platformAuth, toolExecuteHandler);

// ── Workflow routes ───────────────────────────────────────────────────────────
const { createWorkflowRouter } = require("./routes/workflow");
const workflowRouter = createWorkflowRouter({ unifiedRegistry, lumigentRuntime, log });
app.use("/v1/workflows", apiLimiter, platformAuth, workflowRouter);
app.use("/platform/workflows", apiLimiter, platformAuth, workflowRouter);

// ── Observability routes ──────────────────────────────────────────────────────
const createObservabilityRouter = require("./routes/observability");
const observabilityRouter = createObservabilityRouter({ traceCollector: null, evaluator: null, getSessionRole, parseCookies, log });
app.use("/v1/traces", apiLimiter, platformAuth, observabilityRouter);
app.use("/platform/traces", apiLimiter, platformAuth, observabilityRouter);

// ── Version routes ────────────────────────────────────────────────────────────
const versionsRouter = require("./routes/versions");
app.use("/v1/versions", apiLimiter, platformAuth, versionsRouter);
app.use("/platform/versions", apiLimiter, platformAuth, versionsRouter);

// ── Sandbox routes ────────────────────────────────────────────────────────────
const createSandboxRouter = require("./routes/sandbox");
const sandboxRouter = createSandboxRouter({ logger: log });
app.use("/v1/sandbox", apiLimiter, platformAuth, sandboxRouter);
app.use("/platform/sandbox", apiLimiter, platformAuth, sandboxRouter);

// ── HKEX filing download routes ───────────────────────────────────────────────
const createHKEXRouter = require("./routes/hkex");
const hkexRouter = createHKEXRouter({ log });
app.use("/v1/hkex", apiLimiter, platformAuth, hkexRouter);
app.use("/platform/hkex", apiLimiter, platformAuth, hkexRouter);

// ── End Agent Platform routes ─────────────────────────────────────────────────

// ============================================================
// Provider Proxy — /v1/:provider (extracted to routes/proxy.js)
// ============================================================
app.use("/v1/:provider", require('./routes/proxy')({
  apiLimiter,
  safeEqual,
  INTERNAL_CHAT_KEY,
  getSessionRole,
  parseCookies,
  validateLcTokenPayload,
  getLcUserTier,
  projects,
  projectKeyIndex,
  ephemeralTokens,
  verifyHmacSignature,
  checkProjectIP,
  checkProjectRateLimit,
  checkTokenRateLimit,
  checkCostRateLimit,
  checkProjectAnomaly,
  checkBudgetReset,
  normalizeIP,
  audit,
  sendAlert,
  markProjectsDirty,
  PROVIDERS,
  ALLOWED_UPSTREAM_PATHS,
  COLLECTOR_SUPPORTED,
  getProviderAccessMode,
  hasCollectorToken,
  getCollectorCredentials,
  setCollectorHealth,
  selectApiKey,
  decryptValue,
  ADMIN_SECRET,
  TIER_RPM,
  projectRateBuckets,
  lumigentRuntime,
  settings,
  handleAnthropicCompat,
  anthropicAuthHeaders,
  proxyMiddleware,
  log,
  getPbAdminToken,
  PB_URL,
  _collector: () => { try { return require("./collector"); } catch { return null; } },
}));

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
  if (_lcExports.ensureLcSchemaExtensions) _lcExports.ensureLcSchemaExtensions();
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

// Wire up LumiTrade WebSocket proxy
if (_tradeResult && _tradeResult.setupTradeWebSocket) {
  _tradeResult.setupTradeWebSocket(server);
  log("info", "LumiTrade WebSocket proxy active at /v1/trade/ws/*");
}

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
