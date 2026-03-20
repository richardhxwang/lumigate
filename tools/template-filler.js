"use strict";

/**
 * Template Filler — Fill Word/Excel templates with data from another source.
 *
 * Use cases:
 *   - Director confirmation letters (Word template + Excel data)
 *   - Bank confirmations, AR/AP confirmations
 *   - Any audit letter following a template with {{placeholders}}
 *
 * Supports:
 *   - Text-based template filling ({{placeholder}} replacement)
 *   - Binary .docx template filling (unzip → XML replace → rezip)
 *   - Batch generation: N data objects → N filled documents
 *   - Output as .docx via doc-gen microservice
 *
 * Registered via unifiedRegistry.registerTool(schema, handler).
 */

const { unifiedRegistry } = require("./unified-registry");

const PB_URL = process.env.PB_URL || "http://localhost:8090";
const DOC_GEN_URL = process.env.DOC_GEN_URL || "http://lumigate-doc-gen:3101";
const SANDBOX_URL = process.env.SANDBOX_URL || "http://lumigate-sandbox:3101";
const DOC_GEN_MODE = (process.env.DOC_GEN_MODE || "auto").toLowerCase();

// ── Schema ──────────────────────────────────────────────────────────────────────

const FILL_TEMPLATE_SCHEMA = {
  name: "fill_template",
  description:
    "Fill a Word/Excel template with data from another file. Supports {{placeholder}} syntax. " +
    "Can generate multiple filled copies from array data (e.g. one confirmation letter per director).",
  input_schema: {
    type: "object",
    properties: {
      template_text: {
        type: "string",
        description:
          "Extracted text from template file with {{placeholders}}. " +
          "Use this for text-based filling when you have the template content.",
      },
      template_file_id: {
        type: "string",
        description:
          "PocketBase file ID of the uploaded template (.docx). " +
          "If provided, the binary template is fetched and placeholders are replaced in-place, preserving formatting.",
      },
      template_collection: {
        type: "string",
        description:
          "PocketBase collection name where the template file is stored (default: 'lc_files').",
      },
      template_field: {
        type: "string",
        description:
          "PocketBase field name for the file attachment (default: 'file').",
      },
      data: {
        type: "array",
        description:
          "Array of data objects. Each object fills one copy of the template. " +
          "Keys must match placeholder names (e.g. {director_name: 'Alice', total_compensation: '500,000'}).",
        items: { type: "object" },
      },
      output_format: {
        type: "string",
        enum: ["docx", "xlsx", "pdf"],
        description: "Output format. Default: docx.",
      },
      output_filename: {
        type: "string",
        description:
          "Output filename prefix. Each generated file appends an index or key field value.",
      },
      merge: {
        type: "boolean",
        description:
          "If true and data has multiple items, merge all filled copies into one document with page breaks. Default: false (separate files).",
      },
      key_field: {
        type: "string",
        description:
          "Field name from data to use in output filenames (e.g. 'director_name'). " +
          "If not set, files are numbered sequentially.",
      },
    },
    required: ["data"],
  },
};

// ── Text-based template filling ─────────────────────────────────────────────────

/**
 * Replace all {{placeholder}} tokens in a text string with values from a data object.
 * Unmatched placeholders are left as-is.
 * Supports nested dot notation: {{address.city}} looks up data.address.city.
 */
function fillTemplateText(templateText, data) {
  return templateText.replace(/\{\{(\w[\w.]*)\}\}/g, (_match, key) => {
    // Support dot notation for nested objects
    const val = key.split(".").reduce((obj, k) => (obj && obj[k] !== undefined ? obj[k] : undefined), data);
    return val !== undefined ? String(val) : `{{${key}}}`;
  });
}

// ── Binary .docx template filling ───────────────────────────────────────────────

/**
 * Fill a .docx binary template by manipulating its XML directly.
 *
 * .docx is a ZIP containing word/document.xml (and headers/footers).
 * Word often splits {{placeholder}} across multiple XML <w:r> runs, e.g.:
 *   <w:r><w:t>{{</w:t></w:r><w:r><w:t>name</w:t></w:r><w:r><w:t>}}</w:t></w:r>
 *
 * Strategy:
 *   1. Extract text content from all <w:t> elements
 *   2. Concatenate them to find placeholder boundaries
 *   3. Replace placeholders in the concatenated text
 *   4. Re-distribute text back into the original <w:t> elements
 *
 * Uses Node.js built-in zlib (via ZIP parsing) — no external ZIP library needed.
 * We implement minimal ZIP read/write to avoid adding dependencies.
 */

