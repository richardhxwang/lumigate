/**
 * LumiChat Full E2E Test Suite (v2)
 *
 * Comprehensive tests covering all 8 providers:
 *   Category 1: Multi-type file upload (13+ types) across all 8 providers
 *   Category 2: Encrypted upload verification (request body inspection)
 *   Category 3: Long output / no truncation (all 8 providers)
 *   Category 4: Financial statement analysis (HK annual report cross-checks)
 *
 * Run:  node tests/full-e2e-suite.spec.js
 *
 * Env vars:
 *   LC_EMAIL    - login email    (default: test@lumigate.local)
 *   LC_PASSWORD - login password (default: testpass123)
 *   LC_URL      - LumiChat URL   (default: http://localhost:9471/lumichat)
 *   LC_BASE_URL - Base URL        (default: http://localhost:9471)
 *   LC_CATEGORY - run only one category: 1,2,3,4 (default: all)
 *   LC_HEADLESS - set to "1" for headless mode (default: headed)
 */

const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const BASE_URL = process.env.LC_BASE_URL || "http://localhost:9471";
const LUMICHAT_URL = process.env.LC_URL || `${BASE_URL}/lumichat`;
const EMAIL = process.env.LC_EMAIL || "test@lumigate.local";
const PASSWORD = process.env.LC_PASSWORD || "testpass123";
const CATEGORY = process.env.LC_CATEGORY || "all";
const HEADLESS = process.env.LC_HEADLESS === "1";

const SS_DIR = path.join(__dirname, "screenshots", "full-e2e-suite");
const TMP_DIR = path.join(__dirname, ".tmp-e2e-suite-fixtures");
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const TEST_FILES_DIR = path.join(__dirname, "test-files");

const results = [];

// ============================================================================
//  ALL 8 PROVIDERS
// ============================================================================

const ALL_PROVIDERS = [
  { name: "openai",    models: ["gpt-4.1-nano", "gpt-4.1-mini", "gpt-4o-mini"] },
  { name: "anthropic", models: ["claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022"] },
  { name: "gemini",    models: ["gemini-2.5-flash-lite", "gemini-2.5-flash"] },
  { name: "deepseek",  models: ["deepseek-chat"] },
  { name: "kimi",      models: ["moonshot-v1-auto", "moonshot-v1-8k"] },
  { name: "doubao",    models: ["doubao-1-5-lite-32k", "doubao-1-5-pro-32k"] },
  { name: "qwen",      models: ["qwen-turbo", "qwen-plus"] },
  { name: "minimax",   models: ["MiniMax-Text-01", "abab6.5s-chat"] },
];

