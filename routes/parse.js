"use strict";

const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();

function sanitizeFilename(name) {
  return (name || "file").replace(/["\r\n\0]/g, "_").slice(0, 255);
}

// --- Config ---

const FILE_PARSER_URL = process.env.FILE_PARSER_URL || "http://lumigate-file-parser:3100";
const GOTENBERG_URL = process.env.GOTENBERG_URL || "http://lumigate-gotenberg:3000";
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// --- Multer (memory storage) ---

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

// --- MIME detection from extension ---

const EXT_MIME = {
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

function detectMime(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  return EXT_MIME[ext] || "application/octet-stream";
}

// --- Helpers ---

/**
 * Forward a file buffer to the file-parser microservice via multipart POST.
 * Returns the parsed JSON response.
 */
async function sendToFileParser(buffer, filename) {
  const boundary = "----LumiParse" + crypto.randomBytes(8).toString("hex");
  const safeName = sanitizeFilename(filename);
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

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`file-parser returned ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Convert a file to PDF via Gotenberg's LibreOffice endpoint.
 * Returns the PDF as a Buffer.
 */
async function convertToPdfViaGotenberg(buffer, filename) {
  const boundary = "----LumiGoten" + crypto.randomBytes(8).toString("hex");
  const safeName = sanitizeFilename(filename);
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

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gotenberg returned ${res.status}: ${text}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Strip HTML tags and decode basic entities. Returns plain text.
 */
function stripHtml(html) {
  let text = html
    // Remove script/style blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // Replace block-level elements with newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Strip remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Collapse whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

// --- Route: POST / (mounted at /v1/parse) ---

router.post("/", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No "file" field in upload' });
    }

    const filename = req.file.originalname || "unknown";
    const mime = detectMime(filename);
    const ext = path.extname(filename).toLowerCase();
    const buffer = req.file.buffer;

    let result;

    // --- Route by file type ---

    if (
      mime === "application/pdf" ||
      mime.includes("spreadsheetml") ||
      mime.includes("ms-excel") ||
      mime === "text/csv" ||
      mime.includes("wordprocessingml") ||
      mime === "application/msword"
    ) {
      // PDF, XLSX, XLS, CSV, DOCX, DOC -> file-parser microservice
      const parsed = await sendToFileParser(buffer, filename);
      if (!parsed.ok) {
        return res.status(502).json({ ok: false, error: parsed.error || "file-parser error" });
      }
      result = {
        text: parsed.text,
        pages: parsed.pages || null,
        mimeType: parsed.mimeType || mime,
      };
    } else if (mime.includes("presentationml") || ext === ".pptx") {
      // PPTX -> Gotenberg (convert to PDF) -> file-parser (parse PDF)
      const pdfBuffer = await convertToPdfViaGotenberg(buffer, filename);
      const parsed = await sendToFileParser(pdfBuffer, filename.replace(/\.pptx$/i, ".pdf"));
      if (!parsed.ok) {
        return res.status(502).json({ ok: false, error: parsed.error || "file-parser error after PPTX conversion" });
      }
      result = {
        text: parsed.text,
        pages: parsed.pages || null,
        mimeType: mime,
      };
    } else if (mime === "text/html") {
      // HTML -> strip tags, extract text (built-in)
      const html = buffer.toString("utf-8");
      result = {
        text: stripHtml(html),
        pages: null,
        mimeType: mime,
      };
    } else if (mime === "text/plain" || mime === "text/markdown") {
      // TXT, MD -> return content directly
      result = {
        text: buffer.toString("utf-8"),
        pages: null,
        mimeType: mime,
      };
    } else {
      return res.status(400).json({
        ok: false,
        error: `Unsupported file type: ${mime} (${filename})`,
        supported: ["PDF", "XLSX", "XLS", "CSV", "DOCX", "DOC", "PPTX", "HTML", "TXT", "MD"],
      });
    }

    return res.json({
      ok: true,
      text: result.text,
      filename,
      pages: result.pages,
      mimeType: result.mimeType,
    });
  } catch (err) {
    console.error("[parse] Error:", err);

    // Multer file-size error
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ ok: false, error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` });
    }

    return res.status(500).json({ ok: false, error: "File parsing failed" });
  }
});

// Multer error handler (catches errors multer throws before the route handler)
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ ok: false, error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` });
    }
    return res.status(400).json({ ok: false, error: err.message });
  }
  console.error("[parse] Unhandled error:", err);
  return res.status(500).json({ ok: false, error: "File parsing failed" });
});

module.exports = router;
