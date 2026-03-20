'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid() {
  return crypto.randomBytes(12).toString('hex');
}

function now() {
  return new Date().toISOString();
}

function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_TYPES = ['tool', 'provider', 'middleware', 'integration'];

function validatePlugin(plugin, isUpdate = false) {
  const errors = [];

  if (!isUpdate) {
    if (!plugin.name || typeof plugin.name !== 'string') errors.push('name is required');
    if (!plugin.type || !VALID_TYPES.includes(plugin.type)) {
      errors.push(`type must be one of: ${VALID_TYPES.join(', ')}`);
    }
  } else {
    if (plugin.type !== undefined && !VALID_TYPES.includes(plugin.type)) {
      errors.push(`type must be one of: ${VALID_TYPES.join(', ')}`);
    }
  }

  if (plugin.version !== undefined && typeof plugin.version !== 'string') {
    errors.push('version must be a string');
  }

  if (plugin.schema !== undefined) {
    if (typeof plugin.schema !== 'object' || plugin.schema === null) {
      errors.push('schema must be an object');
    }
  }

  if (plugin.endpoint !== undefined) {
    if (typeof plugin.endpoint !== 'object' || plugin.endpoint === null) {
      errors.push('endpoint must be an object');
    } else if (!plugin.endpoint.url) {
      errors.push('endpoint.url is required when endpoint is provided');
    }
  }

  if (plugin.code !== undefined && typeof plugin.code !== 'string') {
    errors.push('code must be a string');
  }

  if (plugin.tags !== undefined && !Array.isArray(plugin.tags)) {
    errors.push('tags must be an array');
  }

  if (errors.length > 0) {
    throw Object.assign(new Error(`Validation failed: ${errors.join('; ')}`), { status: 400 });
  }
}

// ---------------------------------------------------------------------------
// PluginRegistry
// ---------------------------------------------------------------------------

class PluginRegistry {
  /**
   * @param {object} opts
   * @param {string} [opts.dataDir='data/plugins']
   * @param {Function} [opts.log]
   */
  constructor({ dataDir = 'data/plugins', pbStore, log } = {}) {
    this.dataDir = dataDir;
    this._pbStore = pbStore || null;
    this.log = log || console.log;
    this.pluginsFile = path.join(dataDir, 'plugins.json');

    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    this._plugins = readJSON(this.pluginsFile, []);
  }

  _save() {
    atomicWrite(this.pluginsFile, this._plugins);
  }

  // ---- CRUD ---------------------------------------------------------------

  async register(plugin) {
    validatePlugin(plugin);

    // Check duplicate name+version
    const dup = this._plugins.find(
      p => p.name === plugin.name && p.version === (plugin.version || '0.0.1'),
    );
    if (dup) {
      throw Object.assign(
        new Error(`Plugin "${plugin.name}" v${plugin.version || '0.0.1'} already exists (id: ${dup.id})`),
        { status: 409 },
      );
    }

    const entry = {
      id: uid(),
      name: plugin.name.trim(),
      description: (plugin.description || '').trim(),
      version: plugin.version || '0.0.1',
      author: plugin.author || 'unknown',
      type: plugin.type,
      schema: plugin.schema || null,
      endpoint: plugin.endpoint || null,
      code: plugin.code || null,
      config: plugin.config || {},
      tags: (plugin.tags || []).map(String),
      enabled: plugin.enabled !== false,
      createdAt: now(),
      updatedAt: now(),
    };

    this._plugins.push(entry);
    this._save();

    // Sync to PocketBase (async, non-blocking)
    if (this._pbStore) {
      this._pbStore.createAsync('plugins', {
        name: entry.name,
        description: entry.description,
        version: entry.version,
        author: entry.author,
        plugin_type: entry.type,
        schema: entry.schema,
        endpoint: entry.endpoint,
        config: entry.config,
        tags: entry.tags,
        enabled: entry.enabled,
      });
    }

    this.log(`[plugins] registered: ${entry.id} (${entry.name} v${entry.version})`);
    return entry;
  }

  async unregister(pluginId) {
    const idx = this._plugins.findIndex(p => p.id === pluginId);
    if (idx === -1) throw Object.assign(new Error('Plugin not found'), { status: 404 });

    const removed = this._plugins.splice(idx, 1)[0];
    this._save();

    // Delete from PocketBase (async, non-blocking)
    if (this._pbStore) {
      this._pbStore.findOne('plugins', `name='${removed.name}' && version='${removed.version}'`).then((rec) => {
        if (rec) this._pbStore.delete('plugins', rec.id).catch(() => {});
      }).catch(() => {});
    }

    this.log(`[plugins] unregistered: ${removed.id} (${removed.name})`);
    return { ok: true, id: removed.id };
  }

  async list({ type, tag, search } = {}) {
    let results = this._plugins;

    if (type) {
      results = results.filter(p => p.type === type);
    }
    if (tag) {
      const t = tag.toLowerCase();
      results = results.filter(p => p.tags.some(pt => pt.toLowerCase() === t));
    }
    if (search) {
      const q = search.toLowerCase();
      results = results.filter(
        p =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.tags.some(t => t.toLowerCase().includes(q)),
      );
    }

    return results;
  }

  async get(pluginId) {
    const plugin = this._plugins.find(p => p.id === pluginId);
    if (!plugin) throw Object.assign(new Error('Plugin not found'), { status: 404 });
    return plugin;
  }

