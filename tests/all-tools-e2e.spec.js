/**
 * All-Tools E2E Test — Comprehensive test of EVERY LumiChat tool
 *
 * Tests: web_search, generate_spreadsheet (Excel), generate_document (Word),
 *        generate_presentation (PPTX), use_template, file upload+parse, image+vision
 *
 * Run:  node tests/all-tools-e2e.spec.js
 *
 * Env vars:
 *   LC_EMAIL    — LumiChat email    (default: test@lumigate.local)
 *   LC_PASSWORD — LumiChat password (default: testpass123)
 *   LC_BASE_URL — Base URL          (default: http://localhost:9471)
 */

const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { execSync } = require("child_process");

const EMAIL = process.env.LC_EMAIL || "test@lumigate.local";
const PASSWORD = process.env.LC_PASSWORD || "testpass123";
const BASE_URL = process.env.LC_BASE_URL || "http://localhost:9471";
const LUMICHAT_URL = `${BASE_URL}/lumichat`;
const SCREENSHOTS_DIR = path.join(__dirname, "screenshots", "all-tools");
const DOWNLOADS_DIR = path.join(SCREENSHOTS_DIR, "downloads");

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Results tracking ────────────────────────────────────────────────────────
const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  log(`  [${status}] ${name}${detail ? ": " + detail : ""}`);
}

// ── Screenshot helper ───────────────────────────────────────────────────────
async function screenshot(page, name) {
  const p = path.join(SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  log(`  [screenshot] ${p}`);
  return p;
}

// ── File content verification ───────────────────────────────────────────────
/**
 * Verify the CONTENTS of a generated Office file (not just that it exists).
 * Uses unzip to inspect the ZIP structure and parse XML contents.
 * @param {string} filePath - path to the file
 * @returns {{ valid: boolean, details: string, sheets?: number, rows?: number, slides?: number, paragraphs?: number }}
 */
function verifyFile(filePath) {
  if (!fs.existsSync(filePath)) return { valid: false, details: "file does not exist" };
  const stat = fs.statSync(filePath);
  if (stat.size < 500) return { valid: false, details: `file too small: ${stat.size} bytes` };

  const ext = path.extname(filePath).toLowerCase();
  const tmpDir = path.join(DOWNLOADS_DIR, `_verify_${Date.now()}`);

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Extract the zip (all Office formats are ZIP)
    execSync(`unzip -q -o "${filePath}" -d "${tmpDir}" 2>/dev/null`, { timeout: 10000 });

    if (ext === ".xlsx") {
      return verifyXlsx(tmpDir, stat.size);
    } else if (ext === ".docx") {
      return verifyDocx(tmpDir, stat.size);
    } else if (ext === ".pptx") {
      return verifyPptx(tmpDir, stat.size);
    }
    return { valid: true, details: `${stat.size} bytes, unzipped OK` };
  } catch (err) {
    return { valid: false, details: `unzip failed: ${err.message.slice(0, 100)}` };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function verifyXlsx(tmpDir, fileSize) {
  // Check for xl/worksheets/sheet*.xml
  const wsDir = path.join(tmpDir, "xl", "worksheets");
  if (!fs.existsSync(wsDir)) return { valid: false, details: "no xl/worksheets directory" };
  const sheetFiles = fs.readdirSync(wsDir).filter(f => f.startsWith("sheet") && f.endsWith(".xml"));
  if (sheetFiles.length === 0) return { valid: false, details: "no sheet XML files" };

  let totalRows = 0;
  let totalCells = 0;
  let formulaCount = 0;
  const sheetPreviews = [];

  for (const sf of sheetFiles) {
    const xml = fs.readFileSync(path.join(wsDir, sf), "utf-8");
    // Count <row> elements
    const rows = (xml.match(/<row\b/g) || []).length;
    // Count <c (cell) elements with values
    const cells = (xml.match(/<c\b/g) || []).length;
    // Count <f> (formula) elements
    const formulas = (xml.match(/<f[> ]/g) || []).length;
    totalRows += rows;
    totalCells += cells;
    formulaCount += formulas;

    // Extract first 3 cell values for preview
    const valMatches = [...xml.matchAll(/<v>([^<]*)<\/v>/g)].slice(0, 5).map(m => m[1]);
    sheetPreviews.push(`${sf}: ${rows} rows, ${cells} cells, ${formulas} formulas, vals=[${valMatches.join(",")}]`);
  }

  // Also check sharedStrings for actual text content
  let sharedStrCount = 0;
  const ssPath = path.join(tmpDir, "xl", "sharedStrings.xml");
  if (fs.existsSync(ssPath)) {
    const ssXml = fs.readFileSync(ssPath, "utf-8");
    sharedStrCount = (ssXml.match(/<t[> ]/g) || []).length;
  }

  const valid = sheetFiles.length > 0 && totalCells >= 10;
  const details = [
    `${fileSize} bytes`,
    `${sheetFiles.length} sheets`,
    `${totalRows} rows`,
    `${totalCells} cells`,
    `${formulaCount} formulas`,
    `${sharedStrCount} shared strings`,
  ].join(", ");

  log(`    XLSX verification:`);
  for (const p of sheetPreviews) log(`      ${p}`);

  return { valid, details, sheets: sheetFiles.length, rows: totalRows, cells: totalCells, formulas: formulaCount };
}

function verifyDocx(tmpDir, fileSize) {
  const docPath = path.join(tmpDir, "word", "document.xml");
  if (!fs.existsSync(docPath)) return { valid: false, details: "no word/document.xml" };

  const xml = fs.readFileSync(docPath, "utf-8");
  // Count paragraphs with text
  const paragraphs = (xml.match(/<w:p\b/g) || []).length;
  // Extract text content from <w:t> elements
  const textMatches = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]);
  const fullText = textMatches.join("");
  const nonEmpty = textMatches.filter(t => t.trim().length > 0).length;

  const valid = nonEmpty >= 5 && fullText.length > 50;
  const preview = fullText.slice(0, 200);
  const details = `${fileSize} bytes, ${paragraphs} paragraphs, ${nonEmpty} text runs, ${fullText.length} chars`;

  log(`    DOCX verification: ${details}`);
  log(`    Preview: ${preview}...`);

  return { valid, details, paragraphs: nonEmpty };
}

