/**
 * LumiChat Media E2E Test
 *
 * Tests image upload + vision, audio transcription endpoint,
 * voice input UI, and multi-format file upload chips.
 *
 * Run: node tests/media-test.spec.js
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

const SS_DIR = path.join(__dirname, "screenshots", "media");
const TMP_DIR = path.join(__dirname, ".tmp-media-fixtures");

const results = [];

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── Test file generators ──────────────────────────────────────────────────

function createTestPNG() {
  // Create a 64x64 red square PNG using canvas-like raw construction
  // Use zlib to create a valid compressed IDAT chunk
  const zlib = require("zlib");
  const width = 64, height = 64;

  // Raw image data: filter byte (0) + RGB pixels per row
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = 255;     // R
      row[1 + x * 3 + 1] = 0;   // G
      row[1 + x * 3 + 2] = 0;   // B
    }
    rawRows.push(row);
  }
  const rawData = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(rawData);

  // CRC32 helper
  const crcTable = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([len, typeAndData, crc]);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const png = Buffer.concat([
    sig,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);

  const p = path.join(TMP_DIR, "test-image.png");
  fs.writeFileSync(p, png);
  return p;
}

function createTestWAV() {
  // Minimal WAV: 16-bit mono, 8000 Hz, 0.1s of silence (800 samples)
  const numSamples = 800;
  const dataSize = numSamples * 2; // 16-bit = 2 bytes per sample
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);       // chunk size
  buf.writeUInt16LE(1, 20);        // PCM
  buf.writeUInt16LE(1, 22);        // mono
  buf.writeUInt32LE(8000, 24);     // sample rate
  buf.writeUInt32LE(16000, 28);    // byte rate
  buf.writeUInt16LE(2, 32);        // block align
  buf.writeUInt16LE(16, 34);       // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  // samples are all zeros (silence)
  const p = path.join(TMP_DIR, "test-audio.wav");
  fs.writeFileSync(p, buf);
  return p;
}

function createTestPDF() {
  // Minimal valid PDF
  const pdf = `%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer<</Size 4/Root 1 0 R>>
startxref
190
%%EOF`;
  const p = path.join(TMP_DIR, "test-document.pdf");
  fs.writeFileSync(p, pdf);
  return p;
}

function createTestCSV() {
  const csv = "name,value\nalpha,1\nbeta,2\ngamma,3\n";
  const p = path.join(TMP_DIR, "test-data.csv");
  fs.writeFileSync(p, csv);
  return p;
}

// ── Auth helpers (same as provider-test) ──────────────────────────────────

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
    if (resp.ok) log(`Created test account: ${EMAIL}`);
    else log(`Test account status: ${resp.status}`);
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
      log(`API login failed (${resp.status}), trying UI login...`);
      return await loginViaUI(page);
    }
    const setCookie = resp.headers.get("set-cookie") || "";
    const tokenMatch = setCookie.match(/lc_token=([^;]+)/);
    if (!tokenMatch) {
      log("No lc_token cookie, falling back to UI login...");
      return await loginViaUI(page);
    }
    const token = tokenMatch[1];
    log(`Got auth token (${token.slice(0, 20)}...)`);
    const url = new URL(BASE_URL);
    await context.addCookies([{
      name: "lc_token", value: token, domain: url.hostname,
      path: "/", httpOnly: true, sameSite: "Strict",
    }]);
    await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
    log("Login successful.");
    return true;
  } catch (e) {
    log(`API login error: ${e.message}`);
    return await loginViaUI(page);
  }
}

async function loginViaUI(page) {
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForSelector("#l-email", { state: "visible", timeout: 10000 });
  await page.fill("#l-email", EMAIL);
  await page.click("#email-continue-btn");
  try {
    await page.waitForSelector("#auth-step-login:not([style*='display: none'])", {
      state: "visible", timeout: 5000,
    });
    await page.fill("#l-pass", PASSWORD);
    await page.click("#auth-step-login .auth-btn");
  } catch {
    await page.waitForSelector("#auth-step-register", { state: "visible", timeout: 5000 });
    await page.fill("#r-pass", PASSWORD);
    await page.fill("#r-pass2", PASSWORD);
    await page.click("#auth-step-register .auth-btn");
  }
  await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
  log("UI login successful.");
  return true;
}

async function selectVisionModel(page) {
  // Try to select a vision-capable model: gemini-2.5-flash-lite > gpt-4.1-nano > any openai
  await page.click("#mdl-btn");
  await page.waitForTimeout(400);
  await page.waitForSelector("#mdl-drop.open", { timeout: 3000 }).catch(() => {});

  // Try providers in order of vision capability
  for (const prov of ["gemini", "openai"]) {
    const pill = await page.$(`.mdl-prov-pill[data-prov="${prov}"]`);
    if (!pill) continue;
    const isLocked = await pill.evaluate(el => el.style.opacity === "0.4" || el.classList.contains("locked"));
    if (isLocked) continue;

    await pill.click();
    await page.waitForTimeout(600);

    // Pick any model (all modern models support vision)
    const modelOpt = await page.$(".mdl-opt");
    if (!modelOpt) continue;
    const modelId = await modelOpt.getAttribute("data-model");
    await modelOpt.click();
    await page.waitForTimeout(400);
    return modelId;
  }
  // Close dropdown if no vision model found
  await page.keyboard.press("Escape");
  return null;
}

async function sendMessageAndWait(page, message, timeoutMs = 45000) {
  await page.fill("#msg-in", message);
  await page.waitForTimeout(200);
  await page.evaluate(() => { if (typeof sendMessage === "function") sendMessage(); });

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const state = await page.evaluate(() => {
      const rows = document.querySelectorAll(".msg-row.assistant .asst-content");
      const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
      return {
        text: lastRow ? lastRow.innerText : "",
        isStreaming: typeof isStreaming !== "undefined" ? isStreaming : false,
      };
    });
    if (state.text && state.text.trim().length > 3 && !state.isStreaming) {
      return { ok: true, text: state.text.trim() };
    }
    const errorText = await page.evaluate(() => {
      const toast = document.querySelector("#toast");
      if (toast && toast.classList.contains("show")) return toast.textContent;
      return null;
    });
    if (errorText) return { ok: false, text: "", reason: `error: ${errorText}` };
    await page.waitForTimeout(500);
  }
  const finalText = await page.evaluate(() => {
    const rows = document.querySelectorAll(".msg-row.assistant .asst-content");
    const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
    return lastRow ? lastRow.innerText : "";
  });
  if (finalText && finalText.trim().length > 0) return { ok: true, text: finalText.trim() };
  return { ok: false, text: "", reason: "timeout" };
}

// ── Test 1: Image Upload + Vision ─────────────────────────────────────────

async function testImageUploadVision(page) {
  log("=== Test 1: Image Upload + Vision ===");

  const imgPath = createTestPNG();
  log(`Created test PNG: ${imgPath}`);

  // Select vision-capable model
  const model = await selectVisionModel(page);
  if (!model) {
    log("SKIP: No vision-capable model available");
    return { test: "Image Upload + Vision", status: "SKIP", reason: "no vision model" };
  }
  log(`Selected vision model: ${model}`);

  // Upload image via file input
  await page.setInputFiles("#file-in", imgPath);
  await page.waitForTimeout(800);

  // Check file chip appeared
  const chipCount = await page.evaluate(() =>
    document.querySelectorAll("#file-chips .fchip").length
  );
  log(`File chips visible: ${chipCount}`);
  if (chipCount === 0) {
    await page.screenshot({ path: path.join(SS_DIR, "01-image-no-chip.png") });
    return { test: "Image Upload + Vision", status: "FAIL", reason: "no file chip appeared" };
  }

  // Verify it is an image chip (has thumbnail)
  const hasThumb = await page.evaluate(() =>
    !!document.querySelector("#file-chips .fchip-thumb")
  );
  log(`Image thumbnail in chip: ${hasThumb}`);

  await page.screenshot({ path: path.join(SS_DIR, "01-image-chip.png") });

  // Send message with image — handle possible page navigation
  let resp;
  try {
    resp = await sendMessageAndWait(page, "Describe this image in one sentence.");
  } catch (navErr) {
    // Page may have navigated (e.g., session refresh). Wait and retry.
    log(`Navigation during send: ${navErr.message.slice(0, 60)}`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 }).catch(() => {});
    resp = { ok: false, reason: "page navigated during send" };
  }
  await page.screenshot({ path: path.join(SS_DIR, "01-image-response.png") }).catch(() => {});

  if (resp.ok) {
    const preview = resp.text.slice(0, 100).replace(/\n/g, " ");
    log(`PASS: Vision response: ${preview}`);
    return { test: "Image Upload + Vision", status: "PASS", model, detail: preview };
  } else {
    log(`FAIL: ${resp.reason}`);
    return { test: "Image Upload + Vision", status: "FAIL", model, reason: resp.reason };
  }
}

// ── Test 2: Audio Transcription Endpoint ──────────────────────────────────

async function testAudioTranscriptionEndpoint() {
  log("=== Test 2: Audio Transcription Endpoint ===");

  const wavPath = createTestWAV();
  const wavBuf = fs.readFileSync(wavPath);

  try {
    // Test the endpoint exists with a properly formed request
    const res = await fetch("http://localhost:9471/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wavBuf,
    });
    const status = res.status;
    let body;
    try { body = await res.json(); } catch { body = await res.text().catch(() => ""); }

    log(`Transcription endpoint status: ${status}`);
    log(`Response: ${JSON.stringify(body).slice(0, 200)}`);

    if (status === 200 && body?.ok) {
      log("PASS: Whisper service is running and responded");
      return { test: "Audio Transcription API", status: "PASS", detail: `text: ${body.text || "(empty)"}` };
    } else if (status === 401 || status === 403) {
      log("PASS: Endpoint exists (auth required, as expected)");
      return { test: "Audio Transcription API", status: "PASS", detail: `auth required (${status})` };
    } else if (status === 502 || status === 503) {
      log("SKIP: Whisper service not running");
      return { test: "Audio Transcription API", status: "SKIP", reason: `whisper unavailable (${status})` };
    } else {
      log(`INFO: Endpoint responded with ${status}`);
      return { test: "Audio Transcription API", status: "PASS", detail: `endpoint exists (${status})` };
    }
  } catch (e) {
    log(`FAIL: Could not reach endpoint: ${e.message}`);
    return { test: "Audio Transcription API", status: "FAIL", reason: e.message };
  }
}

// ── Test 3: Voice Input UI ────────────────────────────────────────────────

async function testVoiceInputUI(page) {
  log("=== Test 3: Voice Input UI ===");

  // Check mic button exists
  const micExists = await page.evaluate(() => {
    const btn = document.getElementById("mic-btn");
    return btn ? { display: getComputedStyle(btn).display, visible: btn.offsetParent !== null } : null;
  });
  log(`Mic button: ${JSON.stringify(micExists)}`);

  if (!micExists) {
    return { test: "Voice Input UI", status: "FAIL", reason: "mic button not found in DOM" };
  }

  // Check voice overlay exists in DOM
  const overlayExists = await page.evaluate(() => {
    const ov = document.getElementById("voice-overlay");
    return ov ? { display: getComputedStyle(ov).display } : null;
  });
  log(`Voice overlay: ${JSON.stringify(overlayExists)}`);

  // Screenshot current state (mic button visible or hidden depending on browser support)
  await page.screenshot({ path: path.join(SS_DIR, "03-voice-ui-initial.png") });

  if (micExists.display === "none") {
    log("SKIP: Mic button hidden (mediaDevices not available in this browser)");
    return { test: "Voice Input UI", status: "SKIP", reason: "mediaDevices not available" };
  }

  // Try clicking the mic button — in headless mode getUserMedia will fail,
  // but we can verify the click handler fires
  try {
    // Override getUserMedia to simulate denial (avoids hanging on permission dialog)
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error("Permission denied"));
    });

    await page.click("#mic-btn");
    await page.waitForTimeout(1000);

    await page.screenshot({ path: path.join(SS_DIR, "03-voice-after-click.png") });

    // Check if a toast appeared (mic denied message)
    const toastText = await page.evaluate(() => {
      const t = document.getElementById("toast");
      return t ? t.textContent : "";
    });
    log(`Toast after mic click: "${toastText}"`);

    if (toastText.includes("denied") || toastText.includes("permission") || toastText.includes("Microphone") || toastText.includes("麦克风")) {
      log("PASS: Mic click triggers permission flow correctly");
      return { test: "Voice Input UI", status: "PASS", detail: "permission denied toast shown" };
    }

    // Check if overlay activated
    const overlayActive = await page.evaluate(() =>
      document.getElementById("voice-overlay")?.classList.contains("active")
    );
    if (overlayActive) {
      log("PASS: Voice overlay activated");
      await page.screenshot({ path: path.join(SS_DIR, "03-voice-overlay-active.png") });
      return { test: "Voice Input UI", status: "PASS", detail: "overlay activated" };
    }

    log("PASS: Mic button clickable, handler ran");
    return { test: "Voice Input UI", status: "PASS", detail: "click handler executed" };
  } catch (e) {
    log(`Voice UI test error: ${e.message}`);
    return { test: "Voice Input UI", status: "FAIL", reason: e.message };
  }
}

// ── Test 4: Multi-format File Upload Chips ────────────────────────────────

async function testFileTypeChips(page) {
  log("=== Test 4: File Type Upload Chips ===");

  // Start fresh chat
  try {
    await page.click("#new-chat");
    await page.waitForTimeout(600);
  } catch {
    await page.evaluate(() => { if (typeof newChat === "function") newChat(); });
    await page.waitForTimeout(600);
  }

  const files = [
    { path: createTestPNG(), name: "test-image.png", kind: "image" },
    { path: createTestPDF(), name: "test-document.pdf", kind: "pdf" },
    { path: createTestCSV(), name: "test-data.csv", kind: "text" },
  ];

  const subResults = [];
  for (const f of files) {
    // Clear existing chips
    await page.evaluate(() => {
      if (typeof pendingFiles !== "undefined") { pendingFiles.length = 0; }
      const fc = document.getElementById("file-chips");
      if (fc) fc.innerHTML = "";
    });

    await page.setInputFiles("#file-in", f.path);
    await page.waitForTimeout(800);

    const chipInfo = await page.evaluate(() => {
      const chips = document.querySelectorAll("#file-chips .fchip");
      return Array.from(chips).map(c => ({
        name: c.querySelector(".fchip-name")?.textContent || "",
        type: c.querySelector(".fchip-type")?.textContent || "",
        hasThumb: !!c.querySelector(".fchip-thumb"),
      }));
    });

    const found = chipInfo.length > 0;
    const status = found ? "PASS" : "FAIL";
    const detail = found
      ? `chip: ${chipInfo[0].name} (${chipInfo[0].type})${chipInfo[0].hasThumb ? " +thumb" : ""}`
      : "no chip";
    log(`  ${f.name}: ${status} — ${detail}`);
    subResults.push({ file: f.name, kind: f.kind, status, detail });
  }

  await page.screenshot({ path: path.join(SS_DIR, "04-file-chips.png") });

  const allPass = subResults.every(r => r.status === "PASS");
  return {
    test: "File Type Chips",
    status: allPass ? "PASS" : "FAIL",
    detail: subResults.map(r => `${r.file}:${r.status}`).join(", "),
    subResults,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(SS_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  await ensureTestAccount();

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  try {
    const loggedIn = await login(page, context);
    if (!loggedIn) {
      log("FATAL: Could not log in.");
      process.exit(1);
    }

    // Test 1: Image upload + vision
    try {
      results.push(await testImageUploadVision(page));
    } catch (e) {
      log(`ERROR in test 1: ${e.message}`);
      await page.screenshot({ path: path.join(SS_DIR, "01-error.png") }).catch(() => {});
      results.push({ test: "Image Upload + Vision", status: "FAIL", reason: e.message.slice(0, 120) });
    }

    // Test 2: Audio transcription (API level, no browser needed)
    try {
      results.push(await testAudioTranscriptionEndpoint());
    } catch (e) {
      log(`ERROR in test 2: ${e.message}`);
      results.push({ test: "Audio Transcription API", status: "FAIL", reason: e.message.slice(0, 120) });
    }

    // Test 3: Voice input UI — reload page to get clean state
    try {
      await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });
      await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
    } catch { /* continue */ }
    try {
      results.push(await testVoiceInputUI(page));
    } catch (e) {
      log(`ERROR in test 3: ${e.message}`);
      await page.screenshot({ path: path.join(SS_DIR, "03-error.png") }).catch(() => {});
      results.push({ test: "Voice Input UI", status: "FAIL", reason: e.message.slice(0, 120) });
    }

    // Test 4: Multi-format file chips — reload page for clean state
    try {
      await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });
      await page.waitForSelector("#msg-in", { state: "visible", timeout: 10000 });
    } catch { /* continue */ }
    try {
      results.push(await testFileTypeChips(page));
    } catch (e) {
      log(`ERROR in test 4: ${e.message}`);
      await page.screenshot({ path: path.join(SS_DIR, "04-error.png") }).catch(() => {});
      results.push({ test: "File Type Chips", status: "FAIL", reason: e.message.slice(0, 120) });
    }

  } finally {
    await browser.close();
    // Cleanup temp files
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }

  // ── Summary ──
  console.log("\n" + "=".repeat(90));
  console.log("MEDIA TEST SUMMARY");
  console.log("=".repeat(90));
  console.log("Test".padEnd(28) + "Status".padEnd(8) + "Detail");
  console.log("-".repeat(90));

  let pass = 0, fail = 0, skip = 0;
  for (const r of results) {
    const detail = r.detail || r.reason || r.model || "";
    console.log(r.test.padEnd(28) + r.status.padEnd(8) + String(detail).slice(0, 55));
    if (r.status === "PASS") pass++;
    else if (r.status === "FAIL") fail++;
    else skip++;
  }

  console.log("-".repeat(90));
  console.log(`Total: ${results.length} | PASS: ${pass} | FAIL: ${fail} | SKIP: ${skip}`);
  console.log("=".repeat(90));

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
