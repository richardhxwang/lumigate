"use strict";

/**
 * routes/hkex.js — HKEX announcement download API endpoints.
 *
 * POST /v1/hkex/download         — Trigger download for a stock code
 * GET  /v1/hkex/download/:id     — Download a ZIP archive by filename
 * GET  /v1/hkex/filings/:code    — List cached filings for a stock code
 */

const { Router } = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { downloadHKEXFilings, DATA_DIR } = require("../tools/hkex-downloader");

function createHKEXRouter(options = {}) {
  const router = Router();
  const log = typeof options.log === "function" ? options.log : () => {};

  /**
   * POST /download — Trigger HKEX filing download.
   * Body: { stock_code, date_from?, date_to?, doc_type? }
   */
  router.post("/download", async (req, res) => {
    const { stock_code, date_from, date_to, doc_type } = req.body || {};

    if (!stock_code) {
      return res.status(400).json({ ok: false, error: "stock_code is required" });
    }

    log("info", "hkex download start", { stock_code, date_from, date_to, doc_type });
    const startTime = Date.now();

    try {
      const result = await downloadHKEXFilings({ stock_code, date_from, date_to, doc_type });
      const duration = Date.now() - startTime;

      log("info", "hkex download complete", {
        stock_code: result.stock_code,
        total: result.total,
        downloaded: result.downloaded,
        duration,
      });

      return res.json({
        ok: true,
        stock_code: result.stock_code,
        total: result.total,
        downloaded: result.downloaded,
        zip_url: result.zip_url,
        files: result.files.map((f) => ({
          name: f.name,
          url: f.url,
          date: f.date,
          type: f.type,
          size: f.size,
          cached: f.cached,
          error: f.error,
        })),
        duration,
      });
    } catch (err) {
      const duration = Date.now() - startTime;
      log("error", "hkex download failed", { stock_code, error: err.message, duration });
      return res.status(500).json({ ok: false, error: err.message, duration });
    }
  });

  /**
   * GET /download/:id — Download a ZIP/tar.gz archive by filename.
   * The :id is the archive filename (e.g. "hkex_00291_a1b2c3d4.zip").
   */
  router.get("/download/:id", (req, res) => {
    const filename = req.params.id;

    // Security: prevent directory traversal
    if (!filename || /[\/\\]/.test(filename) || filename.includes("..")) {
      return res.status(400).json({ ok: false, error: "Invalid filename" });
    }

    // Extract stock code from filename pattern: hkex_XXXXX_hash.zip
    const match = filename.match(/^hkex_(\d{5})_/);
    if (!match) {
      return res.status(400).json({ ok: false, error: "Invalid archive filename format" });
    }

    const stockCode = match[1];
    const filePath = path.join(DATA_DIR, stockCode, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: "Archive not found" });
    }

    const stat = fs.statSync(filePath);
    const isGzip = filename.endsWith(".tar.gz");
    const contentType = isGzip ? "application/gzip" : "application/zip";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader("Content-Length", stat.size);

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on("error", (err) => {
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: "Failed to read archive" });
      }
    });
  });

  /**
   * GET /filings/:code — List all cached filings for a stock code.
   */
  router.get("/filings/:code", (req, res) => {
    const rawCode = String(req.params.code || "").replace(/^0+/, "");
    if (!rawCode || !/^\d+$/.test(rawCode)) {
      return res.status(400).json({ ok: false, error: "Invalid stock code" });
    }

    const stockCode = rawCode.padStart(5, "0");
    const dir = path.join(DATA_DIR, stockCode);

    if (!fs.existsSync(dir)) {
      return res.json({ ok: true, stock_code: stockCode, files: [], total: 0 });
    }

    try {
      const entries = fs.readdirSync(dir).filter((f) => !f.startsWith("."));
      const files = entries.map((f) => {
        const stat = fs.statSync(path.join(dir, f));
        const isArchive = f.endsWith(".zip") || f.endsWith(".tar.gz");
        return {
          name: f,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          type: isArchive ? "archive" : "filing",
          download_url: isArchive
            ? `/v1/hkex/download/${f}`
            : null,
        };
      });

      return res.json({
        ok: true,
        stock_code: stockCode,
        files: files.filter((f) => f.type === "filing"),
        archives: files.filter((f) => f.type === "archive"),
        total: files.filter((f) => f.type === "filing").length,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = createHKEXRouter;