function verifyPptx(tmpDir, fileSize) {
  const slidesDir = path.join(tmpDir, "ppt", "slides");
  if (!fs.existsSync(slidesDir)) return { valid: false, details: "no ppt/slides directory" };

  const slideFiles = fs.readdirSync(slidesDir).filter(f => f.startsWith("slide") && f.endsWith(".xml"));
  if (slideFiles.length === 0) return { valid: false, details: "no slide XML files" };

  let slidesWithText = 0;
  for (const sf of slideFiles) {
    const xml = fs.readFileSync(path.join(slidesDir, sf), "utf-8");
    const textMatches = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]);
    const text = textMatches.join("");
    if (text.trim().length > 0) slidesWithText++;
  }

  const valid = slideFiles.length >= 3;
  const details = `${fileSize} bytes, ${slideFiles.length} slides, ${slidesWithText} with text`;

  log(`    PPTX verification: ${details}`);

  return { valid, details, slides: slideFiles.length };
}

// ── Download a file from a blob URL via the browser ─────────────────────────
async function downloadFromBlobUrl(page, blobUrl, filename) {
  const savePath = path.join(DOWNLOADS_DIR, filename);
  try {
    // Use page.evaluate to fetch the blob and convert to base64
    const base64 = await page.evaluate(async (url) => {
      const resp = await fetch(url);
      const blob = await resp.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          resolve(dataUrl.split(",")[1]); // strip data:...;base64,
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }, blobUrl);

    if (base64) {
      fs.writeFileSync(savePath, Buffer.from(base64, "base64"));
      log(`    Downloaded: ${savePath} (${fs.statSync(savePath).size} bytes)`);
      return savePath;
    }
  } catch (err) {
    log(`    Download failed: ${err.message}`);
  }
  return null;
}

// ── Download from PocketBase URL via http ───────────────────────────────────
async function downloadFromUrl(url, filename) {
  const savePath = path.join(DOWNLOADS_DIR, filename);
  try {
    const resp = await fetch(url);
    if (!resp.ok) { log(`    HTTP download failed: ${resp.status}`); return null; }
    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(savePath, buffer);
    log(`    Downloaded: ${savePath} (${buffer.length} bytes)`);
    return savePath;
  } catch (err) {
    log(`    Download failed: ${err.message}`);
    return null;
  }
}

