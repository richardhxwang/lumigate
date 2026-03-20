"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Atomic file helpers (project convention: *.tmp + rename)
// ---------------------------------------------------------------------------

async function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await fs.promises.rename(tmp, filePath);
}

async function safeRead(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// WorkflowStore — JSON file persistence for workflows and executions
// ---------------------------------------------------------------------------

class WorkflowStore {
  /**
   * @param {object} options
   * @param {string} options.dataDir - Base directory for workflow data (default: data/workflows)
   * @param {import('../pb-store').PBStore} [options.pbStore] - PocketBase store for persistence
   */
  constructor({ dataDir = "data/workflows", pbStore } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.workflowsDir = path.join(this.dataDir, "definitions");
    this.executionsDir = path.join(this.dataDir, "executions");
    this._pbStore = pbStore || null;

    // Ensure directories exist synchronously on startup
    fs.mkdirSync(this.workflowsDir, { recursive: true });
    fs.mkdirSync(this.executionsDir, { recursive: true });

    // In-memory index for fast listing (loaded lazily)
    this._index = null;
    this._indexDirty = false;
  }

  // -----------------------------------------------------------------------
  // Workflow CRUD
  // -----------------------------------------------------------------------

  /**
   * Save a workflow definition. Generates an id if missing.
   * @param {object} workflow
   * @returns {Promise<object>} The saved workflow (with id, timestamps).
   */
  async save(workflow) {
    if (!workflow || typeof workflow !== "object") {
      throw new Error("Workflow must be an object");
    }

    const now = new Date().toISOString();
    const existing = workflow.id ? await this.load(workflow.id) : null;

    const doc = {
      ...workflow,
      id: workflow.id || `wf_${crypto.randomUUID()}`,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    const filePath = path.join(this.workflowsDir, `${doc.id}.json`);
    await atomicWrite(filePath, doc);

    // Sync to PocketBase (async, non-blocking)
    if (this._pbStore) {
      const pbData = {
        name: doc.name || "",
        description: doc.description || "",
        nodes: doc.nodes || [],
        edges: doc.edges || [],
        variables: doc.variables || {},
        owner_id: doc.ownerId || doc.owner_id || "",
        org_id: doc.orgId || doc.org_id || "",
        status: doc.status || "draft",
        version: doc.version || "",
        published_channel: doc.publishedChannel || doc.published_channel || "",
      };
      if (existing && existing._pbId) {
        this._pbStore.updateAsync("workflows", existing._pbId, pbData);
      } else {
        this._pbStore.createAsync("workflows", { ...pbData, id: doc.id });
      }
    }

    // Update index
    await this._ensureIndex();
    this._index.set(doc.id, {
      id: doc.id,
      name: doc.name || "",
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      nodeCount: Array.isArray(doc.nodes) ? doc.nodes.length : 0,
    });
    this._indexDirty = true;
    await this._flushIndex();

    return doc;
  }

  /**
   * Load a workflow by id.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async load(id) {
    if (!id || typeof id !== "string") return null;
    const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "");

    // Try local file first (fast)
    const filePath = path.join(this.workflowsDir, `${sanitized}.json`);
    const local = await safeRead(filePath);
    if (local) return local;

    // Fallback: try PocketBase
    if (this._pbStore) {
      try {
        const record = await this._pbStore.findOne("workflows", `id='${sanitized}'`);
        if (record) return record;
      } catch {
        // PB unavailable — return null
      }
    }
    return null;
  }

  /**
   * List all workflows (summary only).
   * @returns {Promise<object[]>}
   */
  async list() {
    await this._ensureIndex();
    return Array.from(this._index.values())
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }

  /**
   * Delete a workflow by id.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async delete(id) {
    if (!id || typeof id !== "string") return false;
    const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "");
    const filePath = path.join(this.workflowsDir, `${sanitized}.json`);
    try {
      await fs.promises.unlink(filePath);
      await this._ensureIndex();
      this._index.delete(sanitized);
      this._indexDirty = true;
      await this._flushIndex();

      // Delete from PocketBase (async, non-blocking)
      if (this._pbStore) {
        this._pbStore.findOne("workflows", `id='${sanitized}'`).then((rec) => {
          if (rec) this._pbStore.delete("workflows", rec.id).catch(() => {});
        }).catch(() => {});
      }

      return true;
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Execution state (for paused / resumable workflows)
  // -----------------------------------------------------------------------

  /**
   * Save execution state.
   * @param {object} execution - Must have executionId field.
   * @returns {Promise<void>}
   */
  async saveExecution(execution) {
    if (!execution || !execution.executionId) {
      throw new Error("Execution must have executionId");
    }
    const sanitized = execution.executionId.replace(/[^a-zA-Z0-9_-]/g, "");
    const filePath = path.join(this.executionsDir, `${sanitized}.json`);
    const savedExec = {
      ...execution,
      savedAt: new Date().toISOString(),
    };
    await atomicWrite(filePath, savedExec);

    // Sync to PocketBase (async, non-blocking)
    if (this._pbStore) {
      const pbData = {
        workflow_id: execution.workflowId || "",
        status: execution.status || "running",
        input: execution.input || {},
        output: execution.output || {},
        context: execution.context || {},
        current_node: execution.currentNode || execution.pausedAtNode || "",
        trace: execution.trace || [],
        started_by: execution.userId || execution.started_by || "",
        duration_ms: execution.durationMs || execution.duration_ms || 0,
        error: execution.error || "",
      };
      this._pbStore.upsert(
        "workflow_executions",
        `workflow_id='${execution.workflowId || ""}' && id='${sanitized}'`,
        pbData,
      ).catch(() => {});
    }
  }

  /**
   * Load execution state by executionId.
   * @param {string} executionId
   * @returns {Promise<object|null>}
   */
  async loadExecution(executionId) {
    if (!executionId || typeof executionId !== "string") return null;
    const sanitized = executionId.replace(/[^a-zA-Z0-9_-]/g, "");
    const filePath = path.join(this.executionsDir, `${sanitized}.json`);
    return safeRead(filePath);
  }

  /**
   * List executions for a workflow.
   * @param {string} workflowId
   * @returns {Promise<object[]>}
   */
  async listExecutions(workflowId) {
    const results = [];
    try {
      const files = await fs.promises.readdir(this.executionsDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const data = await safeRead(path.join(this.executionsDir, file));
          if (data && data.workflowId === workflowId) {
            results.push({
              executionId: data.executionId,
              workflowId: data.workflowId,
              status: data.status || (data.pausedAtNode ? "waiting_approval" : "unknown"),
              pausedAtNode: data.pausedAtNode || null,
              createdAt: data.createdAt,
              savedAt: data.savedAt,
              userId: data.userId,
            });
          }
        } catch {
          // Skip malformed files
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return results.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  }

  /**
   * Delete execution state.
   * @param {string} executionId
   * @returns {Promise<boolean>}
   */
  async deleteExecution(executionId) {
    if (!executionId || typeof executionId !== "string") return false;
    const sanitized = executionId.replace(/[^a-zA-Z0-9_-]/g, "");
    const filePath = path.join(this.executionsDir, `${sanitized}.json`);
    try {
      await fs.promises.unlink(filePath);
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Index management
  // -----------------------------------------------------------------------

  async _ensureIndex() {
    if (this._index) return;
    this._index = new Map();

    try {
      const files = await fs.promises.readdir(this.workflowsDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const data = await safeRead(path.join(this.workflowsDir, file));
          if (data && data.id) {
            this._index.set(data.id, {
              id: data.id,
              name: data.name || "",
              createdAt: data.createdAt,
              updatedAt: data.updatedAt,
              nodeCount: Array.isArray(data.nodes) ? data.nodes.length : 0,
            });
          }
        } catch {
          // Skip malformed files
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  async _flushIndex() {
    if (!this._indexDirty || !this._index) return;
    // Index is rebuilt from files on startup, so flushing is optional.
    // We still write it for faster cold starts on large stores.
    const indexPath = path.join(this.dataDir, "_index.json");
    const entries = Array.from(this._index.values());
    await atomicWrite(indexPath, entries).catch(() => {});
    this._indexDirty = false;
  }
}

module.exports = { WorkflowStore };
