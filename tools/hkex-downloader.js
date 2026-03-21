"use strict";

/**
 * tools/hkex-downloader.js — Download HKEX announcements via direct HTTP API.
 *
 * Uses HKEX's titleSearchServlet.do JSON API to search for filings,
 * downloads PDFs via direct HTTP, and bundles them into a ZIP.
 * No browser/Playwright dependency required.
 *
 * Input:  { stock_code, date_from?, date_to?, doc_type? }
 * Output: { files: [{ name, url, date, type, local_path }], zip_path, zip_url }
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const DATA_DIR = path.join(__dirname, "..", "data", "hkex-filings");
const HKEX_API_URL = "https://www1.hkexnews.hk/search/titleSearchServlet.do";
const HKEX_STOCK_LIST_URL = "https://www1.hkexnews.hk/ncms/script/eds/activestock_sehk_e.json";
const HKEX_BASE_URL = "https://www1.hkexnews.hk";

// Cache the stock list in memory (18k entries, ~2MB)
let _stockList = null;
let _stockListTime = 0;
const STOCK_LIST_TTL = 24 * 60 * 60 * 1000; // refresh daily

/**
 * Fetch and cache the HKEX active stock list.
 * Returns a Map of stockCode (e.g. "00291") → internal stockId (e.g. 513).
 */
