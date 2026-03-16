"use strict";

/**
 * security-middleware.js -- Express middleware that wires PII detection and
 * command-guard scanning into the proxy pipeline.  All detections are written
 * to PocketBase `security_events` collection as fire-and-forget requests.
 *
 * Usage:
 *   const { createSecurityMiddleware } = require('./middleware/security-middleware');
 *   app.use(createSecurityMiddleware({ pbUrl, enabled: true }));
 */

const { detectPII } = require("../security");
const { checkCommand } = require("../security/command-guard");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** PB admin token cache (mirrors server.js pattern but self-contained). */
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
      // Refresh before expiry (tokens typically last ~1h)
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
 * Fire-and-forget write to PB security_events collection.
 * Never throws, never blocks the request.
 */
function writeSecurityEvent(pbUrl, record) {
  getPbToken(pbUrl)
    .then((token) => {
      if (!token) return;
      fetch(`${pbUrl}/api/collections/security_events/records`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(record),
      }).catch(() => {});
    })
    .catch(() => {});
}

/** Route patterns that should be scanned. */
const SCAN_PATHS = [
  /^\/v1\/[^/]+\/chat\/completions/,
  /^\/v1\/smart\//,
];

function shouldScan(method, path) {
  if (method !== "POST") return false;
  return SCAN_PATHS.some((re) => re.test(path));
}

/**
 * Extract plain-text content from chat messages array.
 * Handles both `{ content: "string" }` and `{ content: [{ type:"text", text }] }`.
 */
function extractUserTexts(messages) {
  if (!Array.isArray(messages)) return [];
  const texts = [];
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") {
      texts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && typeof part.text === "string") {
          texts.push(part.text);
        }
      }
    }
  }
  return texts;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create security scanning middleware.
 *
 * @param {object} options
 * @param {string}  options.pbUrl          PocketBase base URL
 * @param {boolean} options.enabled        Master switch (default true)
 * @param {boolean} options.ollamaEnabled  Reserved for future local-model scanning
 * @param {string}  options.ollamaUrl      Reserved
 * @param {string}  options.ollamaModel    Reserved
 * @returns {function} Express middleware
 */
function createSecurityMiddleware(options = {}) {
  const {
    pbUrl = process.env.PB_URL || "http://localhost:8090",
    enabled = true,
  } = options;

  return function securityMiddleware(req, res, next) {
    if (!enabled) return next();
    if (!shouldScan(req.method, req.path)) return next();

    const messages = req.body && req.body.messages;
    const userTexts = extractUserTexts(messages);
    const projectId = req.get("X-Project-Id") || req._projectName || "unknown";
    const source = req.get("X-Source") || "api";

    // ------------------------------------------------------------------
    // A. Inbound PII scan (user messages)
    // ------------------------------------------------------------------
    try {
      for (const text of userTexts) {
        const result = detectPII(text);
        if (result.found) {
          const types = result.entities.map((e) => e.type);
          const maxScore = Math.max(...result.entities.map((e) => e.score));
          const severity = maxScore > 0.9 ? "critical" : maxScore > 0.7 ? "warning" : "info";

          console.warn(
            `[security-middleware] PII detected in request — project=${projectId} types=${types.join(",")} severity=${severity}`
          );

          writeSecurityEvent(pbUrl, {
            type: "pii_detected",
            severity,
            details: JSON.stringify({
              count: result.entities.length,
              types,
              direction: "inbound",
            }),
            projectId,
            timestamp: new Date().toISOString(),
            source,
          });
        }
      }
    } catch (err) {
      console.error("[security-middleware] PII scan error (non-blocking):", err.message);
    }

    // ------------------------------------------------------------------
    // B. Inbound command-guard scan (user messages)
    // ------------------------------------------------------------------
    try {
      for (const text of userTexts) {
        const cmdResult = checkCommand(text);
        if (cmdResult.blocked) {
          console.warn(
            `[security-middleware] Dangerous command in user input — project=${projectId} rule="${cmdResult.rule}"`
          );

          writeSecurityEvent(pbUrl, {
            type: "dangerous_command",
            severity: "warning",
            details: JSON.stringify({
              rule: cmdResult.rule,
              command: cmdResult.command,
              direction: "inbound",
            }),
            projectId,
            timestamp: new Date().toISOString(),
            source,
          });
        }
      }
    } catch (err) {
      console.error("[security-middleware] Command-guard scan error (non-blocking):", err.message);
    }

    // ------------------------------------------------------------------
    // C. Outbound response scan (AI responses) via res.on('finish')
    //    We intercept res.write / res.end to capture response body chunks
    //    for non-streaming responses. For SSE streams, we scan accumulated
    //    text content delta chunks.
    // ------------------------------------------------------------------
    const chunks = [];
    const origWrite = res.write;
    const origEnd = res.end;

    res.write = function (chunk, encoding, callback) {
      try {
        if (chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        }
      } catch {
        // never fail
      }
      return origWrite.apply(res, arguments);
    };

    res.end = function (chunk, encoding, callback) {
      try {
        if (chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        }
      } catch {
        // never fail
      }
      return origEnd.apply(res, arguments);
    };

    res.on("finish", () => {
      try {
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        const body = Buffer.concat(chunks).toString("utf-8");

        // Limit scan size to avoid burning CPU on huge responses
        const scanText = body.length > 50_000 ? body.slice(0, 50_000) : body;

        // Try to extract assistant content from JSON response
        let textToScan = "";
        try {
          const parsed = JSON.parse(scanText);
          // Standard OpenAI format
          if (parsed.choices && parsed.choices[0] && parsed.choices[0].message) {
            const content = parsed.choices[0].message.content;
            if (typeof content === "string") textToScan = content;
          }
        } catch {
          // SSE or non-JSON — scan for content deltas in SSE lines
          const deltaMatches = scanText.match(/"content"\s*:\s*"([^"]*)"/g);
          if (deltaMatches) {
            textToScan = deltaMatches
              .map((m) => {
                try { return JSON.parse(`{${m}}`).content; } catch { return ""; }
              })
              .join("");
          }
        }

        if (!textToScan) return;

        const cmdResult = checkCommand(textToScan);
        if (cmdResult.blocked) {
          console.warn(
            `[security-middleware] Dangerous command in AI response — project=${projectId} rule="${cmdResult.rule}"`
          );

          writeSecurityEvent(pbUrl, {
            type: "dangerous_command",
            severity: "critical",
            details: JSON.stringify({
              rule: cmdResult.rule,
              command: cmdResult.command,
              direction: "outbound",
            }),
            projectId,
            timestamp: new Date().toISOString(),
            source,
          });
        }
      } catch (err) {
        console.error("[security-middleware] Response scan error (non-blocking):", err.message);
      }
    });

    next();
  };
}

module.exports = { createSecurityMiddleware };
