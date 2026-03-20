"use strict";

/**
 * services/knowledge/vector-store.js — Qdrant vector database client wrapper.
 *
 * Uses native fetch (Node 18+). No extra dependencies.
 * Qdrant REST API: https://qdrant.tech/documentation/
 */

const DEFAULT_QDRANT_URL = "http://localhost:6333";

class VectorStore {
  /**
   * @param {object} opts
   * @param {string} [opts.qdrantUrl]
   * @param {string} [opts.apiKey]  — Qdrant Cloud API key (optional for local)
   * @param {function} [opts.log]   — structured logger (level, msg, ctx)
   */
  constructor({ qdrantUrl, apiKey, log } = {}) {
    this.baseUrl = (qdrantUrl || process.env.QDRANT_URL || DEFAULT_QDRANT_URL).replace(/\/+$/, "");
    this.apiKey = apiKey || process.env.QDRANT_API_KEY || "";
    this.log = log || (() => {});
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /** Build headers for Qdrant requests. */
  _headers() {
    const h = { "Content-Type": "application/json" };
    if (this.apiKey) h["api-key"] = this.apiKey;
    return h;
  }

  /**
   * Generic Qdrant REST call with retry + error handling.
   * @param {string} method
   * @param {string} path   — relative to baseUrl (e.g. "/collections")
   * @param {object} [body]
   * @param {number} [retries=2]
   * @returns {Promise<object>}
   */
  async _request(method, path, body, retries = 2) {
    const url = `${this.baseUrl}${path}`;
    const opts = { method, headers: this._headers() };
    if (body !== undefined) opts.body = JSON.stringify(body);

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, opts);
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { json = { raw: text }; }

        if (!res.ok) {
          const errMsg = json?.status?.error || json?.raw || res.statusText;
          const err = new Error(`Qdrant ${method} ${path} → ${res.status}: ${errMsg}`);
          err.status = res.status;
          err.qdrantResponse = json;
          throw err;
        }
        return json;
      } catch (err) {
        // Retry on network errors, not on 4xx
        if (err.status && err.status >= 400 && err.status < 500) throw err;
        if (attempt >= retries) throw err;
        this.log("warn", "qdrant_retry", {
          component: "vector-store",
          attempt: attempt + 1,
          path,
          error: err.message,
        });
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }

  // ── Collection management ───────────────────────────────────────────────────

  /**
   * Create a new collection.
   * @param {string} name
   * @param {object} [opts]
   * @param {number} [opts.dimension=1536]
   * @param {'Cosine'|'Euclid'|'Dot'} [opts.distance='Cosine']
   */
  async createCollection(name, { dimension = 1536, distance = "Cosine" } = {}) {
    this.log("info", "qdrant_create_collection", { component: "vector-store", collection: name, dimension, distance });
    return this._request("PUT", `/collections/${encodeURIComponent(name)}`, {
      vectors: { size: dimension, distance },
      // Sensible defaults for small-to-medium KBs
      optimizers_config: { indexing_threshold: 5000 },
    });
  }

  /**
   * Delete a collection and all its data.
   * @param {string} name
   */
  async deleteCollection(name) {
    this.log("info", "qdrant_delete_collection", { component: "vector-store", collection: name });
    return this._request("DELETE", `/collections/${encodeURIComponent(name)}`);
  }

  /**
   * List all collections.
   * @returns {Promise<string[]>} — collection names
   */
  async listCollections() {
    const res = await this._request("GET", "/collections");
    return (res?.result?.collections || []).map((c) => c.name);
  }

  /**
   * Get collection info (point count, config, etc.).
   * @param {string} name
   */
  async getCollectionInfo(name) {
    const res = await this._request("GET", `/collections/${encodeURIComponent(name)}`);
    return res?.result || null;
  }

  // ── Point operations ────────────────────────────────────────────────────────

  /**
   * Upsert points (vectors + payloads).
   * @param {string} collection
   * @param {Array<{id: string|number, vector: number[], payload: object}>} points
   */
  async upsert(collection, points) {
    if (!points || points.length === 0) return;

    // Batch in chunks of 100 to avoid oversized requests
    const BATCH_SIZE = 100;
    for (let i = 0; i < points.length; i += BATCH_SIZE) {
      const batch = points.slice(i, i + BATCH_SIZE);
      await this._request(
        "PUT",
        `/collections/${encodeURIComponent(collection)}/points`,
        { points: batch },
      );
    }

    this.log("info", "qdrant_upsert", {
      component: "vector-store",
      collection,
      count: points.length,
    });
  }

  /**
   * Vector similarity search.
   * @param {string} collection
   * @param {number[]} vector
   * @param {object} [opts]
   * @param {number} [opts.limit=5]
   * @param {object} [opts.filter]          — Qdrant filter object
   * @param {number} [opts.scoreThreshold=0.7]
   * @returns {Promise<Array<{id, score, payload}>>}
   */
  async search(collection, vector, { limit = 5, filter, scoreThreshold = 0.7 } = {}) {
    const body = {
      vector,
      limit,
      with_payload: true,
      score_threshold: scoreThreshold,
    };
    if (filter) body.filter = filter;

    const res = await this._request(
      "POST",
      `/collections/${encodeURIComponent(collection)}/points/search`,
      body,
    );

    return (res?.result || []).map((r) => ({
      id: r.id,
      score: r.score,
      payload: r.payload,
    }));
  }