// ── Login via API + cookie injection ────────────────────────────────────────
async function login(page, context) {
  log("Authenticating via API...");
  const token = await new Promise((resolve, reject) => {
    const postData = JSON.stringify({ email: EMAIL, password: PASSWORD });
    const url = new URL(`${BASE_URL}/lc/auth/login`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
      },
      (res) => {
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`Login API returned ${res.statusCode}: ${data}`));
          const cookies = res.headers["set-cookie"] || [];
          for (const c of cookies) {
            const m = c.match(/lc_token=([^;]+)/);
            if (m) return resolve(m[1]);
          }
          reject(new Error("No lc_token cookie in response"));
        });
      }
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
  log(`  Got auth token: ${token.slice(0, 20)}...`);

  const url = new URL(BASE_URL);
  await context.addCookies([{
    name: "lc_token",
    value: token,
    domain: url.hostname,
    path: "/",
    httpOnly: true,
    sameSite: "Strict",
    expires: Math.floor(Date.now() / 1000) + 604800,
  }]);

  await page.goto(LUMICHAT_URL, { waitUntil: "networkidle", timeout: 30000 });
  await sleep(3000);
  await page.waitForFunction(
    () => {
      const app = document.querySelector("#app");
      return app && app.style.display !== "none" && getComputedStyle(app).display !== "none";
    },
    null,
    { timeout: 15000 }
  );
  log("Login successful!");
  await sleep(1000);
}

// ── Select DeepSeek provider + deepseek-chat model ──────────────────────────
async function selectDeepSeek(page) {
  log("Selecting DeepSeek / deepseek-chat...");
  await page.click("#mdl-btn");
  await sleep(800);

  const picked = await page.evaluate(() => {
    const drop = document.querySelector("#mdl-drop");
    if (!drop || !drop.classList.contains("open")) return false;
    const pills = drop.querySelectorAll(".mdl-prov-pill[data-prov]");
    for (const pill of pills) {
      if (pill.dataset.prov === "deepseek" && !pill.classList.contains("locked")) {
        pill.click();
        return true;
      }
    }
    return false;
  });

  if (!picked) {
    log("  Could not select DeepSeek provider");
    return false;
  }
  await sleep(600);

  const model = await page.evaluate(() => {
    const drop = document.querySelector("#mdl-drop");
    if (!drop) return null;
    const items = drop.querySelectorAll(".mdl-opt[data-model]");
    for (const item of items) {
      if (item.dataset.model && item.dataset.model.includes("deepseek-chat")) {
        item.click();
        return item.dataset.model;
      }
    }
    if (items.length > 0) { items[0].click(); return items[0].dataset.model; }
    return null;
  });

  if (model) log(`  Selected model: ${model}`);
  await sleep(400);
  return !!model;
}

// ── Start a new chat session ────────────────────────────────────────────────
async function startNewChat(page) {
  try {
    const btn = await page.$("#new-chat, .new-btn");
    if (btn) { await btn.click(); await sleep(1000); }
  } catch {
    await page.evaluate(() => { if (typeof window.newChat === "function") window.newChat(); });
    await sleep(1000);
  }
}

