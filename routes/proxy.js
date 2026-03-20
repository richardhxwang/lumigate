/**
 * routes/proxy.js — Generic /v1/:provider proxy handler
 *
 * Handles project auth, tier access control, collector routing,
 * key selection, tool injection, PII masking, and upstream proxy.
 */
const crypto = require("crypto");
const express = require("express");
const { detectPII, getMapping } = require("../security");

module.exports = function createProxyRouter(deps) {
  const {
    // Rate limiters
    apiLimiter,
    // Auth & session
    safeEqual,
    INTERNAL_CHAT_KEY,
    getSessionRole,
    parseCookies,
    validateLcTokenPayload,
    getLcUserTier,
    // Project data
    projects,
    projectKeyIndex,
    ephemeralTokens,
    verifyHmacSignature,
    // Project policy checks
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
    // Provider data
    PROVIDERS,
    ALLOWED_UPSTREAM_PATHS,
    COLLECTOR_SUPPORTED,
    getProviderAccessMode,
    hasCollectorToken,
    getCollectorCredentials,
    setCollectorHealth,
    // Key management
    selectApiKey,
    decryptValue,
    ADMIN_SECRET,
    TIER_RPM,
    projectRateBuckets,
    // Tool injection
    lumigentRuntime,
    settings,
    // Proxy
    handleAnthropicCompat,
    anthropicAuthHeaders,
    proxyMiddleware,
    // Usage
    log,
    // PB
    getPbAdminToken,
    PB_URL,
    // Collector
    _collector,
  } = deps;

  const router = express.Router();

  router.use("/", apiLimiter, async (req, res, next) => {
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

    // Let unknown provider paths fall through instead of forcing a provider error.
    // This avoids /v1/:provider catch-all swallowing unrelated routes.
    if (!provider) return next();

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
      collector = _collector();
      if (!collector) { return res.status(503).json({ error: "Collector module not available" }); }
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
        const toolPrompt = lumigentRuntime.getSystemPrompt();
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

  return router;
};
