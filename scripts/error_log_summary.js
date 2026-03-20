#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
  const args = {
    sinceMinutes: 120,
    serverLog: path.join("data", "logs", "runtime", "server.log"),
    auditLog: path.join("data", "audit.jsonl"),
    jsonOut: "",
    onlyErrors: false,
    includeShutdown: false,
    securityDb: "",
    lumichatDb: ""
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--since-minutes" && next) {
      args.sinceMinutes = Math.max(1, Number(next) || 120);
      i += 1;
      continue;
    }
    if (a === "--server-log" && next) {
      args.serverLog = next;
      i += 1;
      continue;
    }
    if (a === "--audit-log" && next) {
      args.auditLog = next;
      i += 1;
      continue;
    }
    if (a === "--json-out" && next) {
      args.jsonOut = next;
      i += 1;
      continue;
    }
    if (a === "--only-errors") {
      args.onlyErrors = true;
      continue;
    }
    if (a === "--include-shutdown") {
      args.includeShutdown = true;
      continue;
    }
    if (a === "--security-db" && next) {
      args.securityDb = next;
      i += 1;
      continue;
    }
    if (a === "--lumichat-db" && next) {
      args.lumichatDb = next;
      i += 1;
      continue;
    }
    if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log([
    "Usage: node scripts/error_log_summary.js [options]",
    "",
    "Options:",
    "  --since-minutes <n>   Only include events newer than now-n minutes (default: 120)",
    "  --server-log <path>   Server runtime log path (default: data/logs/runtime/server.log)",
    "  --audit-log <path>    Audit JSONL path (default: data/audit.jsonl)",
    "  --json-out <path>     Write full summary JSON to file",
    "  --only-errors         Exclude info-level events from output",
    "  --include-shutdown    Include shutdown events from audit logs",
    "  --security-db <path>  SQLite DB path that has security_events",
    "  --lumichat-db <path>  SQLite DB path that has lc_messages",
    "  -h, --help            Show this help"
  ].join("\n"));
}

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (_err) {
    return "";
  }
}

function fileMtimeIso(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch (_err) {
    return new Date().toISOString();
  }
}

function toMs(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : NaN;
}

function withinWindow(tsMs, minMs) {
  if (!Number.isFinite(tsMs)) {
    return false;
  }
  return tsMs >= minMs;
}

function classify(reason) {
  const text = String(reason || "").toLowerCase();
  if (text.includes("未能从当前链接提取可读内容") || text.includes("could not extract readable content")) return "url-extract-fallback";
  if (text.includes("no usable search results")) return "search-no-result";
  if (text.includes("tool fallback emitted")) return "tool-fallback";
  if (text.includes("encrypted key unwrap failed") || text.includes("decrypt")) return "encrypt/decrypt";
  if (text.includes("bad request to ai provider") || text.includes("provider") || text.includes("model")) return "provider";
  if (text.includes("no image") || text.includes("image")) return "image-input";
  if (text.includes("parse failed") || text.includes("file-parser") || text.includes("xref")) return "file-parse";
  if (text.includes("schema") || text.includes("collection")) return "schema/db";
  if (text.includes("readablestream") || text.includes("unhandledrejection") || text.includes("crash")) return "runtime-crash";
  if (text.includes("sandbox_exec") || text.includes("docker enoent") || text.includes("exitcode")) return "sandbox/exec";
  return "other";
}

function pushEvent(target, evt) {
  if (!evt || !evt.reason || !evt.ts) {
    return;
  }
  evt.context = evt.context && typeof evt.context === "object" ? evt.context : {};
  evt.key = `${evt.category}|${evt.context.sessionId || "-"}|${evt.context.provider || "-"}|${evt.context.model || "-"}|${evt.reason}`;
  target.push(evt);
}

