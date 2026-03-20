"use strict";

const path = require("node:path");
const { execFile } = require("node:child_process");

const PYTHON_BIN = process.env.FS_ANALYSIS_PYTHON || "python3";
const SCRIPT_PATH = path.join(__dirname, "..", "services", "financial-analysis", "analyze.py");

function runPythonAnalysis(payload, timeoutMs = 45000) {
  const input = JSON.stringify(payload || {});
  return new Promise((resolve, reject) => {
    const child = execFile(
      PYTHON_BIN,
      [SCRIPT_PATH],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || "financial analysis worker failed").trim();
          reject(new Error(msg));
          return;
        }
        try {
          resolve(JSON.parse(String(stdout || "{}")));
        } catch (parseErr) {
          reject(new Error(`financial analysis worker returned invalid JSON: ${parseErr.message}`));
        }
      }
    );
    if (child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function analyzeFinancialStatements({ query = "", documents = [], lang = "en", strict = true } = {}) {
  const payload = {
    query: String(query || ""),
    lang: String(lang || "en"),
    strict: !!strict,
    documents: Array.isArray(documents) ? documents.map((d) => ({
      name: String(d?.name || ""),
      source: String(d?.source || ""),
      text: String(d?.text || ""),
    })) : [],
  };
  const out = await runPythonAnalysis(payload);
  return {
    ok: !!out?.ok,
    summary: out?.summary || "",
    checks: Array.isArray(out?.checks) ? out.checks : [],
    missing_fields: Array.isArray(out?.missing_fields) ? out.missing_fields : [],
    evidence: Array.isArray(out?.evidence) ? out.evidence : [],
    meta: out?.meta && typeof out.meta === "object" ? out.meta : {},
  };
}

module.exports = {
  analyzeFinancialStatements,
};

