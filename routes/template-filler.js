"use strict";

/**
 * Template Filler REST endpoint.
 *
 * POST /v1/tools/fill-template
 * POST /platform/tools/fill-template
 *
 * Body: { template_file_id?, template_text?, data: [...], output_format?, output_filename?, merge?, key_field? }
 * Response: file download (single docx or zip) with JSON metadata in X-Result-Meta header,
 *           or JSON response if no file is generated.
 */

const express = require("express");
const multer = require("multer");
const { executeFillTemplate } = require("../tools/template-filler");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

/**
 * POST /fill-template
 *
 * Accepts JSON body or multipart form with an attached template file.
 * When using multipart, the template .docx is uploaded as "template" field,
 * and "data" is a JSON string in the "data" field.
 */
router.post("/fill-template", upload.single("template"), async (req, res) => {
  try {
    let input;

    if (req.file) {
      // Multipart upload: template file + JSON data field
      let data;
      try {
        data = JSON.parse(req.body.data || "[]");
      } catch {
        return res.status(400).json({ ok: false, error: "Invalid JSON in 'data' field" });
      }

      if (!Array.isArray(data) || data.length === 0) {
        return res.status(400).json({ ok: false, error: "'data' must be a non-empty JSON array" });
      }

      // Store the uploaded template buffer temporarily and pass as binary
      // We process it directly without going through PocketBase
      const ext = (req.file.originalname || "").split(".").pop().toLowerCase();
      if (ext !== "docx") {
        return res.status(400).json({
          ok: false,
          error: `Binary template upload supports .docx only. Got: .${ext}`,
        });
      }

      const { fillDocxBinary } = require("../tools/template-filler");
      const results = data.map((row) => fillDocxBinary(req.file.buffer, row));
      const keyField = req.body.key_field;
      const prefix = (req.body.output_filename || "filled").replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "_");
      const labels = data.map((row, i) =>
        keyField && row[keyField] ? String(row[keyField]) : String(i + 1)
      );

      if (results.length === 1) {
        const safeName = `${prefix}_${labels[0]}.docx`.replace(/[^a-zA-Z0-9_.\-\u4e00-\u9fff]/g, "_");
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
        res.setHeader("X-Result-Meta", JSON.stringify({
          ok: true,
          message: `Filled template for ${labels[0]}.`,
          placeholders_filled: Object.keys(data[0]),
        }));
        return res.send(results[0]);
      }

      // Multiple files — create ZIP bundle
      const { default: _noop, ...mod } = require("../tools/template-filler");
      // Use the ZIP bundling by calling executeFillTemplate with text approach
      // Or directly build ZIP here using the SimpleZip approach
      const zlib = require("node:zlib");

      // Inline minimal ZIP bundle (store method)
      const zipParts = [];
      const centralDir = [];
      let offset = 0;

      function crc32Buf(buf) {
        let crc = 0xffffffff;
        for (let i = 0; i < buf.length; i++) {
          crc ^= buf[i];
          for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
          }
        }
        return (crc ^ 0xffffffff) >>> 0;
      }

      for (let i = 0; i < results.length; i++) {
        const fileName = `${prefix}_${labels[i]}.docx`.replace(/[^a-zA-Z0-9_.\-\u4e00-\u9fff]/g, "_");
        const nameBuffer = Buffer.from(fileName, "utf-8");
        const fileData = results[i];
        const fileCrc = crc32Buf(fileData);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0, 8);
        localHeader.writeUInt32LE(fileCrc, 14);
        localHeader.writeUInt32LE(fileData.length, 18);
        localHeader.writeUInt32LE(fileData.length, 22);
        localHeader.writeUInt16LE(nameBuffer.length, 26);

        const localOffset = offset;
        zipParts.push(localHeader, nameBuffer, fileData);
        offset += 30 + nameBuffer.length + fileData.length;

        const cdEntry = Buffer.alloc(46);
        cdEntry.writeUInt32LE(0x02014b50, 0);
        cdEntry.writeUInt16LE(20, 4);
        cdEntry.writeUInt16LE(20, 6);
        cdEntry.writeUInt32LE(fileCrc, 16);
        cdEntry.writeUInt32LE(fileData.length, 20);
        cdEntry.writeUInt32LE(fileData.length, 24);
        cdEntry.writeUInt16LE(nameBuffer.length, 28);
        cdEntry.writeUInt32LE(localOffset, 42);
        centralDir.push(cdEntry, nameBuffer);
      }

      const cdOffset = offset;
      let cdSize = 0;
      for (const part of centralDir) { zipParts.push(part); cdSize += part.length; }
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(results.length, 8);
      eocd.writeUInt16LE(results.length, 10);
      eocd.writeUInt32LE(cdSize, 12);
      eocd.writeUInt32LE(cdOffset, 16);
      zipParts.push(eocd);

      const zipBuffer = Buffer.concat(zipParts);
      const zipName = `${prefix}_${results.length}_files.zip`;
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
      res.setHeader("X-Result-Meta", JSON.stringify({
        ok: true,
        message: `Generated ${results.length} filled documents.`,
        files: labels.map((l) => `${prefix}_${l}.docx`),
      }));
      return res.send(zipBuffer);
    }

    // JSON body mode
    input = req.body;
    if (!input || (!input.template_text && !input.template_file_id)) {
      return res.status(400).json({
        ok: false,
        error: "Provide template_text or template_file_id (or upload a template file via multipart).",
      });
    }
    if (!Array.isArray(input.data) || input.data.length === 0) {
      return res.status(400).json({ ok: false, error: "'data' must be a non-empty array" });
    }

    const result = await executeFillTemplate(input);

    if (result.file) {
      res.setHeader("Content-Type", result.mimeType || "application/octet-stream");
      const disposition = `attachment; filename="${result.filename || "filled.docx"}"`;
      res.setHeader("Content-Disposition", disposition);
      if (result.data) {
        res.setHeader("X-Result-Meta", JSON.stringify({ ok: true, ...result.data }));
      }
      return res.send(result.file);
    }

    // No file generated — return JSON
    return res.json({ ok: true, ...result.data });
  } catch (err) {
    console.error("[template-filler route] Error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
