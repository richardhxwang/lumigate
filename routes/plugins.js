'use strict';

const { Router } = require('express');
const { PluginRegistry } = require('../services/plugins/registry');

const router = Router();
const pluginRegistry = new PluginRegistry({ dataDir: 'data/plugins' });

// Expose registry for external integration (e.g., UnifiedRegistry)
router.pluginRegistry = pluginRegistry;

// ---------------------------------------------------------------------------
// POST /v1/plugins — Register plugin
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const plugin = await pluginRegistry.register(req.body || {});
    res.status(201).json({ ok: true, data: plugin });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/plugins — List/search plugins
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { type, tag, search } = req.query;
    const plugins = await pluginRegistry.list({ type, tag, search });
    res.json({ ok: true, data: plugins, total: plugins.length });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/plugins/:id — Get plugin detail
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const plugin = await pluginRegistry.get(req.params.id);
    res.json({ ok: true, data: plugin });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /v1/plugins/:id — Update plugin
// ---------------------------------------------------------------------------
router.put('/:id', async (req, res) => {
  try {
    const plugin = await pluginRegistry.update(req.params.id, req.body || {});
    res.json({ ok: true, data: plugin });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /v1/plugins/:id — Unregister plugin
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const result = await pluginRegistry.unregister(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/plugins/:id/execute — Execute plugin tool
// ---------------------------------------------------------------------------
router.post('/:id/execute', async (req, res) => {
  try {
    const result = await pluginRegistry.execute(req.params.id, req.body || {});
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/plugins/:id/toggle — Enable/disable
// ---------------------------------------------------------------------------
router.post('/:id/toggle', async (req, res) => {
  try {
    const plugin = await pluginRegistry.get(req.params.id);
    const updated = plugin.enabled
      ? await pluginRegistry.disable(req.params.id)
      : await pluginRegistry.enable(req.params.id);
    res.json({ ok: true, data: updated });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/plugins/import/openapi — Import from OpenAPI spec
// ---------------------------------------------------------------------------
router.post('/import/openapi', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: 'url is required' });

    const plugins = await pluginRegistry.importFromOpenAPI(url);
    res.status(201).json({ ok: true, data: plugins, imported: plugins.length });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/plugins/import/mcp — Import from MCP server
// ---------------------------------------------------------------------------
router.post('/import/mcp', async (req, res) => {
  try {
    const plugin = await pluginRegistry.importFromMCP(req.body || {});
    res.status(201).json({ ok: true, data: plugin });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