function parseServerLog(content, minMs) {
  const events = [];
  const lines = content.split(/\r?\n/);
  let lastKnownTs = "";
  const fallbackTs = fileMtimeIso(path.join("data", "logs", "runtime", "server.log"));
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const obj = JSON.parse(line);
        const ts = obj.ts || obj.time || "";
        if (ts) {
          lastKnownTs = ts;
        }
        const tsMs = toMs(ts);
        if (!withinWindow(tsMs, minMs)) continue;

        const lvl = String(obj.level || "").toLowerCase();
        const msg = String(obj.msg || "");
        const err = obj.error ? String(obj.error) : "";
        const nested = (obj.data && typeof obj.data === "object") ? obj.data : {};
        const provider = obj.provider || nested.provider || "";
        const model = obj.model || nested.model || "";
        const sessionId = obj.sessionId || obj._lcSessionId || nested.sessionId || nested._lcSessionId || "";
        const traceId = obj.traceId || nested.traceId || "";
        const userId = obj.userId || obj._lcUserId || nested.userId || "";

        if (lvl === "error" || lvl === "warn" || err || /error|failed|exception|unavailable/i.test(msg)) {
          const reason = [msg, err].filter(Boolean).join(" | ");
          pushEvent(events, {
            ts,
            source: "server.log",
            level: lvl || "info",
            reason,
            category: classify(reason),
            context: {
              traceId,
              provider: String(provider || ""),
              model: String(model || ""),
              sessionId: String(sessionId || ""),
              userId: String(userId || "")
            }
          });
        }
      } catch (_e) {
        // fallthrough to plain-line parsing
      }
      continue;
    }

    const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?\s*(.*)$/);
    const ts = m && m[1] ? m[1] : "";
    const msg = m && m[2] ? m[2] : line;
    if (ts) {
      lastKnownTs = ts;
    }
    const effectiveTs = ts || lastKnownTs || fallbackTs;
    const tsMs = effectiveTs ? toMs(effectiveTs) : NaN;
    if (!withinWindow(tsMs, minMs)) continue;

    if (/error|failed|exception|unhandled|crash|\[vision\]/i.test(msg)) {
      pushEvent(events, {
        ts: effectiveTs,
        source: "server.log",
        level: /error|exception|crash|unhandled/i.test(msg) ? "error" : "warn",
        reason: msg,
        category: classify(msg),
        context: {}
      });
    }
  }
  return events;
}

function parseAuditLog(content, minMs) {
  const events = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      const ts = obj.ts || "";
      const tsMs = toMs(ts);
      if (!withinWindow(tsMs, minMs)) continue;

      const action = String(obj.action || "");
      const d = obj.details || {};
      const reason = [action, d.reason, d.error, d.message, Number.isFinite(d.exitCode) ? `exitCode=${d.exitCode}` : ""].filter(Boolean).join(" | ");

      if (
        /crash|error|shutdown|exit/i.test(action) ||
        d.error ||
        d.message ||
        (Number.isFinite(d.exitCode) && d.exitCode !== 0)
      ) {
        pushEvent(events, {
          ts,
          source: "audit.jsonl",
          level: /crash|error/i.test(action) ? "error" : "warn",
          reason,
          category: classify(reason),
          context: {
            actor: obj.actor || "",
            target: obj.target || "",
            action
          }
        });
      }
    } catch (_e) {
      // ignore broken lines
    }
  }
  return events;
}

function findExisting(candidates) {
  for (const p of candidates) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return "";
}

function runSqlite(dbPath, sql) {
  if (!dbPath) return "";
  const out = spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
  if (out.status !== 0) return "";
  return String(out.stdout || "");
}

function parseSecurityEventsFromDb(dbPath, minMs) {
  if (!dbPath) return [];
  const minIso = new Date(minMs).toISOString().replace("T", " ").replace("Z", "Z");
  const sql = [
    "SELECT created, source, severity, detail_json",
    "FROM security_events",
    `WHERE created >= '${minIso}'`,
    "ORDER BY created DESC LIMIT 1200;"
  ].join(" ");
  const raw = runSqlite(dbPath, sql);
  if (!raw) return [];
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("|");
    if (parts.length < 4) continue;
    const [created, source, severity, ...rest] = parts;
    const detailJson = rest.join("|");
    const ts = String(created || "").replace(" ", "T");
    const tsMs = toMs(ts);
    if (!withinWindow(tsMs, minMs)) continue;
    let detail = {};
    try { detail = JSON.parse(detailJson); } catch {}
    const msg = String(detail.msg || detail.message || "");
    const data = (detail.data && typeof detail.data === "object") ? detail.data : {};
    const reason = msg || String(detailJson || "").slice(0, 400);
    if (!/error|failed|fallback|unavailable|no usable|未能从当前链接提取可读内容|bad request/i.test(reason)) continue;
    pushEvent(events, {
      ts,
      source: source || "security_events",
      level: String(severity || "warn").toLowerCase() === "critical" ? "error" : "warn",
      reason,
      category: classify(reason),
      context: {
        traceId: data.traceId || "",
        provider: data.provider || "",
        model: data.model || "",
        sessionId: data.sessionId || data._lcSessionId || "",
        userId: data.userId || ""
      }
    });
  }
  return events;
}

