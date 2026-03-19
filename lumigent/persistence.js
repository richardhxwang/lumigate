"use strict";

const crypto = require("node:crypto");

function createGeneratedFilePersister(options = {}) {
  const getPbAdminToken = options.getPbAdminToken;
  const pbUrl = options.pbUrl;
  const fetchImpl = options.fetchImpl || fetch;

  return async function persistGeneratedToolFile({ userId, filename, mimeType, file }) {
    const pbToken = await getPbAdminToken();
    if (!pbToken || !file) return "";
    const fn = String(filename || "file").replace(/"/g, "_");
    const mtype = mimeType || "application/octet-stream";
    const boundary = "----FB" + crypto.randomBytes(8).toString("hex");
    const headerBuf = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="filename"\r\n\r\n${fn}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="mime_type"\r\n\r\n${mtype}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="user"\r\n\r\n${userId || "api"}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fn}"\r\nContent-Type: ${mtype}\r\n\r\n`
    );
    const footerBuf = Buffer.from(`\r\n--${boundary}--\r\n`);
    const pbRes = await fetchImpl(`${pbUrl}/api/collections/generated_files/records`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, Authorization: pbToken },
      body: Buffer.concat([headerBuf, file, footerBuf]),
    });
    if (!pbRes.ok) return "";
    const rec = await pbRes.json();
    return `${pbUrl}/api/files/generated_files/${rec.id}/${rec.file}`;
  };
}

module.exports = { createGeneratedFilePersister };
