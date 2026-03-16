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

/**
 * Forward audio buffer to whisper.cpp /inference endpoint as multipart form data.
 * Returns parsed transcription result.
 */
async function forwardToWhisper(buffer, filename, contentType) {
  const boundary = "----WhisperBoundary" + crypto.randomBytes(8).toString("hex");
  const safeName = sanitizeFilename(filename);

  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, buffer, footer]);

  // Try /asr (openai-whisper-asr-webservice) then /inference (whisper.cpp native)
  const endpoint = process.env.WHISPER_ENDPOINT || "/asr";
  const res = await fetch(`${WHISPER_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(120_000), // 2 min for long audio
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`whisper.cpp returned ${res.status}: ${errText}`);
  }

  return res.json();
}

const router = Router();

// POST /transcribe  (mounted at /v1/audio → /v1/audio/transcribe)
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

    const text = (result.text || "").trim();
    return res.json({
      ok: true,
      text,
      language: result.language || null,
      duration: parseFloat(((Date.now() - start) / 1000).toFixed(2)),
    });
  } catch (err) {
    console.error("[audio] transcribe error:", err);
    return res.status(502).json({ ok: false, error: "Transcription failed" });
  }
});

// POST /transcriptions  (OpenAI-compatible: /v1/audio/transcriptions)
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

    const text = (result.text || "").trim();

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
    return res.status(502).json({ ok: false, error: "Transcription failed" });
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