function parseLcMessagesFromDb(dbPath, minMs) {
  if (!dbPath) return [];
  const minIso = new Date(minMs).toISOString();
  const sql = [
    "SELECT created_at, session, role, replace(replace(content, char(10), ' '), char(13), ' ')",
    "FROM lc_messages",
    `WHERE created_at >= '${minIso}'`,
    "ORDER BY created_at DESC LIMIT 1200;"
  ].join(" ");
  const raw = runSqlite(dbPath, sql);
  if (!raw) return [];
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("|");
    if (parts.length < 4) continue;
    const [createdAt, session, role, ...rest] = parts;
    if (String(role) !== "assistant") continue;
    const content = rest.join("|");
    const ts = String(createdAt || "");
    const tsMs = toMs(ts);
    if (!withinWindow(tsMs, minMs)) continue;
    if (!/未能从当前链接提取可读内容|No usable search results|Could not extract readable content/i.test(content)) continue;
    const reason = String(content || "").trim().slice(0, 420);
    pushEvent(events, {
      ts,
      source: "lc_messages",
      level: "warn",
      reason,
      category: classify(reason),
      context: {
        sessionId: String(session || ""),
        provider: "",
        model: "",
        traceId: "",
        userId: ""
      }
    });
  }
  return events;
}

function summarize(events, sinceMinutes) {
  const byCategory = {};
  const byReason = {};
  const byLevel = { error: 0, warn: 0, info: 0 };
  const bySession = {};
  const byProviderModel = {};
  const bySignature = {};

  for (const e of events) {
    byCategory[e.category] = (byCategory[e.category] || 0) + 1;
    byReason[e.reason] = (byReason[e.reason] || 0) + 1;
    byLevel[e.level] = (byLevel[e.level] || 0) + 1;
    const sid = e.context?.sessionId || "(none)";
    bySession[sid] = (bySession[sid] || 0) + 1;
    const pm = `${e.context?.provider || "(n/a)"} / ${e.context?.model || "(n/a)"}`;
    byProviderModel[pm] = (byProviderModel[pm] || 0) + 1;
    const sig = `${e.category} | ${sid} | ${pm}`;
    bySignature[sig] = (bySignature[sig] || 0) + 1;
  }

  const topReasons = Object.entries(byReason)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([reason, count]) => ({ reason, count }));

  const sorted = events.slice().sort((a, b) => toMs(b.ts) - toMs(a.ts));
  const topSessions = Object.entries(bySession).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([sessionId, count]) => ({ sessionId, count }));
  const topProviderModels = Object.entries(byProviderModel).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([providerModel, count]) => ({ providerModel, count }));
  const topSignatures = Object.entries(bySignature).sort((a, b) => b[1] - a[1]).slice(0, 16).map(([signature, count]) => ({ signature, count }));
  const searchFailureEvents = sorted.filter((e) => e.category === "url-extract-fallback" || e.category === "search-no-result" || e.category === "tool-fallback");

  return {
    generatedAt: new Date().toISOString(),
    sinceMinutes,
    total: events.length,
    levels: byLevel,
    categories: byCategory,
    topReasons,
    topSessions,
    topProviderModels,
    topSignatures,
    searchFailureCount: searchFailureEvents.length,
    latestSearchFailures: searchFailureEvents.slice(0, 20),
    latestEvents: sorted.slice(0, 20),
    allEvents: sorted
  };
}