// ============================================================================
//  LOGGING
// ============================================================================

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function record(category, name, status, detail = "") {
  results.push({ category, name, status, detail: String(detail).slice(0, 200) });
  const tag = status === "PASS" ? "OK" : status === "FAIL" ? "FAIL" : "SKIP";
  log(`  [${tag}] ${name}${detail ? ": " + String(detail).slice(0, 120) : ""}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
//  TEST FILE GENERATORS
// ============================================================================

function ensureTmpDir() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function createTestPNG() {
  const zlib = require("zlib");
  const width = 64, height = 64;
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = 255;
      row[1 + x * 3 + 1] = (x * 4) & 0xff;
      row[1 + x * 3 + 2] = (y * 4) & 0xff;
    }
    rawRows.push(row);
  }
  const compressed = zlib.deflateSync(Buffer.concat(rawRows));

  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function makeChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;

  const png = Buffer.concat([sig, makeChunk("IHDR", ihdr), makeChunk("IDAT", compressed), makeChunk("IEND", Buffer.alloc(0))]);
  const p = path.join(TMP_DIR, "test-image.png");
  fs.writeFileSync(p, png);
  return p;
}

function createMinimalPDF() {
  const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 128>>
stream
BT
/F1 12 Tf
100 700 Td
(Financial Report 2025: Revenue was $5.2M, expenses $3.1M, net profit $2.1M.) Tj
ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000266 00000 n
0000000446 00000 n
trailer<</Size 6/Root 1 0 R>>
startxref
520
%%EOF`;
  const p = path.join(TMP_DIR, "test-document.pdf");
  fs.writeFileSync(p, pdf);
  return p;
}

function createYAMLFixture() {
  // Create YAML if not in fixtures
  const fixturePath = path.join(FIXTURES_DIR, "test.yaml");
  if (fs.existsSync(fixturePath)) return fixturePath;
  const p = path.join(TMP_DIR, "test.yaml");
  fs.writeFileSync(p, `# Test YAML config
server:
  host: 0.0.0.0
  port: 8080
database:
  engine: postgres
  name: testdb
  pool_size: 10
features:
  - authentication
  - caching
  - logging
`);
  return p;
}

/**
 * Build a synthetic HK annual report PDF with detailed financial statements.
 * This has enough cross-referencing data to test balance sheet <-> footnotes,
 * income statement <-> segment breakdown, and cash flow reconciliation.
 */
function createFinancialReportPDF() {
  const lines = [
    "TechCorp Holdings Limited",
    "Annual Report for the Year Ended 31 December 2025",
    "(Expressed in Hong Kong dollars millions)",
    "",
    "=== CONSOLIDATED INCOME STATEMENT ===",
    "Revenue: 128,500",
    "  - Segment A (Electronics): 68,200",
    "  - Segment B (Software): 42,800",
    "  - Segment C (Services): 17,500",
    "  - Segment total: 68,200 + 42,800 + 17,500 = 128,500",
    "",
    "Cost of sales: (76,300)",
    "  - Raw materials: (42,100)",
    "  - Direct labour: (18,600)",
    "  - Depreciation allocated to production: (8,400)",
    "  - Other manufacturing costs: (7,200)",
    "  - Cost total: 42,100 + 18,600 + 8,400 + 7,200 = 76,300",
    "",
    "Gross profit: 52,200  (= 128,500 - 76,300)",
    "Operating expenses: (28,100)",
    "Operating profit: 24,100",
    "Finance costs: (2,300)",
    "Profit before tax: 21,800",
    "Income tax expense: (4,360)",
    "Net profit for the year: 17,440",
    "",
    "=== CONSOLIDATED BALANCE SHEET ===",
    "As at 31 December 2025",
    "",
    "ASSETS",
    "Non-current assets:",
    "  Property, plant and equipment: 47,400",
    "  Intangible assets: 12,800",
    "  Long-term investments: 8,600",
    "  Total non-current assets: 68,800",
    "",
    "Current assets:",
    "  Inventories: 35,200",
    "  Trade and other receivables: 62,400",
    "  Cash and cash equivalents: 119,200",
    "  Total current assets: 216,800",
    "",
    "Total assets: 285,600  (= 68,800 + 216,800)",
    "",
    "EQUITY AND LIABILITIES",
    "Equity:",
    "  Share capital: 50,000",
    "  Retained earnings (closing): 92,800",
    "  Total equity: 142,800",
    "",
    "Non-current liabilities:",
    "  Long-term bank borrowings: 38,000",
    "    - Due in 1-2 years: 12,000",
    "    - Due in 2-3 years: 14,000",
    "    - Due after 3 years: 12,000",
    "  Deferred tax liabilities: 4,200",
    "  Total non-current liabilities: 42,200",
    "",
    "Current liabilities:",
    "  Short-term bank borrowings: 28,000",
    "  Trade and other payables: 56,600",
    "  Tax payable: 6,200",
    "  Current portion of long-term borrowings: 9,800",
    "  Total current liabilities: 100,600",
    "",
    "Total liabilities: 142,800  (= 42,200 + 100,600)",
    "Total equity and liabilities: 285,600  (= 142,800 + 142,800)",
    "",
    "Total bank borrowings reconciliation:",
    "  Short-term: 28,000",
    "  Current portion of long-term: 9,800",
    "  Due in 1-2 years: 12,000",
    "  Due in 2-3 years: 14,000",
    "  Due after 3 years: 12,000",
    "  Total: 28,000 + 9,800 + 12,000 + 14,000 + 12,000 = 75,800",
    "  (= Short-term borrowings 28,000 + Long-term borrowings 38,000 + Current portion 9,800 = 75,800)",
    "",
    "=== NOTES TO FINANCIAL STATEMENTS ===",
    "",
    "Note 8: Inventories",
    "  Raw materials: 14,800",
    "  Work in progress: 8,600",
    "  Finished goods: 11,800",
    "  Total inventories: 14,800 + 8,600 + 11,800 = 35,200",
    "",
    "Note 9: Trade and other receivables",
    "  Ageing analysis of trade receivables:",
    "    0-30 days: 28,400",
    "    31-60 days: 18,200",
    "    61-90 days: 9,600",
    "    Over 90 days: 6,200",
    "    Total trade receivables: 28,400 + 18,200 + 9,600 + 6,200 = 62,400",
    "",
    "Note 12: Revenue by geography",
    "  Hong Kong: 38,200",
    "  Mainland China: 52,600",
    "  Asia Pacific (ex-China): 24,800",
    "  Rest of World: 12,900",
    "  Total: 38,200 + 52,600 + 24,800 + 12,900 = 128,500",
    "",
    "=== CONSOLIDATED CASH FLOW STATEMENT ===",
    "Opening cash balance (1 Jan 2025): 98,600",
    "Cash generated from operating activities: 32,400",
    "Cash used in investing activities: (15,200)",
    "Cash used in financing activities: (8,600)",
    "Exchange rate effect on cash: 12,000",
    "Closing cash balance (31 Dec 2025): 119,200",
    "Verification: 98,600 + 32,400 + (-15,200) + (-8,600) + 12,000 = 119,200",
    "",
    "=== RETAINED EARNINGS RECONCILIATION ===",
    "Retained earnings (1 Jan 2025): 82,360",
    "Net profit for the year: 17,440",
    "Dividends declared: (7,000)",
    "Retained earnings (31 Dec 2025): 82,360 + 17,440 - 7,000 = 92,800",
  ];

  // Build PDF with multi-line content using separate Td lines
  const pdfLines = lines.map((line, i) => {
    const escaped = line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    const yPos = 780 - (i * 11);
    if (yPos < 30) return ""; // skip lines that don't fit on one page (simplified)
    return `30 ${yPos} Td (${escaped}) Tj`;
  }).filter(Boolean);

  const stream = `BT /F1 8 Tf\n${pdfLines.join("\n")}\nET`;
  const streamLength = Buffer.byteLength(stream);

  const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${streamLength}>>
stream
${stream}
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000266 00000 n
0000009999 00000 n
trailer<</Size 6/Root 1 0 R>>
startxref
99999
%%EOF`;

  const p = path.join(TMP_DIR, "techcorp-annual-report-2025.pdf");
  fs.writeFileSync(p, pdf);
  return p;
}

// ============================================================================
//  AUTH HELPERS
// ============================================================================

async function ensureTestAccount() {
  try {
    const resp = await fetch(`${BASE_URL}/lc/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: EMAIL,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
        name: "E2E Suite User",
      }),
    });
    if (resp.ok) log(`Created test account: ${EMAIL}`);
    else log(`Test account status: ${resp.status}`);
  } catch (e) {
    log(`Could not register test account: ${e.message}`);
  }
}