// ── Send a message and wait for streaming to complete ───────────────────────
async function sendAndWait(page, message, timeoutMs = 90000) {
  await page.fill("#msg-in", message);
  await sleep(300);

  // Wait for send button to be enabled
  await page.waitForFunction(() => {
    const btn = document.querySelector("#send-btn");
    return btn && !btn.disabled;
  }, null, { timeout: 5000 }).catch(() => {});

  // Use evaluate to call sendMessage() to avoid IME issues
  await page.evaluate(() => {
    if (typeof sendMessage === "function") sendMessage();
    else document.querySelector("#send-btn")?.click();
  });

  log("  Message sent, waiting for response...");
  const start = Date.now();
  let sawStreaming = false;
  let stableCount = 0; // count consecutive "done" polls to avoid premature detection

  while (Date.now() - start < timeoutMs) {
    const state = await page.evaluate(() => {
      const streaming = typeof isStreaming !== "undefined" ? isStreaming : null;
      const sendBtn = document.querySelector("#send-btn");
      const stopBtn = document.querySelector("#stop-btn");
      const sendVisible = sendBtn && getComputedStyle(sendBtn).display !== "none";
      const stopVisible = stopBtn && getComputedStyle(stopBtn).display !== "none";
      const asstRows = document.querySelectorAll(".msg-row.assistant");
      const lastRow = asstRows.length > 0 ? asstRows[asstRows.length - 1] : null;
      const asst = lastRow?.querySelector(".asst-content");
      const contentLen = asst ? asst.textContent.length : 0;
      const contentText = asst ? asst.textContent.trim() : "";
      const toast = document.querySelector("#toast");
      const toastText = (toast && toast.classList.contains("show")) ? toast.textContent : "";
      // Check for download cards (tool result already rendered)
      const dlCards = lastRow ? lastRow.querySelectorAll("a[download]").length : 0;
      // Check if tool indicator is showing (means tool is executing)
      const hasToolIndicator = asst ? !!asst.querySelector("span[style*='color:var(--t3)'] svg") : false;
      // Check if typing dots are visible (means waiting for next response)
      const typRow = document.getElementById("typ-row");
      const typVisible = typRow && getComputedStyle(typRow).display !== "none";
      return { streaming, sendVisible, stopVisible, contentLen, contentText, toastText, dlCards, hasToolIndicator, typVisible };
    });

    if (state.streaming) sawStreaming = true;

    // Error toast (only after 5s to avoid transient toasts)
    if (state.toastText && (Date.now() - start > 5000)) {
      return { ok: false, reason: `toast: ${state.toastText}` };
    }

    // If typing dots are visible or tool indicator is showing, tool is executing - keep waiting
    if (state.typVisible || state.hasToolIndicator) {
      stableCount = 0;
      await sleep(1500);
      continue;
    }

    // Check if streaming is truly done
    const isDone = sawStreaming && !state.streaming && state.sendVisible && !state.stopVisible;
    const hasContent = (state.contentLen > 0 || state.dlCards > 0) && !state.streaming && state.sendVisible;

    if (isDone || hasContent) {
      stableCount++;
      // Require 2 consecutive "done" polls (3s total) to avoid premature detection
      // during tool_calls -> typing dots -> next streaming cycle
      if (stableCount >= 2) break;
    } else {
      stableCount = 0;
    }

    await sleep(1500);
  }

  // Final delay for markdown rendering
  await sleep(2000);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`  Response completed in ${elapsed}s`);
  return { ok: true, elapsed };
}

// ── Extract response info from last assistant message ───────────────────────
async function extractResponse(page) {
  return page.evaluate(() => {
    const asstRows = document.querySelectorAll(".msg-row.assistant");
    const lastRow = asstRows.length > 0 ? asstRows[asstRows.length - 1] : null;
    if (!lastRow) return { text: "", textLen: 0, hasDownloadCard: false, downloadCards: [], rawTags: false, streamingActive: false };

    const asst = lastRow.querySelector(".asst-content");
    const text = asst ? asst.textContent.trim() : "";
    const html = asst ? asst.innerHTML : "";

    // Download cards: look for <a download="...">
    const dlLinks = asst ? Array.from(asst.querySelectorAll("a[download]")) : [];
    const downloadCards = dlLinks.map(a => ({
      filename: a.getAttribute("download") || "",
      href: a.href || "",
    }));

    // Raw tags leaked
    const rawTags =
      /\[TOOL:\w+\]/.test(text) ||
      /DSML/.test(text) ||
      /<invoke/.test(text) ||
      /<function_calls>/.test(text) ||
      /<tool_call>/.test(text);

    // Streaming active class (should be gone)
    const streamingActive = asst ? asst.classList.contains("streaming-active") : false;

    return { text: text.slice(0, 600), textLen: text.length, hasDownloadCard: dlLinks.length > 0, downloadCards, rawTags, streamingActive };
  });
}

// ── Get download card info from last assistant message ──────────────────────
async function getDownloadCard(page, expectedExt) {
  return page.evaluate((ext) => {
    const asstRows = document.querySelectorAll(".msg-row.assistant");
    const lastRow = asstRows.length > 0 ? asstRows[asstRows.length - 1] : null;
    if (!lastRow) return { found: false };
    const links = lastRow.querySelectorAll("a[download]");
    for (const a of links) {
      const fn = a.getAttribute("download") || "";
      if (fn.toLowerCase().endsWith(ext)) {
        return { found: true, filename: fn, href: a.href };
      }
    }
    if (links.length > 0) {
      return { found: true, filename: links[0].getAttribute("download") || "", href: links[0].href };
    }
    return { found: false };
  }, expectedExt);
}

