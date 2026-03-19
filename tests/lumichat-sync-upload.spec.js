const { chromium } = require("playwright-core");
const path = require("path");

const BASE_URL = process.env.LC_URL || "http://localhost:9471/lumichat";
const EMAIL = process.env.LC_EMAIL || "test@lumigate.local";
const PASSWORD = process.env.LC_PASSWORD || "testpass123";
const FIXTURE = path.join(__dirname, "fixtures", "test.csv");

async function ensureTestAccount() {
  try {
    await fetch("http://localhost:9471/lc/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: EMAIL,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
        name: "Test User",
      }),
    });
  } catch {}
}

async function loginViaApi(context) {
  const resp = await fetch("http://localhost:9471/lc/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!resp.ok) {
    throw new Error(`Login failed: ${resp.status} ${await resp.text()}`);
  }
  const setCookie = resp.headers.get("set-cookie") || "";
  const tokenMatch = setCookie.match(/lc_token=([^;]+)/);
  if (!tokenMatch) throw new Error("No lc_token cookie in login response");
  const url = new URL(BASE_URL);
  await context.addCookies([{
    name: "lc_token",
    value: tokenMatch[1],
    domain: url.hostname,
    path: "/",
    httpOnly: true,
    sameSite: "Strict",
  }]);
}

async function waitForChat(page) {
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 20000 });
  await page.waitForSelector("#msg-in", { state: "visible", timeout: 15000 });
}

async function main() {
  await ensureTestAccount();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await loginViaApi(context);

  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await Promise.all([waitForChat(pageA), waitForChat(pageB)]);

  const [chooser] = await Promise.all([
    pageA.waitForEvent("filechooser"),
    pageA.click("#attach-btn"),
  ]);
  await chooser.setFiles(FIXTURE);
  await pageA.waitForSelector("#file-chips .fchip", { state: "visible", timeout: 3000 });
  const chipState = await pageA.evaluate(() => {
    const chip = document.querySelector("#file-chips .fchip");
    return {
      exists: !!chip,
      text: chip?.innerText || "",
      hasSpin: !!chip?.querySelector(".fchip-spin"),
      busy: chip?.classList.contains("fchip-busy") || false,
    };
  });

  const sessionTitle = `Sync ${Date.now()}`;
  await pageA.fill("#msg-in", sessionTitle);
  await pageA.click("#send-btn");
  await pageA.waitForFunction((expected) => {
    return Array.from(document.querySelectorAll(".sess-item .sess-title")).some((el) => (el.textContent || "").includes(expected));
  }, sessionTitle, { timeout: 10000 });

  await pageB.waitForFunction((expected) => {
    return Array.from(document.querySelectorAll(".sess-item .sess-title")).some((el) => (el.textContent || "").includes(expected));
  }, sessionTitle, { timeout: 10000 });

  const sessionSeenInB = await pageB.evaluate((expected) => {
    return Array.from(document.querySelectorAll(".sess-item .sess-title")).some((el) => (el.textContent || "").includes(expected));
  }, sessionTitle);

  const mobileContext = await browser.newContext({
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
  });
  await loginViaApi(mobileContext);
  const mobilePage = await mobileContext.newPage();
  await waitForChat(mobilePage);
  const [mobileChooser] = await Promise.all([
    mobilePage.waitForEvent("filechooser"),
    mobilePage.tap("#attach-btn"),
  ]);
  await mobileChooser.setFiles(FIXTURE);
  await mobilePage.waitForSelector("#file-chips .fchip", { state: "visible", timeout: 3000 });
  const mobileChipState = await mobilePage.evaluate(() => {
    const chip = document.querySelector("#file-chips .fchip");
    return {
      exists: !!chip,
      text: chip?.innerText || "",
      hasSpin: !!chip?.querySelector(".fchip-spin"),
      busy: chip?.classList.contains("fchip-busy") || false,
    };
  });

  await browser.close();
  console.log(JSON.stringify({ ok: true, chipState, mobileChipState, sessionTitle, sessionSeenInB }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