async function getStockList() {
  if (_stockList && Date.now() - _stockListTime < STOCK_LIST_TTL) {
    return _stockList;
  }
  const res = await fetch(HKEX_STOCK_LIST_URL, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Referer: "https://www1.hkexnews.hk/search/titlesearch.xhtml",
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch HKEX stock list: ${res.status}`);
  const data = await res.json();
  // data is an array of { i: internalId, c: "00291", n: "CHINA RES BEER", s: sortKey }
  const map = new Map();
  for (const item of data) {
    map.set(item.c, item.i);
  }
  _stockList = map;
  _stockListTime = Date.now();
  return map;
}

/**
 * Map doc_type filter to HKEX headline category codes.
 * Returns { t1code, t2code, title } for the search API.
 */
// HKEX API category codes are unreliable — fetch all results, filter locally by title
// Primary pattern = strict match; fallback = looser match shown as alternative
const DOC_TYPE_PATTERNS = {
  annual:  { primary: /annual\s*report|年度報告|年度报告|年報(?!告)|年报(?!告)/i, fallback: /annual\s*result|全年業績|全年业绩/i, fallbackLabel: "Annual Results (业绩公告)" },
  interim: { primary: /interim\s*report|half.?year\s*report|中期報告|中期报告/i, fallback: /interim\s*result|中期業績/i, fallbackLabel: "Interim Results (中期业绩)" },
  results: { primary: /result|業績|业绩|profit|盈利|dividend/i },
  circular: { primary: /circular|通函|通告/i },
  prospectus: { primary: /prospectus|招股/i },
};

function getDocTypeFilter(docType) {
  // Always fetch everything from HKEX API — filter locally
  return { t1code: "-2", t2code: "-2", title: "", localFilter: docType };
}

/**
 * Download a single file from a URL to a local path.
 */
async function downloadFile(url, destPath) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "application/pdf,application/octet-stream,*/*",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
  return buffer.length;
}

/**
 * Create a ZIP archive from a directory of files.
 * Uses the system `zip` command (-j strips directory paths, just filenames in the zip).
 * Requires `zip` package installed (apt-get install -y zip).
 */
async function createZip(sourceDir, zipPath) {
  const files = fs.readdirSync(sourceDir).filter((f) => !f.endsWith(".zip"));
  if (files.length === 0) throw new Error("No files to archive");

  await execFileAsync("zip", ["-j", zipPath, ...files.map((f) => path.join(sourceDir, f))], {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return zipPath;
}

/**
 * Main download function — searches HKEX via direct HTTP API and downloads announcements.
 *
 * @param {object} input
 * @param {string} input.stock_code - e.g. "0291", "00291", "291"
 * @param {string} [input.date_from] - e.g. "2024-01-01"
 * @param {string} [input.date_to]   - e.g. "2025-03-21"
 * @param {string} [input.doc_type]  - "annual"|"interim"|"results"|"circular"|"all"
 * @returns {Promise<{ files: Array, zip_path: string, zip_url: string }>}
 */
async function downloadHKEXFilings(input, onProgress) {
  const emit = typeof onProgress === "function" ? onProgress : () => {};
  const rawCode = String(input.stock_code || "").replace(/^0+/, "");
  if (!rawCode || !/^\d+$/.test(rawCode)) {
    throw new Error("Invalid stock_code: must be a numeric HKEX stock code");
  }
  // Pad to 5 digits (HKEX format)
  const stockCode = rawCode.padStart(5, "0");
  const dateFrom = input.date_from ? input.date_from.replace(/-/g, "") : "";
  const dateTo = input.date_to
    ? input.date_to.replace(/-/g, "")
    : new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const docFilter = getDocTypeFilter(input.doc_type);

  // Ensure output directory
  const outputDir = path.join(DATA_DIR, stockCode);
  fs.mkdirSync(outputDir, { recursive: true });

  // Step 1: Resolve stock code to HKEX internal stockId
  emit({ text: `HKEX: Looking up stock ${stockCode}...`, icon: "file" });
  const stockList = await getStockList();
  const stockId = stockList.get(stockCode);
  if (!stockId) {
    throw new Error(
      `Stock code ${stockCode} not found in HKEX active stock list. ` +
        `It may be delisted or invalid.`
    );
  }

  // Step 2: Search via HKEX titleSearchServlet.do API
  // Default range: 3 years for annual/interim (published once a year), 12 months for others
  const isReportType = /^(annual|interim)/.test(String(docFilter.localFilter || ""));
  const effectiveDateFrom =
    dateFrom ||
    (() => {
      const d = new Date();
      if (isReportType) d.setFullYear(d.getFullYear() - 3);
      else d.setMonth(d.getMonth() - 12);
      return d.toISOString().slice(0, 10).replace(/-/g, "");
    })();

  const params = new URLSearchParams({
    sortDir: "0",
    sortByRecordCount: "100",
    category: "0",
    market: "SEHK",
    searchType: "0",
    documentType: "-1",
    t1code: docFilter.t1code,
    t2Gcode: "-2",
    t2code: docFilter.t2code,
    stockId: String(stockId),
    from: effectiveDateFrom,
    to: dateTo,
    title: docFilter.title,
    rowRange: "100",
    lang: "EN",
  });

  const searchUrl = `${HKEX_API_URL}?${params}`;
  const searchRes = await fetch(searchUrl, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Referer: "https://www1.hkexnews.hk/search/titlesearch.xhtml",
    },
  });
  if (!searchRes.ok) {
    throw new Error(`HKEX search API returned ${searchRes.status}`);
  }

  const searchData = await searchRes.json();
  let results = JSON.parse(searchData.result || "[]");

  // Local filtering by doc type (HKEX API category codes are unreliable)
  const localFilter = String(docFilter.localFilter || "all").toLowerCase();
  let usedFallback = false;
  let fallbackLabel = "";
  if (localFilter !== "all" && DOC_TYPE_PATTERNS[localFilter]) {
    const spec = DOC_TYPE_PATTERNS[localFilter];
    const textOf = r => `${r.TITLE || ""} ${r.LONG_TEXT || ""} ${r.SHORT_TEXT || ""}`;
    const before = results.length;
    // Try primary pattern first
    const primary = results.filter(r => spec.primary.test(textOf(r)));
    if (primary.length > 0) {
      results = primary;
    } else if (spec.fallback) {
      // No exact match — try fallback and flag it
      const fb = results.filter(r => spec.fallback.test(textOf(r)));
      if (fb.length > 0) {
        results = fb;
        usedFallback = true;
        fallbackLabel = spec.fallbackLabel || localFilter;
      } else {
        results = [];
      }
    } else {
      results = results.filter(r => spec.primary.test(textOf(r)));
    }
    console.log(`[hkex-downloader] Filtered ${before} → ${results.length} by doc_type=${localFilter}${usedFallback ? " (fallback)" : ""}`);
  }

  emit({ text: `HKEX: Found ${results.length} matching filings for ${stockCode}${usedFallback ? ` (${fallbackLabel})` : ""}`, icon: "file" });
  console.log(
    `[hkex-downloader] Found ${results.length} results for stock ${stockCode} (id=${stockId})`
  );

  const files = [];

  // Step 3: Download each PDF
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const fileLink = r.FILE_LINK || "";
    if (!fileLink) continue;

    const url = fileLink.startsWith("http") ? fileLink : HKEX_BASE_URL + fileLink;
    const date = (r.DATE_TIME || "").split(" ")[0] || "unknown";
    const title = (r.TITLE || `filing_${i + 1}`)
      .replace(/&#x[0-9a-fA-F]+;/g, "_") // decode HTML entities
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff_\-]/g, "_")
      .slice(0, 80);
    const dateStr = date.replace(/\//g, "-");
    const ext = fileLink.toLowerCase().endsWith(".pdf") ? ".pdf" : ".pdf";
    const filename = `${dateStr}_${title}${ext}`;
    const destPath = path.join(outputDir, filename);

    // Skip if already downloaded
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      files.push({
        name: filename,
        url,
        date,
        type: (r.LONG_TEXT || r.SHORT_TEXT || "").replace(/<br\/>/g, "").trim(),
        local_path: destPath,
        size: fs.statSync(destPath).size,
        cached: true,
      });
      continue;
    }

    try {
      emit({ text: `HKEX: Downloading ${i + 1}/${results.length}: ${title.slice(0, 40)}...`, icon: "file" });
      const size = await downloadFile(url, destPath);
      files.push({
        name: filename,
        url,
        date,
        type: (r.LONG_TEXT || r.SHORT_TEXT || "").replace(/<br\/>/g, "").trim(),
        local_path: destPath,
        size,
        cached: false,
      });
      console.log(`[hkex-downloader] Downloaded: ${filename} (${(size / 1024).toFixed(1)} KB)`);
    } catch (e) {
      console.warn(`[hkex-downloader] Failed to download ${url}: ${e.message}`);
      files.push({
        name: filename,
        url,
        date,
        type: (r.LONG_TEXT || r.SHORT_TEXT || "").replace(/<br\/>/g, "").trim(),
        local_path: null,
        error: e.message,
      });
    }
  }

  // Package results: single files → individual cards, 3+ files → ZIP
  let zipPath = null;
  let zipUrl = null;
  const downloadedFiles = files.filter((f) => f.local_path && !f.error);

  // Only create ZIP for 3+ files; fewer files get individual download cards
  if (downloadedFiles.length >= 3) {
    emit({ text: `HKEX: Packaging ${downloadedFiles.length} files into ZIP...`, icon: "file" });
    const zipId = crypto.randomBytes(8).toString("hex");
    const zipFilename = `hkex_${stockCode}_${zipId}.zip`;
    zipPath = path.join(outputDir, zipFilename);

    try {
      zipPath = await createZip(outputDir, zipPath);
      const actualFilename = path.basename(zipPath);
      zipUrl = `/v1/hkex/download/${actualFilename}`;
      console.log(`[hkex-downloader] Created archive: ${actualFilename}`);
    } catch (e) {
      console.warn(`[hkex-downloader] Failed to create ZIP: ${e.message}`);
    }
  }

  // For 1-2 files, prepare individual file buffers for direct download cards
  const individualFiles = [];
  if (downloadedFiles.length > 0 && downloadedFiles.length < 3) {
    for (const f of downloadedFiles) {
      try {
        const buf = fs.readFileSync(f.local_path);
        individualFiles.push({
          file: buf,
          filename: f.name,
          mimeType: f.name.endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
          size: buf.length,
          date: f.date,
          type: f.type,
        });
      } catch {}
    }
  }

  return {
    stock_code: stockCode,
    files,
    total: files.length,
    downloaded: downloadedFiles.length,
    zip_path: zipPath,
    zip_url: zipUrl,
    usedFallback,
    fallbackLabel,
    individualFiles,
  };
}

/**
 * Register the hkex_download tool with the UnifiedRegistry.
 * @param {import('./unified-registry').UnifiedRegistry} registry
 */
function registerHKEXTool(registry) {
  registry.registerTool(
    {
      name: "hkex_download",
      description:
        "Download HKEX (Hong Kong Stock Exchange) company announcements and filings. " +
        "Searches the HKEX news archive for a given stock code, downloads all matching PDFs, " +
        "and returns them as a ZIP archive. Supports filtering by date range and document type " +
        "(annual reports, interim reports, results announcements, circulars).",
      input_schema: {
        type: "object",
        properties: {
          stock_code: {
            type: "string",
            description:
              'HKEX stock code, e.g. "0291", "00700", "1398". Leading zeros optional.',
          },
          date_from: {
            type: "string",
            description: 'Start date in YYYY-MM-DD format, e.g. "2024-01-01". Optional.',
          },
          date_to: {
            type: "string",
            description:
              'End date in YYYY-MM-DD format, e.g. "2025-03-21". Defaults to today.',
          },
          doc_type: {
            type: "string",
            enum: ["annual", "interim", "results", "circular", "all"],
            description:
              'Document type filter. "annual" for annual reports, "interim" for interim reports, "all" for everything. Default: "all".',
          },
        },
        required: ["stock_code"],
      },
    },
    async (toolInput) => {
      const onProgress = typeof toolInput._progress_sink === "function" ? toolInput._progress_sink : () => {};
      const result = await downloadHKEXFilings(toolInput, onProgress);
      const fallbackNote = result.usedFallback
        ? `No Annual Report found. Showing ${result.fallbackLabel} instead.`
        : "";
      onProgress({ text: `HKEX: Done — ${result.downloaded} files downloaded${fallbackNote ? " (fallback)" : ""}`, icon: "file", done: true });

      // Individual files (1-2) → return each as separate download card
      if (result.individualFiles && result.individualFiles.length > 0) {
        const first = result.individualFiles[0];
        return {
          file: first.file,
          filename: first.filename,
          mimeType: first.mimeType,
          size: first.size,
          extra_files: result.individualFiles.slice(1).map(f => ({
            file: f.file,
            filename: f.filename,
            mimeType: f.mimeType,
            size: f.size,
          })),
          data: {
            stock_code: result.stock_code,
            total_found: result.total,
            downloaded: result.downloaded,
            note: fallbackNote || undefined,
          },
        };
      }

      // ZIP for 3+ files
      if (result.zip_path && fs.existsSync(result.zip_path)) {
        const zipBuffer = fs.readFileSync(result.zip_path);
        return {
          file: zipBuffer,
          filename: path.basename(result.zip_path),
          mimeType: "application/zip",
          size: zipBuffer.length,
          downloadUrl: result.zip_url,
          data: {
            stock_code: result.stock_code,
            total_found: result.total,
            downloaded: result.downloaded,
            files: result.files.map((f) => ({
              name: f.name,
              date: f.date,
              type: f.type,
              size: f.size,
              cached: f.cached,
              error: f.error,
            })),
          },
        };
      }

      // No files downloaded — return clear message for AI to relay
      let message;
      if (result.total === 0 && result.usedFallback) {
        message = `No Annual Report found for ${result.stock_code}. Also searched for Annual Results as fallback — none found either. The company may not have published reports in the searched date range.`;
      } else if (result.total === 0 && fallbackNote) {
        message = fallbackNote;
      } else if (result.total === 0) {
        message = `No matching filings found for stock code ${result.stock_code} in the searched date range. The stock code is valid — this company simply has no filings of this type in the period. Try a different document type or wider date range.`;
      } else {
        message = `Found ${result.total} filings but could not download any.`;
      }
      return {
        data: {
          stock_code: result.stock_code,
          total_found: result.total,
          downloaded: result.downloaded,
          message,
          files: result.files.map((f) => ({
            name: f.name,
            date: f.date,
            type: f.type,
            error: f.error,
          })),
        },
      };
    }
  );
}

module.exports = {
  downloadHKEXFilings,
  registerHKEXTool,
  DATA_DIR,
};
