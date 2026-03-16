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

    // 2. Try built-in handler (registry.js executeToolCall)
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

    return [
      "You have access to the following tools to help users:",
      "",
      ...toolLines,
      "",
      "When using a tool, provide the required parameters as specified.",
      "Tools return structured results. Summarize the output for the user.",
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
