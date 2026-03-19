"use strict";

function repairJSON(str) {
  let s = String(str || "").trim();
  s = s.replace(/,\s*([}\]])/g, "$1");
  try { JSON.parse(s); return s; } catch {}
  let opens = 0;
  let openb = 0;
  for (const c of s) {
    if (c === "{") opens++;
    if (c === "}") opens--;
    if (c === "[") openb++;
    if (c === "]") openb--;
  }
  while (opens > 0) { s += "}"; opens--; }
  while (openb > 0) { s += "]"; openb--; }
  try { JSON.parse(s); return s; } catch {}
  s = s.replace(/'/g, "\"");
  try { JSON.parse(s); return s; } catch {}
  return str;
}

function defaultFormatToolResult(toolName, data) {
  if (toolName === "web_search" && data?.results) {
    const items = (data.results || []).slice(0, 6);
    if (items.length === 0) return { html: "<div style=\"padding:12px;color:#888\">No results found</div>" };
    const esc = (s) => String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    let html = "<div style=\"border:1px solid var(--border,#333);border-radius:12px;overflow:hidden\">";
    html += "<div style=\"padding:10px 14px;background:var(--inp,#2f2f2f);font-size:12px;font-weight:600;color:var(--t3,#888);display:flex;align-items:center;gap:6px\"><svg viewBox=\"0 0 24 24\" width=\"14\" height=\"14\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"M21 21l-4.35-4.35\"/></svg>Search Results</div>";
    for (const r of items) {
      html += `<div style="padding:10px 14px;border-top:1px solid var(--border,#333)"><a href="${esc(r.url)}" target="_blank" style="color:var(--accent,#10a37f);font-size:14px;font-weight:500;text-decoration:none">${esc(r.title)}</a><div style="font-size:12px;color:var(--t3,#888);margin-top:4px;line-height:1.5">${esc((r.content || "").slice(0, 150))}</div></div>`;
    }
    html += "</div>";
    return { html, query: data.query };
  }

  if (data?.based_on_template) {
    return {
      html: `<div style="padding:8px 12px;background:var(--inp,#2f2f2f);border-radius:8px;font-size:13px;color:var(--t2,#ccc)">Based on template: <b>${String(data.based_on_template)}</b></div>`,
      data,
    };
  }

  return { data };
}

class LumigentRuntime {
  constructor(options = {}) {
    this.registry = options.registry;
    this.logger = typeof options.logger === "function" ? options.logger : (() => {});
    this.persistFile = typeof options.persistFile === "function" ? options.persistFile : (async () => "");
    this.formatToolResult = typeof options.formatToolResult === "function" ? options.formatToolResult : defaultFormatToolResult;
    this.traceStore = options.traceStore || null;
  }

  getSystemPrompt() {
    return this.registry?.getSystemPrompt ? this.registry.getSystemPrompt() : "No tools are currently available.";
  }

  async executeToolCall(toolName, toolInput) {
    const startedAt = Date.now();
    try {
      const result = await this.registry.executeToolCall(toolName, toolInput);
      this._trace({
        kind: "tool_call",
        toolName,
        toolInput,
        ok: !!result?.ok,
        duration: result?.duration ?? (Date.now() - startedAt),
        error: result?.error || null,
      });
      return result;
    } catch (err) {
      this._trace({
        kind: "tool_call",
        toolName,
        toolInput,
        ok: false,
        duration: Date.now() - startedAt,
        error: err.message,
      });
      throw err;
    }
  }

  async executeTextToolCalls(contentText, userId) {
    const results = [];
    await this._parseBracketToolCalls(contentText, userId, results);
    await this._parseDsmlToolCalls(contentText, userId, results);
    await this._parseXmlToolCalls(contentText, userId, results);
    return results;
  }

