"use strict";

const { Router } = require("express");
const { WorkflowEngine, WorkflowStore, TaskQueue } = require("../services/workflow");

/**
 * Create workflow router.
 *
 * @param {object} options
 * @param {object} options.unifiedRegistry - UnifiedRegistry instance
 * @param {object} [options.lumigentRuntime] - LumigentRuntime instance
 * @param {function} options.log - Structured logger (level, msg, ctx)
 * @param {string} [options.dataDir] - Workflow data directory
 * @returns {Router}
 */
function createWorkflowRouter({ unifiedRegistry, lumigentRuntime, log, dataDir } = {}) {
  const router = Router();

  // ---------------------------------------------------------------------------
  // Initialize engine, store, and task queue
  // ---------------------------------------------------------------------------

  const store = new WorkflowStore({ dataDir: dataDir || "data/workflows" });

  const engine = new WorkflowEngine({
    lumigentRuntime,
    unifiedRegistry,
    log,
  });
  engine.setStore(store);

  const taskQueue = new TaskQueue({
    concurrency: 3,
    log,
  });

  // Purge completed tasks every 30 minutes
  const purgeInterval = setInterval(() => {
    const purged = taskQueue.purge(3_600_000);
    if (purged > 0) {
      log("info", "task_queue_purged", { component: "workflow", purged });
    }
  }, 30 * 60_000);
  purgeInterval.unref(); // Don't keep process alive

  // ---------------------------------------------------------------------------
  // JSON body parsing helper
  // ---------------------------------------------------------------------------

  function parseBody(req, res) {
    if (!req.body || typeof req.body !== "object") {
      res.status(400).json({ ok: false, error: "Request body must be JSON" });
      return null;
    }
    return req.body;
  }

  // ---------------------------------------------------------------------------
  // Workflow CRUD
  // ---------------------------------------------------------------------------

  // POST /v1/workflows — Create workflow
  router.post("/", async (req, res) => {
    try {
      const body = parseBody(req, res);
      if (!body) return;

      const { name, description, nodes, edges, variables } = body;

      if (!name || typeof name !== "string") {
        return res.status(400).json({ ok: false, error: "name is required" });
      }
      if (!Array.isArray(nodes) || nodes.length === 0) {
        return res.status(400).json({ ok: false, error: "nodes array is required and must be non-empty" });
      }

      const workflow = {
        name,
        description: description || "",
        nodes,
        edges: edges || [],
        variables: variables || {},
      };

      // Validate before saving
      const validation = engine.validate({ ...workflow, id: "temp" });
      if (!validation.valid) {
        return res.status(400).json({ ok: false, errors: validation.errors });
      }

      const saved = await store.save(workflow);
      log("info", "workflow_created", { component: "workflow", workflowId: saved.id, name });
      res.status(201).json({ ok: true, workflow: saved });
    } catch (err) {
      log("error", "workflow_create_failed", { component: "workflow", error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /v1/workflows — List workflows
  router.get("/", async (_req, res) => {
    try {
      const workflows = await store.list();
      res.json({ ok: true, workflows });
    } catch (err) {
      log("error", "workflow_list_failed", { component: "workflow", error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /v1/workflows/:id — Get workflow detail
  router.get("/:id", async (req, res) => {
    try {
      const workflow = await store.load(req.params.id);
      if (!workflow) {
        return res.status(404).json({ ok: false, error: "Workflow not found" });
      }
      res.json({ ok: true, workflow });
    } catch (err) {
      log("error", "workflow_get_failed", { component: "workflow", error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // PUT /v1/workflows/:id — Update workflow
  router.put("/:id", async (req, res) => {
    try {
      const body = parseBody(req, res);
      if (!body) return;

      const existing = await store.load(req.params.id);
      if (!existing) {
        return res.status(404).json({ ok: false, error: "Workflow not found" });
      }

      const updated = {
        ...existing,
        ...body,
        id: req.params.id, // Prevent id override
      };

      const validation = engine.validate(updated);
      if (!validation.valid) {
        return res.status(400).json({ ok: false, errors: validation.errors });
      }

      const saved = await store.save(updated);
      log("info", "workflow_updated", { component: "workflow", workflowId: saved.id });
      res.json({ ok: true, workflow: saved });
    } catch (err) {
      log("error", "workflow_update_failed", { component: "workflow", error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // DELETE /v1/workflows/:id — Delete workflow
  router.delete("/:id", async (req, res) => {
    try {
      const deleted = await store.delete(req.params.id);
      if (!deleted) {
        return res.status(404).json({ ok: false, error: "Workflow not found" });
      }
      log("info", "workflow_deleted", { component: "workflow", workflowId: req.params.id });
      res.json({ ok: true });
    } catch (err) {
      log("error", "workflow_delete_failed", { component: "workflow", error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Workflow execution
  // ---------------------------------------------------------------------------

  // POST /v1/workflows/:id/execute — Execute workflow
  router.post("/:id/execute", async (req, res) => {
    try {
      const workflow = await store.load(req.params.id);
      if (!workflow) {
        return res.status(404).json({ ok: false, error: "Workflow not found" });
      }

      const body = req.body || {};
      const { input, variables, async: asyncMode } = body;

      const context = {
        userId: body.userId || req.headers["x-user-id"] || "anonymous",
        sessionId: body.sessionId || undefined,
        input: input || {},
        variables: variables || {},
      };

      // Async mode: enqueue and return immediately
      if (asyncMode) {
        const taskId = taskQueue.enqueue({
          type: "workflow_execution",
          payload: { workflowId: workflow.id },
          timeoutMs: body.timeoutMs || 600_000, // 10 min default for async
          priority: body.priority || 0,
          handler: async (payload, { signal }) => {
            // Check abort between major steps
            if (signal.aborted) throw new Error("Task cancelled");
            return engine.execute(workflow, context);
          },
        });

        log("info", "workflow_execute_async", {
          component: "workflow",
          workflowId: workflow.id,
          taskId,
        });

        return res.status(202).json({
          ok: true,
          taskId,
          message: "Workflow execution queued",
          statusUrl: `/v1/tasks/${taskId}`,
        });
      }

      // Synchronous execution
      const result = await engine.execute(workflow, context);
      res.json({ ok: true, ...result });
    } catch (err) {
      log("error", "workflow_execute_failed", {
        component: "workflow",
        workflowId: req.params.id,
        error: err.message,
      });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /v1/workflows/:id/executions/:execId/resume — Resume paused workflow
  router.post("/:id/executions/:execId/resume", async (req, res) => {
    try {
      const body = req.body || {};
      const { approved, comment, data } = body;

      if (typeof approved !== "boolean") {
        return res.status(400).json({ ok: false, error: "approved (boolean) is required" });
      }

      const result = await engine.resume(req.params.execId, { approved, comment, data });
      log("info", "workflow_resumed", {
        component: "workflow",
        workflowId: req.params.id,
        executionId: req.params.execId,
        approved,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      log("error", "workflow_resume_failed", {
        component: "workflow",
        executionId: req.params.execId,
        error: err.message,
      });
      const status = err.message.includes("not found") ? 404 : 500;
      res.status(status).json({ ok: false, error: err.message });
    }
  });

  // GET /v1/workflows/:id/executions — List executions for a workflow
  router.get("/:id/executions", async (req, res) => {
    try {
      const executions = await store.listExecutions(req.params.id);
      res.json({ ok: true, executions });
    } catch (err) {
      log("error", "workflow_list_executions_failed", { component: "workflow", error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Task status (async execution)
  // ---------------------------------------------------------------------------

  // GET /v1/tasks/:taskId — Get task status
  router.get("/tasks/:taskId", async (req, res) => {
    const status = taskQueue.getStatus(req.params.taskId);
    if (!status) {
      return res.status(404).json({ ok: false, error: "Task not found" });
    }
    res.json({ ok: true, task: status });
  });

  // POST /v1/tasks/:taskId/cancel — Cancel task
  router.post("/tasks/:taskId/cancel", async (req, res) => {
    const cancelled = taskQueue.cancel(req.params.taskId);
    if (!cancelled) {
      return res.status(404).json({ ok: false, error: "Task not found or already completed" });
    }
    log("info", "task_cancelled_via_api", { component: "workflow", taskId: req.params.taskId });
    res.json({ ok: true, message: "Task cancelled" });
  });

  // GET /v1/tasks — Queue stats (admin overview)
  router.get("/tasks", async (_req, res) => {
    res.json({ ok: true, stats: taskQueue.stats() });
  });

  return router;
}

module.exports = { createWorkflowRouter };
