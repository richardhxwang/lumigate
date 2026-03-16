/**
 * LumiChat File Upload E2E Test
 *
 * Tests file upload for all supported text-based file types.
 * Run: node tests/file-upload.spec.js
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

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");

// All text-based fixture files to test
const TEST_FILES = [
  { file: "test.txt", label: "TXT (plain text)" },
  { file: "test.md", label: "MD (markdown)" },
  { file: "test.csv", label: "CSV (data)" },
  { file: "test.json", label: "JSON (data)" },
  { file: "test.html", label: "HTML (markup)" },
  { file: "test.py", label: "PY (Python)" },
  { file: "test.js", label: "JS (JavaScript)" },
  { file: "test.xml", label: "XML (data)" },
  { file: "test.yaml", label: "YAML (config)" },
  { file: "test.sh", label: "SH (shell)" },
  { file: "test.log", label: "LOG (log file)" },
];

const results = [];

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

async function ensureTestAccount() {
  // Try to register a test account via the LumiGate API.
  // If it already exists, that's fine — we'll just log in.
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
  // Strategy: authenticate via API to get auth cookie, then set it on the
  // browser context before navigating. This bypasses the check-email issue
  // where PB API rules may hide user records from unauthenticated queries.
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

      // Fall back to UI-based login
      return await loginViaUI(page);
    }

    // Extract lc_token cookie from Set-Cookie header
    const setCookie = resp.headers.get("set-cookie") || "";
    const tokenMatch = setCookie.match(/lc_token=([^;]+)/);
    if (!tokenMatch) {
      log("API login succeeded but no lc_token cookie found. Falling back to UI.");
      return await loginViaUI(page);
    }

    const token = tokenMatch[1];
    log(`Got auth token via API (${token.slice(0, 20)}...)`);

    // Set cookie on browser context
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

    // Navigate to LumiChat — should auto-detect cookie and skip auth
    log("Navigating to LumiChat with auth cookie...");
    await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });

    // Wait for main chat UI
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

  // Wait for auth UI
  await page.waitForSelector("#l-email", { state: "visible", timeout: 10000 });
  log("Auth screen visible. Entering email...");

  // Step 1: email
  await page.fill("#l-email", EMAIL);
  await page.click("#email-continue-btn");

  // Step 2: wait for either login or register step to appear
  try {
    await page.waitForSelector("#auth-step-login:not([style*='display: none']):not([style*='display:none'])", {
      state: "visible",
      timeout: 5000,
    });
    log("Login step visible. Entering password...");
    await page.fill("#l-pass", PASSWORD);
    await page.click("#auth-step-login .auth-btn");
  } catch {
    // check-email may have returned exists:false — register step shown
    // Try clicking back and manually navigating
    log("Login step not shown (check-email may have failed). Trying register step workaround...");
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "login-step-missing.png"),
    });
    return false;
  }

  // Wait for main chat UI to appear (msg-in textarea)
  try {
    await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
    log("Login successful! Chat UI is ready.");
    return true;
  } catch {
    const errText = await page
      .locator("#auth-err, #auth-err-login, .auth-err")
      .allTextContents()
      .catch(() => []);
    log(
      `Login FAILED. Error text on page: ${errText.join(", ") || "(none visible)"}`
    );
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "login-failed.png"),
    });
    return false;
  }
}

async function clearPendingFiles(page) {
  // Remove all existing file chips by clicking all remove buttons
  const removeButtons = await page.$$(".fchip-rm");
  for (const btn of removeButtons) {
    await btn.click();
    await page.waitForTimeout(100);
  }
}

async function testFileUpload(page, testFile, index) {
  const { file, label } = testFile;
  const filePath = path.join(FIXTURES_DIR, file);

  if (!fs.existsSync(filePath)) {
    log(`  SKIP ${label} — fixture not found: ${filePath}`);
    results.push({ file, label, status: "SKIP", reason: "fixture not found" });
    return;
  }

  log(`  [${index + 1}/${TEST_FILES.length}] Testing ${label}...`);

  try {
    // Clear any leftover chips
    await clearPendingFiles(page);

    // Upload file via the hidden file input
    const fileInput = page.locator("#file-in");
    await fileInput.setInputFiles(filePath);

    // Wait for file chip to appear in #file-chips
    await page.waitForSelector("#file-chips .fchip", {
      state: "visible",
      timeout: 5000,
    });

    // Verify chip shows the filename
    const chipName = await page
      .locator("#file-chips .fchip-name")
      .first()
      .textContent();
    if (!chipName || !chipName.includes(file.split(".")[0])) {
      throw new Error(
        `Chip name mismatch: expected "${file}", got "${chipName}"`
      );
    }
    log(`    Chip appeared: "${chipName}"`);

    // Type a message
    const ext = path.extname(file).slice(1);
    await page.fill("#msg-in", `Briefly describe this ${ext} file in one sentence.`);

    // Click send
    await page.click("#send-btn");

    // Wait for assistant response — either streaming or complete
    try {
      // Wait for an assistant message bubble to appear
      await page.waitForSelector(".msg.assistant, .msg.ai, [data-role='assistant']", {
        state: "visible",
        timeout: 30000,
      });
      log(`    Got assistant response.`);

      // Wait a bit for streaming to settle
      await page.waitForTimeout(3000);
    } catch {
      log(`    No assistant response within 30s (may need valid API key).`);
    }

    // Take screenshot
    const screenshotPath = path.join(
      SCREENSHOTS_DIR,
      `upload-${ext}-${index + 1}.png`
    );
    await page.screenshot({ path: screenshotPath, fullPage: false });
    log(`    Screenshot: ${screenshotPath}`);

    results.push({ file, label, status: "PASS", chip: chipName });

    // Wait before next test for UI to settle
    await page.waitForTimeout(500);
  } catch (e) {
    const screenshotPath = path.join(
      SCREENSHOTS_DIR,
      `upload-${path.extname(file).slice(1)}-FAIL.png`
    );
    await page
      .screenshot({ path: screenshotPath, fullPage: false })
      .catch(() => {});
    log(`    FAIL: ${e.message}`);
    results.push({ file, label, status: "FAIL", reason: e.message });
  }
}

function printSummary() {
  console.log("\n" + "=".repeat(70));
  console.log("  FILE UPLOAD TEST SUMMARY");
  console.log("=".repeat(70));
  console.log(
    "  " +
      "File".padEnd(15) +
      "Type".padEnd(20) +
      "Status".padEnd(8) +
      "Details"
  );
  console.log("  " + "-".repeat(65));

  let pass = 0,
    fail = 0,
    skip = 0;
  for (const r of results) {
    const statusIcon =
      r.status === "PASS" ? "OK" : r.status === "FAIL" ? "FAIL" : "SKIP";
    const details =
      r.status === "PASS"
        ? `chip: "${r.chip}"`
        : r.reason || "";
    console.log(
      "  " +
        r.file.padEnd(15) +
        r.label.padEnd(20) +
        statusIcon.padEnd(8) +
        details
    );
    if (r.status === "PASS") pass++;
    else if (r.status === "FAIL") fail++;
    else skip++;
  }

  console.log("  " + "-".repeat(65));
  console.log(
    `  Total: ${results.length} | Pass: ${pass} | Fail: ${fail} | Skip: ${skip}`
  );
  console.log("=".repeat(70) + "\n");
}

(async () => {
  // Ensure directories
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // Try to create test account
  await ensureTestAccount();

  log("Launching Chromium (headed)...");
  const browser = await chromium.launch({
    headless: false,
    args: ["--window-size=1400,900"],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  try {
    const loggedIn = await login(page, context);
    if (!loggedIn) {
      log("Cannot proceed without login. Exiting.");
      printSummary();
      await browser.close();
      process.exit(1);
    }

    // Small pause after login for UI to fully initialize
    await page.waitForTimeout(1500);

    log(`\nStarting file upload tests (${TEST_FILES.length} files)...\n`);

    for (let i = 0; i < TEST_FILES.length; i++) {
      await testFileUpload(page, TEST_FILES[i], i);
    }

    printSummary();

    // Keep browser open for 5 seconds so user can see final state
    await page.waitForTimeout(5000);
  } catch (e) {
    log(`Fatal error: ${e.message}`);
    console.error(e);
  } finally {
    await browser.close();
  }
})();