  async _handleToolInvocation(toolName, toolInput, userId, results, parseLabel) {
    try {
      const result = await this.executeToolCall(toolName, toolInput);
      if (!result?.ok) return;
      if (result.file) {
        let downloadUrl = "";
        try {
          downloadUrl = await this.persistFile({
            userId,
            toolName,
            filename: result.filename,
            mimeType: result.mimeType,
            file: result.file,
          });
        } catch {}
        results.push({
          tool: toolName,
          filename: result.filename,
          mimeType: result.mimeType,
          size: result.file.length,
          downloadUrl,
          base64: !downloadUrl ? result.file.toString("base64") : undefined,
          duration: result.duration,
        });
        return;
      }
      if (result.data) {
        const formatted = this.formatToolResult(toolName, result.data);
        results.push({ tool: toolName, ...formatted, duration: result.duration });
      }
    } catch (e) {
      this.logger("warn", `${parseLabel} tool exec failed`, { tool: toolName, error: e.message });
    }
  }

  async _parseBracketToolCalls(contentText, userId, results) {
    const toolTagRe = /\[TOOL:(\w+)\]([\s\S]*?)\[\/TOOL\]/g;
    let toolMatch;
    while ((toolMatch = toolTagRe.exec(contentText)) !== null) {
      const toolName = toolMatch[1];
      let toolInput = {};
      try {
        toolInput = JSON.parse(repairJSON(toolMatch[2].trim()));
      } catch (e) {
        this.logger("warn", "Tool JSON parse failed", { tool: toolName, error: e.message, raw: toolMatch[2].slice(0, 200) });
        continue;
      }
      await this._handleToolInvocation(toolName, toolInput, userId, results, "Tool tag");
    }
  }

  async _parseDsmlToolCalls(contentText, userId, results) {
    const dsmlRe = /<(?:｜DSML｜|︱DSML︱|\|DSML\|)function_calls>([\s\S]*?)<\/(?:｜DSML｜|︱DSML︱|\|DSML\|)function_calls>/g;
    let dsmlMatch;
    while ((dsmlMatch = dsmlRe.exec(contentText)) !== null) {
      const invokeRe = /<(?:｜DSML｜|︱DSML︱|\|DSML\|)invoke\s+name="(\w+)"[^>]*>([\s\S]*?)<\/(?:｜DSML｜|︱DSML︱|\|DSML\|)invoke>/g;
      let dInvoke;
      while ((dInvoke = invokeRe.exec(dsmlMatch[1])) !== null) {
        const toolName = dInvoke[1];
        const toolInput = {};
        const paramRe = /<(?:｜DSML｜|︱DSML︱|\|DSML\|)parameter\s+name="(\w+)"[^>]*>([\s\S]*?)<(?:｜DSML｜|︱DSML︱|\|DSML\|)parameter>/g;
        let dParam;
        while ((dParam = paramRe.exec(dInvoke[2])) !== null) {
          let val = dParam[2].trim();
          try { val = JSON.parse(val); } catch {}
          toolInput[dParam[1]] = val;
        }
        if (Object.keys(toolInput).length > 0) {
          await this._handleToolInvocation(toolName, toolInput, userId, results, "DSML");
        }
      }
    }
  }

  async _parseXmlToolCalls(contentText, userId, results) {
    const xmlToolRe = /<(?:minimax:)?tool_call>([\s\S]*?)<\/(?:minimax:)?tool_call>/g;
    let xmlMatch;
    while ((xmlMatch = xmlToolRe.exec(contentText)) !== null) {
      const invokeRe = /<invoke\s+name="(\w+)">([\s\S]*?)<\/invoke>/g;
      let invokeMatch;
      while ((invokeMatch = invokeRe.exec(xmlMatch[1])) !== null) {
        const toolName = invokeMatch[1];
        const toolInput = {};
        const paramRe = /<parameter\s+name="(\w+)">([\s\S]*?)<\/parameter>/g;
        let paramMatch;
        while ((paramMatch = paramRe.exec(invokeMatch[2])) !== null) {
          let val = paramMatch[2].trim();
          try { val = JSON.parse(val); } catch {}
          toolInput[paramMatch[1]] = val;
        }
        await this._handleToolInvocation(toolName, toolInput, userId, results, "XML");
      }
    }
  }

  _trace(entry) {
    if (this.traceStore?.add) this.traceStore.add(entry);
  }
}

module.exports = {
  LumigentRuntime,
  repairJSON,
  defaultFormatToolResult,
};