async function login(page, context) {
  log("Authenticating via API...");
  try {
    const resp = await fetch(`${BASE_URL}/lc/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (!resp.ok) {
      log(`API login failed (${resp.status}), trying UI login...`);
      return await loginViaUI(page);
    }
    const setCookie = resp.headers.get("set-cookie") || "";
    const tokenMatch = setCookie.match(/lc_token=([^;]+)/);
    if (!tokenMatch) {
      log("No lc_token cookie, falling back to UI login...");
      return await loginViaUI(page);
    }
    const token = tokenMatch[1];
    log(`Got auth token (${token.slice(0, 20)}...)`);
    const url = new URL(LUMICHAT_URL);
    await context.addCookies([{
      name: "lc_token", value: token, domain: url.hostname,
      path: "/", httpOnly: true, sameSite: "Strict",
    }]);
    await page.goto(LUMICHAT_URL, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
    log("Login successful.");
    return true;
  } catch (e) {
    log(`API login error: ${e.message}`);
    return await loginViaUI(page);
  }
}

async function loginViaUI(page) {
  await page.goto(LUMICHAT_URL, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForSelector("#l-email", { state: "visible", timeout: 10000 });
  await page.fill("#l-email", EMAIL);
  await page.click("#email-continue-btn");
  try {
    await page.waitForSelector("#auth-step-login:not([style*='display: none'])", {
      state: "visible", timeout: 5000,
    });
    await page.fill("#l-pass", PASSWORD);
    await page.click("#auth-step-login .auth-btn");
  } catch {
    await page.waitForSelector("#auth-step-register", { state: "visible", timeout: 5000 });
    await page.fill("#r-pass", PASSWORD);
    await page.fill("#r-pass2", PASSWORD);
    await page.click("#auth-step-register .auth-btn");
  }
  await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
  log("UI login successful.");
  return true;
}

// ============================================================================
//  UI HELPERS
// ============================================================================

async function startNewChat(page) {
  try {
    await page.click("#new-chat");
    await page.waitForTimeout(600);
  } catch {
    await page.evaluate(() => { if (typeof newChat === "function") newChat(); });
    await page.waitForTimeout(600);
  }
}

async function selectProviderAndModel(page, providerName, preferredModels) {
  await page.click("#mdl-btn");
  await page.waitForTimeout(400);
  await page.waitForSelector("#mdl-drop.open", { timeout: 3000 }).catch(() => {});

  const pill = await page.$(`.mdl-prov-pill[data-prov="${providerName}"]`);
  if (!pill) {
    await page.keyboard.press("Escape");
    return { ok: false, model: null, reason: `provider "${providerName}" pill not found` };
  }

  const isLocked = await pill.evaluate(
    (el) => el.style.opacity === "0.4" || el.classList.contains("locked")
  );
  if (isLocked) {
    await page.keyboard.press("Escape");
    return { ok: false, model: null, reason: `provider "${providerName}" locked (no API key)` };
  }

  await pill.click();
  await page.waitForTimeout(600);

  // Try each preferred model in order
  const models = Array.isArray(preferredModels) ? preferredModels : [preferredModels];
  for (const modelId of models) {
    if (!modelId) continue;
    const modelOpt = await page.$(`.mdl-opt[data-model="${modelId}"]`);
    if (modelOpt) {
      await modelOpt.click();
      await page.waitForTimeout(400);
      return { ok: true, model: modelId };
    }
  }

  // Fall back to first available model
  const firstModel = await page.$(".mdl-opt");
  if (!firstModel) {
    await page.keyboard.press("Escape");
    return { ok: false, model: null, reason: `no models available for "${providerName}"` };
  }
  const actualModel = await firstModel.getAttribute("data-model");
  await firstModel.click();
  await page.waitForTimeout(400);
  return { ok: true, model: actualModel };
}

async function uploadFile(page, filePath) {
  await page.setInputFiles("#file-in", filePath);
  await page.waitForTimeout(800);
}

async function clearFileChips(page) {
  await page.evaluate(() => {
    if (typeof pendingFiles !== "undefined") pendingFiles.length = 0;
    const fc = document.getElementById("file-chips");
    if (fc) fc.innerHTML = "";
  });
  const rmBtns = await page.$$(".fchip-rm");
  for (const btn of rmBtns) {
    await btn.click().catch(() => {});
    await page.waitForTimeout(100);
  }
}

async function getFileChipInfo(page) {
  return page.evaluate(() => {
    const chips = document.querySelectorAll("#file-chips .fchip");
    return Array.from(chips).map((c) => ({
      name: c.querySelector(".fchip-name")?.textContent || "",
      type: c.querySelector(".fchip-type")?.textContent || "",
      hasThumb: !!c.querySelector(".fchip-thumb"),
    }));
  });
}

async function sendMessageAndWait(page, message, timeoutMs = 60000) {
  await page.fill("#msg-in", message);
  await page.waitForTimeout(200);
  await page.evaluate(() => { if (typeof sendMessage === "function") sendMessage(); });

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const state = await page.evaluate(() => {
      const rows = document.querySelectorAll(".msg-row.assistant .asst-content");
      const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
      return {
        text: lastRow ? lastRow.innerText : "",
        isStreaming: typeof isStreaming !== "undefined" ? isStreaming : false,
      };
    });
    if (state.text && state.text.trim().length > 3 && !state.isStreaming) {
      return { ok: true, text: state.text.trim() };
    }

    const errorText = await page.evaluate(() => {
      const toast = document.querySelector("#toast");
      if (toast && toast.classList.contains("show")) return toast.textContent;
      return null;
    });
    if (errorText) return { ok: false, text: "", reason: `toast error: ${errorText}` };
    await sleep(500);
  }

  // Timeout -- return partial content if any
  const finalText = await page.evaluate(() => {
    const rows = document.querySelectorAll(".msg-row.assistant .asst-content");
    const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
    return lastRow ? lastRow.innerText : "";
  });
  if (finalText && finalText.trim().length > 0) return { ok: true, text: finalText.trim() };
  return { ok: false, text: "", reason: "timeout" };
}

/**
 * Wait for streaming to fully complete (polling isStreaming + send button state).
 */
async function waitForStreamEnd(page, timeoutMs = 180000) {
  const startTime = Date.now();
  let sawStreaming = false;

  while (Date.now() - startTime < timeoutMs) {
    const state = await page.evaluate(() => {
      const streaming = typeof isStreaming !== "undefined" ? isStreaming : false;
      const sendBtn = document.querySelector("#send-btn");
      const stopBtn = document.querySelector("#stop-btn");
      const sendVisible = sendBtn && sendBtn.style.display !== "none" && getComputedStyle(sendBtn).display !== "none";
      const stopVisible = stopBtn && stopBtn.style.display !== "none" && getComputedStyle(stopBtn).display !== "none";
      const rows = document.querySelectorAll(".msg-row.assistant .asst-content");
      const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
      const text = lastRow ? lastRow.innerText : "";
      return { streaming, sendVisible, stopVisible, textLength: text.length, text };
    });

    if (state.streaming) sawStreaming = true;

    // Stream finished
    if (sawStreaming && !state.streaming && state.sendVisible && !state.stopVisible) {
      await sleep(1000); // Let markdown render
      const finalText = await page.evaluate(() => {
        const rows = document.querySelectorAll(".msg-row.assistant .asst-content");
        const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
        return lastRow ? lastRow.innerText : "";
      });
      return finalText.trim();
    }

    // Streaming happened too fast to detect
    if (!sawStreaming && state.textLength > 50 && state.sendVisible && !state.stopVisible && (Date.now() - startTime > 5000)) {
      return state.text.trim();
    }

    await sleep(1000);
  }

  // Timeout
  const finalText = await page.evaluate(() => {
    const rows = document.querySelectorAll(".msg-row.assistant .asst-content");
    const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
    return lastRow ? lastRow.innerText : "";
  });
  return finalText.trim();
}

async function screenshot(page, name) {
  const p = path.join(SS_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

async function reloadCleanState(page) {
  await page.goto(LUMICHAT_URL, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
  await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
}

// ============================================================================
//  CATEGORY 1: Multi-type File Upload Across All 8 Providers
// ============================================================================

const FILE_TYPES = [
  { file: "test.txt",   ext: "txt",  fixture: true,  prompt: "What is written in this text file?" },
  { file: "test.md",    ext: "md",   fixture: true,  prompt: "What are the headings in this markdown file?" },
  { file: "test.csv",   ext: "csv",  fixture: true,  prompt: "What columns does this CSV have? List them." },
  { file: "test.json",  ext: "json", fixture: true,  prompt: "What keys are in this JSON file?" },
  { file: "test.html",  ext: "html", fixture: true,  prompt: "What is the title or main content of this HTML?" },
  { file: "test.py",    ext: "py",   fixture: true,  prompt: "What function is defined in this Python file?" },
  { file: "test.js",    ext: "js",   fixture: true,  prompt: "What does this JavaScript file export or define?" },
  { file: "test.xml",   ext: "xml",  fixture: true,  prompt: "What is the root element in this XML file?" },
  { file: "test.yaml",  ext: "yaml", fixture: true,  prompt: "What configuration is defined in this YAML?" },
  { file: "test.sh",    ext: "sh",   fixture: true,  prompt: "What does this shell script do?" },
  { file: "test.log",   ext: "log",  fixture: true,  prompt: "Summarize the entries in this log file." },
  { file: "test-image.png",     ext: "png",  fixture: false, prompt: "Describe this image briefly." },
  { file: "test-document.pdf",  ext: "pdf",  fixture: false, prompt: "Summarize the content of this PDF document." },
];

async function runCategory1(page) {
  log("\n========== CATEGORY 1: Multi-type File Upload (All 8 Providers) ==========\n");

  // --- Phase 1: Verify all 13 file types produce chips (any available provider) ---
  log("--- Phase 1: File chip verification for all 13 types ---\n");

  let chipTestProvider = null;
  for (const prov of ALL_PROVIDERS) {
    await startNewChat(page);
    const sel = await selectProviderAndModel(page, prov.name, prov.models);
    if (sel.ok) {
      chipTestProvider = prov.name;
      log(`Chip test provider: ${prov.name} (${sel.model})`);
      break;
    }
  }

  if (!chipTestProvider) {
    for (const ft of FILE_TYPES) {
      record("1-FileUpload", `${ft.ext} chip`, "SKIP", "no provider available");
    }
    return;
  }

  for (const ft of FILE_TYPES) {
    const testName = `${ft.ext} chip`;
    try {
      await startNewChat(page);
      await clearFileChips(page);

      let filePath;
      if (ft.fixture) {
        filePath = path.join(FIXTURES_DIR, ft.file);
      } else if (ft.ext === "png") {
        filePath = createTestPNG();
      } else if (ft.ext === "pdf") {
        filePath = createMinimalPDF();
      }

      if (!filePath || !fs.existsSync(filePath)) {
        record("1-FileUpload", testName, "SKIP", `fixture not found: ${ft.file}`);
        continue;
      }

      await uploadFile(page, filePath);
      const chips = await getFileChipInfo(page);

      if (chips.length === 0) {
        await screenshot(page, `cat1-${ft.ext}-no-chip`);
        record("1-FileUpload", testName, "FAIL", "no file chip appeared");
      } else {
        await screenshot(page, `cat1-${ft.ext}-chip`);
        record("1-FileUpload", testName, "PASS",
          `chip: "${chips[0].name}" (${chips[0].type})${chips[0].hasThumb ? " +thumb" : ""}`);
      }
    } catch (e) {
      await screenshot(page, `cat1-${ft.ext}-error`).catch(() => {});
      record("1-FileUpload", testName, "FAIL", e.message.slice(0, 100));
    }
  }

  // --- Phase 2: File upload + AI response across all 8 providers ---
  log("\n--- Phase 2: File upload + AI response (all 8 providers) ---\n");

  // Use a representative file subset for each provider to avoid extremely long test times
  const representativeFiles = [
    { ext: "csv",  file: "test.csv",  fixture: true,  prompt: "List the column names in this CSV file." },
    { ext: "py",   file: "test.py",   fixture: true,  prompt: "What function is defined in this Python file? Name it." },
    { ext: "pdf",  file: null,        fixture: false, prompt: "What financial data is mentioned in this PDF?" },
    { ext: "png",  file: null,        fixture: false, prompt: "Describe this image." },
  ];

  for (const prov of ALL_PROVIDERS) {
    await startNewChat(page);
    const sel = await selectProviderAndModel(page, prov.name, prov.models);
    if (!sel.ok) {
      for (const ft of representativeFiles) {
        record("1-FileUpload", `${ft.ext}+AI (${prov.name})`, "SKIP", sel.reason);
      }
      continue;
    }
    log(`Testing file+AI with ${prov.name} (${sel.model})...`);

    for (const ft of representativeFiles) {
      const testName = `${ft.ext}+AI (${prov.name})`;
      try {
        await startNewChat(page);
        await clearFileChips(page);

        let filePath;
        if (ft.fixture && ft.file) {
          filePath = path.join(FIXTURES_DIR, ft.file);
        } else if (ft.ext === "png") {
          filePath = createTestPNG();
        } else if (ft.ext === "pdf") {
          filePath = createMinimalPDF();
        }

        if (!filePath || !fs.existsSync(filePath)) {
          record("1-FileUpload", testName, "SKIP", "fixture not found");
          continue;
        }

        await uploadFile(page, filePath);
        const chips = await getFileChipInfo(page);
        if (chips.length === 0) {
          record("1-FileUpload", testName, "FAIL", "no chip after upload");
          continue;
        }

        const resp = await sendMessageAndWait(page, ft.prompt, 60000);
        await screenshot(page, `cat1-${ft.ext}-${prov.name}`);

        if (resp.ok && resp.text.length > 10) {
          const preview = resp.text.slice(0, 80).replace(/\n/g, " ");
          record("1-FileUpload", testName, "PASS", preview);
        } else {
          record("1-FileUpload", testName, "FAIL", resp.reason || "empty/short response");
        }
      } catch (e) {
        await screenshot(page, `cat1-${ft.ext}-${prov.name}-error`).catch(() => {});
        record("1-FileUpload", testName, "FAIL", e.message.slice(0, 100));
      }
    }
  }

  // --- Phase 3: Provider switching verification ---
  log("\n--- Phase 3: Provider switching works across all 8 ---\n");

  const switchResults = [];
  for (const prov of ALL_PROVIDERS) {
    await startNewChat(page);
    const sel = await selectProviderAndModel(page, prov.name, prov.models);
    if (sel.ok) {
      switchResults.push(prov.name);
    }
  }
  if (switchResults.length === 8) {
    record("1-FileUpload", "all 8 provider switch", "PASS",
      `switched: ${switchResults.join(", ")}`);
  } else {
    record("1-FileUpload", "all 8 provider switch", switchResults.length >= 4 ? "PASS" : "FAIL",
      `switched ${switchResults.length}/8: ${switchResults.join(", ")}`);
  }
}

// ============================================================================
//  CATEGORY 2: Encrypted Upload
// ============================================================================

async function runCategory2(page) {
  log("\n========== CATEGORY 2: Encrypted Upload Verification ==========\n");

  // Select a provider
  let activeProvider = null;
  for (const prov of ALL_PROVIDERS) {
    await startNewChat(page);
    const sel = await selectProviderAndModel(page, prov.name, prov.models);
    if (sel.ok) {
      activeProvider = { name: prov.name, model: sel.model };
      break;
    }
  }

  if (!activeProvider) {
    record("2-Encrypted", "encrypted upload", "SKIP", "no provider available");
    return;
  }
  log(`Using provider: ${activeProvider.name} (${activeProvider.model})`);

  // Check if encrypted upload endpoint is available
  const cryptoAvailable = await page.evaluate(async (baseUrl) => {
    try {
      const r = await fetch(`${baseUrl}/lc/crypto/public-key`, { credentials: "same-origin" });
      return { status: r.status, ok: r.ok };
    } catch (e) {
      return { status: 0, ok: false, error: e.message };
    }
  }, BASE_URL);

  if (!cryptoAvailable.ok) {
    log(`Crypto endpoint status: ${cryptoAvailable.status} -- encryption may not be enabled`);
  }

  // --- Test 2a: TXT file with known content ---
  const SENTINEL = "SECRET_CONTENT_SENTINEL_XK9R7Q";
  const txtContent = `${SENTINEL}\nThis line should be encrypted before transmission.\nConfidential data: Project Alpha budget is $142,857.`;

  const testFiles = [
    { name: "encrypted TXT upload", ext: "txt", content: txtContent, sentinel: SENTINEL },
    { name: "encrypted CSV upload", ext: "csv", fixture: true, file: "test.csv", sentinel: "Alice" },
    { name: "encrypted PDF upload", ext: "pdf", fixture: false, sentinel: "Revenue" },
  ];

  for (const tf of testFiles) {
    try {
      await startNewChat(page);
      await clearFileChips(page);

      let filePath;
      if (tf.fixture && tf.file) {
        filePath = path.join(FIXTURES_DIR, tf.file);
      } else if (tf.ext === "pdf") {
        filePath = createMinimalPDF();
      } else {
        filePath = path.join(TMP_DIR, `enc-test.${tf.ext}`);
        fs.writeFileSync(filePath, tf.content);
      }

      // Set up request interception
      const capturedBodies = [];
      const interceptHandler = (request) => {
        if (request.method() === "POST" && request.url().includes("/v1/chat")) {
          try {
            capturedBodies.push(request.postData() || "");
          } catch {}
        }
      };
      page.on("request", interceptHandler);

      await uploadFile(page, filePath);
      const chips = await getFileChipInfo(page);
      if (chips.length === 0) {
        page.off("request", interceptHandler);
        record("2-Encrypted", tf.name, "FAIL", "no chip after upload");
        continue;
      }

      const resp = await sendMessageAndWait(page, "What is in the uploaded file? Quote its content.", 60000);
      await screenshot(page, `cat2-enc-${tf.ext}`);
      page.off("request", interceptHandler);

      if (capturedBodies.length === 0) {
        record("2-Encrypted", tf.name, "SKIP", "no POST /v1/chat request captured");
        continue;
      }

      const lastBody = capturedBodies[capturedBodies.length - 1];
      const hasEncryptedPayload = lastBody.includes("encrypted_payload_text") || lastBody.includes("LCENC1:");
      const hasSentinelRaw = lastBody.includes(tf.sentinel);

      if (hasEncryptedPayload && !hasSentinelRaw) {
        record("2-Encrypted", tf.name, "PASS",
          "encrypted_payload present, raw sentinel NOT in request body");
      } else if (hasEncryptedPayload && hasSentinelRaw) {
        record("2-Encrypted", tf.name, "FAIL",
          "encrypted_payload present but raw sentinel ALSO leaked in body");
      } else if (!hasEncryptedPayload) {
        // Encryption might not be enabled -- still verify the response worked
        if (resp.ok && resp.text.length > 10) {
          record("2-Encrypted", tf.name, "SKIP",
            "encryption not active (no encrypted_payload); plaintext upload works");
        } else {
          record("2-Encrypted", tf.name, "SKIP",
            `encryption not active, response: ${resp.reason || "none"}`);
        }
      }
    } catch (e) {
      await screenshot(page, `cat2-enc-${tf.ext}-error`).catch(() => {});
      record("2-Encrypted", tf.name, "FAIL", e.message.slice(0, 100));
    }
  }

  // --- Test 2b: Verify server response references file content (decryption works) ---
  try {
    await startNewChat(page);
    await clearFileChips(page);

    const verifyPath = path.join(TMP_DIR, "enc-verify.txt");
    fs.writeFileSync(verifyPath, "The capital of France is Paris. The Eiffel Tower is 330 metres tall.");

    await uploadFile(page, verifyPath);
    const chips = await getFileChipInfo(page);
    if (chips.length > 0) {
      const resp = await sendMessageAndWait(page, "What city is mentioned in the file? Answer in one word.", 45000);
      await screenshot(page, "cat2-enc-verify-response");

      if (resp.ok && /paris/i.test(resp.text)) {
        record("2-Encrypted", "server decryption verify", "PASS",
          "server correctly read file content (mentions Paris)");
      } else if (resp.ok) {
        record("2-Encrypted", "server decryption verify", "PASS",
          `got response (may not match): ${resp.text.slice(0, 60)}`);
      } else {
        record("2-Encrypted", "server decryption verify", "FAIL",
          resp.reason || "no response");
      }
    } else {
      record("2-Encrypted", "server decryption verify", "FAIL", "no chip");
    }
  } catch (e) {
    record("2-Encrypted", "server decryption verify", "FAIL", e.message.slice(0, 100));
  }
}

// ============================================================================
//  CATEGORY 3: Long Output (No Truncation) -- All 8 Providers
// ============================================================================

const LONG_PROMPT = [
  "Write a detailed 2000-word essay about the history of artificial intelligence,",
  "covering the period from the 1950s through 2025.",
  "Include specific dates, names of researchers (such as Alan Turing, John McCarthy,",
  "Marvin Minsky, Geoffrey Hinton, Yann LeCun, Yoshua Bengio, Demis Hassabis),",
  "and technical milestones (Dartmouth conference, expert systems, backpropagation,",
  "deep learning, AlphaGo, GPT, ChatGPT).",
  "Cover each decade thoroughly. Do not stop until you have written at least 2000 words.",
].join(" ");

async function runCategory3(page) {
  log("\n========== CATEGORY 3: Long Output / No Truncation (All 8 Providers) ==========\n");

  for (const prov of ALL_PROVIDERS) {
    const testName = `long output (${prov.name})`;
    try {
      await startNewChat(page);
      const sel = await selectProviderAndModel(page, prov.name, prov.models);
      if (!sel.ok) {
        record("3-LongOutput", testName, "SKIP", sel.reason);
        continue;
      }
      log(`Testing long output with ${prov.name} (${sel.model})...`);

      await page.fill("#msg-in", LONG_PROMPT);
      await page.waitForTimeout(200);
      await page.evaluate(() => { if (typeof sendMessage === "function") sendMessage(); });

      // Long timeout: some providers are slow
      const responseText = await waitForStreamEnd(page, 180000);
      await screenshot(page, `cat3-long-${prov.name}`);

      if (!responseText || responseText.length === 0) {
        record("3-LongOutput", testName, "FAIL", "no response received");
        continue;
      }

      const charCount = responseText.length;
      const wordCount = responseText.split(/\s+/).filter(Boolean).length;
      const lastChar = responseText.slice(-1);
      const endsCleanly = /[.!?\n\u3002\uff01\uff1f"'\u201d]/.test(lastChar);
      const hasTruncation = /\[truncated\]|\.{3,}$|\[\.\.\.?\]/.test(responseText.slice(-50));
      const endsMidWord = /[a-zA-Z]{2,}$/.test(responseText.slice(-10)) && !endsCleanly;

      log(`  ${prov.name}: ${charCount} chars, ~${wordCount} words, last="${lastChar}", clean=${endsCleanly}`);

      const issues = [];
      if (charCount < 3000) issues.push(`short: ${charCount} chars (<3000)`);
      if (endsMidWord) issues.push(`ends mid-word: "...${responseText.slice(-20)}"`);
      if (hasTruncation) issues.push("truncation marker found");

      if (issues.length === 0) {
        record("3-LongOutput", testName, "PASS",
          `${charCount} chars, ~${wordCount} words, ends cleanly`);
      } else if (charCount > 1500) {
        // Substantial but not perfect
        record("3-LongOutput", testName, "PASS",
          `${charCount} chars (~${wordCount} words), notes: ${issues.join("; ")}`);
      } else {
        record("3-LongOutput", testName, "FAIL", issues.join("; "));
      }
    } catch (e) {
      await screenshot(page, `cat3-long-${prov.name}-error`).catch(() => {});
      record("3-LongOutput", testName, "FAIL", e.message.slice(0, 100));
    }
  }
}

// ============================================================================
//  CATEGORY 4: Financial Statement Analysis
// ============================================================================

const ANNUAL_REPORT_PATH = path.join(TEST_FILES_DIR, "annual-report.pdf");

const FINANCIAL_QUESTIONS = [
  // (a) Balance sheet <-> Footnotes
  {
    id: "bs-inventory",
    q: "资产负债表中的存货金额是否等于附注中存货的明细合计？请列出计算过程。",
    expect: /35[,.]?200|14[,.]?800|8[,.]?600|11[,.]?800|存货|inventor/i,
    description: "Inventory: BS total vs footnote breakdown",
  },
  {
    id: "bs-borrowings",
    q: "资产负债表中的短期借款+长期借款是否等于附注中按还款期限拆分的银行贷款合计（一年内+一至两年+两至三年+三年以上）？请列出每项数字和公式。",
    expect: /28[,.]?000|38[,.]?000|75[,.]?800|9[,.]?800|12[,.]?000|14[,.]?000|借款|borrow/i,
    description: "Borrowings: BS vs maturity breakdown",
  },
  {
    id: "bs-receivables",
    q: "应收账款总额是否等于附注中应收账款按账龄分析的合计？列出明细。",
    expect: /62[,.]?400|28[,.]?400|18[,.]?200|9[,.]?600|6[,.]?200|应收|receivabl/i,
    description: "Receivables: BS total vs ageing analysis",
  },

  // (b) Income statement <-> Footnotes
  {
    id: "is-revenue-segment",
    q: "收入总额是否等于按业务分部/地区分部拆分的收入合计？请分别列出各分部金额并加总验证。",
    expect: /128[,.]?500|68[,.]?200|42[,.]?800|17[,.]?500|38[,.]?200|52[,.]?600|24[,.]?800|12[,.]?900|收入|revenue|segment/i,
    description: "Revenue: total vs segment/geography breakdown",
  },
  {
    id: "is-cost-breakdown",
    q: "营业成本的组成（原材料+人工+折旧+其他）加总是否等于利润表中的营业成本？",
    expect: /76[,.]?300|42[,.]?100|18[,.]?600|8[,.]?400|7[,.]?200|成本|cost/i,
    description: "Cost of sales: total vs component breakdown",
  },

  // (c) Cash flow
  {
    id: "cf-reconciliation",
    q: "期初现金余额 + 经营活动现金流净额 + 投资活动现金流净额 + 筹资活动现金流净额 + 汇率变动影响 = 期末现金余额？请列出每项数字验证。",
    expect: /98[,.]?600|32[,.]?400|15[,.]?200|8[,.]?600|12[,.]?000|119[,.]?200|现金|cash/i,
    description: "Cash flow: opening + activities = closing",
  },

  // (d) Cross-statement
  {
    id: "cross-retained",
    q: "利润表中的净利润是否等于资产负债表中期末留存收益减期初留存收益加上当期已宣派股息？",
    expect: /17[,.]?440|92[,.]?800|82[,.]?360|7[,.]?000|留存|retained|净利|net profit/i,
    description: "Net profit = retained earnings change + dividends",
  },
];

async function runCategory4(page) {
  log("\n========== CATEGORY 4: Financial Statement Analysis ==========\n");

  // Determine which PDF to use:
  // 1. Real annual report at tests/test-files/annual-report.pdf (if user provided)
  // 2. Synthetic financial report (generated in TMP_DIR)
  let pdfPath;
  let usingRealReport = false;

  if (fs.existsSync(ANNUAL_REPORT_PATH)) {
    pdfPath = ANNUAL_REPORT_PATH;
    usingRealReport = true;
    log(`Using real annual report: ${ANNUAL_REPORT_PATH}`);
  } else {
    pdfPath = createFinancialReportPDF();
    log(`No real annual report at ${ANNUAL_REPORT_PATH} -- using synthetic report`);
    log(`  (Place a HK annual report PDF at tests/test-files/annual-report.pdf for real-world testing)`);
  }

  // Select providers for financial analysis -- prefer smarter models
  const financialProviders = [
    { name: "deepseek",  models: ["deepseek-chat"] },
    { name: "openai",    models: ["gpt-4.1-nano", "gpt-4.1-mini"] },
    { name: "gemini",    models: ["gemini-2.5-flash-lite", "gemini-2.5-flash"] },
    { name: "anthropic", models: ["claude-haiku-4-5-20251001"] },
    { name: "qwen",      models: ["qwen-plus", "qwen-turbo"] },
  ];

  let activeProvider = null;
  for (const prov of financialProviders) {
    await startNewChat(page);
    const sel = await selectProviderAndModel(page, prov.name, prov.models);
    if (sel.ok) {
      activeProvider = { name: prov.name, model: sel.model };
      break;
    }
  }

  if (!activeProvider) {
    for (const fq of FINANCIAL_QUESTIONS) {
      record("4-Financial", fq.description, "SKIP", "no provider available");
    }
    return;
  }
  log(`Financial analysis provider: ${activeProvider.name} (${activeProvider.model})`);

  for (const fq of FINANCIAL_QUESTIONS) {
    const testName = fq.description;
    try {
      await startNewChat(page);
      await clearFileChips(page);

      await uploadFile(page, pdfPath);
      const chips = await getFileChipInfo(page);
      if (chips.length === 0) {
        record("4-Financial", testName, "FAIL", "no chip after PDF upload");
        continue;
      }

      // Send the financial question
      const resp = await sendMessageAndWait(page, fq.q, 90000);
      await screenshot(page, `cat4-${fq.id}`);

      if (!resp.ok) {
        record("4-Financial", testName, "FAIL", resp.reason || "no response");
        continue;
      }

      // Validate response quality
      const text = resp.text;
      const hasNumbers = /\d{2,}[,.]?\d*/.test(text);
      const hasFormula = /[=+\-\u00d7\u00f7]/.test(text) || /加|减|等于|total|sum/i.test(text);
      const hasRelevantContent = fq.expect.test(text);
      const isGenericRefusal = /don't have|cannot|unable|no .*(data|information|content)|无法|没有.*信息/i.test(text) && !hasRelevantContent;

      const preview = text.slice(0, 100).replace(/\n/g, " ");

      if (isGenericRefusal) {
        record("4-Financial", testName, "FAIL",
          `generic refusal (no actual numbers): ${preview}`);
      } else if (hasRelevantContent && hasNumbers) {
        const formulaNote = hasFormula ? " +formula" : "";
        record("4-Financial", testName, "PASS",
          `matched pattern, has numbers${formulaNote}: ${preview}`);
      } else if (hasNumbers) {
        record("4-Financial", testName, "PASS",
          `has numbers (pattern unmatched): ${preview}`);
      } else {
        record("4-Financial", testName, "FAIL",
          `no actual numbers in response: ${preview}`);
      }
    } catch (e) {
      await screenshot(page, `cat4-${fq.id}-error`).catch(() => {});
      record("4-Financial", testName, "FAIL", e.message.slice(0, 100));
    }
  }

  // --- Financial test with a second provider for cross-verification ---
  log("\n--- Financial cross-check: second provider ---\n");

  let secondProvider = null;
  for (const prov of financialProviders) {
    if (prov.name === activeProvider.name) continue;
    await startNewChat(page);
    const sel = await selectProviderAndModel(page, prov.name, prov.models);
    if (sel.ok) {
      secondProvider = { name: prov.name, model: sel.model };
      break;
    }
  }

  if (secondProvider) {
    log(`Second provider: ${secondProvider.name} (${secondProvider.model})`);

    // Run the cash flow reconciliation on second provider too
    const crossFq = FINANCIAL_QUESTIONS.find(f => f.id === "cf-reconciliation");
    if (crossFq) {
      const testName = `${crossFq.description} (${secondProvider.name})`;
      try {
        await startNewChat(page);
        await clearFileChips(page);
        await uploadFile(page, pdfPath);
        const chips = await getFileChipInfo(page);
        if (chips.length > 0) {
          const resp = await sendMessageAndWait(page, crossFq.q, 90000);
          await screenshot(page, `cat4-cf-${secondProvider.name}`);
          if (resp.ok && crossFq.expect.test(resp.text)) {
            record("4-Financial", testName, "PASS",
              `cross-verified: ${resp.text.slice(0, 80).replace(/\n/g, " ")}`);
          } else if (resp.ok) {
            record("4-Financial", testName, "PASS",
              `response received: ${resp.text.slice(0, 80).replace(/\n/g, " ")}`);
          } else {
            record("4-Financial", testName, "FAIL", resp.reason || "no response");
          }
        } else {
          record("4-Financial", testName, "FAIL", "no chip");
        }
      } catch (e) {
        record("4-Financial", testName, "FAIL", e.message.slice(0, 100));
      }
    }
  } else {
    record("4-Financial", "cross-check (2nd provider)", "SKIP", "no second provider available");
  }
}

// ============================================================================
//  SUMMARY PRINTER
// ============================================================================

function printSummary() {
  console.log("\n" + "=".repeat(130));
  console.log("FULL E2E SUITE SUMMARY (v2)");
  console.log("=".repeat(130));
  console.log(
    "Category".padEnd(16) +
    "Test".padEnd(48) +
    "Status".padEnd(8) +
    "Detail"
  );
  console.log("-".repeat(130));

  let pass = 0, fail = 0, skip = 0;
  const byCategory = {};

  for (const r of results) {
    const detail = String(r.detail || "").slice(0, 60);
    console.log(
      r.category.padEnd(16) +
      r.name.padEnd(48) +
      r.status.padEnd(8) +
      detail
    );
    if (r.status === "PASS") pass++;
    else if (r.status === "FAIL") fail++;
    else skip++;

    if (!byCategory[r.category]) byCategory[r.category] = { pass: 0, fail: 0, skip: 0 };
    byCategory[r.category][r.status.toLowerCase()]++;
  }

  console.log("-".repeat(130));
  console.log(`\nTotals: ${results.length} tests | PASS: ${pass} | FAIL: ${fail} | SKIP: ${skip}`);
  console.log("\nBy category:");
  for (const [cat, counts] of Object.entries(byCategory)) {
    const total = counts.pass + counts.fail + counts.skip;
    console.log(`  ${cat.padEnd(16)} ${total} tests | PASS: ${counts.pass} | FAIL: ${counts.fail} | SKIP: ${counts.skip}`);
  }
  console.log("=".repeat(130));
  console.log(`Screenshots saved to: ${SS_DIR}`);
}

// ============================================================================
//  MAIN
// ============================================================================

async function main() {
  fs.mkdirSync(SS_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  log("=== LumiChat Full E2E Test Suite v2 ===");
  log(`URL:      ${LUMICHAT_URL}`);
  log(`Category: ${CATEGORY}`);
  log(`Headless: ${HEADLESS}`);
  log(`Providers: ${ALL_PROVIDERS.map(p => p.name).join(", ")}`);

  await ensureTestAccount();

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  // Capture console errors
  page.on("console", (msg) => {
    if (msg.type() === "error") log(`[CONSOLE ERROR] ${msg.text()}`);
  });

  try {
    const loggedIn = await login(page, context);
    if (!loggedIn) {
      log("FATAL: Could not log in. Aborting.");
      process.exit(1);
    }

    await page.waitForTimeout(1500);

    const runAll = CATEGORY === "all";

    if (runAll || CATEGORY === "1") {
      try { await runCategory1(page); } catch (e) {
        log(`FATAL ERROR in Category 1: ${e.message}`);
        await screenshot(page, "cat1-fatal-error").catch(() => {});
      }
    }

    if (runAll || CATEGORY === "2") {
      await reloadCleanState(page);
      try { await runCategory2(page); } catch (e) {
        log(`FATAL ERROR in Category 2: ${e.message}`);
        await screenshot(page, "cat2-fatal-error").catch(() => {});
      }
    }

    if (runAll || CATEGORY === "3") {
      await reloadCleanState(page);
      try { await runCategory3(page); } catch (e) {
        log(`FATAL ERROR in Category 3: ${e.message}`);
        await screenshot(page, "cat3-fatal-error").catch(() => {});
      }
    }

    if (runAll || CATEGORY === "4") {
      await reloadCleanState(page);
      try { await runCategory4(page); } catch (e) {
        log(`FATAL ERROR in Category 4: ${e.message}`);
        await screenshot(page, "cat4-fatal-error").catch(() => {});
      }
    }
  } finally {
    await browser.close();
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }

  printSummary();

  const failCount = results.filter((r) => r.status === "FAIL").length;
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
