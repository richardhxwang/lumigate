"use strict";

/**
 * MCP Client — Connects to MCPJungle gateway to discover and invoke MCP tools.
 *
 * MCPJungle exposes an MCP Streamable HTTP transport at /mcp.
 * This client uses JSON-RPC over HTTP to list tools and call them.
 *
 * Usage:
 *   const { mcpClient } = require('./tools/mcp-client');
 *   const tools = await mcpClient.listTools();
 *   const result = await mcpClient.callTool('playwright', 'browser_navigate', { url: 'https://example.com' });
 */

const MCP_GATEWAY_URL = process.env.MCP_GATEWAY_URL || "http://lumigate-mcpjungle:8080";
const MCP_ENDPOINT = `${MCP_GATEWAY_URL}/mcp`;

const CACHE_TTL = 5 * 60_000; // 5 minutes

let _cachedTools = null;
let _cacheTime = 0;
let _refreshPromise = null;

/**
 * Send a JSON-RPC request to MCPJungle's Streamable HTTP endpoint.
 * @param {string} method - JSON-RPC method name
 * @param {object} [params] - Method parameters
 * @returns {Promise<object>} JSON-RPC result
 */
async function rpcCall(method, params = {}) {
  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params,
  };

  const res = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`MCPJungle returned ${res.status}: ${res.statusText}`);
  }

  const contentType = res.headers.get("content-type") || "";

  // Streamable HTTP may return SSE or plain JSON
  if (contentType.includes("text/event-stream")) {
    return parseSSEResponse(res);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
  }
  return json.result;
}

/**
 * Parse an SSE response stream and extract the JSON-RPC result.
 * MCPJungle Streamable HTTP transport may return results as SSE events.
 */
async function parseSSEResponse(res) {
  const text = await res.text();
  const lines = text.split("\n");
  let lastData = null;

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      lastData = line.slice(6).trim();
    }
  }

  if (!lastData) {
    throw new Error("Empty SSE response from MCPJungle");
  }

  const json = JSON.parse(lastData);
  if (json.error) {
    throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
  }
  return json.result;
}

class MCPClient {
  /**
   * List all available tools from MCPJungle.
   * Returns the raw MCP tools/list result with tool definitions.
   * @returns {Promise<Array<{name: string, description: string, inputSchema: object}>>}
   */
  async listTools() {
    if (_cachedTools && Date.now() - _cacheTime < CACHE_TTL) {
      return _cachedTools;
    }

    // Coalesce concurrent refresh requests
    if (_refreshPromise) return _refreshPromise;

    _refreshPromise = this._fetchTools();
    try {
      return await _refreshPromise;
    } finally {
      _refreshPromise = null;
    }
  }

  /** @private */
  async _fetchTools() {
    try {
      const result = await rpcCall("tools/list");
      const tools = result.tools || [];
      _cachedTools = tools;
      _cacheTime = Date.now();
      return tools;
    } catch (err) {
      console.warn(`[mcp-client] Failed to list tools: ${err.message}`);
      // Return stale cache if available, otherwise empty
      return _cachedTools || [];
    }
  }

  /**
   * Call a specific tool via MCPJungle.
   *
   * MCPJungle uses double-underscore naming: serverName__toolName
   *
   * @param {string} serverName - MCP server name (e.g. 'playwright', 'filesystem')
   * @param {string} toolName - Tool name within that server (e.g. 'browser_navigate')
   * @param {object} args - Tool arguments
   * @returns {Promise<{ok: boolean, data?: any, error?: string, duration: number}>}
   */
  async callTool(serverName, toolName, args = {}) {
    const startTime = Date.now();
    const qualifiedName = `${serverName}__${toolName}`;

    try {
      const result = await rpcCall("tools/call", {
        name: qualifiedName,
        arguments: args,
      });

      return {
        ok: true,
        data: result,
        duration: Date.now() - startTime,
      };
    } catch (err) {
      return {
        ok: false,
        error: err.message,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Get tool schemas in the format compatible with tools/registry.js.
   *
   * Converts MCP tool definitions to the Anthropic/OpenAI tool schema format
   * used by LumiGate's ToolRegistry:
   *   { name, description, input_schema }
   *
   * Tool names are returned in MCPJungle's qualified format: serverName__toolName
   *
   * @returns {Promise<Array<{name: string, description: string, input_schema: object}>>}
   */
  async getSchemas() {
    const tools = await this.listTools();

    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      input_schema: tool.inputSchema || { type: "object", properties: {} },
    }));
  }

  /**
   * Invalidate the cached tool list, forcing a refresh on next call.
   */
  invalidateCache() {
    _cachedTools = null;
    _cacheTime = 0;
  }

  /**
   * Check if MCPJungle gateway is reachable.
   * @returns {Promise<boolean>}
   */
  async isHealthy() {
    try {
      const res = await fetch(`${MCP_GATEWAY_URL}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

const mcpClient = new MCPClient();

module.exports = { MCPClient, mcpClient };
