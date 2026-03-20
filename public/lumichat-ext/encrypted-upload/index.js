const textEncoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const part = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...part);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function utf8ToBase64Url(str) {
  return bytesToBase64Url(textEncoder.encode(String(str || "")));
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

function getMime(file) {
  return String(file?.mime || file?.type || file?.file?.type || "application/octet-stream");
}

function normalizeName(name) {
  return String(name || "file").replace(/[\r\n\0]/g, "_").slice(0, 255);
}

function kindFromMimeName(fileObj) {
  const mime = getMime(fileObj);
  const name = normalizeName(fileObj?.name || fileObj?.file?.name || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (mime.startsWith("text/") || /\.(txt|md|csv|json|js|ts|jsx|tsx|py|html|css|xml|yaml|yml|sh|log|c|cpp|java|go|rs|rb|php|swift|kt)$/i.test(name)) return "text";
  return "document";
}

function localizedKindLabel(kind, lang) {
  const MAP = {
    image: { en: "Image", zh: "图片" },
    audio: { en: "Audio", zh: "音频" },
    video: { en: "Video", zh: "视频" },
    pdf: { en: "PDF", zh: "PDF" },
    text: { en: "Text", zh: "文本" },
    document: { en: "Document", zh: "文档" },
  };
  const entry = MAP[kind] || { en: kind, zh: kind };
  return entry[lang] || entry.en;
}

function buildSummaryText(records, lang) {
  const counts = {};
  for (const rec of records) {
    const label = localizedKindLabel(rec.kind, lang);
    counts[label] = (counts[label] || 0) + 1;
  }
  const subtitle = Object.entries(counts)
    .map(([label, count]) => (count > 1 ? `${label}×${count}` : label))
    .join(" · ");
  if (lang === "zh") return `[加密文件: ${subtitle || `${records.length} 个文件`}]`;
  return `[Encrypted Files: ${subtitle || `${records.length} file(s)`}]`;
}

async function readFileBytes(fileObj) {
  const src = fileObj?.file;
  if (!(src instanceof File)) throw new Error("Invalid file object");
  const buf = await src.arrayBuffer();
  return new Uint8Array(buf);
}

async function gzipCompressBytes(bytes) {
  // Skip browser gzip — CompressionStream hangs in Safari and some Headless Chrome.
  // The payload is already encrypted (AES-GCM), so compression adds minimal benefit
  // on already-compressed files (PDF, XLSX, DOCX are all ZIP-based internally).
  // Server handles both compressed and uncompressed payloads (checks envelope.zip field).
  return { bytes, algorithm: "none" };
}

function packBundleV2(records) {
  const manifest = {
    v: 2,
    kind: "encrypted_upload_bundle",
    created_at: new Date().toISOString(),
    files: [],
  };
  let dataBytes = 0;
  for (const rec of records) {
    dataBytes += rec.bytes.length;
  }
  let offset = 0;
  for (const rec of records) {
    manifest.files.push({
      name: rec.name,
      mime: rec.mime,
      kind: rec.kind,
      size: rec.size,
      offset,
      length: rec.bytes.length,
      sha256: rec.sha256,
    });
    offset += rec.bytes.length;
  }
  const manifestBytes = textEncoder.encode(JSON.stringify(manifest));
  const magic = textEncoder.encode("LCPK2");
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, manifestBytes.length, false);

  const out = new Uint8Array(magic.length + len.length + manifestBytes.length + dataBytes);
  let p = 0;
  out.set(magic, p); p += magic.length;
  out.set(len, p); p += len.length;
  out.set(manifestBytes, p); p += manifestBytes.length;
  for (const rec of records) {
    out.set(rec.bytes, p);
    p += rec.bytes.length;
  }
  return out;
}

async function importServerPublicKey(spkiB64) {
  const raw = Uint8Array.from(atob(spkiB64), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "spki",
    raw,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );
}

async function fetchPublicKey() {
  const res = await fetch("/lc/crypto/public-key", { credentials: "same-origin" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(t || `Key fetch failed (${res.status})`);
  }
  const data = await res.json();
  if (!data?.spki || data?.alg !== "RSA-OAEP-256") {
    throw new Error("Invalid key response");
  }
  return data;
}

async function encryptPayloadBytes(plaintext, keyInfo, opts = {}) {
  const publicKey = await importServerPublicKey(keyInfo.spki);
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const aesKey = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext));

  if (encrypted.length < 17) throw new Error("Encryption output too short");
  const tag = encrypted.slice(encrypted.length - 16);
  const ct = encrypted.slice(0, encrypted.length - 16);

  const wrappedKey = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, dek));

  const envelope = {
    v: 2,
    alg: "RSA-OAEP-256/A256GCM",
    kid: keyInfo.kid || "default",
    fmt: opts.format || "json",
    zip: opts.zip || "none",
    usize: Number(opts.uncompressedSize || plaintext.length || 0),
    psize: Number(opts.packedSize || plaintext.length || 0),
    ek: bytesToBase64Url(wrappedKey),
    iv: bytesToBase64Url(iv),
    tag: bytesToBase64Url(tag),
    ct: bytesToBase64Url(ct),
  };
  return `LCENC1:${utf8ToBase64Url(JSON.stringify(envelope))}`;
}