const zlib = require("node:zlib");

/**
 * Minimal ZIP reader/writer for .docx manipulation.
 * Only handles deflate (method 8) and store (method 0) — sufficient for .docx files.
 */
class SimpleZip {
  constructor(buffer) {
    this.buffer = buffer;
    this.entries = this._parseEntries();
  }

  _parseEntries() {
    const buf = this.buffer;
    const entries = [];

    // Find End of Central Directory record (search from end)
    let eocdOffset = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) throw new Error("Invalid ZIP: EOCD not found");

    const cdOffset = buf.readUInt32LE(eocdOffset + 16);
    const cdEntryCount = buf.readUInt16LE(eocdOffset + 10);

    let offset = cdOffset;
    for (let i = 0; i < cdEntryCount; i++) {
      if (buf.readUInt32LE(offset) !== 0x02014b50) break;

      const method = buf.readUInt16LE(offset + 10);
      const crc32 = buf.readUInt32LE(offset + 16);
      const compressedSize = buf.readUInt32LE(offset + 20);
      const uncompressedSize = buf.readUInt32LE(offset + 24);
      const nameLen = buf.readUInt16LE(offset + 28);
      const extraLen = buf.readUInt16LE(offset + 30);
      const commentLen = buf.readUInt16LE(offset + 32);
      const localHeaderOffset = buf.readUInt32LE(offset + 42);
      const name = buf.toString("utf-8", offset + 46, offset + 46 + nameLen);

      // Read local header to find actual data offset
      const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;

      const compressedData = buf.subarray(dataOffset, dataOffset + compressedSize);

      let data;
      if (method === 0) {
        // Stored
        data = compressedData;
      } else if (method === 8) {
        // Deflate
        data = zlib.inflateRawSync(compressedData);
      } else {
        // Unknown method — keep compressed, mark as raw
        data = compressedData;
      }

      entries.push({
        name,
        method,
        crc32,
        compressedSize,
        uncompressedSize,
        data,
        _originalCompressed: compressedData,
      });

      offset += 46 + nameLen + extraLen + commentLen;
    }

    return entries;
  }

  readAsText(entryName) {
    const entry = this.entries.find((e) => e.name === entryName);
    if (!entry) return null;
    return entry.data.toString("utf-8");
  }

  updateFile(entryName, newContent) {
    const entry = this.entries.find((e) => e.name === entryName);
    if (!entry) return false;
    const buf = Buffer.isBuffer(newContent) ? newContent : Buffer.from(newContent, "utf-8");
    entry.data = buf;
    entry.uncompressedSize = buf.length;
    entry._modified = true;
    return true;
  }

  toBuffer() {
    const parts = [];
    const centralDir = [];
    let offset = 0;

    for (const entry of this.entries) {
      const nameBuffer = Buffer.from(entry.name, "utf-8");

      let compressedData;
      let method;
      if (entry._modified) {
        // Re-compress modified entries with deflate
        compressedData = zlib.deflateRawSync(entry.data);
        method = 8;
      } else if (entry.method === 0) {
        compressedData = entry.data;
        method = 0;
      } else {
        compressedData = entry._originalCompressed;
        method = entry.method;
      }

      const crc = entry._modified ? crc32(entry.data) : entry.crc32;

      // Local file header
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0); // signature
      localHeader.writeUInt16LE(20, 4); // version needed
      localHeader.writeUInt16LE(0, 6); // flags
      localHeader.writeUInt16LE(method, 8);
      localHeader.writeUInt16LE(0, 10); // mod time
      localHeader.writeUInt16LE(0, 12); // mod date
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(compressedData.length, 18);
      localHeader.writeUInt32LE(entry.data.length, 22);
      localHeader.writeUInt16LE(nameBuffer.length, 26);
      localHeader.writeUInt16LE(0, 28); // extra field length

      const localOffset = offset;
      parts.push(localHeader, nameBuffer, compressedData);
      offset += localHeader.length + nameBuffer.length + compressedData.length;

      // Central directory entry
      const cdEntry = Buffer.alloc(46);
      cdEntry.writeUInt32LE(0x02014b50, 0); // signature
      cdEntry.writeUInt16LE(20, 4); // version made by
      cdEntry.writeUInt16LE(20, 6); // version needed
      cdEntry.writeUInt16LE(0, 8); // flags
      cdEntry.writeUInt16LE(method, 10);
      cdEntry.writeUInt16LE(0, 12); // mod time
      cdEntry.writeUInt16LE(0, 14); // mod date
      cdEntry.writeUInt32LE(crc, 16);
      cdEntry.writeUInt32LE(compressedData.length, 20);
      cdEntry.writeUInt32LE(entry.data.length, 24);
      cdEntry.writeUInt16LE(nameBuffer.length, 28);
      cdEntry.writeUInt16LE(0, 30); // extra field length
      cdEntry.writeUInt16LE(0, 32); // comment length
      cdEntry.writeUInt16LE(0, 34); // disk number start
      cdEntry.writeUInt16LE(0, 36); // internal file attributes
      cdEntry.writeUInt32LE(0, 38); // external file attributes
      cdEntry.writeUInt32LE(localOffset, 42);

      centralDir.push(cdEntry, nameBuffer);
    }

    const cdOffset = offset;
    let cdSize = 0;
    for (const part of centralDir) {
      parts.push(part);
      cdSize += part.length;
    }

    // End of central directory
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4); // disk number
    eocd.writeUInt16LE(0, 6); // disk with CD
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20); // comment length
    parts.push(eocd);

    return Buffer.concat(parts);
  }
}

