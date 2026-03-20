"use strict";

class LumigentTraceStore {
  constructor(options = {}) {
    this.limit = Math.max(10, Number(options.limit) || 200);
    this.items = [];
    this._onTrace = typeof options.onTrace === "function" ? options.onTrace : null;
  }

  add(entry) {
    const item = {
      id: entry.id || `lgt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: entry.ts || new Date().toISOString(),
      ...entry,
    };
    this.items.push(item);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    if (this._onTrace) {
      try { this._onTrace(item); } catch {}
    }
    return item;
  }

  list(limit = 50) {
    const n = Math.max(1, Number(limit) || 50);
    return this.items.slice(-n).reverse();
  }
}

module.exports = { LumigentTraceStore };
