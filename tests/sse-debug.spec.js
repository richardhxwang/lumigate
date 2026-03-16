/**
 * SSE Debug Test — Diagnose DSML tags, green cursor, typing dots issues
 * Run: node tests/sse-debug.spec.js
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

async function ensureTestAccount() {
  try {
    const resp = await fetch("http://localhost:9471/lc/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, passwordConfirm: PASSWORD, name: "Test User" }),
    });
    const data = await resp.json();
    if (resp.ok) log(`Created test account: ${EMAIL}`);
    else log(`Account status: ${JSON.stringify(data).slice(0, 100)}`);
  } catch (e) { log(`Register: ${e.message}`); }
}

async function login(page, context) {
  log("Authenticating via API...");
  const resp = await fetch("http://localhost:9471/lc/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!resp.ok) throw new Error(`Login failed: ${resp.status}`);

  const setCookie = resp.headers.get("set-cookie") || "";
  const tokenMatch = setCookie.match(/lc_token=([^;]+)/);
  if (!tokenMatch) throw new Error("No lc_token in response");

  const url = new URL(BASE_URL);
  await context.addCookies([{
    name: "lc_token", value: tokenMatch[1],
    domain: url.hostname, path: "/", httpOnly: true, sameSite: "Strict",
  }]);

  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
  log("Login successful!");
}

async function selectDeepSeek(page) {
  // Click model label to open provider picker
  await page.click("#mdl-label");
  await page.waitForTimeout(500);

  // Find and click deepseek provider pill
  const pills = await page.$$(".prov-pill");
  for (const pill of pills) {
    const text = await pill.textContent();
    if (text.toLowerCase().includes("deepseek")) {
      await pill.click();
      log("Selected DeepSeek provider");
      break;
    }
  }
  await page.waitForTimeout(500);

  // Select the first model available
  const modelItems = await page.$$(".model-item");
  if (modelItems.length > 0) {
    const modelText = await modelItems[0].textContent();
    await modelItems[0].click();
    log(`Selected model: ${modelText.trim()}`);
  }
  await page.waitForTimeout(300);
}

(async () => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  await ensureTestAccount();

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Capture raw SSE data for DSML analysis
  const sseChunks = [];
  page.on("response", async (response) => {
    if (response.url().includes("/chat/completions") && response.headers()["content-type"]?.includes("text/event-stream")) {
      log("SSE stream detected");
    }
  });

  await login(page, context);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "01-logged-in.png") });

  // Select DeepSeek
  await selectDeepSeek(page);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "02-deepseek-selected.png") });

  // Enable web search toggle if present
  const webToggle = await page.$("#web-search-toggle, #ws-toggle, .ws-btn");
  if (webToggle) {
    await webToggle.click();
    log("Toggled web search");
    await page.waitForTimeout(300);
  } else {
    // Try finding by toolbar button
    const tbs = await page.$$(".tb");
    for (const tb of tbs) {
      const title = await tb.getAttribute("title");
      const text = await tb.textContent();
      if (title?.toLowerCase().includes("search") || text?.toLowerCase().includes("search")) {
        await tb.click();
        log("Toggled web search via toolbar button");
        break;
      }
    }
  }

  // Type and send a web-search triggering message
  const testMsg = "搜索一下2026年苹果春季发布会";
  await page.fill("#msg-in", testMsg);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "03-before-send.png") });

  // Send
  await page.click("#send-btn");
  log("Message sent");

  // Stage 1: Immediately after send — check for typing dots
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "04-after-send-typing-dots.png") });

  // Check typing indicator
  const typRow1 = await page.evaluate(() => {
    const el = document.getElementById("typ-row");
    if (!el) return { exists: false };
    const style = window.getComputedStyle(el);
    return {
      exists: true,
      display: style.display,
      visibility: style.visibility,
      innerHTML: el.innerHTML.slice(0, 200),
      offsetHeight: el.offsetHeight,
    };
  });
  log(`Typing indicator after send: ${JSON.stringify(typRow1)}`);

  // Stage 2: Wait for tool execution indicator ("Searching: xxx")
  let searchIndicatorFound = false;
  for (let i = 0; i < 60; i++) {
    const state = await page.evaluate(() => {
      const rows = document.querySelectorAll(".msg-row.assistant");
      const lastRow = rows[rows.length - 1];
      const asst = lastRow?.querySelector(".asst-content");
      const typRow = document.getElementById("typ-row");
      return {
        asstHTML: asst?.innerHTML?.slice(0, 500) || "",
        asstText: asst?.textContent?.slice(0, 200) || "",
        typRowExists: !!typRow,
        typRowDisplay: typRow ? window.getComputedStyle(typRow).display : "N/A",
        rowDisplay: lastRow ? window.getComputedStyle(lastRow).display : "N/A",
        streamingActive: asst?.classList?.contains("streaming-active") || false,
      };
    });

    if (state.asstText.includes("search") || state.asstText.includes("Searching") || state.asstHTML.includes("web_search")) {
      log(`Search indicator found at iteration ${i}: ${state.asstText.slice(0, 100)}`);
      searchIndicatorFound = true;
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "05-searching-indicator.png") });

      // Check if DSML tags are visible
      const dsmlCheck = await page.evaluate(() => {
        const rows = document.querySelectorAll(".msg-row.assistant");
        let allText = "";
        rows.forEach(r => allText += r.textContent + "\n");
        return {
          hasDSML: /DSML/.test(allText),
          hasInvoke: /invoke/.test(allText),
          hasFunctionCalls: /function_calls/.test(allText),
          rawText: allText.slice(0, 500),
        };
      });
      log(`DSML check during search: ${JSON.stringify(dsmlCheck)}`);
      break;
    }

    await page.waitForTimeout(500);
  }

  if (!searchIndicatorFound) {
    log("WARNING: Search indicator never appeared. Checking for direct streaming...");
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "05-no-search-indicator.png") });
  }

  // Stage 3: Wait for search to complete and check for typing dots before final response
  let postSearchDotsFound = false;
  for (let i = 0; i < 30; i++) {
    const state = await page.evaluate(() => {
      const typRow = document.getElementById("typ-row");
      const rows = document.querySelectorAll(".msg-row.assistant");
      const lastRow = rows[rows.length - 1];
      const asst = lastRow?.querySelector(".asst-content");
      return {
        typRowExists: !!typRow,
        asstHTML: asst?.innerHTML?.slice(0, 500) || "",
        streamingActive: asst?.classList?.contains("streaming-active") || false,
        rowDisplay: lastRow ? window.getComputedStyle(lastRow).display : "N/A",
        rowCount: rows.length,
      };
    });

    if (state.streamingActive) {
      log(`Streaming active at iteration ${i}, row visible: ${state.rowDisplay}`);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "06-streaming-response.png") });
      break;
    }
    await page.waitForTimeout(500);
  }

  // Stage 4: Wait for response to finish
  let responseComplete = false;
  for (let i = 0; i < 120; i++) {
    const state = await page.evaluate(() => {
      const rows = document.querySelectorAll(".msg-row.assistant");
      const lastRow = rows[rows.length - 1];
      const asst = lastRow?.querySelector(".asst-content");
      const sendBtn = document.getElementById("send-btn");
      const stopBtn = document.getElementById("stop-btn");
      return {
        streamingActive: asst?.classList?.contains("streaming-active") || false,
        sendBtnDisplay: sendBtn ? window.getComputedStyle(sendBtn).display : "N/A",
        stopBtnDisplay: stopBtn ? window.getComputedStyle(stopBtn).display : "N/A",
        asstHTML: asst?.innerHTML || "",
        asstText: asst?.textContent || "",
      };
    });

    if (!state.streamingActive && state.stopBtnDisplay === "none") {
      log("Response complete!");
      responseComplete = true;

      // Check for DSML remnants
      const dsmlCheck = await page.evaluate(() => {
        const allHTML = document.getElementById("chat-el")?.innerHTML || "";
        const allText = document.getElementById("chat-el")?.textContent || "";
        return {
          hasDSML_html: /DSML/.test(allHTML),
          hasDSML_text: /DSML/.test(allText),
          hasInvoke_text: /invoke/.test(allText),
          hasFunctionCalls_text: /function_calls/.test(allText),
          hasGreenCursor: allHTML.includes("stream-cursor") || allHTML.includes("streaming-active"),
          fullText: allText.slice(0, 1000),
        };
      });
      log(`Final DSML check: ${JSON.stringify(dsmlCheck)}`);

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "07-final-response.png") });
      break;
    }

    // Check for DSML during streaming
    if (i % 10 === 5) {
      const midCheck = await page.evaluate(() => {
        const el = document.querySelector(".asst-content");
        return {
          html: el?.innerHTML?.slice(0, 500) || "",
          text: el?.textContent?.slice(0, 300) || "",
          hasDSML: /DSML/.test(el?.textContent || ""),
          hasGreenCursorClass: el?.classList?.contains("streaming-active") || false,
        };
      });
      log(`Mid-stream check: DSML=${midCheck.hasDSML}, cursor=${midCheck.hasGreenCursorClass}`);
      if (midCheck.hasDSML) {
        log(`DSML text visible: ${midCheck.text.slice(0, 200)}`);
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `08-dsml-visible-${i}.png`) });
      }
    }

    await page.waitForTimeout(500);
  }

  if (!responseComplete) {
    log("WARNING: Response did not complete within timeout");
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "09-timeout.png") });
  }

  // Final: Inspect DOM for any remaining issues
  const finalInspection = await page.evaluate(() => {
    const chat = document.getElementById("chat-el");
    const asstContents = chat?.querySelectorAll(".asst-content") || [];
    const results = [];
    asstContents.forEach((el, i) => {
      results.push({
        index: i,
        hasStreamingActive: el.classList.contains("streaming-active"),
        hasStreamCursor: el.innerHTML.includes("stream-cursor"),
        hasDSML: /DSML/.test(el.textContent),
        hasInvoke: /invoke/.test(el.textContent),
        textPreview: el.textContent.slice(0, 200),
        htmlPreview: el.innerHTML.slice(0, 300),
      });
    });
    return results;
  });
  log(`Final DOM inspection: ${JSON.stringify(finalInspection, null, 2)}`);

  log("Test complete. Closing browser...");
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
