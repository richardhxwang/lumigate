"use strict";

/**
 * tools/hkex-downloader.js — Download HKEX announcements for a company via Chrome CDP.
 *
 * Uses the Collector's Chrome instance (Playwright over CDP) to search
 * HKEX news for filings, download PDFs, and bundle them into a ZIP.
 *
 * Input:  { stock_code, date_from?, date_to?, doc_type? }
 * Output: { files: [{ name, url, date, type, local_path }], zip_path, zip_url }
 */

const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_PORT = process.env.CDP_PORT || 9223;
const DATA_DIR = path.join(__dirname, "..", "data", "hkex-filings");
const HKEX_SEARCH_URL = "https://www1.hkexnews.hk/search/titlesearch.xhtml";
const TIMEOUT_MS = 60_000;

// Reuse singleton CDP connection (same pattern as collector/adapters/browser.js)
let _browser = null;
let _connecting = null;

async function getCDPBrowser() {
  if (_browser) {
    try {
      // Verify connection is still alive
      _browser.contexts();
      return _browser;
    } catch {
      _browser = null;
    }
  }
  if (_connecting) return _connecting;

  _connecting = (async () => {
    const cdpUrl = `http://${CDP_HOST}:${CDP_PORT}`;
    let wsUrl = null;

    // Try /json/version to get the WebSocket URL
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(`${cdpUrl}/json/version`, {
          signal: AbortSignal.timeout(2000),
          headers: { Host: `127.0.0.1:${CDP_PORT}` },
        });
        const data = await res.json();
        wsUrl = data.webSocketDebuggerUrl;
        if (wsUrl) {
          wsUrl = wsUrl.replace("127.0.0.1", CDP_HOST).replace("localhost", CDP_HOST);
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!wsUrl) wsUrl = `ws://${CDP_HOST}:${CDP_PORT}`;

    try {
      _browser = await chromium.connectOverCDP(wsUrl);
    } catch (e) {
      _connecting = null;
      throw new Error(
        `Cannot connect to Chrome CDP at ${cdpUrl}. ` +
          `Ensure Collector Chrome is running (cd collector && node login.js start). ` +
          `Original: ${e.message}`
      );
    }

    _browser.on("disconnected", () => {
      _browser = null;
    });
    _connecting = null;
    return _browser;
  })();

  return _connecting;
}

/**
 * Map doc_type filter to HKEX category IDs.
 * HKEX uses numeric category codes in their search form.
 */
