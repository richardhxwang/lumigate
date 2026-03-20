"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { registry } = require("./registry");
const { executeToolCall: builtinExecute } = require("./builtin-handlers");

/**
 * UnifiedRegistry — Enhanced tool registry that combines built-in tools,
 * schema-defined tools, and optional MCP tools via a single interface.
 *
 * Built-in tools come from the existing ToolRegistry (doc-gen, file-parser, etc.).
 * Schema files in tools/schemas/ define additional tool definitions.
 * MCP tools are loaded dynamically if tools/mcp-client.js exists.
 */

// Attempt to load MCP client (optional dependency)
let mcpClient = null;
try {
  mcpClient = require("./mcp-client");
} catch {
  // MCP client not available — that's fine, operate without it
}

/**
 * Load all JSON schema files from tools/schemas/ directory.
 * Each file should export { name, description, input_schema }.
 */
function loadSchemaFiles() {
  const schemasDir = path.join(__dirname, "schemas");
  const schemas = [];
  try {
    const files = fs.readdirSync(schemasDir).filter(f => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(schemasDir, file), "utf-8");
        const schema = JSON.parse(raw);
        if (schema.name && schema.input_schema) {
          schemas.push(schema);
        } else {
          console.warn(`[unified-registry] Schema file ${file} missing name or input_schema, skipped`);
        }
      } catch (err) {
        console.warn(`[unified-registry] Failed to parse ${file}: ${err.message}`);
      }
    }
  } catch {
    // schemas directory doesn't exist — no extra schemas
  }
  return schemas;
}

/**
 * Validate tool execution result for correctness and completeness.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
function validateToolResult(toolName, result) {
  if (!result) return { valid: false, reason: "null result" };
  if (result.error) return { valid: false, reason: result.error };
  if (result.ok === false) return { valid: false, reason: result.error || "tool returned ok:false" };

  // Tool-specific validation
  const name = (toolName || "").toLowerCase();
  if (name === "web_search" && (!result.data?.results?.length)) {
    return { valid: false, reason: "no search results returned" };
  }
  if (name.startsWith("generate_") && !result.file && !result.data?.downloadUrl) {
    return { valid: false, reason: "no file generated" };
  }
  if (name === "parse_file" && !result.data?.text && !result.data?.content) {
    return { valid: false, reason: "no content extracted from file" };
  }
  if (name === "vision_analyze" && !result.data?.description && !result.data?.text) {
    return { valid: false, reason: "no description returned from vision analysis" };
  }
  if (name === "code_run" && result.data?.exitCode !== 0 && result.data?.exitCode !== undefined) {
    return { valid: false, reason: `code exited with non-zero status: ${result.data.exitCode}` };
  }

  return { valid: true };
}

/**
 * Retry strategies per tool type.
 * Returns modified input for retry, or null if no retry strategy exists.
 */
function getRetryInput(toolName, toolInput, attempt) {
  const name = (toolName || "").toLowerCase();

  if (name === "web_search") {
    const q = toolInput.query || toolInput.q || "";
    if (attempt === 1) {
      // Broaden: append "latest" or simplify
      return { ...toolInput, query: q + " latest", q: undefined };
    }
    if (attempt === 2) {
      // Simplify: take first 5 words
      const simplified = q.split(/\s+/).slice(0, 5).join(" ");
      return { ...toolInput, query: simplified, q: undefined, freshness: "" };
    }
  }

  if (name === "code_run" && attempt === 1) {
    // Retry once — transient sandbox issues
    return { ...toolInput };
  }

  return null; // no retry strategy
}

/**
 * Fallback tool mapping: when tool X fails, try tool Y.
 * Returns { toolName, toolInput } or null.
 */
function getFallbackTool(toolName, toolInput) {
  const name = (toolName || "").toLowerCase();

  if (name === "parse_file" && toolInput.file) {
    // If text extraction fails, try vision analysis for image-like content
    const ext = (toolInput.filename || toolInput.file || "").split(".").pop().toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff"].includes(ext)) {
      return { toolName: "vision_analyze", toolInput: { image: toolInput.file, filename: toolInput.filename } };
    }
  }

  return null;
}

/**
 * Build a structured error message that helps the AI decide what to do next.
 */
