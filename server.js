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
function deriveEncKey(secret) {
  return crypto.scryptSync(secret, 'lumigate-enc-salt', 32);
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
function normalizeIP(req) {
  const forwarded = req.headers["x-forwarded-for"]?.split(",")[0]?.trim();
  const ip = forwarded || req.ip || "unknown";
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

// Per-project rate limiter (in-memory, 1-min buckets)
// Two tiers: project-wide total RPM + per-IP RPM within project
const projectRateBuckets = new Map(); // projectName -> { count, resetAt }
const projectIpRateBuckets = new Map(); // "projectName:ip" -> { count, resetAt }
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
const BACKUP_DIR = path.join(DATA_DIR, "backups");

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
  const files = [PROJECTS_FILE, USAGE_FILE, RATE_FILE, USERS_FILE, SETTINGS_FILE, KEYS_FILE];
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
    const obj = Object.fromEntries(ephemeralTokens);
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

const PROVIDERS = {
  openai: { baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com", apiKey: decryptEnvKey("OPENAI_API_KEY") },
  anthropic: { baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com", apiKey: decryptEnvKey("ANTHROPIC_API_KEY") },
  gemini: { baseUrl: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com", apiKey: decryptEnvKey("GEMINI_API_KEY") },
  deepseek: { baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com", apiKey: decryptEnvKey("DEEPSEEK_API_KEY") },
  kimi: { baseUrl: process.env.KIMI_BASE_URL || "https://api.moonshot.cn", apiKey: decryptEnvKey("KIMI_API_KEY") },
  doubao: { baseUrl: process.env.DOUBAO_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3", apiKey: decryptEnvKey("DOUBAO_API_KEY") },
  qwen: { baseUrl: process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode", apiKey: decryptEnvKey("QWEN_API_KEY") },
  minimax: { baseUrl: process.env.MINIMAX_BASE_URL || "https://api.minimax.chat", apiKey: decryptEnvKey("MINIMAX_API_KEY") },
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
    { id: "claude-haiku-4-5-20251001", tier: "economy", price: { in: 1.00, cacheIn: 0.10, out: 5.00 }, caps: ["text", "image", "pdf"], desc: "Code completion, classification, summarization — sub-second, 200K" },
    { id: "claude-sonnet-4-5-20250514", tier: "standard", price: { in: 3.00, cacheIn: 0.30, out: 15.00 }, caps: ["text", "image", "pdf"], desc: "Extended thinking, complex coding, long-form writing" },
    { id: "claude-opus-4-6", tier: "flagship", price: { in: 5.00, cacheIn: 0.50, out: 25.00 }, caps: ["text", "image", "pdf"], desc: "Autonomous coding, deep research, 200K analysis" },
  ],
  gemini: [
    { id: "gemini-2.5-flash-lite", tier: "economy", price: { in: 0.10, cacheIn: 0.01, out: 0.40 }, freeRPD: 1500, caps: ["text", "image", "audio"], desc: "High-throughput summarization/classification, audio input — 1500 free/day" },
    { id: "gemini-2.0-flash", tier: "economy", price: { in: 0.10, cacheIn: 0.025, out: 0.40 }, freeRPD: 1500, caps: ["text", "image", "audio", "video"], desc: "Fast multimodal — audio/video/image input, 1M context, 1500 free/day" },
    { id: "gemini-2.5-flash", tier: "standard", price: { in: 0.30, cacheIn: 0.03, out: 2.50 }, freeRPD: 500, caps: ["text", "image", "audio", "video", "pdf"], desc: "Code gen, math reasoning, 1M context — 500 free/day" },
    { id: "gemini-2.5-pro", tier: "flagship", price: { in: 1.25, cacheIn: 0.125, out: 10.00 }, freeRPD: 25, caps: ["text", "image", "audio", "video", "pdf"], desc: "Multimodal video analysis, 1M context — 25 free/day" },
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
    { id: "MiniMax-M2", tier: "economy", price: { in: 0.29, cacheIn: 0.029, out: 1.16 }, caps: ["text"], desc: "Compact high-efficiency — coding, agentic workflows, 196K" },
    { id: "MiniMax-M2.1", tier: "standard", price: { in: 0.29, cacheIn: 0.029, out: 1.16 }, caps: ["text"], desc: "Optimized for coding and agentic workflows, 196K context" },
    { id: "MiniMax-M2.5", tier: "flagship", price: { in: 0.29, cacheIn: 0.029, out: 1.16 }, caps: ["text"], desc: "SOTA coding (SWE-Bench 80.2%), agentic tool use, 200K context" },
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

const loginLimiter = rateLimit({
  ...rateLimitOpts,
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 login attempts per 15 min
  message: { error: "Too many login attempts" },
});

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
app.get("/health", (req, res) => {
  const available = Object.entries(PROVIDERS)
    .filter(([name]) => (providerKeys[name] || []).some(k => k.enabled))
    .map(([name]) => name);
  res.json({ status: "ok", mode: DEPLOY_MODE, modules: [...modules], providers: available, uptime: Math.floor((Date.now() - startTime) / 1000) });
});

app.get("/providers", (req, res) => {
  res.json(Object.entries(PROVIDERS).map(([name, cfg]) => {
    const allKeys = providerKeys[name] || [];
    const enabledKeys = allKeys.filter(k => k.enabled);
    return {
      name,
      baseUrl: cfg.baseUrl,
      available: enabledKeys.length > 0,
      keyCount: allKeys.length,
      enabledCount: enabledKeys.length,
    };
  }));
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

// F-02: Serve chat — requires root/admin session (no key exposed to browser)
app.get("/chat", (req, res) => {
  if (!mod("chat")) return res.redirect("/");
  const role = getSessionRole(req);
  if (!role || role === "user") return res.redirect("/");
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

// ============================================================
// Admin auth: login/logout
// ============================================================
app.post("/admin/login", loginLimiter, async (req, res) => {
  // Flow 1: ADMIN_SECRET (root)
  if (req.body.secret) {
    if (safeEqual(req.body.secret, ADMIN_SECRET)) {
      const sessionToken = crypto.randomBytes(32).toString('hex');
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      sessions.set(sessionToken, { createdAt: Date.now(), role: "root", username: "_root" });
      const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https" || (req.headers["cf-visitor"] || "").includes("https");
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
  const sessionToken = crypto.randomBytes(32).toString('hex');
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  sessions.set(sessionToken, { createdAt: Date.now(), role: user.role, username: user.username });
  const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https" || (req.headers["cf-visitor"] || "").includes("https");
  res.cookie("admin_token", sessionToken, { httpOnly: true, sameSite: "Strict", secure: isSecure, path: "/", maxAge: 86400000 });
  audit(user.username, "login", null, { method: "password", role: user.role });
  res.json({ success: true, role: user.role });
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
      headers["x-api-key"] = testKey;
      headers["anthropic-version"] = "2023-06-01";
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
    proj.name = req.body.newName;
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
  audit(req.userName, "project_update", req.params.name, { fields: Object.keys(req.body) });
  res.json({ success: true, project: proj });
});

app.post("/admin/projects/:name/regenerate", requireRole("root", "admin"), (req, res) => {
  const proj = projects.find((p) => p.name === req.params.name);
  if (!proj) return res.json({ success: false, error: "project not found" });
  proj.key = "pk_" + crypto.randomBytes(24).toString("hex");
  saveProjects(projects);
  audit(req.userName, "project_regenerate_key", req.params.name);
  res.json({ success: true, project: proj });
});

app.delete("/admin/projects/:name", requireRole("root", "admin"), (req, res) => {
  const idx = projects.findIndex((p) => p.name === req.params.name);
  if (idx === -1) return res.json({ success: false, error: "project not found" });
  projects.splice(idx, 1);
  saveProjects(projects);
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
  res.json({
    freeTierMode: settings.freeTierMode || "global",
    deployMode: DEPLOY_MODE,
    modules: [...modules],
    allModules: ALL_MODULES,
    authMode: settings.authMode || "static",
    authEmail: settings.authEmail || "",
    authRotateHours: settings.authRotateHours || 24,
    authLastRotated: settings.authLastRotated || null,
  });
});

app.put("/admin/settings", requireRole("root"), (req, res) => {
  const { freeTierMode, deployMode, enabledModules, authMode, authEmail, authRotateHours, confirmSecret } = req.body;
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
        headers["x-api-key"] = safeKey;
        headers["anthropic-version"] = "2023-06-01";
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
      if (name === "anthropic") { headers["x-api-key"] = safeKey; headers["anthropic-version"] = "2023-06-01"; url = `${PROVIDERS[name].baseUrl}/v1/messages`; }
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
      proj = projects.find(p => p.enabled && safeEqual(p.key, projectKey));
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

  // Add routing info header
  res.setHeader("X-Smart-Route", `${target.provider}/${target.model}`);

  // --- Inject auth and forward to proxy ---
  const targetProvider = PROVIDERS[target.provider];
  if (target.provider === "anthropic") {
    req.headers["x-api-key"] = targetProvider.apiKey;
    req.headers["anthropic-version"] = req.headers["anthropic-version"] || "2023-06-01";
    delete req.headers["authorization"];
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
  const nonSystem = msgs
    .filter(m => m.role !== "system")
    .map(m => ({ role: m.role, content: m.content }));
  const out = { model: body.model, messages: nonSystem, max_tokens: body.max_tokens || 1024 };
  if (systemParts.length) out.system = systemParts.join("\n");
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.stream) out.stream = true;
  return out;
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
  const requestedModel = req.body?.model || "claude-haiku-4-5-20251001";
  const isStream = req.body?.stream === true;
  const anthropicBody = openaiToAnthropicBody(req.body);
  const fetchHeaders = { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  if (req.traceId) fetchHeaders["x-request-id"] = req.traceId;

  let anthropicResp;
  try {
    anthropicResp = await fetch(`${PROVIDERS.anthropic.baseUrl}/v1/messages`, {
      method: "POST", headers: fetchHeaders, body: JSON.stringify(anthropicBody),
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
            } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
              res.write(`data: ${JSON.stringify({ id: msgId, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: { content: ev.delta.text }, logprobs: null, finish_reason: null }] })}\n\n`);
            } else if (ev.type === "message_delta") {
              outputTokens = ev.usage?.output_tokens || 0;
              const fr = { end_turn: "stop", max_tokens: "length" }[ev.delta?.stop_reason] || ev.delta?.stop_reason || "stop";
              res.write(`data: ${JSON.stringify({ id: msgId, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: fr }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } })}\n\n`);
            } else if (ev.type === "message_stop") {
              res.write("data: [DONE]\n\n");
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    res.end();
    const tokens = { input: inputTokens, cacheHit: 0, output: outputTokens };
    recordUsage(req._proxyProjectName, "anthropic", requestedModel, tokens);
    if (req._proxyProject) {
      const cost = calcRequestCost("anthropic", requestedModel, tokens);
      if (req._proxyProject.maxBudgetUsd != null) { req._proxyProject.budgetUsedUsd = (req._proxyProject.budgetUsedUsd || 0) + cost; markProjectsDirty(); }
      if (req._proxyProject.maxCostPerMin) recordCostForRateLimit(req._proxyProjectName, cost);
    }
    return;
  }

  // Non-streaming
  const anthropicData = await anthropicResp.json();
  const openaiData = anthropicToOpenaiResponse(anthropicData, requestedModel);
  const tokens = { input: anthropicData.usage?.input_tokens || 0, cacheHit: 0, output: anthropicData.usage?.output_tokens || 0 };
  recordUsage(req._proxyProjectName, "anthropic", requestedModel, tokens);
  if (req._proxyProject) {
    const cost = calcRequestCost("anthropic", requestedModel, tokens);
    if (req._proxyProject.maxBudgetUsd != null) { req._proxyProject.budgetUsedUsd = (req._proxyProject.budgetUsedUsd || 0) + cost; markProjectsDirty(); }
    if (req._proxyProject.maxCostPerMin) recordCostForRateLimit(req._proxyProjectName, cost);
  }
  return res.json(openaiData);
}

// ============================================================
// API Proxy — /v1/:provider/*
// ============================================================

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
    try {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        tail = (tail + chunk.toString()).slice(-8192);
        res.write(chunk);
      }
    } catch (_) {}
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
      recordUsage(projectName, providerName, modelId, tokens);
      if (req._proxyProject?.maxBudgetUsd != null || req._proxyProject?.maxCostPerMin) {
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
  timeout: 120000,
  proxyTimeout: 120000,
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

      let tail = "";
      proxyRes.on("data", (chunk) => {
        tail = (tail + chunk.toString()).slice(-8192);
        res.write(chunk);
      });
      proxyRes.on("end", () => {
        res.end();
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
          recordUsage(projectName, providerName, modelId, tokens);
          // Phase 1a: Track budget spend
          if (req._proxyProject?.maxBudgetUsd != null || req._proxyProject?.maxCostPerMin) {
            const cost = calcRequestCost(providerName, modelId, tokens);
            if (req._proxyProject.maxBudgetUsd != null) {
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
      });
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
  const proj = projects.find(p => p.enabled && safeEqual(p.key, projectKey));
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
  // Count existing tokens for this project
  let count = 0;
  for (const info of ephemeralTokens.values()) { if (info.projectName === resolvedProj.name) count++; }
  if (count >= MAX_EPHEMERAL_PER_PROJECT) return res.status(429).json({ error: "Too many active tokens" });
  const ttl = (resolvedProj.tokenTtlMinutes || 60) * 60 * 1000;
  const token = "et_" + crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + ttl;
  const userId = req.body?.userId || null;
  ephemeralTokens.set(token, { projectName: resolvedProj.name, project: resolvedProj, userId, expiresAt });
  markTokensDirty();
  audit(null, "token_issued", resolvedProj.name, { userId, ttlMin: Math.round(ttl / 60000) });
  res.json({ token, expiresAt: new Date(expiresAt).toISOString(), expiresIn: Math.round(ttl / 1000) });
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
  } else if (["root", "admin"].includes(getSessionRole(req))) {
    // H-01 fix: only root/admin sessions bypass project policy
    projectName = "_chat";
  } else {
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
      proj = projects.find(p => p.enabled && safeEqual(p.key, projectKey));
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
  }

  const providerName = req.params.provider.toLowerCase();
  const provider = PROVIDERS[providerName];

  // F-10: Don't leak provider list in error response
  if (!provider) {
    return res.status(404).json({ error: "Unknown provider" });
  }
  // Select API key: project-specific first, then public
  const selectedKey = selectApiKey(providerName, projectName);
  if (!selectedKey && !provider.apiKey) {
    return res.status(403).json({ error: "Provider has no API key configured" });
  }
  const proxyApiKey = selectedKey?.apiKey || provider.apiKey;
  req._selectedKeyId = selectedKey?.keyId;

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
    req.headers["x-api-key"] = proxyApiKey;
    req.headers["anthropic-version"] = req.headers["anthropic-version"] || "2023-06-01";
    delete req.headers["authorization"];
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
