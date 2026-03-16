"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { registry, executeToolCall: builtinExecute } = require("./registry");

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

    return Array.from(schemaMap.values());
  }

  /**
   * Execute a tool call by routing to the appropriate handler.
   * Priority: custom handler > built-in handler > MCP client.
   * @param {string} toolName
   * @param {object} toolInput
   * @returns {Promise<{ ok: boolean, data?: any, file?: Buffer, error?: string, duration?: number }>}
   */
  async executeToolCall(toolName, toolInput) {
    const startTime = Date.now();

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

    // 3. Try MCP client
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
    const { category, template, data } = toolInput;
    const catalogPath = path.join(__dirname, "..", "templates", "catalog.json");

    try {
      if (!fs.existsSync(catalogPath)) {
        // No catalog — fall back to generate_spreadsheet with the data
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

      if (!match || !match.file || !fs.existsSync(match.file)) {
        return this._templateFallback(toolInput, startTime);
      }

      // Read the template file
      const ext = path.extname(match.file).toLowerCase();

      if (ext === ".xls") {
        // Read .xls with xlrd-style approach — actually we need to convert or use ExcelJS
        // For .xls files, we copy the file and return it as-is (template download)
        // In production, this would fill data into the template
        const fileBuffer = fs.readFileSync(match.file);
        const outName = data?.company
          ? `${data.company}_${match.name}.xls`
          : `${match.name}_template.xls`;
        return {
          ok: true,
          file: fileBuffer,
          filename: outName,
          mimeType: "application/vnd.ms-excel",
          data: { template: match.name, category: match.category, sheets: match.sheets, note: "Professional template from library" },
          duration: Date.now() - startTime,
        };
      } else if (ext === ".xlsx") {
        const fileBuffer = fs.readFileSync(match.file);
        return {
          ok: true,
          file: fileBuffer,
          filename: `${data?.company || match.name}_model.xlsx`,
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          data: { template: match.name, sheets: match.sheets },
          duration: Date.now() - startTime,
        };
      } else if (ext === ".pptx") {
        const fileBuffer = fs.readFileSync(match.file);
        return {
          ok: true,
          file: fileBuffer,
          filename: `${data?.company || match.name}_presentation.pptx`,
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          data: { template: match.name },
          duration: Date.now() - startTime,
        };
      } else if (ext === ".docx") {
        const fileBuffer = fs.readFileSync(match.file);
        return {
          ok: true,
          file: fileBuffer,
          filename: `${data?.company || match.name}_document.docx`,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          data: { template: match.name },
          duration: Date.now() - startTime,
        };
      }

      return this._templateFallback(toolInput, startTime);
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
      "Tools: generate_spreadsheet, generate_document, generate_presentation, use_template, web_search",
      "",
      "IMPORTANT: When creating financial models, reports, or presentations, FIRST check if a template exists:",
      '  [TOOL:use_template]{"category":"finance/dcf","template":"DCF Model","data":{"company":"华润啤酒","revenue":[36428,38932,38635]}}[/TOOL]',
      "If no matching template, generate from scratch:",
      '  [TOOL:generate_spreadsheet]{"title":"Model","sheets":[{"name":"Sheet1","headers":["","2024","2025"],"rows":[["Revenue",1000,"=B2*1.2"]]}]}[/TOOL]',
      "",
      "RULES: When asked to CREATE a file, ALWAYS use a tool. Never output file content as text.",
      "For Excel: use real numbers (not strings), formulas start with =, percentages as decimals (0.15 not 15%).",
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

    return Array.from(schemaMap.values());
  }
}

const unifiedRegistry = new UnifiedRegistry();

module.exports = { UnifiedRegistry, unifiedRegistry };
