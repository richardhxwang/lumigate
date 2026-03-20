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

function normalizeToolName(name) {
  const raw = String(name || "").trim();
  const n = raw.toLowerCase();
  const aliasMap = {
    search: "web_search",
    websearch: "web_search",
    internet_search: "web_search",
    search_tool: "web_search",
    browse: "web_search",
    generate_excel: "generate_spreadsheet",
    make_excel: "generate_spreadsheet",
    generate_word: "generate_document",
    make_doc: "generate_document",
    generate_ppt: "generate_presentation",
  };
  const mapped = aliasMap[n] || raw;
  return /^[a-zA-Z_][\w]*$/.test(mapped) ? mapped : "";
}

function tryParseJsonLoose(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try { return JSON.parse(repairJSON(text)); } catch {}
  return null;
}

function normalizeToolInvocation(tagToolName, rawBodyText) {
  const fallbackName = normalizeToolName(tagToolName);
  const raw = String(rawBodyText || "").trim();
  if (!raw) return { toolName: fallbackName, toolInput: {} };

  // Pattern A: some models output [TOOL:name]web_search[/TOOL]
  if (fallbackName === "name") {
    const directName = normalizeToolName(raw);
    if (directName) return { toolName: directName, toolInput: {} };
  }

  // Pattern B: raw JSON object / array.
  const parsed = tryParseJsonLoose(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const byName = normalizeToolName(parsed.name || parsed.tool || parsed.tool_name || parsed.function);
    const effectiveName = byName || (fallbackName === "name" ? "" : fallbackName);
    let toolInput = {};

    // OpenAI-style: {name:"web_search", arguments:{...}} or arguments:"{...}"
    if (parsed.arguments !== undefined) {
      if (typeof parsed.arguments === "string") {
        const argsObj = tryParseJsonLoose(parsed.arguments);
        toolInput = (argsObj && typeof argsObj === "object" && !Array.isArray(argsObj)) ? argsObj : { value: parsed.arguments };
      } else if (parsed.arguments && typeof parsed.arguments === "object" && !Array.isArray(parsed.arguments)) {
        toolInput = parsed.arguments;
      }
    } else if (parsed.input && typeof parsed.input === "object" && !Array.isArray(parsed.input)) {
      toolInput = parsed.input;
    } else if (parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params)) {
      toolInput = parsed.params;
    } else {
      // If there is no wrapper field, treat object fields as tool input.
      const { name, tool, tool_name, function: fnName, arguments: _args, input, params, ...rest } = parsed;
      toolInput = rest;
    }

    if (effectiveName) return { toolName: effectiveName, toolInput };
  }

  // Pattern C: plain text query inside explicit tool tag.
  if (fallbackName && fallbackName !== "name") {
    if (fallbackName === "web_search") return { toolName: fallbackName, toolInput: { q: raw } };
    if (fallbackName === "parse_file") return { toolName: fallbackName, toolInput: { file_url: raw } };
    return { toolName: fallbackName, toolInput: { text: raw } };
  }

  return { toolName: fallbackName, toolInput: {} };
}

