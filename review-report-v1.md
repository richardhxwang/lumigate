# Enterprise Gateway Code Review Report (v1)

Project: `ai-api-proxy`  
Scope: Security, tenancy isolation, proxy controls, admin plane hardening, performance/readiness  
Date: 2026-03-10

## Executive Summary

This review targets an enterprise API gateway for AI conversation-analysis SaaS workloads.  
Current implementation has strong baseline engineering in some areas (timing-safe compare, graceful shutdown, reverse proxy layer), but still contains several high-impact security and operability gaps.

- Critical: 2
- High: 3
- Medium: 4
- Low: 1

Top immediate risks:
- Anonymous upstream access when no project exists
- Internal chat key exposed to browser clients
- SSRF defenses rely on regex blocklist only

---

## Findings (Prioritized)

### F-01 (Critical) - Anonymous upstream proxying when no projects are configured

- Location: `server.js` in route `app.use("/v1/:provider", ...)`
- Impact: If `projects.length === 0`, the entire auth check block is skipped — **any** request with **any** header values proceeds to upstream proxying unchecked. `projectName` defaults to `"_chat"` and execution falls through to the proxy layer. This allows unlimited billing abuse and full unauthorized access to all configured providers.

```821:839:server.js
app.use("/v1/:provider", apiLimiter, (req, res, next) => {
  let projectName = "_chat";
  const projectKey =
    req.headers["x-project-key"] ||
    (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");

  if (projectKey === INTERNAL_CHAT_KEY) {
    projectName = "_chat";
  } else if (projects.length > 0) {
    const proj = projects.find(p => p.enabled && safeEqual(p.key, projectKey));
    if (!proj) {
      return res.status(401).json({
```

Recommended fix:
- Always enforce project-key validation for `/v1/*` requests unless a dedicated internal trusted path is used.
- Remove the `projects.length > 0` conditional bypass.

---

### F-02 (Critical) - Internal chat key is injected into frontend and reusable

- Location: `server.js` (`/chat` HTML injection), `public/chat.html` (`CHAT_KEY`)
- Impact: Any user who can load `/chat` can extract and replay the internal key against gateway APIs.

```421:427:server.js
const chatHtml = fs.readFileSync(path.join(__dirname, "public", "chat.html"), "utf8")
  .replace("__INTERNAL_CHAT_KEY__", INTERNAL_CHAT_KEY);
app.get("/chat", (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.type("html").send(chatHtml);
});
```

```169:171:public/chat.html
const B = location.origin;
const CHAT_KEY = '__INTERNAL_CHAT_KEY__';
let history = [];
```

Recommended fix:
- Do not expose gateway credentials to browser code.
- Move chat traffic to server-side session-backed endpoint (e.g. `/chat/api/*`) and inject no reusable key.

---

### F-03 (High) - SSRF defense is regex blocklist only

- Location: `server.js` in `POST /admin/key`
- Impact: Blocklist-style validation can be bypassed via hostname tricks, DNS rebinding, or non-canonical forms.

```711:719:server.js
if (safeUrl) {
  if (!(safeUrl.startsWith("https://") || safeUrl.startsWith("http://localhost"))) {
    return res.status(400).json({ success: false, error: "Invalid baseUrl — must start with https:// or http://localhost" });
  }
  const blocked = /^https?:\/\/(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|127\.|0\.0\.0\.0|localhost:\d+\/admin|\[::1\]|metadata\.google|169\.254\.169\.254)/i;
  if (blocked.test(safeUrl)) {
```

Recommended fix:
- Prefer provider hostname allowlist.
- Resolve DNS and validate resolved IP ranges (IPv4+IPv6), including redirect targets.

---

### F-04 (High) - Open-ended subpath relay to upstream providers

- Location: `server.js` `pathRewrite` + `/v1/:provider` proxying
- Impact: Arbitrary subpaths can be forwarded to configured upstream hosts; expands abuse and blast radius.

```763:774:server.js
pathRewrite: (pathStr, req) => {
  const providerName = req.params?.provider?.toLowerCase();
  const stripped = pathStr.replace(`/v1/${providerName}`, "");
  if (providerName === "gemini") {
    return stripped.replace(/^\/v1\//, "/v1beta/openai/");
  }
  if (providerName === "doubao") {
    return stripped.replace(/^\/v1\//, "/");
  }
  return stripped;
},
```

Recommended fix:
- Define explicit allowlisted upstream endpoints per provider.
- Deny unknown paths by default.

---

### F-05 (High) - Provider secrets are persisted in plaintext `.env`

- Location: `server.js` `POST /admin/key`
- Impact: Plaintext secrets on disk increase compromise and leakage risk in enterprise environments.

```725:745:server.js
try {
  const envPath = path.join(__dirname, ".env");
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  // ...
  fs.writeFileSync(envPath, envContent);
} catch (e) {
  console.error("Failed to persist .env:", e.message);
}
```

Recommended fix:
- Store runtime secrets in a secret manager (Vault/KMS/SSM).
- If local persistence is unavoidable: encrypt-at-rest and enforce strict FS permissions.

---

### F-06 (Medium) - IPv6 rate-limit keying warning from framework

- Location: `server.js` rate limiters
- Impact: Current key generation may allow bypass behavior for IPv6 clients.
- Runtime evidence: express-rate-limit emits `ERR_ERL_KEY_GEN_IPV6`.

```332:338:server.js
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip,
```

