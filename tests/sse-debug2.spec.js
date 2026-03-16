/**
 * SSE Debug Test 2 — Capture raw DSML bytes and check post-tool typing dots
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

(async () => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Intercept SSE responses to capture raw bytes
  const rawSSEData = [];
  page.on("request", (request) => {
    if (request.url().includes("/chat/completions")) {
      log("Intercepting chat completions request");
    }
  });

  // Use CDP to intercept raw response data
  const client = await context.newCDPSession(page);
  await client.send("Network.enable");

  const sseResponseBodies = [];
  let sseRequestId = null;

  client.on("Network.responseReceived", (params) => {
    if (params.response.url.includes("/chat/completions")) {
      sseRequestId = params.requestId;
      log(`SSE response received, requestId: ${sseRequestId}`);
    }
  });

  client.on("Network.dataReceived", (params) => {
    if (params.requestId === sseRequestId) {
      // Can't get body here directly, but we can track the data
    }
  });

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

  // Inject SSE interceptor to capture raw streaming data
  await page.evaluate(() => {
    window.__sseRawChunks = [];
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const resp = await origFetch.apply(this, args);
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (url.includes('/chat/completions')) {
        const origBody = resp.body;
        const [s1, s2] = origBody.tee();
        const reader = s2.getReader();
        const dec = new TextDecoder();
        (async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = dec.decode(value, { stream: true });
            window.__sseRawChunks.push(text);
          }
        })();
        return new Response(s1, { headers: resp.headers, status: resp.status, statusText: resp.statusText });
      }
      return resp;
    };
  });

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
  await page.fill("#msg-in", "搜索一下今天的天气北京");
  await page.click("#send-btn");
  log("Message sent");

  // Monitor stages closely
  let lastState = "";
  const stages = [];

  for (let i = 0; i < 120; i++) {
    const state = await page.evaluate(() => {
      const typRow = document.getElementById("typ-row");
      const rows = document.querySelectorAll(".msg-row.assistant");
      const results = [];
      rows.forEach((r, idx) => {
        const asst = r.querySelector(".asst-content");
        const typing = r.querySelector(".typing");
        results.push({
          index: idx,
          display: window.getComputedStyle(r).display,
          hasAsst: !!asst,
          hasTyping: !!typing,
          streamingActive: asst?.classList?.contains("streaming-active") || false,
          textLen: asst?.textContent?.length || 0,
          textPreview: asst?.textContent?.slice(0, 80) || "",
          htmlPreview: asst?.innerHTML?.slice(0, 150) || "",
        });
      });
      return {
        typRow: typRow ? { exists: true, display: window.getComputedStyle(typRow).display, html: typRow.innerHTML.slice(0, 100) } : { exists: false },
        asstRows: results,
        stopBtn: window.getComputedStyle(document.getElementById("stop-btn")).display,
      };
    });

    const stateKey = JSON.stringify(state);
    if (stateKey !== lastState) {
      lastState = stateKey;
      const stage = { iteration: i, time: Date.now(), ...state };
      stages.push(stage);
      log(`State change at i=${i}: typRow=${state.typRow.exists}(${state.typRow.display || ""}), asstRows=${state.asstRows.length}, stopBtn=${state.stopBtn}`);

      if (state.asstRows.length > 0) {
        const lastAsst = state.asstRows[state.asstRows.length - 1];
        log(`  Last asst: display=${lastAsst.display}, streaming=${lastAsst.streamingActive}, textLen=${lastAsst.textLen}, text="${lastAsst.textPreview.slice(0, 60)}"`);
      }

      // Check for DSML in raw text
      if (state.asstRows.some(r => /DSML|invoke|function_call/.test(r.textPreview))) {
        log(`  DSML FOUND IN TEXT: ${state.asstRows.map(r => r.textPreview).join(" | ")}`);
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `dsml-found-${i}.png`) });
      }

      // Screenshot on key transitions
      if (i <= 3 || state.asstRows.some(r => r.textPreview.includes("search") || r.textPreview.includes("web"))) {
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `state-${String(i).padStart(3, "0")}.png`) });
      }
    }

    if (state.stopBtn === "none" && i > 5) {
      log("Stream complete (stop button hidden)");
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "final.png") });
      break;
    }

    await page.waitForTimeout(300);
  }

  // Capture raw SSE data for DSML analysis
  const rawChunks = await page.evaluate(() => window.__sseRawChunks || []);
  const allSSE = rawChunks.join("");

  // Search for DSML-like patterns in raw SSE
  const dsmlPatterns = allSSE.match(/<[^\s<>]{0,5}DSML[^\s<>]{0,5}[^>]*>/g) || [];
  const dsmlClosePatterns = allSSE.match(/<\/[^\s<>]{0,5}DSML[^\s<>]{0,5}[^>]*>/g) || [];
  const invokePatterns = allSSE.match(/<[^\s<>]{0,5}invoke[^>]*>/g) || [];

  log(`\nRaw SSE DSML patterns found: ${dsmlPatterns.length}`);
  dsmlPatterns.forEach(p => {
    log(`  Pattern: "${p}"`);
    // Show hex bytes for the separator characters
    const bytes = [...p].map(c => `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join(" ");
    log(`  Bytes: ${bytes}`);
  });

  log(`Raw SSE DSML close patterns: ${dsmlClosePatterns.length}`);
  dsmlClosePatterns.forEach(p => {
    log(`  Close: "${p}"`);
    const bytes = [...p].map(c => `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join(" ");
    log(`  Bytes: ${bytes}`);
  });

  log(`Raw SSE invoke patterns: ${invokePatterns.length}`);
  invokePatterns.forEach(p => log(`  Invoke: "${p}"`));

  // Also check for any visible residual tags in final DOM
  const finalCheck = await page.evaluate(() => {
    const chat = document.getElementById("chat-el");
    const text = chat?.textContent || "";
    const html = chat?.innerHTML || "";
    return {
      hasDSML: /DSML/.test(text),
      hasInvoke: /invoke/.test(text),
      hasStreamCursor: html.includes("stream-cursor"),
      hasStreamingActive: html.includes("streaming-active"),
      greenCursorElements: chat?.querySelectorAll(".streaming-active, .stream-cursor")?.length || 0,
    };
  });
  log(`\nFinal DOM check: ${JSON.stringify(finalCheck)}`);

  // Save raw SSE data for analysis
  fs.writeFileSync(path.join(SCREENSHOTS_DIR, "raw-sse.txt"), allSSE.slice(0, 50000));
  log("Saved raw SSE data to raw-sse.txt");

  // Summary
  log("\n=== STAGE TRANSITIONS ===");
  stages.forEach(s => {
    log(`  i=${s.iteration}: typRow=${s.typRow.exists}, asstRows=${s.asstRows.length}, stop=${s.stopBtn}`);
  });

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
