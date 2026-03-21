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
const { s2t, t2s } = require("chinese-s2t");

// Cache full stock list with English + Chinese names for search
const HKEX_STOCK_LIST_EN = "https://www1.hkexnews.hk/ncms/script/eds/activestock_sehk_e.json";
const HKEX_STOCK_LIST_ZH = "https://www1.hkexnews.hk/ncms/script/eds/activestock_sehk_c.json";
let _fullStockList = null;
let _fullStockListTime = 0;

async function getFullStockList() {
  if (_fullStockList && Date.now() - _fullStockListTime < 24 * 60 * 60 * 1000) return _fullStockList;
  const hdrs = { "User-Agent": "Mozilla/5.0", Referer: "https://www1.hkexnews.hk/search/titlesearch.xhtml" };
  const [enRes, zhRes] = await Promise.all([
    fetch(HKEX_STOCK_LIST_EN, { signal: AbortSignal.timeout(15_000), headers: hdrs }),
    fetch(HKEX_STOCK_LIST_ZH, { signal: AbortSignal.timeout(15_000), headers: hdrs }).catch(() => null),
  ]);
  if (!enRes.ok) throw new Error(`HKEX stock list: ${enRes.status}`);
  const enData = await enRes.json();
  // Build Chinese name map: code → zh name
  const zhMap = new Map();
  if (zhRes?.ok) {
    try {
      const zhData = await zhRes.json();
      for (const item of zhData) zhMap.set(item.c, item.n);
    } catch {}
  }
  // Merge: { code, name (EN), nameZh (繁体中文), id }
  _fullStockList = enData.map(item => ({
    code: item.c,
    name: item.n,
    nameZh: zhMap.get(item.c) || "",
    id: item.i,
  }));
  _fullStockListTime = Date.now();
  return _fullStockList;
}

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
        used_fallback: result.usedFallback || false,
        fallback_label: result.fallbackLabel || "",
        message: result.downloaded === 0 ? (result.usedFallback ? `No results found (tried fallback)` : `No matching filings in this date range`) : "",
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

  /**
   * GET /search?q=700 — Search HKEX stock list by code or name.
   * Returns top 10 matches. Used by LumiChat HKEX modal autocomplete.
   */
  router.get("/search", async (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    if (!q) return res.json({ ok: true, results: [] });
    try {
      const list = await getFullStockList();
      // Match by code, English name, or Chinese name
      // Search with both simplified and traditional Chinese
      const qTrad = s2t(q);
      const qSimp = t2s(q);
      const matched = list.filter(s => {
        if (s.code.includes(q)) return true;
        if (s.name.toLowerCase().includes(q)) return true;
        if (s.nameZh && (s.nameZh.includes(q) || s.nameZh.includes(qTrad) || s.nameZh.includes(qSimp))) return true;
        return false;
      });
      // Sort: exact code match first, then main board (code <= 09999), then others
      matched.sort((a, b) => {
        const aExact = a.code === q.padStart(5, "0") ? 0 : 1;
        const bExact = b.code === q.padStart(5, "0") ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        const aMain = parseInt(a.code) <= 9999 ? 0 : 1;
        const bMain = parseInt(b.code) <= 9999 ? 0 : 1;
        return aMain - bMain;
      });
      const results = matched.slice(0, 10).map(s => ({ code: s.code, name: s.name, nameZh: s.nameZh || "" }));
      return res.json({ ok: true, results });
    } catch (err) {
      return res.status(502).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = createHKEXRouter;
module.exports.getFullStockList = getFullStockList;
