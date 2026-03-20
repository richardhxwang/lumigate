#!/usr/bin/env node
/**
 * Generate binary test fixtures (PDF, PNG) for E2E tests.
 * Text-based fixtures live in ../fixtures/ and are checked in.
 * Binary fixtures are generated on-demand by the test runner.
 *
 * Run: node tests/test-files/generate-binary-fixtures.js
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT_DIR = __dirname;

// ── PNG: 64x64 gradient image ───────────────────────────────────────────────

function createTestPNG(outPath) {
  const width = 64, height = 64;
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = (x * 4) & 0xff;       // R
      row[1 + x * 3 + 1] = (y * 4) & 0xff;   // G
      row[1 + x * 3 + 2] = 128;               // B
    }
    rawRows.push(row);
  }
  const compressed = zlib.deflateSync(Buffer.concat(rawRows));

  const crcTable = (() => {
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
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;

  const png = Buffer.concat([sig, makeChunk("IHDR", ihdr), makeChunk("IDAT", compressed), makeChunk("IEND", Buffer.alloc(0))]);
  fs.writeFileSync(outPath, png);
  console.log(`Created: ${outPath} (${png.length} bytes)`);
}

// ── PDF: minimal with text content ──────────────────────────────────────────

function createTestPDF(outPath) {
  const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 95>>
stream
BT
/F1 12 Tf
100 700 Td
(Test PDF document for LumiChat E2E testing. Content verification line.) Tj
ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000266 00000 n
0000000413 00000 n
trailer<</Size 6/Root 1 0 R>>
startxref
487
%%EOF`;
  fs.writeFileSync(outPath, pdf);
  console.log(`Created: ${outPath} (${Buffer.byteLength(pdf)} bytes)`);
}

// ── Generate all ────────────────────────────────────────────────────────────

createTestPNG(path.join(OUT_DIR, "test-image.png"));
createTestPDF(path.join(OUT_DIR, "test-document.pdf"));
console.log("Binary fixtures generated.");
