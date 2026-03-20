'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * TraceCollector — lightweight LangSmith-style trace collection.
 *
 * Storage layout:
 *   data/traces/YYYY-MM-DD/{traceId}.json   — full trace + spans
 *   data/traces/YYYY-MM-DD/index.json        — daily index for fast listing
 */
class TraceCollector {
  /**
   * @param {object} opts
   * @param {string}   opts.dataDir    — root dir for trace files
   * @param {number}   opts.maxTraces  — cap per-day index (soft, enforced on prune)
   * @param {function} opts.log        — log(level, msg, ctx)
   */
  constructor({ dataDir = 'data/traces', maxTraces = 10000, pbStore, log } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.maxTraces = maxTraces;
    this._pbStore = pbStore || null;
    this.log = log || (() => {});

    // In-memory cache of active (not yet ended) traces keyed by traceId
    this._active = new Map();

    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _dayDir(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    const day = d.toISOString().slice(0, 10); // YYYY-MM-DD
    const dir = path.join(this.dataDir, day);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return { dir, day };
  }

  _traceFile(traceId, day) {
    const dir = path.join(this.dataDir, day);
    return path.join(dir, `${traceId}.json`);
  }

  _indexFile(day) {
    return path.join(this.dataDir, day, 'index.json');
  }

  _readIndex(day) {
    const f = this._indexFile(day);
    try {
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {}
    return [];
  }

  _writeIndex(day, entries) {
    const f = this._indexFile(day);
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 0));
    fs.renameSync(tmp, f);
  }

