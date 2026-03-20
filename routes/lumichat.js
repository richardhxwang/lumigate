/**
 * routes/lumichat.js — LumiChat, FurNote, and Domain API routes
 *
 * Extracted from server.js. Contains:
 * - PocketBase helpers (pbFetch, lcPbFetch, fnPbFetch)
 * - Encrypted upload / RSA keypair management
 * - File parsing, extraction, sandbox isolation
 * - Domain API (generic CRUD for lc/fn collections)
 * - LumiChat auth (login, register, OAuth, approval, tier)
 * - LumiChat CRUD (sessions, messages, files, projects, trash)
 * - FurNote auth, extractions, RAG, reports
 * - Collector re-login, SearXNG search, suggestions
 * - Gemini native API proxy, BYOK key management
 */
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { Readable, PassThrough } = require("stream");

module.exports = function createLumiChatRouter(deps) {
  const router = express.Router();
  const {
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
    requireFnAuth,
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
    getLcFileSandboxPolicy,
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
    saveCollectorCookies,
    sendAdminNotify,
    _getLoginState,
    _setLoginState,
    _getGlobalRegCount,
    _setGlobalRegCount,
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
    _collector,
  } = deps;

// FurNote auth middleware — analogous to requireLcAuth but reads fn_token cookie
// Defined here because it was not wired from server.js (passed as undefined)
const _requireFnAuth = (typeof requireFnAuth === "function") ? requireFnAuth : function requireFnAuthFallback(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.fn_token;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    if (!token || token.split(".").length !== 3) return res.status(401).json({ error: "Session expired" });
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    if (!payload.id || !payload.collectionId) return res.status(401).json({ error: "Session expired" });
    if (payload.exp * 1000 < Date.now()) return res.status(401).json({ error: "Session expired" });
    req.fnUser = payload;
    req.fnToken = token;
    next();
  } catch { return res.status(401).json({ error: "Session expired" }); }
};

// Safe fallback for saveCollectorCookies (may be undefined if not wired from server.js)
const _saveCollectorCookies = (typeof saveCollectorCookies === "function") ? saveCollectorCookies : () => {};

// Helper: forward request to PocketBase with optional auth
async function pbFetch(path, options = {}) {
  const url = `${PB_URL}${path}`;
  return fetch(url, options);
}

const PB_LC_PROJECT = (process.env.PB_LC_PROJECT || "lumichat").trim() || "lumichat";
const PB_FN_PROJECT = (process.env.PB_FN_PROJECT || "furnote").trim() || "furnote";
const FILE_PARSER_URL = process.env.FILE_PARSER_URL || "http://lumigate-file-parser:3100";
const GOTENBERG_URL = process.env.GOTENBERG_URL || "http://lumigate-gotenberg:3000";
const LC_ENCRYPTED_UPLOAD_LIMIT_BYTES = Number(process.env.LC_ENCRYPTED_UPLOAD_LIMIT_BYTES || 64 * 1024 * 1024);
const LC_ISOLATION_DIR = process.env.LC_ISOLATION_DIR || path.join(DATA_DIR, "lc_isolation");
const LC_CONSENT_TOKEN_TTL_SEC = Math.max(15, Number(process.env.LC_CONSENT_TOKEN_TTL_SEC || 90));
const lcFileConsentTokens = new Map(); // token -> { fileId, userId, expiresAt, used }
const LC_URL_FETCH_MEMORY_TTL_MS = Math.max(60_000, Number(process.env.LC_URL_FETCH_MEMORY_TTL_MS || 6 * 60 * 60 * 1000));
const LC_URL_FETCH_MEMORY_MAX_ITEMS = Math.max(1, Number(process.env.LC_URL_FETCH_MEMORY_MAX_ITEMS || 12));
const LC_URL_FETCH_MEMORY_MAX_CHARS = Math.max(2000, Number(process.env.LC_URL_FETCH_MEMORY_MAX_CHARS || 120_000));
const lcUrlFetchMemory = new Map(); // key -> { items: [{ url, filename, text }], updatedAt }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of lcFileConsentTokens) {
    if (!v || v.expiresAt <= now || v.used) lcFileConsentTokens.delete(k);
  }
}, 30_000);
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of lcUrlFetchMemory) {
    if (!v || !v.updatedAt || now - v.updatedAt > LC_URL_FETCH_MEMORY_TTL_MS) lcUrlFetchMemory.delete(k);
  }
}, 60_000);

const LC_RSA_KEYPAIR_FILE = process.env.LC_ENCRYPTED_RSA_KEYPAIR_FILE
  || path.join(__dirname, "data", "lc_encrypted_upload_keypair.json");