Recommended fix:
- Use framework-provided IPv6-safe key helper.
- Keep trusted proxy configuration strict and explicit.

---

### F-07 (Medium) - CLI/TUI auth contract differs from server admin session model

- Location: `server.js` `adminAuth`, `cli.sh`, `tui.js`
- Impact: Auth contract mismatch — server validates against `sessions` Map (session tokens issued via `/admin/login`), but CLI/TUI send the raw `GATEWAY_SECRET` directly via `X-Admin-Token` header. This works **only by accident** if the secret happens to match a session token; otherwise CLI requests silently 401. Creates operational confusion and fragile admin automation.

```370:374:server.js
function adminAuth(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.admin_token || req.headers["x-admin-token"];
  if (!token || !sessions.has(token)) return res.status(401).json({ error: "Unauthorized" });
```

```58:60:cli.sh
response=$(curl -s -w "\n%{http_code}" --max-time 15 \
  -H "X-Admin-Token: ${GATEWAY_SECRET}" \
  "${GATEWAY_URL}${path}" 2>&1) || {
```

Recommended fix:
- Unify on one admin auth pattern for both UI and CLI (session exchange or PAT-style token).
- If raw-secret auth is intended for CLI, `adminAuth` should also accept `GATEWAY_SECRET` directly (in addition to session tokens).

---

### F-08 (Medium) - Session and limiter state are process-local memory

- Location: `server.js` (`sessions` map and in-memory limiter state)
- Impact: Multi-instance deployments lose consistency across restarts/replicas.

```16:17:server.js
const sessions = new Map();
```

Recommended fix:
- Externalize session and limiter stores (e.g. Redis).

---

### F-09 (Medium) - Global JSON body limit is too high for gateway ingress

- Location: `server.js`
- Impact: `100mb` request body size can increase memory pressure and GC stalls under load.

```358:360:server.js
// 4. Body parser with size limit
app.use(express.json({ limit: "100mb" }));
```

Recommended fix:
- Route-specific body limits.
- Tight cap for admin routes, stricter defaults for proxy ingress.

---

### F-10 (Low) - Provider list exposed to unauthenticated users

- Location: `server.js` error response in `/v1/:provider` route
- Impact: When a request targets an unknown provider, the error response includes `available: Object.keys(PROVIDERS)`, revealing all configured provider names to unauthenticated callers. Low severity (no secrets leaked), but unnecessary information disclosure.

Recommended fix:
- Return a generic 404 without listing available providers.

---

## Positive Observations

- **Timing-safe comparison**: `safeEqual()` correctly uses `crypto.timingSafeEqual()` to prevent timing attacks on key validation.
- **CORS policy**: Appropriately restrictive — rejects cross-origin requests with `Origin` header, only allows same-origin or requests without `Origin`.
- **Error handling**: Global error handler prevents stack trace leakage to clients.
- **Graceful shutdown**: Proper signal handling for clean process termination.

---

## Performance and Reliability Observations

- Single-process Node runtime (`server.js`) without worker/process scaling strategy.
- No explicit circuit breaker or downstream concurrency guard.
- No explicit outbound HTTP agent tuning for keepalive pooling to providers.
- Admin usage endpoints perform in-memory aggregation loops that may degrade with cardinality.

Relevant anchors:
- `recordUsage()` and periodic `saveUsage()`: `server.js`
- Usage APIs: `GET /admin/usage`, `GET /admin/usage/summary` in `server.js`
- Nginx timeout/fallback behavior: `nginx/nginx.conf`

---

## Test Coverage and Tooling Gaps

- No dedicated security/performance test suite found in repo.
- `package.json` only provides `start` script; lacks test/perf/security automation scripts.
- `npm audit --omit=dev` currently reports zero known package vulnerabilities.

---

## Recommended Remediation Plan (Phased)

### Phase 0 (Immediate - block abuse)
- Fix F-01 and F-02 first.
- Patch rate limiter keying (F-06).

### Phase 1 (Security hardening)
- Implement strict upstream endpoint allowlists (F-04).
- Replace SSRF blocklist model with allowlist + DNS/IP validation (F-03).
- Remove plaintext secret persistence (F-05).

### Phase 2 (Enterprise readiness)
- Externalize session/limit stores (F-08).
- Introduce observability baseline: structured logs, request IDs, metrics.
- Add repeatable security + load tests in CI.

---

## Suggested Validation Matrix

- Security regression:
  - Unauthorized `/v1/*` requests always 401.
  - Browser cannot obtain reusable gateway keys.
  - SSRF probes blocked after DNS resolution checks.
- Load/stress:
  - Mixed streaming/non-streaming scenarios on `/v1/:provider`.
  - p95/p99 latency + error-rate + memory + event loop lag tracking.
- Fault injection:
  - Upstream timeout/502 injection and recovery behavior verification.

---

## Appendix: Key Functions and Routes Reviewed

- `safeEqual()`: `server.js`
- `adminAuth()`: `server.js`
- `app.post("/admin/login")`: `server.js`
- `app.post("/admin/key")`: `server.js`
- `proxyMiddleware` (`router`, `pathRewrite`, `on.proxyReq`, `on.proxyRes`): `server.js`
- `app.use("/v1/:provider", ...)`: `server.js`
- `/chat` HTML key injection path: `server.js` + `public/chat.html`
- Nginx ingress/proxy/fallback config: `nginx/nginx.conf`

