/**
 * routes/admin.js — Admin API routes
 *
 * Extracted from server.js. Covers:
 * - Admin auth (login/logout/MFA)
 * - Project CRUD
 * - Usage & summary
 * - Settings
 * - LumiChat data ops (schema/trash/remap)
 * - LumiChat user management & subscriptions
 * - Provider key management (single + multi-key)
 * - Collector management (accounts, login, cookies)
 * - User management
 * - Metrics, audit log, backup/restore
 */
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dns = require("dns");
const { promisify } = require("util");
const dnsLookup = promisify(dns.lookup);

module.exports = function createAdminRouter(deps) {
  const {
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
    __dirname: rootDir,
    // Data access
    getProjects,
    setProjects,
    getUsers,
    setUsers,
    getSettings,
    setSettings,
    getProviderKeys,
    setProviderKeys,
    getCollectorTokens,
    setCollectorTokens,
    getUsageData,
    getExchangeRate,
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
    saveCollectorTokens: saveCollectorTokensFn,
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
    providerKeys: _providerKeysRef,
    // Key management
    selectApiKey,
    keyCooldowns,
    markKeyCooling,
    // Provider helpers
    anthropicAuthHeaders,
    patchAnthropicBodyForOAuth,
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
    loginStateRef,
    // Module system
    mod,
    modules,
    ALL_MODULES,
    DEPLOY_MODE_REF,
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
    isLcSoftDeleteEnabled,
    getAttachmentSearchMode,
    getDomainApiSchema,
    pbListOwnedRecords,
    withSoftDeleteFilters,
    restoreSoftDeletedRecord,
    listReferencingRecords,
    assertNoBlockingReferences,
    remapLcProjectReferences,
  } = deps;
  // Lazy-accessed deps (defined after mount point in server.js)
  const getLcCollectionConfig = () => deps.LC_COLLECTION_CONFIG;
  const getLcTierCache = () => deps.lcTierCache;

  const router = express.Router();

  // --- Helper: requireModule middleware (admin-only) ---
  function requireModule(name) {
    return (req, res, next) => {
      if (!mod(name)) return res.status(404).json({ error: `Module "${name}" not enabled. Set DEPLOY_MODE=enterprise or add to MODULES in .env` });
      next();
    };
  }

  // --- Helper: build daily usage counts ---
  function buildDailyCounts(days, perProject) {
    const usageData = getUsageData();
    const now = new Date();
    const dailyCounts = {};
    const projectDailyCounts = {};
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

  const USAGE_CACHE_TTL = 5000;

  // --- Token rotation ---
  let rotationTimer = null;
  function scheduleTokenRotation() {
    const settings = getSettings();
    if (rotationTimer) clearTimeout(rotationTimer);
    if (settings.authMode !== "rotating" || !settings.authEmail) return;
    const hours = settings.authRotateHours || 24;
    const lastRotated = settings.authLastRotated ? new Date(settings.authLastRotated).getTime() : 0;
    const nextRotation = lastRotated + hours * 3600000;
    const delay = Math.max(0, nextRotation - Date.now());
    rotationTimer = setTimeout(async () => {
      await rotateAdminToken();
      scheduleTokenRotation();
    }, delay);
    console.log(`Token rotation scheduled in ${Math.round(delay / 60000)}min`);
  }

  async function rotateAdminToken() {
    const settings = getSettings();
    const newToken = crypto.randomBytes(32).toString("hex");
    const email = settings.authEmail;
    if (!email) return;
    try {
      const envPath = path.join(rootDir, ".env");
      let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
      const re = /^ADMIN_SECRET=.*$/m;
      if (re.test(envContent)) envContent = envContent.replace(re, `ADMIN_SECRET=${newToken}`);
      else envContent += `\nADMIN_SECRET=${newToken}`;
      fs.writeFileSync(envPath, envContent, { mode: 0o600 });
    } catch (e) { console.error("Failed to write rotated token:", e.message); return; }
    console.log(`[TOKEN ROTATION] New admin token generated. Sending to ${email}...`);
    settings.authLastRotated = new Date().toISOString();
    settings.pendingRotatedToken = newToken;
    saveSettings(settings);
    audit("system", "token_rotated", null, { email, nextRotation: `${settings.authRotateHours}h` });
    console.log(`[TOKEN ROTATION] New token stored. Restart required to apply. Token preview: ${newToken.slice(0, 8)}...`);
  }

  scheduleTokenRotation();

  // --- Collector login state & cookies ---
  const COLLECTOR_COOKIES_PATH = path.join(rootDir, "data", "collector-cookies.json");
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
          const fixed = cookies.map(c => ({ ...c, expires: c.expires === -1 ? (Date.now()/1000 + 30*86400) : c.expires }));
          await ctx.addCookies(fixed).catch(() => {});
          log("info", "Restored collector cookies", { provider, count: fixed.length });
        }
      }
    } catch (e) { log("warn", "Cookie restore failed (Chrome may not be ready)", { error: e.message }); }
  }
  setTimeout(() => restoreCollectorCookies(), 10000);

  // COLLECTOR_LOGIN_SITES and login state come from deps (shared with LC user routes)

  // ============================================================
  // Admin auth: login/logout (before adminAuth middleware)
  // ============================================================
  router.post("/admin/login", loginLimiter, async (req, res) => {
    const settings = getSettings();
    const users = getUsers();
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
  router.post("/admin/mfa/verify", loginLimiter, (req, res) => {
    const settings = getSettings();
    const users = getUsers();
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

  router.post("/admin/logout", (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies.admin_token;
    if (token) sessions.delete(token);
    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https" || (req.headers["cf-visitor"] || "").includes("https");
    res.clearCookie("admin_token", { httpOnly: true, sameSite: "Strict", secure: isSecure, path: "/" });
    res.json({ success: true });
  });

  // Check auth status
  router.get("/admin/auth", adminLimiter, (req, res) => {
    const users = getUsers();
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
  router.use("/admin", adminLimiter, adminAuth);

  // --- MFA Management (authenticated) ---
  router.post("/admin/mfa/setup", (req, res) => {
    const settings = getSettings();
    const users = getUsers();
    const secret = generateTotpSecret();
    const label = req.userName === '_root' ? 'LumiGate Root' : req.userName;
    const uri = totpUri(secret, label);
    if (req.userName === '_root') {
      settings._pendingRootTotp = secret;
    } else {
      const user = users.find(u => u.username === req.userName);
      if (!user) return res.status(404).json({ error: "User not found" });
      user._pendingTotp = secret;
    }
    res.json({ secret, otpauthUrl: uri });
  });

  router.post("/admin/mfa/confirm", (req, res) => {
    const settings = getSettings();
    const users = getUsers();
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

  router.delete("/admin/mfa", (req, res) => {
    const settings = getSettings();
    const users = getUsers();
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

  router.get("/admin/mfa/qr", async (req, res) => {
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

  router.get("/admin/mfa/status", (req, res) => {
    const settings = getSettings();
    const users = getUsers();
    if (req.userName === '_root') {
      return res.json({ mfaEnabled: !!settings.rootMfaEnabled });
    }
    const user = users.find(u => u.username === req.userName);
    res.json({ mfaEnabled: !!(user?.mfaEnabled) });
  });

  router.get("/admin/uptime", (req, res) => {
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
  router.get("/admin/test/:provider", requireRole("root", "admin"), async (req, res) => {
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
      const finalTestBody = name === "anthropic" ? patchAnthropicBodyForOAuth(testBody, testKey) : testBody;
      const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(finalTestBody) });
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
  router.get("/admin/projects", (req, res) => {
    const projects = getProjects();
    if (req.userRole === "user") {
      return res.json(projects
        .filter(p => (req.userProjects || []).includes(p.name))
        .map(({ key, ...rest }) => rest));
    }
    res.json(projects);
  });

  router.post("/admin/projects", requireRole("root", "admin"), (req, res) => {
    const projects = getProjects();
    const { name, maxBudgetUsd, budgetPeriod, allowedModels, maxRpm, allowedIPs, anomalyAutoSuspend } = req.body;
    if (!validateProjectName(name)) {
      return res.json({ success: false, error: "Invalid project name (max 64 chars, no special chars)" });
    }
    if (projects.find((p) => p.name === name)) {
      return res.json({ success: false, error: "project already exists" });
    }
    const key = "pk_" + crypto.randomBytes(24).toString("hex");
    const project = { name, key, enabled: true, authMode: "hmac", maxRpm: 600, maxRpmPerIp: 30, maxRpmPerToken: 30, maxCostPerMin: 0.5, anomalyAutoSuspend: true, createdAt: new Date().toISOString() };
    if (maxBudgetUsd != null && maxBudgetUsd > 0) {
      project.maxBudgetUsd = Number(maxBudgetUsd);
      project.budgetUsedUsd = 0;
      project.budgetPeriod = ["monthly", "daily"].includes(budgetPeriod) ? budgetPeriod : null;
      project.budgetResetAt = initBudgetResetAt(project.budgetPeriod);
    }
    if (Array.isArray(allowedModels) && allowedModels.length > 0) {
      project.allowedModels = allowedModels.filter(m => typeof m === "string" && m.length > 0);
    }
    if (maxRpm != null && maxRpm > 0) project.maxRpm = Math.min(Number(maxRpm), 10000);
    if (req.body.maxRpmPerIp != null && req.body.maxRpmPerIp > 0) project.maxRpmPerIp = Math.min(Number(req.body.maxRpmPerIp), 1000);
    if (req.body.maxRpmPerToken != null && req.body.maxRpmPerToken > 0) project.maxRpmPerToken = Math.min(Number(req.body.maxRpmPerToken), 1000);
    if (req.body.maxCostPerMin != null && req.body.maxCostPerMin > 0) project.maxCostPerMin = Number(req.body.maxCostPerMin);
    if (Array.isArray(allowedIPs) && allowedIPs.length > 0) {
      project.allowedIPs = allowedIPs.filter(ip => typeof ip === "string" && ip.length > 0).slice(0, 50);
    }
    if (anomalyAutoSuspend) project.anomalyAutoSuspend = true;
    if (req.body.authMode && ["key", "hmac", "token"].includes(req.body.authMode)) {
      project.authMode = req.body.authMode;
    }
    if (req.body.tokenTtlMinutes > 0) project.tokenTtlMinutes = Math.min(Number(req.body.tokenTtlMinutes), 1440);
    if (req.body.smartRouting) {
      project.smartRouting = validateSmartRouting(req.body.smartRouting);
    }
    projects.push(project);
    saveProjects(projects);
    rebuildProjectKeyIndex();
    audit(req.userName, "project_create", name, { budget: project.maxBudgetUsd || null });
    res.json({ success: true, project });
  });

  router.put("/admin/projects/:name", requireRole("root", "admin"), (req, res) => {
    const projects = getProjects();
    const users = getUsers();
    const providerKeys = getProviderKeys();
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
        for (const u of users) {
          if (Array.isArray(u.projects)) {
            u.projects = u.projects.map(n => n === oldName ? newName : n);
          }
        }
        saveUsers(users);
        for (const info of ephemeralTokens.values()) {
          if (info.projectName === oldName) {
            info.projectName = newName;
            info.project = proj;
          }
        }
        let keysDirty = false;
        for (const k of Object.values(providerKeys).flat()) {
          if (k.project === oldName) { k.project = newName; keysDirty = true; }
        }
        if (keysDirty) saveKeys(providerKeys);
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
    if (req.body.allowedModels !== undefined) {
      if (req.body.allowedModels === null || (Array.isArray(req.body.allowedModels) && req.body.allowedModels.length === 0)) {
        delete proj.allowedModels;
      } else if (Array.isArray(req.body.allowedModels)) {
        proj.allowedModels = req.body.allowedModels.filter(m => typeof m === "string" && m.length > 0);
      }
    }
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
    if (req.body.allowedIPs !== undefined) {
      if (req.body.allowedIPs === null || (Array.isArray(req.body.allowedIPs) && req.body.allowedIPs.length === 0)) {
        delete proj.allowedIPs;
      } else if (Array.isArray(req.body.allowedIPs)) {
        proj.allowedIPs = req.body.allowedIPs.filter(ip => typeof ip === "string" && ip.length > 0).slice(0, 50);
      }
    }
    if (req.body.subscriptionCountsSpending !== undefined) {
      if (req.body.subscriptionCountsSpending) proj.subscriptionCountsSpending = true;
      else delete proj.subscriptionCountsSpending;
    }
    if (req.body.anomalyAutoSuspend !== undefined) {
      if (req.body.anomalyAutoSuspend) proj.anomalyAutoSuspend = true;
      else delete proj.anomalyAutoSuspend;
    }
    if (req.body.authMode !== undefined) {
      if (["key", "hmac", "token"].includes(req.body.authMode)) proj.authMode = req.body.authMode;
      else delete proj.authMode;
    }
    if (req.body.tokenTtlMinutes !== undefined) {
      if (req.body.tokenTtlMinutes > 0) proj.tokenTtlMinutes = Math.min(Number(req.body.tokenTtlMinutes), 1440);
      else delete proj.tokenTtlMinutes;
    }
    if (req.body.tokenIssuanceRpm !== undefined) {
      if (req.body.tokenIssuanceRpm > 0) proj.tokenIssuanceRpm = Math.min(Number(req.body.tokenIssuanceRpm), 10000);
      else delete proj.tokenIssuanceRpm;
    }
    if (req.body.privacyMode !== undefined) {
      if (req.body.privacyMode) proj.privacyMode = true;
      else delete proj.privacyMode;
    }
    if (req.body.enabled === true && proj.suspendReason) {
      delete proj.suspendReason;
      delete proj.suspendedAt;
      projectMinuteHistory.delete(proj.name);
    }
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

  router.post("/admin/projects/:name/regenerate", requireRole("root", "admin"), (req, res) => {
    const projects = getProjects();
    const proj = projects.find((p) => p.name === req.params.name);
    if (!proj) return res.json({ success: false, error: "project not found" });
    proj.key = "pk_" + crypto.randomBytes(24).toString("hex");
    saveProjects(projects);
    rebuildProjectKeyIndex();
    audit(req.userName, "project_regenerate_key", req.params.name);
    res.json({ success: true, project: proj });
  });

  router.delete("/admin/projects/:name", requireRole("root", "admin"), (req, res) => {
    const projects = getProjects();
    const idx = projects.findIndex((p) => p.name === req.params.name);
    if (idx === -1) return res.json({ success: false, error: "project not found" });
    projects.splice(idx, 1);
    saveProjects(projects);
    rebuildProjectKeyIndex();
    audit(req.userName, "project_delete", req.params.name);
    res.json({ success: true });
  });

  // Exchange rate
  router.get("/admin/rate", (req, res) => {
    res.json(getExchangeRate());
  });

  // --- Usage API ---
  router.get("/admin/usage", (req, res) => {
    const settings = getSettings();
    const usageData = getUsageData();
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
    usageCache.key = cacheKey; usageCache.data = result; usageCache.ts = now;
    res.json(result);
  });

  router.get("/admin/usage/summary", (req, res) => {
    const settings = getSettings();
    const usageData = getUsageData();
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
    summaryCache.key = cacheKey; summaryCache.data = data; summaryCache.ts = Date.now();
    res.json(data);
  });

  // --- Settings API (root only) ---
  router.get("/admin/settings", requireRole("root"), (req, res) => {
    const settings = getSettings();
    const domainApiRegistry = settings.domainApiRegistry && typeof settings.domainApiRegistry === "object"
      ? settings.domainApiRegistry
      : {};
    res.json({
      freeTierMode: settings.freeTierMode || "global",
      deployMode: DEPLOY_MODE_REF(),
      modules: [...modules],
      allModules: ALL_MODULES,
      authMode: settings.authMode || "static",
      authEmail: settings.authEmail || "",
      authRotateHours: settings.authRotateHours || 24,
      authLastRotated: settings.authLastRotated || null,
      stealthMode: !!settings.stealthMode,
      approvalEmail: settings.approvalEmail || "",
      approvalEnabled: settings.approvalEnabled !== false,
      smtpHost: settings.smtpHost || "",
      smtpPort: settings.smtpPort || 587,
      smtpUser: settings.smtpUser || "",
      smtpFrom: settings.smtpFrom || "",
      smtpTo: settings.smtpTo || "",
      smtpEnabled: !!settings.smtpEnabled,
      smtpHasPassword: !!(settings.smtpPass),
      searchKeywordProvider: settings.searchKeywordProvider || "minimax",
      searchKeywordModel: settings.searchKeywordModel || "MiniMax-M1",
      autoSearchEnabled: settings.autoSearchEnabled !== false,
      toolInjectionEnabled: settings.toolInjectionEnabled !== false,
      lcSoftDeleteEnabled: isLcSoftDeleteEnabled(),
      attachmentSearchMode: getAttachmentSearchMode(),
      domainApiRegistry,
      // Platform Parameters
      agentMaxIterations: settings.agentMaxIterations ?? 8,
      toolRetryMax: settings.toolRetryMax ?? 2,
      memoryRecallLimit: settings.memoryRecallLimit ?? 10,
      memoryScoreThreshold: settings.memoryScoreThreshold ?? 0.15,
      ragStrategy: settings.ragStrategy || "standard",
      searchMaxResults: settings.searchMaxResults ?? 15,
      dailyTokenLimitBasic: settings.dailyTokenLimitBasic ?? 100000,
      dailyTokenLimitPremium: settings.dailyTokenLimitPremium ?? 0,
      pdfEnginePreference: settings.pdfEnginePreference || "pdftotext",
      workflowNodeTimeout: settings.workflowNodeTimeout ?? 30,
      workflowMaxNodes: settings.workflowMaxNodes ?? 50,
      ttsEnabled: settings.ttsEnabled !== false,
      ttsDefaultVoice: settings.ttsDefaultVoice || "",
      // Sandbox settings
      lcFileSandboxUploadEnabled: settings.lcFileSandboxUploadEnabled !== false,
      lcFileSandboxUploadTrustedBypass: settings.lcFileSandboxUploadTrustedBypass !== false,
      lcFileSandboxDownloadEnabled: settings.lcFileSandboxDownloadEnabled !== false,
      lcFileSandboxRequireConsent: settings.lcFileSandboxRequireConsent !== false,
      lcFileSandboxTrustedUsers: settings.lcFileSandboxTrustedUsers || [],
      lumigentSandboxEnabled: settings.lumigentSandboxEnabled !== false,
      lumigentSandboxImage: settings.lumigentSandboxImage || "python:3.12-alpine",
      lumigentSandboxCommandAllowlist: settings.lumigentSandboxCommandAllowlist || [],
      lumigentSandboxNetworkDefaultEnabled: settings.lumigentSandboxNetworkDefaultEnabled !== false,
      lumigentSandboxNetworkForceDisabled: settings.lumigentSandboxNetworkForceDisabled === true,
      lumigentSandboxLocalFallbackEnabled: settings.lumigentSandboxLocalFallbackEnabled !== false,
    });
  });

  router.get("/admin/logs/recent", requireRole("root"), (req, res) => {
    res.json({
      ok: true,
      items: getRecentLogs({
        limit: req.query.limit,
        level: typeof req.query.level === "string" ? req.query.level : undefined,
        component: typeof req.query.component === "string" ? req.query.component : undefined,
      }),
    });
  });

  router.put("/admin/settings", requireRole("root"), (req, res) => {
    const settings = getSettings();
    const { freeTierMode, deployMode, enabledModules, authMode, authEmail, authRotateHours, confirmSecret,
            smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom, smtpTo, smtpEnabled,
            stealthMode, approvalEmail, approvalEnabled,
            searchKeywordProvider, searchKeywordModel, autoSearchEnabled, toolInjectionEnabled,
            attachmentSearchMode,
            lcSoftDeleteEnabled, domainApiRegistry,
            // Platform Parameters
            agentMaxIterations, toolRetryMax, memoryRecallLimit, memoryScoreThreshold,
            ragStrategy, searchMaxResults, dailyTokenLimitBasic, dailyTokenLimitPremium,
            pdfEnginePreference, workflowNodeTimeout, workflowMaxNodes,
            ttsEnabled, ttsDefaultVoice,
            // Sandbox settings
            lcFileSandboxUploadEnabled, lcFileSandboxUploadTrustedBypass,
            lcFileSandboxDownloadEnabled, lcFileSandboxRequireConsent,
            lcFileSandboxTrustedUsers, lumigentSandboxEnabled, lumigentSandboxImage,
            lumigentSandboxCommandAllowlist, lumigentSandboxNetworkDefaultEnabled,
            lumigentSandboxNetworkForceDisabled, lumigentSandboxLocalFallbackEnabled } = req.body;
    if (!confirmSecret || !safeEqual(confirmSecret, ADMIN_SECRET)) {
      return res.status(403).json({ error: "Admin secret required to change settings" });
    }
    const changes = {};
    if (freeTierMode && ["global", "per-project"].includes(freeTierMode)) {
      settings.freeTierMode = freeTierMode;
      changes.freeTierMode = freeTierMode;
    }
    if (deployMode && ["lite", "enterprise", "custom"].includes(deployMode)) {
      const customMods = Array.isArray(enabledModules) ? enabledModules : undefined;
      applyDeployMode(deployMode, customMods);
      settings.deployMode = deployMode;
      if (customMods) settings.customModules = customMods;
      changes.deployMode = deployMode;
      changes.modules = [...modules];
    } else if (Array.isArray(enabledModules) && DEPLOY_MODE_REF() === "custom") {
      applyDeployMode("custom", enabledModules);
      settings.customModules = enabledModules;
      changes.modules = [...modules];
    }
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
    if (changes.deployMode || changes.modules) {
      try {
        const envPath = path.join(rootDir, ".env");
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
    if (stealthMode !== undefined) {
      settings.stealthMode = !!stealthMode;
      applyStealthConf(settings.stealthMode);
      changes.stealthMode = settings.stealthMode;
    }
    if (typeof smtpHost === "string") { settings.smtpHost = smtpHost.trim(); changes.smtpHost = settings.smtpHost; }
    if (smtpPort) { settings.smtpPort = Number(smtpPort) || 587; changes.smtpPort = settings.smtpPort; }
    if (typeof smtpUser === "string") { settings.smtpUser = smtpUser.trim(); changes.smtpUser = settings.smtpUser; }
    if (typeof smtpPass === "string" && smtpPass) { settings.smtpPass = encryptValue(smtpPass, ADMIN_SECRET); changes.smtpPass = "[redacted]"; }
    if (typeof smtpFrom === "string") { settings.smtpFrom = smtpFrom.trim(); changes.smtpFrom = settings.smtpFrom; }
    if (typeof smtpTo === "string") { settings.smtpTo = smtpTo.trim(); changes.smtpTo = settings.smtpTo; }
    if (smtpEnabled !== undefined) { settings.smtpEnabled = !!smtpEnabled; changes.smtpEnabled = settings.smtpEnabled; }
    if (typeof approvalEmail === "string") { settings.approvalEmail = approvalEmail.trim(); changes.approvalEmail = settings.approvalEmail; }
    if (approvalEnabled !== undefined) { settings.approvalEnabled = !!approvalEnabled; changes.approvalEnabled = settings.approvalEnabled; }
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
          if (!getLcCollectionConfig()[cfgKey]) continue;
          collections[apiName] = cfgKey;
        }
        if (!Object.keys(collections).length) continue;
        sanitized[domainKey] = { label, authAdapter, collections };
      }
      settings.domainApiRegistry = sanitized;
      changes.domainApiRegistry = Object.keys(sanitized);
    }
    // Platform Parameters
    if (agentMaxIterations !== undefined) {
      const v = Math.max(1, Math.min(50, Number(agentMaxIterations) || 8));
      settings.agentMaxIterations = v; changes.agentMaxIterations = v;
    }
    if (toolRetryMax !== undefined) {
      const v = Math.max(0, Math.min(10, Number(toolRetryMax) || 0));
      settings.toolRetryMax = v; changes.toolRetryMax = v;
    }
    if (memoryRecallLimit !== undefined) {
      const v = Math.max(1, Math.min(100, Number(memoryRecallLimit) || 10));
      settings.memoryRecallLimit = v; changes.memoryRecallLimit = v;
    }
    if (memoryScoreThreshold !== undefined) {
      const v = Math.max(0, Math.min(1, parseFloat(memoryScoreThreshold) || 0.15));
      settings.memoryScoreThreshold = v; changes.memoryScoreThreshold = v;
    }
    if (typeof ragStrategy === "string" && ["simple", "standard", "thorough", "agentic"].includes(ragStrategy)) {
      settings.ragStrategy = ragStrategy; changes.ragStrategy = ragStrategy;
    }
    if (searchMaxResults !== undefined) {
      const v = Math.max(1, Math.min(100, Number(searchMaxResults) || 15));
      settings.searchMaxResults = v; changes.searchMaxResults = v;
    }
    if (dailyTokenLimitBasic !== undefined) {
      const v = Math.max(0, Number(dailyTokenLimitBasic) || 0);
      settings.dailyTokenLimitBasic = v; changes.dailyTokenLimitBasic = v;
    }
    if (dailyTokenLimitPremium !== undefined) {
      const v = Math.max(0, Number(dailyTokenLimitPremium) || 0);
      settings.dailyTokenLimitPremium = v; changes.dailyTokenLimitPremium = v;
    }
    if (typeof pdfEnginePreference === "string" && ["pdftotext", "pdfjs", "pdf-parse", "docling"].includes(pdfEnginePreference)) {
      settings.pdfEnginePreference = pdfEnginePreference; changes.pdfEnginePreference = pdfEnginePreference;
    }
    if (workflowNodeTimeout !== undefined) {
      const v = Math.max(5, Math.min(300, Number(workflowNodeTimeout) || 30));
      settings.workflowNodeTimeout = v; changes.workflowNodeTimeout = v;
    }
    if (workflowMaxNodes !== undefined) {
      const v = Math.max(1, Math.min(500, Number(workflowMaxNodes) || 50));
      settings.workflowMaxNodes = v; changes.workflowMaxNodes = v;
    }
    if (ttsEnabled !== undefined) { settings.ttsEnabled = !!ttsEnabled; changes.ttsEnabled = settings.ttsEnabled; }
    if (typeof ttsDefaultVoice === "string") { settings.ttsDefaultVoice = ttsDefaultVoice.trim(); changes.ttsDefaultVoice = settings.ttsDefaultVoice; }
    // Sandbox settings
    if (lcFileSandboxUploadEnabled !== undefined) { settings.lcFileSandboxUploadEnabled = !!lcFileSandboxUploadEnabled; changes.lcFileSandboxUploadEnabled = settings.lcFileSandboxUploadEnabled; }
    if (lcFileSandboxUploadTrustedBypass !== undefined) { settings.lcFileSandboxUploadTrustedBypass = !!lcFileSandboxUploadTrustedBypass; changes.lcFileSandboxUploadTrustedBypass = settings.lcFileSandboxUploadTrustedBypass; }
    if (lcFileSandboxDownloadEnabled !== undefined) { settings.lcFileSandboxDownloadEnabled = !!lcFileSandboxDownloadEnabled; changes.lcFileSandboxDownloadEnabled = settings.lcFileSandboxDownloadEnabled; }
    if (lcFileSandboxRequireConsent !== undefined) { settings.lcFileSandboxRequireConsent = !!lcFileSandboxRequireConsent; changes.lcFileSandboxRequireConsent = settings.lcFileSandboxRequireConsent; }
    if (typeof lcFileSandboxTrustedUsers === "string") {
      settings.lcFileSandboxTrustedUsers = lcFileSandboxTrustedUsers.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
      changes.lcFileSandboxTrustedUsers = settings.lcFileSandboxTrustedUsers;
    }
    if (lumigentSandboxEnabled !== undefined) { settings.lumigentSandboxEnabled = !!lumigentSandboxEnabled; changes.lumigentSandboxEnabled = settings.lumigentSandboxEnabled; }
    if (typeof lumigentSandboxImage === "string" && lumigentSandboxImage.trim()) { settings.lumigentSandboxImage = lumigentSandboxImage.trim(); changes.lumigentSandboxImage = settings.lumigentSandboxImage; }
    if (typeof lumigentSandboxCommandAllowlist === "string") {
      settings.lumigentSandboxCommandAllowlist = lumigentSandboxCommandAllowlist.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
      changes.lumigentSandboxCommandAllowlist = settings.lumigentSandboxCommandAllowlist;
    }
    if (lumigentSandboxNetworkDefaultEnabled !== undefined) { settings.lumigentSandboxNetworkDefaultEnabled = !!lumigentSandboxNetworkDefaultEnabled; changes.lumigentSandboxNetworkDefaultEnabled = settings.lumigentSandboxNetworkDefaultEnabled; }
    if (lumigentSandboxNetworkForceDisabled !== undefined) { settings.lumigentSandboxNetworkForceDisabled = !!lumigentSandboxNetworkForceDisabled; changes.lumigentSandboxNetworkForceDisabled = settings.lumigentSandboxNetworkForceDisabled; }
    if (lumigentSandboxLocalFallbackEnabled !== undefined) { settings.lumigentSandboxLocalFallbackEnabled = !!lumigentSandboxLocalFallbackEnabled; changes.lumigentSandboxLocalFallbackEnabled = settings.lumigentSandboxLocalFallbackEnabled; }
    saveSettings(settings);
    audit(req.userName, "settings_update", null, changes);
    logParamChange("admin", req.userName, changes, {
      component: "settings",
      route: "/admin/settings",
      ip: req.ip,
    });
    res.json({
      success: true,
      settings: {
        freeTierMode: settings.freeTierMode || "global",
        deployMode: DEPLOY_MODE_REF(),
        modules: [...modules],
        authMode: settings.authMode || "static",
        authEmail: settings.authEmail || "",
        authRotateHours: settings.authRotateHours || 24,
      }
    });
  });

  // --- Admin LC Data Ops (root only) ---
  router.get("/admin/lc/schema", requireRole("root"), (req, res) => {
    res.json(getDomainApiSchema("lc"));
  });

  router.get("/admin/lc/trash", requireRole("root"), async (req, res) => {
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

  router.post("/admin/lc/trash/restore", requireRole("root"), async (req, res) => {
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

  router.get("/admin/lc/projects/:id/references", requireRole("root"), async (req, res) => {
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

  router.post("/admin/lc/projects/:id/remap", requireRole("root"), async (req, res) => {
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

  // --- Admin API: LumiChat User Management ---
  router.get("/admin/lc-users", requireRole("root", "admin"), async (req, res) => {
    const pbToken = await getPbAdminToken();
    if (!pbToken) return res.status(500).json({ error: "PB admin auth not configured" });
    try {
      const page = req.query.page || 1;
      const perPage = req.query.perPage || 50;
      const usersRes = await fetch(`${PB_URL}/api/collections/users/records?perPage=${perPage}&page=${page}&sort=-created`, {
        headers: { Authorization: `Bearer ${pbToken}` },
      });
      const usersData = await usersRes.json();

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

  router.patch("/admin/lc-users/:id/tier", requireRole("root"), async (req, res) => {
    const { tier, clear_upgrade } = req.body;
    if (!isValidPbId(req.params.id)) return res.status(400).json({ error: "Invalid user id" });
    if (!['basic', 'premium', 'selfservice'].includes(tier)) {
      return res.status(400).json({ error: "tier must be basic, premium, or selfservice" });
    }
    const pbToken = await getPbAdminToken();
    if (!pbToken) return res.status(500).json({ error: "PB admin auth not configured" });

    const userId = req.params.id;
    try {
      const findRes = await lcPbFetch(`/api/collections/lc_user_settings/records?filter=user='${userId}'&perPage=1`, {
        headers: { Authorization: `Bearer ${pbToken}` },
      });
      const findData = await findRes.json();

      if (findData.items?.length) {
        const updateBody = { tier, tier_updated: new Date().toISOString() };
        if (clear_upgrade) { updateBody.upgrade_request = ''; updateBody.upgrade_requested_at = ''; }
        await lcPbFetch(`/api/collections/lc_user_settings/records/${findData.items[0].id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${pbToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(updateBody),
        });
      } else {
        await lcPbFetch(`/api/collections/lc_user_settings/records`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${pbToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user: userId, tier, tier_updated: new Date().toISOString() }),
        });
      }

      getLcTierCache().delete(userId);
      audit(req.userName, "lc_user_tier_change", userId, { tier });
      res.json({ success: true, tier });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.patch("/admin/lc-users/:id/decline-upgrade", requireRole("root"), async (req, res) => {
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
      getLcTierCache().delete(userId);
      audit(req.userName, "lc_upgrade_declined", userId, {});
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/admin/lc-subscriptions", requireRole("root", "admin"), async (req, res) => {
    const pbToken = await getPbAdminToken();
    if (!pbToken) return res.status(500).json({ error: "PB admin auth not configured" });
    try {
      const r = await lcPbFetch(`/api/collections/lc_subscriptions/records?perPage=100&sort=-created&expand=user`, {
        headers: { Authorization: `Bearer ${pbToken}` },
      });
      res.json(await r.json());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post("/admin/lc-subscriptions", requireRole("root"), async (req, res) => {
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
      getLcTierCache().delete(userId);
      audit(req.userName, "lc_subscription_create", userId, { expiresAt });
      res.json({ success: true, id: data.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Update API key at runtime + persist to .env
  router.post("/admin/key", requireRole("root"), async (req, res) => {
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

    if (!/^[a-zA-Z0-9_\-\.+\/=:]+$/.test(safeKey)) {
      return res.status(400).json({ success: false, error: "Invalid API key format — contains disallowed characters" });
    }
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
      if (parsed.hostname !== "localhost" && !PROVIDER_HOST_ALLOWLIST.has(parsed.hostname)) {
        return res.status(400).json({
          success: false,
          error: `Invalid baseUrl — hostname '${parsed.hostname}' is not in the provider allowlist. Allowed: ${[...PROVIDER_HOST_ALLOWLIST].join(", ")}`,
        });
      }
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
      const envPath = path.join(rootDir, ".env");
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
      fs.writeFileSync(envPath, envContent, { mode: 0o600 });
    } catch (e) {
      console.error("Failed to persist .env:", e.message);
    }
    audit(req.userName, "provider_key_update", name, { baseUrl: !!safeUrl });
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
        const finalTestBody = name === "anthropic" ? patchAnthropicBodyForOAuth(testBody, safeKey) : testBody;
        const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(finalTestBody), signal: AbortSignal.timeout(15000) });
        const data = await resp.json();
        if (resp.ok) {
          const reply = name === "anthropic" ? ((data.content || []).filter(c => c.type === "text").map(c => c.text).join("") || "OK") : (data.choices?.[0]?.message?.content || "OK");
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

  // --- Key cooldown management ---
  router.get("/admin/keys/cooldowns", requireRole("root"), (req, res) => {
    const now = Date.now();
    const list = [];
    for (const [keyId, c] of keyCooldowns) {
      if (now <= c.until) {
        list.push({ keyId, reason: c.reason, count: c.count, remainingSec: Math.ceil((c.until - now) / 1000) });
      }
    }
    res.json(list);
  });

  router.delete("/admin/keys/cooldowns/:keyId", requireRole("root"), (req, res) => {
    const { keyId } = req.params;
    if (!keyCooldowns.has(keyId)) return res.status(404).json({ error: "Key not in cooldown" });
    keyCooldowns.delete(keyId);
    audit(req.userName, "key_cooldown_cleared", keyId);
    res.json({ success: true });
  });

  // --- Multi-key API (root only) ---
  router.get("/admin/keys/:provider", requireModule("multikey"), requireRole("root"), (req, res) => {
    const providerKeys = getProviderKeys();
    const name = req.params.provider.toLowerCase();
    if (!PROVIDERS[name]) return res.status(404).json({ error: "Unknown provider" });
    const keys = (providerKeys[name] || []).map(k => ({
      id: k.id, label: k.label, project: k.project, enabled: k.enabled,
      keyPreview: (() => { try { const d = decryptValue(k.key, ADMIN_SECRET); return d.slice(0, 6) + '...' + d.slice(-4); } catch { return '***'; } })(),
    }));
    res.json(keys);
  });

  router.post("/admin/keys/:provider", requireModule("multikey"), requireRole("root"), async (req, res) => {
    const providerKeys = getProviderKeys();
    const projects = getProjects();
    const name = req.params.provider.toLowerCase();
    if (!PROVIDERS[name]) return res.status(404).json({ error: "Unknown provider" });
    const { label, apiKey, project } = req.body;
    if (!apiKey || typeof apiKey !== "string") return res.status(400).json({ error: "apiKey required" });
    if (!label || typeof label !== "string") return res.status(400).json({ error: "label required" });
    const safeKey = sanitizeEnvValue(apiKey);
    if (!/^[a-zA-Z0-9_\-\.+\/=:]+$/.test(safeKey)) return res.status(400).json({ error: "Invalid API key format" });
    if (project && !projects.find(p => p.name === project)) return res.status(400).json({ error: "Project not found" });
    if (!providerKeys[name]) providerKeys[name] = [];
    if (providerKeys[name].length >= 100) return res.status(400).json({ error: "Maximum 100 keys per provider" });
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
    try { PROVIDERS[name].apiKey = decryptValue(providerKeys[name].find(k => k.enabled)?.key, ADMIN_SECRET); } catch {}
    saveKeys(providerKeys);
    audit(req.userName, "key_add", name, { label: entry.label, project: entry.project });
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
        const finalTestBody = name === "anthropic" ? patchAnthropicBodyForOAuth(testBody, safeKey) : testBody;
        const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(finalTestBody), signal: AbortSignal.timeout(15000) });
        const data = await resp.json();
        if (resp.ok) {
          const reply = name === "anthropic" ? ((data.content || []).filter(c => c.type === "text").map(c => c.text).join("") || "OK") : (data.choices?.[0]?.message?.content || "OK");
          test = { passed: true, model: cheapest.id, reply: reply.trim() };
        } else {
          test = { passed: false, model: cheapest.id, error: data.error?.message || "API error" };
        }
      } catch (e) { test = { passed: false, error: e.message }; }
    }
    res.json({ success: true, id: entry.id, test });
  });

  router.put("/admin/keys/:provider/reorder", requireModule("multikey"), requireRole("root"), (req, res) => {
    const providerKeys = getProviderKeys();
    const name = req.params.provider.toLowerCase();
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: "order array required" });
    const keys = providerKeys[name];
    if (!keys) return res.status(404).json({ error: "Unknown provider" });
    const reordered = [];
    for (const id of order) {
      const k = keys.find(x => x.id === id);
      if (k) reordered.push(k);
    }
    for (const k of keys) { if (!reordered.includes(k)) reordered.push(k); }
    providerKeys[name] = reordered;
    saveKeys(providerKeys);
    res.json({ success: true });
  });

  router.put("/admin/keys/:provider/:keyId", requireModule("multikey"), requireRole("root"), (req, res) => {
    const providerKeys = getProviderKeys();
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

  router.delete("/admin/keys/:provider/:keyId", requireModule("multikey"), requireRole("root"), (req, res) => {
    const providerKeys = getProviderKeys();
    const name = req.params.provider.toLowerCase();
    if (!providerKeys[name]) return res.status(404).json({ error: "Unknown provider" });
    audit(req.userName, "key_delete", `${name}/${req.params.keyId}`);
    providerKeys[name] = providerKeys[name].filter(k => k.id !== req.params.keyId);
    try { PROVIDERS[name].apiKey = decryptValue(providerKeys[name].find(k => k.enabled)?.key, ADMIN_SECRET); } catch { PROVIDERS[name].apiKey = undefined; }
    saveKeys(providerKeys);
    res.json({ success: true });
  });

  // --- Collector management ---
  router.get("/admin/collector/status", requireRole("root", "admin"), (req, res) => {
    const collectorTokens = getCollectorTokens();
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
    try { credentialFields = require("../collector").credentialFields; } catch {}
    res.json({ providers: status, credentialFields });
  });

  router.post("/admin/collector/accounts/:provider", requireRole("root", "admin"), (req, res) => {
    const collectorTokens = getCollectorTokens();
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
    saveCollectorTokensFn(collectorTokens);
    audit(req.userName, "collector_account_add", name, { label: entry.label });
    log("info", "Collector account added", { provider: name, label: entry.label });
    res.json({ success: true, id: entry.id });
  });

  router.put("/admin/collector/accounts/:provider/:accountId", requireRole("root", "admin"), (req, res) => {
    const collectorTokens = getCollectorTokens();
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
    saveCollectorTokensFn(collectorTokens);
    audit(req.userName, "collector_account_update", `${name}/${req.params.accountId}`);
    res.json({ success: true });
  });

  router.delete("/admin/collector/accounts/:provider/:accountId", requireRole("root", "admin"), (req, res) => {
    const collectorTokens = getCollectorTokens();
    const name = req.params.provider.toLowerCase();
    if (!Array.isArray(collectorTokens[name])) return res.status(404).json({ error: "No accounts" });
    collectorTokens[name] = collectorTokens[name].filter(a => a.id !== req.params.accountId);
    if (collectorTokens[name].length === 0) delete collectorTokens[name];
    saveCollectorTokensFn(collectorTokens);
    audit(req.userName, "collector_account_delete", `${name}/${req.params.accountId}`);
    res.json({ success: true });
  });

  // Login: open Chrome login window
  router.post("/admin/collector/login/:provider", requireRole("root", "admin"), async (req, res) => {
    const collectorTokens = getCollectorTokens();
    const name = req.params.provider.toLowerCase();
    if (!COLLECTOR_LOGIN_SITES[name]) return res.status(400).json({ error: "Unsupported provider" });
    if (loginStateRef.current.active) return res.status(409).json({ error: `Login in progress: ${loginStateRef.current.provider}` });

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
      } catch {
        return res.status(500).json({ error: "Collector Chrome not running" });
      }

      const browser = await chromium.connectOverCDP(wsUrl);
      const ctx = browser.contexts()[0];

      const existing = await ctx.cookies([site.url]);
      if (existing.find(c => c.name === site.cookie && c.value.length > 5)) {
        if (!Array.isArray(collectorTokens[name])) collectorTokens[name] = [];
        if (!collectorTokens[name].some(a => a.enabled)) {
          collectorTokens[name].push({
            id: crypto.randomBytes(8).toString('hex'),
            label: req.body?.label || 'Default',
            credentials: encryptValue(JSON.stringify({ cdpPort: Number(cdpPort), cdpHost }), ADMIN_SECRET),
            enabled: true,
          });
          saveCollectorTokensFn(collectorTokens);
        }
        return res.json({ success: true, status: 'already_logged_in', message: `${site.name} already logged in` });
      }

      const page = await ctx.newPage();
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

      loginStateRef.current = { active: true, provider: name, status: 'waiting', page, ctx, label: req.body?.label || 'Default', cdpPort, cdpHost };

      (async () => {
        const site = COLLECTOR_LOGIN_SITES[name];
        for (let i = 0; i < 300; i++) {
          if (!loginStateRef.current.active) return;
          const cookies = await ctx.cookies([site.url]).catch(() => []);
          if (cookies.find(c => c.name === site.cookie && c.value.length > 5)) {
            const allCookies = await ctx.cookies([site.url]).catch(() => []);
            saveCollectorCookies(name, allCookies);
            await page.close().catch(() => {});
            const collectorTokens = getCollectorTokens();
            if (!Array.isArray(collectorTokens[name])) collectorTokens[name] = [];
            const cred = encryptValue(JSON.stringify({ cdpPort: Number(loginStateRef.current.cdpPort), cdpHost: loginStateRef.current.cdpHost }), ADMIN_SECRET);
            const existingAcct = collectorTokens[name].find(a => a.enabled);
            if (existingAcct) { existingAcct.credentials = cred; existingAcct.label = loginStateRef.current.label; }
            else { collectorTokens[name].push({ id: crypto.randomBytes(8).toString('hex'), label: loginStateRef.current.label, credentials: cred, enabled: true }); }
            saveCollectorTokensFn(collectorTokens);
            setCollectorHealth(name, true);
            audit(null, "collector_login", name, { label: loginStateRef.current.label });
            loginStateRef.current = { active: false, provider: null, status: 'success' };
            return;
          }
          await new Promise(r => setTimeout(r, 1000));
        }
        await page.close().catch(() => {});
        loginStateRef.current = { active: false, provider: null, status: 'timeout' };
      })();

      res.json({ success: true, status: 'waiting', provider: name });
    } catch (e) {
      loginStateRef.current = { active: false, provider: null, status: 'error' };
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/admin/collector/login/status", requireRole("root", "admin"), (req, res) => {
    res.json({
      active: loginStateRef.current.active,
      provider: loginStateRef.current.provider,
      status: loginStateRef.current.status,
    });
  });

  router.delete("/admin/collector/login", requireRole("root", "admin"), async (req, res) => {
    if (loginStateRef.current.active && loginStateRef.current.page) {
      await loginStateRef.current.page.close().catch(() => {});
    }
    loginStateRef.current = { active: false, provider: null, status: 'idle' };
    res.json({ success: true });
  });

  router.post("/admin/collector/restore", requireRole("root"), async (req, res) => {
    try {
      const result = await restoreCollectorTokensFromPB();
      audit(req.userName, "collector_restore_from_pb", null, result);
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Legacy: save single token
  router.put("/admin/collector/token/:provider", requireRole("root", "admin"), (req, res) => {
    const collectorTokens = getCollectorTokens();
    const name = req.params.provider.toLowerCase();
    if (!PROVIDERS[name]) return res.status(404).json({ error: "Unknown provider" });
    if (!COLLECTOR_SUPPORTED.includes(name)) return res.status(400).json({ error: `Collector not supported for ${name}` });
    const { credentials } = req.body;
    if (!credentials || typeof credentials !== "object") return res.status(400).json({ error: "credentials object required" });
    if (!Array.isArray(collectorTokens[name])) collectorTokens[name] = [];
    const entry = {
      id: crypto.randomBytes(8).toString('hex'),
      label: req.body.label || 'Default',
      credentials: encryptValue(JSON.stringify(credentials), ADMIN_SECRET),
      enabled: true,
    };
    if (collectorTokens[name].length <= 1) collectorTokens[name] = [entry];
    else collectorTokens[name].push(entry);
    saveCollectorTokensFn(collectorTokens);
    audit(req.userName, "collector_token_update", name);
    res.json({ success: true, id: entry.id });
  });

  router.delete("/admin/collector/token/:provider", requireRole("root", "admin"), (req, res) => {
    const collectorTokens = getCollectorTokens();
    const name = req.params.provider.toLowerCase();
    if (!collectorTokens[name]) return res.status(404).json({ error: "No collector token for this provider" });
    delete collectorTokens[name];
    saveCollectorTokensFn(collectorTokens);
    audit(req.userName, "collector_token_delete", name);
    res.json({ success: true });
  });

  // Switch provider access mode
  router.put("/admin/providers/:name/access-mode", requireRole("root", "admin"), (req, res) => {
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
  router.get("/admin/users", requireModule("users"), requireRole("root", "admin"), (req, res) => {
    const users = getUsers();
    res.json(users.map(u => ({ username: u.username, role: u.role, enabled: u.enabled, projects: u.projects || [], createdAt: u.createdAt })));
  });

  router.post("/admin/users", requireModule("users"), requireRole("root", "admin"), async (req, res) => {
    const users = getUsers();
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

  router.put("/admin/users/:username", requireModule("users"), requireRole("root", "admin"), async (req, res) => {
    const users = getUsers();
    const user = users.find(u => u.username === req.params.username);
    if (!user) return res.json({ success: false, error: "User not found" });
    if (req.body.enabled === false && user.username === req.userName) {
      return res.status(400).json({ error: "Cannot disable your own account" });
    }
    if (req.userRole === "admin" && user.role === "admin" && user.username !== req.userName) {
      return res.status(403).json({ error: "Admins cannot modify other admin accounts" });
    }
    if (req.body.password && req.body.password.length >= 8) {
      const { hash, salt } = await hashPassword(req.body.password);
      user.passwordHash = hash;
      user.salt = salt;
    }
    if (req.body.role && ["admin", "user"].includes(req.body.role)) {
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

  router.delete("/admin/users/:username", requireModule("users"), requireRole("root", "admin"), (req, res) => {
    const users = getUsers();
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
  // ============================================================
  router.get("/admin/metrics", requireModule("metrics"), requireRole("root", "admin"), (req, res) => {
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

  router.get("/admin/audit", requireModule("audit"), requireRole("root"), (req, res) => {
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

  router.post("/admin/backup", requireModule("backup"), requireRole("root"), (req, res) => {
    try {
      const result = createBackup();
      audit(req.userName, "backup_create", result.path, { files: result.files });
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/admin/backups", requireModule("backup"), requireRole("root"), (req, res) => {
    res.json(listBackups());
  });

  router.post("/admin/restore/:name", requireModule("backup"), requireRole("root"), (req, res) => {
    try {
      const result = restoreBackup(req.params.name);
      audit(req.userName, "backup_restore", req.params.name, { files: result.restored });
      // Reload in-memory state
      setProjects(loadProjects());
      rebuildProjectKeyIndex();
      setUsers(loadUsers());
      setSettings(loadSettings());
      setProviderKeys(loadKeys());
      res.json({ success: true, ...result, message: "Data restored. Usage data will take effect after restart." });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return { router, saveCollectorCookies, adminAuth };
};