/**
 * CRC-32 computation (IEEE / ZIP standard).
 */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Word often splits {{placeholder}} across multiple XML runs.
 * This function merges adjacent <w:r> runs within each <w:p> paragraph
 * so that placeholders become whole, then performs the replacement.
 *
 * Approach: extract all <w:t> text within a paragraph, join them,
 * replace placeholders, then put the result into the first <w:t>
 * and empty the rest.
 */
function replaceDocxPlaceholders(xml, data) {
  // Process each paragraph independently
  return xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (paragraph) => {
    // Extract all <w:t ...>text</w:t> contents in order
    const textParts = [];
    const regex = /(<w:t[^>]*>)([\s\S]*?)(<\/w:t>)/g;
    let m;
    while ((m = regex.exec(paragraph)) !== null) {
      textParts.push({ full: m[0], open: m[1], text: m[2], close: m[3] });
    }

    if (textParts.length === 0) return paragraph;

    // Join all text to find placeholders
    const joined = textParts.map((p) => p.text).join("");
    if (!joined.includes("{{")) return paragraph;

    // Replace placeholders in the joined text
    const replaced = joined.replace(/\{\{(\w[\w.]*)\}\}/g, (_match, key) => {
      const val = key
        .split(".")
        .reduce((obj, k) => (obj && obj[k] !== undefined ? obj[k] : undefined), data);
      if (val === undefined) return `{{${key}}}`;
      // Escape XML special characters
      return String(val)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    });

    // Put all replaced text into the first <w:t> and empty the rest
    let result = paragraph;
    let firstDone = false;
    let partIndex = 0;
    result = result.replace(/(<w:t[^>]*>)([\s\S]*?)(<\/w:t>)/g, (full, open, _text, close) => {
      if (!firstDone) {
        firstDone = true;
        // Ensure xml:space="preserve" so leading/trailing spaces are kept
        const openTag = open.includes("xml:space") ? open : open.replace(">", ' xml:space="preserve">');
        return `${openTag}${replaced}${close}`;
      }
      partIndex++;
      return `${open}${close}`;
    });

    return result;
  });
}

/**
 * Fill a binary .docx template buffer with data.
 * Processes word/document.xml plus all headers and footers.
 */
function fillDocxBinary(templateBuffer, data) {
  const zip = new SimpleZip(templateBuffer);

  // Files that may contain placeholders
  const xmlFiles = zip.entries
    .map((e) => e.name)
    .filter(
      (n) =>
        n === "word/document.xml" ||
        n.startsWith("word/header") ||
        n.startsWith("word/footer")
    );

  for (const xmlFile of xmlFiles) {
    const content = zip.readAsText(xmlFile);
    if (content && content.includes("{{")) {
      const filled = replaceDocxPlaceholders(content, data);
      zip.updateFile(xmlFile, filled);
    }
  }

  return zip.toBuffer();
}

// ── Doc-gen fetch helper (mirrors builtin-handlers.js) ──────────────────────────