function printText(summary) {
  console.log("=== Error Log Summary ===");
  console.log(`Generated At : ${summary.generatedAt}`);
  console.log(`Window       : last ${summary.sinceMinutes} minutes`);
  console.log(`Total Events : ${summary.total}`);
  console.log(`Levels       : error=${summary.levels.error || 0}, warn=${summary.levels.warn || 0}, info=${summary.levels.info || 0}`);
  console.log(`Search Fail  : ${summary.searchFailureCount || 0}`);

  console.log("\nCategories:");
  const catList = Object.entries(summary.categories).sort((a, b) => b[1] - a[1]);
  if (!catList.length) {
    console.log("  (none)");
  } else {
    for (const [k, v] of catList) {
      console.log(`  - ${k}: ${v}`);
    }
  }

  console.log("\nTop Reasons:");
  if (!summary.topReasons.length) {
    console.log("  (none)");
  } else {
    for (const item of summary.topReasons) {
      console.log(`  - [${item.count}] ${item.reason}`);
    }
  }

  console.log("\nTop Sessions:");
  if (!summary.topSessions.length) {
    console.log("  (none)");
  } else {
    for (const item of summary.topSessions) {
      console.log(`  - [${item.count}] ${item.sessionId}`);
    }
  }

  console.log("\nTop Provider/Model:");
  if (!summary.topProviderModels.length) {
    console.log("  (none)");
  } else {
    for (const item of summary.topProviderModels) {
      console.log(`  - [${item.count}] ${item.providerModel}`);
    }
  }

  console.log("\nTop Error Signatures:");
  if (!summary.topSignatures.length) {
    console.log("  (none)");
  } else {
    for (const item of summary.topSignatures) {
      console.log(`  - [${item.count}] ${item.signature}`);
    }
  }

  console.log("\nLatest Search Failures:");
  if (!summary.latestSearchFailures.length) {
    console.log("  (none)");
  } else {
    for (const e of summary.latestSearchFailures) {
      const sid = e.context?.sessionId || "(none)";
      const pm = `${e.context?.provider || "(n/a)"} / ${e.context?.model || "(n/a)"}`;
      console.log(`  - ${e.ts} | ${sid} | ${pm} | ${e.reason}`);
    }
  }

  console.log("\nLatest Events:");
  if (!summary.latestEvents.length) {
    console.log("  (none)");
  } else {
    for (const e of summary.latestEvents) {
      console.log(`  - ${e.ts} | ${e.level.toUpperCase()} | ${e.source} | ${e.category} | ${e.reason}`);
    }
  }
}

(function main() {
  const args = parseArgs(process.argv);
  const minMs = Date.now() - (args.sinceMinutes * 60 * 1000);

  const serverContent = safeRead(args.serverLog);
  const auditContent = safeRead(args.auditLog);

  const events = [];
  events.push(...parseServerLog(serverContent, minMs));
  const auditEvents = parseAuditLog(auditContent, minMs);
  events.push(...(args.includeShutdown ? auditEvents : auditEvents.filter((e) => !/shutdown/i.test(e.reason))));

  const securityDbPath = findExisting([
    args.securityDb,
    process.env.SECURITY_DB_PATH,
    path.join("data", "pocketbase", "data.db"),
    "/Volumes/SSD Acer M7000/MacMini-Data/Projects/Project/General/pocketbase/pb_data/data.db"
  ]);
  const lumichatDbPath = findExisting([
    args.lumichatDb,
    process.env.LUMICHAT_DB_PATH,
    path.join("data", "pocketbase", "projects", "lumichat", "data.db"),
    "/Volumes/SSD Acer M7000/MacMini-Data/Projects/Project/General/pocketbase/pb_data/projects/lumichat/data.db"
  ]);
  events.push(...parseSecurityEventsFromDb(securityDbPath, minMs));
  events.push(...parseLcMessagesFromDb(lumichatDbPath, minMs));
  const filtered = args.onlyErrors ? events.filter((e) => e.level !== "info") : events;

  const summary = summarize(filtered, args.sinceMinutes);
  printText(summary);

  if (args.jsonOut) {
    fs.mkdirSync(path.dirname(args.jsonOut), { recursive: true });
    fs.writeFileSync(args.jsonOut, JSON.stringify(summary, null, 2));
    console.log(`\nJSON written: ${args.jsonOut}`);
  }
})();