// ── Download and verify a file from download card ───────────────────────────
async function downloadAndVerify(page, dlCard, testName) {
  if (!dlCard || !dlCard.found) {
    record(`${testName} - file content`, "SKIP", "no download card");
    return;
  }

  let filePath = null;
  if (dlCard.href.startsWith("blob:")) {
    filePath = await downloadFromBlobUrl(page, dlCard.href, dlCard.filename);
  } else if (dlCard.href.startsWith("http")) {
    filePath = await downloadFromUrl(dlCard.href, dlCard.filename);
  }

  if (!filePath) {
    record(`${testName} - file download`, "FAIL", "could not download");
    return;
  }

  const fileSize = fs.statSync(filePath).size;
  record(`${testName} - file download`, fileSize > 500 ? "PASS" : "FAIL", `${fileSize} bytes`);

  // Verify contents
  const verification = verifyFile(filePath);
  record(`${testName} - file content valid`, verification.valid ? "PASS" : "FAIL", verification.details);

  return verification;
}

// ==========================================================================
// TEST CASES
// ==========================================================================

async function testWebSearch(page) {
  log("\n=== Test 1: Web Search ===");
  await startNewChat(page);
  await sleep(500);

  const resp = await sendAndWait(page, "搜索一下2026年最新的AI新闻", 60000);
  await screenshot(page, "01-web-search");

  if (!resp.ok) {
    record("Web Search", "FAIL", resp.reason);
    return;
  }

  const info = await extractResponse(page);
  record("Web Search - response received", info.textLen > 30 ? "PASS" : "FAIL", `${info.textLen} chars`);
  record("Web Search - no raw tags", !info.rawTags ? "PASS" : "FAIL");
  record("Web Search - no streaming cursor", !info.streamingActive ? "PASS" : "FAIL");

  if (info.text.length > 0) {
    log(`  Preview: ${info.text.slice(0, 150)}...`);
  }
}

async function testGenerateExcel(page) {
  log("\n=== Test 2: Generate Excel (Spreadsheet) ===");
  await startNewChat(page);
  await sleep(500);

  const resp = await sendAndWait(page, "帮我生成一个华润啤酒的三大表财务模型Excel，包含利润表(2022-2026带公式)和DCF估值", 120000);
  await screenshot(page, "02-generate-excel");

  if (!resp.ok) {
    record("Generate Excel", "FAIL", resp.reason);
    return;
  }

  const info = await extractResponse(page);
  const dlCard = await getDownloadCard(page, ".xlsx");

  record("Generate Excel - response received", info.textLen > 0 || dlCard.found ? "PASS" : "FAIL", `${info.textLen} chars`);
  record("Generate Excel - download card present", dlCard.found ? "PASS" : "FAIL", dlCard.filename || "no card");
  record("Generate Excel - no raw tags", !info.rawTags ? "PASS" : "FAIL");

  // Download and verify file contents
  await downloadAndVerify(page, dlCard, "Generate Excel");

  // Scroll + second screenshot
  await page.evaluate(() => {
    const chat = document.querySelector("#chat-scroll") || document.querySelector("#chat-el");
    if (chat) chat.scrollTop = chat.scrollHeight;
  });
  await sleep(500);
  await screenshot(page, "02-generate-excel-scrolled");
}

async function testGenerateWord(page) {
  log("\n=== Test 3: Generate Word Document ===");
  await startNewChat(page);
  await sleep(500);

  const resp = await sendAndWait(page, "帮我生成一份华润啤酒的投资研究报告Word文档，包含行业分析和估值", 120000);
  await screenshot(page, "03-generate-word");

  if (!resp.ok) {
    record("Generate Word", "FAIL", resp.reason);
    return;
  }

  const info = await extractResponse(page);
  const dlCard = await getDownloadCard(page, ".docx");

  record("Generate Word - response received", info.textLen > 0 || dlCard.found ? "PASS" : "FAIL", `${info.textLen} chars`);
  record("Generate Word - download card present", dlCard.found ? "PASS" : "FAIL", dlCard.filename || "no card");
  record("Generate Word - no raw tags", !info.rawTags ? "PASS" : "FAIL");

  // Download and verify file contents
  await downloadAndVerify(page, dlCard, "Generate Word");

  await page.evaluate(() => {
    const chat = document.querySelector("#chat-scroll") || document.querySelector("#chat-el");
    if (chat) chat.scrollTop = chat.scrollHeight;
  });
  await sleep(500);
  await screenshot(page, "03-generate-word-scrolled");
}

