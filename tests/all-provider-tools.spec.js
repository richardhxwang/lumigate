/**
 * LumiChat All-Provider Tool Calls Test
 *
 * Tests web_search tool across all providers.
 * Run: node tests/all-provider-tools.spec.js
 *
 * Env vars:
 *   LC_EMAIL    - login email    (default: test@lumigate.local)
 *   LC_PASSWORD - login password (default: testpass123)
 *   LC_URL      - LumiChat URL   (default: http://localhost:9471/lumichat)
 */

const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const BASE_URL = process.env.LC_URL || "http://localhost:9471/lumichat";
const EMAIL = process.env.LC_EMAIL || "test@lumigate.local";
const PASSWORD = process.env.LC_PASSWORD || "testpass123";

const SCREENSHOTS_DIR = path.join(__dirname, "screenshots", "tool-tests");

// Provider → model pairs to test
const TEST_CASES = [
  { provider: "openai", model: "gpt-4.1-nano" },
  { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  { provider: "deepseek", model: "deepseek-chat" },
  { provider: "minimax", model: "MiniMax-M2" },
  { provider: "gemini", model: "gemini-2.5-flash-lite" },
];

const TEST_MESSAGE = "搜索一下今天的科技新闻";
const TIMEOUT_MS = 60000;

const results = [];

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

async function ensureTestAccount() {
  try {
    const resp = await fetch("http://localhost:9471/lc/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: EMAIL,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
        name: "Test User",
      }),
    });
    const data = await resp.json();
    if (resp.ok) {
      log(`Created test account: ${EMAIL}`);
    } else if (data.error?.includes("already") || data.message?.includes("already") || resp.status === 400) {
      log(`Test account already exists: ${EMAIL}`);
    } else {
      log(`Register response (${resp.status}): ${JSON.stringify(data)}`);
    }
  } catch (e) {
    log(`Could not register test account: ${e.message}`);
  }
}

