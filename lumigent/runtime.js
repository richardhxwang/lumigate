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

      // Log retry info if available
      if (result?._retryInfo) {
        this.logger("info", `${parseLabel} tool retry info`, {
          tool: toolName,
          attempts: result._retryInfo.attempts,
          succeeded: result._retryInfo.succeeded,
          fallbackTool: result._retryInfo.fallbackTool || undefined,
        });
      }

      if (!result?.ok) {
        // Push structured error so follow-up AI call gets actionable context
        if (result?._errorContext) {
          results.push({
            tool: toolName,
            ok: false,
            error: result._errorContext.message,
            suggestions: result._errorContext.suggestions,
            duration: result.duration,
          });
        }
        return;
      }
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
   * Full multi-step agent loop: Plan -> Execute -> Observe -> Reflect -> Repeat.
   * Provider-agnostic — caller supplies fetchAI callback for the actual LLM request.
   *
   * Supports both text-based tool tags and native function calling (via nativeToolCalls).
   *
   * @param {object} opts
   * @param {Array} opts.messages - Conversation messages array (mutated in-place with tool results)
   * @param {function} opts.fetchAI - async (messages, opts?) => { text, finishReason, nativeToolCalls?, usage? }
   * @param {function} [opts.onDelta] - (deltaText: string) => void — streaming text callback
   * @param {function} [opts.onToolStatus] - (status: { tool, state, message, iteration? }) => void
   * @param {function} [opts.onFileDownload] - (fileInfo: { tool, filename, mimeType, size, downloadUrl, base64? }) => void
   * @param {function} [opts.onIteration] - (info: { iteration, phase, toolCount }) => void — progress callback
   * @param {number} [opts.maxIterations=8] - Safety cap on loop iterations
   * @param {string} [opts.userId] - Caller user ID for tool execution context
   * @param {boolean} [opts.planningEnabled=true] - Inject planning prompt on first iteration for complex requests
   * @param {string} [opts.lang="en"] - Language for status messages ("en" or "zh")
   * @returns {Promise<{ text: string, toolResults: Array, iterations: number, plan: string|null }>}
   */
  async executeAgentLoop({
    messages, fetchAI, onDelta, onToolStatus, onFileDownload, onIteration,
    maxIterations = 8, userId, planningEnabled = true, lang = "en",
  } = {}) {
    if (typeof fetchAI !== "function") throw new Error("fetchAI callback is required");

    const allToolResults = [];
    let iterations = 0;
    let plan = null;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;
    const zh = lang === "zh";

    const emitStatus = (info) => { if (typeof onToolStatus === "function") try { onToolStatus(info); } catch {} };
    const emitFile = (info) => { if (typeof onFileDownload === "function") try { onFileDownload(info); } catch {} };
    const emitDelta = (text) => { if (text && typeof onDelta === "function") try { onDelta(text); } catch {} };
    const emitIter = (info) => { if (typeof onIteration === "function") try { onIteration(info); } catch {} };

    while (iterations < maxIterations) {
      iterations++;
      emitIter({ iteration: iterations, phase: "call_ai", toolCount: allToolResults.length });

      // ── Phase 1: Call AI provider ──
      let aiResponse;
      try {
        aiResponse = await fetchAI(messages);
      } catch (err) {
        this.logger("error", "Agent loop fetchAI failed", { iteration: iterations, error: err.message });
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
        // Retry with a nudge
        messages.push({ role: "user", content: "The previous request encountered an error. Please try again or take a different approach." });
        continue;
      }

      const responseText = aiResponse.text || "";
      const finishReason = aiResponse.finishReason || "stop";
      const nativeToolCalls = aiResponse.nativeToolCalls || [];

      // Emit text delta to the client
      emitDelta(responseText);

      // ── Phase 2: Extract plan from first iteration (if present) ──
      if (iterations === 1 && planningEnabled && !plan) {
        plan = this._extractPlan(responseText);
        if (plan) {
          this.logger("info", "Agent plan detected", { planLength: plan.length });
        }
      }

      // ── Phase 3: Execute tools ──
      // Collect results from both native function calls and text-based tool tags
      const iterToolResults = [];
      const iterErrors = [];

      // 3a. Native function calling (OpenAI/Anthropic/DeepSeek/Gemini)
      if (nativeToolCalls.length > 0) {
        emitIter({ iteration: iterations, phase: "execute_tools", toolCount: nativeToolCalls.length });
        for (const tc of nativeToolCalls) {
          const toolName = tc.name;
          let toolInput = {};
          try { toolInput = typeof tc.arguments === "string" ? JSON.parse(tc.arguments || "{}") : (tc.arguments || {}); } catch {}

          emitStatus({ tool: toolName, state: "running", message: zh ? `${toolName} 执行中...` : `Running ${toolName}...`, iteration: iterations });

          try {
            const result = await this.executeToolCall(toolName, { ...toolInput, _caller_user_id: userId });
            if (!result?.ok) {
              const errMsg = result?.error || "Tool returned not-ok";
              iterErrors.push({ tool: toolName, error: errMsg, id: tc.id });
              emitStatus({ tool: toolName, state: "error", message: zh ? `${toolName} 失败: ${errMsg}` : `${toolName} failed: ${errMsg}`, iteration: iterations });
              continue;
            }
            consecutiveErrors = 0; // Reset on success

            const processed = await this._processToolResult(toolName, result, userId);
            processed.id = tc.id;
            iterToolResults.push(processed);

            // Emit file_download and tool_status events
            if (processed.downloadUrl || processed.base64) {
              emitFile({ tool: toolName, filename: processed.filename, mimeType: processed.mimeType, size: processed.size, downloadUrl: processed.downloadUrl || "", base64: processed.base64 });
            }
            emitStatus({ tool: toolName, state: "done", message: processed.filename ? (zh ? `${processed.filename} 已生成` : `Generated ${processed.filename}`) : processed.html ? (zh ? "搜索完成" : "Search complete") : (zh ? `${toolName} 完成` : `${toolName} complete`), iteration: iterations });
          } catch (e) {
            iterErrors.push({ tool: toolName, error: e.message, id: tc.id });
            emitStatus({ tool: toolName, state: "error", message: zh ? `${toolName} 出错: ${e.message}` : `${toolName} error: ${e.message}`, iteration: iterations });
            this.logger("warn", "Agent loop native tool exec failed", { tool: toolName, error: e.message, iteration: iterations });
          }
        }
      }

      // 3b. Text-based tool tags (DSML, [TOOL:], XML)
      const textToolResults = await this.executeTextToolCalls(responseText, userId);
      for (const tr of textToolResults) {
        iterToolResults.push(tr);
        if (tr.downloadUrl || tr.base64) {
          emitFile({ tool: tr.tool, filename: tr.filename, mimeType: tr.mimeType, size: tr.size, downloadUrl: tr.downloadUrl || "", base64: tr.base64 });
        }
        emitStatus({ tool: tr.tool, state: "done", message: tr.filename ? (zh ? `${tr.filename} 已生成` : `Generated ${tr.filename}`) : tr.html ? (zh ? "搜索完成" : "Search complete") : (zh ? `${tr.tool} 完成` : `${tr.tool} complete`), iteration: iterations });
      }

      // Accumulate all results
      for (const tr of iterToolResults) allToolResults.push(tr);

      // ── Phase 4: Reflect — decide whether to continue ──
      const hasResults = iterToolResults.length > 0;
      const hasErrors = iterErrors.length > 0;

      if (hasResults || hasErrors) {
        // Build a summary of what happened this iteration
        const resultSummaries = iterToolResults.map(tr => {
          if (tr.filename) return `[File generated: ${tr.filename} (${tr.size} bytes) - SUCCESS]`;
          if (tr.data?.results) {
            const items = tr.data.results.slice(0, 5);
            return `[Search results (${tr.data.results.length} total):\n${items.map((r, i) => `  ${i + 1}. ${r.title || "Untitled"} - ${r.url || ""}`).join("\n")}]`;
          }
          if (tr.data) return `[${tr.tool} result: ${JSON.stringify(tr.data).slice(0, 400)}]`;
          if (tr.html) return `[${tr.tool}: rendered HTML content]`;
          return `[${tr.tool} completed]`;
        });

        const errorSummaries = iterErrors.map(e => `[${e.tool} FAILED: ${e.error}]`);

        // Construct the reflection prompt
        const allSummaries = [...resultSummaries, ...errorSummaries].join("\n\n");
        const reflectPrompt = this._buildReflectPrompt(allSummaries, hasErrors, iterations, maxIterations, lang);

        messages.push({ role: "assistant", content: responseText });
        messages.push({ role: "user", content: reflectPrompt });

        // Track consecutive errors for bail-out
        if (hasErrors && !hasResults) {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            this.logger("warn", "Agent loop: max consecutive errors reached, stopping", { iterations, errors: iterErrors.length });
            break;
          }
        } else {
          consecutiveErrors = 0;
        }

        continue; // Next iteration: AI reflects on results and decides next action
      }

      // ── Phase 5: No tools invoked — check if we should auto-continue (truncated) ──
      if (finishReason === "length" && iterations < maxIterations) {
        messages.push({ role: "assistant", content: responseText });
        messages.push({ role: "user", content: zh ? "请从中断处继续。" : "Continue from where you left off." });
        continue;
      }

      // ── Phase 6: Done — no tools, not truncated ──
      break;
    }

    // Collect all text from the conversation for the caller
    const fullText = messages
      .filter(m => m.role === "assistant")
      .map(m => m.content || "")
      .join("");

    return { text: fullText, toolResults: allToolResults, iterations, plan };
  }

  /**
   * Process a raw tool execution result into a standardized result object.
   * Handles file persistence, formatting, etc.
   */
  async _processToolResult(toolName, result, userId) {
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
      return {
        tool: toolName,
        filename: result.filename,
        mimeType: result.mimeType,
        size: result.file.length,
        downloadUrl,
        base64: !downloadUrl ? result.file.toString("base64") : undefined,
        duration: result.duration,
      };
    }

    if (result.data) {
      const formatted = this.formatToolResult(toolName, result.data);
      return { tool: toolName, ...formatted, duration: result.duration };
    }

    return { tool: toolName, duration: result.duration };
  }

  /**
   * Extract a plan block from the AI's first response.
   * Looks for numbered steps, "Plan:", "Approach:", etc.
   */
  _extractPlan(text) {
    if (!text) return null;
    // Look for explicit plan markers
    const planPatterns = [
      /(?:^|\n)\s*(?:Plan|Approach|Strategy|My plan|Steps|Here's my (?:plan|approach)):?\s*\n((?:\s*(?:\d+[\.\):]|\-|\*)\s+.+\n?){2,})/i,
      /(?:^|\n)\s*(?:计划|方案|步骤|思路):?\s*\n((?:\s*(?:\d+[\.\):]|\-|\*)\s+.+\n?){2,})/,
    ];
    for (const re of planPatterns) {
      const m = text.match(re);
      if (m && m[1]) return m[1].trim();
    }
    return null;
  }

  /**
   * Build the reflection prompt sent to AI after tool execution.
   * Encourages the AI to evaluate results and decide next steps.
   */
  _buildReflectPrompt(toolSummary, hasErrors, iteration, maxIterations, lang) {
    const zh = lang === "zh";
    const remaining = maxIterations - iteration;
    let prompt = zh
      ? `工具执行结果 (第 ${iteration} 轮):\n${toolSummary}\n\n`
      : `Tool execution results (iteration ${iteration}):\n${toolSummary}\n\n`;

    if (hasErrors) {
      prompt += zh
        ? `部分工具执行失败。你可以：\n- 尝试使用其他工具或不同参数\n- 根据已有结果直接回答\n- 告知用户哪些部分无法完成\n\n`
        : `Some tools failed. You may:\n- Try alternative tools or different parameters\n- Answer based on available results\n- Inform the user what could not be completed\n\n`;
    }

    prompt += zh
      ? `请基于以上结果决定下一步：\n- 如果结果已足够回答用户问题，请直接给出最终回答。\n- 如果还需要更多信息，请调用更多工具。\n- 剩余可用轮次: ${remaining}。`
      : `Based on these results, decide your next step:\n- If results are sufficient to answer the user's question, provide a final answer.\n- If you need more information, call additional tools.\n- Remaining iterations: ${remaining}.`;

    return prompt;
  }

  _trace(entry) {
    if (this.traceStore?.add) this.traceStore.add(entry);
  }
}