  async update(pluginId, updates) {
    validatePlugin(updates, true);

    const plugin = this._plugins.find(p => p.id === pluginId);
    if (!plugin) throw Object.assign(new Error('Plugin not found'), { status: 404 });

    const allowed = ['name', 'description', 'version', 'author', 'type', 'schema', 'endpoint', 'code', 'config', 'tags', 'enabled'];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        plugin[key] = updates[key];
      }
    }
    plugin.updatedAt = now();

    this._save();

    // Sync update to PocketBase (async, non-blocking)
    if (this._pbStore) {
      this._pbStore.findOne('plugins', `name='${plugin.name}'`).then((rec) => {
        if (rec) {
          this._pbStore.updateAsync('plugins', rec.id, {
            name: plugin.name,
            description: plugin.description,
            version: plugin.version,
            author: plugin.author,
            plugin_type: plugin.type,
            schema: plugin.schema,
            endpoint: plugin.endpoint,
            config: plugin.config,
            tags: plugin.tags,
            enabled: plugin.enabled,
          });
        }
      }).catch(() => {});
    }

    this.log(`[plugins] updated: ${plugin.id} (${plugin.name})`);
    return plugin;
  }

  async enable(pluginId) {
    return this.update(pluginId, { enabled: true });
  }

  async disable(pluginId) {
    return this.update(pluginId, { enabled: false });
  }

  // ---- Execution ----------------------------------------------------------

  /**
   * Execute a plugin tool. Supports two modes:
   * - endpoint: HTTP call to a remote URL
   * - code: inline JS execution (sandboxed via Function constructor)
   */
  async execute(pluginId, input) {
    const plugin = await this.get(pluginId);

    if (!plugin.enabled) {
      throw Object.assign(new Error('Plugin is disabled'), { status: 403 });
    }

    if (plugin.endpoint) {
      return this._executeRemote(plugin, input);
    }

    if (plugin.code) {
      return this._executeInline(plugin, input);
    }

    throw Object.assign(new Error('Plugin has no endpoint or code to execute'), { status: 400 });
  }

  async _executeRemote(plugin, input) {
    const { url, method = 'POST', headers = {} } = plugin.endpoint;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: method !== 'GET' ? JSON.stringify(input) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw Object.assign(
          new Error(`Remote plugin returned ${res.status}: ${text.slice(0, 500)}`),
          { status: 502 },
        );
      }

      return res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        throw Object.assign(new Error('Plugin execution timed out (30s)'), { status: 504 });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  async _executeInline(plugin, input) {
    try {
      // Minimal sandbox: the function receives `input` and `config`
      const fn = new Function('input', 'config', plugin.code);
      const result = await Promise.resolve(fn(input, plugin.config));
      return result;
    } catch (err) {
      throw Object.assign(
        new Error(`Plugin inline execution failed: ${err.message}`),
        { status: 500 },
      );
    }
  }

  // ---- Tool schema integration --------------------------------------------

  /**
   * Returns tool schemas for all enabled tool-type plugins, suitable for
   * injection into UnifiedRegistry / LLM tool_use.
   */
  async getToolSchemas() {
    const tools = this._plugins.filter(p => p.enabled && p.type === 'tool' && p.schema);
    return tools.map(p => ({
      name: p.name,
      description: p.description,
      input_schema: p.schema.input_schema || p.schema,
      _pluginId: p.id,
    }));
  }

  // ---- Import helpers -----------------------------------------------------

  /**
   * Import tools from an OpenAPI specification URL.
   * Fetches the spec, extracts paths, and registers each operation as a
   * plugin with type 'tool'.
   */
  async importFromOpenAPI(specUrl) {
    if (!specUrl || typeof specUrl !== 'string') {
      throw Object.assign(new Error('specUrl is required'), { status: 400 });
    }

    const res = await fetch(specUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw Object.assign(new Error(`Failed to fetch OpenAPI spec: ${res.status}`), { status: 502 });
    }

    const spec = await res.json();
    const imported = [];
    const basePath = spec.servers?.[0]?.url || '';
    const paths = spec.paths || {};

    for (const [pathStr, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (['get', 'post', 'put', 'patch', 'delete'].indexOf(method) === -1) continue;

        const opId = operation.operationId || `${method}_${pathStr.replace(/\//g, '_')}`;
        const plugin = await this.register({
          name: opId,
          description: operation.summary || operation.description || `${method.toUpperCase()} ${pathStr}`,
          version: spec.info?.version || '0.0.1',
          author: spec.info?.title || 'OpenAPI Import',
          type: 'tool',
          schema: operation.requestBody?.content?.['application/json']?.schema || null,
          endpoint: {
            url: `${basePath}${pathStr}`,
            method: method.toUpperCase(),
          },
          tags: operation.tags || ['openapi-import'],
        });
        imported.push(plugin);
      }
    }

    this.log(`[plugins] imported ${imported.length} tools from OpenAPI: ${specUrl}`);
    return imported;
  }

  /**
   * Import tools from an MCP server configuration.
   * Stores the server config as an integration-type plugin.
   */
  async importFromMCP(serverConfig) {
    if (!serverConfig || typeof serverConfig !== 'object') {
      throw Object.assign(new Error('serverConfig is required'), { status: 400 });
    }
    if (!serverConfig.name) {
      throw Object.assign(new Error('serverConfig.name is required'), { status: 400 });
    }

    const plugin = await this.register({
      name: `mcp_${serverConfig.name}`,
      description: serverConfig.description || `MCP Server: ${serverConfig.name}`,
      version: serverConfig.version || '0.0.1',
      author: serverConfig.author || 'MCP Import',
      type: 'integration',
      config: {
        transport: serverConfig.transport || 'stdio',
        command: serverConfig.command,
        args: serverConfig.args || [],
        env: serverConfig.env || {},
        url: serverConfig.url, // for SSE transport
      },
      tags: ['mcp', ...(serverConfig.tags || [])],
    });

    this.log(`[plugins] imported MCP server: ${serverConfig.name}`);
    return plugin;
  }
}

module.exports = { PluginRegistry, VALID_TYPES };
