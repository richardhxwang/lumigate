"use strict";

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Task states
// ---------------------------------------------------------------------------

const TASK_STATES = {
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

// ---------------------------------------------------------------------------
// TaskQueue — In-memory async task queue with concurrency control
// ---------------------------------------------------------------------------

class TaskQueue {
  /**
   * @param {object} options
   * @param {number} options.concurrency - Max concurrent tasks (default: 3)
   * @param {number} options.defaultTimeoutMs - Default task timeout (default: 5 min)
   * @param {number} options.maxTimeoutMs - Maximum allowed timeout (default: 30 min)
   * @param {number} options.maxQueueSize - Maximum pending tasks (default: 100)
   * @param {function} options.log - Logging function (level, msg, ctx)
   */
  constructor({ concurrency = 3, defaultTimeoutMs = 300_000, maxTimeoutMs = 1_800_000, maxQueueSize = 100, pbStore, log } = {}) {
    this.concurrency = Math.max(1, Math.min(20, concurrency));
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxTimeoutMs = maxTimeoutMs;
    this.maxQueueSize = maxQueueSize;
    this._pbStore = pbStore || null;
    this.log = typeof log === "function" ? log : () => {};

    /** @type {Map<string, object>} All tasks by id */
    this._tasks = new Map();

    /** @type {Array<string>} Queued task ids, ordered by priority then enqueue time */
    this._queue = [];

    /** @type {Set<string>} Currently running task ids */
    this._running = new Set();

    /** @type {Map<string, AbortController>} Abort controllers for running tasks */
    this._abortControllers = new Map();

    /** @type {Map<string, NodeJS.Timeout>} Timeout handles for running tasks */
    this._timeoutHandles = new Map();

    // Process loop
    this._processing = false;
    this._drainResolvers = [];
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Enqueue a task for async processing.
   * @param {object} task
   * @param {string} [task.id] - Unique id (auto-generated if missing)
   * @param {string} task.type - Task type identifier
   * @param {object} task.payload - Task data
   * @param {number} [task.priority] - Priority (higher = sooner, default: 0)
   * @param {number} [task.timeoutMs] - Timeout in milliseconds
   * @param {function} [task.handler] - async (payload, { signal, progress }) => result
   * @returns {string} taskId
   */
  enqueue(task) {
    if (!task || typeof task !== "object") throw new Error("Task must be an object");
    if (typeof task.handler !== "function") throw new Error("Task must have a handler function");

    if (this._queue.length >= this.maxQueueSize) {
      throw new Error(`Queue is full (max ${this.maxQueueSize} pending tasks)`);
    }

    const taskId = task.id || `task_${crypto.randomUUID()}`;
    const timeoutMs = Math.min(task.timeoutMs || this.defaultTimeoutMs, this.maxTimeoutMs);

    const taskRecord = {
      id: taskId,
      type: task.type || "generic",
      payload: task.payload || {},
      priority: typeof task.priority === "number" ? task.priority : 0,
      timeoutMs,
      handler: task.handler,
      status: TASK_STATES.QUEUED,
      progress: 0,
      progressMessage: "",
      result: null,
      error: null,
      enqueuedAt: Date.now(),
      startedAt: null,
      completedAt: null,
    };

    this._tasks.set(taskId, taskRecord);
    this._insertSorted(taskId, taskRecord.priority);

    this.log("info", "task_enqueued", {
      component: "task-queue",
      taskId,
      type: taskRecord.type,
      priority: taskRecord.priority,
      queueLength: this._queue.length,
    });

    // Kick off processing
    this._scheduleProcess();

    return taskId;
  }

  /**
   * Get task status.
   * @param {string} taskId
   * @returns {object|null} { id, type, status, progress, progressMessage, result, error, timings }
   */
  getStatus(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) return null;

    return {
      id: task.id,
      type: task.type,
      status: task.status,
      progress: task.progress,
      progressMessage: task.progressMessage,
      result: task.status === TASK_STATES.COMPLETED ? task.result : null,
      error: task.status === TASK_STATES.FAILED ? task.error : null,
      enqueuedAt: task.enqueuedAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      durationMs: task.completedAt && task.startedAt ? task.completedAt - task.startedAt : null,
    };
  }

  /**
   * Cancel a queued or running task.
   * @param {string} taskId
   * @returns {boolean} Whether the task was cancelled.
   */
  cancel(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) return false;

    if (task.status === TASK_STATES.QUEUED) {
      task.status = TASK_STATES.CANCELLED;
      task.completedAt = Date.now();
      this._queue = this._queue.filter(id => id !== taskId);
      this.log("info", "task_cancelled", { component: "task-queue", taskId, was: "queued" });
      return true;
    }

    if (task.status === TASK_STATES.RUNNING) {
      const controller = this._abortControllers.get(taskId);
      if (controller) controller.abort();

      const timeout = this._timeoutHandles.get(taskId);
      if (timeout) clearTimeout(timeout);

      task.status = TASK_STATES.CANCELLED;
      task.completedAt = Date.now();
      this._running.delete(taskId);
      this._abortControllers.delete(taskId);
      this._timeoutHandles.delete(taskId);

      this.log("info", "task_cancelled", { component: "task-queue", taskId, was: "running" });
      this._scheduleProcess(); // Fill the concurrency slot
      return true;
    }

    return false; // Already completed/failed/cancelled
  }

  /**
   * Get queue statistics.
   */
  stats() {
    let queued = 0, running = 0, completed = 0, failed = 0, cancelled = 0;
    for (const task of this._tasks.values()) {
      switch (task.status) {
        case TASK_STATES.QUEUED: queued++; break;
        case TASK_STATES.RUNNING: running++; break;
        case TASK_STATES.COMPLETED: completed++; break;
        case TASK_STATES.FAILED: failed++; break;
        case TASK_STATES.CANCELLED: cancelled++; break;
      }
    }
    return { queued, running, completed, failed, cancelled, total: this._tasks.size };
  }

  /**
   * Returns a promise that resolves when the queue is fully drained (no queued or running tasks).
   * Useful for graceful shutdown.
   */
  drain() {
    if (this._queue.length === 0 && this._running.size === 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => this._drainResolvers.push(resolve));
  }

  /**
   * Purge completed/failed/cancelled tasks older than maxAgeMs.
   * @param {number} maxAgeMs - Max age in milliseconds (default: 1 hour)
   * @returns {number} Number of purged tasks
   */
  purge(maxAgeMs = 3_600_000) {
    const cutoff = Date.now() - maxAgeMs;
    let purged = 0;
    const terminal = new Set([TASK_STATES.COMPLETED, TASK_STATES.FAILED, TASK_STATES.CANCELLED]);

    for (const [id, task] of this._tasks) {
      if (terminal.has(task.status) && task.completedAt && task.completedAt < cutoff) {
        this._tasks.delete(id);
        purged++;
      }
    }
    return purged;
  }

  // -----------------------------------------------------------------------
  // Internal processing
  // -----------------------------------------------------------------------

  _scheduleProcess() {
    if (this._processing) return;
    // Use setImmediate so we don't block the current tick
    setImmediate(() => this._processLoop());
  }

  async _processLoop() {
    if (this._processing) return;
    this._processing = true;

    try {
      while (this._queue.length > 0 && this._running.size < this.concurrency) {
        const taskId = this._queue.shift();
        if (!taskId) break;

        const task = this._tasks.get(taskId);
        if (!task || task.status !== TASK_STATES.QUEUED) continue;

        // Start the task (don't await — run concurrently)
        this._runTask(task);
      }
    } finally {
      this._processing = false;
    }

    this._checkDrain();
  }

  async _runTask(task) {
    task.status = TASK_STATES.RUNNING;
    task.startedAt = Date.now();
    this._running.add(task.id);

    const controller = new AbortController();
    this._abortControllers.set(task.id, controller);

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, task.timeoutMs);
    this._timeoutHandles.set(task.id, timeoutHandle);

    const progress = (pct, message) => {
      if (task.status !== TASK_STATES.RUNNING) return;
      task.progress = Math.max(0, Math.min(100, typeof pct === "number" ? pct : 0));
      if (message) task.progressMessage = String(message);
    };

    this.log("info", "task_started", {
      component: "task-queue",
      taskId: task.id,
      type: task.type,
    });

    try {
      const result = await task.handler(task.payload, {
        signal: controller.signal,
        progress,
        taskId: task.id,
      });

      if (task.status === TASK_STATES.CANCELLED) return; // Cancelled during execution

      task.status = TASK_STATES.COMPLETED;
      task.result = result;
      task.progress = 100;
      task.completedAt = Date.now();

      this.log("info", "task_completed", {
        component: "task-queue",
        taskId: task.id,
        type: task.type,
        durationMs: task.completedAt - task.startedAt,
      });
    } catch (err) {
      if (task.status === TASK_STATES.CANCELLED) return;

      task.status = TASK_STATES.FAILED;
      task.error = controller.signal.aborted ? "Task timed out" : err.message;
      task.completedAt = Date.now();

      this.log("error", "task_failed", {
        component: "task-queue",
        taskId: task.id,
        type: task.type,
        error: task.error,
        durationMs: task.completedAt - task.startedAt,
      });
    } finally {
      clearTimeout(timeoutHandle);
      this._running.delete(task.id);
      this._abortControllers.delete(task.id);
      this._timeoutHandles.delete(task.id);

      // Free the handler reference to allow GC
      task.handler = null;

      // Sync final task state to PocketBase (fire-and-forget)
      if (this._pbStore) {
        this._pbStore.createAsync("async_tasks", {
          task_type: task.type,
          status: task.status,
          payload: task.payload,
          result: task.result,
          error: task.error || "",
          progress: task.progress,
          started_by: task.payload?.userId || task.payload?.started_by || "",
          duration_ms: task.completedAt && task.startedAt ? task.completedAt - task.startedAt : 0,
          priority: task.priority,
        });
      }

      // Process next
      this._scheduleProcess();
    }
  }

  _insertSorted(taskId, priority) {
    // Higher priority = earlier in queue. Equal priority = FIFO.
    let insertIdx = this._queue.length;
    for (let i = 0; i < this._queue.length; i++) {
      const existingTask = this._tasks.get(this._queue[i]);
      if (existingTask && existingTask.priority < priority) {
        insertIdx = i;
        break;
      }
    }
    this._queue.splice(insertIdx, 0, taskId);
  }

  _checkDrain() {
    if (this._queue.length === 0 && this._running.size === 0 && this._drainResolvers.length > 0) {
      for (const resolve of this._drainResolvers) resolve();
      this._drainResolvers = [];
    }
  }
}

module.exports = { TaskQueue, TASK_STATES };
