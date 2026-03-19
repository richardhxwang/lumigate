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

async function encryptPayloadJson(payloadObj, keyInfo) {
  const publicKey = await importServerPublicKey(keyInfo.spki);

  const plaintext = textEncoder.encode(JSON.stringify(payloadObj));
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const aesKey = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext));

  if (encrypted.length < 17) throw new Error("Encryption output too short");
  const tag = encrypted.slice(encrypted.length - 16);
  const ct = encrypted.slice(0, encrypted.length - 16);

  const wrappedKey = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, dek));

  const envelope = {
    v: 1,
    alg: "RSA-OAEP-256/A256GCM",
    kid: keyInfo.kid || "default",
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
      records.push({
        name: normalizeName(f.name || f.file?.name || "file"),
        mime: getMime(f),
        kind: kindFromMimeName(f),
        size: Number(f.file?.size || bytes.length || 0),
        data_b64: bytesToBase64Url(bytes),
      });
    }

    if (!records.length) throw new Error("No valid files to encrypt");

    // Always refresh public key before packing to avoid stale-key failures after server restart.
    const keyInfo = await ensureKey(true);
    const payload = {
      kind: "encrypted_upload_bundle",
      created_at: new Date().toISOString(),
      files: records,
    };
    const encryptedText = await encryptPayloadJson(payload, keyInfo);

    const summaryText = buildSummaryText(records, lang);
    try {
      window.clientLog?.("info", "encrypted_pack_ok", {
        fileCount: records.length,
        kinds: records.map(r => r.kind),
        totalBytes: records.reduce((sum, r) => sum + (r.size || 0), 0),
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
