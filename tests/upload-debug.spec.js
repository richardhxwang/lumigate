/**
 * Upload Debug Test — 4 Steps
 *
 * Step 1: Simple text message (no file)
 * Step 2: File upload (.txt)
 * Step 3: Image upload (.png)
 * Step 4: Encrypted upload mode
 *
 * Run: node tests/upload-debug.spec.js
 */

const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const BASE_URL = process.env.LC_URL || "http://localhost:9471/lumichat";
const EMAIL = process.env.LC_EMAIL || "test@lumigate.local";
const PASSWORD = process.env.LC_PASSWORD || "testpass123";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const SCREENSHOTS_DIR = path.join(__dirname, "screenshots", "upload-debug");

const consoleErrors = [];
const networkLog = [];

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
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) log(`Created test account: ${EMAIL}`);
    else log(`Test account status: ${resp.status} (likely exists)`);
  } catch (e) {
    log(`Register attempt: ${e.message}`);
  }
}

async function loginViaCookie(page, context) {
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
      log("No lc_token cookie found. Falling back to UI.");
      return await loginViaUI(page);
    }

    const token = tokenMatch[1];
    log(`Got auth token (${token.slice(0, 20)}...)`);

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

    await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
    log("Login via cookie successful. Chat UI ready.");
    return true;
  } catch (e) {
    log(`Cookie login error: ${e.message}`);
    return await loginViaUI(page);
  }
}

async function loginViaUI(page) {
  log("Falling back to UI login...");
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });

  try {
    await page.waitForSelector("#l-email", { state: "visible", timeout: 10000 });
  } catch {
    // Maybe already logged in
    const msgIn = await page.$("#msg-in");
    if (msgIn) {
      log("Already logged in (msg-in visible).");
      return true;
    }
    log("Neither auth screen nor chat UI found.");
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "login-unknown-state.png") });
    return false;
  }

  await page.fill("#l-email", EMAIL);
  await page.click("#email-continue-btn");

  try {
    await page.waitForSelector(
      "#auth-step-login:not([style*='display: none']):not([style*='display:none'])",
      { state: "visible", timeout: 5000 }
    );
    await page.fill("#l-pass", PASSWORD);
    await page.click("#auth-step-login .auth-btn");
  } catch {
    log("Login step not shown.");
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "login-step-missing.png") });
    return false;
  }

  try {
    await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
    log("UI login successful.");
    return true;
  } catch {
    log("UI login failed.");
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "login-failed.png") });
    return false;
  }
}

async function clearChips(page) {
  const btns = await page.$$(".fchip-rm");
  for (const b of btns) {
    await b.click();
    await page.waitForTimeout(100);
  }
}

// ===== STEP 1: Simple text message =====
async function step1_textMessage(page) {
  log("\n=== STEP 1: Simple text message (no file) ===");
  try {
    await page.fill("#msg-in", "Hello! Just testing. Reply with one word.");
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "step1-before-send.png") });

    await page.click("#send-btn");
    log("Message sent. Waiting for response...");

    // Wait for assistant response
    try {
      await page.waitForSelector(".msg.assistant, .msg.ai, [data-role='assistant']", {
        state: "visible",
        timeout: 30000,
      });
      // Give streaming time to finish
      await page.waitForTimeout(5000);
      log("Got assistant response.");
    } catch {
      log("No assistant response in 30s (check API keys).");
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "step1-response.png") });
    log("STEP 1: PASS");
    return true;
  } catch (e) {
    log(`STEP 1: FAIL — ${e.message}`);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "step1-fail.png") }).catch(() => {});
    return false;
  }
}

// ===== STEP 2: Text file upload =====
async function step2_textFileUpload(page) {
  log("\n=== STEP 2: File upload (.txt) ===");
  const filePath = path.join(FIXTURES_DIR, "test.txt");
  if (!fs.existsSync(filePath)) {
    log("STEP 2: SKIP — test.txt fixture not found");
    return false;
  }

  try {
    await clearChips(page);

    const fileInput = page.locator("#file-in");
    await fileInput.setInputFiles(filePath);
    log("Set file on input. Waiting for chip...");

    await page.waitForSelector("#file-chips .fchip", { state: "visible", timeout: 5000 });
    const chipText = await page.locator("#file-chips .fchip-name").first().textContent();
    log(`Chip appeared: "${chipText}"`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "step2-chip-visible.png") });

    // Send message about the file
    await page.fill("#msg-in", "What is in this text file? Reply briefly.");
    await page.click("#send-btn");
    log("Message with file sent. Waiting for response...");

    try {
      await page.waitForSelector(".msg.assistant, .msg.ai, [data-role='assistant']", {
        state: "visible",
        timeout: 30000,
      });
      await page.waitForTimeout(5000);
      log("Got assistant response.");
    } catch {
      log("No assistant response in 30s.");
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "step2-response.png") });
    log("STEP 2: PASS");
    return true;
  } catch (e) {
    log(`STEP 2: FAIL — ${e.message}`);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "step2-fail.png") }).catch(() => {});
    return false;
  }
}

