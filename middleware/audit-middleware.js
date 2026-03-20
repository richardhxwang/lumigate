"use strict";

/**
 * audit-middleware.js -- Express middleware that logs significant events
 * (tool executions, logins, project changes, etc.) to PocketBase `audit_log`
 * collection.  All writes are fire-and-forget.
 *
 * Usage:
 *   const { createAuditMiddleware } = require('./middleware/audit-middleware');
 *   app.use(createAuditMiddleware({ pbUrl, enabled: true }));
 */

// ---------------------------------------------------------------------------
// PB admin token (self-contained, same pattern as security-middleware)
// ---------------------------------------------------------------------------

let _pbToken = null;
let _pbTokenPromise = null;

async function getPbToken(pbUrl) {
  if (_pbToken) return _pbToken;
  if (_pbTokenPromise) return _pbTokenPromise;
  const email = process.env.PB_ADMIN_EMAIL;
  const password = process.env.PB_ADMIN_PASSWORD;
  if (!email || !password) return null;
  _pbTokenPromise = (async () => {
    try {
      const r = await fetch(`${pbUrl}/api/collections/_superusers/auth-with-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity: email, password }),
      });
      if (!r.ok) return null;
      const data = await r.json();
      _pbToken = data.token;
      setTimeout(() => { _pbToken = null; _pbTokenPromise = null; }, 50 * 60_000).unref();
      return _pbToken;
    } catch {
      _pbTokenPromise = null;
      return null;
    }
  })();
  return _pbTokenPromise;
}

/**
 * Fire-and-forget write to PB audit_log collection.
 */
function writeAuditLog(pbUrl, record) {
  getPbToken(pbUrl)
    .then((token) => {
      if (!token) return;
      fetch(`${pbUrl}/api/collections/audit_log/records`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(record),
      }).catch(e => console.error(`[audit-middleware] pb_write_failed collection=audit_log event=${record.event_type || 'unknown'} error=${e.message}`));
    })
    .catch(e => console.error(`[audit-middleware] pb_write_failed reason=no_token error=${e.message}`));
}

// ---------------------------------------------------------------------------
// Route classification
// ---------------------------------------------------------------------------

/**
 * Classify a request into an auditable event type.
 * Returns null if the request is not audit-worthy.
 */
function classifyEvent(method, path) {
  // Auth / login events
  if (path === "/lc/auth/login" && method === "POST") return "login";
  if (path === "/lc/auth/register" && method === "POST") return "register";
  if (path === "/lc/auth/refresh" && method === "POST") return "token_refresh";

  // Project management
  if (/^\/projects\/?$/.test(path) && method === "POST") return "project_create";
  if (/^\/projects\/[^/]+$/.test(path) && method === "PUT") return "project_update";
  if (/^\/projects\/[^/]+$/.test(path) && method === "DELETE") return "project_delete";

  // Tool executions
  if (/^\/v1\/smart\//.test(path) && method === "POST") return "tool_execution";
  if (/^\/v1\/tools\//.test(path) && method === "POST") return "tool_execution";

  // Admin operations
  if (/^\/admin\//.test(path) && (method === "POST" || method === "PUT" || method === "DELETE")) {
    return "admin_action";
  }

  // Settings changes
  if (/^\/lc\/settings/.test(path) && (method === "POST" || method === "PUT" || method === "PATCH")) {
    return "settings_change";
  }

  // User management (admin)
  if (/^\/lc\/admin\/users/.test(path) && (method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH")) {
    return "user_management";
  }

  // Subscription changes
  if (/^\/lc\/admin\/subscriptions/.test(path) && method === "POST") return "subscription_change";

  // API key operations
  if (/^\/lc\/apikeys/.test(path) && (method === "POST" || method === "DELETE")) {
    return "apikey_change";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create audit logging middleware.
 *
 * @param {object} options
 * @param {string}  options.pbUrl    PocketBase base URL
 * @param {boolean} options.enabled  Master switch (default true)
 * @returns {function} Express middleware
 */
function createAuditMiddleware(options = {}) {
  const {
    pbUrl = process.env.PB_URL || "http://localhost:8090",
    enabled = true,
  } = options;

  return function auditMiddleware(req, res, next) {
    if (!enabled) return next();

    const eventType = classifyEvent(req.method, req.path);
    if (!eventType) return next();

    const startTime = Date.now();

    res.on("finish", () => {
      try {
        const duration = Date.now() - startTime;
        const userId =
          req._lcUserId ||
          req._tokenUserId ||
          (req.body && req.body.email) ||
          "anonymous";
        const projectId = req.get("X-Project-Id") || req._projectName || "";
        const source = req.get("X-Source") || "api";
        const success = res.statusCode >= 200 && res.statusCode < 400;

        // Build detail object — omit sensitive fields
        const detail = {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: duration,
        };

        // Add contextual info based on event type
        if (eventType === "tool_execution" && req.body) {
          detail.model = req.body.model || "";
          detail.tool = req.body.tool || req.body.function_call || "";
        }
        if (eventType === "login" || eventType === "register") {
          detail.email = req.body && req.body.email ? req.body.email : "";
        }

        writeAuditLog(pbUrl, {
          event_type: eventType,
          user: typeof userId === "string" ? userId.slice(0, 100) : String(userId),
          project: projectId,
          source,
          success,
          detail_json: JSON.stringify(detail),
          ip_address: req.ip || "",
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        console.error("[audit-middleware] Write error (non-blocking):", err.message);
      }
    });

    next();
  };
}

module.exports = { createAuditMiddleware };