function buildToolErrorContext(toolName, reason, attempts) {
  const suggestions = [];
  const name = (toolName || "").toLowerCase();

  if (name === "web_search") {
    suggestions.push(
      "Try rephrasing the search with different keywords",
      "Ask the user for more specific information",
      "Provide an answer based on your training data with a disclaimer that it may not be current",
    );
  } else if (name.startsWith("generate_")) {
    suggestions.push(
      "Verify the input data format is correct (numbers not strings, valid sheet structure)",
      "Try generating with simpler/fewer sheets first",
      "Ask the user to clarify the desired file structure",
    );
  } else if (name === "parse_file") {
    suggestions.push(
      "The file format may not be supported — inform the user",
      "Ask the user to provide the content in a different format (e.g., paste as text)",
    );
  } else if (name === "code_run") {
    suggestions.push(
      "Check the code for syntax errors or missing dependencies",
      "Try a simpler version of the code",
      "Ask the user to review the code logic",
    );
  } else {
    suggestions.push(
      "Try an alternative approach to fulfill the user's request",
      "Ask the user for more information or clarification",
    );
  }

  return {
    error: true,
    tool: toolName,
    reason,
    attempts,
    suggestions,
    message: `Tool "${toolName}" failed after ${attempts} attempt(s): ${reason}.\nSuggestions:\n${suggestions.map(s => `- ${s}`).join("\n")}`,
  };
}

class UnifiedRegistry {
  constructor() {
    /** @type {Map<string, { schema: object, handler: function|null }>} */
    this._customTools = new Map();
    this._fileSchemas = loadSchemaFiles();
    this._mcpSchemasCache = [];
    this._mcpCacheTime = 0;
    this._mcpCacheTTL = 60_000; // 1 minute cache for MCP schemas
  }

  /**
   * Get all available tool schemas — built-in + file schemas + custom + MCP.
   * Deduplicates by tool name (later sources override earlier ones).
   * @returns {Promise<object[]>}
   */
  async getSchemas() {
    const schemaMap = new Map();

    // 1. Built-in tools from existing registry (doc-gen, parse_file, etc.)
    const builtinSchemas = await registry.getSchemas();
    for (const s of builtinSchemas) {
      schemaMap.set(s.name, s);
    }

    // 2. File-based schemas from tools/schemas/
    for (const s of this._fileSchemas) {
      schemaMap.set(s.name, s);
    }

    // 3. Custom tools registered at runtime
    for (const [name, { schema }] of this._customTools) {
      schemaMap.set(name, schema);
    }

    // 4. MCP tools (if client available)
    const mcpSchemas = await this._getMCPSchemas();
    for (const s of mcpSchemas) {
      schemaMap.set(s.name, s);
    }

    // 5. Ensure use_template is always present (handled specially in executeToolCall)
    if (!schemaMap.has('use_template')) {
      schemaMap.set('use_template', {
        name: 'use_template',
        description: 'Use a professional template to generate files. Supports inspect mode to preview structure before filling data.',
        input_schema: {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Template category (e.g. "finance/dcf", "hr/offer-letter")' },
            template: { type: 'string', description: 'Template name' },
            inspect: { type: 'boolean', description: 'If true, returns template structure without generating file' },
            data: { type: 'object', description: 'Data to fill the template with (company, sheets, etc.)' }
          },
          required: ['category', 'template']
        }
      });
    }