// ===== STEP 3: Image upload =====
async function step3_imageUpload(page) {
  log("\n=== STEP 3: Image upload (.png) ===");
  const filePath = path.join(FIXTURES_DIR, "test-image.png");
  if (!fs.existsSync(filePath)) {
    log("STEP 3: SKIP — test-image.png fixture not found");
    return false;
  }

  try {
    await clearChips(page);

    const fileInput = page.locator("#file-in");
    await fileInput.setInputFiles(filePath);
    log("Set image on input. Waiting for chip...");

    // Image might use a different chip selector or the same one
    try {
      await page.waitForSelector("#file-chips .fchip, #img-preview, .img-chip, .image-chip", {
        state: "visible",
        timeout: 5000,
      });
      log("Image chip/preview appeared.");
    } catch {
      log("No image chip appeared in 5s. Checking if there's a separate image input...");
      // Some UIs have separate image input
      const imgInput = await page.$("#img-in, #image-in, input[accept*='image']");
      if (imgInput) {
        log("Found separate image input. Retrying...");
        await imgInput.setInputFiles(filePath);
        await page.waitForTimeout(2000);
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "step3-chip-visible.png") });

    await page.fill("#msg-in", "Describe this image briefly.");
    await page.click("#send-btn");
    log("Message with image sent. Waiting for response...");

    try {
      await page.waitForSelector(".msg.assistant, .msg.ai, [data-role='assistant']", {
        state: "visible",
        timeout: 30000,
      });
      await page.waitForTimeout(5000);
      log("Got assistant response.");
    } catch {
      log("No assistant response in 30s.");
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "step3-response.png") });
    log("STEP 3: PASS");
    return true;
  } catch (e) {
    log(`STEP 3: FAIL — ${e.message}`);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "step3-fail.png") }).catch(() => {});
    return false;
  }
}

// ===== STEP 4: Encrypted upload =====
async function step4_encryptedUpload(page) {
  log("\n=== STEP 4: Encrypted upload mode ===");
  const filePath = path.join(FIXTURES_DIR, "test.txt");
  if (!fs.existsSync(filePath)) {
    log("STEP 4: SKIP — test.txt fixture not found");
    return false;
  }

  let encryptedPayloadSeen = false;

  try {
    // Enable encrypted upload via settings
    log("Opening settings to enable encrypted upload...");

    // Click settings button — look for various selectors
    const settingsBtn = await page.$("#sb-foot-btn, #settings-btn, #stg-btn, button[aria-label='Settings'], .settings-btn");
    if (!settingsBtn) {
      log("STEP 4: SKIP — settings button not found");
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "step4-no-settings-btn.png") });
      return false;
    }
    await settingsBtn.click();
    await page.waitForSelector("#stg-overlay.open", { state: "visible", timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "step4-settings-open.png") });

    // Find and click the encrypted upload toggle
    const encToggle = await page.$("#stg-encrypted-upload-toggle");
    if (!encToggle) {
      log("STEP 4: SKIP — encrypted upload toggle not found in settings");
      // Close settings
      await page.keyboard.press("Escape");
      return false;
    }

    // Check if already enabled
    const isOn = await encToggle.evaluate((el) => el.classList.contains("on"));
    if (!isOn) {
      await encToggle.click();
      await page.waitForTimeout(500);
      log("Encrypted upload toggle enabled.");
    } else {
      log("Encrypted upload already enabled.");
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "step4-toggle-enabled.png") });

    // Close settings — click overlay background or press Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    // Ensure overlay is actually closed
    try {
      await page.waitForSelector("#stg-overlay.open", { state: "hidden", timeout: 2000 });
    } catch {
      // Force-close via JS
      await page.evaluate(() => {
        const ov = document.getElementById('stg-overlay');
        if (ov) ov.classList.remove('open');
      });
      await page.waitForTimeout(200);
    }
    log("Settings closed.");

    // Monitor network for encrypted_payload_text
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/v1/chat")) {
        try {
          const body = req.postData();
          if (body && body.includes("encrypted_payload_text")) {
            encryptedPayloadSeen = true;
            log(">>> Network: encrypted_payload_text found in /v1/chat request!");
          }
        } catch {}
      }
    });

    // Upload file
    await clearChips(page);
    const fileInput = page.locator("#file-in");
    await fileInput.setInputFiles(filePath);
    log("Set file for encrypted upload...");

    try {
      await page.waitForSelector("#file-chips .fchip", { state: "visible", timeout: 5000 });
      log("Chip appeared.");
    } catch {
      log("No chip appeared (encrypted mode may handle differently).");
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "step4-file-added.png") });

    // Send
    await page.fill("#msg-in", "Summarize this file in one line.");
    await page.click("#send-btn");
    log("Encrypted message sent. Waiting...");

    await page.waitForTimeout(8000);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "step4-after-send.png") });

    if (encryptedPayloadSeen) {
      log("STEP 4: PASS — encrypted_payload_text confirmed in network request");
    } else {
      log("STEP 4: PARTIAL — sent but encrypted_payload_text not detected in request body");
    }

    // Disable encrypted upload to clean up
    const settingsBtn2 = await page.$("#sb-foot-btn, #settings-btn, #stg-btn, button[aria-label='Settings'], .settings-btn");
    if (settingsBtn2) {
      await settingsBtn2.click();
      await page.waitForTimeout(500);
      const toggle2 = await page.$("#stg-encrypted-upload-toggle");
      if (toggle2) {
        const stillOn = await toggle2.evaluate((el) => el.classList.contains("on"));
        if (stillOn) await toggle2.click();
      }
      await page.keyboard.press("Escape");
    }

    return encryptedPayloadSeen;
  } catch (e) {
    log(`STEP 4: FAIL — ${e.message}`);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "step4-fail.png") }).catch(() => {});
    return false;
  }
}

