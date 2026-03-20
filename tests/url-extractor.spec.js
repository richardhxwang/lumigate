"use strict";

/**
 * Regression tests for direct URL extraction.
 * Guards against:
 * - local file names being mis-detected as URLs (e.g. report.xlsx)
 * - Chinese instructions appended to URL without a space
 */

const fs = require("fs");
const vm = require("vm");

function loadExtractor() {
  const src = fs.readFileSync("server.js", "utf8");
  const stripStart = src.indexOf("function stripAttachmentContextBlocks(text) {");
  const stripEnd = src.indexOf("\nfunction contentHasAttachmentContext", stripStart);
  const start = src.indexOf("function extractDirectUrls(text) {");
  const end = src.indexOf("\nfunction inferFilenameFromUrl", start);
  if (stripStart < 0 || stripEnd < 0 || start < 0 || end < 0) throw new Error("required functions not found");
  const fnCode = `${src.slice(stripStart, stripEnd)}\n${src.slice(start, end)}`;
  const ctx = { URL, Set, String, Array, RegExp };
  vm.createContext(ctx);
  vm.runInContext(`${fnCode}\nthis.extractDirectUrls = extractDirectUrls;\nthis.stripAttachmentContextBlocks = stripAttachmentContextBlocks;`, ctx);
  return {
    extractDirectUrls: ctx.extractDirectUrls,
    stripAttachmentContextBlocks: ctx.stripAttachmentContextBlocks,
  };
}

function assertEqual(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${name} failed\nexpected: ${e}\nactual:   ${a}`);
  }
}

function run() {
  const { extractDirectUrls, stripAttachmentContextBlocks } = loadExtractor();

  assertEqual(
    extractDirectUrls("帮我分析 report.xlsx"),
    [],
    "bare excel filename should not trigger fetch"
  );

  assertEqual(
    extractDirectUrls("notes.md 里面是什么"),
    [],
    "bare markdown filename should not trigger fetch"
  );

  assertEqual(
    extractDirectUrls("https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0319/2026031901655_c.pdf分析"),
    ["https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0319/2026031901655_c.pdf"],
    "url with chinese suffix should be normalized"
  );

  assertEqual(
    extractDirectUrls("autorums.com 总结"),
    ["https://autorums.com/"],
    "domain-only input should still be detected"
  );

  const withAttachmentContext = [
    "请帮我总结这个文件",
    "",
    "[Attachment Context]",
    "name: report.xlsx",
    "kind: document",
    "mime: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "content:",
    "参考链接 https://example.com/internal",
  ].join("\n");
  assertEqual(
    extractDirectUrls(stripAttachmentContextBlocks(withAttachmentContext)),
    [],
    "attachment context urls should not trigger direct url fetch"
  );

  console.log("[pass] url-extractor regression");
}

run();