export function createEncryptedUploadExtension() {
  let keyPromise = null;

  async function ensureKey(forceRefresh = false) {
    if (forceRefresh || !keyPromise) keyPromise = fetchPublicKey();
    return keyPromise;
  }

  async function packFiles(fileObjs) {
    const files = Array.isArray(fileObjs) ? fileObjs : [];
    if (!files.length) throw new Error("No files selected");
    const lang = (document?.documentElement?.lang || localStorage.getItem("lc_lang") || "en").startsWith("zh") ? "zh" : "en";
    try { window.clientLog?.("info", "encrypted_pack_start", { fileCount: files.length, lang }); } catch {}

    const records = [];
    for (const f of files) {
      if (!f?.file) continue;
      const bytes = await readFileBytes(f);
      const sha256 = await sha256Hex(bytes);
      records.push({
        name: normalizeName(f.name || f.file?.name || "file"),
        mime: getMime(f),
        kind: kindFromMimeName(f),
        size: Number(f.file?.size || bytes.length || 0),
        sha256,
        bytes,
      });
    }

    if (!records.length) throw new Error("No valid files to encrypt");

    const packed = packBundleV2(records);
    const compressed = await gzipCompressBytes(packed);
    const compressionRatio = packed.length ? Number((compressed.bytes.length / packed.length).toFixed(4)) : 1;

    // Use cached key if available; only refresh if no key cached yet.
    // Stale keys will fail at server decryption → user retries → activate() refreshes.
    const keyInfo = await ensureKey(false);
    const encryptedText = await encryptPayloadBytes(compressed.bytes, keyInfo, {
      format: "lcpack2",
      zip: compressed.algorithm,
      uncompressedSize: packed.length,
      packedSize: compressed.bytes.length,
    });

    const summaryText = buildSummaryText(records, lang);
    try {
      window.clientLog?.("info", "encrypted_pack_ok", {
        fileCount: records.length,
        kinds: records.map(r => r.kind),
        totalBytes: records.reduce((sum, r) => sum + (r.size || 0), 0),
        packedBytes: packed.length,
        compressedBytes: compressed.bytes.length,
        compression: compressed.algorithm,
        compressionRatio,
        summaryText,
      });
    } catch {}
    return {
      encryptedPayloadText: encryptedText,
      summaryText,
      fileNames: records.map(r => r.name),
    };
  }

  return {
    async activate() { await ensureKey(true); return true; },
    deactivate() { return true; },
    status() { return { ready: !!keyPromise }; },
    packFiles,
  };
}
