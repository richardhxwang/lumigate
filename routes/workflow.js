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
  // Visual → Engine format normalization
  // ---------------------------------------------------------------------------
  // The workflow editor sends a visual (React Flow) format:
  //   { nodes: [{id, type, position, data: {label, nodeType}}], edges: [{id, source, target, ...}], configs: {} }
  // The engine expects an execution format:
  //   { nodes: [{id, type, config, inputs, next, branches}], edges: [{source, target}] }
  //
  // This adapter bridges the gap so both formats are accepted transparently.

  /** Map frontend node type names to engine type names. */
  const TYPE_ALIAS = { approval: "human_approval" };

  function isVisualFormat(body) {
    // Heuristic: visual format nodes have a 'position' or 'data' field, or body has 'configs'.
    if (body.configs && typeof body.configs === "object") return true;
    if (Array.isArray(body.nodes) && body.nodes.length > 0) {
      const first = body.nodes[0];
      if (first.position || (first.data && (first.data.nodeType || first.data.label))) return true;
    }
    return false;
  }

  function normalizeWorkflowBody(body) {
    if (!isVisualFormat(body)) {
      // Already in engine format — just fix type aliases on nodes
      if (Array.isArray(body.nodes)) {
        for (const n of body.nodes) {
          if (n.type && TYPE_ALIAS[n.type]) n.type = TYPE_ALIAS[n.type];
        }
      }
      return body;
    }

    const configs = body.configs || {};

    const nodes = (body.nodes || []).map(n => {
      const nodeType = n.data?.nodeType || n.type || "template";
      const engineType = TYPE_ALIAS[nodeType] || nodeType;
      const cfg = configs[n.id] || n.config || {};

      const engineNode = {
        id: n.id,
        type: engineType,
        config: mapConfigToEngine(engineType, cfg),
        inputs: n.inputs || {},
      };

      // Preserve visual metadata for round-trip (so the editor can reload)
      engineNode._visual = {
        position: n.position,
        label: n.data?.label || "",
      };

      return engineNode;
    });

    // Build edges in the simple {source, target} format
    const edges = (body.edges || []).map(e => ({
      source: e.source,
      target: e.target,
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
      ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
    }));

    return {
      name: body.name,
      description: body.description || "",
      nodes,
      edges,
      variables: body.variables || {},
      _configs: configs, // Preserve original configs for round-trip to editor
    };
  }

  /** Map frontend config keys to engine config structure. */
  function mapConfigToEngine(type, cfg) {
    switch (type) {
      case "llm":
        return {
          model: cfg.model || "gpt-4o",
          systemPrompt: cfg.systemPrompt || "",
          prompt: cfg.prompt || "",
          temperature: cfg.temperature ?? 0.7,
          maxTokens: cfg.maxTokens || 4096,
          provider: cfg.provider || "openai",
        };
      case "tool":
        return {
          tool: cfg.toolName || cfg.tool || "",
          toolInput: typeof cfg.parameters === "string" ? safeParseJSON(cfg.parameters) : (cfg.parameters || cfg.toolInput || {}),
          retryOnFail: cfg.retryOnFail || false,
        };
      case "condition":
        return {
          expression: cfg.expression || "",
          trueLabel: cfg.trueLabel || "Yes",
          falseLabel: cfg.falseLabel || "No",
        };
      case "parallel":
        return {
          branches: [],
          waitForAll: cfg.waitForAll ?? true,
        };
      case "code":
        return {
          language: cfg.language || "python",
          code: cfg.code || "",
          timeoutMs: (cfg.timeout || 30) * 1000,
        };
      case "human_approval":
        return {
          message: cfg.message || "Please review and approve this step.",
          timeoutMs: (cfg.timeout || 3600) * 1000,
          requiredRole: cfg.approvers || "admin",
        };
      case "template":
        return {
          template: cfg.template || "",
          outputVar: cfg.outputVar || "text",
        };
      default:
        return cfg;
    }
  }

  function safeParseJSON(str) {
    try { return JSON.parse(str); } catch { return {}; }
  }

  // ---------------------------------------------------------------------------
  // Engine → Visual format (for editor reload)
  // ---------------------------------------------------------------------------

  function toVisualFormat(workflow) {
    if (!workflow) return workflow;

    // If it already has _configs, reconstruct visual nodes
    const configs = workflow._configs || {};
    const nodes = (workflow.nodes || []).map(n => {
      const visual = n._visual || {};
      const nodeType = n.type === "human_approval" ? "approval" : n.type;
      // Merge engine config back if no _configs entry
      if (!configs[n.id] && n.config) {
        configs[n.id] = mapConfigToVisual(n.type, n.config);
      }
      return {
        id: n.id,
        type: nodeType,
        position: visual.position || { x: 0, y: 0 },
        data: {
          label: visual.label || n.id,
          nodeType,
        },
      };
    });

    return {
      ...workflow,
      nodes,
      configs,
    };
  }

  /** Map engine config back to frontend config keys. */
  function mapConfigToVisual(type, cfg) {
    if (!cfg) return {};
    switch (type) {
      case "tool":
        return {
          toolName: cfg.tool || "",
          parameters: cfg.toolInput ? JSON.stringify(cfg.toolInput) : "{}",
          retryOnFail: cfg.retryOnFail || false,
        };
      case "code":
        return {
          language: cfg.language || "python",
          code: cfg.code || "",
          timeout: Math.round((cfg.timeoutMs || 30000) / 1000),
        };
      case "human_approval":
        return {
          message: cfg.message || "",
          timeout: Math.round((cfg.timeoutMs || 3600000) / 1000),
          approvers: cfg.requiredRole || "admin",
        };
      default:
        return cfg;
    }
  }

  // ---------------------------------------------------------------------------
  // Workflow CRUD
  // ---------------------------------------------------------------------------

  // POST /v1/workflows — Create workflow
  router.post("/", async (req, res) => {
    try {
      const body = parseBody(req, res);
      if (!body) return;

      const normalized = normalizeWorkflowBody(body);
      const { name, description, nodes, edges, variables } = normalized;

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
        _configs: normalized._configs,
      };

      // Validate before saving
      const validation = engine.validate({ ...workflow, id: "temp" });
      if (!validation.valid) {
        return res.status(400).json({ ok: false, errors: validation.errors });
      }

      const saved = await store.save(workflow);
      log("info", "workflow_created", { component: "workflow", workflowId: saved.id, name });
      res.status(201).json({ ok: true, workflow: saved, id: saved.id });
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

  // ---------------------------------------------------------------------------
  // Task status (async execution) — MUST be before /:id to avoid shadowing
  // ---------------------------------------------------------------------------

  // GET /v1/workflows/tasks — Queue stats (admin overview)
  router.get("/tasks", async (_req, res) => {
    res.json({ ok: true, stats: taskQueue.stats() });
  });

  // GET /v1/workflows/tasks/:taskId — Get task status
  router.get("/tasks/:taskId", async (req, res) => {
    const status = taskQueue.getStatus(req.params.taskId);
    if (!status) {
      return res.status(404).json({ ok: false, error: "Task not found" });
    }
    res.json({ ok: true, task: status });
  });

  // POST /v1/workflows/tasks/:taskId/cancel — Cancel task
  router.post("/tasks/:taskId/cancel", async (req, res) => {
    const cancelled = taskQueue.cancel(req.params.taskId);
    if (!cancelled) {
      return res.status(404).json({ ok: false, error: "Task not found or already completed" });
    }
    log("info", "task_cancelled_via_api", { component: "workflow", taskId: req.params.taskId });
    res.json({ ok: true, message: "Task cancelled" });
  });

  // GET /v1/workflows/:id — Get workflow detail
  // Returns visual format if ?format=visual (default for editor), or engine format with ?format=engine.
  router.get("/:id", async (req, res) => {
    try {
      const workflow = await store.load(req.params.id);
      if (!workflow) {
        return res.status(404).json({ ok: false, error: "Workflow not found" });
      }
      const fmt = req.query.format || "visual";
      const out = fmt === "visual" ? toVisualFormat(workflow) : workflow;
      res.json({ ok: true, workflow: out, ...out });
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

      const normalized = normalizeWorkflowBody(body);

      const updated = {
        ...existing,
        ...normalized,
        id: req.params.id, // Prevent id override
      };

      const validation = engine.validate(updated);
      if (!validation.valid) {
        return res.status(400).json({ ok: false, errors: validation.errors });
      }

      const saved = await store.save(updated);
      log("info", "workflow_updated", { component: "workflow", workflowId: saved.id });
      res.json({ ok: true, workflow: saved, id: saved.id });
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

      // Persist execution result so GET /executions/:execId can retrieve it
      await store.saveExecution({
        executionId: result.executionId,
        workflowId: workflow.id,
        workflow,
        context: { input: context.input, variables: context.variables, nodes: result.outputs ? Object.fromEntries(Object.entries(result.outputs).map(([k, v]) => [k, { output: v }])) : {} },
        trace: result.trace || [],
        status: result.status,
        createdAt: new Date().toISOString(),
        userId: context.userId,
      }).catch(e => log("warn", "workflow_execution_persist_failed", { component: "workflow", error: e.message }));

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

  // GET /v1/workflows/:id/executions/:execId — Get single execution status
  router.get("/:id/executions/:execId", async (req, res) => {
    try {
      const execution = await store.loadExecution(req.params.execId);
      if (!execution || execution.workflowId !== req.params.id) {
        return res.status(404).json({ ok: false, error: "Execution not found" });
      }

      // Build node statuses and logs from trace
      const nodeStatuses = {};
      const logs = [];
      if (Array.isArray(execution.trace)) {
        for (const entry of execution.trace) {
          nodeStatuses[entry.nodeId] = entry.status;
          logs.push({
            level: entry.status === "failed" ? "error" : (entry.status === "completed" ? "success" : "info"),
            message: `Node "${entry.nodeId}" (${entry.type}): ${entry.status}${entry.error ? " — " + entry.error : ""} [${entry.durationMs || 0}ms]`,
          });
        }
      }

      // Determine overall status
      const status = execution.pausedAtNode ? "waiting_approval" : (execution.status || "unknown");

      res.json({
        ok: true,
        executionId: execution.executionId,
        workflowId: execution.workflowId,
        status,
        nodeStatuses,
        logs,
        outputs: execution.context?.nodes ? Object.fromEntries(
          Object.entries(execution.context.nodes).map(([k, v]) => [k, v.output || {}])
        ) : {},
        pausedAtNode: execution.pausedAtNode || null,
        createdAt: execution.createdAt,
      });
    } catch (err) {
      log("error", "workflow_get_execution_failed", { component: "workflow", error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /v1/workflows/:id/executions/:execId/stop — Stop/cancel a running execution
  router.post("/:id/executions/:execId/stop", async (req, res) => {
    try {
      // Try to cancel if it's in the task queue (async mode)
      const cancelled = taskQueue.cancel(req.params.execId);

      // Also try to delete the paused execution state
      const deleted = await store.deleteExecution(req.params.execId);
      engine._pausedExecutions.delete(req.params.execId);

      if (cancelled || deleted) {
        log("info", "workflow_execution_stopped", {
          component: "workflow",
          workflowId: req.params.id,
          executionId: req.params.execId,
        });
        return res.json({ ok: true, message: "Execution stopped" });
      }
      res.status(404).json({ ok: false, error: "Execution not found or already completed" });
    } catch (err) {
      log("error", "workflow_stop_failed", { component: "workflow", error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createWorkflowRouter };