async function docGenFetch(path, body) {
  const jsonBody = JSON.stringify(body);
  const opts = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: jsonBody,
    signal: AbortSignal.timeout(60000),
  };

  if (DOC_GEN_MODE === "sandbox") {
    return fetch(`${SANDBOX_URL}${path}`, opts);
  }
  if (DOC_GEN_MODE === "dedicated") {
    return fetch(`${DOC_GEN_URL}${path}`, opts);
  }

  // "auto" mode
  try {
    return await fetch(`${DOC_GEN_URL}${path}`, opts);
  } catch (err) {
    const msg = String(err?.cause?.code || err?.code || err?.message || "").toLowerCase();
    if (
      msg.includes("econnrefused") ||
      msg.includes("enotfound") ||
      msg.includes("fetch failed") ||
      msg.includes("networkerror")
    ) {
      return fetch(`${SANDBOX_URL}${path}`, { ...opts, signal: AbortSignal.timeout(60000) });
    }
    throw err;
  }
}

// ── PocketBase file fetch ───────────────────────────────────────────────────────

async function fetchPBFile(fileId, collection, field) {
  const col = collection || "lc_files";
  const fld = field || "file";

  // First get the record to find the actual filename
  const recordUrl = `${PB_URL}/api/collections/${col}/records/${fileId}`;
  const recordRes = await fetch(recordUrl, { signal: AbortSignal.timeout(10000) });
  if (!recordRes.ok) {
    throw new Error(`Failed to fetch PB record ${fileId}: ${recordRes.status}`);
  }
  const record = await recordRes.json();
  const filename = record[fld];
  if (!filename) {
    throw new Error(`No file in field '${fld}' for record ${fileId}`);
  }

  // Download the actual file
  const fileUrl = `${PB_URL}/api/files/${col}/${fileId}/${filename}`;
  const fileRes = await fetch(fileUrl, { signal: AbortSignal.timeout(30000) });
  if (!fileRes.ok) {
    throw new Error(`Failed to download file: ${fileRes.status}`);
  }
  return {
    buffer: Buffer.from(await fileRes.arrayBuffer()),
    filename,
  };
}

// ── Main handler ────────────────────────────────────────────────────────────────