function loadOrCreateLcRsaKeypair() {
  const readFromDisk = () => {
    try {
      if (!fs.existsSync(LC_RSA_KEYPAIR_FILE)) return null;
      const raw = fs.readFileSync(LC_RSA_KEYPAIR_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.privateKeyPem && parsed?.publicKeyPem) {
        return { privateKey: parsed.privateKeyPem, publicKey: parsed.publicKeyPem };
      }
      return null;
    } catch {
      return null;
    }
  };
  const persistToDisk = (pair) => {
    const dir = path.dirname(LC_RSA_KEYPAIR_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const payload = {
      algorithm: "RSA-OAEP-256",
      createdAt: new Date().toISOString(),
      publicKeyPem: pair.publicKey,
      privateKeyPem: pair.privateKey,
    };
    fs.writeFileSync(LC_RSA_KEYPAIR_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
  };
  const existing = readFromDisk();
  if (existing) return existing;
  const generated = crypto.generateKeyPairSync("rsa", {
    modulusLength: Number(process.env.LC_ENCRYPTED_RSA_BITS || 2048),
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  persistToDisk(generated);
  return generated;
}
const LC_RSA_KEYPAIR = loadOrCreateLcRsaKeypair();
const LC_RSA_PUBLIC_SPKI_DER = crypto.createPublicKey(LC_RSA_KEYPAIR.publicKey).export({ type: "spki", format: "der" });
const LC_RSA_PUBLIC_SPKI_B64 = LC_RSA_PUBLIC_SPKI_DER.toString("base64");
const LC_RSA_KEY_ID = crypto.createHash("sha256").update(LC_RSA_PUBLIC_SPKI_DER).digest("hex").slice(0, 16);

function lcB64urlToBuffer(input) {
  const normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + "=".repeat(padLen), "base64");
}

function lcParseEncryptedEnvelope(rawText) {
  if (typeof rawText !== "string" || !rawText.startsWith("LCENC1:")) {
    throw Object.assign(new Error("Invalid encrypted payload prefix"), { status: 400 });
  }
  let envelope;
  try {
    const jsonText = lcB64urlToBuffer(rawText.slice(7)).toString("utf8");
    envelope = JSON.parse(jsonText);
  } catch (err) {
    throw Object.assign(new Error("Encrypted payload decode failed"), { status: 400 });
  }
  if (!envelope || ![1, 2].includes(Number(envelope.v)) || !envelope.ek || !envelope.iv || !envelope.tag || !envelope.ct) {
    throw Object.assign(new Error("Encrypted payload format invalid"), { status: 400 });
  }
  return envelope;
}

function lcBufferToB64url(input) {
  return Buffer.from(input || Buffer.alloc(0)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function lcDecodePackedV2Payload(buf) {
  const plain = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || "");
  if (plain.length < 9) throw Object.assign(new Error("Encrypted packed payload too short"), { status: 400 });
  const magic = plain.subarray(0, 5).toString("utf8");
  if (magic !== "LCPK2") throw Object.assign(new Error("Encrypted packed payload magic invalid"), { status: 400 });
  const manifestLen = plain.readUInt32BE(5);
  const manifestStart = 9;
  const manifestEnd = manifestStart + manifestLen;
  if (manifestLen <= 0 || manifestEnd > plain.length) {
    throw Object.assign(new Error("Encrypted packed manifest length invalid"), { status: 400 });
  }
  let manifest;
  try {
    manifest = JSON.parse(plain.subarray(manifestStart, manifestEnd).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Encrypted packed manifest invalid"), { status: 400 });
  }
  if (!manifest || !Array.isArray(manifest.files)) {
    throw Object.assign(new Error("Encrypted packed manifest missing files"), { status: 400 });
  }
  const dataStart = manifestEnd;
  const files = [];
  for (const file of manifest.files) {
    const name = lcUploadSafeName(file?.name || "file");
    const mime = String(file?.mime || "application/octet-stream");
    const kind = String(file?.kind || "document");
    const offset = Number(file?.offset || 0);
    const length = Number(file?.length || 0);
    if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length <= 0) {
      throw Object.assign(new Error("Encrypted packed file offset invalid"), { status: 400 });
    }
    const start = dataStart + offset;
    const end = start + length;
    if (start < dataStart || end > plain.length) {
      throw Object.assign(new Error("Encrypted packed file boundary invalid"), { status: 400 });
    }
    const content = plain.subarray(start, end);
    const expectedSha = String(file?.sha256 || "").toLowerCase();
    if (expectedSha) {
      const got = crypto.createHash("sha256").update(content).digest("hex");
      if (got !== expectedSha) {
        throw Object.assign(new Error(`Encrypted packed file checksum mismatch: ${name}`), { status: 422 });
      }
    }
    files.push({
      name,
      mime,
      kind,
      size: Number(file?.size || content.length),
      data_b64: lcBufferToB64url(content),
      sha256: expectedSha || crypto.createHash("sha256").update(content).digest("hex"),
    });
  }
  return {
    kind: String(manifest.kind || "encrypted_upload_bundle"),
    created_at: String(manifest.created_at || new Date().toISOString()),
    files,
  };
}

function lcDecryptEncryptedPayload(rawText) {
  const envelope = lcParseEncryptedEnvelope(rawText);
  let dek;
  try {
    dek = crypto.privateDecrypt(
      {
        key: LC_RSA_KEYPAIR.privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      lcB64urlToBuffer(envelope.ek)
    );
  } catch {
    throw Object.assign(new Error("Encrypted key unwrap failed"), { status: 422 });
  }
  if (dek.length !== 32) throw Object.assign(new Error("Encrypted key length invalid"), { status: 422 });

  const iv = lcB64urlToBuffer(envelope.iv);
  const tag = lcB64urlToBuffer(envelope.tag);
  const ct = lcB64urlToBuffer(envelope.ct);
  if (iv.length !== 12 || tag.length !== 16 || !ct.length) {
    throw Object.assign(new Error("Encrypted payload fields invalid"), { status: 400 });
  }
  let plain;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", dek, iv);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw Object.assign(new Error("Encrypted payload authentication failed"), { status: 422 });
  }
  if (plain.length > LC_ENCRYPTED_UPLOAD_LIMIT_BYTES * 2) {
    throw Object.assign(new Error("Encrypted payload too large"), { status: 413 });
  }
  const compression = String(envelope.zip || "none").toLowerCase();
  if (compression === "gzip") {
    try {
      plain = zlib.gunzipSync(plain, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch {
      throw Object.assign(new Error("Encrypted payload gzip decode failed"), { status: 400 });
    }
  } else if (compression !== "none" && compression !== "") {
    throw Object.assign(new Error("Encrypted payload compression unsupported"), { status: 400 });
  }
  if (plain.length > LC_ENCRYPTED_UPLOAD_LIMIT_BYTES) {
    throw Object.assign(new Error("Encrypted payload uncompressed too large"), { status: 413 });
  }
  if (String(envelope.fmt || "").toLowerCase() === "lcpack2") {
    return lcDecodePackedV2Payload(plain);
  }
  let parsed;
  try {
    parsed = JSON.parse(plain.toString("utf8"));
  } catch {
    throw Object.assign(new Error("Encrypted payload JSON invalid"), { status: 400 });
  }
  return parsed;
}

function toLcProjectPath(path) {
  const p = String(path || "");
  if (p.startsWith(`/api/p/${PB_LC_PROJECT}/`)) return p;
  if (p.startsWith("/api/collections/")) return `/api/p/${PB_LC_PROJECT}${p.slice("/api".length)}`;
  if (p.startsWith("/api/files/")) return `/api/p/${PB_LC_PROJECT}${p.slice("/api".length)}`;
  return p;
}

function toFnProjectPath(path) {
  const p = String(path || "");
  if (p.startsWith(`/api/p/${PB_FN_PROJECT}/`)) return p;
  if (p.startsWith("/api/collections/")) return `/api/p/${PB_FN_PROJECT}${p.slice("/api".length)}`;
  if (p.startsWith("/api/files/")) return `/api/p/${PB_FN_PROJECT}${p.slice("/api".length)}`;
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

async function fnPbFetch(path, options = {}) {
  const p = String(path || "");
  const target = toFnProjectPath(p);
  const noFallback = !!options.fnNoFallback;
  const fetchOptions = { ...options };
  delete fetchOptions.fnNoFallback;

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

function ensureLcIsolationDir() {
  fs.mkdirSync(LC_ISOLATION_DIR, { recursive: true });
}

function lcFileIsolationDir(fileId) {
  return path.join(LC_ISOLATION_DIR, "files", String(fileId || ""));
}

function lcFileIsolationMetaPath(fileId) {
  return path.join(lcFileIsolationDir(fileId), "meta.json");
}

function lcFileIsolationBlobPath(fileId) {
  return path.join(lcFileIsolationDir(fileId), "blob.bin");
}

function lcSha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function lcSha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const s = fs.createReadStream(filePath);
    s.on("error", reject);
    s.on("data", (chunk) => hash.update(chunk));
    s.on("end", () => resolve(hash.digest("hex")));
  });
}

function lcHasExecutableSignature(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    // MZ, ELF, Mach-O magic
    const b0 = buf[0];
    const b1 = buf[1];
    const b2 = buf[2];
    const b3 = buf[3];
    if (b0 === 0x4d && b1 === 0x5a) return true;
    if (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46) return true;
    if ((b0 === 0xcf && b1 === 0xfa && b2 === 0xed && b3 === 0xfe) || (b0 === 0xca && b1 === 0xfe && b2 === 0xba && b3 === 0xbe)) return true;
    return false;
  } catch {
    return false;
  }
}

function lcValidateSandboxUpload({ tmpPath, originalName, mimeType, fileSize }) {
  if (!tmpPath || !fs.existsSync(tmpPath)) {
    const err = new Error("Upload temp file missing");
    err.status = 400;
    throw err;
  }
  if (lcHasExecutableSignature(tmpPath)) {
    const err = new Error("Executable files are blocked by sandbox policy");
    err.status = 415;
    throw err;
  }
  const ext = path.extname(String(originalName || "")).toLowerCase();
  const mime = String(mimeType || "").toLowerCase();
  const isOfficeOrDoc = [".pdf", ".xlsx", ".xls", ".csv", ".docx", ".doc", ".pptx", ".txt", ".md", ".html", ".htm", ".py", ".js", ".ts", ".jsx", ".tsx", ".json", ".yaml", ".yml", ".xml", ".log", ".css", ".scss", ".sh", ".bash", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".rb", ".php", ".swift", ".kt", ".sql", ".r", ".lua", ".toml", ".ini", ".cfg", ".env"].includes(ext);
  if (!isOfficeOrDoc && !mime.startsWith("image/") && !mime.startsWith("audio/") && !mime.startsWith("video/")) {
    const err = new Error("File type not allowed by sandbox policy");
    err.status = 415;
    throw err;
  }
  if (Number(fileSize || 0) <= 0) {
    const err = new Error("Empty file blocked by sandbox policy");
    err.status = 400;
    throw err;
  }
}

async function persistLcIsolatedFileFromPath({ fileId, sourcePath, originalName, mimeType, sizeBytes, userId, sessionId, status = "ready", sandboxMode = "full" }) {
  if (!fileId || !sourcePath || !fs.existsSync(sourcePath)) return null;
  ensureLcIsolationDir();
  const dir = lcFileIsolationDir(fileId);
  fs.mkdirSync(dir, { recursive: true });
  const blobPath = lcFileIsolationBlobPath(fileId);
  fs.copyFileSync(sourcePath, blobPath);
  const sha256 = await lcSha256File(blobPath);
  const meta = {
    id: String(fileId),
    originalName: lcUploadSafeName(originalName),
    mimeType: String(mimeType || "application/octet-stream"),
    sizeBytes: Number(sizeBytes || 0),
    userId: String(userId || ""),
    sessionId: String(sessionId || ""),
    status: String(status || "ready"),
    sandboxMode: String(sandboxMode || "full"),
    sha256,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(lcFileIsolationMetaPath(fileId), JSON.stringify(meta, null, 2));
  return meta;
}

async function persistLcIsolatedFileFromBuffer({ fileId, buffer, originalName, mimeType, sizeBytes, userId, sessionId, status = "ready", sandboxMode = "full" }) {
  if (!fileId || !Buffer.isBuffer(buffer) || !buffer.length) return null;
  ensureLcIsolationDir();
  const dir = lcFileIsolationDir(fileId);
  fs.mkdirSync(dir, { recursive: true });
  const blobPath = lcFileIsolationBlobPath(fileId);
  fs.writeFileSync(blobPath, buffer);
  const sha256 = lcSha256Buffer(buffer);
  const meta = {
    id: String(fileId),
    originalName: lcUploadSafeName(originalName),
    mimeType: String(mimeType || "application/octet-stream"),
    sizeBytes: Number(sizeBytes || 0),
    userId: String(userId || ""),
    sessionId: String(sessionId || ""),
    status: String(status || "ready"),
    sandboxMode: String(sandboxMode || "full"),
    sha256,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(lcFileIsolationMetaPath(fileId), JSON.stringify(meta, null, 2));
  return meta;
}

function readLcIsolatedMeta(fileId) {
  try {
    const p = lcFileIsolationMetaPath(fileId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function issueLcFileConsentToken({ fileId, userId }) {
  const token = crypto.randomBytes(24).toString("hex");
  lcFileConsentTokens.set(token, {
    fileId: String(fileId || ""),
    userId: String(userId || ""),
    expiresAt: Date.now() + LC_CONSENT_TOKEN_TTL_SEC * 1000,
    used: false,
  });
  return token;
}

function consumeLcFileConsentToken({ token, fileId, userId }) {
  const rec = lcFileConsentTokens.get(String(token || ""));
  if (!rec) return { ok: false, reason: "missing" };
  if (rec.used) return { ok: false, reason: "used" };
  if (rec.expiresAt <= Date.now()) return { ok: false, reason: "expired" };
  if (rec.fileId !== String(fileId || "") || rec.userId !== String(userId || "")) return { ok: false, reason: "scope_mismatch" };
  rec.used = true;
  lcFileConsentTokens.set(String(token || ""), rec);
  return { ok: true };
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

const LC_PB_EXTRACTED_TEXT_MAX_CHARS = Math.max(100000, Number(process.env.LC_PB_EXTRACTED_TEXT_MAX_CHARS || 1900000));
function clampExtractedTextForPb(text) {
  const normalized = String(text || "");
  if (!normalized) return "";
  if (normalized.length <= LC_PB_EXTRACTED_TEXT_MAX_CHARS) return normalized;
  // Keep both beginning and ending context so follow-up questions about tail sections still work.
  const marker = "\n\n[pb extracted_text truncated: middle omitted]\n\n";
  const budget = Math.max(2000, LC_PB_EXTRACTED_TEXT_MAX_CHARS - marker.length);
  const head = normalized.slice(0, Math.floor(budget * 0.5));
  const tail = normalized.slice(Math.max(0, normalized.length - Math.ceil(budget * 0.5)));
  return `${head}${marker}${tail}`;
}

const LC_MODEL_ATTACHMENT_MAX_CHARS = Math.max(4000, Number(process.env.LC_MODEL_ATTACHMENT_MAX_CHARS || 24000));
const LC_MODEL_ATTACHMENT_MAX_LINES = Math.max(40, Number(process.env.LC_MODEL_ATTACHMENT_MAX_LINES || 220));
const LC_MODEL_ATTACHMENT_FULL_CHARS = Math.max(12000, Number(process.env.LC_MODEL_ATTACHMENT_FULL_CHARS || 48000));
function clampExtractedTextForModel(text, label = "attachment") {
  const normalized = lcNormalizeExtractedText(text);
  if (!normalized) return "";
  const lines = normalized.split(/\r?\n/);
  let clipped = lines.slice(0, LC_MODEL_ATTACHMENT_MAX_LINES).join("\n");
  if (clipped.length > LC_MODEL_ATTACHMENT_MAX_CHARS) clipped = clipped.slice(0, LC_MODEL_ATTACHMENT_MAX_CHARS);
  const omittedLines = Math.max(0, lines.length - LC_MODEL_ATTACHMENT_MAX_LINES);
  const omittedChars = Math.max(0, normalized.length - clipped.length);
  if (!omittedLines && !omittedChars) return clipped;
  const note = `[${label} truncated for model context: omitted ${omittedLines} line(s), ${omittedChars} char(s)]`;
  return `${clipped.trim()}\n\n${note}`.trim();
}
function formatAttachmentContextBlock({ name = "", kind = "", mime = "", text = "", note = "" } = {}) {
  const body = String(text || "").trim();
  if (!body) return "";
  const meta = [
    name ? `name: ${name}` : "",
    kind ? `kind: ${kind}` : "",
    mime ? `mime: ${mime}` : "",
    note ? `note: ${note}` : "",
  ].filter(Boolean).join("\n");
  return `[Attachment Context]\n${meta}\ncontent:\n${body}`.trim();
}
function normalizeAttachmentContextItems(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const text = String(item.text || item.extracted_text || "").trim();
    if (!text) continue;
    const clippedText = text.length > LC_MODEL_ATTACHMENT_FULL_CHARS ? text.slice(0, LC_MODEL_ATTACHMENT_FULL_CHARS) : text;
    out.push({
      file_id: String(item.file_id || "").trim(),
      name: String(item.name || "").trim(),
      kind: String(item.kind || "").trim(),
      mime: String(item.mime || "").trim(),
      note: String(item.note || "parsed attachment text").trim(),
      source: String(item.source || "attachment").trim(),
      text: clippedText,
    });
    if (out.length >= 12) break;
  }
  return out;
}
function buildStructuredAttachmentPayloadBlock({ userQuery = "", attachments = [] } = {}) {
  const normalizedQuery = String(userQuery || "").trim();
  const normalizedAttachments = normalizeAttachmentContextItems(attachments).map((entry) => ({
    file_id: entry.file_id || undefined,
    name: entry.name || undefined,
    kind: entry.kind || undefined,
    mime: entry.mime || undefined,
    note: entry.note || undefined,
    source: entry.source || undefined,
    text: entry.text,
  }));
  if (!normalizedQuery && !normalizedAttachments.length) return "";
  const payload = {
    user_query: normalizedQuery,
    attachments: normalizedAttachments,
  };
  return `[Structured Input JSON]\n${JSON.stringify(payload)}`;
}
function buildFinancialAnalysisPromptBlock(analysisResult = {}) {
  if (!analysisResult || typeof analysisResult !== "object") return "";
  const checks = Array.isArray(analysisResult.checks) ? analysisResult.checks : [];
  const crossChecks = Array.isArray(analysisResult.cross_checks) ? analysisResult.cross_checks : [];
  if (!checks.length && !crossChecks.length) return "";
  const normalized = checks.slice(0, 20).map((c) => ({
    check: String(c.check || ""),
    formula: String(c.formula || ""),
    reported: c.reported,
    computed: c.computed,
    difference: c.difference,
    status: String(c.status || ""),
    missing_fields: Array.isArray(c.missing_fields) ? c.missing_fields : [],
  }));

  // Build human-readable cross-check summary for the AI
  let crossCheckBlock = "";
  if (crossChecks.length > 0) {
    const lines = ["=== PROGRAMMATIC CROSS-CHECKS (computed, not estimated) ==="];
    crossChecks.forEach((xc, i) => {
      const status = String(xc.status || "insufficient");
      const icon = status === "pass" ? "[PASS]" : status === "fail" ? "[FAIL]" : "[?]";
      const checkName = String(xc.check || "").replace(/_/g, " ");
      const formula = String(xc.formula || "");
      const mainVal = xc.main_value != null ? Number(xc.main_value).toLocaleString("en-US") : "N/A";
      const detailSum = xc.detail_sum != null ? Number(xc.detail_sum).toLocaleString("en-US") : "N/A";
      const source = String(xc.main_source || "");
      if (status === "pass") {
        lines.push(`${i + 1}. ${icon} ${checkName}: ${source} ${mainVal} == Detail sum ${detailSum}`);
      } else if (status === "fail") {
        const diff = xc.difference != null ? Number(xc.difference).toLocaleString("en-US") : "?";
        lines.push(`${i + 1}. ${icon} ${checkName}: ${source} ${mainVal} != Detail sum ${detailSum} (diff: ${diff})`);
      } else {
        lines.push(`${i + 1}. ${icon} ${checkName}: insufficient data for verification`);
      }
      if (formula) lines.push(`   Formula: ${formula}`);
    });
    crossCheckBlock = lines.join("\n");
  }

  const payload = {
    summary: String(analysisResult.summary || ""),
    checks: normalized,
    cross_checks: crossChecks.slice(0, 20),
    extracted_fields: analysisResult.extracted_fields || {},
    missing_fields: Array.isArray(analysisResult.missing_fields) ? analysisResult.missing_fields : [],
    meta: analysisResult.meta && typeof analysisResult.meta === "object" ? analysisResult.meta : {},
  };
  let block = `[Financial Analysis JSON]\n${JSON.stringify(payload)}`;
  if (crossCheckBlock) {
    block += `\n\n${crossCheckBlock}`;
  }
  return block;
}
async function runFinancialAnalysisForAttachments({ query = "", attachments = [], lang = "en" } = {}) {
  const docs = normalizeAttachmentContextItems(attachments).map((item) => ({
    name: item.name || item.file_id || "attachment",
    source: item.source || "attachment",
    text: item.text || "",
  })).filter((d) => d.text);
  if (!docs.length) {
    return {
      ok: false,
      summary: "No attachment evidence provided for financial analysis",
      checks: [],
      missing_fields: ["attachment_text"],
      evidence: [],
      meta: { documents_count: 0 },
    };
  }
  try {
    const analyzed = await analyzeFinancialStatements({ query, documents: docs, lang, strict: true });
    return analyzed;
  } catch (err) {
    return {
      ok: false,
      summary: `Financial analysis failed: ${err.message}`,
      checks: [],
      missing_fields: [],
      evidence: [],
      meta: { error: err.message },
    };
  }
}
function extractMessagePlainText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && typeof part === "object" && part.type === "text")
      .map((part) => String(part.text || ""))
      .join("\n");
  }
  return "";
}
function stripAttachmentContextBlocks(text) {
  const src = String(text || "");
  if (!src || !src.includes("[Attachment Context]")) return src;
  // LumiChat appends attachment blocks after user query text.
  // For URL detection, only keep the leading natural-language query segment.
  return src.split("[Attachment Context]")[0].trim();
}
function contentHasAttachmentContext(content) {
  if (typeof content === "string") return content.includes("[Attachment Context]");
  if (Array.isArray(content)) {
    return content.some((part) => part && typeof part === "object" && part.type === "text" && String(part.text || "").includes("[Attachment Context]"));
  }
  return false;
}
const LC_CN_NUM_MAP = { "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
function lcCnNumeralToNumber(text) {
  const s = String(text || "").trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  const pos = s.indexOf("十");
  if (pos >= 0) {
    const left = pos === 0 ? 1 : (LC_CN_NUM_MAP[s.slice(0, pos)] ?? NaN);
    const rightText = s.slice(pos + 1);
    const right = rightText ? (LC_CN_NUM_MAP[rightText] ?? NaN) : 0;
    if (!Number.isFinite(left) || !Number.isFinite(right)) return NaN;
    return left * 10 + right;
  }
  return LC_CN_NUM_MAP[s] ?? NaN;
}
function lcNumberToCnNumeral(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return "";
  if (n < 10) return Object.keys(LC_CN_NUM_MAP).find((k) => LC_CN_NUM_MAP[k] === n) || "";
  if (n === 10) return "十";
  if (n < 20) return `十${lcNumberToCnNumeral(n - 10)}`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${lcNumberToCnNumeral(tens)}十${ones ? lcNumberToCnNumeral(ones) : ""}`;
}
function extractQueryNoteRefs(text) {
  const raw = String(text || "");
  if (!raw) return [];
  const refs = new Set();
  const re = /(附注|附註|注|註|note|notes?)\s*[:：.\-]?\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})/ig;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const n = lcCnNumeralToNumber(m[2]);
    if (Number.isFinite(n) && n >= 1 && n <= 99) refs.add(n);
  }
  return [...refs];
}
function attachmentQueryTerms(text) {
  const raw = String(text || "").toLowerCase();
  const noteRefs = extractQueryNoteRefs(text);
  const noteAliasTokens = [];
  const financeAliasTokens = [];
  for (const n of noteRefs) {
    const cn = lcNumberToCnNumeral(n);
    noteAliasTokens.push(
      `note ${n}`,
      `notes ${n}`,
      `附注${n}`,
      `附註${n}`,
      `第${n}`,
      "附注",
      "附註"
    );
    if (cn) {
      noteAliasTokens.push(
        cn,
        `附注${cn}`,
        `附註${cn}`,
        `第${cn}`
      );
    }
  }
  if (/\bbs\b|balance\s*sheet|statement\s*of\s*financial\s*position|资产负债表|資產負債表/i.test(raw)) {
    financeAliasTokens.push("balance sheet", "statement of financial position", "current assets", "current liabilities", "资产负债表", "資產負債表", "流动资产", "流動資產", "流动负债", "流動負債");
  }
  if (/\bnote(s)?\b|附注|附註|财务报表附注|財務報表附註/i.test(raw)) {
    financeAliasTokens.push("notes", "note", "附注", "附註", "綜合財務報告附註", "notes to the consolidated financial statements");
  }
  if (/\btie\b|勾稽|核对|核對|一致|reconcile|roll[-\s]*forward/i.test(raw)) {
    financeAliasTokens.push("reconcile", "tied", "tie", "勾稽", "核对", "核對", "一致", "changes in", "變動");
  }
  if (/存货|存貨|inventory|inventories|stocks/i.test(raw)) {
    financeAliasTokens.push("inventory", "inventories", "stocks", "存货", "存貨");
  }
  if (/香港财报|香港財報|hkfrs|hksas|annual report|综合财务报表|綜合財務報表|consolidated/i.test(raw)) {
    financeAliasTokens.push(
      "annual report", "consolidated financial statements", "notes to the consolidated financial statements",
      "statement of financial position", "balance sheet", "statement of profit or loss", "statement of comprehensive income",
      "statement of changes in equity", "statement of cash flows",
      "綜合財務狀況表", "綜合損益表", "綜合全面收益表", "綜合權益變動表", "綜合現金流量表",
      "综合财务状况表", "综合损益表", "综合全面收益表", "综合权益变动表", "综合现金流量表",
      "附註", "附注", "營業額及分部資料", "turnover and segment information",
      "trade and other receivables", "trade and other payables", "property, plant and equipment",
      "goodwill", "intangible assets", "borrowings", "taxation", "earnings per share", "dividends",
      "stocks", "inventories", "deferred tax", "non-controlling interests", "owners of the company"
    );
  }
  const baseTokens = raw
    .replace(/[^\p{L}\p{N}_\s-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const latinTokens = raw.match(/[a-z0-9_]{2,}/g) || [];
  const cjkTokens = raw.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const stop = /^(the|and|for|with|from|this|that|only|using|uploaded|file|attachment|please|list|show|give|tell|about|do|not|use|web|search|仅基于|只基于|上传文件|继续)$/i;
  const sticky = new Set([...noteAliasTokens, ...financeAliasTokens].map((t) => String(t || "").toLowerCase()).filter(Boolean));
  return Array.from(new Set(
    [...baseTokens, ...latinTokens, ...cjkTokens, ...noteAliasTokens, ...financeAliasTokens]
      .map((t) => String(t || "").trim())
      .filter((token) => {
        if (!token) return false;
        if (sticky.has(token.toLowerCase())) return true;
        if (token.length >= 2 && !stop.test(token)) return true;
        return false;
      })
  ));
}
function buildRelevantAttachmentExcerpt(text, queryText = "", maxChars = LC_MODEL_ATTACHMENT_FULL_CHARS) {
  const normalized = lcNormalizeExtractedText(text);
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  const findNoteScopedBlock = (noteNum) => {
    const lines = normalized.split(/\r?\n/);
    if (!lines.length) return "";
    const cn = lcNumberToCnNumeral(noteNum);
    const noteHeadingRe = new RegExp(
      String.raw`^\s*(?:附[注註]\s*)?(?:${noteNum}${cn ? `|${cn}` : ""})\s*[\.、：:]\s*$|^\s*note\s*${noteNum}\b`,
      "i"
    );
    const anyHeadingRe = /^\s*(?:附[注註]\s*)?(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*[\.、：:]\s*$/;
    const starts = [];
    for (let i = 0; i < lines.length; i++) {
      if (noteHeadingRe.test(String(lines[i] || "").trim())) starts.push(i);
    }
    if (!starts.length) return "";
    // Prefer the candidate that also contains likely table/casting clues nearby.
    const scoredStarts = starts.map((s) => {
      const near = lines.slice(s, Math.min(lines.length, s + 400)).join("\n");
      let score = 0;
      if (/turnover|segment|營業額|分部|total|合计|合計|elimination|對銷|抵销|抵銷/i.test(near)) score += 5;
      if (/\d{1,3},\d{3}/.test(near)) score += 3;
      if (/rmb|人民幣|million|百萬元/i.test(near)) score += 2;
      return { s, score };
    }).sort((a, b) => b.score - a.score);
    const start = scoredStarts[0].s;
    let end = Math.min(lines.length, start + 2200);
    for (let i = start + 1; i < Math.min(lines.length, start + 2400); i++) {
      if (anyHeadingRe.test(String(lines[i] || "").trim()) && !noteHeadingRe.test(String(lines[i] || "").trim())) {
        end = i;
        break;
      }
    }
    const block = lines.slice(Math.max(0, start - 6), end).join("\n").trim();
    if (!block) return "";
    if (block.length <= maxChars) return block;
    const clipped = block.slice(0, Math.max(8000, Math.floor(maxChars * 0.9))).trim();
    const omitted = Math.max(0, block.length - clipped.length);
    return `${clipped}\n\n[attachment note block truncated: omitted ${omitted} char(s)]`;
  };
  const buildHeadTailExcerpt = () => {
    const separator = "\n\n[attachment excerpt includes the beginning and end of a longer file]\n\n";
    const budget = Math.max(2000, maxChars - separator.length);
    const headBudget = Math.floor(budget * 0.45);
    const tailBudget = Math.floor(budget * 0.45);
    const head = normalized.slice(0, headBudget).trim();
    const tail = normalized.slice(Math.max(0, normalized.length - tailBudget)).trim();
    const merged = `${head}${separator}${tail}`.trim();
    const omittedChars = Math.max(0, normalized.length - merged.length);
    return `${merged}\n\n[attachment excerpt selected for model context: omitted ${omittedChars} char(s)]`.trim();
  };
  const terms = attachmentQueryTerms(queryText);
  let segments = normalized
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment, idx) => ({ idx, segment }));
  if (!segments.length) return buildHeadTailExcerpt();
  if (segments.length === 1 || segments.some((entry) => entry.segment.length > Math.max(1200, maxChars * 0.6))) {
    const lines = normalized.split(/\r?\n/).filter(Boolean);
    const windowSize = 120;
    const step = 90;
    const windows = [];
    for (let start = 0; start < lines.length; start += step) {
      const chunk = lines.slice(start, start + windowSize).join("\n").trim();
      if (!chunk) continue;
      windows.push({ idx: windows.length, segment: chunk });
      if (start + windowSize >= lines.length) break;
    }
    if (windows.length > 1) segments = windows;
    else return buildHeadTailExcerpt();
  }
  const wantsTail = /(tail|end|ending|final|closing|last|末尾|最后|尾部|结尾|末端|后段|后面)/i.test(queryText);
  const wantsHead = /(first|beginning|start|opening|开头|开始|前面|前段)/i.test(queryText);
  const noteRefs = extractQueryNoteRefs(queryText);
  const wantsCalcCheck = /(核对|核對|计算|計算|勾稽|tie|reconcile|是否正确|是否正確|是否一致|check|verify)/i.test(queryText);
  if (noteRefs.length && wantsCalcCheck) {
    for (const noteNum of noteRefs) {
      const block = findNoteScopedBlock(noteNum);
      if (block) return block;
    }
  }
  const scored = segments.map(({ idx, segment }) => {
    const lower = segment.toLowerCase();
    let score = 0;
    let noteHeadingMatch = false;
    for (const term of terms) {
      if (lower.includes(term)) score += 5;
    }
    if (noteRefs.length) {
      for (const noteNum of noteRefs) {
        const cn = lcNumberToCnNumeral(noteNum);
        const hasNoteHeading = (
          new RegExp(`(?:附[注註]\\s*${noteNum}|note\\s*${noteNum}|(?:^|\\n)\\s*${noteNum}\\s*[\\.、：:](?!\\d))`, "i").test(segment)
          || (cn && new RegExp(`(?:附[注註]\\s*${cn}|(?:^|\\n)\\s*${cn}\\s*[\\.、：:](?!\\d))`, "i").test(segment))
        );
        if (hasNoteHeading) {
          score += 16;
          noteHeadingMatch = true;
        }
      }
    }
    if (idx === 0) score += 1;
    if (wantsTail && segments.length > 1) score += (idx / (segments.length - 1)) * 4;
    if (wantsHead && segments.length > 1) score += ((segments.length - 1 - idx) / (segments.length - 1)) * 4;
    return { idx, segment, score, noteHeadingMatch };
  });
  const chosen = [];
  let used = 0;
  const chosenIdx = new Set();
  const pushIfFit = (entry) => {
    if (!entry || chosenIdx.has(entry.idx)) return false;
    if ((used + entry.segment.length + 2) > maxChars) return false;
    chosen.push(entry);
    chosenIdx.add(entry.idx);
    used += entry.segment.length + 2;
    return true;
  };

  // For note+calculation questions, prioritize continuous context around matched note headings,
  // so numeric tables are included instead of isolated title lines.
  if (noteRefs.length && wantsCalcCheck) {
    const anchors = scored
      .filter((entry) => entry.noteHeadingMatch)
      .map((entry) => entry.idx)
      .slice(0, 4);
    const radius = 22;
    for (const anchor of anchors) {
      for (let i = Math.max(0, anchor - radius); i <= Math.min(scored.length - 1, anchor + radius); i++) {
        const near = scored.find((entry) => entry.idx === i);
        if (!near) continue;
        if (!pushIfFit(near)) break;
      }
      if (used >= maxChars * 0.75) break;
    }
  }

  const sorted = scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  for (const entry of sorted) {
    if (entry.score <= 0 && chosen.length) continue;
    if (!pushIfFit(entry)) continue;
    if (used >= maxChars * 0.85) break;
  }
  if (!chosen.some((entry) => entry.idx === 0)) {
    const head = scored.find((entry) => entry.idx === 0);
    if (head && (used + head.segment.length + 2) <= maxChars) {
      chosen.push(head);
      used += head.segment.length + 2;
    }
  }
  if (!chosen.some((entry) => entry.idx === scored.length - 1)) {
    const tail = scored.find((entry) => entry.idx === scored.length - 1);
    if (tail && (used + tail.segment.length + 2) <= maxChars) {
      chosen.push(tail);
      used += tail.segment.length + 2;
    }
  }
  if (!chosen.length) return buildHeadTailExcerpt();
  if (noteRefs.length) {
    const picked = new Set(chosen.map((entry) => entry.idx));
    const anchors = chosen.filter((entry) => entry.noteHeadingMatch).map((entry) => entry.idx);
    for (const anchorIdx of anchors) {
      const nearCandidates = wantsCalcCheck
        ? Array.from({ length: 25 }, (_, off) => anchorIdx - 12 + off)
        : [anchorIdx - 1, anchorIdx + 1, anchorIdx + 2];
      for (const nearIdx of nearCandidates) {
        if (nearIdx < 0 || nearIdx >= scored.length) continue;
        if (picked.has(nearIdx)) continue;
        const near = scored.find((entry) => entry.idx === nearIdx);
        if (!near) continue;
        if (!pushIfFit(near)) continue;
        picked.add(nearIdx);
      }
    }
  }
  chosen.sort((a, b) => a.idx - b.idx);
  const excerpt = chosen.map((entry) => entry.segment).join("\n\n").trim();
  const omittedChars = Math.max(0, normalized.length - excerpt.length);
  if (!omittedChars) return excerpt;
  return `${excerpt}\n\n[attachment excerpt selected for model context: omitted ${omittedChars} char(s)]`.trim();
}
function buildAttachmentModelContext({ name = "", kind = "", mime = "", text = "", queryText = "" } = {}) {
  const excerpt = buildRelevantAttachmentExcerpt(text, queryText, LC_MODEL_ATTACHMENT_FULL_CHARS);
  if (!excerpt) return "";
  return formatAttachmentContextBlock({
    name,
    kind,
    mime,
    text: excerpt,
    note: "parsed attachment text",
  });
}
async function fetchLcAttachmentContextsByIds(ids, { token, ownerId, queryText = "" } = {}) {
  const uniqueIds = [...new Set((ids || []).filter((id) => validPbId(id)))].slice(0, 24);
  const terms = attachmentQueryTerms(queryText);
  const rows = [];
  for (const id of uniqueIds) {
    try {
      await assertRecordOwned("files", { id, ownerId, token });
      const r = await lcPbFetch(`/api/collections/lc_files/records/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) continue;
      const rec = await r.json();
      const context = buildAttachmentModelContext({
        name: rec.original_name || rec.file || id,
        kind: rec.kind || lcFileKindByMimeOrExt(rec.mime_type, rec.original_name || rec.file),
        mime: rec.mime_type || "application/octet-stream",
        text: rec.extracted_text || "",
        queryText,
      });
      if (!context) continue;
      const name = rec.original_name || rec.file || id;
      const kind = rec.kind || lcFileKindByMimeOrExt(rec.mime_type, name);
      const mime = rec.mime_type || "application/octet-stream";
      const lowerName = String(name).toLowerCase();
      const lowerKind = String(kind).toLowerCase();
      const lowerMime = String(mime).toLowerCase();
      const lowerExtract = String(rec.extracted_text || "").toLowerCase();
      let relevance = 0;
      for (const t of terms) {
        if (!t) continue;
        if (lowerName.includes(t)) relevance += 4;
        if (lowerKind.includes(t) || lowerMime.includes(t)) relevance += 3;
        if (lowerExtract.includes(t)) relevance += 2;
      }
      // Keep deterministic ordering and avoid starvation when relevance ties.
      if (kind === "spreadsheet") relevance += 0.05;
      if (kind === "document") relevance += 0.03;
      if (kind === "pdf") relevance += 0.02;
      rows.push({
        id,
        name,
        kind,
        mime,
        relevance,
        context,
      });
    } catch (err) {
      log("warn", "lc attachment context skipped", { fileId: id, error: err.message });
    }
  }
  if (!rows.length) return [];
  // Multi-file chats can overflow weaker models; prioritize relevant files by query.
  const maxItems = Math.min(4, rows.length);
  if (terms.length) {
    const sorted = rows
      .slice()
      .sort((a, b) => (b.relevance - a.relevance) || a.name.localeCompare(b.name))
      .slice(0, maxItems);
    const relevantOnly = sorted.filter((item) => item.relevance > 0);
    if (relevantOnly.length) return relevantOnly;
    // If query terms failed to match any file, fall back to stable first-N list.
    if (sorted[0]?.relevance > 0) return sorted;
  }
  return rows.slice(0, maxItems);
}

function mergeArraysUnique(a, b) {
  return [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].filter(Boolean))];
}

function lcNormalizeExtractedText(text) {
  return String(text || "")
    .replace(/^⚠️[^\n]*\n+/u, "")
    .trim();
}

const LC_SPREADSHEET_CLEAN_MAX_LINES = Math.max(2000, Number(process.env.LC_SPREADSHEET_CLEAN_MAX_LINES || 30000));
const LC_SPREADSHEET_CLEAN_MAX_CHARS = Math.max(200000, Number(process.env.LC_SPREADSHEET_CLEAN_MAX_CHARS || 6000000));
function lcCleanSpreadsheetExtractedText(text) {
  const normalized = lcNormalizeExtractedText(text);
  if (!normalized) return "";
  const lines = normalized.split(/\r?\n/);
  const out = [];
  let charCount = 0;
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
    charCount += line.length + 1;
    if (out.length >= LC_SPREADSHEET_CLEAN_MAX_LINES || charCount >= LC_SPREADSHEET_CLEAN_MAX_CHARS) break;
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

async function extractTextForLcBuffer(buffer, originalName, mimeType) {
  const tmpPath = path.join(os.tmpdir(), `lcenc-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    return await extractTextForLcUpload(tmpPath, originalName, mimeType);
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

async function describeImageBufferForModel(buffer, { prompt = "" } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return "";
  const OLLAMA_URL = process.env.OLLAMA_URL || "http://host.docker.internal:11434";
  const VISION_MODEL = process.env.VISION_MODEL || "qwen2.5-vl:3b";
  const finalPrompt = String(prompt || "Describe this image in detail, extract visible text, and summarize key visual facts for a text-only model.");
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODEL,
        prompt: finalPrompt,
        images: [buffer.toString("base64")],
        stream: false,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      log("warn", "Encrypted image vision analyze failed", { status: resp.status, error: errText.slice(0, 400) });
      return "";
    }
    const data = await resp.json().catch(() => ({}));
    return String(data?.response || "").trim();
  } catch (err) {
    log("warn", "Encrypted image vision analyze unreachable", { error: err.message });
    return "";
  }
}

async function uploadLcBufferRecord({ buffer, originalName, mimeType, sessionId, userId, token }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("Missing file buffer");
  if (!sessionId || !userId || !token) throw new Error("Missing upload context");

  const now = lcNowIso();
  const safeOriginalName = String(originalName || "file");
  const fileName = path.basename(safeOriginalName).replace(/"/g, "_");
  const ext = path.extname(safeOriginalName).toLowerCase();
  const detectedMime = detectLcUploadMime(safeOriginalName, mimeType);
  const kind = lcFileKindByMimeOrExt(detectedMime, safeOriginalName);
  const extraction = await extractTextForLcBuffer(buffer, safeOriginalName, detectedMime);
  const sandboxPolicy = getLcFileSandboxPolicy();
  const trusted = sandboxPolicy.trustedUsers.includes(String(userId || ""));
  const uploadSandboxEnabled = !!sandboxPolicy.uploadEnabled && !(sandboxPolicy.uploadTrustedBypass && trusted);
  const sandboxMode = uploadSandboxEnabled ? "full" : "trusted_bypass";
  if (uploadSandboxEnabled) {
    // Enforce lightweight sandbox gate on encrypted uploads as well.
    const tmpEncPath = path.join(os.tmpdir(), `lcenc-check-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
    fs.writeFileSync(tmpEncPath, buffer);
    try {
      lcValidateSandboxUpload({
        tmpPath: tmpEncPath,
        originalName: safeOriginalName,
        mimeType: detectedMime,
        fileSize: buffer.length,
      });
    } finally {
      fs.unlink(tmpEncPath, () => {});
    }
  }
  log("info", "lc encrypted upload policy", {
    userId,
    sessionId,
    name: safeOriginalName,
    mime: detectedMime,
    sizeBytes: buffer.length,
    sandboxMode,
  });
  const boundary = `LumiGate${crypto.randomBytes(8).toString("hex")}`;

  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="session"\r\n\r\n${sessionId}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="user"\r\n\r\n${userId}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="mime_type"\r\n\r\n${detectedMime}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="size_bytes"\r\n\r\n${buffer.length}`,
  ];
  if (lcSupportsField("files", "original_name")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="original_name"\r\n\r\n${lcUploadSafeName(safeOriginalName)}`);
  if (lcSupportsField("files", "ext")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="ext"\r\n\r\n${ext}`);
  if (lcSupportsField("files", "kind")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}`);
  if (lcSupportsField("files", "parse_status")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="parse_status"\r\n\r\n${extraction.status}`);
  if (lcSupportsField("files", "parse_error")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="parse_error"\r\n\r\n${extraction.error || ""}`);
  if (lcSupportsField("files", "parsed_at")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="parsed_at"\r\n\r\n${extraction.parsedAt || ""}`);
  if (lcSupportsField("files", "security_status")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="security_status"\r\n\r\nscanned`);
  if (lcSupportsField("files", "sandbox_mode")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="sandbox_mode"\r\n\r\n${sandboxMode}`);
  if (lcSupportsField("files", "consent_required")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="consent_required"\r\n\r\n${sandboxPolicy.requireConsent ? "1" : "0"}`);
  if (lcSupportsField("files", "created_at")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="created_at"\r\n\r\n${now}`);
  if (lcSupportsField("files", "updated_at")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="updated_at"\r\n\r\n${now}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="extracted_text"\r\n\r\n${extraction.text}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${detectedMime}\r\n\r\n`);

  const head = Buffer.from(parts.join("\r\n"));
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buffer, tail]);
  const r = await lcPbFetch("/api/collections/lc_files/records", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const data = await r.json();
  if (!r.ok) {
    throw Object.assign(new Error(pbErrorSummary(data, "Encrypted file save failed")), { status: r.status });
  }
  const isolatedMeta = await persistLcIsolatedFileFromBuffer({
    fileId: data.id,
    buffer,
    originalName: safeOriginalName,
    mimeType: detectedMime,
    sizeBytes: buffer.length,
    userId,
    sessionId,
    status: "ready",
    sandboxMode,
  });
  if (isolatedMeta) {
    const patchBody = {};
    if (lcSupportsField("files", "storage_ref")) patchBody.storage_ref = `isolation://files/${data.id}/blob.bin`;
    if (lcSupportsField("files", "storage_sha256")) patchBody.storage_sha256 = isolatedMeta.sha256;
    if (Object.keys(patchBody).length) {
      await lcPbFetch(`/api/collections/lc_files/records/${data.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      }).catch(() => {});
    }
  }
  audit(userId || null, "lc_file_upload_encrypted", data.id, {
    sessionId,
    sandboxMode,
    sizeBytes: buffer.length,
    mimeType: detectedMime,
  });
  return {
    id: data.id,
    url: `/lc/files/serve/${data.id}`,
    mime_type: detectedMime,
    size_bytes: buffer.length,
    extracted_text: extraction.text,
  };
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
    { name: "security_status", type: "text", max: 32 },
    { name: "sandbox_mode", type: "text", max: 32 },
    { name: "consent_required", type: "text", max: 16 },
    { name: "storage_ref", type: "text", max: 255 },
    { name: "storage_sha256", type: "text", max: 80 },
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
  fnPets: {
    name: "pet_profiles",
    ownerField: "owner",
    defaultPerPage: 100,
    pbClient: "fn",
    filterableFields: ["id", "owner", "local_id", "name", "species", "breed", "gender", "birthday"],
    sortableFields: ["id", "local_updated_at", "name", "birthday"],
    writableFields: ["local_id", "name", "species", "breed", "birthday", "gender", "is_neutered", "weight_kg", "current_food", "vaccine_count", "is_indoor_only", "is_multi_cat", "onboarding_intent", "body_length_cm", "tail_length_cm", "fur_length_cm", "fur_color", "photo", "local_updated_at"],
  },
  fnConversations: {
    name: "chat_conversations",
    ownerField: "owner",
    defaultPerPage: 200,
    pbClient: "fn",
    filterableFields: ["id", "owner", "local_id", "title", "style", "local_created_at", "local_updated_at"],
    sortableFields: ["id", "local_created_at", "local_updated_at", "title"],
    writableFields: ["local_id", "title", "style", "local_created_at", "local_updated_at"],
  },
  fnMessages: {
    name: "chat_messages",
    ownerField: "owner",
    defaultPerPage: 200,
    pbClient: "fn",
    filterableFields: ["id", "owner", "local_id", "conversation_local_id", "role", "local_created_at", "local_updated_at", "is_error"],
    sortableFields: ["id", "local_created_at", "local_updated_at", "role"],
    writableFields: ["local_id", "conversation_local_id", "role", "content", "is_error", "extracted_event_json", "extraction_confirmed", "local_created_at", "local_updated_at"],
  },
  fnHealthRecords: {
    name: "health_records",
    ownerField: "owner",
    defaultPerPage: 200,
    pbClient: "fn",
    filterableFields: ["id", "owner", "local_id", "pet_local_id", "category", "recorded_at", "local_updated_at"],
    sortableFields: ["id", "recorded_at", "local_updated_at", "category"],
    writableFields: ["local_id", "pet_local_id", "reminder_local_id", "category", "title", "note", "outcome", "recorded_at", "local_updated_at"],
  },
  fnReminders: {
    name: "health_reminders",
    ownerField: "owner",
    defaultPerPage: 200,
    pbClient: "fn",
    filterableFields: ["id", "owner", "local_id", "pet_local_id", "category", "status", "scheduled_date", "local_updated_at"],
    sortableFields: ["id", "scheduled_date", "local_updated_at", "category"],
    writableFields: ["local_id", "pet_local_id", "category", "custom_title", "note", "scheduled_date", "status", "notification_id", "local_updated_at"],
  },
  fnMeasurements: {
    name: "pet_measurements",
    ownerField: "owner",
    defaultPerPage: 200,
    pbClient: "fn",
    filterableFields: ["id", "owner", "local_id", "pet_local_id", "measurement_type", "recorded_at", "local_updated_at"],
    sortableFields: ["id", "recorded_at", "local_updated_at", "measurement_type"],
    writableFields: ["local_id", "pet_local_id", "measurement_type", "value", "recorded_at", "local_updated_at"],
  },
  fnInventory: {
    name: "stock_items",
    ownerField: "owner",
    defaultPerPage: 200,
    pbClient: "fn",
    filterableFields: ["id", "owner", "local_id", "pet_local_id", "category", "brand", "name", "expiry_date", "local_updated_at"],
    sortableFields: ["id", "local_created_at", "local_updated_at", "name", "expiry_date"],
    writableFields: ["local_id", "pet_local_id", "category", "brand", "name", "spec", "quantity", "unit", "low_stock_threshold", "kcal_per_kg", "protein_percent", "fat_percent", "fiber_percent", "moisture_percent", "expiry_date", "local_created_at", "local_updated_at"],
  },
  fnReportSnapshots: {
    name: "report_snapshots",
    ownerField: "owner",
    defaultPerPage: 50,
    pbClient: "fn",
    filterableFields: ["id", "owner", "pet_local_id", "period_type", "period_start", "period_end", "generated_at"],
    sortableFields: ["id", "generated_at", "period_start", "period_end"],
    writableFields: ["owner", "local_id", "pet_local_id", "period_type", "period_start", "period_end", "score_total", "score_breakdown_json", "insights_json", "generated_at"],
  },
  fnRagSessions: {
    name: "rag_sessions",
    ownerField: "data_owner_id",
    defaultPerPage: 100,
    pbClient: "fn",
    filterableFields: ["id", "data_owner_id", "pet_id", "created", "updated", "llm_model"],
    sortableFields: ["id", "created", "updated", "top_similarity", "tokens_used"],
    writableFields: ["data_owner_id", "pet_id", "query", "answer", "llm_model", "retrieved_chunks", "top_similarity", "tokens_used"],
  },
};

const LC_USER_SETTINGS_DEFAULTS = Object.freeze({
  memory: "",
  sensitivity: "default",
  presets: [],
  theme: "auto",
  compact: false,
  active_project: "",
  default_provider: "",
  default_model: "",
});

const SEARCH_KEYWORD_PROVIDER_OPTIONS = Object.freeze([
  { value: "minimax", label: "MiniMax" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "qwen", label: "Qwen" },
]);

const SEARCH_KEYWORD_MODEL_OPTIONS = Object.freeze([
  { value: "MiniMax-M1", label: "MiniMax-M1" },
  { value: "deepseek-chat", label: "deepseek-chat" },
  { value: "gpt-4.1-nano", label: "gpt-4.1-nano" },
  { value: "gemini-2.5-flash", label: "gemini-2.5-flash" },
  { value: "qwen-turbo", label: "qwen-turbo" },
]);

const ATTACHMENT_SEARCH_MODE_OPTIONS = Object.freeze([
  { value: "smart", label: "Smart" },
  { value: "always", label: "Always" },
  { value: "assistant_decide", label: "Assistant Decide" },
  { value: "off", label: "Off" },
]);

function normalizeLcUserSettingsRecord(record) {
  return { ...LC_USER_SETTINGS_DEFAULTS, ...(record || {}) };
}

async function getOrCreateLcUserSettingsRecord(userId, token) {
  const r = await pbListOwnedRecords("userSettings", { ownerId: userId, token });
  const d = await r.json();
  const record = d.items?.[0] || null;
  if (record) return normalizeLcUserSettingsRecord(record);

  const cr = await lcPbFetch("/api/collections/lc_user_settings/records", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ user: userId, ...LC_USER_SETTINGS_DEFAULTS }),
  });
  const created = await cr.json();
  return normalizeLcUserSettingsRecord(created);
}

function buildLcSettingsUiSchema() {
  return {
    user: {
      writable: true,
      fields: {
        memory: { type: "textarea", label: "System Prompt" },
        sensitivity: {
          type: "enum",
          label: "Response Mode",
          options: [
            { value: "strict", label: "Strict" },
            { value: "default", label: "Default" },
            { value: "creative", label: "Creative" },
            { value: "unrestricted", label: "Unrestricted" },
          ],
        },
        default_provider: { type: "provider", label: "Default Provider" },
        default_model: { type: "model", label: "Default Model" },
        theme: {
          type: "enum",
          label: "Theme",
          options: [
            { value: "auto", label: "Auto" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ],
        },
        compact: { type: "boolean", label: "Compact Messages" },
      },
    },
    runtime: {
      writable: false,
      description: "Managed by server",
      fields: {
        autoSearchEnabled: { type: "boolean", label: "Auto Search", value: settings.autoSearchEnabled !== false },
        attachmentSearchMode: { type: "enum", label: "Attachment Search Mode", value: getAttachmentSearchMode(), options: ATTACHMENT_SEARCH_MODE_OPTIONS },
        toolInjectionEnabled: { type: "boolean", label: "Tool Injection", value: settings.toolInjectionEnabled !== false },
        searchKeywordProvider: { type: "enum", label: "Search Keyword Provider", value: settings.searchKeywordProvider || "minimax", options: SEARCH_KEYWORD_PROVIDER_OPTIONS },
        searchKeywordModel: { type: "enum", label: "Search Keyword Model", value: settings.searchKeywordModel || "MiniMax-M1", options: SEARCH_KEYWORD_MODEL_OPTIONS },
      },
    },
  };
}

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
  fn: {
    pets: {
      deletePolicy: DELETE_POLICY.SOFT,
      references: [],
    },
    conversations: {
      deletePolicy: DELETE_POLICY.SOFT,
      references: [],
    },
    messages: {
      deletePolicy: DELETE_POLICY.SOFT,
      references: [],
    },
    healthRecords: {
      deletePolicy: DELETE_POLICY.SOFT,
      references: [],
    },
    reminders: {
      deletePolicy: DELETE_POLICY.SOFT,
      references: [],
    },
    measurements: {
      deletePolicy: DELETE_POLICY.SOFT,
      references: [],
    },
    inventory: {
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
  fn: {
    label: "FurNote",
    authAdapter: "fn",
    collections: {
      pets: "fnPets",
      conversations: "fnConversations",
      messages: "fnMessages",
      healthRecords: "fnHealthRecords",
      reminders: "fnReminders",
      measurements: "fnMeasurements",
      inventory: "fnInventory",
      reportSnapshots: "fnReportSnapshots",
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

function collectionPbFetch(configKey, path, options = {}) {
  const config = getLcCollectionConfig(configKey);
  const client = String(config?.pbClient || "lc").toLowerCase();
  if (client === "fn") return fnPbFetch(path, options);
  if (client === "lc") return lcPbFetch(path, options);
  return pbFetch(path, options);
}

const DOMAIN_AUTH_ADAPTERS = {
  lc: {
    middleware: requireLcAuth,
    getContext: (req) => ({ ownerId: req.lcUser?.id, token: req.lcToken }),
  },
  fn: {
    middleware: _requireFnAuth,
    getContext: (req) => ({ ownerId: req.fnUser?.id, token: req.fnToken }),
  },
};

function domainPbFetch(domainKey, path, options = {}) {
  const key = String(domainKey || "").toLowerCase();
  if (key === "lc") return lcPbFetch(path, options);
  if (key === "fn") return fnPbFetch(path, options);
  return pbFetch(path, options);
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
  return collectionPbFetch(configKey, buildPbQuery({
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

function canSoftDelete(configKey) {
  const config = getLcCollectionConfig(configKey);
  const fields = config?.filterableFields || [];
  return fields.includes("deleted_at") && fields.includes("deleted_by") && fields.includes("delete_reason");
}

async function softDeleteRecord(configKey, { id, token, userId, reason = "" }) {
  const config = getLcCollectionConfig(configKey);
  const now = new Date().toISOString();
  const payload = {
    deleted_at: now,
    deleted_by: userId || "",
    delete_reason: reason || "",
  };
  const r = await collectionPbFetch(configKey, `/api/collections/${config.name}/records/${id}`, {
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
  const r = await collectionPbFetch(configKey, `/api/collections/${config.name}/records/${id}`, {
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
  const r = await collectionPbFetch(configKey, `/api/collections/${config.name}/records/${id}`, {
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
  if (configKey === "fnConversations") {
    const body = pickAllowedFields(input || {}, getLcCollectionConfig("fnConversations").writableFields);
    return {
      owner: ownerId,
      local_id: String(body.local_id || "").trim(),
      title: String(body.title || "New Conversation").slice(0, 200),
      style: String(body.style || ""),
      ...(body.local_created_at ? { local_created_at: String(body.local_created_at) } : {}),
      ...(body.local_updated_at ? { local_updated_at: String(body.local_updated_at) } : {}),
    };
  }
  if (configKey === "fnMessages") {
    const body = pickAllowedFields(input || {}, getLcCollectionConfig("fnMessages").writableFields);
    return {
      owner: ownerId,
      local_id: String(body.local_id || "").trim(),
      conversation_local_id: String(body.conversation_local_id || "").trim(),
      role: String(body.role || "user"),
      content: clampPbMessageContent(body.content || ""),
      ...(typeof body.is_error === "boolean" ? { is_error: body.is_error } : {}),
      ...(typeof body.extracted_event_json === "string" ? { extracted_event_json: body.extracted_event_json } : {}),
      ...(typeof body.extraction_confirmed === "boolean" ? { extraction_confirmed: body.extraction_confirmed } : {}),
      ...(body.local_created_at ? { local_created_at: String(body.local_created_at) } : {}),
      ...(body.local_updated_at ? { local_updated_at: String(body.local_updated_at) } : {}),
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
  if (configKey === "fnMessages") {
    const body = pickAllowedFields(input || {}, getLcCollectionConfig("fnMessages").writableFields);
    if (typeof body.content === "string") body.content = clampPbMessageContent(body.content);
    return body;
  }
  const config = getLcCollectionConfig(configKey);
  return pickAllowedFields(input || {}, config.writableFields);
}

async function findOwnedRecordByField(configKey, { ownerId, token, field, value }) {
  const r = await pbListOwnedRecords(configKey, {
    ownerId,
    token,
    extraFilters: [buildPbFilterClause(field, "=", value)],
    perPage: 1,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(pbErrorSummary(d, "Record lookup failed"));
    err.status = r.status;
    throw err;
  }
  return (d.items || [])[0] || null;
}

async function createDomainRecord(configKey, { token, payload }) {
  const config = getLcCollectionConfig(configKey);
  const r = await collectionPbFetch(configKey, `/api/collections/${config.name}/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload || {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(pbErrorSummary(d, "Create failed"));
    err.status = r.status;
    err.details = d;
    throw err;
  }
  return d;
}

async function updateDomainRecord(configKey, { token, recordId, payload }) {
  const config = getLcCollectionConfig(configKey);
  const r = await collectionPbFetch(configKey, `/api/collections/${config.name}/records/${recordId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload || {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(pbErrorSummary(d, "Update failed"));
    err.status = r.status;
    err.details = d;
    throw err;
  }
  return d;
}

const DOMAIN_REMAP_HANDLERS = {
  lc: {
    projects: async ({ ownerId, token, sourceId, targetId }) => remapLcProjectReferences({ ownerId, token, sourceId, targetId }),
  },
};

// GET /lc/auth/methods → return available auth methods (password + oauth providers)
router.get("/lc/auth/methods", async (req, res) => {
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

// POST /fn/auth/register → create fn_owners account
router.post("/fn/auth/register", async (req, res) => {
  try {
    const body = req.body || {};
    const payload = {
      email: String(body.email || "").trim().toLowerCase(),
      password: String(body.password || ""),
      passwordConfirm: String(body.passwordConfirm || body.password || ""),
      name: String(body.name || "FurNote User").trim().slice(0, 80),
    };
    if (!payload.email || !payload.password || !payload.passwordConfirm) {
      return res.status(400).json({ error: "email, password and passwordConfirm are required" });
    }
    const r = await fnPbFetch("/api/collections/fn_owners/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(d);
    return res.status(r.status).json(d);
  } catch (err) {
    return res.status(502).json({ error: err?.message || "PocketBase unavailable" });
  }
});

// POST /fn/auth/login → auth fn_owners and set fn_token cookie
router.post("/fn/auth/login", async (req, res) => {
  try {
    const body = req.body || {};
    const payload = {
      identity: String(body.identity || body.email || "").trim(),
      password: String(body.password || ""),
    };
    if (!payload.identity || !payload.password) return res.status(400).json({ error: "identity and password are required" });
    const r = await fnPbFetch("/api/collections/fn_owners/auth-with-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(d);
    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https" || (req.headers["cf-visitor"] || "").includes("https");
    if (d?.token) {
      res.cookie("fn_token", d.token, {
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: isSecure,
        sameSite: "Lax",
        path: "/",
      });
    }
    return res.status(r.status).json(d);
  } catch (err) {
    return res.status(502).json({ error: err?.message || "PocketBase unavailable" });
  }
});

// POST /fn/auth/refresh → refresh token
router.post("/fn/auth/refresh", _requireFnAuth, async (req, res) => {
  try {
    const r = await fnPbFetch("/api/collections/fn_owners/auth-refresh", {
      method: "POST",
      headers: { Authorization: `Bearer ${req.fnToken}` },
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(d);
    if (d?.token) {
      const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https" || (req.headers["cf-visitor"] || "").includes("https");
      res.cookie("fn_token", d.token, {
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: isSecure,
        sameSite: "Lax",
        path: "/",
      });
    }
    return res.status(r.status).json(d);
  } catch (err) {
    return res.status(502).json({ error: err?.message || "PocketBase unavailable" });
  }
});

// GET /fn/auth/me → get owner profile
router.get("/fn/auth/me", _requireFnAuth, async (req, res) => {
  try {
    const uid = req.fnUser?.id;
    if (!uid || !validPbId(uid)) return res.status(401).json({ error: "Not authenticated" });
    const r = await fnPbFetch(`/api/collections/fn_owners/records/${uid}`, {
      headers: { Authorization: `Bearer ${req.fnToken}` },
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(d);
    return res.json(d);
  } catch (err) {
    return res.status(502).json({ error: err?.message || "PocketBase unavailable" });
  }
});

// GET /api/domains/:domain/schema → expose app-facing collection capabilities through LumiGate
router.get("/api/domains/:domain/schema", (req, res) => {
  const schema = getDomainApiSchema(req.params.domain);
  if (!schema) return res.status(404).json({ error: "Unknown domain" });
  res.json(schema);
});

// GET /api/domains/:domain/:collection → generic domain collection list endpoint
router.get("/api/domains/:domain/:collection", requireDomainAuth, async (req, res) => {
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
router.post("/api/domains/:domain/:collection", requireDomainAuth, async (req, res) => {
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
    if (configKey === "fnMessages") {
      if (!payload.conversation_local_id || !payload.role || !payload.content) {
        return res.status(400).json({ error: "Missing required fields: conversation_local_id, role, content" });
      }
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
router.patch("/api/domains/:domain/:collection/:id", requireDomainAuth, async (req, res) => {
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
router.delete("/api/domains/:domain/:collection/:id", requireDomainAuth, async (req, res) => {
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

    if (isLcSoftDeleteEnabled() && canSoftDelete(configKey) && !isHardDeleteRequested(req)) {
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
router.get("/api/domains/:domain/:collection/:id/references", requireDomainAuth, async (req, res) => {
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
router.post("/api/domains/:domain/:collection/:id/remap", requireDomainAuth, async (req, res) => {
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
router.post("/api/domains/:domain/trash/:collection/:id/restore", requireDomainAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid ID" });
  if (!isLcSoftDeleteEnabled()) return res.status(400).json({ error: "Soft delete is disabled" });

  const domainKey = String(req.domainKey || req.params.domain || "").toLowerCase();
  const apiCollectionName = String(req.params.collection || "");
  const resolved = resolveDomainCollectionConfig(domainKey, apiCollectionName);
  if (!resolved) return res.status(404).json({ error: "Unknown domain collection" });

  try {
    const { configKey } = resolved;
    if (!canSoftDelete(configKey)) return res.status(400).json({ error: "Soft delete not supported for this collection" });
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

function normalizeIsoDateString(input, fallback = null) {
  if (!input) return fallback;
  const d = new Date(String(input));
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString();
}

function summarizeFnHealthSignals({ records = [], reminders = [], measurements = [] } = {}) {
  const symptomCount = records.filter((r) => String(r.category || "").toLowerCase().includes("symptom")).length;
  const visitCount = records.filter((r) => String(r.category || "").toLowerCase().includes("visit")).length;
  const reminderDone = reminders.filter((r) => ["done", "completed", "complete"].includes(String(r.status || "").toLowerCase())).length;
  const reminderOpen = Math.max(0, reminders.length - reminderDone);
  const weightMeasurements = measurements.filter((m) => String(m.measurement_type || "").toLowerCase().includes("weight"));
  const latestWeight = weightMeasurements.length ? Number(weightMeasurements[weightMeasurements.length - 1].value || 0) : null;

  const riskPenalty = Math.min(35, symptomCount * 8 + reminderOpen * 2);
  const adherenceBonus = Math.min(15, reminderDone * 2);
  const scoreTotal = Math.max(0, Math.min(100, 80 - riskPenalty + adherenceBonus));
  const scoreBreakdown = {
    symptoms: Math.max(0, 100 - Math.min(100, symptomCount * 20)),
    reminders: Math.max(0, 100 - Math.min(100, reminderOpen * 12)),
    consistency: Math.max(0, Math.min(100, 50 + Math.min(30, measurements.length * 4))),
    visits: Math.max(0, Math.min(100, 60 + Math.min(20, visitCount * 5))),
  };

  const highlights = [];
  if (symptomCount > 0) highlights.push(`Detected ${symptomCount} symptom-linked records in period`);
  if (reminderDone > 0) highlights.push(`Completed ${reminderDone} reminders`);
  if (latestWeight !== null && Number.isFinite(latestWeight)) highlights.push(`Latest recorded weight: ${latestWeight}`);
  if (!highlights.length) highlights.push("No significant health events captured in this period");

  return { scoreTotal, scoreBreakdown, highlights, metrics: { symptomCount, visitCount, reminderDone, reminderOpen, measurementCount: measurements.length, latestWeight } };
}

// POST /api/fn/extractions/confirm → persist confirmed extraction into fn health records
router.post("/api/fn/extractions/confirm", _requireFnAuth, async (req, res) => {
  try {
    const ownerId = req.fnUser?.id;
    const token = req.fnToken;
    if (!ownerId || !token) return res.status(401).json({ error: "Not authenticated" });

    const body = req.body || {};
    const petLocalId = String(body.pet_local_id || body.petLocalId || "").trim();
    const category = String(body.category || "symptom").trim();
    const title = String(body.title || "Extracted Health Event").trim();
    if (!petLocalId) return res.status(400).json({ error: "pet_local_id required" });

    const payload = {
      owner: ownerId,
      local_id: String(body.local_id || crypto.randomUUID()),
      pet_local_id: petLocalId,
      reminder_local_id: String(body.reminder_local_id || ""),
      category,
      title: title.slice(0, 200),
      note: String(body.note || ""),
      outcome: String(body.outcome || "observed"),
      recorded_at: normalizeIsoDateString(body.recorded_at, new Date().toISOString()),
      local_updated_at: normalizeIsoDateString(body.local_updated_at, new Date().toISOString()),
    };
    const created = await createDomainRecord("fnHealthRecords", { token, payload });

    let linkedMessageId = null;
    const messageId = String(body.message_id || body.messageId || "").trim();
    const messageLocalId = String(body.message_local_id || body.messageLocalId || "").trim();
    const extractedEventJson = body.extracted_event_json || body.extractedEventJson || null;

    if (messageId && validPbId(messageId)) {
      try {
        const msg = await assertRecordOwned("fnMessages", { id: messageId, ownerId, token });
        linkedMessageId = msg?.id || null;
      } catch {}
    } else if (messageLocalId) {
      try {
        const msg = await findOwnedRecordByField("fnMessages", { ownerId, token, field: "local_id", value: messageLocalId });
        linkedMessageId = msg?.id || null;
      } catch {}
    }

    if (linkedMessageId) {
      const patch = { extraction_confirmed: true };
      if (extractedEventJson && typeof extractedEventJson === "string") patch.extracted_event_json = extractedEventJson;
      await updateDomainRecord("fnMessages", { token, recordId: linkedMessageId, payload: patch }).catch(() => {});
    }

    return res.json({ ok: true, record: created, linkedMessageId });
  } catch (err) {
    return res.status(Number(err?.status) || 502).json({ error: err?.message || "Extraction confirm failed" });
  }
});

function ragScoreTextFactory(query) {
  const keyword = String(query || "").split(/\s+/).map((x) => x.trim()).filter(Boolean).slice(0, 12);
  const phrase = String(query || "").slice(0, 160).toLowerCase();
  return (text) => {
    const t = String(text || "").toLowerCase();
    if (!t) return 0;
    let s = 0;
    if (phrase && t.includes(phrase)) s += 8;
    for (const k of keyword) if (k && t.includes(k.toLowerCase())) s += 1;
    return s;
  };
}

async function retrieveFnDualLayerRag({ ownerId, token, query, petLocalId = "", topK = 6, scopeMode = "project_then_shared" } = {}) {
  const mode = ["project_only", "project_then_shared", "shared_only"].includes(String(scopeMode || "")) ? String(scopeMode) : "project_then_shared";
  const includeProject = mode !== "shared_only";
  const includeShared = mode !== "project_only";
  const scoreText = ragScoreTextFactory(query);
  const chunks = [];
  let projectCandidates = 0;
  let sharedCandidates = 0;

  if (includeProject) {
    const hrFilters = [];
    if (petLocalId) hrFilters.push(buildPbFilterClause("pet_local_id", "=", petLocalId));
    const [hrResp, msgResp] = await Promise.all([
      pbListOwnedRecords("fnHealthRecords", { ownerId, token, extraFilters: hrFilters, perPage: 300, sort: ["-recorded_at"] }),
      pbListOwnedRecords("fnMessages", { ownerId, token, perPage: 300, sort: ["-local_created_at"] }),
    ]);

    const hrData = await hrResp.json().catch(() => ({}));
    const msgData = await msgResp.json().catch(() => ({}));
    if (!hrResp.ok) {
      const err = new Error(pbErrorSummary(hrData, "health_records query failed"));
      err.status = hrResp.status;
      throw err;
    }
    if (!msgResp.ok) {
      const err = new Error(pbErrorSummary(msgData, "messages query failed"));
      err.status = msgResp.status;
      throw err;
    }

    for (const r of hrData.items || []) {
      const text = [r.title, r.note, r.category, r.outcome].filter(Boolean).join(" | ");
      const score = scoreText(text);
      if (score <= 0) continue;
      projectCandidates++;
      chunks.push({
        scope: "project",
        source: "health_records",
        id: r.id,
        source_id: r.id,
        chunk_id: r.id,
        pet_local_id: r.pet_local_id || "",
        text,
        score,
        recorded_at: r.recorded_at || "",
      });
    }
    for (const m of msgData.items || []) {
      const text = String(m.content || "");
      const score = scoreText(text);
      if (score <= 0) continue;
      projectCandidates++;
      chunks.push({
        scope: "project",
        source: "chat_messages",
        id: m.id,
        source_id: m.id,
        chunk_id: m.id,
        conversation_local_id: m.conversation_local_id || "",
        text,
        score,
        recorded_at: m.local_created_at || "",
      });
    }
  }

  if (includeShared) {
    let vetResp = await fnPbFetch("/api/collections/vet_chunks/records?perPage=400&fields=id,document_id,chunk_index,chunk_text,updated", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!vetResp.ok) {
      const pbToken = await getPbAdminToken().catch(() => null);
      if (pbToken) {
        vetResp = await fnPbFetch("/api/collections/vet_chunks/records?perPage=400&fields=id,document_id,chunk_index,chunk_text,updated", {
          headers: { Authorization: pbToken.startsWith("Bearer ") ? pbToken : `Bearer ${pbToken}` },
        });
      }
    }
    const vetData = await vetResp.json().catch(() => ({}));
    if (vetResp.ok) {
      for (const c of vetData.items || []) {
        const text = String(c.chunk_text || "");
        const score = scoreText(text);
        if (score <= 0) continue;
        sharedCandidates++;
        chunks.push({
          scope: "shared",
          source: "vet_chunks",
          id: c.id,
          source_id: c.document_id || c.id,
          chunk_id: c.id,
          text,
          score,
          recorded_at: c.updated || "",
        });
      }
    }
  }

  chunks.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1; // project wins ties
    if (b.score !== a.score) return b.score - a.score;
    return String(b.recorded_at || "").localeCompare(String(a.recorded_at || ""));
  });
  const topChunks = chunks.slice(0, Math.max(1, Math.min(20, Number(topK) || 6))).map((c, idx) => ({
    rank: idx + 1,
    ...c,
    similarity: Math.max(0, Math.min(1, c.score / 16)),
  }));

  return {
    mode,
    total_candidates: chunks.length,
    project_candidates: projectCandidates,
    shared_candidates: sharedCandidates,
    chunks: topChunks,
    top_similarity: topChunks.length ? topChunks[0].similarity : 0,
  };
}

// POST /api/fn/rag/trace → save retrieval trace when rag_sessions collection is available
router.post("/api/fn/rag/trace", _requireFnAuth, async (req, res) => {
  try {
    const ownerId = req.fnUser?.id;
    const token = req.fnToken;
    if (!ownerId || !token) return res.status(401).json({ error: "Not authenticated" });
    const body = req.body || {};
    if (!String(body.query || "").trim()) return res.status(400).json({ error: "query required" });

    const payload = {
      data_owner_id: ownerId,
      pet_id: String(body.pet_id || body.petId || ""),
      query: String(body.query || ""),
      answer: String(body.answer || ""),
      llm_model: String(body.llm_model || body.model || ""),
      retrieved_chunks: Array.isArray(body.retrieved_chunks) ? body.retrieved_chunks : [],
      top_similarity: Number.isFinite(Number(body.top_similarity)) ? Number(body.top_similarity) : 0,
      tokens_used: Number.isFinite(Number(body.tokens_used)) ? Number(body.tokens_used) : 0,
    };

    try {
      const saved = await createDomainRecord("fnRagSessions", { token, payload });
      return res.json({ ok: true, persisted: true, record: saved });
    } catch (persistErr) {
      log("warn", "fn rag trace persistence unavailable", { error: persistErr.message, traceId: req.traceId, ownerId });
      return res.status(202).json({ ok: true, persisted: false, warning: "rag_sessions collection unavailable", trace: payload });
    }
  } catch (err) {
    return res.status(Number(err?.status) || 502).json({ error: err?.message || "RAG trace failed" });
  }
});

// POST /api/fn/rag/search → lightweight retrieval over owner-scoped FurNote records
router.post("/api/fn/rag/search", _requireFnAuth, async (req, res) => {
  try {
    const ownerId = req.fnUser?.id;
    const token = req.fnToken;
    if (!ownerId || !token) return res.status(401).json({ error: "Not authenticated" });

    const body = req.body || {};
    const query = String(body.query || "").trim();
    const petLocalId = String(body.pet_local_id || body.petLocalId || "").trim();
    const topK = Math.max(1, Math.min(20, Number(body.top_k || body.topK || 6)));
    if (!query) return res.status(400).json({ error: "query required" });

    const retrieval = await retrieveFnDualLayerRag({
      ownerId,
      token,
      query,
      petLocalId,
      topK,
      scopeMode: String(body.scope_mode || body.scopeMode || "project_then_shared"),
    });

    return res.json({
      ok: true,
      query,
      pet_local_id: petLocalId || null,
      mode: retrieval.mode,
      total_candidates: retrieval.total_candidates,
      project_candidates: retrieval.project_candidates,
      shared_candidates: retrieval.shared_candidates,
      chunks: retrieval.chunks,
      top_similarity: retrieval.top_similarity,
    });
  } catch (err) {
    return res.status(Number(err?.status) || 502).json({ error: err?.message || "RAG search failed" });
  }
});

// POST /api/fn/reports/generate → generate weekly/monthly report snapshot
router.post("/api/fn/reports/generate", _requireFnAuth, async (req, res) => {
  try {
    const ownerId = req.fnUser?.id;
    const token = req.fnToken;
    if (!ownerId || !token) return res.status(401).json({ error: "Not authenticated" });

    const body = req.body || {};
    const petLocalId = String(body.pet_local_id || body.petLocalId || "").trim();
    const periodType = String(body.period_type || body.periodType || "weekly").toLowerCase();
    if (!["weekly", "monthly"].includes(periodType)) return res.status(400).json({ error: "period_type must be weekly or monthly" });
    if (!petLocalId) return res.status(400).json({ error: "pet_local_id required" });

    const now = new Date();
    const endAt = normalizeIsoDateString(body.period_end, now.toISOString()) || now.toISOString();
    const fallbackStart = new Date(now.getTime() - (periodType === "monthly" ? 30 : 7) * 24 * 60 * 60 * 1000).toISOString();
    const startAt = normalizeIsoDateString(body.period_start, fallbackStart) || fallbackStart;

    const mkRangeFilters = (field) => [
      buildPbFilterClause("pet_local_id", "=", petLocalId),
      buildPbFilterClause(field, ">=", startAt),
      buildPbFilterClause(field, "<=", endAt),
    ];

    const [recordsResp, remindersResp, measurementsResp] = await Promise.all([
      pbListOwnedRecords("fnHealthRecords", { ownerId, token, extraFilters: mkRangeFilters("recorded_at"), perPage: 500 }),
      pbListOwnedRecords("fnReminders", { ownerId, token, extraFilters: mkRangeFilters("scheduled_date"), perPage: 500 }),
      pbListOwnedRecords("fnMeasurements", { ownerId, token, extraFilters: mkRangeFilters("recorded_at"), perPage: 500 }),
    ]);

    const recordsData = await recordsResp.json().catch(() => ({}));
    const remindersData = await remindersResp.json().catch(() => ({}));
    const measurementsData = await measurementsResp.json().catch(() => ({}));
    if (!recordsResp.ok) return res.status(recordsResp.status).json({ error: pbErrorSummary(recordsData, "health records query failed") });
    if (!remindersResp.ok) return res.status(remindersResp.status).json({ error: pbErrorSummary(remindersData, "reminders query failed") });
    if (!measurementsResp.ok) return res.status(measurementsResp.status).json({ error: pbErrorSummary(measurementsData, "measurements query failed") });

    const summary = summarizeFnHealthSignals({
      records: recordsData.items || [],
      reminders: remindersData.items || [],
      measurements: measurementsData.items || [],
    });
    const report = {
      owner: ownerId,
      local_id: crypto.randomUUID(),
      pet_local_id: petLocalId,
      period_type: periodType,
      period_start: startAt,
      period_end: endAt,
      score_total: summary.scoreTotal,
      score_breakdown_json: JSON.stringify(summary.scoreBreakdown),
      insights_json: JSON.stringify({ highlights: summary.highlights, metrics: summary.metrics }),
      generated_at: new Date().toISOString(),
    };

    const shouldPersist = body.persist !== false;
    if (!shouldPersist) {
      return res.json({ ok: true, persisted: false, report });
    }

    try {
      const saved = await createDomainRecord("fnReportSnapshots", { token, payload: report });
      return res.json({ ok: true, persisted: true, report: saved, computed: { highlights: summary.highlights, metrics: summary.metrics } });
    } catch (persistErr) {
      log("warn", "fn report snapshot persistence unavailable", { error: persistErr.message, traceId: req.traceId, ownerId });
      saveFnReportFallback(ownerId, report);
      return res.status(202).json({ ok: true, persisted: false, warning: "report_snapshots collection unavailable", report, computed: { highlights: summary.highlights, metrics: summary.metrics } });
    }
  } catch (err) {
    return res.status(Number(err?.status) || 502).json({ error: err?.message || "Report generation failed" });
  }
});

// GET /api/fn/reports/snapshots?pet_local_id=&period_type=&perPage=
router.get("/api/fn/reports/snapshots", _requireFnAuth, async (req, res) => {
  try {
    const ownerId = req.fnUser?.id;
    const token = req.fnToken;
    if (!ownerId || !token) return res.status(401).json({ error: "Not authenticated" });
    const perPage = req.query.perPage ? Math.max(1, Math.min(200, Number(req.query.perPage))) : 50;
    const extraFilters = [];
    if (req.query.pet_local_id) extraFilters.push(buildPbFilterClause("pet_local_id", "=", String(req.query.pet_local_id)));
    if (req.query.period_type) extraFilters.push(buildPbFilterClause("period_type", "=", String(req.query.period_type).toLowerCase()));
    const r = await pbListOwnedRecords("fnReportSnapshots", { ownerId, token, extraFilters, sort: ["-generated_at"], perPage });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 404) {
        const items = listFnReportFallback(ownerId, {
          petLocalId: String(req.query.pet_local_id || ""),
          periodType: String(req.query.period_type || ""),
          perPage,
        });
        return res.json({
          page: 1,
          perPage,
          totalItems: items.length,
          totalPages: items.length ? 1 : 0,
          items,
          persisted: false,
          source: "memory_fallback",
        });
      }
      return res.status(r.status).json(d);
    }
    return res.json({ ...(d || {}), persisted: true, source: "pocketbase" });
  } catch (err) {
    return res.status(Number(err?.status) || 502).json({ error: err?.message || "Report snapshot query failed" });
  }
});

// Server-side PKCE state store: state → { codeVerifier, provider, redirect, redirectUrl, ts }
// Avoids cookie loss on Safari/mobile during cross-domain OAuth redirect
const oauthStateStore = new Map();
setInterval(() => {
  const cutoff = Date.now() - 600_000;
  for (const [k, v] of oauthStateStore) if (v.ts < cutoff) oauthStateStore.delete(k);
}, 120_000);

const FN_REPORT_FALLBACK_LIMIT = Math.max(10, Number(process.env.FN_REPORT_FALLBACK_LIMIT || 200));
const fnReportSnapshotFallbackStore = new Map(); // ownerId -> [{...report}]

function saveFnReportFallback(ownerId, report) {
  const key = String(ownerId || "");
  if (!key || !report) return;
  const list = fnReportSnapshotFallbackStore.get(key) || [];
  list.unshift({ ...report, _fallback: true });
  if (list.length > FN_REPORT_FALLBACK_LIMIT) list.splice(FN_REPORT_FALLBACK_LIMIT);
  fnReportSnapshotFallbackStore.set(key, list);
}

function listFnReportFallback(ownerId, { petLocalId = "", periodType = "", perPage = 50 } = {}) {
  const key = String(ownerId || "");
  const list = (fnReportSnapshotFallbackStore.get(key) || []).filter((r) => {
    if (petLocalId && String(r.pet_local_id || "") !== String(petLocalId)) return false;
    if (periodType && String(r.period_type || "").toLowerCase() !== String(periodType).toLowerCase()) return false;
    return true;
  });
  return list.slice(0, Math.max(1, Math.min(200, Number(perPage) || 50)));
}

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
router.get("/lc/auth/oauth-start", lcAuthLimiter, async (req, res) => {
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
router.get("/lc/auth/oauth-callback", async (req, res) => {
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
router.post("/lc/auth/check-email", lcAuthLimiter, async (req, res) => {
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
router.post("/lc/auth/register", lcAuthLimiter, lcRegisterLimiter, async (req, res) => {
  // Global hourly registration cap
  if (_getGlobalRegCount() >= 20) return res.status(429).json({ error: "Too many registrations, try again later" });
  try {
    const r = await lcPbFetch("/api/collections/users/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    if (r.ok && data.id) _setGlobalRegCount(_getGlobalRegCount() + 1);
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

router.get("/lc/admin/approve", lcAuthLimiter, async (req, res) => {
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

router.post("/lc/admin/approve", express.json(), lcAuthLimiter, async (req, res) => {
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
router.post("/lc/auth/login", lcAuthLimiter, async (req, res) => {
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
router.post("/lc/auth/logout", (req, res) => {
  res.clearCookie("lc_token", { path: "/" });
  res.json({ ok: true });
});

// POST /lc/auth/refresh → call PB auth-refresh to extend session while user is active
router.post("/lc/auth/refresh", requireLcAuth, async (req, res) => {
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
router.get("/lc/auth/me", requireLcAuth, async (req, res) => {
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

// GET /lc/crypto/public-key → public key for encrypted upload extension
router.get("/lc/crypto/public-key", requireLcAuth, async (req, res) => {
  res.json({
    alg: "RSA-OAEP-256",
    kid: LC_RSA_KEY_ID,
    spki: LC_RSA_PUBLIC_SPKI_B64,
  });
});

// PATCH /lc/auth/profile → update display name + avatar
router.patch("/lc/auth/profile", requireLcAuth, lcUpload.single("avatar"), async (req, res) => {
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
router.post("/lc/auth/change-password", requireLcAuth, async (req, res) => {
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
router.get("/lc/providers", requireLcAuth, (req, res) => {
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
router.get("/lc/models/:provider", requireLcAuth, (req, res) => {
  const name = req.params.provider.toLowerCase();
  res.json(MODELS[name] || []);
});

// ── Collector re-login for LumiChat users ─────────────────────────────────
// Trigger login, poll status, get VNC URL — no admin required
router.post("/lc/collector/login/:provider", requireLcAuth, async (req, res) => {
  const name = req.params.provider.toLowerCase();
  if (!COLLECTOR_LOGIN_SITES[name]) return res.status(400).json({ error: "Unsupported provider" });
  if (_getLoginState().active) return res.status(409).json({ error: `Login in progress for ${_getLoginState().provider}` });
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
    _setLoginState({ active: true, provider: name, status: 'waiting', page, ctx, label: 'LumiChat', cdpPort, cdpHost });
    // Background polling — close page immediately on login detection
    (async () => {
      for (let i = 0; i < 180; i++) { // 3 min timeout
        if (!_getLoginState().active) return;
        const cookies = await ctx.cookies([site.url]).catch(() => []);
        if (cookies.find(c => c.name === site.cookie && c.value.length > 5)) {
          const allCookies = await ctx.cookies([site.url]).catch(() => []);
          _saveCollectorCookies(name, allCookies);
          await page.close().catch(() => {});
          // Update existing account or create one (avoid duplicates)
          if (!Array.isArray(collectorTokens[name])) collectorTokens[name] = [];
          const cred = encryptValue(JSON.stringify({ cdpPort: Number(_getLoginState().cdpPort), cdpHost: _getLoginState().cdpHost }), ADMIN_SECRET);
          const existing = collectorTokens[name].find(a => a.enabled);
          if (existing) { existing.credentials = cred; }
          else { collectorTokens[name].push({ id: crypto.randomBytes(8).toString('hex'), label: 'LumiChat', credentials: cred, enabled: true }); }
          saveCollectorTokens(collectorTokens);
          setCollectorHealth(name, true);
          _setLoginState({ active: false, provider: null, status: 'success' });
          return;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      await page.close().catch(() => {});
      _setLoginState({ active: false, provider: null, status: 'timeout' });
    })();
    res.json({ status: 'waiting', provider: name });
  } catch (e) {
    _setLoginState({ active: false, provider: null, status: 'error' });
    res.status(500).json({ error: e.message });
  }
});
router.get("/lc/collector/login/status", requireLcAuth, (req, res) => {
  res.json({ active: _getLoginState().active, provider: _getLoginState().provider, status: _getLoginState().status });
});

// ── SearXNG web search ────────────────────────────────────────────────────
// GET /lc/search?q=... → query SearXNG JSON API, return top results
const SEARXNG_URL = process.env.SEARXNG_URL || "http://lumigate-searxng:8080";
router.get("/lc/search", requireLcAuth, async (req, res) => {
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
router.get("/lc/suggest", requireLcAuth, async (req, res) => {
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
router.get("/lc/user/settings", requireLcAuth, async (req, res) => {
  try {
    const record = await getOrCreateLcUserSettingsRecord(req.lcUser.id, req.lcToken);
    res.json(record);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// GET /lc/settings/ui → frontend settings schema + current values
router.get("/lc/settings/ui", requireLcAuth, async (req, res) => {
  try {
    const userSettings = await getOrCreateLcUserSettingsRecord(req.lcUser.id, req.lcToken);
    res.json({
      userSettings,
      schema: buildLcSettingsUiSchema(),
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.post("/lc/client-log", express.json({ limit: "128kb" }), (req, res) => {
  const normalizeEntries = (raw) => {
    if (raw && typeof raw === "object" && Array.isArray(raw.batch)) return raw.batch;
    if (raw && typeof raw === "object" && raw.data && Array.isArray(raw.data.items)) return raw.data.items;
    return [raw];
  };
  const sanitizeData = (payload) => {
    const src = payload && typeof payload === "object" ? payload : {};
    const safePayload = {};
    for (const [key, value] of Object.entries(src)) {
      if (value == null) continue;
      if (typeof value === "string") safePayload[key] = value.slice(0, 500);
      else if (typeof value === "number" || typeof value === "boolean") safePayload[key] = value;
      else if (Array.isArray(value)) safePayload[key] = value.slice(0, 20);
      else if (typeof value === "object") safePayload[key] = JSON.parse(JSON.stringify(value));
    }
    return safePayload;
  };
  const entries = normalizeEntries(req.body && typeof req.body === "object" ? req.body : {});
  for (const item of entries.slice(0, 30)) {
    const body = item && typeof item === "object" ? item : {};
    const level = ["debug", "info", "warn", "error"].includes(body.level) ? body.level : "info";
    const event = String(body.event || "client_event").slice(0, 120);
    log(level, event, {
      component: "lumichat-client",
      href: String(body.href || "").slice(0, 300),
      sessionId: String(body.sessionId || "").slice(0, 80),
      userId: String(body.userId || "").slice(0, 80),
      ua: String(req.headers["user-agent"] || "").slice(0, 220),
      ip: req.ip,
      data: sanitizeData(body.data),
    });
  }
  res.json({ ok: true });
});

// PATCH /lc/user/settings → update settings (upsert)
router.patch("/lc/user/settings", requireLcAuth, async (req, res) => {
  try {
    const body = pickAllowedFields(req.body, getLcCollectionConfig("userSettings").writableFields);
    const beforeSettings = await getOrCreateLcUserSettingsRecord(req.lcUser.id, req.lcToken);

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
        body: JSON.stringify({ user: req.lcUser.id, ...LC_USER_SETTINGS_DEFAULTS, ...body }),
      });
    }
    const d = await r.json();
    if (r.ok) {
      const changes = {};
      for (const [key, value] of Object.entries(body)) {
        const before = beforeSettings ? beforeSettings[key] : undefined;
        if (JSON.stringify(before) !== JSON.stringify(d[key])) {
          changes[key] = { before, after: d[key] };
        }
      }
      logParamChange("user", req.lcUser.email || req.lcUser.id, changes, {
        component: "settings",
        route: "/lc/user/settings",
        userId: req.lcUser.id,
      });
    }
    res.status(r.status).json(d);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── lc_projects ───────────────────────────────────────────────────────────
// GET /lc/projects → list user's projects
router.get("/lc/projects", requireLcAuth, async (req, res) => {
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
router.post("/lc/projects", requireLcAuth, async (req, res) => {
  try {
    const r = await createLcProjectRecord({ lcToken: req.lcToken, userId: req.lcUser.id, input: req.body || {} });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// PATCH /lc/projects/:id → update project
router.patch("/lc/projects/:id", requireLcAuth, async (req, res) => {
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
router.get("/lc/projects/:id/references", requireLcAuth, async (req, res) => {
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
router.post("/lc/projects/:id/remap", requireLcAuth, async (req, res) => {
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
router.delete("/lc/projects/:id", requireLcAuth, async (req, res) => {
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
router.get("/lc/sessions", requireLcAuth, async (req, res) => {
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
router.post("/lc/sessions", requireLcAuth, async (req, res) => {
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
router.patch("/lc/sessions/:id/title", requireLcAuth, async (req, res) => {
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
router.patch("/lc/sessions/:id/model", requireLcAuth, async (req, res) => {
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
router.delete("/lc/sessions/:id", requireLcAuth, async (req, res) => {
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
router.get("/lc/sessions/:id/messages", requireLcAuth, async (req, res) => {
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

// GET /lc/files/context?ids=id1,id2&q=query → fetch model-ready attachment contexts from PB
router.get("/lc/files/context", requireLcAuth, async (req, res) => {
  const ids = String(req.query.ids || "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => validPbId(id));
  if (!ids.length) return res.json({ ok: true, items: [] });
  const queryText = String(req.query.q || "").slice(0, 1000);
  const items = await fetchLcAttachmentContextsByIds(ids, {
    token: req.lcToken,
    ownerId: req.lcUser.id,
    queryText,
  });
  res.json({ ok: true, items });
});

// POST /lc/files/consent/:id → issue short-lived, one-time download token
router.post("/lc/files/consent/:id", requireLcAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid file ID" });
  try {
    await assertRecordOwned("files", { id: req.params.id, ownerId: req.lcUser.id, token: req.lcToken });
    const policy = getLcFileSandboxPolicy();
    if (!policy.downloadEnabled || !policy.requireConsent) {
      audit(req.lcUser.id, "lc_file_consent_bypass", req.params.id, {
        reason: "policy_disabled",
      });
      return res.json({ ok: true, downloadUrl: `/lc/files/serve/${req.params.id}` });
    }
    const token = issueLcFileConsentToken({ fileId: req.params.id, userId: req.lcUser.id });
    audit(req.lcUser.id, "lc_file_consent_issued", req.params.id, {
      expiresInSec: LC_CONSENT_TOKEN_TTL_SEC,
    });
    return res.json({
      ok: true,
      token,
      expiresInSec: LC_CONSENT_TOKEN_TTL_SEC,
      downloadUrl: `/lc/files/serve/${req.params.id}?consent_token=${encodeURIComponent(token)}`,
    });
  } catch (err) {
    return res.status(Number(err?.status) || 502).json({ error: err?.message || "Failed to issue consent token" });
  }
});

// POST /lc/messages → create message record
router.post("/lc/messages", requireLcAuth, async (req, res) => {
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
router.delete("/lc/messages/:id", requireLcAuth, async (req, res) => {
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
router.get("/lc/trash", requireLcAuth, async (req, res) => {
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
router.post("/lc/trash/:collection/:id/restore", requireLcAuth, async (req, res) => {
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
router.patch("/lc/messages/:id", requireLcAuth, async (req, res) => {
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
router.post("/lc/files", requireLcAuth, lcUpload.single("file"), async (req, res) => {
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
    const sandboxPolicy = getLcFileSandboxPolicy();
    const trusted = sandboxPolicy.trustedUsers.includes(String(req.lcUser.id || ""));
    const uploadSandboxEnabled = !!sandboxPolicy.uploadEnabled && !(sandboxPolicy.uploadTrustedBypass && trusted);
    const sandboxMode = uploadSandboxEnabled ? "full" : "trusted_bypass";
    if (uploadSandboxEnabled) {
      lcValidateSandboxUpload({
        tmpPath,
        originalName,
        mimeType,
        fileSize: req.file.size,
      });
    }
    log("info", "lc upload policy", {
      userId: req.lcUser.id,
      sessionId: session,
      name: originalName,
      mime: mimeType,
      sizeBytes: req.file.size,
      sandboxMode,
    });
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
    if (lcSupportsField("files", "security_status")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="security_status"\r\n\r\nscanned`);
    if (lcSupportsField("files", "sandbox_mode")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="sandbox_mode"\r\n\r\n${sandboxMode}`);
    if (lcSupportsField("files", "consent_required")) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="consent_required"\r\n\r\n${sandboxPolicy.requireConsent ? "1" : "0"}`);
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
    if (!r.ok) {
      fs.unlink(tmpPath, () => {}); // cleanup temp file
      return res.status(r.status).json(data);
    }
    const isolatedMeta = await persistLcIsolatedFileFromPath({
      fileId: data.id,
      sourcePath: tmpPath,
      originalName,
      mimeType,
      sizeBytes: req.file.size,
      userId: req.lcUser.id,
      sessionId: session,
      status: "ready",
      sandboxMode,
    });
    if (isolatedMeta) {
      const patchBody = {};
      if (lcSupportsField("files", "storage_ref")) patchBody.storage_ref = `isolation://files/${data.id}/blob.bin`;
      if (lcSupportsField("files", "storage_sha256")) patchBody.storage_sha256 = isolatedMeta.sha256;
      if (Object.keys(patchBody).length) {
        await lcPbFetch(`/api/collections/lc_files/records/${data.id}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${req.lcToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(patchBody),
        }).catch(() => {});
      }
    }
    audit(req.lcUser.id, "lc_file_upload", data.id, {
      sessionId: session,
      sandboxMode,
      sizeBytes: req.file.size,
      mimeType,
    });
    fs.unlink(tmpPath, () => {}); // cleanup temp file
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
router.get("/lc/files/serve/:id", requireLcAuth, async (req, res) => {
  if (!validPbId(req.params.id)) return res.status(400).json({ error: "Invalid file ID" });
  try {
    const rec = await assertRecordOwned("files", { id: req.params.id, ownerId: req.lcUser.id, token: req.lcToken });
    const policy = getLcFileSandboxPolicy();
    if (policy.downloadEnabled && policy.requireConsent) {
      const consentToken = String(req.query.consent_token || "");
      const check = consumeLcFileConsentToken({ token: consentToken, fileId: req.params.id, userId: req.lcUser.id });
      if (!check.ok) {
        audit(req.lcUser.id, "lc_file_download_blocked", req.params.id, { reason: check.reason || "consent_required" });
        return res.status(428).json({ error: "Download consent required", code: "consent_required" });
      }
    }
    res.setHeader("Content-Type", rec.mime_type || "application/octet-stream");
    const safeFileName = path.basename(rec.original_name || rec.file || "download").replace(/"/g, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}"`);

    if (policy.downloadEnabled) {
      const isoMeta = readLcIsolatedMeta(req.params.id);
      const isoPath = lcFileIsolationBlobPath(req.params.id);
      if (isoMeta && fs.existsSync(isoPath)) {
        audit(req.lcUser.id, "lc_file_download", req.params.id, { source: "isolation" });
        const rs = fs.createReadStream(isoPath);
        rs.on("error", (streamErr) => {
          log("error", "lcServeFile isolated stream error", { error: streamErr.message });
          if (!res.headersSent) res.status(500).end();
          else res.end();
        });
        return rs.pipe(res);
      }
    }

    // Fallback for legacy records: stream from PB file storage.
    audit(req.lcUser.id, "lc_file_download", req.params.id, { source: "pocketbase_fallback" });
    const fileR = await lcPbFetch(`/api/files/lc_files/${rec.id}/${rec.file}`, {
      headers: { Authorization: `Bearer ${req.lcToken}` },
    });
    if (!fileR.ok) return res.status(fileR.status).json({ error: "File fetch failed" });
    const readable = Readable.fromWeb(fileR.body);
    readable.on("error", (streamErr) => {
      log("error", "lcServeFile stream error", { error: streamErr.message });
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    readable.pipe(res);
  } catch (err) {
    log("error", "lcServeFile error", { error: err.message, fileId: req.params.id });
    res.status(Number(err?.status) || 500).json({ error: err?.message || "Failed to serve file" });
  }
});

// POST /lc/files/gemini-upload/:pbFileId → upload PB file to Gemini File API
router.post("/lc/files/gemini-upload/:pbFileId", requireLcAuth, async (req, res) => {
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
router.post("/lc/chat/gemini-native", requireLcAuth, express.json({ limit: process.env.LC_CHAT_BODY_LIMIT || "256mb" }), async (req, res) => {
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

// --- Clean Chat Proxy (extracted to routes/chat.js) ---
router.use("/v1/chat", require("./chat")({
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
  selectApiKey,
  checkBudgetReset,
  PROVIDERS,
  COLLECTOR_SUPPORTED,
  getProviderAccessMode,
  hasCollectorToken,
  getCollectorCredentials,
  setCollectorHealth,
  lumigentRuntime,
  settings,
  recordUsage,
  log,
  lcPbFetch,
  lcNowIso,
  lcSupportsField,
  validPbId,
  normalizeAttachmentContextItems,
  shouldAutoContinueFinishReason,
  getContinuationPrompt,
  AUTO_CONTINUE_MAX_PASSES,
  SEARXNG_URL,
  lcUrlFetchMemory,
  LC_URL_FETCH_MEMORY_MAX_ITEMS,
  LC_URL_FETCH_MEMORY_MAX_CHARS,
  FILE_PARSER_URL,
  _collector: () => _collector,
  touchLcSession,
  clampPbMessageContent,
  getPbAdminToken,
  PB_URL,
}));

// --- LumiChat: User tier & BYOK API key management ---
router.get("/lc/user/tier", requireLcAuth, async (req, res) => {
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
router.post("/lc/upgrade-request", requireLcAuth, async (req, res) => {
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
router.get("/lc/admin/upgrade-action", async (req, res) => {
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
router.get("/admin/upgrade-requests", adminAuth, requireRole("root", "admin"), async (req, res) => {
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
router.post("/admin/upgrade-requests/:settingsId/approve", requireRole("root"), async (req, res) => {
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
router.post("/admin/upgrade-requests/:settingsId/reject", requireRole("root"), async (req, res) => {
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

router.get("/lc/user/apikeys", requireLcAuth, async (req, res) => {
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

router.post("/lc/user/apikeys", requireLcAuth, async (req, res) => {
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

router.delete("/lc/user/apikeys/:id", requireLcAuth, async (req, res) => {
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

  // === Exports for use by other parts of server.js ===
  return {
    router,
    // PB helpers
    pbFetch,
    lcPbFetch,
    fnPbFetch,
    // Validation / utility
    validPbId,
    lcNowIso,
    lcSupportsField,
    // Domain API helpers
    createDomainRecord,
    updateDomainRecord,
    findOwnedRecordByField,
    buildPbFilterClause,
    pbListOwnedRecords,
    assertRecordOwned,
    assertLcSessionOwned,
    getLcCollectionConfig,
    getDomainApiSchema,
    resolveDomainCollectionConfig,
    collectionPbFetch,
    domainPbFetch,
    buildCreatePayload,
    buildUpdatePayload,
    pickAllowedFields,
    // Attachment / extraction
    normalizeAttachmentContextItems,
    fetchLcAttachmentContextsByIds,
    buildStructuredAttachmentPayloadBlock,
    buildFinancialAnalysisPromptBlock,
    runFinancialAnalysisForAttachments,
    buildRelevantAttachmentExcerpt,
    buildAttachmentModelContext,
    formatAttachmentContextBlock,
    extractMessagePlainText,
    stripAttachmentContextBlocks,
    contentHasAttachmentContext,
    getAttachmentSearchMode,
    // Encrypted upload
    lcDecryptEncryptedPayload,
    uploadLcBufferRecord,
    LC_RSA_KEY_ID,
    LC_RSA_PUBLIC_SPKI_B64,
    describeImageBufferForModel,
    // File isolation
    readLcIsolatedMeta,
    lcFileIsolationBlobPath,
    issueLcFileConsentToken,
    consumeLcFileConsentToken,
    // RAG
    retrieveFnDualLayerRag,
    // Schema
    ensureLcSchemaExtensions,
    // Settings helpers
    getOrCreateLcUserSettingsRecord,
    normalizeLcUserSettingsRecord,
    buildLcSettingsUiSchema,
    LC_USER_SETTINGS_DEFAULTS,
    // URL fetch memory (shared state)
    lcUrlFetchMemory,
    LC_URL_FETCH_MEMORY_MAX_ITEMS,
    LC_URL_FETCH_MEMORY_MAX_CHARS,
    // File parser URL
    FILE_PARSER_URL,
  };
};
