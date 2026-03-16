/**
 * LumiChat Mobile Viewport E2E Test
 *
 * Tests all known mobile-specific issues on iPhone 14 Pro viewport (393x852).
 * Run: node tests/mobile-test.spec.js
 *
 * Env vars:
 *   LC_EMAIL    - login email    (default: test@lumigate.local)
 *   LC_PASSWORD - login password (default: testpass123)
 *   LC_URL      - LumiChat URL   (default: http://localhost:9471/lumichat)
 */

const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const BASE = process.env.LC_URL || "http://localhost:9471";
const LUMICHAT_URL = `${BASE}/lumichat`;
const EMAIL = process.env.LC_EMAIL || "test@lumigate.local";
const PASSWORD = process.env.LC_PASSWORD || "testpass123";

const SS_DIR = path.join(__dirname, "screenshots", "mobile");
const results = [];

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  log(`${status} : ${name}${detail ? " — " + detail : ""}`);
}

async function ss(page, name) {
  const p = path.join(SS_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  log(`  screenshot: ${name}.png`);
}

async function ensureTestAccount() {
  try {
    const resp = await fetch(`${BASE}/lc/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, passwordConfirm: PASSWORD, name: "Test User" }),
    });
    if (resp.ok) log("Created test account");
    else log("Test account exists or register skipped");
  } catch (e) {
    log(`Register attempt: ${e.message}`);
  }
}

async function apiLogin() {
  const resp = await fetch(`${BASE}/lc/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!resp.ok) throw new Error(`Login failed: ${resp.status}`);
  const setCookie = resp.headers.get("set-cookie") || "";
  const m = setCookie.match(/lc_token=([^;]+)/);
  if (!m) throw new Error("No lc_token in response");
  return m[1];
}

// ────────────────────────────────────────────────────────────────────────────
// TESTS
// ────────────────────────────────────────────────────────────────────────────

async function testSplash(page) {
  const name = "a_splash_animation";
  try {
    // Navigate but don't wait for full load — we need to catch the splash
    await page.goto(LUMICHAT_URL, { waitUntil: "domcontentloaded", timeout: 10000 });
    await ss(page, "01_splash_initial");

    // Check splash exists in DOM (it may already be animating or transitioning)
    const splashInfo = await page.evaluate(() => {
      const splash = document.querySelector("#splash");
      const ball = document.querySelector("#splash-ball");
      if (!splash) return { exists: false };
      const style = getComputedStyle(splash);
      return {
        exists: true,
        display: style.display,
        opacity: style.opacity,
        hasOutClass: splash.classList.contains("out"),
        ballExists: !!ball,
      };
    });

    await page.waitForTimeout(800);
    await ss(page, "02_splash_animating");

    if (splashInfo.exists && splashInfo.ballExists) {
      record(name, "PASS", `splash present in DOM, ball exists, display=${splashInfo.display}, opacity=${splashInfo.opacity}`);
    } else if (splashInfo.exists) {
      record(name, "PASS", "splash element exists (ball may have already transitioned)");
    } else {
      record(name, "FAIL", "splash element not found in DOM");
    }
  } catch (e) {
    await ss(page, "01_splash_error");
    record(name, "FAIL", e.message);
  }
}

async function testAuthScreen(page) {
  const name = "b_auth_screen";
  try {
    // Wait for splash to fade and auth to appear
    await page.waitForSelector("#auth", { state: "visible", timeout: 8000 });
    await page.waitForTimeout(500);
    await ss(page, "03_auth_screen");

    // Check that "What can I help" text is NOT visible (it's behind auth)
    const whatCanIHelp = await page.evaluate(() => {
      const el = document.querySelector("#empty h2");
      if (!el) return { visible: false, text: "" };
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
        text: el.textContent,
      };
    });

    // The #app should be display:none, so no flash
    const appHidden = await page.evaluate(() => {
      const app = document.querySelector("#app");
      return app && (app.style.display === "none" || getComputedStyle(app).display === "none");
    });

    if (appHidden) {
      record(name, "PASS", "auth screen shows, no 'What can I help' flash (#app hidden)");
    } else if (!whatCanIHelp.visible) {
      record(name, "PASS", "auth screen shows, 'What can I help' not visible");
    } else {
      record(name, "FAIL", `'What can I help' flash detected: visible=${whatCanIHelp.visible}`);
    }
  } catch (e) {
    await ss(page, "03_auth_error");
    record(name, "FAIL", e.message);
  }
}

async function loginWithCookie(page, context, token) {
  const url = new URL(LUMICHAT_URL);
  await context.addCookies([{
    name: "lc_token",
    value: token,
    domain: url.hostname,
    path: "/",
    httpOnly: true,
    sameSite: "Strict",
  }]);
  await page.goto(LUMICHAT_URL, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
}

async function testAfterLogin(page) {
  const name = "c_model_name_after_login";
  try {
    // Wait for splash to finish and app to fully load
    await page.waitForSelector("#splash", { state: "detached", timeout: 8000 }).catch(() => {});
    await page.waitForSelector("#app:not([style*='display: none']):not([style*='display:none'])", { state: "visible", timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await ss(page, "04_after_login");

    const labelText = await page.evaluate(() => {
      const el = document.querySelector("#mdl-label");
      return el ? el.textContent.trim() : "";
    });

    log(`  model label text: "${labelText}"`);

    if (!labelText || labelText === "LumiChat" || labelText === "") {
      record(name, "FAIL", `model label shows "${labelText}" instead of model name`);
    } else {
      record(name, "PASS", `model label shows "${labelText}"`);
    }
  } catch (e) {
    await ss(page, "04_login_error");
    record(name, "FAIL", e.message);
  }
}

async function testModelDropdown(page) {
  const name = "d_model_dropdown_mobile";
  try {
    await page.tap("#mdl-btn");
    await page.waitForTimeout(600);
    await ss(page, "05_model_dropdown_open");

    // Check dropdown is visible and within viewport
    const dropInfo = await page.evaluate(() => {
      const drop = document.querySelector("#mdl-drop");
      if (!drop) return { exists: false };
      const rect = drop.getBoundingClientRect();
      const style = getComputedStyle(drop);
      return {
        exists: true,
        visible: drop.classList.contains("open") || style.display !== "none",
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });

    log(`  dropdown: top=${dropInfo.top}, bottom=${dropInfo.bottom}, left=${dropInfo.left}, right=${dropInfo.right}, vpW=${dropInfo.viewportWidth}, vpH=${dropInfo.viewportHeight}`);

    if (!dropInfo.exists || !dropInfo.visible) {
      record(name, "FAIL", "dropdown not visible");
    } else if (dropInfo.right > dropInfo.viewportWidth + 5 || dropInfo.left < -5) {
      record(name, "FAIL", `dropdown off-screen horizontally (left=${dropInfo.left}, right=${dropInfo.right})`);
    } else if (dropInfo.bottom > dropInfo.viewportHeight + 50) {
      record(name, "FAIL", `dropdown extends below viewport (bottom=${dropInfo.bottom}, vpH=${dropInfo.viewportHeight})`);
    } else {
      record(name, "PASS", `dropdown visible within viewport (${Math.round(dropInfo.width)}x${Math.round(dropInfo.height)})`);
    }

    // Close dropdown
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  } catch (e) {
    await ss(page, "05_dropdown_error");
    record(name, "FAIL", e.message);
  }
}

async function testSidebar(page) {
  const name = "e_sidebar_mobile";
  try {
    // Open sidebar via toggle button
    await page.tap("#sb-toggle");
    await page.waitForTimeout(500);
    await ss(page, "06_sidebar_open");

    const sidebarInfo = await page.evaluate(() => {
      const sb = document.querySelector("#sidebar");
      if (!sb) return { exists: false };
      const rect = sb.getBoundingClientRect();
      const foot = document.querySelector(".sb-foot");
      const footRect = foot ? foot.getBoundingClientRect() : null;
      const nameEl = document.querySelector("#u-name");
      const emailEl = document.querySelector("#u-email");
      return {
        exists: true,
        mobileOpen: sb.classList.contains("mobile-open"),
        sbRight: rect.right,
        sbWidth: rect.width,
        vpWidth: window.innerWidth,
        footOverflow: footRect ? footRect.right > window.innerWidth : false,
        userName: nameEl ? nameEl.textContent : "",
        userEmail: emailEl ? emailEl.textContent : "",
      };
    });

    log(`  sidebar: mobileOpen=${sidebarInfo.mobileOpen}, width=${sidebarInfo.sbWidth}, user=${sidebarInfo.userName}`);

    if (!sidebarInfo.mobileOpen) {
      record(name, "FAIL", "sidebar did not open (no mobile-open class)");
    } else if (sidebarInfo.footOverflow) {
      record(name, "FAIL", "user info overflows viewport");
    } else {
      record(name, "PASS", `sidebar open, user="${sidebarInfo.userName}", email="${sidebarInfo.userEmail}"`);
    }

    // Close sidebar via JS (tapping overlay can be intercepted by sidebar content)
    await page.evaluate(() => { if (typeof closeMobileSidebar === "function") closeMobileSidebar(); });
    await page.waitForTimeout(400);
  } catch (e) {
    await ss(page, "06_sidebar_error");
    record(name, "FAIL", e.message);
  }
}

async function ensureSidebarClosed(page) {
  await page.evaluate(() => {
    const sb = document.querySelector("#sidebar");
    if (sb && sb.classList.contains("mobile-open") && typeof closeMobileSidebar === "function") {
      closeMobileSidebar();
    }
  });
  await page.waitForTimeout(300);
}

async function selectDeepSeek(page) {
  await ensureSidebarClosed(page);
  await page.click("#mdl-btn", { force: true });
  await page.waitForTimeout(500);

  // Click deepseek provider pill
  const pill = await page.$(`.mdl-prov-pill[data-prov="deepseek"]`);
  if (!pill) {
    log("  DeepSeek pill not found, using default model");
    await page.keyboard.press("Escape");
    return false;
  }

  const isLocked = await pill.evaluate(el => el.style.opacity === "0.4" || el.classList.contains("locked"));
  if (isLocked) {
    log("  DeepSeek is locked (no API key), using default model");
    await page.keyboard.press("Escape");
    return false;
  }

  await pill.click();
  await page.waitForTimeout(500);

  // Pick first model
  const opt = await page.$(".mdl-opt");
  if (opt) {
    const modelId = await opt.getAttribute("data-model");
    await opt.click();
    log(`  Selected DeepSeek model: ${modelId}`);
    await page.waitForTimeout(300);
    return true;
  }

  await page.keyboard.press("Escape");
  return false;
}

async function testSendMessage(page) {
  const name = "f_send_message";
  try {
    await ensureSidebarClosed(page);

    // Select DeepSeek if available
    const dsOk = await selectDeepSeek(page);

    // Type message
    await page.fill("#msg-in", "你好");
    await page.waitForTimeout(200);

    // Send
    await page.evaluate(() => { if (typeof sendMessage === "function") sendMessage(); });

    // Wait for typing dots to appear
    await page.waitForTimeout(300);
    const dotsVisible = await page.isVisible(".typing-dots");
    await ss(page, "07_typing_dots");

    // Wait for streaming to start
    let streamingScreenshot = false;
    const startTime = Date.now();
    while (Date.now() - startTime < 20000) {
      const state = await page.evaluate(() => {
        const rows = document.querySelectorAll(".msg-row.assistant .asst-content");
        const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
        return {
          text: lastRow ? lastRow.innerText : "",
          isStreaming: typeof isStreaming !== "undefined" ? isStreaming : false,
          hasStreamCursor: !!document.querySelector(".streaming-active"),
        };
      });

      // Take screenshot during streaming
      if (state.text.length > 5 && state.isStreaming && !streamingScreenshot) {
        await ss(page, "08_during_streaming");
        streamingScreenshot = true;
      }

      // Done streaming
      if (state.text && state.text.trim().length > 3 && !state.isStreaming) {
        await ss(page, "09_response_complete");

        // Check for issues
        const issues = [];

        // Check for green cursor line on empty row
        const cursorOnEmpty = await page.evaluate(() => {
          const el = document.querySelector(".streaming-active:empty");
          return !!el;
        });
        if (cursorOnEmpty) issues.push("green cursor on empty row");

        // Check for raw markdown (* or #)
        const hasRawMd = await page.evaluate(() => {
          const rows = document.querySelectorAll(".msg-row.assistant .asst-content");
          const last = rows[rows.length - 1];
          if (!last) return false;
          const html = last.innerHTML;
          // If there are literal * or # not inside tags, it's raw markdown
          const text = last.textContent || "";
          return /^\s*[*#]{1,3}\s/m.test(text);
        });
        if (hasRawMd) issues.push("raw markdown visible (unrendered * or #)");

        // Check for DSML/XML/tool tags
        const hasTags = await page.evaluate(() => {
          const rows = document.querySelectorAll(".msg-row.assistant .asst-content");
          const last = rows[rows.length - 1];
          if (!last) return false;
          const text = last.textContent || "";
          return /<\/?(?:dsml|tool_call|function_call|search_result|result|artifact|antThinking)/i.test(text);
        });
        if (hasTags) issues.push("DSML/XML/tool tags visible in response");

        if (issues.length > 0) {
          record(name, "FAIL", issues.join("; "));
        } else {
          record(name, "PASS", `response received, dots=${dotsVisible}, streaming-ss=${streamingScreenshot}, text="${state.text.slice(0, 40)}..."`);
        }
        return;
      }

      // Check for error
      const err = await page.evaluate(() => {
        const t = document.querySelector("#toast");
        return t && t.classList.contains("show") ? t.textContent : null;
      });
      if (err) {
        await ss(page, "09_send_error");
        record(name, "FAIL", `toast error: ${err}`);
        return;
      }

      await page.waitForTimeout(500);
    }

    await ss(page, "09_timeout");
    record(name, "FAIL", "timeout waiting for response");
  } catch (e) {
    await ss(page, "09_send_exception");
    record(name, "FAIL", e.message);
  }
}

async function testToolCall(page) {
  const name = "g_tool_call_search";
  try {
    await ensureSidebarClosed(page);

    // Start new chat
    await page.evaluate(() => { if (typeof newChat === "function") newChat(); });
    await page.waitForTimeout(600);

    // Enable web search
    await page.click("#web-search-btn", { force: true });
    await page.waitForTimeout(300);

    // Select DeepSeek if needed
    await selectDeepSeek(page);

    // Send search query
    await page.fill("#msg-in", "搜索一下今天的新闻");
    await page.waitForTimeout(200);
    await page.evaluate(() => { if (typeof sendMessage === "function") sendMessage(); });

    // Wait and capture stages
    await page.waitForTimeout(500);
    const dotsVisible = await page.isVisible(".typing-dots");
    await ss(page, "10_tool_typing_dots");

    let searchIndicatorSeen = false;
    let responseComplete = false;
    const startTime = Date.now();

    while (Date.now() - startTime < 45000) {
      const state = await page.evaluate(() => {
        const rows = document.querySelectorAll(".msg-row.assistant .asst-content");
        const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
        const html = lastRow ? lastRow.innerHTML : "";
        const text = lastRow ? lastRow.innerText : "";
        return {
          html,
          text,
          isStreaming: typeof isStreaming !== "undefined" ? isStreaming : false,
          hasSearchIndicator: html.includes("web_search") || html.includes("web search") || html.includes("Searching"),
        };
      });

      if (state.hasSearchIndicator && !searchIndicatorSeen) {
        searchIndicatorSeen = true;
        await ss(page, "11_search_indicator");
        log("  search indicator visible");
      }

      if (state.text && state.text.trim().length > 10 && !state.isStreaming) {
        responseComplete = true;
        await ss(page, "12_search_response");

        // Check for raw JSON or DSML tags
        const issues = [];
        const hasDsml = /(<\/?(?:dsml|tool_call|function_call|search_result|artifact))/i.test(state.text);
        if (hasDsml) issues.push("DSML/tool tags visible");

        const hasRawJson = /^\s*[\[{]/.test(state.text) && state.text.includes('"url"');
        if (hasRawJson) issues.push("raw JSON visible instead of formatted cards");

        if (issues.length > 0) {
          record(name, "FAIL", issues.join("; "));
        } else {
          record(name, "PASS", `search done, indicator=${searchIndicatorSeen}, dots=${dotsVisible}, text="${state.text.slice(0, 50)}..."`);
        }
        break;
      }

      // Check for error
      const err = await page.evaluate(() => {
        const t = document.querySelector("#toast");
        return t && t.classList.contains("show") ? t.textContent : null;
      });
      if (err) {
        await ss(page, "12_tool_error");
        // If web search isn't configured, mark as SKIP not FAIL
        if (err.includes("SearXNG") || err.includes("search") || err.includes("tool")) {
          record(name, "SKIP", `web search not available: ${err}`);
        } else {
          record(name, "FAIL", `toast error: ${err}`);
        }
        break;
      }

      await page.waitForTimeout(800);
    }

    if (!responseComplete && !results.find(r => r.name === name)) {
      await ss(page, "12_tool_timeout");
      record(name, "FAIL", "timeout waiting for tool call response");
    }

    // Disable web search
    await page.click("#web-search-btn", { force: true }).catch(() => {});
  } catch (e) {
    await ss(page, "12_tool_exception");
    record(name, "FAIL", e.message);
  }
}

async function testFileUpload(page) {
  const name = "h_file_upload";
  try {
    await ensureSidebarClosed(page);

    // Start new chat
    await page.evaluate(() => { if (typeof newChat === "function") newChat(); });
    await page.waitForTimeout(400);

    // Create a test .txt file
    const testFilePath = path.join(SS_DIR, "test-upload.txt");
    fs.writeFileSync(testFilePath, "This is a test file for LumiChat mobile upload.\nLine 2.\nLine 3.");

    // Set file on the hidden input
    const fileInput = await page.$("#file-in");
    await fileInput.setInputFiles(testFilePath);
    await page.waitForTimeout(800);
    await ss(page, "13_file_chip");

    // Check if chip appeared
    const chipInfo = await page.evaluate(() => {
      const chips = document.querySelector("#file-chips");
      return {
        hasChips: chips && chips.children.length > 0,
        html: chips ? chips.innerHTML : "",
        childCount: chips ? chips.children.length : 0,
      };
    });

    if (chipInfo.hasChips) {
      record(name, "PASS", `file chip visible (${chipInfo.childCount} chip(s))`);
    } else {
      record(name, "FAIL", "file chip did not appear after upload");
    }

    // Clean up pending files
    await page.evaluate(() => { pendingFiles = []; document.querySelector("#file-chips").innerHTML = ""; });
  } catch (e) {
    await ss(page, "13_file_error");
    record(name, "FAIL", e.message);
  }
}

async function testKeyboardHandling(page) {
  const name = "i_keyboard_handling";
  try {
    await ensureSidebarClosed(page);

    // Focus input
    await page.click("#msg-in", { force: true });
    await page.waitForTimeout(500);
    await ss(page, "14_input_focused");

    // On mobile, the virtual keyboard changes viewport. Check input is visible.
    const inputInfo = await page.evaluate(() => {
      const inp = document.querySelector("#msg-in");
      if (!inp) return { exists: false };
      const rect = inp.getBoundingClientRect();
      return {
        exists: true,
        top: rect.top,
        bottom: rect.bottom,
        visible: rect.bottom <= window.innerHeight && rect.top >= 0,
        vpHeight: window.innerHeight,
        isFocused: document.activeElement === inp,
      };
    });

    log(`  input: top=${inputInfo.top}, bottom=${inputInfo.bottom}, vpH=${inputInfo.vpHeight}, focused=${inputInfo.isFocused}`);

    if (inputInfo.isFocused && inputInfo.visible) {
      record(name, "PASS", `input focused and visible (bottom=${Math.round(inputInfo.bottom)}, vpH=${inputInfo.vpHeight})`);
    } else if (inputInfo.isFocused) {
      record(name, "WARN", `input focused but may be outside viewport (bottom=${Math.round(inputInfo.bottom)}, vpH=${inputInfo.vpHeight})`);
    } else {
      record(name, "FAIL", "input not focused after tap");
    }

    // Type something and verify
    await page.fill("#msg-in", "test keyboard");
    await page.waitForTimeout(200);
    const typed = await page.evaluate(() => document.querySelector("#msg-in").value);
    if (typed === "test keyboard") {
      log("  typing works correctly");
    }

    // Clear
    await page.fill("#msg-in", "");
    await page.keyboard.press("Escape");
  } catch (e) {
    await ss(page, "14_keyboard_error");
    record(name, "FAIL", e.message);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(SS_DIR, { recursive: true });

  await ensureTestAccount();
  const token = await apiLogin();
  log(`Auth token obtained (${token.slice(0, 20)}...)`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();

  try {
    // a. Splash animation (before login cookie injection — fresh page load)
    await testSplash(page);

    // b. Auth screen check
    await testAuthScreen(page);

    // Inject cookie and navigate
    await loginWithCookie(page, context, token);
    log("Logged in via API cookie injection");

    // c. Model name after login
    await testAfterLogin(page);

    // d. Model dropdown on mobile
    await testModelDropdown(page);

    // e. Sidebar
    await testSidebar(page);

    // f. Send message
    await testSendMessage(page);

    // g. Tool call (web search)
    await testToolCall(page);

    // h. File upload
    await testFileUpload(page);

    // i. Keyboard handling
    await testKeyboardHandling(page);

  } catch (e) {
    log(`FATAL: ${e.message}`);
    await ss(page, "99_fatal_error").catch(() => {});
  } finally {
    await browser.close();
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(90));
  console.log("MOBILE TEST SUMMARY  (iPhone 14 Pro — 393x852 @3x)");
  console.log("=".repeat(90));
  console.log("Test".padEnd(32) + "Status".padEnd(8) + "Detail");
  console.log("-".repeat(90));

  let pass = 0, fail = 0, skip = 0, warn = 0;
  for (const r of results) {
    console.log(r.name.padEnd(32) + r.status.padEnd(8) + (r.detail || "").slice(0, 50));
    if (r.status === "PASS") pass++;
    else if (r.status === "FAIL") fail++;
    else if (r.status === "SKIP") skip++;
    else if (r.status === "WARN") warn++;
  }

  console.log("-".repeat(90));
  console.log(`Total: ${results.length} | PASS: ${pass} | FAIL: ${fail} | WARN: ${warn} | SKIP: ${skip}`);
  console.log("=".repeat(90));
  console.log(`Screenshots saved to: ${SS_DIR}`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
