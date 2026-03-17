/**
 * Gemini mixed-media regression test:
 * uploads 2 images + 1 PDF and verifies Gemini does not claim
 * that it cannot access the attachments.
 *
 * Run: node tests/gemini-mixed-media.spec.js
 */

const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const BASE_URL = process.env.LC_URL || "http://localhost:9471/lumichat";
const EMAIL = process.env.LC_EMAIL || "test@lumigate.local";
const PASSWORD = process.env.LC_PASSWORD || "testpass123";
const TMP_DIR = path.join(__dirname, ".tmp-gemini-mixed");

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makePng(name, rgb) {
  const zlib = require("zlib");
  const width = 48, height = 48;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = rgb[0];
      row[1 + x * 3 + 1] = rgb[1];
      row[1 + x * 3 + 2] = rgb[2];
    }
    rows.push(row);
  }
  const rawData = Buffer.concat(rows);
  const compressed = zlib.deflateSync(rawData);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crc]);
  }

  const png = Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, png);
  return p;
}

function makePdf() {
  const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 55>>stream
BT /F1 18 Tf 40 80 Td (Quarterly revenue summary PDF) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000241 00000 n 
0000000347 00000 n 
trailer<</Root 1 0 R/Size 6>>
startxref
417
%%EOF`;
  const p = path.join(TMP_DIR, "summary.pdf");
  fs.writeFileSync(p, pdf);
  return p;
}

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

async function login(page, context) {
  const resp = await fetch("http://localhost:9471/lc/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!resp.ok) throw new Error(`Login failed: ${resp.status}`);
  const setCookie = resp.headers.get("set-cookie") || "";
  const tokenMatch = setCookie.match(/lc_token=([^;]+)/);
  if (!tokenMatch) throw new Error("No lc_token in login response");
  const url = new URL(BASE_URL);
  await context.addCookies([{
    name: "lc_token",
    value: tokenMatch[1],
    domain: url.hostname,
    path: "/",
    httpOnly: true,
    sameSite: "Strict",
  }]);
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 20000 });
  await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
}

async function selectGeminiFlash(page) {
  await page.click("#mdl-btn");
  await page.waitForTimeout(400);
  const pill = page.locator('.mdl-prov-pill[data-prov="gemini"]').first();
  await pill.click();
  await page.waitForTimeout(500);
  let opt = page.locator('.mdl-opt[data-model="gemini-2.5-flash"]').first();
  if (!(await opt.count())) {
    opt = page.locator('.mdl-opt[data-model="gemini-2.5-flash-lite"]').first();
  }
  if (!(await opt.count())) throw new Error("No Gemini Flash model visible");
  const modelId = await opt.getAttribute("data-model");
  await opt.click();
  await page.waitForTimeout(400);
  return modelId;
}

async function main() {
  ensureDir(TMP_DIR);
  const img1 = makePng("red.png", [255, 0, 0]);
  const img2 = makePng("blue.png", [0, 90, 255]);
  const pdf = makePdf();

  await ensureTestAccount();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await login(page, context);
    const modelId = await selectGeminiFlash(page);
    log(`Selected model: ${modelId}`);

    const chooserPromise = page.waitForEvent("filechooser");
    await page.click("#attach-btn");
    const chooser = await chooserPromise;
    await chooser.setFiles([img1, img2, pdf]);
    await page.waitForTimeout(1200);

    const chipCount = await page.locator("#file-chips .file-chip").count();
    log(`Attached chips: ${chipCount}`);
    if (chipCount !== 3) throw new Error(`Expected 3 chips, got ${chipCount}`);

    await page.fill("#msg-in", "Describe every attachment. State the number of images and mention the PDF contents.");
    await page.click("#send-btn");

    const assistant = page.locator(".msg-row.assistant .asst-content").last();
    await assistant.waitFor({ state: "visible", timeout: 60000 });

    let text = "";
    const started = Date.now();
    while (Date.now() - started < 90000) {
      await page.waitForTimeout(1500);
      text = (await assistant.textContent()) || "";
      if (text.trim().length > 80 && !/Thinking|Typing/i.test(text)) break;
    }
    text = text.trim();
    log(`Assistant response preview: ${text.slice(0, 240)}`);

    const denied = /cannot (?:directly )?(?:see|view|access)|didn'?t receive|haven'?t received|please upload|provide the images|paste the text/i.test(text);
    if (denied) throw new Error(`Gemini still denied the attachments: ${text.slice(0, 240)}`);

    const hasImageSignal = /image|red|blue|square/i.test(text);
    const hasPdfSignal = /pdf|revenue|summary/i.test(text);
    if (!hasImageSignal || !hasPdfSignal) {
      throw new Error(`Response did not mention both image and PDF content clearly: ${text.slice(0, 240)}`);
    }

    log("PASS: Gemini handled mixed image + PDF input.");
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
