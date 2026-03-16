/**
 * financial-models.spec.js
 *
 * Playwright E2E test that logs into LumiChat, sends three complex
 * investment-banking financial model prompts, waits for AI responses,
 * captures download links, and takes screenshots.
 *
 * Run:  node tests/financial-models.spec.js
 *
 * Env vars:
 *   LC_EMAIL    — LumiChat email  (default: test@lumigate.local)
 *   LC_PASSWORD — LumiChat password (default: testpass123)
 *   LC_BASE_URL — Base URL (default: http://localhost:9471)
 */

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const EMAIL = process.env.LC_EMAIL || "test@lumigate.local";
const PASSWORD = process.env.LC_PASSWORD || "testpass123";
const BASE_URL = process.env.LC_BASE_URL || "http://localhost:9471";
const SCREENSHOT_DIR = path.join(__dirname, "screenshots");

// Ensure screenshots directory exists
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Financial model prompts
const PROMPTS = [
  {
    name: "three-statement-model",
    label: "Three-Statement Model",
    text: `Generate a comprehensive 3-statement financial model Excel spreadsheet for a fictional tech company 'NovaTech Inc.' with:
- Income Statement (5-year projection, revenue growth 15-25%, COGS 40%, SG&A 20%, R&D 12%, tax rate 21%)
- Balance Sheet (assets, liabilities, equity with proper links to P&L)
- Cash Flow Statement (indirect method, linked to both IS and BS)
- All cells should use Excel formulas (=SUM, =IF, multiplication references) not hardcoded numbers
- Include growth rate assumptions sheet
- Add conditional formatting: red for negative, green for positive growth`,
  },
  {
    name: "dcf-valuation",
    label: "DCF Valuation Model",
    text: `Generate a DCF (Discounted Cash Flow) valuation model Excel for NovaTech Inc. with:
- Unlevered Free Cash Flow projections (5 years + terminal value)
- WACC calculation sheet (risk-free rate 4.5%, equity risk premium 5.5%, beta 1.2, debt/equity 30%, cost of debt 6%, tax 21%)
- Terminal value using both perpetuity growth (2.5%) and exit multiple (12x EBITDA) methods
- Enterprise value to equity value bridge (subtract net debt, add cash)
- Sensitivity analysis table: WACC vs terminal growth rate
- Football field chart showing valuation range
- All formulas linked, no hardcoded intermediates`,
  },
  {
    name: "lbo-model",
    label: "LBO Model",
    text: `Generate an LBO (Leveraged Buyout) model Excel for acquiring NovaTech at $500M enterprise value:
- Sources & Uses table (senior debt 3.5x EBITDA, mezzanine 1.5x, equity the rest)
- Debt schedule with mandatory amortization (senior: 5% per year) and cash sweep (50%)
- 5-year projection with debt paydown
- Exit analysis at year 3, 4, 5 with exit multiples 10x-14x EBITDA
- IRR and MOIC calculation for each exit scenario
- Returns sensitivity: entry multiple vs exit multiple matrix
- All cells formula-based`,
  },
];

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function takeScreenshot(page, name) {
  const filepath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: filepath, fullPage: false });
  console.log(`  [screenshot] ${filepath}`);
  return filepath;
}

/**
 * Wait for the AI response to complete (streaming finished).
 * Detects completion by checking that the send button is back to visible
 * and that at least one assistant message row with content exists.
 */