/**
 * Detect if a user message is "complex" enough to benefit from a planning prompt.
 * Heuristics: multiple questions, multi-step keywords, long messages, conjunctions implying sequence.
 */
function isComplexRequest(text) {
  if (!text) return false;
  const s = String(text).trim();
  // Long messages often indicate complex tasks
  if (s.length > 300) return true;
  // Multiple question marks
  if ((s.match(/\?/g) || []).length >= 2) return true;
  // Multi-step keywords
  if (/(?:then|after that|next|finally|step\s*\d|第[一二三四五六七八九十]步|然后|接着|最后|首先.*然后|first.*then)/i.test(s)) return true;
  // Multiple tool-like requests in one message
  const toolWords = ["search", "generate", "create", "analyze", "find", "compare", "搜索", "生成", "创建", "分析", "查找", "比较", "对比"];
  let toolHits = 0;
  for (const w of toolWords) { if (s.toLowerCase().includes(w)) toolHits++; }
  if (toolHits >= 2) return true;
  return false;
}

/**
 * Build a planning prompt to inject before the first AI call for complex requests.
 */
function buildPlanningPrompt(lang) {
  if (lang === "zh") {
    return `在执行之前，请先简要规划你的方法：
1. 我需要什么信息？
2. 应该使用哪些工具，按什么顺序？
3. 预期的输出是什么？
然后按计划逐步执行。注意：如果任务简单，可以直接执行不需要规划。`;
  }
  return `Before executing, briefly plan your approach:
1. What information do I need?
2. Which tools should I use and in what order?
3. What is my expected output?
Then execute the plan step by step. Note: if the task is simple, proceed directly without planning.`;
}

module.exports = {
  LumigentRuntime,
  repairJSON,
  defaultFormatToolResult,
  isComplexRequest,
  buildPlanningPrompt,
};
