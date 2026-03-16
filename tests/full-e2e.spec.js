/**
 * LumiChat Full E2E Provider Test
 *
 * Tests EVERY provider with text capability by sending a message and verifying response.
 * Run: node tests/full-e2e.spec.js
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

const SCREENSHOTS_DIR = path.join(__dirname, "screenshots", "full-e2e");

// Provider → preferred model mapping (API key mode only)
const PROVIDERS = [
  { name: "openai", model: "gpt-4.1-nano", capabilities: ["text", "vision"] },
  { name: "anthropic", model: "claude-haiku-4-5-20251001", capabilities: ["text"] },
  { name: "gemini", model: "gemini-2.5-flash-lite", capabilities: ["text"] },
  { name: "deepseek", model: "deepseek-chat", capabilities: ["text"] },
  { name: "minimax", model: "MiniMax-M2", capabilities: ["text"] },
];

const TEST_MESSAGE = "你好，用中文回答，1+1等于几";
const RESPONSE_TIMEOUT = 45000;

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
        name: "E2E Test User",
      }),
    });
    const data = await resp.json();
    if (resp.ok) {
      log(`Created test account: ${EMAIL}`);
    } else if (
      data.error?.includes("already") ||
      data.message?.includes("already") ||
      resp.status === 400
    ) {
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
      log("API login succeeded but no lc_token cookie. Falling back to UI.");
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
    await page.waitForSelector(
      "#auth-step-login:not([style*='display: none']):not([style*='display:none'])",
      { state: "visible", timeout: 5000 }
    );
    log("Login step visible. Entering password...");
    await page.fill("#l-pass", PASSWORD);
    await page.click("#auth-step-login .auth-btn");
  } catch {
    log("Login step not found, trying register step...");
    await page.waitForSelector("#auth-step-register", {
      state: "visible",
      timeout: 5000,
    });
    await page.fill("#r-pass", PASSWORD);
    await page.fill("#r-pass2", PASSWORD);
    await page.click("#auth-step-register .auth-btn");
  }

  await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
  log("Login via UI successful!");
  return true;
}

async function selectProviderAndModel(page, providerName, preferredModel) {
  // Click the model button to open dropdown
  await page.click("#mdl-btn");
  await page.waitForTimeout(400);

  // Wait for dropdown
  await page.waitForSelector("#mdl-drop.open", { timeout: 3000 }).catch(() => {});

  // Click provider pill
  const pill = await page.$(`.mdl-prov-pill[data-prov="${providerName}"]`);
  if (!pill) {
    log(`Provider pill not found: ${providerName}`);
    await page.keyboard.press("Escape");
    return { ok: false, model: null, reason: "provider pill not found" };
  }

  // Check if locked
  const isLocked = await pill.evaluate(
    (el) => el.style.opacity === "0.4" || el.classList.contains("locked")
  );
  if (isLocked) {
    await page.keyboard.press("Escape");
    return { ok: false, model: null, reason: "provider locked (no API key)" };
  }

  await pill.click();
  await page.waitForTimeout(600);

  // Try to find the preferred model first
  let modelOpt = await page.$(`.mdl-opt[data-model="${preferredModel}"]`);
  let actualModel = preferredModel;

  if (!modelOpt) {
    log(`Preferred model ${preferredModel} not found, picking first available`);
    modelOpt = await page.$(".mdl-opt");
    if (!modelOpt) {
      await page.keyboard.press("Escape");
      return { ok: false, model: null, reason: "no models available" };
    }
    actualModel = await modelOpt.getAttribute("data-model");
  }

  await modelOpt.click();
  await page.waitForTimeout(400);

  return { ok: true, model: actualModel };
}

async function sendMessageAndWait(page, message, timeoutMs = RESPONSE_TIMEOUT) {
  // Type and send
  await page.fill("#msg-in", message);
  await page.waitForTimeout(200);

  await page.evaluate(() => {
    if (typeof sendMessage === "function") sendMessage();
  });

  const startTime = Date.now();
  let lastText = "";

  while (Date.now() - startTime < timeoutMs) {
    const state = await page.evaluate(() => {
      const rows = document.querySelectorAll(".msg-row.assistant .asst-content");
      const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
      const text = lastRow ? lastRow.innerText : "";
      return {
        text,
        isStreaming: typeof isStreaming !== "undefined" ? isStreaming : false,
        rowCount: rows.length,
      };
    });

    if (state.text && state.text.trim().length > 3 && !state.isStreaming) {
      return { ok: true, text: state.text.trim() };
    }

    // Track that content is arriving (for logging)
    if (state.text && state.text !== lastText) {
      lastText = state.text;
    }

    // Check for error toast
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

  // Timeout — get whatever we have
  const finalText = await page.evaluate(() => {
    const rows = document.querySelectorAll(".msg-row.assistant .asst-content");
    const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
    return lastRow ? lastRow.innerText : "";
  });

  if (finalText && finalText.trim().length > 0) {
    return { ok: true, text: finalText.trim() };
  }
  return { ok: false, text: "", reason: "timeout waiting for response" };
}

async function startNewChat(page) {
  try {
    await page.click("#new-chat");
    await page.waitForTimeout(600);
  } catch {
    await page.evaluate(() => {
      if (typeof newChat === "function") newChat();
    });
    await page.waitForTimeout(600);
  }
}

async function testProvider(page, provider) {
  const { name, model, capabilities } = provider;
  log(`\n--- Testing ${name} (${model}) [${capabilities.join(", ")}] ---`);

  await startNewChat(page);

  // Select provider and model
  const sel = await selectProviderAndModel(page, name, model);
  if (!sel.ok) {
    log(`SKIP ${name}: ${sel.reason}`);
    const ssPath = path.join(SCREENSHOTS_DIR, `${name}.png`);
    await page.screenshot({ path: ssPath, fullPage: false });
    return {
      provider: name,
      model: null,
      status: "SKIP",
      reason: sel.reason,
      preview: "",
    };
  }

  log(`Selected model: ${sel.model}`);

  // Text test
  log(`Sending text message to ${name}...`);
  const resp = await sendMessageAndWait(page, TEST_MESSAGE, RESPONSE_TIMEOUT);

  // Screenshot
  const ssPath = path.join(SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: ssPath, fullPage: false });

  if (resp.ok) {
    const preview = resp.text.slice(0, 100).replace(/\n/g, " ");
    log(`PASS ${name} (${sel.model}): ${preview}`);
    return {
      provider: name,
      model: sel.model,
      status: "PASS",
      reason: "",
      preview,
    };
  } else {
    log(`FAIL ${name} (${sel.model}): ${resp.reason}`);
    return {
      provider: name,
      model: sel.model,
      status: "FAIL",
      reason: resp.reason,
      preview: "",
    };
  }
}

async function main() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  log("=== LumiChat Full E2E Provider Test ===");
  log(`URL: ${BASE_URL}`);
  log(`Providers: ${PROVIDERS.map((p) => p.name).join(", ")}`);
  log(`Test message: ${TEST_MESSAGE}`);
  log(`Timeout per provider: ${RESPONSE_TIMEOUT / 1000}s`);

  await ensureTestAccount();

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  // Capture console errors
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      log(`[CONSOLE ERROR] ${msg.text()}`);
    }
  });

  try {
    const loggedIn = await login(page, context);
    if (!loggedIn) {
      log("FATAL: Could not log in. Aborting.");
      process.exit(1);
    }

    // Test each provider
    for (const provider of PROVIDERS) {
      try {
        const result = await testProvider(page, provider);
        results.push(result);
      } catch (e) {
        log(`ERROR testing ${provider.name}: ${e.message}`);
        const ssPath = path.join(SCREENSHOTS_DIR, `${provider.name}-error.png`);
        await page.screenshot({ path: ssPath }).catch(() => {});
        results.push({
          provider: provider.name,
          model: provider.model,
          status: "FAIL",
          reason: e.message.slice(0, 100),
          preview: "",
        });
      }
    }
  } finally {
    await browser.close();
  }

  // Summary
  console.log("\n" + "=".repeat(110));
  console.log("FULL E2E PROVIDER TEST SUMMARY");
  console.log("=".repeat(110));
  console.log(
    "Provider".padEnd(14) +
      "Model".padEnd(35) +
      "Status".padEnd(8) +
      "Detail"
  );
  console.log("-".repeat(110));

  let pass = 0,
    fail = 0,
    skip = 0;
  for (const r of results) {
    const detail =
      r.status === "PASS" ? r.preview.slice(0, 50) : r.reason || "";
    console.log(
      r.provider.padEnd(14) +
        (r.model || "-").padEnd(35) +
        r.status.padEnd(8) +
        detail
    );
    if (r.status === "PASS") pass++;
    else if (r.status === "FAIL") fail++;
    else skip++;
  }

  console.log("-".repeat(110));
  console.log(
    `Total: ${results.length} | PASS: ${pass} | FAIL: ${fail} | SKIP: ${skip}`
  );
  console.log("=".repeat(110));

  // Screenshots location
  console.log(`\nScreenshots saved to: ${SCREENSHOTS_DIR}`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
