/**
 * Selection Menu Position — Verification test
 *
 * Verifies #sel-menu appears directly above selected text at various scroll positions.
 * Tests both Chromium and WebKit.
 *
 * Run: node tests/sel-menu-scroll-test.spec.js
 */

const { chromium, webkit } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const BASE_URL = process.env.LC_URL || "http://localhost:9471/lumichat";
const EMAIL = process.env.LC_EMAIL || "test@lumigate.local";
const PASSWORD = process.env.LC_PASSWORD || "testpass123";
const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

async function login(page, context) {
  try {
    await fetch("http://localhost:9471/lc/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, passwordConfirm: PASSWORD, name: "Sel Test" }),
    });
  } catch {}
  const resp = await fetch("http://localhost:9471/lc/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!resp.ok) throw new Error(`Login failed: ${resp.status}`);
  const setCookie = resp.headers.get("set-cookie") || "";
  const tokenMatch = setCookie.match(/lc_token=([^;]+)/);
  if (!tokenMatch) throw new Error("No lc_token");
  const url = new URL(BASE_URL);
  await context.addCookies([{
    name: "lc_token", value: tokenMatch[1],
    domain: url.hostname, path: "/", httpOnly: true, sameSite: "Strict",
  }]);
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
}

async function runTest(browserType, name) {
  log(`\n===== ${name} =====`);
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  let pass = 0, fail = 0;

  try {
    await login(page, context);

    // Get past empty state with a real message
    await page.fill("#msg-in", "Say hello briefly");
    await page.click("#send-btn");
    await page.waitForSelector(".asst-content", { state: "visible", timeout: 60000 });
    await page.waitForTimeout(5000);

    // Inject scrollable content
    await page.evaluate(() => {
      const chat = document.getElementById('chat');
      let html = '<div class="msg-row assistant"><div class="asst-content" id="injected-asst">';
      for (let i = 1; i <= 40; i++) {
        html += `<p><strong>Fact ${i}:</strong> The solar system contains many fascinating objects. ` +
          `This paragraph ${i} tests the selection menu positioning across scrolled content.</p>`;
      }
      html += '</div></div>';
      chat.insertAdjacentHTML('beforeend', html);
    });

    for (const scrollPos of ['top', 'middle', 'bottom']) {
      await page.evaluate((pos) => {
        const c = document.getElementById('chat');
        c.scrollTop = pos === 'top' ? 0 : pos === 'middle' ? c.scrollHeight / 2 : c.scrollHeight;
      }, scrollPos);
      await page.waitForTimeout(600);

      // Programmatic selection + mouseup dispatch
      await page.evaluate(() => {
        const paras = document.querySelectorAll('#injected-asst p');
        const chatRect = document.getElementById('chat').getBoundingClientRect();
        for (const p of paras) {
          const r = p.getBoundingClientRect();
          if (r.top > chatRect.top + 30 && r.bottom < chatRect.bottom - 30) {
            const range = document.createRange();
            // Find a text node inside the paragraph
            const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
            const textNode = walker.nextNode();
            if (!textNode) return;
            range.setStart(textNode, 0);
            range.setEnd(textNode, Math.min(textNode.textContent.length, 20));
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            return;
          }
        }
      });
      await page.waitForTimeout(400);

      const result = await page.evaluate(() => {
        const sel = window.getSelection();
        if (!sel.rangeCount || sel.isCollapsed) return null;
        const range = sel.getRangeAt(0);
        const selRect = range.getBoundingClientRect();
        const menu = document.getElementById('sel-menu');
        if (getComputedStyle(menu).display !== 'flex') return null;
        const menuRect = menu.getBoundingClientRect();
        return {
          gap: Math.round(selRect.top - menuRect.bottom),
          hDiff: Math.round(Math.abs((selRect.left + selRect.right) / 2 - (menuRect.left + menuRect.right) / 2)),
        };
      });

      if (result && Math.abs(result.gap - 8) < 10 && result.hDiff < 50) {
        log(`  ${scrollPos}: PASS (gap=${result.gap}px, hDiff=${result.hDiff}px)`);
        pass++;
      } else {
        log(`  ${scrollPos}: FAIL ${JSON.stringify(result)}`);
        fail++;
      }

      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `sel-menu-${name}-${scrollPos}.png`) });
      await page.evaluate(() => { window.getSelection().removeAllRanges(); });
      await page.waitForTimeout(200);
    }

  } catch (e) {
    log(`  Error: ${e.message}`);
    fail++;
  } finally {
    await browser.close();
  }
  return { pass, fail };
}

(async () => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const cr = await runTest(chromium, 'Chromium');
  const wk = await runTest(webkit, 'WebKit');
  const totalPass = cr.pass + wk.pass;
  const totalFail = cr.fail + wk.fail;
  log(`\nTotal: ${totalPass} passed, ${totalFail} failed`);
  process.exit(totalFail > 0 ? 1 : 0);
})();