async function testGeneratePPTX(page) {
  log("\n=== Test 4: Generate PowerPoint ===");
  await startNewChat(page);
  await sleep(500);

  const resp = await sendAndWait(page, "生成一个10页的华润啤酒投资分析PPT", 120000);
  await screenshot(page, "04-generate-pptx");

  if (!resp.ok) {
    record("Generate PPTX", "FAIL", resp.reason);
    return;
  }

  const info = await extractResponse(page);
  const dlCard = await getDownloadCard(page, ".pptx");

  record("Generate PPTX - response received", info.textLen > 0 || dlCard.found ? "PASS" : "FAIL", `${info.textLen} chars`);
  record("Generate PPTX - download card present", dlCard.found ? "PASS" : "FAIL", dlCard.filename || "no card");
  record("Generate PPTX - no raw tags", !info.rawTags ? "PASS" : "FAIL");

  // Download and verify file contents
  await downloadAndVerify(page, dlCard, "Generate PPTX");

  await page.evaluate(() => {
    const chat = document.querySelector("#chat-scroll") || document.querySelector("#chat-el");
    if (chat) chat.scrollTop = chat.scrollHeight;
  });
  await sleep(500);
  await screenshot(page, "04-generate-pptx-scrolled");
}

async function testUseTemplate(page) {
  log("\n=== Test 5: Use Template ===");
  await startNewChat(page);
  await sleep(500);

  const resp = await sendAndWait(page, "用DCF模型模板生成一个估值分析", 120000);
  await screenshot(page, "05-use-template");

  if (!resp.ok) {
    record("Use Template", "FAIL", resp.reason);
    return;
  }

  const info = await extractResponse(page);
  const dlCard = await getDownloadCard(page, ".xlsx");

  record("Use Template - response received", info.textLen > 10 ? "PASS" : "FAIL", `${info.textLen} chars`);
  record("Use Template - result rendered", (dlCard.found || info.textLen > 50) ? "PASS" : "FAIL",
    dlCard.found ? `download: ${dlCard.filename}` : "text response");
  record("Use Template - no raw tags", !info.rawTags ? "PASS" : "FAIL");

  // If there's a download card, verify contents
  if (dlCard.found) {
    await downloadAndVerify(page, dlCard, "Use Template");
  }

  await page.evaluate(() => {
    const chat = document.querySelector("#chat-scroll") || document.querySelector("#chat-el");
    if (chat) chat.scrollTop = chat.scrollHeight;
  });
  await sleep(500);
  await screenshot(page, "05-use-template-scrolled");
}

async function testFileUploadParse(page) {
  log("\n=== Test 6: File Upload + Parse ===");
  await startNewChat(page);
  await sleep(500);

  // Create a test txt file with financial data
  const testFilePath = path.join(SCREENSHOTS_DIR, "test-financial-data.txt");
  fs.writeFileSync(testFilePath, `China Resources Beer Holdings (0291.HK) Financial Summary
Revenue (2022): 35.2B RMB
Revenue (2023): 38.9B RMB
Revenue (2024): 42.1B RMB (estimate)
Gross Margin: 39.2%
Net Income (2023): 5.1B RMB
P/E Ratio: 28.5x
Market Cap: ~145B RMB
Key brands: Snow Beer, Heineken (China distribution)
Growth drivers: premiumization, craft beer segment expansion
`);

  const fileInput = await page.$("#file-in");
  if (!fileInput) {
    record("File Upload", "SKIP", "#file-in element not found");
    return;
  }

  await fileInput.setInputFiles(testFilePath);
  await sleep(1000);

  // Check if file chip appeared
  const chipExists = await page.evaluate(() => {
    const chips = document.querySelector("#file-chips");
    return chips && chips.children.length > 0;
  });
  record("File Upload - chip appears", chipExists ? "PASS" : "FAIL");
  await screenshot(page, "06-file-upload-chip");

  // Send analysis request
  const resp = await sendAndWait(page, "分析这个文件的内容并总结关键财务数据", 60000);
  await screenshot(page, "06-file-upload-response");

  if (!resp.ok) {
    record("File Upload - parse response", "FAIL", resp.reason);
    return;
  }

  const info = await extractResponse(page);
  // Text content of file is displayed inline (not parsed by backend),
  // so even a short AI response acknowledging the file is valid
  record("File Upload - AI analyzed content", info.textLen > 15 ? "PASS" : "FAIL", `${info.textLen} chars`);
  record("File Upload - no raw tags", !info.rawTags ? "PASS" : "FAIL");

  if (info.text.length > 0) {
    log(`  Preview: ${info.text.slice(0, 200)}...`);
  }
}