async function waitForResponse(page, timeoutMs = 180000) {
  const start = Date.now();
  console.log("  Waiting for AI response...");

  // First, wait a bit for the request to start
  await sleep(2000);

  // Check if there's a toast error (API failure)
  const toastErr = await page.evaluate(() => {
    const toast = document.querySelector(".toast, .snackbar, [role='alert']");
    return toast ? toast.textContent : "";
  });
  if (toastErr) {
    console.log(`  Toast message: ${toastErr}`);
  }

  // Wait for streaming to finish — the textarea becomes enabled and send button reappears
  try {
    await page.waitForFunction(
      () => {
        // isStreaming is a global variable in LumiChat
        if (typeof isStreaming !== "undefined" && isStreaming) return false;
        const sendBtn = document.querySelector("#send-btn");
        const stopBtn = document.querySelector("#stop-btn");
        if (!sendBtn) return false;
        const sendStyle = getComputedStyle(sendBtn);
        const sendVisible = sendStyle.display !== "none" && sendBtn.style.display !== "none";
        const stopHidden = !stopBtn || getComputedStyle(stopBtn).display === "none" || stopBtn.style.display === "none";
        return sendVisible && stopHidden;
      },
      null,
      { timeout: timeoutMs }
    );
  } catch (err) {
    console.log(`  Timeout waiting for response after ${((Date.now() - start) / 1000).toFixed(0)}s`);
    throw err;
  }

  // Small delay for final markdown rendering
  await sleep(2000);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  Response completed in ${elapsed}s`);
}

/**
 * Extract info about the last assistant message — text preview, download links.
 */
async function extractResponseInfo(page) {
  return page.evaluate(() => {
    // Find all assistant message rows
    const asstRows = document.querySelectorAll(".msg-row.assistant");
    const lastRow = asstRows.length > 0 ? asstRows[asstRows.length - 1] : null;

    if (!lastRow) {
      // Fallback: try to find any .asst-content in the page
      const anyContent = document.querySelector(".asst-content");
      if (anyContent) {
        const text = anyContent.textContent.trim();
        return {
          text: text.slice(0, 500),
          textLength: text.length,
          links: [],
          downloadLinks: [],
          hasContent: text.length > 50,
        };
      }
      return { text: "", textLength: 0, links: [], downloadLinks: [], hasContent: false };
    }

    // Assistant content is in .asst-content div
    const msgEl = lastRow.querySelector(".asst-content");
    const text = msgEl ? msgEl.textContent.trim() : "";

    // Find all links in the response
    const allLinks = [];
    const searchEl = msgEl || lastRow;
    const anchors = searchEl.querySelectorAll("a[href]");
    anchors.forEach((a) => {
      allLinks.push({ text: a.textContent.trim(), href: a.href });
    });

    // Look for download-specific links
    const downloadLinks = allLinks.filter(
      (l) =>
        l.href.includes("/download") ||
        l.href.includes(".xlsx") ||
        l.href.includes(".docx") ||
        l.href.includes("generated_files") ||
        l.href.includes("/files/")
    );

    return {
      text: text.slice(0, 500),
      textLength: text.length,
      links: allLinks.slice(0, 20),
      downloadLinks,
      hasContent: text.length > 50,
    };
  });
}

async function sendMessage(page, text) {
  // Focus the textarea
  await page.click("#msg-in");
  await sleep(200);

  // Fill the message (use fill to handle long text properly)
  await page.fill("#msg-in", text);
  await sleep(300);

  // Wait for send button to be enabled
  await page.waitForFunction(() => {
    const btn = document.querySelector("#send-btn");
    return btn && !btn.disabled;
  }, null, { timeout: 5000 });

  // Click send
  await page.click("#send-btn");
  console.log("  Message sent, waiting for response...");
}

async function login(page, context) {
  console.log("Authenticating via API...");

  // Step 1: Get auth token via direct API call
  const http = require("http");
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
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`Login API returned ${res.statusCode}: ${data}`));
          // Extract lc_token from set-cookie header
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

  console.log(`  Got auth token: ${token.slice(0, 20)}...`);

  // Step 2: Set cookie in browser context
  const url = new URL(BASE_URL);
  await context.addCookies([
    {
      name: "lc_token",
      value: token,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
      expires: Math.floor(Date.now() / 1000) + 604800,
    },
  ]);

  // Step 3: Navigate to LumiChat
  console.log(`Navigating to ${BASE_URL}/lumichat ...`);
  await page.goto(`${BASE_URL}/lumichat`, { waitUntil: "networkidle", timeout: 30000 });

  // Wait for splash to disappear and app to load
  await sleep(3000);

  // Wait for main app to appear
  try {
    await page.waitForFunction(
      () => {
        const app = document.querySelector("#app");
        return app && app.style.display !== "none" && getComputedStyle(app).display !== "none";
      },
      null,
      { timeout: 15000 }
    );
    console.log("Login successful!");
    await sleep(1000);
    return true;
  } catch (err) {
    // Fallback: try UI-based login
    console.log("  Cookie-based login didn't work, trying UI login...");
    try {
      await page.waitForSelector("#l-email", { state: "visible", timeout: 5000 });
      await page.fill("#l-email", EMAIL);
      await sleep(300);
      await page.click("#email-continue-btn");
      await sleep(1500);

      // Check which step is shown (login or register)
      const loginVisible = await page.evaluate(() => {
        const el = document.querySelector("#auth-step-login");
        return el && el.style.display !== "none";
      });
      const regVisible = await page.evaluate(() => {
        const el = document.querySelector("#auth-step-reg");
        return el && el.style.display !== "none";
      });

      if (loginVisible) {
        await page.fill("#l-pass", PASSWORD);
        await sleep(300);
        await page.click("#l-btn");
      } else if (regVisible) {
        // Account exists in PB but check-email can't find it (emailVisibility issue)
        // Try direct login by navigating after setting cookie - already done above
        // As a workaround, use the register form fields but call login API directly
        console.log("  Registration form shown (emailVisibility issue), injecting login...");
        await page.evaluate(
          async (email, password) => {
            const res = await fetch("/lc/auth/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email, password }),
              credentials: "same-origin",
            });
            if (res.ok) location.reload();
          },
          EMAIL,
          PASSWORD
        );
        await sleep(2000);
      }

      await page.waitForFunction(
        () => {
          const app = document.querySelector("#app");
          return app && app.style.display !== "none";
        },
        null,
        { timeout: 15000 }
      );
      console.log("Login successful (UI fallback)!");
      await sleep(1000);
      return true;
    } catch (err2) {
      const errText = await page
        .evaluate(() => {
          const e1 = document.querySelector("#auth-err-login");
          const e2 = document.querySelector("#auth-err-reg");
          const e3 = document.querySelector("#auth-err");
          return (e1?.textContent || "") + (e2?.textContent || "") + (e3?.textContent || "");
        })
        .catch(() => "");
      console.error(`Login failed: ${errText || err2.message}`);
      return false;
    }
  }
}

async function main() {
  console.log("=== LumiChat Financial Models E2E Test ===\n");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Email: ${EMAIL}`);
  console.log(`Screenshots: ${SCREENSHOT_DIR}\n`);

  const browser = await chromium.launch({
    headless: false,
    args: ["--window-size=1400,900"],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    // Enable downloads
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // Collect console errors and network failures
  const consoleErrors = [];
  const networkErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("response", (response) => {
    const url = response.url();
    const status = response.status();
    if (status >= 400 && (url.includes("/v1/") || url.includes("/lc/"))) {
      networkErrors.push(`${status} ${response.request().method()} ${url}`);
      // Try to get body for error details
      response.text().then(body => {
        const preview = body.slice(0, 200);
        console.log(`  [NET ${status}] ${url.split("/").slice(-3).join("/")} => ${preview}`);
      }).catch(() => {});
    }
  });

  const results = [];

  try {
    // Login
    const loggedIn = await login(page, context);
    if (!loggedIn) {
      await takeScreenshot(page, "login-failed");
      console.error("\nFATAL: Could not log in. Aborting test.");
      await browser.close();
      process.exit(1);
    }

    await takeScreenshot(page, "00-logged-in");

    // Select a good model for tool use (Claude or GPT-4o preferred)
    console.log("\nSelecting model...");
    try {
      // Click the model selector button
      await page.click("#mdl-btn");
      await sleep(1000);
      await takeScreenshot(page, "00-model-dropdown");

      // Try to select anthropic provider first, then openai
      // The dropdown has provider pills and model items
      const modelSelected = await page.evaluate(() => {
        const drop = document.querySelector("#mdl-drop");
        if (!drop || getComputedStyle(drop).display === "none") return null;

        // Find provider pills
        const pills = drop.querySelectorAll("[data-provider]");
        let targetProvider = null;
        for (const pill of pills) {
          const prov = pill.dataset.provider;
          if (prov === "anthropic" || prov === "openai" || prov === "gemini") {
            targetProvider = pill;
            break;
          }
        }
        if (targetProvider) {
          targetProvider.click();
          return targetProvider.dataset.provider;
        }
        return null;
      });

      if (modelSelected) {
        console.log(`  Selected provider: ${modelSelected}`);
        await sleep(500);

        // Now select a specific model from that provider
        const model = await page.evaluate(() => {
          const drop = document.querySelector("#mdl-drop");
          if (!drop) return null;
          const items = drop.querySelectorAll("[data-model]");
          // Prefer claude-sonnet, gpt-4o, or gemini-2.5-flash
          const prefs = ["claude-sonnet-4", "claude-4-sonnet", "gpt-4o", "gemini-2.5-flash", "deepseek-chat"];
          for (const pref of prefs) {
            for (const item of items) {
              if (item.dataset.model && item.dataset.model.includes(pref)) {
                item.click();
                return item.dataset.model;
              }
            }
          }
          // Click first available
          if (items.length > 0) {
            items[0].click();
            return items[0].dataset.model;
          }
          return null;
        });

        if (model) {
          console.log(`  Selected model: ${model}`);
        }
      } else {
        console.log("  Could not find provider pills, using default model");
        // Close dropdown
        await page.click("#mdl-btn");
      }
      await sleep(500);
    } catch (err) {
      console.log(`  Model selection failed: ${err.message}, using default`);
    }

    // Send each financial model prompt
    for (let i = 0; i < PROMPTS.length; i++) {
      const prompt = PROMPTS[i];
      console.log(`\n--- [${i + 1}/${PROMPTS.length}] ${prompt.label} ---`);

      // Create a new chat session for each model to avoid context issues
      // Click "New Chat" button if available
      if (i > 0) {
        try {
          // Look for new chat button in sidebar
          const newChatBtn = await page.$("#new-chat, #new-chat-btn, .new-btn");
          if (newChatBtn) {
            await newChatBtn.click();
            await sleep(1000);
            console.log("  Started new chat session");
          }
        } catch {
          // Continue in same session if new chat button not found
        }
      }

      try {
        await sendMessage(page, prompt.text);
        await waitForResponse(page, 180000); // 3 min timeout per prompt

        const info = await extractResponseInfo(page);
        await takeScreenshot(page, `${String(i + 1).padStart(2, "0")}-${prompt.name}`);

        results.push({
          name: prompt.label,
          success: info.hasContent,
          textLength: info.textLength,
          textPreview: info.text,
          downloadLinks: info.downloadLinks,
          allLinks: info.links,
        });

        console.log(`  Response length: ${info.textLength} chars`);
        console.log(`  Has content: ${info.hasContent}`);
        console.log(`  Links found: ${info.links.length}`);
        if (info.downloadLinks.length > 0) {
          console.log(`  Download links:`);
          for (const dl of info.downloadLinks) {
            console.log(`    - ${dl.text}: ${dl.href}`);
          }
          // Try to click download links
          for (const dl of info.downloadLinks) {
            try {
              const [download] = await Promise.all([
                page.waitForEvent("download", { timeout: 10000 }),
                page.click(`a[href="${dl.href}"]`),
              ]);
              const dlPath = path.join(SCREENSHOT_DIR, download.suggestedFilename());
              await download.saveAs(dlPath);
              console.log(`    Downloaded: ${dlPath}`);
            } catch (dlErr) {
              console.log(`    Download attempt failed: ${dlErr.message}`);
            }
          }
        }

        // Scroll to see the full response and take another screenshot
        await page.evaluate(() => {
          const chat = document.querySelector("#chat-scroll") || document.querySelector("#chat");
          if (chat) chat.scrollTop = chat.scrollHeight;
        });
        await sleep(500);
        await takeScreenshot(page, `${String(i + 1).padStart(2, "0")}-${prompt.name}-scrolled`);

      } catch (err) {
        console.error(`  ERROR: ${err.message}`);
        await takeScreenshot(page, `${String(i + 1).padStart(2, "0")}-${prompt.name}-error`);
        results.push({
          name: prompt.label,
          success: false,
          error: err.message,
        });
      }

      // Longer pause between prompts to avoid rate limiting
      if (i < PROMPTS.length - 1) {
        console.log("  Waiting 10s before next prompt (rate limit cooldown)...");
        await sleep(10000);
      }
    }

  } catch (err) {
    console.error(`\nUnexpected error: ${err.message}`);
    await takeScreenshot(page, "unexpected-error");
  } finally {
    // Print summary
    console.log("\n\n=== RESULTS SUMMARY ===\n");
    for (const r of results) {
      const status = r.success ? "PASS" : "FAIL";
      const dlCount = r.downloadLinks?.length || 0;
      console.log(`[${status}] ${r.name}`);
      if (r.success) {
        console.log(`  Response: ${r.textLength} chars`);
        console.log(`  Download links: ${dlCount}`);
        if (r.textPreview) console.log(`  Preview: ${r.textPreview.slice(0, 200)}...`);
      } else {
        console.log(`  Error: ${r.error || "No content received"}`);
      }
      console.log();
    }

    if (consoleErrors.length > 0) {
      console.log(`Console errors (${consoleErrors.length}):`);
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

    console.log("\nClosing browser...");
    await browser.close();
    console.log("Done.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
