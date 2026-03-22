/**
 * OpenAI Codex OAuth — PKCE flow + token management for ChatGPT Plus/Pro subscriptions.
 *
 * Based on OpenClaw/pi-ai implementation.
 * Allows LumiGate to proxy requests through chatgpt.com/backend-api using
 * the user's ChatGPT subscription instead of an API key.
 *
 * Flow: Browser OAuth login → access_token + refresh_token → Bearer auth to chatgpt.com/backend-api
 */

const crypto = require("crypto");

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

// ── PKCE ──

function base64urlEncode(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

async function generatePKCE() {
  const verifierBytes = crypto.randomBytes(32);
  const verifier = base64urlEncode(verifierBytes);
  const hash = crypto.createHash("sha256").update(verifier).digest();
  const challenge = base64urlEncode(hash);
  return { verifier, challenge };
}

// ── JWT helpers ──

function decodeJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
  } catch { return null; }
}

function getAccountId(accessToken) {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH];
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function getTokenExpiry(accessToken) {
  const payload = decodeJwt(accessToken);
  return payload?.exp ? payload.exp * 1000 : Date.now() + 3600_000;
}

// ── Token exchange ──

async function exchangeAuthorizationCode(code, verifier) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!response.ok) return null;
  const json = await response.json();
  if (!json.access_token || !json.refresh_token) return null;
  const accountId = getAccountId(json.access_token);
  if (!accountId) return null;
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + (json.expires_in || 3600) * 1000,
    accountId,
  };
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!response.ok) return null;
  const json = await response.json();
  if (!json.access_token || !json.refresh_token) return null;
  const accountId = getAccountId(json.access_token);
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + (json.expires_in || 3600) * 1000,
    accountId: accountId || null,
  };
}

// ── OAuth login flow (Express-based callback) ──

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>OK</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}
.card{text-align:center;background:#fff;padding:40px;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,0.08)}
h2{color:#10a37f;margin-bottom:8px}p{color:#666}</style></head>
<body><div class="card"><h2>Authentication Successful</h2><p>Return to LumiGate Dashboard. This window will close automatically.</p></div>
<script>setTimeout(()=>window.close(),2000)</script></body></html>`;

// Pending OAuth flow state (only one flow at a time)
let _pendingFlow = null;

async function startLogin() {
  const { verifier, challenge } = await generatePKCE();
  const state = crypto.randomBytes(16).toString("hex");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "lumigate");

  _pendingFlow = { verifier, state, createdAt: Date.now(), resolved: false, result: null, error: null };
  // Auto-expire after 3 minutes
  setTimeout(() => { if (_pendingFlow?.state === state && !_pendingFlow.resolved) _pendingFlow = null; }, 180_000);
  return { authUrl: url.toString() };
}

/**
 * Handle OAuth callback (called from Express route at /auth/callback).
 */
async function handleCallback(query) {
  if (!_pendingFlow || _pendingFlow.resolved) {
    return { ok: false, status: 400, error: "No pending OAuth flow. Click 'ChatGPT OAuth' again." };
  }
  if (query.state !== _pendingFlow.state) {
    return { ok: false, status: 400, error: "State mismatch. Click 'ChatGPT OAuth' again." };
  }
  if (!query.code) {
    return { ok: false, status: 400, error: "Missing authorization code." };
  }
  _pendingFlow.resolved = true;
  const tokens = await exchangeAuthorizationCode(query.code, _pendingFlow.verifier);
  if (!tokens) {
    _pendingFlow.error = "Token exchange failed";
    return { ok: false, status: 500, error: "Token exchange failed." };
  }
  _pendingFlow.result = tokens;
  return { ok: true, html: SUCCESS_HTML, tokens };
}

/** Check if there's a completed flow result waiting. */
function getPendingResult() {
  if (!_pendingFlow) return null;
  if (_pendingFlow.result) return { tokens: _pendingFlow.result };
  if (_pendingFlow.error) return { error: _pendingFlow.error };
  return { pending: true };
}

// ── Request helpers for chatgpt.com/backend-api ──

function buildCodexHeaders(accessToken, accountId) {
  return {
    "Authorization": `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    "OpenAI-Beta": "responses=experimental",
    "originator": "lumigate",
    "User-Agent": `lumigate (${process.platform} ${process.arch})`,
    "accept": "text/event-stream",
    "Content-Type": "application/json",
  };
}

function resolveCodexUrl(baseUrl) {
  const raw = (baseUrl || CODEX_BASE_URL).replace(/\/+$/, "");
  if (raw.endsWith("/codex/responses")) return raw;
  if (raw.endsWith("/codex")) return `${raw}/responses`;
  return `${raw}/codex/responses`;
}

function chatToCodexBody(chatBody) {
  const messages = chatBody.messages || [];
  const systemMsgs = messages.filter(m => m.role === "system");
  const nonSystemMsgs = messages.filter(m => m.role !== "system");

  const input = nonSystemMsgs.map(m => {
    if (m.role === "assistant") {
      return { role: "assistant", content: typeof m.content === "string" ? [{ type: "output_text", text: m.content }] : m.content };
    }
    return { role: m.role === "user" ? "user" : m.role, content: typeof m.content === "string" ? [{ type: "input_text", text: m.content }] : m.content };
  });

  const body = {
    model: chatBody.model,
    store: false,
    stream: true,
    input,
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };

  body.instructions = systemMsgs.length
    ? systemMsgs.map(m => typeof m.content === "string" ? m.content : "").join("\n")
    : "You are a helpful assistant.";
  if (chatBody.temperature !== undefined) body.temperature = chatBody.temperature;

  return body;
}

/** Check if a model ID requires Codex OAuth (GPT-5.x series) */
function isCodexModel(modelId) {
  const m = String(modelId || "").toLowerCase();
  return m.startsWith("gpt-5") || m.includes("-codex");
}

function createCodexToCompletionsTransformer(model) {
  let responseId = "chatcmpl-codex-" + Date.now();
  return {
    transformEvent(eventType, data) {
      if (!data) return null;
      try {
        const parsed = JSON.parse(data);
        const type = eventType || parsed.type;
        if (type === "response.output_text.delta") {
          return `data: ${JSON.stringify({
            id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta: { content: parsed.delta || "" }, finish_reason: null }],
          })}\n\n`;
        }
        if (type === "response.completed" || type === "response.done") {
          const usage = parsed.response?.usage;
          const chunk = `data: ${JSON.stringify({
            id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            ...(usage ? { usage: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) } } : {}),
          })}\n\n`;
          return chunk + "data: [DONE]\n\n";
        }
        if (type === "response.failed") {
          return `data: ${JSON.stringify({ error: { message: parsed.response?.error?.message || "Codex response failed", type: "server_error" } })}\n\n`;
        }
        if (type === "error") {
          return `data: ${JSON.stringify({ error: { message: parsed.message || "Unknown error", type: "server_error" } })}\n\n`;
        }
      } catch {}
      return null;
    },
  };
}

module.exports = {
  startLogin,
  handleCallback,
  getPendingResult,
  refreshAccessToken,
  getAccountId,
  getTokenExpiry,
  decodeJwt,
  isCodexModel,
  buildCodexHeaders,
  resolveCodexUrl,
  chatToCodexBody,
  createCodexToCompletionsTransformer,
  CODEX_BASE_URL,
  CLIENT_ID,
};
