'use strict';

const { Router } = require('express');

/**
 * routes/observability.js — REST API for trace visualization and evaluation.
 *
 * Mounted at /v1/traces and /v1/experiments by server.js.
 * Requires admin session (getSessionRole check).
 */
module.exports = function createObservabilityRouter({ traceCollector, evaluator, getSessionRole, parseCookies, log }) {
  const router = Router();

  // All observability routes require admin auth
  function requireAdmin(req, res, next) {
    const role = getSessionRole(req);
    if (!role || !['root', 'admin'].includes(role)) {
      return res.status(401).json({ error: 'Admin authentication required' });
    }
    next();
  }

  router.use(requireAdmin);

  // ── Traces ─────────────────────────────────────────────────────────────────

  /**
   * GET /v1/traces/stats — Aggregate stats (must be before /:id)
   */
  router.get('/traces/stats', async (req, res) => {
    try {
      const { from, to, groupBy } = req.query;
      const stats = await traceCollector.getStats({ from, to, groupBy });
      res.json(stats);
    } catch (e) {
      log('error', 'traces stats failed', { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /v1/traces/days — List available days
   */
  router.get('/traces/days', async (req, res) => {
    try {
      const days = await traceCollector.listDays();
      res.json({ days });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /v1/traces — List traces with filters
   * Query params: userId, type, status, from, to, limit, offset
   */
  router.get('/traces', async (req, res) => {
    try {
      const { userId, type, status, from, to, limit, offset } = req.query;
      const result = await traceCollector.listTraces({
        userId,
        type,
        status,
        from,
        to,
        limit: limit ? parseInt(limit, 10) : 50,
        offset: offset ? parseInt(offset, 10) : 0,
      });
      res.json(result);
    } catch (e) {
      log('error', 'list traces failed', { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /v1/traces/:id — Full trace with spans
   */
  router.get('/traces/:id', async (req, res) => {
    try {
      const trace = await traceCollector.getTrace(req.params.id);
      if (!trace) return res.status(404).json({ error: 'Trace not found' });
      res.json(trace);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * DELETE /v1/traces/:id — Delete a trace
   */
  router.delete('/traces/:id', async (req, res) => {
    try {
      const deleted = await traceCollector.deleteTrace(req.params.id);
      res.json({ deleted });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /v1/traces/:id/rate — Manually rate a trace
   * Body: { score, feedback, criteria }
   */
  router.post('/traces/:id/rate', async (req, res) => {
    try {
      const { score, feedback, criteria } = req.body || {};
      if (!score) return res.status(400).json({ error: 'score is required (1-5)' });
      const result = await evaluator.rate(req.params.id, { score, feedback, criteria });
      if (!result) return res.status(404).json({ error: 'Trace not found' });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /v1/traces/:id/auto-evaluate — Auto-evaluate with LLM
   * Body: { criteria, model }
   */
  router.post('/traces/:id/auto-evaluate', async (req, res) => {
    try {
      const { criteria, model } = req.body || {};
      const result = await evaluator.autoEvaluate(req.params.id, { criteria, model });
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /v1/traces/prune — Prune old traces
   * Body: { maxAgeDays }
   */
  router.post('/traces/prune', async (req, res) => {
    try {
      const maxAgeDays = (req.body || {}).maxAgeDays || 30;
      const result = await traceCollector.prune(maxAgeDays * 86400000);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Experiments ────────────────────────────────────────────────────────────

  /**
   * POST /v1/experiments — Create experiment
   * Body: { name, description, variants }
   */
  router.post('/experiments', (req, res) => {
    try {
      const { name, description, variants } = req.body || {};
      const exp = evaluator.createExperiment({ name, description, variants });
      res.status(201).json(exp);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /v1/experiments — List experiments
   */
  router.get('/experiments', (req, res) => {
    try {
      res.json({ experiments: evaluator.listExperiments() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /v1/experiments/:id — Get experiment results
   */
  router.get('/experiments/:id', async (req, res) => {
    try {
      const result = await evaluator.getExperimentResults(req.params.id);
      if (!result) return res.status(404).json({ error: 'Experiment not found' });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /v1/experiments/:id/record — Record variant result
   * Body: { traceId, variant, metrics }
   */
  router.post('/experiments/:id/record', async (req, res) => {
    try {
      const { traceId, variant, metrics } = req.body || {};
      if (!variant) return res.status(400).json({ error: 'variant is required' });
      const result = await evaluator.recordVariant(req.params.id, { traceId, variant, metrics });
      if (result.error) return res.status(404).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /v1/traces/eval-stats — Evaluation aggregate stats
   */
  router.get('/eval-stats', async (req, res) => {
    try {
      const { from, to } = req.query;
      const stats = await evaluator.getEvalStats({ from, to });
      res.json(stats);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
