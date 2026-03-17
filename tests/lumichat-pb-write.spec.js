/**
 * LumiChat -> PocketBase write-path regression test.
 *
 * Validates that a browser-driven send with image + PDF:
 * 1. triggers /lc/files uploads
 * 2. creates a user message
 * 3. PATCHes file_ids back onto the message
 * 4. persists retrievable records through LumiChat APIs
 *
 * Run:
 *   node tests/lumichat-pb-write.spec.js
 */

const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const BASE_URL = process.env.LC_URL || "http://localhost:9471/lumichat";
const API_BASE = process.env.LC_API_BASE || "http://localhost:9471";
const EMAIL = process.env.LC_EMAIL || "test@lumigate.local";
const PASSWORD = process.env.LC_PASSWORD || "testpass123";
const TMP_DIR = path.join(__dirname, ".tmp-pb-write");

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function makePng(name, rgb) {
  const zlib = require("zlib");
  const width = 32, height = 32;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = rgb[0];
      row[1 + x * 3 + 1] = rgb[1];
      row[1 + x * 3 + 2] = rgb[2];
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const compressed = zlib.deflateSync(raw);
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const file = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, file);
  return p;
}

function makePdf(name, text) {
  const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${text.length + 33}>>stream
BT /F1 14 Tf 20 72 Td (${text}) Tj ET
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
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, pdf);
  return p;
}

async function ensureTestAccount() {
  try {
    await fetch(`${API_BASE}/lc/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: EMAIL,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
        name: "PB Write Test User",
      }),
    });
  } catch {}
}

async function loginViaApi(context) {
  const resp = await fetch(`${API_BASE}/lc/auth/login`, {
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
  return tokenMatch[1];
}

async function api(path, { token, method = "GET", body } = {}) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      Cookie: `lc_token=${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  return { resp, data: text ? JSON.parse(text) : null };
}

async function main() {
  ensureDir(TMP_DIR);
  const img = makePng("pb-write.png", [12, 146, 96]);
  const pdf = makePdf("pb-write.pdf", "PB write test PDF");
  await ensureTestAccount();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const uploadRecords = [];
  let createdSession = null;
  let createdMessage = null;
  let patchedMessage = null;

  page.on("response", async (resp) => {
    try {
      const url = resp.url();
      if (url.endsWith("/lc/sessions") && resp.request().method() === "POST") {
        createdSession = await resp.json();
      }
      if (url.includes("/lc/files") && resp.request().method() === "POST") {
        const json = await resp.json();
        uploadRecords.push(json);
      }
      if (url.endsWith("/lc/messages") && resp.request().method() === "POST") {
        createdMessage = await resp.json();
      }
      if (/\/lc\/messages\/[^/]+$/.test(url) && resp.request().method() === "PATCH") {
        patchedMessage = await resp.json();
      }
    } catch {}
  });

  try {
    const token = await loginViaApi(context);
    await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });

    const chooserPromise = page.waitForEvent("filechooser");
    await page.click("#attach-btn");
    const chooser = await chooserPromise;
    await chooser.setFiles([img, pdf]);
    await page.waitForTimeout(1200);

    const stamp = `pb-write-${Date.now()}`;
    await page.fill("#msg-in", `Store these files and create a message marker: ${stamp}`);
    await page.click("#send-btn");

    await page.waitForFunction(() => document.querySelectorAll(".msg-row.user").length > 0, null, { timeout: 20000 });

    const started = Date.now();
    while (Date.now() - started < 20000) {
      if (uploadRecords.length >= 2 && createdSession?.id && createdMessage?.id && patchedMessage?.file_ids?.length >= 2) break;
      await page.waitForTimeout(500);
    }

    if (uploadRecords.length < 2) {
      throw new Error(`Expected 2 /lc/files uploads, got ${uploadRecords.length}`);
    }
    if (!createdSession?.id) {
      throw new Error("Session was not created through /lc/sessions POST");
    }
    if (!createdMessage?.id) {
      throw new Error("User message was not created through /lc/messages POST");
    }
    if (createdMessage.session !== createdSession.id) {
      throw new Error(`Message session mismatch: message=${createdMessage.session} session=${createdSession.id}`);
    }
    if (!patchedMessage?.id || (patchedMessage.file_ids || []).length < 2) {
      throw new Error(`Message PATCH did not attach file_ids correctly: ${JSON.stringify(patchedMessage)}`);
    }

    const messages = await api(`/lc/sessions/${createdMessage.session}/messages`, { token });
    if (!messages.resp.ok) throw new Error(`Failed to list messages: ${messages.resp.status}`);
    const saved = (messages.data.items || []).find((item) => item.id === createdMessage.id);
    if (!saved) throw new Error(`Created message ${createdMessage.id} not found in session messages`);
    if ((saved.file_ids || []).length < 2) throw new Error(`Saved message missing file_ids: ${JSON.stringify(saved)}`);

    log(`PASS: LumiChat wrote session ${createdSession.id}, message ${saved.id}, files ${saved.file_ids.join(", ")}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