async function login(page, context) {
  log("Authenticating via API...");
  try {
    const resp = await fetch("http://localhost:9471/lc/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      log(`API login failed (${resp.status}): ${JSON.stringify(data)}`);
      return await loginViaUI(page);
    }

    const setCookie = resp.headers.get("set-cookie") || "";
    const tokenMatch = setCookie.match(/lc_token=([^;]+)/);
    if (!tokenMatch) {
      log("API login succeeded but no lc_token cookie found. Falling back to UI.");
      return await loginViaUI(page);
    }

    const token = tokenMatch[1];
    log(`Got auth token via API (${token.slice(0, 20)}...)`);

    const url = new URL(BASE_URL);
    await context.addCookies([
      {
        name: "lc_token",
        value: token,
        domain: url.hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);

    log("Navigating to LumiChat with auth cookie...");
    await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
    log("Login successful! Chat UI is ready.");
    return true;
  } catch (e) {
    log(`API login error: ${e.message}. Falling back to UI login.`);
    return await loginViaUI(page);
  }
}

async function loginViaUI(page) {
  log("Navigating to LumiChat (UI login)...");
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForSelector("#l-email", { state: "visible", timeout: 10000 });
  log("Auth screen visible. Entering email...");

  await page.fill("#l-email", EMAIL);
  await page.click("#email-continue-btn");

  try {
    await page.waitForSelector("#auth-step-login:not([style*='display: none']):not([style*='display:none'])", {
      state: "visible",
      timeout: 5000,
    });
    log("Login step visible. Entering password...");
    await page.fill("#l-pass", PASSWORD);
    await page.click("#auth-step-login .auth-btn");
  } catch {
    log("Login step not found, trying register step...");
    await page.waitForSelector("#auth-step-register", { state: "visible", timeout: 5000 });
    await page.fill("#r-pass", PASSWORD);
    await page.fill("#r-pass2", PASSWORD);
    await page.click("#auth-step-register .auth-btn");
  }

  await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
  log("Login via UI successful!");
  return true;
}

async function selectProviderAndModel(page, providerName, modelId) {
  // Click the model button to open dropdown
  await page.click("#mdl-btn");
  await page.waitForTimeout(400);

  // Wait for dropdown to be visible
  await page.waitForSelector("#mdl-drop.open", { timeout: 3000 }).catch(() => {});

  // Click the provider pill
  const pill = await page.$(`.mdl-prov-pill[data-prov="${providerName}"]`);
  if (!pill) {
    await page.keyboard.press("Escape");
    return { ok: false, model: null, reason: "provider pill not found" };
  }

  const isLocked = await pill.evaluate(el => el.style.opacity === "0.4" || el.classList.contains("locked"));
  if (isLocked) {
    await page.keyboard.press("Escape");
    return { ok: false, model: null, reason: "provider locked (no API key)" };
  }

  await pill.click();
  await page.waitForTimeout(600);

  // Try to find the specific model, fallback to first available
  let modelOpt = await page.$(`.mdl-opt[data-model="${modelId}"]`);
  if (!modelOpt) {
    modelOpt = await page.$(".mdl-opt");
  }
  if (!modelOpt) {
    await page.keyboard.press("Escape");
    return { ok: false, model: null, reason: "no models available" };
  }

  const actualModel = await modelOpt.getAttribute("data-model");
  await modelOpt.click();
  await page.waitForTimeout(400);

  return { ok: true, model: actualModel };
}

async function enableWebSearch(page) {
  // Click web search toggle button
  const btn = await page.$("#web-search-btn");
  if (!btn) {
    log("  web-search-btn not found");
    return false;
  }
  const isActive = await btn.evaluate(el => el.classList.contains("tb-active"));
  if (!isActive) {
    await btn.click();
    await page.waitForTimeout(200);
    log("  Web search enabled");
  } else {
    log("  Web search already enabled");
  }
  return true;
}

async function startNewChat(page) {
  // Abort any ongoing stream first
  await page.evaluate(() => {
    if (typeof abortCtrl !== "undefined" && abortCtrl) {
      try { abortCtrl.abort(); } catch {}
    }
    if (typeof isStreaming !== "undefined") isStreaming = false;
    const toast = document.querySelector("#toast");
    if (toast) toast.classList.remove("show");
  });
  await page.waitForTimeout(1500); // wait for abort cleanup + async saves
  // Clear toast again after abort cleanup
  await page.evaluate(() => {
    const toast = document.querySelector("#toast");
    if (toast) toast.classList.remove("show");
  });
  try {
    await page.click("#new-chat");
    await page.waitForTimeout(800);
  } catch {
    await page.evaluate(() => { if (typeof newChat === "function") newChat(); });
    await page.waitForTimeout(800);
  }
  // Dismiss toast again after new chat
  await page.evaluate(() => {
    const toast = document.querySelector("#toast");
    if (toast) toast.classList.remove("show");
  });
}

async function testProviderTools(page, providerName, modelId) {
  log(`\n--- Testing tool calls: ${providerName} / ${modelId} ---`);

  // Start a new chat
  await startNewChat(page);

  // Select provider and model
  const sel = await selectProviderAndModel(page, providerName, modelId);
  if (!sel.ok) {
    log(`  SKIP ${providerName}: ${sel.reason}`);
    const ssPath = path.join(SCREENSHOTS_DIR, `tool-${providerName}.png`);
    await page.screenshot({ path: ssPath, fullPage: false });
    return { provider: providerName, model: modelId, status: "SKIP", reason: sel.reason, details: {} };
  }

  log(`  Selected model: ${sel.model}`);

  // Enable web search
  const searchEnabled = await enableWebSearch(page);
  if (!searchEnabled) {
    return { provider: providerName, model: sel.model, status: "FAIL", reason: "could not enable web search", details: {} };
  }

  // Dismiss any toast before sending
  await page.evaluate(() => {
    const toast = document.querySelector("#toast");
    if (toast) toast.classList.remove("show");
  });

  // Send test message
  await page.fill("#msg-in", TEST_MESSAGE);
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    if (typeof sendMessage === "function") sendMessage();
  });
  await page.waitForTimeout(500); // give time for send to initiate

  // Monitor for various states
  const startTime = Date.now();
  let sawSearchIndicator = false;
  let sawSearchResults = false;
  let sawToolTag = false;
  let sawTypingDots = false;
  let finalText = "";
  let pollCount = 0;

  while (Date.now() - startTime < TIMEOUT_MS) {
    const state = await page.evaluate(() => {
      const rows = document.querySelectorAll(".msg-row.assistant");
      const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
      const content = lastRow?.querySelector(".asst-content");
      const html = content ? content.innerHTML : "";
      const text = content ? content.innerText : "";

      // Check for typing dots
      const typRow = document.getElementById("typ-row");
      const hasDots = !!typRow;

      // Check for search indicator (gray text with "web search:" or "Searching:")
      const hasSearchIndicator = html.includes("color:var(--t3)") && (html.includes("web search") || html.includes("Searching") || html.includes("web_search"));

      // Check for search results card
      const hasSearchResults = html.includes("Search Results") || html.includes("search-result");

      // Check for leaked tool tags
      const hasToolTags = /\[TOOL:|<tool_call>|<minimax:tool_call>|DSML/.test(text);

      // Check streaming state
      const streaming = typeof isStreaming !== "undefined" ? isStreaming : false;

      return {
        text: text.trim(),
        html: html.slice(0, 500),
        hasDots,
        hasSearchIndicator,
        hasSearchResults,
        hasToolTags,
        streaming,
        rowCount: rows.length,
      };
    });

    if (state.hasDots) sawTypingDots = true;
    if (state.hasSearchIndicator) sawSearchIndicator = true;
    if (state.hasSearchResults) sawSearchResults = true;
    if (state.hasToolTags) sawToolTag = true;

    // Log first detection
    if (pollCount % 10 === 0 || state.hasSearchIndicator || state.hasSearchResults) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      log(`  [${elapsed}s] streaming=${state.streaming} dots=${state.hasDots} indicator=${state.hasSearchIndicator} results=${state.hasSearchResults} textLen=${state.text.length}`);
    }

    // Done: has text, not streaming
    if (state.text && state.text.length > 0 && !state.streaming) {
      finalText = state.text;
      break;
    }

    // Check for error toast
    const errorText = await page.evaluate(() => {
      const toast = document.querySelector("#toast");
      if (toast && toast.classList.contains("show")) return toast.textContent;
      return null;
    });
    if (errorText) {
      log(`  ERROR toast: ${errorText}`);
      const ssPath = path.join(SCREENSHOTS_DIR, `tool-${providerName}-error.png`);
      await page.screenshot({ path: ssPath, fullPage: false });
      return {
        provider: providerName, model: sel.model, status: "FAIL",
        reason: `error: ${errorText}`,
        details: { sawSearchIndicator, sawSearchResults, sawToolTag, sawTypingDots },
      };
    }

    pollCount++;
    await page.waitForTimeout(500);
  }

  // Get final state
  if (!finalText) {
    const finalState = await page.evaluate(() => {
      const rows = document.querySelectorAll(".msg-row.assistant .asst-content");
      const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
      return lastRow ? lastRow.innerText : "";
    });
    finalText = (finalState || "").trim();
  }

  // Check for leaked tags in final text
  const hasLeakedTags = /\[TOOL:\w+\]|\[\/TOOL\]|<tool_call>|<\/tool_call>|<minimax:tool_call>|DSML|<invoke |<parameter /.test(finalText);

  // Take screenshot
  const ssPath = path.join(SCREENSHOTS_DIR, `tool-${providerName}.png`);
  await page.screenshot({ path: ssPath, fullPage: false });

  // Determine status
  const details = {
    sawSearchIndicator,
    sawSearchResults,
    sawToolTag,
    sawTypingDots,
    hasLeakedTags,
    finalTextLen: finalText.length,
    finalTextPreview: finalText.slice(0, 100).replace(/\n/g, " "),
  };

  let status = "PASS";
  let reason = "";

  if (!finalText || finalText.length === 0) {
    status = "FAIL";
    reason = "no response text";
  } else if (hasLeakedTags) {
    status = "FAIL";
    reason = "leaked tool tags in final output";
  } else if (!sawSearchIndicator && !sawSearchResults) {
    // Tool didn't trigger — may be acceptable if model chose not to search
    status = "WARN";
    reason = "no search indicator or results seen (model may not have used tool)";
  }

  log(`  ${status} ${providerName}: indicator=${sawSearchIndicator} results=${sawSearchResults} leaked=${hasLeakedTags} textLen=${finalText.length}`);
  if (reason) log(`  Reason: ${reason}`);

  return { provider: providerName, model: sel.model, status, reason, details };
}

