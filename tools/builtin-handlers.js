"use strict";

const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { validateExternalUrl } = require("../security/url-validator");
const execFileAsync = promisify(execFile);

/**
 * Builtin Tool Handlers — microservice routing for tool execution.
 * Extracted from tools/registry.js for cleaner separation of concerns.
 *
 * Each handler takes toolInput and returns:
 *   { ok, data?, file?, filename?, mimeType?, error?, duration? }
 */

const DOC_GEN_URL = process.env.DOC_GEN_URL || "http://lumigate-doc-gen:3101";
const FILE_PARSER_URL = process.env.FILE_PARSER_URL || "http://lumigate-file-parser:3100";
const SEARXNG_URL = process.env.SEARXNG_URL || "http://lumigate-searxng:8080";
const WHISPER_URL = process.env.WHISPER_URL || "http://host.docker.internal:17863";
const SANDBOX_URL = process.env.SANDBOX_URL || "http://lumigate-sandbox:3101";

// DOC_GEN_MODE controls how document generation is routed:
//   "dedicated" — always use the dedicated doc-gen container (default, backward compat)
//   "sandbox"   — always route to the sandbox container
//   "auto"      — try doc-gen first, fall back to sandbox on ECONNREFUSED
const DOC_GEN_MODE = (process.env.DOC_GEN_MODE || "auto").toLowerCase();

// Extra tool schemas not served by doc-gen /tools
const EXTRA_TOOL_SCHEMAS = [
  {
    name: "parse_file",
    description: "Parse an uploaded file (PDF/Excel/Word/PPTX/CSV) and extract text content for analysis.",
    input_schema: {
      type: "object",
      properties: {
        file_url: { type: "string", description: "URL to download the file from" },
        filename: { type: "string", description: "Original filename with extension" },
      },
      required: ["file_url", "filename"],
    },
  },
  {
    name: "transcribe_audio",
    description: "Transcribe audio to text using Whisper speech recognition.",
    input_schema: {
      type: "object",
      properties: {
        audio_url: { type: "string", description: "URL to download the audio file from" },
        content_type: { type: "string", description: "Audio MIME type (audio/wav, audio/webm, audio/ogg, audio/mp3)", default: "audio/wav" },
      },
      required: ["audio_url"],
    },
  },
];

