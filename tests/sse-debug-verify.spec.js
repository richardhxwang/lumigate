/**
 * SSE Debug Verification — Verify fixes for typing dots, green cursor, DSML
 */
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const BASE_URL = process.env.LC_URL || "http://localhost:9471/lumichat";
const EMAIL = process.env.LC_EMAIL || "test@lumigate.local";
const PASSWORD = process.env.LC_PASSWORD || "testpass123";
const SCREENSHOTS_DIR = path.join(__dirname, "screenshots", "sse-debug");

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

let passed = 0, failed = 0;
function check(name, condition) {
  if (condition) { log(`  PASS: ${name}`); passed++; }
  else { log(`  FAIL: ${name}`); failed++; }
}

(async () => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Login
  const resp = await fetch("http://localhost:9471/lc/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const setCookie = resp.headers.get("set-cookie") || "";
  const tokenMatch = setCookie.match(/lc_token=([^;]+)/);
  const url = new URL(BASE_URL);
  await context.addCookies([{
    name: "lc_token", value: tokenMatch[1],
    domain: url.hostname, path: "/", httpOnly: true, sameSite: "Strict",
  }]);
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
  log("Logged in");

  // Select DeepSeek
  await page.click("#mdl-label");
  await page.waitForTimeout(500);
  const pills = await page.$$(".prov-pill");
  for (const pill of pills) {
    const text = await pill.textContent();
    if (text.toLowerCase().includes("deepseek")) { await pill.click(); break; }
  }
  await page.waitForTimeout(500);
  const modelItems = await page.$$(".model-item");
  if (modelItems.length > 0) await modelItems[0].click();
  await page.waitForTimeout(300);

  // Enable web search
  const tbs = await page.$$(".tb");
  for (const tb of tbs) {
    const title = await tb.getAttribute("title");
    if (title?.toLowerCase().includes("search") || title?.includes("搜索")) {
      await tb.click();
      log("Toggled web search");
      break;
    }
  }

  // Send message
  await page.fill("#msg-in", "搜索一下2026年最新的AI新闻");
  await page.click("#send-btn");
  log("Message sent");

  // === CHECK 1: Typing dots appear immediately after send ===
  await page.waitForTimeout(300);
  const typCheck1 = await page.evaluate(() => {
    const el = document.getElementById("typ-row");
    if (!el) return { exists: false };
    return {
      exists: true,
      visible: window.getComputedStyle(el).display !== "none",
      hasDots: el.querySelectorAll(".tdot").length === 3,
    };
  });
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "verify-01-typing-after-send.png") });
  log("Check 1: Typing dots after send");
  check("Typing row exists", typCheck1.exists);
  check("Typing row visible", typCheck1.visible);
  check("Has 3 dots", typCheck1.hasDots);

  // === CHECK 2: Wait for search indicator ===
  let searchFound = false;
  for (let i = 0; i < 60; i++) {
    const state = await page.evaluate(() => {
      const rows = document.querySelectorAll(".msg-row.assistant");
      const lastRow = rows[rows.length - 1];
      const asst = lastRow?.querySelector(".asst-content");
      return { text: asst?.textContent || "", display: lastRow ? window.getComputedStyle(lastRow).display : "none" };
    });
    if (state.text.includes("web search") || state.text.includes("search")) {
      searchFound = true;
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "verify-02-search-indicator.png") });
      log("Check 2: Search indicator");
      check("Search indicator visible", state.display !== "none");

      // Check no green cursor
      const cursorCheck = await page.evaluate(() => {
        const el = document.querySelector(".asst-content");
        const style = window.getComputedStyle(el, "::after");
        return {
          hasStreamingActive: el?.classList?.contains("streaming-active") || false,
          emptyAfterRule: el?.matches(".streaming-active:empty") || false,
        };
      });
      check("No streaming-active on search indicator", !cursorCheck.hasStreamingActive || !cursorCheck.emptyAfterRule);
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!searchFound) log("  WARN: Search indicator did not appear");

  // === CHECK 3: After search completes, typing dots should reappear ===
  let postSearchDotsFound = false;
  for (let i = 0; i < 40; i++) {
    const state = await page.evaluate(() => {
      const typRow = document.getElementById("typ-row");
      const rows = document.querySelectorAll(".msg-row.assistant");
      const lastRow = rows[rows.length - 1];
      const asst = lastRow?.querySelector(".asst-content");
      return {
        typRowExists: !!typRow,
        typRowVisible: typRow ? window.getComputedStyle(typRow).display !== "none" : false,
        typRowHasDots: typRow?.querySelectorAll(".tdot")?.length === 3,
        asstRowDisplay: lastRow ? window.getComputedStyle(lastRow).display : "none",
        asstEmpty: !asst?.textContent?.trim(),
        streamingActive: asst?.classList?.contains("streaming-active") || false,
      };
    });

    // After tool execution, before final response starts, we should see typing dots
    if (state.typRowExists && state.typRowVisible && state.typRowHasDots) {
      postSearchDotsFound = true;
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "verify-03-post-search-typing-dots.png") });
      log("Check 3: Post-search typing dots");
      check("Typing dots reappear after search", true);
      break;
    }
    await page.waitForTimeout(300);
  }
  if (!postSearchDotsFound) {
    log("Check 3: Post-search typing dots");
    check("Typing dots reappear after search", false);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "verify-03-no-dots.png") });
  }

  // === CHECK 4: Final response is visible (not display:none) ===
  let finalVisible = false;
  for (let i = 0; i < 120; i++) {
    const state = await page.evaluate(() => {
      const rows = document.querySelectorAll(".msg-row.assistant");
      const lastRow = rows[rows.length - 1];
      const asst = lastRow?.querySelector(".asst-content");
      const stopBtn = document.getElementById("stop-btn");
      return {
        rowDisplay: lastRow ? window.getComputedStyle(lastRow).display : "none",
        textLen: asst?.textContent?.length || 0,
        streamingActive: asst?.classList?.contains("streaming-active") || false,
        stopVisible: stopBtn ? window.getComputedStyle(stopBtn).display !== "none" : false,
      };
    });

    // Streaming and visible
    if (state.rowDisplay !== "none" && state.textLen > 20 && state.streamingActive) {
      finalVisible = true;
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "verify-04-streaming-visible.png") });
      log("Check 4: Final response visibility during stream");
      check("Response row visible during streaming", true);
      check("Content length > 20", state.textLen > 20);
      break;
    }

    if (!state.stopVisible && i > 10) {
      // Stream ended
      if (state.rowDisplay !== "none" && state.textLen > 0) {
        finalVisible = true;
        log("Check 4: Response visible after stream end");
        check("Response row visible", true);
      }
      break;
    }
    await page.waitForTimeout(300);
  }
  if (!finalVisible) {
    log("Check 4: Final response visibility");
    const finalState = await page.evaluate(() => {
      const rows = document.querySelectorAll(".msg-row.assistant");
      const lastRow = rows[rows.length - 1];
      return {
        display: lastRow ? window.getComputedStyle(lastRow).display : "none",
        textLen: lastRow?.querySelector(".asst-content")?.textContent?.length || 0,
      };
    });
    check("Response row visible", finalState.display !== "none");
    log(`  Row display: ${finalState.display}, textLen: ${finalState.textLen}`);
  }

  // Wait for completion
  for (let i = 0; i < 60; i++) {
    const done = await page.evaluate(() => {
      const stopBtn = document.getElementById("stop-btn");
      return window.getComputedStyle(stopBtn).display === "none";
    });
    if (done) break;
    await page.waitForTimeout(500);
  }

  // === CHECK 5: No DSML, no green cursor, no streaming-active after completion ===
  await page.waitForTimeout(500);
  const finalCheck = await page.evaluate(() => {
    const chat = document.getElementById("chat-el");
    const text = chat?.textContent || "";
    const html = chat?.innerHTML || "";
    return {
      hasDSML: /DSML/.test(text),
      hasInvoke: /invoke>/.test(text),
      hasFunctionCalls: /function_calls>/.test(text),
      hasStreamCursor: html.includes("stream-cursor"),
      hasStreamingActive: !!chat?.querySelector(".streaming-active"),
      greenCursorCount: chat?.querySelectorAll(".streaming-active")?.length || 0,
    };
  });
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "verify-05-final.png") });
  log("Check 5: Final DOM cleanliness");
  check("No DSML tags in text", !finalCheck.hasDSML);
  check("No invoke tags in text", !finalCheck.hasInvoke);
  check("No function_calls tags in text", !finalCheck.hasFunctionCalls);
  check("No streaming-active class remaining", !finalCheck.hasStreamingActive);

  log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