function getDocTypeFilter(docType) {
  const dt = String(docType || "all").toLowerCase();
  if (dt === "annual" || dt === "annual_report") return "annual";
  if (dt === "interim" || dt === "interim_report") return "interim";
  if (dt === "results" || dt === "financial_results") return "results";
  if (dt === "circular") return "circular";
  if (dt === "prospectus") return "prospectus";
  return "all";
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
 * Uses the system `zip` command (available in Docker containers).
 */
async function createZip(sourceDir, zipPath) {
  const files = fs.readdirSync(sourceDir).filter((f) => !f.endsWith(".zip"));
  if (files.length === 0) throw new Error("No files to archive");

  try {
    await execFileAsync("zip", ["-j", zipPath, ...files.map((f) => path.join(sourceDir, f))], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    // Fallback: if zip is not available, create a tar.gz
    const tarPath = zipPath.replace(/\.zip$/, ".tar.gz");
    await execFileAsync("tar", ["-czf", tarPath, "-C", sourceDir, ...files], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return tarPath;
  }
  return zipPath;
}

/**
 * Main download function — searches HKEX and downloads announcements.
 *
 * @param {object} input
 * @param {string} input.stock_code - e.g. "0291", "00291", "291"
 * @param {string} [input.date_from] - e.g. "2024-01-01"
 * @param {string} [input.date_to]   - e.g. "2025-03-21"
 * @param {string} [input.doc_type]  - "annual"|"interim"|"results"|"circular"|"all"
 * @returns {Promise<{ files: Array, zip_path: string, zip_url: string }>}
 */
async function downloadHKEXFilings(input) {
  const rawCode = String(input.stock_code || "").replace(/^0+/, "");
  if (!rawCode || !/^\d+$/.test(rawCode)) {
    throw new Error("Invalid stock_code: must be a numeric HKEX stock code");
  }
  // Pad to 5 digits (HKEX format)
  const stockCode = rawCode.padStart(5, "0");
  const dateFrom = input.date_from || "";
  const dateTo = input.date_to || new Date().toISOString().slice(0, 10);
  const docType = getDocTypeFilter(input.doc_type);

  // Ensure output directory
  const outputDir = path.join(DATA_DIR, stockCode);
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await getCDPBrowser();
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();

  const files = [];

  try {
    // Navigate to HKEX title search
    await page.goto(HKEX_SEARCH_URL, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT_MS,
    });

    // Wait for the search form to be ready
    await page.waitForSelector("#searchStockCode", { timeout: 15_000 }).catch(() => {});

    // Fill in the stock code
    const stockInput =
      (await page.$("#searchStockCode")) || (await page.$('input[name="stockCode"]'));
    if (stockInput) {
      await stockInput.fill("");
      await stockInput.fill(stockCode);
    } else {
      throw new Error("Could not find stock code input on HKEX search page");
    }

    // Fill date range if provided
    if (dateFrom) {
      const fromInput =
        (await page.$("#txtDateFrom")) || (await page.$('input[name="from"]'));
      if (fromInput) {
        await fromInput.fill("");
        await fromInput.fill(dateFrom.replace(/-/g, "/"));
      }
    }

    if (dateTo) {
      const toInput =
        (await page.$("#txtDateTo")) || (await page.$('input[name="to"]'));
      if (toInput) {
        await toInput.fill("");
        await toInput.fill(dateTo.replace(/-/g, "/"));
      }
    }

    // Select document type from dropdown if not "all"
    if (docType !== "all") {
      try {
        const typeSelect =
          (await page.$("#selTIERTwo")) ||
          (await page.$("select[name='tierTwo']")) ||
          (await page.$(".tier-two select"));
        if (typeSelect) {
          // Try to find and select the matching option
          const options = await typeSelect.$$("option");
          for (const opt of options) {
            const text = (await opt.textContent()).toLowerCase();
            if (text.includes(docType)) {
              const val = await opt.getAttribute("value");
              if (val) await typeSelect.selectOption(val);
              break;
            }
          }
        }
      } catch {}
    }

    // Click search button
    const searchBtn =
      (await page.$("#searchButton")) ||
      (await page.$('a[href*="search"]')) ||
      (await page.$("button.search-btn")) ||
      (await page.$("a.search-btn"));
    if (searchBtn) {
      await searchBtn.click();
    } else {
      // Fallback: press Enter in the stock code field
      if (stockInput) await stockInput.press("Enter");
    }

    // Wait for results to load
    await page
      .waitForSelector(".result-table tbody tr, .search-results tr, table.result tbody tr", {
        timeout: 20_000,
      })
      .catch(() => {});

    // Give extra time for dynamic content
    await page.waitForTimeout(2000);

    // Extract all result rows — PDF links + metadata
    const results = await page.evaluate(() => {
      const rows = [];
      // Try multiple selectors for the results table
      const selectors = [
        ".result-table tbody tr",
        "table.result tbody tr",
        ".search-results tbody tr",
        "#titleSearchResultPanel tr",
        "table tr",
      ];

      let trElements = [];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          trElements = Array.from(els);
          break;
        }
      }

      for (const tr of trElements) {
        const links = tr.querySelectorAll("a[href]");
        const tds = tr.querySelectorAll("td");
        if (tds.length < 2) continue;

        const date = tds[0]?.textContent?.trim() || "";
        const title = tds[1]?.textContent?.trim() || tds[2]?.textContent?.trim() || "";

        // Find PDF links
        for (const link of links) {
          const href = link.getAttribute("href") || "";
          if (
            href.endsWith(".pdf") ||
            href.includes("/filing_") ||
            href.includes("SEHK") ||
            href.includes("listedco")
          ) {
            let fullUrl = href;
            if (href.startsWith("/")) {
              fullUrl = "https://www1.hkexnews.hk" + href;
            } else if (!href.startsWith("http")) {
              fullUrl = "https://www1.hkexnews.hk/" + href;
            }
            rows.push({ date, title, url: fullUrl });
          }
        }
      }
      return rows;
    });

    if (results.length === 0) {
      // Try an alternative approach: look for any links containing PDF patterns
      const altResults = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*=".pdf"], a[href*="listedco"], a[href*="SEHK"]');
        return Array.from(links).map((a) => ({
          date: "",
          title: a.textContent?.trim() || a.getAttribute("title") || "",
          url: a.href || "",
        }));
      });
      results.push(...altResults);
    }

    console.log(`[hkex-downloader] Found ${results.length} results for stock ${stockCode}`);

    // Download each PDF
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r.url) continue;

      // Sanitize filename
      const dateStr = (r.date || "unknown").replace(/\//g, "-").replace(/\s/g, "");
      const titleStr = (r.title || `filing_${i + 1}`)
        .replace(/[^a-zA-Z0-9\u4e00-\u9fff_\-]/g, "_")
        .slice(0, 80);
      const ext = r.url.toLowerCase().endsWith(".pdf") ? ".pdf" : ".pdf";
      const filename = `${dateStr}_${titleStr}${ext}`;
      const destPath = path.join(outputDir, filename);

      // Skip if already downloaded
      if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
        files.push({
          name: filename,
          url: r.url,
          date: r.date,
          type: r.title,
          local_path: destPath,
          size: fs.statSync(destPath).size,
          cached: true,
        });
        continue;
      }

      try {
        const size = await downloadFile(r.url, destPath);
        files.push({
          name: filename,
          url: r.url,
          date: r.date,
          type: r.title,
          local_path: destPath,
          size,
          cached: false,
        });
        console.log(`[hkex-downloader] Downloaded: ${filename} (${(size / 1024).toFixed(1)} KB)`);
      } catch (e) {
        console.warn(`[hkex-downloader] Failed to download ${r.url}: ${e.message}`);
        files.push({
          name: filename,
          url: r.url,
          date: r.date,
          type: r.title,
          local_path: null,
          error: e.message,
        });
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  // Create ZIP if we have downloaded files
  let zipPath = null;
  let zipUrl = null;
  const downloadedFiles = files.filter((f) => f.local_path && !f.error);

  if (downloadedFiles.length > 0) {
    const zipId = crypto.randomBytes(8).toString("hex");
    const zipFilename = `hkex_${stockCode}_${zipId}.zip`;
    zipPath = path.join(outputDir, zipFilename);

    try {
      zipPath = await createZip(outputDir, zipPath);
      const ext = path.extname(zipPath);
      const actualFilename = path.basename(zipPath);
      zipUrl = `/v1/hkex/download/${actualFilename}`;
      console.log(`[hkex-downloader] Created archive: ${actualFilename}`);
    } catch (e) {
      console.warn(`[hkex-downloader] Failed to create ZIP: ${e.message}`);
    }
  }

  return {
    stock_code: stockCode,
    files,
    total: files.length,
    downloaded: downloadedFiles.length,
    zip_path: zipPath,
    zip_url: zipUrl,
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
      const result = await downloadHKEXFilings(toolInput);

      // If we have a ZIP, return it as a file download
      if (result.zip_path && fs.existsSync(result.zip_path)) {
        const zipBuffer = fs.readFileSync(result.zip_path);
        return {
          file: zipBuffer,
          filename: path.basename(result.zip_path),
          mimeType: result.zip_path.endsWith(".tar.gz")
            ? "application/gzip"
            : "application/zip",
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

      // No files downloaded — return data only
      return {
        data: {
          stock_code: result.stock_code,
          total_found: result.total,
          downloaded: result.downloaded,
          message:
            result.total === 0
              ? `No filings found for stock code ${result.stock_code}`
              : `Found ${result.total} filings but could not download any`,
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