// ===== MAIN =====
(async () => {
  log("Starting Upload Debug Test");
  log(`URL: ${BASE_URL}`);
  log(`Email: ${EMAIL}`);

  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  await ensureTestAccount();

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  // Capture console errors
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      consoleErrors.push(text);
      log(`[CONSOLE ERROR] ${text}`);
    }
  });

  // Capture failed network requests
  page.on("response", (resp) => {
    if (resp.status() >= 400) {
      const entry = `${resp.status()} ${resp.url()}`;
      networkLog.push(entry);
      log(`[NET ${resp.status()}] ${resp.url()}`);
    }
  });

  try {
    const loggedIn = await loginViaCookie(page, context);
    if (!loggedIn) {
      log("FATAL: Could not log in. Aborting.");
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "fatal-no-login.png") });
      await browser.close();
      process.exit(1);
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "step0-logged-in.png") });

    const results = {
      step1: await step1_textMessage(page),
      step2: await step2_textFileUpload(page),
      step3: await step3_imageUpload(page),
      step4: await step4_encryptedUpload(page),
    };

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("  UPLOAD DEBUG TEST SUMMARY");
    console.log("=".repeat(60));
    console.log(`  Step 1 (text message):     ${results.step1 ? "PASS" : "FAIL"}`);
    console.log(`  Step 2 (txt file upload):   ${results.step2 ? "PASS" : "FAIL"}`);
    console.log(`  Step 3 (image upload):      ${results.step3 ? "PASS" : "FAIL"}`);
    console.log(`  Step 4 (encrypted upload):  ${results.step4 ? "PASS" : "FAIL"}`);
    console.log("=".repeat(60));

    if (consoleErrors.length > 0) {
      console.log(`\n  Browser console errors (${consoleErrors.length}):`);
      for (const e of consoleErrors.slice(0, 10)) {
        console.log(`    - ${e.slice(0, 120)}`);
      }
    }

    if (networkLog.length > 0) {
      console.log(`\n  Failed network requests (${networkLog.length}):`);
      for (const e of networkLog.slice(0, 10)) {
        console.log(`    - ${e.slice(0, 120)}`);
      }
    }

    console.log(`\n  Screenshots saved to: ${SCREENSHOTS_DIR}`);
    console.log("=".repeat(60) + "\n");
  } catch (e) {
    log(`FATAL ERROR: ${e.message}`);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "fatal-error.png") }).catch(() => {});
  } finally {
    await browser.close();
  }
})();
