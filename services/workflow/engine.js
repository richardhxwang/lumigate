"use strict";

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a dotted path like "nodes.search.output.results[0].title" from obj.
 * Supports bracket notation for array indices.
 */
function resolvePath(obj, path) {
  if (!path || typeof path !== "string") return undefined;
  // Normalize bracket access: foo[0].bar → foo.0.bar
  const normalized = path.replace(/\[(\d+)\]/g, ".$1");
  const parts = normalized.split(".");
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Replace all {{expression}} placeholders in a string with values from context.
 * Expressions can reference: input.*, variables.*, nodes.<id>.output.*
 */
function interpolate(template, context) {
  if (typeof template !== "string") return template;
  return template.replace(/\{\{([\w\.\[\]]+)\}\}/g, (_match, expr) => {
    const val = resolvePath(context, expr);
    if (val === undefined) return "";
    if (typeof val === "object") return JSON.stringify(val);
    return String(val);
  });
}

/**
 * Resolve an inputs map: { varName: "{{expr}}" } → { varName: resolvedValue }
 */
function resolveInputs(inputs, context) {
  if (!inputs || typeof inputs !== "object") return {};
  const resolved = {};
  for (const [key, expr] of Object.entries(inputs)) {
    if (typeof expr === "string" && expr.includes("{{")) {
      // If the entire value is a single expression, preserve the original type
      const singleMatch = expr.match(/^\{\{([\w\.\[\]]+)\}\}$/);
      if (singleMatch) {
        const val = resolvePath(context, singleMatch[1]);
        resolved[key] = val !== undefined ? val : null;
      } else {
        resolved[key] = interpolate(expr, context);
      }
    } else {
      resolved[key] = expr;
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Condition evaluator (safe subset)
// ---------------------------------------------------------------------------

/**
 * Evaluate a simple condition expression against context.
 * Supports: ==, !=, >, <, >=, <=, includes, !includes, truthy, falsy
 * Format: "{{expr}} operator value" or "{{expr}}" (truthy check)
 */
function evaluateCondition(expression, context) {
  if (typeof expression !== "string") return false;

  const resolved = interpolate(expression, context);

  // Boolean-like check
  if (resolved === "true" || resolved === "1") return true;
  if (resolved === "false" || resolved === "0" || resolved === "" || resolved === "null" || resolved === "undefined") return false;

  // Operator-based: "left op right"
  const opMatch = expression.match(/^(.+?)\s+(==|!=|>=|<=|>|<|includes|!includes)\s+(.+)$/);
  if (opMatch) {
    const left = interpolate(opMatch[1].trim(), context);
    const op = opMatch[2];
    const right = interpolate(opMatch[3].trim(), context);

    const numL = Number(left);
    const numR = Number(right);
    const bothNum = !isNaN(numL) && !isNaN(numR) && left !== "" && right !== "";

    switch (op) {
      case "==": return bothNum ? numL === numR : left === right;
      case "!=": return bothNum ? numL !== numR : left !== right;
      case ">": return bothNum && numL > numR;
      case "<": return bothNum && numL < numR;
      case ">=": return bothNum && numL >= numR;
      case "<=": return bothNum && numL <= numR;
      case "includes": return String(left).includes(right);
      case "!includes": return !String(left).includes(right);
      default: return false;
    }
  }

  // Default: truthy check on resolved string
  return resolved !== "" && resolved !== "null" && resolved !== "undefined" && resolved !== "false";
}

// ---------------------------------------------------------------------------
// DAG builder & cycle detection
// ---------------------------------------------------------------------------

function buildAdjacencyMap(workflow) {
  const adj = new Map();
  for (const node of workflow.nodes) {
    adj.set(node.id, []);
  }

  // From explicit edges array
  if (Array.isArray(workflow.edges)) {
    for (const edge of workflow.edges) {
      const list = adj.get(edge.source);
      if (list && adj.has(edge.target)) {
        list.push(edge.target);
      }
    }
  }

  // From node.next / node.branches (inline definition)
  for (const node of workflow.nodes) {
    const list = adj.get(node.id);
    if (Array.isArray(node.next)) {
      for (const nid of node.next) {
        if (adj.has(nid) && !list.includes(nid)) list.push(nid);
      }
    }
    if (node.branches) {
      for (const branch of node.branches.conditions || []) {
        if (branch.next && adj.has(branch.next) && !list.includes(branch.next)) {
          list.push(branch.next);
        }
      }
      if (node.branches.default && adj.has(node.branches.default) && !list.includes(node.branches.default)) {
        list.push(node.branches.default);
      }
    }
  }

  return adj;
}

function detectCycle(adj) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const id of adj.keys()) color.set(id, WHITE);

  function dfs(u) {
    color.set(u, GRAY);
    for (const v of adj.get(u) || []) {
      if (color.get(v) === GRAY) return true; // back edge → cycle
      if (color.get(v) === WHITE && dfs(v)) return true;
    }
    color.set(u, BLACK);
    return false;
  }

  for (const id of adj.keys()) {
    if (color.get(id) === WHITE && dfs(id)) return true;
  }
  return false;
}

/**
 * Topological sort (Kahn's algorithm). Returns ordered node IDs.
 * Throws if cycle detected.
 */
function topologicalSort(adj) {
  const inDegree = new Map();
  for (const id of adj.keys()) inDegree.set(id, 0);
  for (const [, neighbors] of adj) {
    for (const n of neighbors) {
      inDegree.set(n, (inDegree.get(n) || 0) + 1);
    }
  }

  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order = [];
  while (queue.length > 0) {
    const u = queue.shift();
    order.push(u);
    for (const v of adj.get(u) || []) {
      const newDeg = inDegree.get(v) - 1;
      inDegree.set(v, newDeg);
      if (newDeg === 0) queue.push(v);
    }
  }

  if (order.length !== adj.size) {
    throw new Error("Workflow contains a cycle — not a valid DAG");
  }
  return order;
}

// ---------------------------------------------------------------------------
// WorkflowEngine
// ---------------------------------------------------------------------------

class WorkflowEngine {
  /**
   * @param {object} options
   * @param {object} options.lumigentRuntime - LumigentRuntime instance (for LLM calls)
   * @param {object} options.unifiedRegistry - UnifiedRegistry (for tool execution)
   * @param {function} options.log - Logging function (level, msg, ctx)
   * @param {function} [options.codeRunner] - async (language, code, timeout) => { stdout, stderr, exitCode }
   */
  constructor({ lumigentRuntime, unifiedRegistry, log, codeRunner } = {}) {
    this.lumigentRuntime = lumigentRuntime || null;
    this.unifiedRegistry = unifiedRegistry || null;
    this.log = typeof log === "function" ? log : () => {};
    this.codeRunner = typeof codeRunner === "function" ? codeRunner : null;

    // In-memory store for paused executions (override with external store via setStore)
    this._pausedExecutions = new Map();
    this._store = null;
  }

  /** Attach an external WorkflowStore for persistence. */
  setStore(store) {
    this._store = store;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Validate a workflow definition.
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate(workflow) {
    const errors = [];
    if (!workflow || typeof workflow !== "object") {
      return { valid: false, errors: ["Workflow must be an object"] };
    }
    if (!workflow.id) errors.push("Workflow missing id");
    if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
      errors.push("Workflow must have at least one node");
      return { valid: false, errors };
    }

    const nodeIds = new Set();
    const validTypes = new Set(["llm", "tool", "condition", "parallel", "human_approval", "code", "template"]);

    for (const node of workflow.nodes) {
      if (!node.id) { errors.push("Node missing id"); continue; }
      if (nodeIds.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
      nodeIds.add(node.id);
      if (!validTypes.has(node.type)) errors.push(`Node ${node.id}: invalid type "${node.type}"`);
    }

    // Check edge references
    if (Array.isArray(workflow.edges)) {
      for (const edge of workflow.edges) {
        if (!nodeIds.has(edge.source)) errors.push(`Edge source "${edge.source}" not found`);
        if (!nodeIds.has(edge.target)) errors.push(`Edge target "${edge.target}" not found`);
      }
    }

    // Check DAG
    if (errors.length === 0) {
      const adj = buildAdjacencyMap(workflow);
      if (detectCycle(adj)) errors.push("Workflow contains a cycle");
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Execute a complete workflow.
   * @param {object} workflow - { id, name, nodes, edges, variables }
   * @param {object} context - { userId, sessionId, input, ... }
   * @returns {Promise<{ outputs: object, trace: object[], status: string, executionId: string }>}
   */
  async execute(workflow, context = {}) {
    const validation = this.validate(workflow);
    if (!validation.valid) {
      throw new Error(`Invalid workflow: ${validation.errors.join("; ")}`);
    }

    const executionId = `exec_${crypto.randomUUID()}`;
    const startTime = Date.now();

    const execContext = {
      input: context.input || {},
      variables: { ...(workflow.variables || {}), ...(context.variables || {}) },
      nodes: {},
    };

    const trace = [];
    const nodeMap = new Map(workflow.nodes.map(n => [n.id, n]));
    const adj = buildAdjacencyMap(workflow);
    const order = topologicalSort(adj);

    this.log("info", "workflow_execute_start", {
      component: "workflow",
      workflowId: workflow.id,
      executionId,
      nodeCount: workflow.nodes.length,
    });

    let status = "completed";
    let pausedAtNode = null;

    for (const nodeId of order) {
      const node = nodeMap.get(nodeId);
      if (!node) continue;

      const nodeStart = Date.now();
      let nodeResult;

      try {
        nodeResult = await this._executeNode(node, execContext, { executionId, workflowId: workflow.id });
      } catch (err) {
        const traceEntry = {
          nodeId,
          type: node.type,
          status: "failed",
          error: err.message,
          durationMs: Date.now() - nodeStart,
        };
        trace.push(traceEntry);

        this.log("error", "workflow_node_failed", {
          component: "workflow",
          executionId,
          nodeId,
          error: err.message,
        });

        status = "failed";
        break;
      }

      // Handle human_approval pause
      if (nodeResult && nodeResult.__paused) {
        status = "waiting_approval";
        pausedAtNode = nodeId;

        const traceEntry = {
          nodeId,
          type: node.type,
          status: "paused",
          durationMs: Date.now() - nodeStart,
        };
        trace.push(traceEntry);

        // Persist execution state for later resume
        const executionState = {
          executionId,
          workflowId: workflow.id,
          workflow,
          context: execContext,
          trace,
          order,
          pausedAtNode: nodeId,
          pausedAtIndex: order.indexOf(nodeId),
          createdAt: new Date().toISOString(),
          userId: context.userId,
        };

        this._pausedExecutions.set(executionId, executionState);
        if (this._store) {
          await this._store.saveExecution(executionState).catch(e => {
            this.log("warn", "workflow_execution_persist_failed", {
              component: "workflow", executionId, error: e.message,
            });
          });
        }

        this.log("info", "workflow_paused", {
          component: "workflow", executionId, nodeId,
        });

        break;
      }

      // Store node output
      execContext.nodes[nodeId] = { output: nodeResult || {} };

      trace.push({
        nodeId,
        type: node.type,
        status: "completed",
        durationMs: Date.now() - nodeStart,
        outputKeys: nodeResult ? Object.keys(nodeResult) : [],
      });

      // Handle condition branching — skip nodes not in the chosen branch
      if (node.type === "condition" && nodeResult && nodeResult.__branch) {
        // The __branch value indicates which next node to follow;
        // other branches are effectively skipped by not being in the topo order
        // (they will still be in the order but will be no-ops if not reachable)
        execContext.nodes[nodeId].output = {
          branch: nodeResult.__branch,
          ...(nodeResult.data || {}),
        };
      }
    }

    const result = {
      executionId,
      workflowId: workflow.id,
      status,
      outputs: this._collectOutputs(execContext),
      trace,
      durationMs: Date.now() - startTime,
    };

    if (pausedAtNode) {
      result.pausedAtNode = pausedAtNode;
    }

    this.log("info", "workflow_execute_end", {
      component: "workflow",
      executionId,
      status,
      durationMs: result.durationMs,
    });

    return result;
  }

  /**
   * Resume a paused workflow (after human approval).
   * @param {string} executionId
   * @param {object} approvalData - { approved: boolean, comment?: string, data?: object }
   * @returns {Promise<object>} Same shape as execute() result.
   */
  async resume(executionId, approvalData = {}) {
    let state = this._pausedExecutions.get(executionId);
    if (!state && this._store) {
      state = await this._store.loadExecution(executionId);
    }
    if (!state) {
      throw new Error(`Execution ${executionId} not found or not paused`);
    }

    const { workflow, context: execContext, trace, order, pausedAtIndex, pausedAtNode } = state;
    const nodeMap = new Map(workflow.nodes.map(n => [n.id, n]));

    // Record the approval in the paused node's output
    execContext.nodes[pausedAtNode] = {
      output: {
        approved: !!approvalData.approved,
        comment: approvalData.comment || "",
        ...(approvalData.data || {}),
      },
    };

    trace.push({
      nodeId: pausedAtNode,
      type: "human_approval",
      status: approvalData.approved ? "approved" : "rejected",
      durationMs: 0,
    });

    if (!approvalData.approved) {
      this._pausedExecutions.delete(executionId);
      return {
        executionId,
        workflowId: workflow.id,
        status: "rejected",
        outputs: this._collectOutputs(execContext),
        trace,
        durationMs: Date.now() - new Date(state.createdAt).getTime(),
      };
    }

    // Continue from the node after the paused one
    let status = "completed";
    const startTime = Date.now();

    for (let i = pausedAtIndex + 1; i < order.length; i++) {
      const nodeId = order[i];
      const node = nodeMap.get(nodeId);
      if (!node) continue;

      const nodeStart = Date.now();
      let nodeResult;

      try {
        nodeResult = await this._executeNode(node, execContext, { executionId, workflowId: workflow.id });
      } catch (err) {
        trace.push({
          nodeId, type: node.type, status: "failed",
          error: err.message, durationMs: Date.now() - nodeStart,
        });
        status = "failed";
        break;
      }

      if (nodeResult && nodeResult.__paused) {
        status = "waiting_approval";
        state.pausedAtNode = nodeId;
        state.pausedAtIndex = i;
        state.trace = trace;

        if (this._store) {
          await this._store.saveExecution(state).catch(() => {});
        }

        trace.push({ nodeId, type: node.type, status: "paused", durationMs: Date.now() - nodeStart });
        break;
      }

      execContext.nodes[nodeId] = { output: nodeResult || {} };
      trace.push({
        nodeId, type: node.type, status: "completed",
        durationMs: Date.now() - nodeStart,
        outputKeys: nodeResult ? Object.keys(nodeResult) : [],
      });
    }

    if (status === "completed" || status === "failed") {
      this._pausedExecutions.delete(executionId);
    }

    return {
      executionId,
      workflowId: workflow.id,
      status,
      outputs: this._collectOutputs(execContext),
      trace,
      durationMs: Date.now() - startTime,
    };
  }

  // -----------------------------------------------------------------------
  // Node execution dispatchers
  // -----------------------------------------------------------------------

  async _executeNode(node, execContext, meta) {
    const resolvedInputs = resolveInputs(node.inputs, execContext);

    switch (node.type) {
      case "llm": return this._executeLlm(node, resolvedInputs, execContext, meta);
      case "tool": return this._executeTool(node, resolvedInputs, execContext, meta);
      case "condition": return this._executeCondition(node, resolvedInputs, execContext);
      case "parallel": return this._executeParallel(node, resolvedInputs, execContext, meta);
      case "human_approval": return this._executeHumanApproval(node, resolvedInputs, execContext);
      case "code": return this._executeCode(node, resolvedInputs, execContext, meta);
      case "template": return this._executeTemplate(node, resolvedInputs, execContext);
      default: throw new Error(`Unknown node type: ${node.type}`);
    }
  }

  /** LLM node: call AI with a prompt template. */
  async _executeLlm(node, inputs, execContext, meta) {
    if (!this.lumigentRuntime) {
      throw new Error("LLM node requires lumigentRuntime");
    }

    const prompt = interpolate(node.config?.prompt || inputs.prompt || "", execContext);
    const model = node.config?.model || inputs.model || "gpt-4o";
    const provider = node.config?.provider || inputs.provider || "openai";
    const systemPrompt = interpolate(node.config?.systemPrompt || inputs.systemPrompt || "", execContext);
    const temperature = node.config?.temperature ?? inputs.temperature ?? 0.7;
    const maxTokens = node.config?.maxTokens || inputs.maxTokens || 4096;

    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });

    // Use internal fetch to the chat endpoint for maximum compatibility
    const baseUrl = `http://127.0.0.1:${process.env.PORT || 9471}`;
    const resp = await fetch(`${baseUrl}/v1/${provider}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Project-Key": process.env.INTERNAL_CHAT_KEY || "",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(node.config?.timeoutMs || 120_000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`LLM call failed (${resp.status}): ${errText.slice(0, 500)}`);
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || "";
    const usage = data.usage || {};

    return { text, model, provider, usage };
  }

  /** Tool node: execute via UnifiedRegistry. */
  async _executeTool(node, inputs, _execContext, _meta) {
    if (!this.unifiedRegistry) {
      throw new Error("Tool node requires unifiedRegistry");
    }

    const toolName = node.config?.tool || inputs.tool;
    if (!toolName) throw new Error(`Tool node ${node.id} missing tool name`);

    const toolInput = { ...(node.config?.toolInput || {}), ...inputs };
    delete toolInput.tool; // Don't pass the tool name as an input param

    const result = await this.unifiedRegistry.executeToolCall(toolName, toolInput);
    return { result, tool: toolName };
  }

  /** Condition node: evaluate expression, return branch indicator. */
  _executeCondition(node, _inputs, execContext) {
    if (!node.branches || !Array.isArray(node.branches.conditions)) {
      throw new Error(`Condition node ${node.id} missing branches.conditions`);
    }

    for (const branch of node.branches.conditions) {
      if (evaluateCondition(branch.expression, execContext)) {
        return { __branch: branch.next, matched: branch.expression };
      }
    }

    return { __branch: node.branches.default || null, matched: "default" };
  }

  /** Parallel node: execute sub-branches concurrently. */
  async _executeParallel(node, _inputs, execContext, meta) {
    const branches = node.config?.branches;
    if (!Array.isArray(branches) || branches.length === 0) {
      throw new Error(`Parallel node ${node.id} missing config.branches`);
    }

    const timeoutMs = node.config?.timeoutMs || 300_000; // 5 min default

    const results = await Promise.all(
      branches.map(async (branch, idx) => {
        const branchId = branch.id || `${node.id}_branch_${idx}`;
        try {
          const result = await Promise.race([
            this._executeNode(branch, execContext, meta),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Branch ${branchId} timed out`)), timeoutMs)
            ),
          ]);
          return { branchId, status: "completed", output: result };
        } catch (err) {
          return { branchId, status: "failed", error: err.message };
        }
      })
    );

    // Merge outputs
    const merged = {};
    for (const r of results) {
      merged[r.branchId] = r.status === "completed" ? r.output : { error: r.error };
    }

    return { branches: merged, completedCount: results.filter(r => r.status === "completed").length };
  }

  /** Human approval node: pause execution. */
  _executeHumanApproval(node, inputs, _execContext) {
    return {
      __paused: true,
      message: node.config?.message || inputs.message || "Awaiting human approval",
      nodeId: node.id,
      requiredRole: node.config?.requiredRole || "admin",
    };
  }

  /** Code node: execute sandboxed code. */
  async _executeCode(node, inputs, execContext, _meta) {
    const language = node.config?.language || inputs.language || "javascript";
    const codeTemplate = node.config?.code || inputs.code || "";
    const code = interpolate(codeTemplate, execContext);
    const timeoutMs = Math.min(node.config?.timeoutMs || 30_000, 60_000);

    if (!code.trim()) throw new Error(`Code node ${node.id}: empty code`);

    if (this.codeRunner) {
      return this.codeRunner(language, code, timeoutMs);
    }

    // Fallback: call the /platform/code/run endpoint
    const baseUrl = `http://127.0.0.1:${process.env.PORT || 9471}`;
    const resp = await fetch(`${baseUrl}/platform/code/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Project-Key": process.env.INTERNAL_CHAT_KEY || "",
      },
      body: JSON.stringify({ language, code, timeout: timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Code execution failed (${resp.status}): ${errText.slice(0, 500)}`);
    }

    return resp.json();
  }

  /** Template node: string interpolation. */
  _executeTemplate(node, inputs, execContext) {
    const template = node.config?.template || inputs.template || "";
    const text = interpolate(template, execContext);
    return { text };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Collect final outputs from the last executed nodes. */
  _collectOutputs(execContext) {
    const outputs = {};
    for (const [nodeId, nodeData] of Object.entries(execContext.nodes)) {
      if (nodeData.output) {
        outputs[nodeId] = nodeData.output;
      }
    }
    return outputs;
  }
}

module.exports = {
  WorkflowEngine,
  interpolate,
  resolveInputs,
  resolvePath,
  evaluateCondition,
  buildAdjacencyMap,
  topologicalSort,
  detectCycle,
};
