"use strict";

const { Router } = require("express");
const multer = require("multer");
const crypto = require("node:crypto");

const WHISPER_URL = process.env.WHISPER_URL || "http://host.docker.internal:17863";

function sanitizeFilename(name) {
  return (name || "file").replace(/["\r\n\0]/g, "_").slice(0, 255);
}

const ALLOWED_EXTENSIONS = new Set(["wav", "mp3", "m4a", "ogg", "webm", "flac"]);
const ALLOWED_MIMES = new Set([
  "audio/wav", "audio/x-wav", "audio/wave",
  "audio/mpeg", "audio/mp3",
  "audio/mp4", "audio/x-m4a", "audio/m4a",
  "audio/ogg",
  "audio/webm",
  "audio/flac", "audio/x-flac",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter(_req, file, cb) {
    const ext = (file.originalname || "").split(".").pop().toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext) || ALLOWED_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported audio format: ${file.mimetype} (.${ext}). Allowed: wav, mp3, m4a, ogg, webm, flac`));
    }
  },
});

function buildMultipartBody({ fieldName, buffer, filename, contentType }) {
  const boundary = "----WhisperBoundary" + crypto.randomBytes(8).toString("hex");
  const safeName = sanitizeFilename(filename || "audio.wav");
  const parts = [];
  // Audio file part only — language/initial_prompt go as query params for this whisper image
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${safeName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  ));
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

function normalizeEndpoint(endpoint) {
  const v = String(endpoint || "/asr").trim();
  if (!v) return "/asr";
  return v.startsWith("/") ? v : `/${v}`;
}

async function whisperRequest({ endpoint, fieldName, buffer, filename, contentType, language }) {
  const { boundary, body } = buildMultipartBody({ fieldName, buffer, filename, contentType });
  // onerahmet/openai-whisper-asr-webservice accepts language + initial_prompt as query params
  const qp = new URLSearchParams({ encode: "true", task: "transcribe", output: "json" });
  if (language) {
    qp.set("language", language);
    qp.set("initial_prompt", "以下是普通话的句子，请使用简体中文输出。");
  }
  const url = `${WHISPER_URL}${endpoint}?${qp}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(120_000), // 2 min for long audio
  });
  const raw = await res.text().catch(() => "");
  return { res, raw };
}

/**
 * Forward audio buffer to whisper service as multipart form data.
 * Auto-retries common field/endpoint mismatches.
 */
async function forwardToWhisper(buffer, filename, contentType) {
  const configuredEndpoint = normalizeEndpoint(process.env.WHISPER_ENDPOINT || "/asr");
  const configuredField = String(process.env.WHISPER_FILE_FIELD || "").trim();

  const endpointCandidates = Array.from(new Set([
    configuredEndpoint,
    "/asr",
    "/platform/audio/transcriptions",
    "/inference",
  ]));

  const attemptErrors = [];
  for (const endpoint of endpointCandidates) {
    const preferredField = configuredField || (endpoint === "/asr" ? "audio_file" : "file");
    const fieldCandidates = Array.from(new Set([preferredField, "audio_file", "file"]));
    for (const fieldName of fieldCandidates) {
      const { res, raw } = await whisperRequest({ endpoint, fieldName, buffer, filename, contentType, language: "zh" });
      if (res.ok) {
        if (!raw.trim()) return { text: "" };
        try {
          return JSON.parse(raw);
        } catch {
          return { text: raw.trim() };
        }
      }
      const errLine = `${endpoint} field=${fieldName} -> ${res.status}${raw ? `: ${raw.slice(0, 220)}` : ""}`;
      attemptErrors.push(errLine);
      // These statuses commonly mean "try another endpoint/field"
      if ([404, 405, 415, 422].includes(res.status)) continue;
      throw new Error(`Whisper request failed (${errLine})`);
    }
  }
  throw new Error(`Whisper request failed after retries: ${attemptErrors.join(" | ")}`.slice(0, 1400));
}

const router = Router();

// POST /transcribe  (mounted at /platform/audio → /platform/audio/transcribe)
router.post("/transcribe", upload.single("file"), async (req, res) => {
  const start = Date.now();
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No audio file provided. Send as multipart field 'file'." });
    }

    const result = await forwardToWhisper(
      req.file.buffer,
      req.file.originalname || "audio.wav",
      req.file.mimetype || "audio/wav"
    );

    // Whisper outputs one segment per line — collapse into single line for chat input
    const text = (result.text || "").replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
    return res.json({
      ok: true,
      text,
      language: result.language || null,
      duration: parseFloat(((Date.now() - start) / 1000).toFixed(2)),
    });
  } catch (err) {
    console.error("[audio] transcribe error:", err);
    return res.status(502).json({ ok: false, error: err?.message || "Transcription failed" });
  }
});

// POST /transcriptions  (OpenAI-compatible: /platform/audio/transcriptions)
router.post("/transcriptions", upload.single("file"), async (req, res) => {
  const start = Date.now();
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No audio file provided. Send as multipart field 'file'." });
    }

    const result = await forwardToWhisper(
      req.file.buffer,
      req.file.originalname || "audio.wav",
      req.file.mimetype || "audio/wav"
    );

    const text = (result.text || "").replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();

    // OpenAI returns { text } by default (response_format=json gives { text })
    const format = req.body?.response_format || "json";
    if (format === "text") {
      res.type("text/plain").send(text);
    } else {
      // verbose_json or json
      res.json({
        ok: true,
        text,
        language: result.language || null,
        duration: parseFloat(((Date.now() - start) / 1000).toFixed(2)),
      });
    }
  } catch (err) {
    console.error("[audio] transcriptions error:", err);
    return res.status(502).json({ ok: false, error: err?.message || "Transcription failed" });
  }
});

// Multer error handler
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ ok: false, error: "File too large. Maximum size is 25 MB." });
    }
    return res.status(400).json({ ok: false, error: err.message });
  }
  if (err) {
    console.error("[audio] unhandled error:", err);
    return res.status(400).json({ ok: false, error: "Transcription failed" });
  }
});

module.exports = router;