async function executeFillTemplate(input) {
  const {
    template_text: templateText,
    template_file_id: templateFileId,
    template_collection: templateCollection,
    template_field: templateField,
    data,
    output_format: outputFormat,
    output_filename: outputFilename,
    merge,
    key_field: keyField,
  } = input;

  if (!Array.isArray(data) || data.length === 0) {
    return { data: { error: "data must be a non-empty array of objects" } };
  }

  const format = outputFormat || "docx";
  const prefix = (outputFilename || "filled").replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "_");

  // ── Path A: Binary .docx template from PocketBase ───────────────────────────
  if (templateFileId) {
    const { buffer: templateBuffer, filename: origName } = await fetchPBFile(
      templateFileId,
      templateCollection,
      templateField
    );

    const ext = (origName || "").split(".").pop().toLowerCase();
    if (ext !== "docx") {
      return {
        data: {
          error: `Binary template filling currently supports .docx only. Got: .${ext}`,
          hint: "For other formats, provide template_text instead of template_file_id.",
        },
      };
    }

    if (merge || data.length === 1) {
      // Single output: fill each data row and merge (or just one)
      if (data.length === 1) {
        const filled = fillDocxBinary(templateBuffer, data[0]);
        const label = keyField && data[0][keyField] ? String(data[0][keyField]) : "1";
        const safeName = `${prefix}_${label}`.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "_");
        return {
          file: filled,
          filename: `${safeName}.docx`,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          data: {
            message: `Filled 1 template copy.`,
            placeholders_filled: Object.keys(data[0]),
          },
        };
      }

      // Merge multiple copies: fill each, then use doc-gen to merge (or return first with note)
      // For now, return separate files described in data, with the first as the downloadable file
      const filledBuffers = data.map((row) => fillDocxBinary(templateBuffer, row));
      const labels = data.map((row, i) =>
        keyField && row[keyField] ? String(row[keyField]) : String(i + 1)
      );

      // Return first file + summary (doc-gen merge not available for arbitrary docx)
      return {
        file: filledBuffers[0],
        filename: `${prefix}_merged.docx`,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        data: {
          message: `Generated ${data.length} filled copies. Returning first (${labels[0]}). Merge of arbitrary .docx requires manual assembly.`,
          copies: labels,
          placeholders_filled: Object.keys(data[0]),
        },
      };
    }

    // Separate files: return first file + metadata about the rest
    const filledBuffers = data.map((row) => fillDocxBinary(templateBuffer, row));
    const labels = data.map((row, i) =>
      keyField && row[keyField] ? String(row[keyField]) : String(i + 1)
    );

    // For multiple files, return as a combined result
    // The SSE handler will deliver the first file; data.additional lists the rest
    if (filledBuffers.length === 1) {
      return {
        file: filledBuffers[0],
        filename: `${prefix}_${labels[0]}.docx`.replace(/[^a-zA-Z0-9_.\-\u4e00-\u9fff]/g, "_"),
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        data: {
          message: `Filled template for ${labels[0]}.`,
          placeholders_filled: Object.keys(data[0]),
        },
      };
    }

    // Multiple files — bundle into a single ZIP
    const zipBuffer = createZipBundle(
      filledBuffers.map((buf, i) => ({
        name: `${prefix}_${labels[i]}.docx`.replace(/[^a-zA-Z0-9_.\-\u4e00-\u9fff]/g, "_"),
        data: buf,
      }))
    );

    return {
      file: zipBuffer,
      filename: `${prefix}_${data.length}_files.zip`,
      mimeType: "application/zip",
      data: {
        message: `Generated ${data.length} filled confirmation letters, bundled as ZIP.`,
        files: labels.map((l) => `${prefix}_${l}.docx`),
        placeholders_filled: Object.keys(data[0]),
      },
    };
  }

  // ── Path B: Text-based template → generate .docx via doc-gen ──────────────
  if (templateText) {
    const filledTexts = data.map((row) => fillTemplateText(templateText, row));
    const labels = data.map((row, i) =>
      keyField && row[keyField] ? String(row[keyField]) : String(i + 1)
    );

    if (format === "docx") {
      if (merge || data.length === 1) {
        // Merge all filled texts with page breaks
        const mergedContent = filledTexts.join("\n\n---PAGE BREAK---\n\n");
        const sections = mergedContent.split("\n").map((line) => {
          if (line.trim() === "---PAGE BREAK---") {
            return { type: "page_break" };
          }
          return { type: "paragraph", text: line };
        });

        try {
          const res = await docGenFetch("/generate/docx", {
            title: prefix,
            sections,
          });
          if (!res.ok) throw new Error(`doc-gen returned ${res.status}`);
          const buffer = Buffer.from(await res.arrayBuffer());
          return {
            file: buffer,
            filename: `${prefix}.docx`,
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            data: {
              message: `Generated ${data.length} filled ${merge ? "merged " : ""}document(s).`,
              copies: labels,
              placeholders_filled: Object.keys(data[0]),
            },
          };
        } catch (err) {
          // Fallback: return as plain text
          return {
            data: {
              message: `Doc-gen unavailable (${err.message}). Returning filled text.`,
              filled_texts: filledTexts.map((text, i) => ({
                label: labels[i],
                content: text,
              })),
              placeholders_filled: Object.keys(data[0]),
            },
          };
        }
      }

      // Multiple separate documents — generate each and bundle as ZIP
      const docBuffers = [];
      for (let i = 0; i < filledTexts.length; i++) {
        const sections = filledTexts[i].split("\n").map((line) => ({
          type: "paragraph",
          text: line,
        }));
        try {
          const res = await docGenFetch("/generate/docx", {
            title: `${prefix}_${labels[i]}`,
            sections,
          });
          if (res.ok) {
            docBuffers.push({
              name: `${prefix}_${labels[i]}.docx`.replace(/[^a-zA-Z0-9_.\-\u4e00-\u9fff]/g, "_"),
              data: Buffer.from(await res.arrayBuffer()),
            });
          }
        } catch {
          // Skip failed individual docs
        }
      }

      if (docBuffers.length === 0) {
        // All doc-gen calls failed — return text
        return {
          data: {
            message: "Doc-gen unavailable. Returning filled text.",
            filled_texts: filledTexts.map((text, i) => ({
              label: labels[i],
              content: text,
            })),
          },
        };
      }

      if (docBuffers.length === 1) {
        return {
          file: docBuffers[0].data,
          filename: docBuffers[0].name,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          data: {
            message: `Generated 1 filled document.`,
            placeholders_filled: Object.keys(data[0]),
          },
        };
      }

      const zipBuffer = createZipBundle(docBuffers);
      return {
        file: zipBuffer,
        filename: `${prefix}_${docBuffers.length}_files.zip`,
        mimeType: "application/zip",
        data: {
          message: `Generated ${docBuffers.length} filled documents, bundled as ZIP.`,
          files: docBuffers.map((d) => d.name),
          placeholders_filled: Object.keys(data[0]),
        },
      };
    }

    // Non-docx text output (xlsx via doc-gen)
    if (format === "xlsx") {
      const sheets = [
        {
          name: "Filled Data",
          headers: Object.keys(data[0]),
          rows: data.map((row) => Object.keys(data[0]).map((k) => row[k] ?? "")),
        },
      ];
      try {
        const res = await docGenFetch("/generate/xlsx", { title: prefix, sheets });
        if (!res.ok) throw new Error(`doc-gen returned ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        return {
          file: buffer,
          filename: `${prefix}.xlsx`,
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          data: {
            message: `Generated Excel with ${data.length} rows of filled data.`,
          },
        };
      } catch (err) {
        return { data: { error: `Failed to generate xlsx: ${err.message}` } };
      }
    }

    // Fallback: return filled texts as data
    return {
      data: {
        message: `Filled ${data.length} copies.`,
        filled_texts: filledTexts.map((text, i) => ({
          label: labels[i],
          content: text,
        })),
        placeholders_filled: Object.keys(data[0]),
      },
    };
  }

  // ── Path C: No template provided — data-only mode ─────────────────────────
  // Just return the data as-is with a helpful message
  return {
    data: {
      error: "Either template_text or template_file_id must be provided.",
      hint: "Upload a Word template with {{placeholders}}, or paste the template text with {{placeholder}} markers.",
      example: {
        template_text: "Dear {{director_name}},\n\nThis confirms your position as {{position}} with total compensation of {{total_compensation}}.",
        data: [
          { director_name: "Alice Chen", position: "Executive Director", total_compensation: "HK$1,200,000" },
          { director_name: "Bob Wong", position: "Non-Executive Director", total_compensation: "HK$400,000" },
        ],
      },
    },
  };
}

// ── ZIP bundle helper (for multiple output files) ───────────────────────────────

/**
 * Create a simple ZIP file from an array of { name, data: Buffer } entries.
 * Uses store method (no compression) for simplicity — .docx files are already compressed.
 */
function createZipBundle(files) {
  const parts = [];
  const centralDir = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf-8");
    const fileData = file.data;
    const fileCrc = crc32(fileData);

    // Local file header (store method — docx is already compressed)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8); // method: store
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(fileCrc, 14);
    localHeader.writeUInt32LE(fileData.length, 18);
    localHeader.writeUInt32LE(fileData.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localOffset = offset;
    parts.push(localHeader, nameBuffer, fileData);
    offset += localHeader.length + nameBuffer.length + fileData.length;

    // Central directory entry
    const cdEntry = Buffer.alloc(46);
    cdEntry.writeUInt32LE(0x02014b50, 0);
    cdEntry.writeUInt16LE(20, 4);
    cdEntry.writeUInt16LE(20, 6);
    cdEntry.writeUInt16LE(0, 8);
    cdEntry.writeUInt16LE(0, 10); // method: store
    cdEntry.writeUInt16LE(0, 12);
    cdEntry.writeUInt16LE(0, 14);
    cdEntry.writeUInt32LE(fileCrc, 16);
    cdEntry.writeUInt32LE(fileData.length, 20);
    cdEntry.writeUInt32LE(fileData.length, 24);
    cdEntry.writeUInt16LE(nameBuffer.length, 28);
    cdEntry.writeUInt16LE(0, 30);
    cdEntry.writeUInt16LE(0, 32);
    cdEntry.writeUInt16LE(0, 34);
    cdEntry.writeUInt16LE(0, 36);
    cdEntry.writeUInt32LE(0, 38);
    cdEntry.writeUInt32LE(localOffset, 42);
    centralDir.push(cdEntry, nameBuffer);
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const part of centralDir) {
    parts.push(part);
    cdSize += part.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);

  return Buffer.concat(parts);
}

// ── Registration ────────────────────────────────────────────────────────────────

function registerTemplateFiller() {
  unifiedRegistry.registerTool(FILL_TEMPLATE_SCHEMA, executeFillTemplate);
  console.log("[template-filler] Registered fill_template tool");
}

module.exports = {
  registerTemplateFiller,
  // Direct exports for testing and route handler
  executeFillTemplate,
  fillTemplateText,
  fillDocxBinary,
  FILL_TEMPLATE_SCHEMA,
};