    return Array.from(schemaMap.values());
  }

  /**
   * Execute a tool call by routing to the appropriate handler.
   * Priority: custom handler > built-in handler > MCP client.
   * Includes result validation, automatic retry, and fallback logic.
   * @param {string} toolName
   * @param {object} toolInput
   * @returns {Promise<{ ok: boolean, data?: any, file?: Buffer, error?: string, duration?: number, _retryInfo?: object }>}
   */
  async executeToolCall(toolName, toolInput) {
    const startTime = Date.now();
    const maxRetries = 2;
    let lastResult = null;
    let lastReason = "";
    let attempts = 0;

    // Try up to maxRetries+1 times (initial + retries)
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const currentInput = attempt === 0 ? toolInput : (getRetryInput(toolName, toolInput, attempt) || toolInput);
      // If retry strategy returned same input as previous, skip
      if (attempt > 0 && currentInput === toolInput && attempt > 1) break;

      lastResult = await this._executeToolCallOnce(toolName, currentInput, startTime);
      attempts = attempt + 1;

      const validation = validateToolResult(toolName, lastResult);
      if (validation.valid) {
        if (attempt > 0) {
          lastResult._retryInfo = { attempts, retriedFrom: "retry", succeeded: true };
          console.log(`[unified-registry] Tool "${toolName}" succeeded on attempt ${attempts}`);
        }
        return lastResult;
      }

      lastReason = validation.reason;

      // Don't retry unknown tools or auth errors
      if (lastResult?.error?.includes("Unknown tool:") || lastResult?.error?.includes("auth")) {
        break;
      }

      // Only retry if we have a retry strategy for this tool
      if (attempt < maxRetries && !getRetryInput(toolName, toolInput, attempt + 1)) {
        break;
      }

      if (attempt < maxRetries) {
        console.log(`[unified-registry] Tool "${toolName}" failed (attempt ${attempts}): ${lastReason}. Retrying...`);
      }
    }

    // All retries exhausted — try fallback tool
    const fallback = getFallbackTool(toolName, toolInput);
    if (fallback) {
      console.log(`[unified-registry] Tool "${toolName}" failed after ${attempts} attempts. Trying fallback: ${fallback.toolName}`);
      const fallbackResult = await this._executeToolCallOnce(fallback.toolName, fallback.toolInput, startTime);
      const fallbackValidation = validateToolResult(fallback.toolName, fallbackResult);
      if (fallbackValidation.valid) {
        fallbackResult._retryInfo = { attempts: attempts + 1, retriedFrom: "fallback", originalTool: toolName, fallbackTool: fallback.toolName, succeeded: true };
        console.log(`[unified-registry] Fallback tool "${fallback.toolName}" succeeded for "${toolName}"`);
        return fallbackResult;
      }
      attempts++;
    }

    // All attempts failed — return structured error context
    const errorCtx = buildToolErrorContext(toolName, lastReason, attempts);
    return {
      ok: false,
      error: errorCtx.message,
      _errorContext: errorCtx,
      _retryInfo: { attempts, succeeded: false },
      duration: Date.now() - startTime,
    };
  }

  /**
   * Single-attempt tool execution (no retry logic).
   * @private
   */
  async _executeToolCallOnce(toolName, toolInput, startTime) {
    // 1. Check custom tools first (runtime-registered with handler)
    const custom = this._customTools.get(toolName);
    if (custom && typeof custom.handler === "function") {
      try {
        const result = await custom.handler(toolInput);
        return { ok: true, ...result, duration: Date.now() - startTime };
      } catch (err) {
        return { ok: false, error: err.message, duration: Date.now() - startTime };
      }
    }

    // 2. Handle use_template — load template, fill with data, return as file
    if (toolName === "use_template") {
      return this._executeTemplate(toolInput, startTime);
    }

    // 3. Try built-in handler (registry.js executeToolCall)
    const builtinResult = await builtinExecute(toolName, toolInput);
    if (builtinResult.ok || builtinResult.error !== `Unknown tool: ${toolName}`) {
      return builtinResult;
    }

    // 4. Try MCP client
    if (mcpClient && typeof mcpClient.executeTool === "function") {
      try {
        const mcpResult = await mcpClient.executeTool(toolName, toolInput);
        return { ok: true, ...mcpResult, duration: Date.now() - startTime };
      } catch (err) {
        return { ok: false, error: `MCP tool error: ${err.message}`, duration: Date.now() - startTime };
      }
    }

    return { ok: false, error: `Unknown tool: ${toolName}`, duration: Date.now() - startTime };
  }

  /**
   * Execute use_template — find best matching template, load it, fill with user data.
   * Falls back to generate_spreadsheet if no template matches.
   */
  async _executeTemplate(toolInput, startTime) {
    const { category, template, data, inspect } = toolInput;
    const catalogPath = path.join(__dirname, "..", "templates", "catalog.json");

    try {
      if (!fs.existsSync(catalogPath)) {
        return this._templateFallback(toolInput, startTime);
      }

      const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));

      // Find best matching template
      let match = null;
      const searchName = (template || "").toLowerCase();
      const searchCat = (category || "").toLowerCase();

      // Exact name match first
      match = catalog.find(e => e.name.toLowerCase() === searchName);
      // Partial name match
      if (!match) match = catalog.find(e => e.name.toLowerCase().includes(searchName) && searchName.length > 3);
      // Category match — pick first in category
      if (!match && searchCat) match = catalog.find(e => e.category.toLowerCase().includes(searchCat));
      // Broadest: category substring
      if (!match && searchCat) match = catalog.find(e => e.category.toLowerCase().includes(searchCat.split("/").pop()));

      if (!match || !match.file || !fs.existsSync(match.file)) {
        // Return list of available templates in this category for AI to choose
        const available = catalog.filter(e => searchCat ? e.category.toLowerCase().includes(searchCat) : true).slice(0, 10);
        return {
          ok: true, data: {
            message: `No exact match for "${template}". Available templates:`,
            templates: available.map(e => ({ name: e.name, category: e.category, sheets: e.sheets })),
          }, duration: Date.now() - startTime,
        };
      }

      // INSPECT mode: return template structure without generating file
      if (inspect) {
        return {
          ok: true, data: {
            message: `Template "${match.name}" found. Use this structure to fill data.`,
            template_name: match.name, category: match.category,
            sheets: match.sheets || [],
            instructions: "Call use_template again WITHOUT inspect, with complete data.sheets array matching these sheet names. Each sheet needs headers + rows with real data and formulas.",
          }, duration: Date.now() - startTime,
        };
      }

      // Read the template file
      const ext = path.extname(match.file).toLowerCase();

      // Template found — use its STRUCTURE as reference, build a new filled xlsx
      // Don't copy the template directly (it's empty/protected)
      // Instead, build a new file based on the data provided + template structure info
      const company = data?.company || "Company";
      const templateInfo = { name: match.name, category: match.category, sheets: match.sheets };

      // Route to generate_spreadsheet with template-aware data
      // The AI provides the actual data; we just ensure the structure matches
      if (data?.sheets) {
        // AI already provided sheet structure — use it directly
        const result = await builtinExecute("generate_spreadsheet", {
          title: `${company} - ${match.name}`,
          sheets: data.sheets,
        });
        if (result.ok) {
          result.data = { ...result.data, based_on_template: match.name, template_sheets: match.sheets };
        }
        return result;
      }

      // AI provided raw financial data — build sheets from it
      const sheets = [];
      if (data?.revenue || data?.financials) {
        const years = data.years || ["2022", "2023", "2024", "2025E", "2026E"];
        const rev = data.revenue || data.financials?.revenue || [];
        const ni = data.net_income || data.financials?.net_income || [];
        const gp = data.gross_profit || data.financials?.gross_profit || [];

        // Income Statement
        const isRows = [["Revenue", ...rev.map((v,i) => i < 3 ? v : `=${String.fromCharCode(66+i-1)}2*1.05`)]];
        if (gp.length) isRows.push(["Gross Profit", ...gp]);
        if (ni.length) isRows.push(["Net Income", ...ni]);
        sheets.push({ name: "Income Statement", headers: ["", ...years.slice(0, Math.max(rev.length, 5))], rows: isRows });

        // DCF if template is DCF-related
        if (match.name.toLowerCase().includes("dcf") || match.category.includes("dcf")) {
          sheets.push({
            name: "DCF Valuation",
            headers: ["Parameter", "Value"],
            rows: [
              ["Risk-Free Rate", 0.035], ["Beta", data.beta || 0.8], ["ERP", 0.06],
              ["Cost of Equity (CAPM)", "=B2+B3*B4"], ["Cost of Debt", 0.04], ["Tax Rate", 0.21],
              ["WACC", "=B5*0.7+B6*(1-B7)*0.3"], ["Terminal Growth", 0.025],
              ["Shares Outstanding (M)", data.shares || 3240],
            ],
          });
        }
      }

      if (sheets.length === 0) {
        // No usable data — return template info so AI knows what to fill
        return {
          ok: true, data: {
            message: `Template "${match.name}" found (${match.sheets?.join(", ")}). Provide data in sheets format to fill it.`,
            template: templateInfo, required_data: "Provide 'sheets' array with headers and rows, or financial data (revenue, net_income arrays).",
          }, duration: Date.now() - startTime,
        };
      }

      const result = await builtinExecute("generate_spreadsheet", { title: `${company} - ${match.name}`, sheets });
      if (result.ok) result.data = { ...result.data, based_on_template: match.name };
      return result;
    } catch (err) {
      return { ok: false, error: `Template error: ${err.message}`, duration: Date.now() - startTime };
    }
  }

  /** Fallback: convert template request to generate_spreadsheet call */
  _templateFallback(toolInput, startTime) {
    const { data } = toolInput;
    if (data && typeof data === "object") {
      // Try to build a basic spreadsheet from the data
      const sheets = [];
      if (data.revenue || data.financials) {
        const fin = data.financials || {};
        sheets.push({
          name: "Financial Summary",
          headers: ["Metric", ...(data.years || ["2022", "2023", "2024"])],
          rows: [
            ["Revenue", ...(data.revenue || fin.revenue || [])],
            ["Net Income", ...(data.net_income || fin.net_income || [])],
          ].filter(r => r.length > 1),
        });
      }
      if (sheets.length > 0) {
        return builtinExecute("generate_spreadsheet", { title: data.company || "Financial Model", sheets });
      }
    }
    return { ok: false, error: "No matching template found and insufficient data for fallback", duration: Date.now() - startTime };
  }

  /**
   * Generate a dynamic system prompt describing all available tools.
   * @returns {string}
   */
  getSystemPrompt() {
    const allSchemas = this._getAllSchemasSync();
    if (allSchemas.length === 0) {
      return "No tools are currently available.";
    }

    const toolLines = allSchemas.map(s => {
      const params = s.input_schema?.properties
        ? Object.keys(s.input_schema.properties).join(", ")
        : "";
      return `- ${s.name}: ${s.description}${params ? ` (params: ${params})` : ""}`;
    });

    // Load template index if available
    let templateHint = "";
    try {
      const idxPath = path.join(__dirname, "..", "templates", "INDEX.md");
      if (fs.existsSync(idxPath)) {
        const idx = fs.readFileSync(idxPath, "utf-8");
        // Extract just category counts for the prompt (keep it short)
        const cats = idx.match(/## .+/g) || [];
        templateHint = `\nYou have ${cats.length} template categories. Use [TOOL:use_template] to base your file on an existing professional template when possible.`;
      }
    } catch {}

    return [
      "You can generate files. Output: [TOOL:name]{json}[/TOOL]",
      "Tools: generate_spreadsheet, generate_document, generate_presentation, use_template, fill_template, financial_statement_analyze, audit_sampling, benford_analysis, journal_entry_testing, variance_analysis, materiality_calculator, reconciliation, going_concern_check",
      "",
      "=== FILE GENERATION WORKFLOW ===",
      "ONLY use tools when user EXPLICITLY asks for file generation. Do NOT generate files for greetings or questions.",
      "",
      "When creating Excel/financial files, follow this 5-step process:",
      "",
      "STEP 1 — Find the right template:",
      "  You have 224 professional templates (DCF, LBO, WACC, Black-Scholes, etc).",
      "  ALWAYS use a template. NEVER generate from scratch if a template exists.",
      "  Call: [TOOL:use_template]{\"category\":\"finance/dcf\",\"template\":\"DCF Model\",\"inspect\":true}[/TOOL]",
      "  This returns the template's sheet structure (sheet names, headers, row labels).",
      "",
      "STEP 2 — Read the template structure:",
      "  The response tells you what sheets exist, what headers/rows are expected.",
      "  Plan which data goes where.",
      "",
      "STEP 3 — Gather data:",
      "  Use your knowledge to fill financial data. If you need real-time data,",
      "  the system will auto-search the web for you. Provide COMPLETE data for ALL sheets.",
      "",
      "STEP 4 — Generate with FULL content:",
      "  Call use_template with complete sheets data. Each sheet MUST have:",
      "  - Multiple rows (minimum 10+ for financial models)",
      "  - Real formulas (=SUM, =NPV, =B2*1.05, cross-sheet refs)",
      "  - All sheets the template defines, not just one",
      '  Example: {"category":"finance/dcf","template":"DCF Model","data":{"company":"华润啤酒","sheets":[{"name":"Historical Data","headers":["","2021","2022","2023","2024"],"rows":[["Revenue",30000,32000,36428,38932],["COGS",18000,19200,21857,23359],...more rows...]},{"name":"DCF Valuation","headers":["Parameter","Value"],"rows":[["WACC",0.08],["Terminal Growth",0.03],...]}]}}',
      "",
      "STEP 5 — Quality check:",
      "  Before outputting, verify: file should be 15KB+ for financial models.",
      "  A DCF with only Revenue is UNACCEPTABLE. Include: Revenue, COGS, Gross Profit,",
      "  EBITDA, D&A, EBIT, Tax, NOPAT, CapEx, Working Capital, FCF, Discount Factors,",
      "  Terminal Value, Enterprise Value, Equity Value, Per Share Value.",
      "",
      "For Excel: real numbers (not strings), formulas with =, percentages as decimals (0.15 not 15%).",
      "",
      "=== FINANCIAL ANALYSIS ===",
      "When user uploads financial statements and asks for tie-out checks, verification, or analysis:",
      "  Use [TOOL:financial_statement_analyze]{\"query\":\"...\",\"documents\":[{\"text\":\"...\",\"name\":\"...\"}]}[/TOOL]",
      "  This runs full casting: parses ALL line items from every statement, auto-verifies every total against sub-items, cross-matches across statements, plus 15+ targeted cross-checks (balance sheet equation, gross profit bridge, cash flow bridge, PPE rollforward, equity changes, etc).",
      "  Use the returned structured results as ground truth. You may explain naturally but do not contradict computed checks.",
      "",
      "=== AUDIT TOOLS ===",
      "Professional audit analytics tools. Use when the user asks for audit procedures, testing, or analysis:",
      "",
      "- audit_sampling: Statistical sampling (MUS, random, stratified). Params: method, population (array of items with amounts), confidence, materiality, expected_error",
      "  Example: [TOOL:audit_sampling]{\"method\":\"mus\",\"population\":[...],\"confidence\":0.95,\"materiality\":50000}[/TOOL]",
      "",
      "- benford_analysis: Benford's Law first-digit/two-digit analysis for fraud detection. Needs 50+ numbers.",
      "  Example: [TOOL:benford_analysis]{\"data\":[1200,3400,5600,...],\"test\":\"both\"}[/TOOL]",
      "",
      "- journal_entry_testing: Flag unusual journal entries (round amounts, weekend postings, just-below-threshold, back-dated, no description).",
      "  Example: [TOOL:journal_entry_testing]{\"entries\":[{\"id\":\"JE001\",\"date\":\"2025-12-31\",\"amount\":9999,\"debit_account\":\"1100\",\"credit_account\":\"4000\",\"user\":\"admin\"}],\"thresholds\":{\"manager\":10000}}[/TOOL]",
      "",
      "- variance_analysis: Analytical procedures — period comparison, budget vs actual, trend regression, ratio analysis.",
      "  Example: [TOOL:variance_analysis]{\"type\":\"period_comparison\",\"current\":{\"Revenue\":1000000},\"prior\":{\"Revenue\":800000},\"materiality_pct\":0.10}[/TOOL]",
      "",
      "- materiality_calculator: ISA 320/PCAOB materiality calculation from financial benchmarks.",
      "  Example: [TOOL:materiality_calculator]{\"revenue\":5000000,\"total_assets\":3000000,\"net_income\":400000,\"entity_type\":\"public\"}[/TOOL]",
      "",
      "- reconciliation: Auto-reconcile two datasets (bank vs GL, sub-ledger vs GL). Matches by amount, date, reference.",
      "  Example: [TOOL:reconciliation]{\"dataset_a\":[...],\"dataset_b\":[...],\"label_a\":\"Bank\",\"label_b\":\"GL\",\"match_fields\":[\"amount\",\"date\"]}[/TOOL]",
      "",
      "- going_concern_check: ISA 570 going concern assessment from financial data + qualitative factors.",
      "  Example: [TOOL:going_concern_check]{\"current_year\":{\"revenue\":1000000,\"net_income\":-50000,\"current_assets\":200000,\"current_liabilities\":350000,\"operating_cash_flow\":-80000}}[/TOOL]",
      "",
      "=== TEMPLATE FILLING ===",
      "Fill Word templates with data from Excel/tables. Generates multiple personalized documents from one template.",
      "Use cases: director confirmations, bank confirmations, AR/AP confirmations, audit letters.",
      "",
      "- fill_template: Fill a Word template ({{placeholder}} syntax) with data. Generates N copies from N data rows.",
      "  Params: template_text (text with {{placeholders}}), template_file_id (PB file ID of .docx template), data (array of objects), key_field, merge, output_format",
      "  Text template: [TOOL:fill_template]{\"template_text\":\"Dear {{director_name}},\\nThis confirms your position as {{position}} with compensation {{total_compensation}}.\",\"data\":[{\"director_name\":\"Alice Chen\",\"position\":\"Executive Director\",\"total_compensation\":\"HK$1,200,000\"},{\"director_name\":\"Bob Wong\",\"position\":\"Non-Executive Director\",\"total_compensation\":\"HK$400,000\"}],\"key_field\":\"director_name\",\"output_filename\":\"Director_Confirmation\"}[/TOOL]",
      "  Binary template: [TOOL:fill_template]{\"template_file_id\":\"abc123\",\"data\":[{\"director_name\":\"Alice\",\"date\":\"2026-03-21\",\"company_name\":\"ACME Ltd\"}],\"key_field\":\"director_name\"}[/TOOL]",
      "  When user uploads a Word template + Excel data: extract placeholders from template, map Excel columns to placeholders, call fill_template with the data array.",
      templateHint,
    ].join("\n");
  }

  /**
   * Register a custom tool at runtime.
   * @param {object} schema - Tool schema { name, description, input_schema }
   * @param {function|null} handler - Async function(toolInput) => result, or null for schema-only
   */
  registerTool(schema, handler = null) {
    if (!schema || !schema.name) {
      throw new Error("Tool schema must include a name");
    }
    if (!schema.input_schema) {
      throw new Error("Tool schema must include input_schema");
    }
    this._customTools.set(schema.name, { schema, handler });
    console.log(`[unified-registry] Registered tool: ${schema.name}`);
  }

  /**
   * Remove a previously registered custom tool.
   * @param {string} name - Tool name to remove
   * @returns {boolean} true if the tool was found and removed
   */
  unregisterTool(name) {
    const existed = this._customTools.delete(name);
    if (existed) {
      console.log(`[unified-registry] Unregistered tool: ${name}`);
    }
    return existed;
  }

  /**
   * Reload file-based schemas from tools/schemas/ directory.
   * Useful if schemas are added/changed at runtime.
   */
  reloadFileSchemas() {
    this._fileSchemas = loadSchemaFiles();
    console.log(`[unified-registry] Reloaded ${this._fileSchemas.length} file schemas`);
  }

  // --- Private helpers ---

  /**
   * Fetch MCP tool schemas with caching.
   * @returns {Promise<object[]>}
   */
  async _getMCPSchemas() {
    if (!mcpClient || typeof mcpClient.listTools !== "function") {
      return [];
    }
    if (Date.now() - this._mcpCacheTime < this._mcpCacheTTL) {
      return this._mcpSchemasCache;
    }
    try {
      const tools = await mcpClient.listTools();
      this._mcpSchemasCache = Array.isArray(tools) ? tools : [];
      this._mcpCacheTime = Date.now();
    } catch (err) {
      console.warn(`[unified-registry] MCP listTools failed: ${err.message}`);
      // Keep stale cache on failure
    }
    return this._mcpSchemasCache;
  }

  /**
   * Synchronous schema collection (built-in cache + file + custom).
   * Used for getSystemPrompt() which is synchronous.
   * Does not include MCP tools (async) — use getSchemas() for the full list.
   */
  _getAllSchemasSync() {
    const schemaMap = new Map();

    // Built-in (cached from last refresh)
    for (const s of registry.schemas) {
      schemaMap.set(s.name, s);
    }

    // File-based
    for (const s of this._fileSchemas) {
      schemaMap.set(s.name, s);
    }

    // Custom
    for (const [name, { schema }] of this._customTools) {
      schemaMap.set(name, schema);
    }

    // MCP cached
    for (const s of this._mcpSchemasCache) {
      schemaMap.set(s.name, s);
    }

    // Ensure use_template is always present
    if (!schemaMap.has('use_template')) {
      schemaMap.set('use_template', {
        name: 'use_template',
        description: 'Use a professional template to generate files. Supports inspect mode to preview structure before filling data.',
        input_schema: {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Template category (e.g. "finance/dcf", "hr/offer-letter")' },
            template: { type: 'string', description: 'Template name' },
            inspect: { type: 'boolean', description: 'If true, returns template structure without generating file' },
            data: { type: 'object', description: 'Data to fill the template with (company, sheets, etc.)' }
          },
          required: ['category', 'template']
        }
      });
    }

    return Array.from(schemaMap.values());
  }
}

const unifiedRegistry = new UnifiedRegistry();

module.exports = { UnifiedRegistry, unifiedRegistry, validateToolResult, buildToolErrorContext };