function normalizeExternalFileUrl(raw) {
  let input = String(raw || "").trim();
  if (/^ttps?:\/\//i.test(input)) input = `h${input}`;
  if (/^www\./i.test(input)) input = `https://${input}`;
  if (input && !/^[a-z][a-z0-9+\-.]*:\/\//i.test(input)) input = `https://${input}`;
  let u;
  try { u = new URL(input); } catch { return input; }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "github.com" && parts.length >= 5) {
    const [owner, repo, mode, branch, ...rest] = parts;
    if ((mode === "raw" || mode === "blob") && owner && repo && branch && rest.length) {
      const rawPath = rest.map(encodeURIComponent).join("/");
      return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${rawPath}`;
    }
  }
  return u.toString();
}

function isPrivateOrLocalHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h === "::1" || h.endsWith(".local")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const parts = h.split(".").map((n) => Number(n));
    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  }
  return false;
}

function shouldBypassDnsValidation(rawUrl, validateError) {
  const err = String(validateError || "").toLowerCase();
  if (!err.includes("dns resolution failed")) return false;
  try {
    const u = new URL(String(rawUrl || ""));
    if (!/^https?:$/.test(u.protocol)) return false;
    if (isPrivateOrLocalHost(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

async function downloadExternalBuffer(url, timeoutMs = 30000) {
  try {
    const fileRes = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/octet-stream,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*",
        "User-Agent": "Mozilla/5.0 (LumiGate parse_file)",
      },
      redirect: "follow",
    });
    if (fileRes.ok) return Buffer.from(await fileRes.arrayBuffer());
  } catch {}

  const maxSec = Math.max(5, Math.ceil(timeoutMs / 1000));
  const { stdout } = await execFileAsync("curl", ["-L", "-sS", "--fail", "--max-time", String(maxSec), url], {
    encoding: "buffer",
    maxBuffer: 50 * 1024 * 1024,
  });
  return Buffer.from(stdout || []);
}

/**
 * Fetch from a doc-gen endpoint with optional sandbox fallback.
 * - "dedicated": only try DOC_GEN_URL
 * - "sandbox": only try SANDBOX_URL
 * - "auto": try DOC_GEN_URL first, fall back to SANDBOX_URL on connection error
 * @param {string} path - e.g. "/generate/docx"
 * @param {object} body - JSON body
 * @returns {Promise<Response>}
 */
async function docGenFetch(path, body, headers = { "Content-Type": "application/json" }) {
  const jsonBody = typeof body === "string" ? body : JSON.stringify(body);
  const opts = { method: "POST", headers, body: jsonBody, signal: AbortSignal.timeout(60000) };

  if (DOC_GEN_MODE === "sandbox") {
    return fetch(`${SANDBOX_URL}${path}`, opts);
  }

  if (DOC_GEN_MODE === "dedicated") {
    return fetch(`${DOC_GEN_URL}${path}`, opts);
  }

  // "auto" mode: try dedicated first, fall back to sandbox
  try {
    const res = await fetch(`${DOC_GEN_URL}${path}`, opts);
    return res;
  } catch (err) {
    const msg = String(err?.cause?.code || err?.code || err?.message || "").toLowerCase();
    if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("fetch failed") || msg.includes("networkerror")) {
      console.log(`[builtin-handlers] doc-gen unavailable (${msg}), falling back to sandbox`);
      return fetch(`${SANDBOX_URL}${path}`, { ...opts, signal: AbortSignal.timeout(60000) });
    }
    throw err;
  }
}

/**
 * Execute a built-in tool call by routing to the appropriate microservice.
 * Returns { ok, data?, file?, filename?, mimeType?, error?, duration? }
 */
async function executeToolCall(toolName, toolInput) {
  const startTime = Date.now();
  try {
    switch (toolName) {
      case "generate_document": {
        const res = await docGenFetch("/generate/docx", toolInput);
        if (!res.ok) throw new Error(`doc-gen returned ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const filename = (toolInput.title || "document").replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "_") + ".docx";
        return { ok: true, file: buffer, filename, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", duration: Date.now() - startTime };
      }
      case "generate_presentation": {
        const res = await docGenFetch("/generate/pptx", toolInput);
        if (!res.ok) throw new Error(`doc-gen returned ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const filename = (toolInput.title || "presentation").replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "_") + ".pptx";
        return { ok: true, file: buffer, filename, mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", duration: Date.now() - startTime };
      }
      case "generate_spreadsheet": {
        const res = await docGenFetch("/generate/xlsx", toolInput);
        if (!res.ok) throw new Error(`doc-gen returned ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const filename = (toolInput.title || "spreadsheet").replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "_") + ".xlsx";
        return { ok: true, file: buffer, filename, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", duration: Date.now() - startTime };
      }
      case "convert_xlsx_to_pptx": {
        const res = await docGenFetch("/convert/xlsx-to-pptx", toolInput);
        if (!res.ok) throw new Error(`doc-gen returned ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        return { ok: true, file: buffer, filename: "converted.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", duration: Date.now() - startTime };
      }
      case "convert_xlsx_to_docx": {
        const res = await docGenFetch("/convert/xlsx-to-docx", toolInput);
        if (!res.ok) throw new Error(`doc-gen returned ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        return { ok: true, file: buffer, filename: "converted.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", duration: Date.now() - startTime };
      }
      case "web_search": {
        const q = toolInput.q || toolInput.query || toolInput.search || "";
        if (!q) return { ok: false, error: "Missing search query", duration: Date.now() - startTime };
        const params = new URLSearchParams({ q, format: "json" });
        if (toolInput.categories) params.set("categories", toolInput.categories);
        if (toolInput.time_range) params.set("time_range", toolInput.time_range);
        if (toolInput.language) params.set("language", toolInput.language);
        const res = await fetch(`${SEARXNG_URL}/search?${params}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`searxng returned ${res.status}`);
        const data = await res.json();
        let results = (data.results || []).slice(0, 15).map(r => ({
          title: r.title, url: r.url, content: r.content,
        }));

        // Adaptive re-fetch: if fewer than 3 results have titles matching query keywords, try refined search
        const keywords = q.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const highRelevance = results.filter(r => {
          const title = (r.title || "").toLowerCase();
          return keywords.some(kw => title.includes(kw));
        });
        if (highRelevance.length < 3 && results.length >= 3) {
          try {
            const refinedParams = new URLSearchParams({ q: `"${q}"`, format: "json" });
            if (toolInput.language) refinedParams.set("language", toolInput.language);
            const res2 = await fetch(`${SEARXNG_URL}/search?${refinedParams}`, { signal: AbortSignal.timeout(8000) });
            if (res2.ok) {
              const data2 = await res2.json();
              const extra = (data2.results || []).slice(0, 15).map(r => ({
                title: r.title, url: r.url, content: r.content,
              }));
              const seen = new Set(results.map(r => r.url));
              for (const item of extra) {
                if (!seen.has(item.url) && results.length < 30) {
                  seen.add(item.url);
                  results.push(item);
                }
              }
            }
          } catch {}
        }

        return { ok: true, data: { results, query: q }, duration: Date.now() - startTime };
      }
      case "parse_file": {
        const normalizedUrl = normalizeExternalFileUrl(toolInput.file_url);
        const fileUrlCheck = await validateExternalUrl(normalizedUrl);
        if (!fileUrlCheck.ok && !shouldBypassDnsValidation(normalizedUrl, fileUrlCheck.error)) {
          return { ok: false, error: `Blocked file_url: ${fileUrlCheck.error}`, duration: Date.now() - startTime };
        }
        const fileBuffer = await downloadExternalBuffer(normalizedUrl, 30000);
        if (!fileBuffer || !fileBuffer.length) throw new Error("Failed to download file: empty body");
        const boundary = "----FormBoundary" + crypto.randomBytes(8).toString("hex");
        const parts = [];
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${toolInput.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
        const header = Buffer.from(parts[0]);
        const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([header, fileBuffer, footer]);
        const parseRes = await fetch(`${FILE_PARSER_URL}/parse`, {
          method: "POST",
          headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
          body,
          signal: AbortSignal.timeout(30000),
        });
        if (!parseRes.ok) throw new Error(`file-parser returned ${parseRes.status}`);
        const parseData = await parseRes.json();
        return { ok: true, data: { text: parseData.text, filename: toolInput.filename, pages: parseData.pages }, duration: Date.now() - startTime };
      }
      case "transcribe_audio": {
        const audioUrlCheck = await validateExternalUrl(toolInput.audio_url);
        if (!audioUrlCheck.ok) return { ok: false, error: `Blocked audio_url: ${audioUrlCheck.error}`, duration: Date.now() - startTime };
        const audioRes = await fetch(toolInput.audio_url, { signal: AbortSignal.timeout(30000) });
        if (!audioRes.ok) throw new Error(`Failed to download audio: ${audioRes.status}`);
        const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
        const contentType = toolInput.content_type || "audio/wav";
        const whisperRes = await fetch(`${WHISPER_URL}/transcribe`, {
          method: "POST",
          headers: { "Content-Type": contentType },
          body: audioBuffer,
          signal: AbortSignal.timeout(30000),
        });
        if (!whisperRes.ok) throw new Error(`whisper returned ${whisperRes.status}`);
        const whisperData = await whisperRes.json();
        return { ok: true, data: { text: whisperData.text }, duration: Date.now() - startTime };
      }
      default:
        return { ok: false, error: `Unknown tool: ${toolName}`, duration: Date.now() - startTime };
    }
  } catch (err) {
    return { ok: false, error: err.message, duration: Date.now() - startTime };
  }
}

module.exports = {
  executeToolCall,
  EXTRA_TOOL_SCHEMAS,
  DOC_GEN_URL,
  DOC_GEN_MODE,
  SANDBOX_URL,
  FILE_PARSER_URL,
  SEARXNG_URL,
  WHISPER_URL,
  normalizeExternalFileUrl,
  downloadExternalBuffer,
};