function inferSearchQueryFromContext(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const zh = s.match(/(?:搜索|查找|查詢|查找一下|帮我找|幫我找)([^。！？\n\[\]<]{2,120})/);
  if (zh && zh[1]) return zh[1].trim();
  const en = s.match(/(?:search(?:\s+for)?|look\s*up|find)\s+([^.\n\[\]<]{2,120})/i);
  if (en && en[1]) return en[1].trim();
  const stripped = s
    .replace(/\[TOOL:[\s\S]*?\[\/TOOL\]/g, " ")
    .replace(/<(?:minimax:)?tool_call>[\s\S]*?<\/(?:minimax:)?tool_call>/g, " ")
    .replace(/<(?:｜DSML｜|︱DSML︱|\|DSML\|)function_calls>[\s\S]*?<\/(?:｜DSML｜|︱DSML︱|\|DSML\|)function_calls>/g, " ")
    .trim();
  return stripped.slice(0, 120);
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

  async executeToolCall(toolName, toolInput, traceContext) {
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
        output: result?.data || (result?.filename ? { file: result.filename } : null),
        ...traceContext,
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
        output: null,
        ...traceContext,
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
      const enrichedInput = (toolInput && typeof toolInput === "object")
        ? { ...toolInput, _caller_user_id: userId }
        : toolInput;
      const result = await this.executeToolCall(toolName, enrichedInput);
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
      const parsed = normalizeToolInvocation(toolMatch[1], toolMatch[2]);
      const toolName = normalizeToolName(parsed.toolName);
      const toolInput = parsed.toolInput && typeof parsed.toolInput === "object" ? parsed.toolInput : {};
      if (!toolName) {
        this.logger("warn", "Tool tag unresolved", { tool: toolMatch[1], raw: String(toolMatch[2] || "").slice(0, 200) });
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
        const toolName = normalizeToolName(dInvoke[1]);
        if (!toolName) continue;
        const toolInput = {};
        const paramRe = /<(?:｜DSML｜|︱DSML︱|\|DSML\|)parameter\s+name="(\w+)"[^>]*>([\s\S]*?)<\/(?:｜DSML｜|︱DSML︱|\|DSML\|)parameter>/g;
        let dParam;
        while ((dParam = paramRe.exec(dInvoke[2])) !== null) {
          let val = dParam[2].trim();
          try { val = JSON.parse(val); } catch {}
          toolInput[dParam[1]] = val;
        }
        if (toolName === "web_search" && !toolInput.q && !toolInput.query) {
          const inferred = inferSearchQueryFromContext(contentText);
          if (inferred) toolInput.q = inferred;
        }
        if (Object.keys(toolInput).length > 0) await this._handleToolInvocation(toolName, toolInput, userId, results, "DSML");
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
        const toolName = normalizeToolName(invokeMatch[1]);
        if (!toolName) continue;
        const toolInput = {};
        const paramRe = /<parameter\s+name="(\w+)">([\s\S]*?)<\/parameter>/g;
        let paramMatch;
        while ((paramMatch = paramRe.exec(invokeMatch[2])) !== null) {
          let val = paramMatch[2].trim();
          try { val = JSON.parse(val); } catch {}
          toolInput[paramMatch[1]] = val;
        }
        if (toolName === "web_search" && !toolInput.q && !toolInput.query) {
          const inferred = inferSearchQueryFromContext(contentText);
          if (inferred) toolInput.q = inferred;
        }
        await this._handleToolInvocation(toolName, toolInput, userId, results, "XML");
      }
    }
  }

  /**
   * Full agent loop: send messages to AI, parse tool calls, execute, re-send.
   * Provider-agnostic — caller supplies fetchAI callback for the actual LLM request.
   *
   * @param {object} opts
   * @param {Array} opts.messages - Conversation messages array (mutated in-place with tool results)
   * @param {function} opts.fetchAI - async (messages) => { text, finishReason }  — makes one AI call
   * @param {function} [opts.onDelta] - (deltaText: string) => void — streaming text callback
   * @param {function} [opts.onToolStatus] - (status: { tool, state, message }) => void
   * @param {function} [opts.onFileDownload] - (fileInfo: { tool, filename, mimeType, size, downloadUrl }) => void
   * @param {number} [opts.maxIterations=12] - Safety cap on loop iterations
   * @param {string} [opts.userId] - Caller user ID for tool execution context
   * @returns {Promise<{ text: string, toolResults: Array, iterations: number }>}
   */
  async executeAgentLoop({ messages, fetchAI, onDelta, onToolStatus, onFileDownload, maxIterations = 12, userId } = {}) {
    if (typeof fetchAI !== "function") throw new Error("fetchAI callback is required");

    let fullText = "";
    const allToolResults = [];
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      // 1. Call AI provider
      const aiResponse = await fetchAI(messages);
      const responseText = aiResponse.text || "";
      const finishReason = aiResponse.finishReason || "stop";

      // Emit delta for the AI response text
      if (responseText && typeof onDelta === "function") {
        try { onDelta(responseText); } catch {}
      }

      fullText += responseText;

      // 2. Parse and execute any tool calls in the response
      const toolResults = await this.executeTextToolCalls(responseText, userId);

      if (toolResults.length > 0) {
        // Notify about each tool result
        for (const tr of toolResults) {
          allToolResults.push(tr);

          if (tr.downloadUrl && typeof onFileDownload === "function") {
            try {
              onFileDownload({
                tool: tr.tool,
                filename: tr.filename,
                mimeType: tr.mimeType,
                size: tr.size,
                downloadUrl: tr.downloadUrl,
              });
            } catch {}
          }

          if (typeof onToolStatus === "function") {
            try {
              onToolStatus({
                tool: tr.tool,
                state: "done",
                message: tr.downloadUrl
                  ? `Generated ${tr.filename}`
                  : tr.html ? "Search complete" : `${tr.tool} complete`,
              });
            } catch {}
          }
        }

        // 3. Append assistant + tool results to messages, then loop
        const toolSummary = toolResults.map(tr => {
          if (tr.downloadUrl) return `[File generated: ${tr.filename} (${tr.size} bytes)]`;
          if (tr.data) return JSON.stringify(tr.data);
          if (tr.html) return `[Search results rendered]`;
          return `[${tr.tool} completed]`;
        }).join("\n");

        messages.push({ role: "assistant", content: responseText });
        messages.push({ role: "user", content: `Tool results:\n${toolSummary}\n\nPlease continue based on these results.` });
        continue;
      }

      // 4. No tool calls — check if we should auto-continue (finish_reason=length)
      if (finishReason === "length" && iterations < maxIterations) {
        messages.push({ role: "assistant", content: responseText });
        messages.push({ role: "user", content: "Continue from where you left off." });
        continue;
      }

      // 5. Done — no tools, not truncated
      break;
    }

    return { text: fullText, toolResults: allToolResults, iterations };
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
