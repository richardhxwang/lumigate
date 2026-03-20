'use strict';

const { Router } = require('express');
const { VersionManager } = require('../services/versioning/version-manager');

const router = Router();
const versionManager = new VersionManager({ dataDir: 'data/versions' });

// Expose for external use
router.versionManager = versionManager;

// ---------------------------------------------------------------------------
// POST /v1/versions/:type/:id — Create new version
// ---------------------------------------------------------------------------
router.post('/:type/:id', async (req, res) => {
  try {
    const { data, message, author } = req.body || {};
    const result = await versionManager.createVersion(req.params.type, req.params.id, {
      data,
      message,
      author,
    });
    res.status(201).json({ ok: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/versions/:type/:id — List versions
// ---------------------------------------------------------------------------
router.get('/:type/:id', async (req, res) => {
  try {
    const result = await versionManager.listVersions(req.params.type, req.params.id);
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/versions/:type/:id/published — Get published version for channel
// Must be defined BEFORE /:type/:id/:vid to avoid route collision
// ---------------------------------------------------------------------------
router.get('/:type/:id/published', async (req, res) => {
  try {
    const channel = req.query.channel || 'stable';
    const result = await versionManager.getPublished(req.params.type, req.params.id, channel);
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/versions/:type/:id/:vid — Get specific version
// ---------------------------------------------------------------------------
router.get('/:type/:id/:vid', async (req, res) => {
  try {
    const result = await versionManager.getVersion(req.params.type, req.params.id, req.params.vid);
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/versions/:type/:id/:vid/rollback — Rollback to version
// ---------------------------------------------------------------------------
router.post('/:type/:id/:vid/rollback', async (req, res) => {
  try {
    const result = await versionManager.rollback(req.params.type, req.params.id, req.params.vid);
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/versions/:type/:id/:vid/publish — Publish to channel
// ---------------------------------------------------------------------------
router.post('/:type/:id/:vid/publish', async (req, res) => {
  try {
    const { channel } = req.body || {};
    const result = await versionManager.publish(
      req.params.type,
      req.params.id,
      req.params.vid,
      { channel },
    );
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
