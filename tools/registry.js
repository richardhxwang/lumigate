"use strict";

/**
 * Tool Registry — Fetches and caches tool schemas from microservices.
 * Delegates actual tool execution to builtin-handlers.js.
 *
 * This file is kept as a thin wrapper for backward compatibility.
 * New code should import from builtin-handlers.js directly.
 */

const { executeToolCall, EXTRA_TOOL_SCHEMAS, DOC_GEN_URL } = require("./builtin-handlers");

const REFRESH_TTL = 5 * 60_000; // 5 minutes

class ToolRegistry {
  constructor() {
    this.schemas = [];
    this.lastFetch = 0;
  }

  async refresh() {
    try {
      const res = await fetch(`${DOC_GEN_URL}/tools`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        this.schemas = Array.isArray(data) ? data : [];
      } else {
        console.warn(`[tool-registry] Failed to fetch doc-gen tools: ${res.status}`);
        this.schemas = [];
      }
    } catch (err) {
      console.warn(`[tool-registry] doc-gen unreachable: ${err.message}`);
      this.schemas = [];
    }
    // Append extra tools
    for (const tool of EXTRA_TOOL_SCHEMAS) {
      if (!this.schemas.find(t => t.name === tool.name)) {
        this.schemas.push(tool);
      }
    }
    this.lastFetch = Date.now();
  }

  async getSchemas() {
    if (Date.now() - this.lastFetch > REFRESH_TTL) {
      await this.refresh();
    }
    return this.schemas;
  }

  getSystemPrompt() {
    return "";
  }
}

const registry = new ToolRegistry();
// Pre-warm on import
registry.refresh().catch(e => console.error(`[tool-registry] refresh_failed error=${e.message}`));

module.exports = { registry, executeToolCall };