  /**
   * Delete points by IDs.
   * @param {string} collection
   * @param {Array<string|number>} ids
   */
  async delete(collection, ids) {
    if (!ids || ids.length === 0) return;
    await this._request(
      "POST",
      `/collections/${encodeURIComponent(collection)}/points/delete`,
      { points: ids },
    );
    this.log("info", "qdrant_delete_points", {
      component: "vector-store",
      collection,
      count: ids.length,
    });
  }

  /**
   * Delete points matching a filter.
   * @param {string} collection
   * @param {object} filter — Qdrant filter object
   */
  async deleteByFilter(collection, filter) {
    await this._request(
      "POST",
      `/collections/${encodeURIComponent(collection)}/points/delete`,
      { filter },
    );
    this.log("info", "qdrant_delete_by_filter", { component: "vector-store", collection });
  }

  /**
   * Scroll (paginate) through points.
   * @param {string} collection
   * @param {object} [opts]
   * @param {object} [opts.filter]
   * @param {number} [opts.limit=20]
   * @param {string|number} [opts.offset]
   * @returns {Promise<{points: Array, nextOffset: string|number|null}>}
   */
  async scroll(collection, { filter, limit = 20, offset } = {}) {
    const body = { limit, with_payload: true };
    if (filter) body.filter = filter;
    if (offset !== undefined) body.offset = offset;

    const res = await this._request(
      "POST",
      `/collections/${encodeURIComponent(collection)}/points/scroll`,
      body,
    );

    return {
      points: (res?.result?.points || []).map((p) => ({
        id: p.id,
        payload: p.payload,
      })),
      nextOffset: res?.result?.next_page_offset ?? null,
    };
  }

  // ── Hybrid search ─────────────────────────────────────────────────────────

  /**
   * Hybrid search: combine vector similarity with BM25 keyword search using
   * Reciprocal Rank Fusion (RRF).
   *
   * @param {string} collection
   * @param {number[]} vector
   * @param {import('./bm25').BM25Index} bm25Index — pre-loaded BM25 index
   * @param {string} query — raw text query for BM25
   * @param {object} [opts]
   * @param {number} [opts.limit=5]
   * @param {number} [opts.scoreThreshold=0.5]
   * @param {number} [opts.vectorWeight=1.0]
   * @param {number} [opts.bm25Weight=1.0]
   * @param {number} [opts.rrfK=60]             — RRF constant (higher = more uniform blending)
   * @param {object} [opts.filter]
   * @returns {Promise<Array<{id, score, payload}>>}
   */
  async hybridSearch(collection, vector, bm25Index, query, {
    limit = 5,
    scoreThreshold = 0.5,
    vectorWeight = 1.0,
    bm25Weight = 1.0,
    rrfK = 60,
    filter,
  } = {}) {
    // Fetch more candidates from each source for better fusion
    const fetchLimit = Math.max(limit * 3, 20);

    // Run vector and BM25 searches in parallel
    const [vectorResults, bm25Results] = await Promise.all([
      this.search(collection, vector, { limit: fetchLimit, scoreThreshold: Math.max(0, scoreThreshold - 0.2), filter }),
      Promise.resolve(bm25Index ? bm25Index.search(query, { limit: fetchLimit }) : []),
    ]);

    // Build RRF score map
    // RRF formula: score = sum( weight / (k + rank_i) ) for each ranking list
    const rrfScores = new Map(); // id -> { score, payload }
    const payloads = new Map();  // id -> payload

    // Vector results (rank starts at 1)
    for (let rank = 0; rank < vectorResults.length; rank++) {
      const r = vectorResults[rank];
      const id = String(r.id);
      const rrfContrib = vectorWeight / (rrfK + rank + 1);
      rrfScores.set(id, (rrfScores.get(id) || 0) + rrfContrib);
      payloads.set(id, r.payload);
    }

    // BM25 results — docId format is "{pointId}" matching Qdrant point IDs
    for (let rank = 0; rank < bm25Results.length; rank++) {
      const r = bm25Results[rank];
      const id = String(r.docId);
      const rrfContrib = bm25Weight / (rrfK + rank + 1);
      rrfScores.set(id, (rrfScores.get(id) || 0) + rrfContrib);
      // BM25 may reference IDs we haven't fetched payload for — these will be missing
    }

    // Sort by RRF score descending, filter to entries with payloads
    const fused = Array.from(rrfScores.entries())
      .filter(([id]) => payloads.has(id))
      .map(([id, score]) => ({ id, score, payload: payloads.get(id) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return fused;
  }

  // ── Health ──────────────────────────────────────────────────────────────────

  /**
   * Ping Qdrant health endpoint.
   * @returns {Promise<boolean>}
   */
  async ping() {
    try {
      const res = await fetch(`${this.baseUrl}/healthz`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

module.exports = { VectorStore };