  _persistTrace(trace) {
    const { dir, day } = this._dayDir(trace.startTime);
    const file = path.join(dir, `${trace.traceId}.json`);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(trace, null, 2));
    fs.renameSync(tmp, file);
    return day;
  }

  _upsertIndex(day, summary) {
    const entries = this._readIndex(day);
    const idx = entries.findIndex(e => e.traceId === summary.traceId);
    if (idx >= 0) entries[idx] = summary;
    else entries.push(summary);
    this._writeIndex(day, entries);
  }

  _makeSummary(trace) {
    return {
      traceId: trace.traceId,
      type: trace.type,
      userId: trace.userId || null,
      sessionId: trace.sessionId || null,
      status: trace.status,
      startTime: trace.startTime,
      endTime: trace.endTime || null,
      duration: trace.endTime ? trace.endTime - trace.startTime : null,
      spanCount: (trace.spans || []).length,
      totalTokens: this._sumTokens(trace),
      estimatedCost: this._estimateCost(trace),
      error: trace.error || null,
    };
  }

  _sumTokens(trace) {
    let total = 0;
    for (const s of (trace.spans || [])) {
      if (s.metadata && s.metadata.tokens) {
        const t = s.metadata.tokens;
        total += (t.prompt || 0) + (t.completion || 0);
      }
    }
    return total;
  }

  _estimateCost(trace) {
    // Very rough cost model (USD) — good enough for observability
    const COST_PER_1K = {
      'gpt-4o': 0.005, 'gpt-4.1': 0.005, 'gpt-4.1-mini': 0.0008, 'gpt-4.1-nano': 0.0002,
      'claude-sonnet-4-20250514': 0.006, 'claude-3-5-sonnet': 0.006,
      'gemini-2.5-pro': 0.005, 'gemini-2.5-flash': 0.0005,
      'deepseek-chat': 0.0003, 'deepseek-reasoner': 0.001,
      default: 0.002,
    };
    let cost = 0;
    for (const s of (trace.spans || [])) {
      if (s.type === 'llm_call' && s.metadata) {
        const tokens = (s.metadata.tokens?.prompt || 0) + (s.metadata.tokens?.completion || 0);
        const model = s.metadata.model || 'default';
        const rate = COST_PER_1K[model] || COST_PER_1K.default;
        cost += (tokens / 1000) * rate;
      }
    }
    return Math.round(cost * 100000) / 100000; // 5 decimal places, no sci notation
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start a new trace.
   * @returns {object} The trace object (also cached in _active)
   */
  startTrace({ traceId, type = 'chat', userId, sessionId, metadata } = {}) {
    const id = traceId || crypto.randomUUID();
    const trace = {
      traceId: id,
      type,
      userId: userId || null,
      sessionId: sessionId || null,
      status: 'running',
      startTime: Date.now(),
      endTime: null,
      metadata: metadata || {},
      spans: [],
      output: null,
      error: null,
      evaluations: [],
    };
    this._active.set(id, trace);

    // Persist immediately so it shows up in queries even if not yet ended
    try {
      const day = this._persistTrace(trace);
      this._upsertIndex(day, this._makeSummary(trace));
    } catch (e) {
      this.log('error', 'trace persist failed', { traceId: id, error: e.message });
    }

    // Sync to PocketBase (fire-and-forget)
    if (this._pbStore) {
      this._pbStore.createAsync('traces', {
        trace_id: id,
        type,
        user_id: trace.userId || '',
        session_id: trace.sessionId || '',
        status: 'running',
        duration_ms: 0,
        token_count: 0,
        cost_usd: 0,
        spans: [],
        metadata: trace.metadata || {},
        error: '',
      });
    }

    return trace;
  }

  /**
   * Add a span to an active or persisted trace.
   */
  addSpan(traceId, { spanId, parentSpanId, name, type, input, output, startTime, endTime, status, metadata } = {}) {
    const span = {
      spanId: spanId || crypto.randomUUID(),
      parentSpanId: parentSpanId || null,
      name: name || 'unnamed',
      type: type || 'llm_call',
      input: input !== undefined ? input : null,
      output: output !== undefined ? output : null,
      startTime: startTime || Date.now(),
      endTime: endTime || null,
      duration: (endTime && startTime) ? endTime - startTime : null,
      status: status || 'ok',
      metadata: metadata || {},
    };

    // Try active cache first
    let trace = this._active.get(traceId);
    if (!trace) {
      // Load from disk
      trace = this._loadTrace(traceId);
    }
    if (!trace) {
      this.log('warn', 'addSpan: trace not found', { traceId });
      return null;
    }

    trace.spans.push(span);

    // Re-persist
    try {
      const day = this._persistTrace(trace);
      this._upsertIndex(day, this._makeSummary(trace));
      if (this._active.has(traceId)) this._active.set(traceId, trace);
    } catch (e) {
      this.log('error', 'span persist failed', { traceId, error: e.message });
    }

    return span;
  }

  /**
   * End a trace — mark status, persist final state, remove from active cache.
   */
  endTrace(traceId, { status = 'completed', output, error } = {}) {
    let trace = this._active.get(traceId);
    if (!trace) trace = this._loadTrace(traceId);
    if (!trace) {
      this.log('warn', 'endTrace: trace not found', { traceId });
      return null;
    }

    trace.status = status;
    trace.endTime = Date.now();
    if (output !== undefined) trace.output = output;
    if (error !== undefined) trace.error = error;

    try {
      const day = this._persistTrace(trace);
      this._upsertIndex(day, this._makeSummary(trace));
    } catch (e) {
      this.log('error', 'endTrace persist failed', { traceId, error: e.message });
    }

    // Update PocketBase record with final state (fire-and-forget)
    if (this._pbStore) {
      const summary = this._makeSummary(trace);
      this._pbStore.findOne('traces', `trace_id='${traceId}'`).then((rec) => {
        if (rec) {
          this._pbStore.updateAsync('traces', rec.id, {
            status: trace.status,
            duration_ms: summary.duration || 0,
            token_count: summary.totalTokens || 0,
            cost_usd: summary.estimatedCost || 0,
            spans: trace.spans || [],
            error: trace.error || '',
          });
        }
      }).catch(() => {});
    }

    this._active.delete(traceId);
    return trace;
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  _loadTrace(traceId) {
    // Search recent days (up to 30)
    const now = new Date();
    for (let i = 0; i < 30; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const day = d.toISOString().slice(0, 10);
      const file = this._traceFile(traceId, day);
      try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {}
    }
    return null;
  }

  /**
   * List traces with optional filters.
   */
  async listTraces({ userId, type, status, from, to, limit = 50, offset = 0 } = {}) {
    const results = [];
    const fromDate = from ? new Date(from) : new Date(Date.now() - 7 * 86400000);
    const toDate = to ? new Date(to) : new Date();

    // Iterate days in reverse (newest first)
    const d = new Date(toDate);
    while (d >= fromDate) {
      const day = d.toISOString().slice(0, 10);
      const entries = this._readIndex(day);

      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (userId && e.userId !== userId) continue;
        if (type && e.type !== type) continue;
        if (status && e.status !== status) continue;
        results.push(e);
      }
      d.setDate(d.getDate() - 1);
    }

    // Sort by startTime descending
    results.sort((a, b) => b.startTime - a.startTime);

    return {
      total: results.length,
      items: results.slice(offset, offset + limit),
      limit,
      offset,
    };
  }

  /**
   * Get full trace with all spans.
   */
  async getTrace(traceId) {
    // Check active cache
    if (this._active.has(traceId)) return this._active.get(traceId);
    return this._loadTrace(traceId);
  }

  /**
   * Delete a trace.
   */
  async deleteTrace(traceId) {
    this._active.delete(traceId);
    const now = new Date();
    for (let i = 0; i < 90; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const day = d.toISOString().slice(0, 10);
      const file = this._traceFile(traceId, day);
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
          // Remove from index
          const entries = this._readIndex(day).filter(e => e.traceId !== traceId);
          this._writeIndex(day, entries);
          return true;
        }
      } catch {}
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Analytics
  // ---------------------------------------------------------------------------

  /**
   * Aggregate stats over a time range.
   */
  async getStats({ from, to, groupBy = 'day' } = {}) {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 7 * 86400000);
    const toDate = to ? new Date(to) : new Date();

    let totalTraces = 0;
    let totalDuration = 0;
    let durationCount = 0;
    let successCount = 0;
    let errorCount = 0;
    let totalTokens = 0;
    let totalCost = 0;
    const byProvider = {};
    const byTool = {};
    const byDay = {};

    const d = new Date(toDate);
    while (d >= fromDate) {
      const day = d.toISOString().slice(0, 10);
      const entries = this._readIndex(day);

      if (!byDay[day]) byDay[day] = { traces: 0, tokens: 0, cost: 0, errors: 0, avgDuration: 0, _durSum: 0, _durCount: 0 };

      for (const e of entries) {
        totalTraces++;
        byDay[day].traces++;
        byDay[day].tokens += e.totalTokens || 0;
        byDay[day].cost += e.estimatedCost || 0;

        totalTokens += e.totalTokens || 0;
        totalCost += e.estimatedCost || 0;

        if (e.duration != null) {
          totalDuration += e.duration;
          durationCount++;
          byDay[day]._durSum += e.duration;
          byDay[day]._durCount++;
        }

        if (e.status === 'completed') successCount++;
        else if (e.status === 'error') { errorCount++; byDay[day].errors++; }

        // For provider/tool breakdown, load full trace (only if small dataset)
        if (totalTraces <= 5000) {
          try {
            const trace = JSON.parse(fs.readFileSync(this._traceFile(e.traceId, day), 'utf8'));
            for (const s of (trace.spans || [])) {
              if (s.type === 'llm_call' && s.metadata?.provider) {
                const p = s.metadata.provider;
                if (!byProvider[p]) byProvider[p] = { calls: 0, tokens: 0, avgLatency: 0, _latSum: 0, _latCount: 0 };
                byProvider[p].calls++;
                byProvider[p].tokens += (s.metadata.tokens?.prompt || 0) + (s.metadata.tokens?.completion || 0);
                if (s.duration) { byProvider[p]._latSum += s.duration; byProvider[p]._latCount++; }
              }
              if (s.type === 'tool_exec') {
                const t = s.name || 'unknown';
                if (!byTool[t]) byTool[t] = { calls: 0, avgDuration: 0, errors: 0, _durSum: 0, _durCount: 0 };
                byTool[t].calls++;
                if (s.status === 'error') byTool[t].errors++;
                if (s.duration) { byTool[t]._durSum += s.duration; byTool[t]._durCount++; }
              }
            }
          } catch {}
        }
      }
      d.setDate(d.getDate() - 1);
    }

    // Compute averages
    for (const day of Object.keys(byDay)) {
      const bd = byDay[day];
      bd.avgDuration = bd._durCount ? Math.round(bd._durSum / bd._durCount) : 0;
      delete bd._durSum; delete bd._durCount;
    }
    for (const p of Object.keys(byProvider)) {
      const bp = byProvider[p];
      bp.avgLatency = bp._latCount ? Math.round(bp._latSum / bp._latCount) : 0;
      delete bp._latSum; delete bp._latCount;
    }
    for (const t of Object.keys(byTool)) {
      const bt = byTool[t];
      bt.avgDuration = bt._durCount ? Math.round(bt._durSum / bt._durCount) : 0;
      delete bt._durSum; delete bt._durCount;
    }

    return {
      totalTraces,
      avgDuration: durationCount ? Math.round(totalDuration / durationCount) : 0,
      successRate: totalTraces ? Math.round((successCount / totalTraces) * 10000) / 100 : 0,
      errorRate: totalTraces ? Math.round((errorCount / totalTraces) * 10000) / 100 : 0,
      tokenUsage: totalTokens,
      costEstimate: Math.round(totalCost * 100000) / 100000,
      byProvider,
      byTool,
      byDay,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Remove traces older than maxAge ms (default 30 days).
   */
  async prune(maxAge = 30 * 24 * 60 * 60 * 1000) {
    const cutoff = new Date(Date.now() - maxAge);
    let removed = 0;

    try {
      const dirs = fs.readdirSync(this.dataDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
      for (const day of dirs) {
        if (new Date(day + 'T23:59:59Z') < cutoff) {
          const dirPath = path.join(this.dataDir, day);
          fs.rmSync(dirPath, { recursive: true, force: true });
          removed++;
        }
      }
    } catch (e) {
      this.log('error', 'trace prune failed', { error: e.message });
    }

    this.log('info', 'trace prune complete', { daysRemoved: removed });
    return { daysRemoved: removed };
  }

  /**
   * List available days (for calendar UI).
   */
  async listDays() {
    try {
      return fs.readdirSync(this.dataDir)
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }
}

module.exports = { TraceCollector };