async function main() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  await ensureTestAccount();

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Capture console for debugging
  page.on("console", msg => {
    if (msg.type() === "error") {
      log(`  [CONSOLE ERROR] ${msg.text().slice(0, 200)}`);
    }
  });

  // Monitor network for debugging
  page.on("response", async resp => {
    const url = resp.url();
    if (url.includes("/v1/") && resp.status() >= 400) {
      let body = "";
      try { body = await resp.text(); } catch {}
      log(`  [HTTP ${resp.status()}] ${url.split("/v1/")[1]?.slice(0, 60)} → ${body.slice(0, 200)}`);
    }
  });

  try {
    const loggedIn = await login(page, context);
    if (!loggedIn) {
      log("FATAL: Could not log in. Aborting.");
      process.exit(1);
    }

    for (const tc of TEST_CASES) {
      try {
        const result = await testProviderTools(page, tc.provider, tc.model);
        results.push(result);
      } catch (e) {
        log(`ERROR testing ${tc.provider}: ${e.message}`);
        const ssPath = path.join(SCREENSHOTS_DIR, `tool-${tc.provider}-error.png`);
        await page.screenshot({ path: ssPath }).catch(() => {});
        results.push({
          provider: tc.provider, model: tc.model, status: "FAIL",
          reason: e.message.slice(0, 100),
          details: {},
        });
      }
    }
  } finally {
    await browser.close();
  }

  // Print summary table
  console.log("\n" + "=".repeat(110));
  console.log("ALL-PROVIDER TOOL CALLS TEST SUMMARY");
  console.log("=".repeat(110));
  console.log(
    "Provider".padEnd(12) +
    "Status".padEnd(8) +
    "Model".padEnd(32) +
    "Indicator".padEnd(12) +
    "Results".padEnd(10) +
    "Leaked".padEnd(9) +
    "Reason"
  );
  console.log("-".repeat(110));

  let pass = 0, fail = 0, skip = 0, warn = 0;
  for (const r of results) {
    const d = r.details || {};
    console.log(
      r.provider.padEnd(12) +
      r.status.padEnd(8) +
      (r.model || "-").padEnd(32) +
      String(d.sawSearchIndicator ?? "-").padEnd(12) +
      String(d.sawSearchResults ?? "-").padEnd(10) +
      String(d.hasLeakedTags ?? "-").padEnd(9) +
      (r.reason || "").slice(0, 40)
    );
    if (r.status === "PASS") pass++;
    else if (r.status === "FAIL") fail++;
    else if (r.status === "WARN") warn++;
    else skip++;
  }

  console.log("-".repeat(110));
  console.log(`Total: ${results.length} | PASS: ${pass} | WARN: ${warn} | FAIL: ${fail} | SKIP: ${skip}`);
  console.log("=".repeat(110));

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