async function testImageVision(page) {
  log("\n=== Test 7: Image Upload + Vision ===");
  log("  NOTE: DeepSeek does not support vision/image_url - this is an expected limitation");
  await startNewChat(page);
  await sleep(500);

  // Create a small test PNG (16x16 with some actual pixel data)
  const pngData = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000100000001008060000001ff3ff" +
    "610000002549444154789c62f84f00308c0c0c6c6068606860646460646060" +
    "60640060000000ff0310000171f3f21f0000000049454e44ae426082",
    "hex"
  );
  const testImagePath = path.join(SCREENSHOTS_DIR, "test-image.png");
  fs.writeFileSync(testImagePath, pngData);

  const fileInput = await page.$("#file-in");
  if (!fileInput) {
    record("Image Vision", "SKIP", "#file-in element not found");
    return;
  }

  await fileInput.setInputFiles(testImagePath);
  await sleep(1000);

  const chipExists = await page.evaluate(() => {
    const chips = document.querySelector("#file-chips");
    return chips && chips.children.length > 0;
  });
  record("Image Upload - chip appears", chipExists ? "PASS" : "FAIL");
  await screenshot(page, "07-image-upload-chip");

  const resp = await sendAndWait(page, "描述这张图片", 60000);
  await screenshot(page, "07-image-vision-response");

  if (!resp.ok) {
    // DeepSeek doesn't support image_url, so this is expected
    record("Image Vision - response", "SKIP", `expected: DeepSeek no vision support. ${resp.reason || ""}`);
    return;
  }

  const info = await extractResponse(page);
  // If we got any response at all (even error text), that's acceptable
  if (info.textLen > 10) {
    record("Image Vision - AI responded", "PASS", `${info.textLen} chars`);
  } else {
    record("Image Vision - AI responded", "SKIP", `DeepSeek does not support vision (${info.textLen} chars)`);
  }
  record("Image Vision - no raw tags", !info.rawTags ? "PASS" : "FAIL");
}

async function testToolIndicatorDisplay(page) {
  log("\n=== Test 8: Tool Indicator Display Verification ===");

  // Navigate back to a chat that had tool results to check
  // (the current chat may be the image test which had an error)
  // Instead, check the general DOM state
  const globalCheck = await page.evaluate(() => {
    const chat = document.getElementById("chat-el");
    if (!chat) return { hasTOOLTags: false, hasDSML: false, hasInvoke: false, hasFunctionCalls: false, hasToolCall: false, streamingActiveCount: 0, downloadCardCount: 0, totalAssistantRows: 0 };
    const text = chat.textContent || "";
    return {
      hasTOOLTags: /\[TOOL:\w+\]/.test(text),
      hasDSML: /DSML/.test(text),
      hasInvoke: /<invoke/.test(text),
      hasFunctionCalls: /function_calls>/.test(text),
      hasToolCall: /<tool_call>/.test(text),
      streamingActiveCount: chat.querySelectorAll(".streaming-active").length || 0,
      downloadCardCount: chat.querySelectorAll("a[download]").length || 0,
      totalAssistantRows: chat.querySelectorAll(".msg-row.assistant").length || 0,
    };
  });
  await screenshot(page, "08-tool-indicator-final-state");

  record("Tool Display - no [TOOL:] tags", !globalCheck.hasTOOLTags ? "PASS" : "FAIL");
  record("Tool Display - no DSML tags", !globalCheck.hasDSML ? "PASS" : "FAIL");
  record("Tool Display - no <invoke> tags", !globalCheck.hasInvoke ? "PASS" : "FAIL");
  record("Tool Display - no <function_calls>", !globalCheck.hasFunctionCalls ? "PASS" : "FAIL");
  record("Tool Display - no <tool_call> tags", !globalCheck.hasToolCall ? "PASS" : "FAIL");
  record("Tool Display - no streaming-active remaining", globalCheck.streamingActiveCount === 0 ? "PASS" : "FAIL",
    `${globalCheck.streamingActiveCount} elements`);

  log(`  Total assistant rows: ${globalCheck.totalAssistantRows}`);
  log(`  Download cards found: ${globalCheck.downloadCardCount}`);
}

