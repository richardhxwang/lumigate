"use strict";

/**
 * routes/knowledge.js — REST API for Knowledge Base management.
 *
 * Mount with: app.use(require('./routes/knowledge').createRouter({ knowledgeService, log, authMiddleware }))
 *
 * Endpoints:
 *   POST   /v1/knowledge                       — Create KB
 *   GET    /v1/knowledge                       — List KBs
 *   GET    /v1/knowledge/:id                   — Get KB detail + stats
 *   DELETE /v1/knowledge/:id                   — Delete KB
 *   POST   /v1/knowledge/:id/documents         — Add document (text or file)
 *   GET    /v1/knowledge/:id/documents         — List documents
 *   DELETE /v1/knowledge/:id/documents/:docId  — Remove document
 *   POST   /v1/knowledge/:id/search            — Search within one KB
 *   POST   /v1/knowledge/search                — Search across multiple KBs
 */

const express = require("express");
const multer = require("multer");

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_TEXT_LENGTH = 2 * 1024 * 1024; // 2 MB of text

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

/**
 * Create the knowledge router.
 *
 * @param {object} opts
 * @param {import('../services/knowledge').KnowledgeBaseManager} opts.manager
 * @param {function} [opts.log]
 * @param {function} [opts.authMiddleware] — Express middleware for auth checks
 * @returns {express.Router}
 */
function createRouter({ manager, log, authMiddleware } = {}) {
  const router = express.Router();
  const _log = log || (() => {});

  // Apply auth middleware to all routes if provided
  if (authMiddleware) {
    router.use(authMiddleware);
  }

  // ── Error wrapper ─────────────────────────────────────────────────────────

  function wrap(fn) {
    return (req, res, next) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  // ── Knowledge Base CRUD ───────────────────────────────────────────────────

  /** POST /v1/knowledge — Create knowledge base */
  router.post(
    "/v1/knowledge",
    wrap(async (req, res) => {
      const { name, description, embeddingModel } = req.body || {};
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ ok: false, error: "name is required" });
      }

      const kb = await manager.create({ name, description, embeddingModel });
      _log("info", "api_kb_created", { component: "knowledge-api", kbId: kb.id, name: kb.name });
      res.status(201).json({ ok: true, knowledgeBase: kb });
    }),
  );

  /** GET /v1/knowledge — List all knowledge bases */
  router.get(
    "/v1/knowledge",
    wrap(async (_req, res) => {
      const list = await manager.list();
      res.json({ ok: true, knowledgeBases: list });
    }),
  );

  /** GET /v1/knowledge/:id — Get KB detail */
  router.get(
    "/v1/knowledge/:id",
    wrap(async (req, res) => {
      const kb = await manager.get(req.params.id);
      if (!kb) return res.status(404).json({ ok: false, error: "Knowledge base not found" });
      res.json({ ok: true, knowledgeBase: kb });
    }),
  );

  /** DELETE /v1/knowledge/:id — Delete KB */
  router.delete(
    "/v1/knowledge/:id",
    wrap(async (req, res) => {
      await manager.delete(req.params.id);
      _log("info", "api_kb_deleted", { component: "knowledge-api", kbId: req.params.id });
      res.json({ ok: true });
    }),
  );

  // ── Document management ───────────────────────────────────────────────────

  /**
   * POST /v1/knowledge/:id/documents
   *
   * Accepts either:
   *  - JSON body: { text, filename, metadata }
   *  - Multipart file upload: field "file"
   */
  router.post(
    "/v1/knowledge/:id/documents",
    upload.single("file"),
    wrap(async (req, res) => {
      const kbId = req.params.id;

      if (req.file) {
        // File upload path
        const result = await manager.addFile(kbId, req.file.buffer, req.file.originalname);
        _log("info", "api_kb_document_file", {
          component: "knowledge-api",
          kbId,
          filename: req.file.originalname,
          documentId: result.documentId,
        });
        return res.status(201).json({ ok: true, ...result });
      }

      // Text body path
      const { text, filename, metadata } = req.body || {};
      if (!text || typeof text !== "string" || !text.trim()) {
        return res.status(400).json({
          ok: false,
          error: "Either a file upload or { text } in JSON body is required",
        });
      }
      if (text.length > MAX_TEXT_LENGTH) {
        return res.status(413).json({
          ok: false,
          error: `Text too large (${text.length} chars, max ${MAX_TEXT_LENGTH})`,
        });
      }

      const result = await manager.addDocument(kbId, { text, filename, metadata });
      _log("info", "api_kb_document_text", {
        component: "knowledge-api",
        kbId,
        documentId: result.documentId,
      });
      res.status(201).json({ ok: true, ...result });
    }),
  );

  /** GET /v1/knowledge/:id/documents — List documents */
  router.get(
    "/v1/knowledge/:id/documents",
    wrap(async (req, res) => {
      const docs = await manager.listDocuments(req.params.id);
      res.json({ ok: true, documents: docs });
    }),
  );

  /** DELETE /v1/knowledge/:id/documents/:docId — Remove document */
  router.delete(
    "/v1/knowledge/:id/documents/:docId",
    wrap(async (req, res) => {
      await manager.removeDocument(req.params.id, req.params.docId);
      _log("info", "api_kb_document_removed", {
        component: "knowledge-api",
        kbId: req.params.id,
        documentId: req.params.docId,
      });
      res.json({ ok: true });
    }),
  );

  // ── Search / Retrieval ────────────────────────────────────────────────────

  /** POST /v1/knowledge/:id/search — Search within one KB */
  router.post(
    "/v1/knowledge/:id/search",
    wrap(async (req, res) => {
      const { query, limit, scoreThreshold } = req.body || {};
      if (!query || typeof query !== "string") {
        return res.status(400).json({ ok: false, error: "query is required" });
      }

      const results = await manager.retrieve(req.params.id, query, {
        limit: Math.min(Math.max(1, Number(limit) || 5), 20),
        scoreThreshold: Number(scoreThreshold) || 0.7,
      });

      res.json({ ok: true, results, context: manager.formatContext(results) });
    }),
  );

  /** POST /v1/knowledge/search — Search across multiple KBs */
  router.post(
    "/v1/knowledge/search",
    wrap(async (req, res) => {
      const { query, kbIds, limit, scoreThreshold } = req.body || {};
      if (!query || typeof query !== "string") {
        return res.status(400).json({ ok: false, error: "query is required" });
      }
      if (!kbIds || !Array.isArray(kbIds) || kbIds.length === 0) {
        return res.status(400).json({ ok: false, error: "kbIds array is required" });
      }
      if (kbIds.length > 10) {
        return res.status(400).json({ ok: false, error: "Maximum 10 knowledge bases per search" });
      }

      const results = await manager.retrieveMulti(kbIds, query, {
        limit: Math.min(Math.max(1, Number(limit) || 5), 20),
        scoreThreshold: Number(scoreThreshold) || 0.7,
      });

      res.json({ ok: true, results, context: manager.formatContext(results) });
    }),
  );

  // ── Error handler ─────────────────────────────────────────────────────────

  router.use((err, _req, res, _next) => {
    const status = err.status || (err.message?.includes("not found") ? 404 : 500);
    _log("error", "knowledge_api_error", {
      component: "knowledge-api",
      error: err.message,
      status,
    });
    res.status(status).json({ ok: false, error: err.message || "Internal error" });
  });

  return router;
}

module.exports = { createRouter };
