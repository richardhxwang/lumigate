/**
 * LumiChat Provider E2E Test
 *
 * Tests all providers by sending a message through LumiChat and verifying a response.
 * Run: node tests/provider-test.spec.js
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

const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");

// Providers to test via API key mode
const API_PROVIDERS = ["openai", "anthropic", "gemini", "deepseek", "minimax"];

// Collector-mode providers (skip)
const COLLECTOR_PROVIDERS = ["kimi", "doubao", "qwen"];

const TEST_MESSAGE = "Hello, reply in Chinese briefly.";

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

async function selectProviderAndModel(page, providerName) {
  // Click the model button to open dropdown
  await page.click("#mdl-btn");
  await page.waitForTimeout(400);

  // Wait for dropdown to be visible
  await page.waitForSelector("#mdl-drop.open", { timeout: 3000 }).catch(() => {});

  // Click the provider pill
  const pill = await page.$(`.mdl-prov-pill[data-prov="${providerName}"]`);
  if (!pill) {
    log(`Provider pill not found for: ${providerName}`);
    // Close dropdown
    await page.keyboard.press("Escape");
    return { ok: false, model: null, reason: "provider pill not found" };
  }

  // Check if it's locked/dimmed (no API key)
  const isLocked = await pill.evaluate(el => el.style.opacity === "0.4" || el.classList.contains("locked"));
  if (isLocked) {
    await page.keyboard.press("Escape");
    return { ok: false, model: null, reason: "provider locked (no API key)" };
  }

  await pill.click();
  await page.waitForTimeout(600);

  // Pick the first available model option
  const modelOpt = await page.$(".mdl-opt");
  if (!modelOpt) {
    await page.keyboard.press("Escape");
    return { ok: false, model: null, reason: "no models available" };
  }

  const modelId = await modelOpt.getAttribute("data-model");
  await modelOpt.click();
  await page.waitForTimeout(400);

  return { ok: true, model: modelId };
}

async function sendMessageAndWait(page, message, timeoutMs = 30000) {
  // Type the message using page.fill (triggers input event)
  await page.fill("#msg-in", message);
  await page.waitForTimeout(200);

  // Trigger sendMessage() directly via JS to avoid IME issues
  await page.evaluate(() => {
    if (typeof sendMessage === "function") sendMessage();
  });

  // Wait for assistant response to appear
  const startTime = Date.now();
  let responseText = "";

  while (Date.now() - startTime < timeoutMs) {
    // Check if streaming is done
    const state = await page.evaluate(() => {
      const rows = document.querySelectorAll(".msg-row.assistant .asst-content");
      const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
      const text = lastRow ? lastRow.innerText : "";
      return {
        text: text,
        isStreaming: typeof isStreaming !== "undefined" ? isStreaming : false,
        rowCount: rows.length,
      };
    });

    if (state.text && state.text.trim().length > 3 && !state.isStreaming) {
      return { ok: true, text: state.text.trim() };
    }

    // Also check for error toast
    const errorText = await page.evaluate(() => {
      const toast = document.querySelector("#toast");
      if (toast && toast.classList.contains("show")) return toast.textContent;
      return null;
    });
    if (errorText) {
      return { ok: false, text: "", reason: `error: ${errorText}` };
    }

    await page.waitForTimeout(500);
  }

  // Timeout - get whatever text we have
  const finalState = await page.evaluate(() => {
    const rows = document.querySelectorAll(".msg-row.assistant .asst-content");
    const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
    return lastRow ? lastRow.innerText : "";
  });

  if (finalState && finalState.trim().length > 0) {
    return { ok: true, text: finalState.trim() };
  }
  return { ok: false, text: "", reason: "timeout waiting for response" };
}

async function startNewChat(page) {
  // Click the new chat button
  try {
    await page.click("#new-chat");
    await page.waitForTimeout(600);
  } catch {
    // If that fails, call newChat() directly
    await page.evaluate(() => { if (typeof newChat === "function") newChat(); });
    await page.waitForTimeout(600);
  }
}

async function testProvider(page, providerName) {
  log(`--- Testing provider: ${providerName} ---`);

  // Start a new chat
  await startNewChat(page);

  // Select provider and model
  const sel = await selectProviderAndModel(page, providerName);
  if (!sel.ok) {
    log(`SKIP ${providerName}: ${sel.reason}`);
    const ssPath = path.join(SCREENSHOTS_DIR, `provider-${providerName}.png`);
    await page.screenshot({ path: ssPath, fullPage: false });
    return { provider: providerName, status: "SKIP", reason: sel.reason, model: null, preview: "" };
  }

  log(`Selected model: ${sel.model}`);

  // Send test message
  const resp = await sendMessageAndWait(page, TEST_MESSAGE);

  // Take screenshot
  const ssPath = path.join(SCREENSHOTS_DIR, `provider-${providerName}.png`);
  await page.screenshot({ path: ssPath, fullPage: false });

  if (resp.ok) {
    const preview = resp.text.slice(0, 80).replace(/\n/g, " ");
    log(`PASS ${providerName} (${sel.model}): ${preview}`);
    return { provider: providerName, status: "PASS", model: sel.model, preview, reason: "" };
  } else {
    log(`FAIL ${providerName} (${sel.model}): ${resp.reason}`);
    return { provider: providerName, status: "FAIL", model: sel.model, preview: "", reason: resp.reason };
  }
}

async function main() {
  // Ensure screenshots dir exists
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  await ensureTestAccount();

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  try {
    const loggedIn = await login(page, context);
    if (!loggedIn) {
      log("FATAL: Could not log in. Aborting.");
      process.exit(1);
    }

    // Test API-key providers
    for (const prov of API_PROVIDERS) {
      try {
        const result = await testProvider(page, prov);
        results.push(result);
      } catch (e) {
        log(`ERROR testing ${prov}: ${e.message}`);
        const ssPath = path.join(SCREENSHOTS_DIR, `provider-${prov}-error.png`);
        await page.screenshot({ path: ssPath }).catch(() => {});
        results.push({ provider: prov, status: "FAIL", model: null, preview: "", reason: e.message.slice(0, 100) });
      }
    }

    // Log collector-mode providers as SKIP
    for (const prov of COLLECTOR_PROVIDERS) {
      log(`SKIP ${prov}: collector mode (unavailable)`);
      results.push({ provider: prov, status: "SKIP", model: null, preview: "", reason: "collector unavailable" });
    }

  } finally {
    await browser.close();
  }

  // Print summary table
  console.log("\n" + "=".repeat(100));
  console.log("PROVIDER TEST SUMMARY");
  console.log("=".repeat(100));
  console.log(
    "Provider".padEnd(12) +
    "Status".padEnd(8) +
    "Model".padEnd(30) +
    "Preview / Reason"
  );
  console.log("-".repeat(100));

  let pass = 0, fail = 0, skip = 0;
  for (const r of results) {
    const detail = r.status === "PASS" ? r.preview : (r.reason || "");
    console.log(
      r.provider.padEnd(12) +
      r.status.padEnd(8) +
      (r.model || "-").padEnd(30) +
      detail.slice(0, 50)
    );
    if (r.status === "PASS") pass++;
    else if (r.status === "FAIL") fail++;
    else skip++;
  }

  console.log("-".repeat(100));
  console.log(`Total: ${results.length} | PASS: ${pass} | FAIL: ${fail} | SKIP: ${skip}`);
  console.log("=".repeat(100));

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