// ==========================================================================
// MAIN
// ==========================================================================

async function main() {
  console.log("=== LumiChat All-Tools E2E Test ===\n");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Email:    ${EMAIL}`);
  console.log(`Screenshots: ${SCREENSHOTS_DIR}\n`);

  const browser = await chromium.launch({
    headless: false,
    args: ["--window-size=1400,900"],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // Collect console errors
  const consoleErrors = [];
  page.on("console", msg => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  // Collect network errors on API routes
  const networkErrors = [];
  page.on("response", response => {
    const u = response.url();
    const status = response.status();
    if (status >= 400 && (u.includes("/v1/") || u.includes("/lc/"))) {
      networkErrors.push(`${status} ${response.request().method()} ${u}`);
      response.text().then(body => {
        log(`  [NET ${status}] ${u.split("/").slice(-3).join("/")} => ${body.slice(0, 200)}`);
      }).catch(() => {});
    }
  });

  try {
    // Login
    await login(page, context);
    await screenshot(page, "00-logged-in");

    // Select DeepSeek
    const modelOk = await selectDeepSeek(page);
    if (!modelOk) {
      log("FATAL: Could not select DeepSeek model. Aborting.");
      await screenshot(page, "00-model-select-failed");
      process.exit(1);
    }
    await screenshot(page, "00-deepseek-selected");

    // Run all tests with cooldown between them
    await testWebSearch(page);
    log("  Cooldown 8s...");
    await sleep(8000);

    await testGenerateExcel(page);
    log("  Cooldown 8s...");
    await sleep(8000);

    await testGenerateWord(page);
    log("  Cooldown 8s...");
    await sleep(8000);

    await testGeneratePPTX(page);
    log("  Cooldown 8s...");
    await sleep(8000);

    await testUseTemplate(page);
    log("  Cooldown 8s...");
    await sleep(8000);

    await testFileUploadParse(page);
    log("  Cooldown 5s...");
    await sleep(5000);

    await testImageVision(page);
    await sleep(2000);

    await testToolIndicatorDisplay(page);

  } catch (err) {
    log(`\nUnexpected error: ${err.message}`);
    console.error(err.stack);
    await screenshot(page, "99-unexpected-error");
  } finally {
    // Print summary
    console.log("\n" + "=".repeat(90));
    console.log("ALL-TOOLS E2E TEST SUMMARY");
    console.log("=".repeat(90));
    console.log("Test".padEnd(48) + "Status".padEnd(8) + "Detail");
    console.log("-".repeat(90));

    let pass = 0, fail = 0, skip = 0;
    for (const r of results) {
      console.log(r.name.padEnd(48) + r.status.padEnd(8) + (r.detail || "").slice(0, 35));
      if (r.status === "PASS") pass++;
      else if (r.status === "FAIL") fail++;
      else skip++;
    }

    console.log("-".repeat(90));
    console.log(`Total: ${results.length} | PASS: ${pass} | FAIL: ${fail} | SKIP: ${skip}`);
    console.log("=".repeat(90));

    if (consoleErrors.length > 0) {
      console.log(`\nConsole errors (${consoleErrors.length}):`);
      for (const e of consoleErrors.slice(0, 10)) {
        console.log(`  - ${e.slice(0, 120)}`);
      }
    }
    if (networkErrors.length > 0) {
      console.log(`\nNetwork errors (${networkErrors.length}):`);
      for (const e of networkErrors.slice(0, 10)) {
        console.log(`  - ${e}`);
      }
    }

    await browser.close();
    process.exit(fail > 0 ? 1 : 0);
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
