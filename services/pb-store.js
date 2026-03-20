"use strict";

/**
 * services/pb-store.js — Generic PocketBase CRUD helper.
 *
 * Wraps the PB REST API with a clean async interface.
 * Handles token refresh, retries, and fire-and-forget writes.
 */

class PBStore {
  /**
   * @param {object} opts
   * @param {string} opts.pbUrl - PocketBase base URL (e.g. http://localhost:8090)
   * @param {function} opts.getAdminToken - async () => string|null
   * @param {function} [opts.log] - (level, msg, ctx) logger
   */
  constructor({ pbUrl, getAdminToken, log } = {}) {
    if (!pbUrl) throw new Error("PBStore: pbUrl is required");
    if (typeof getAdminToken !== "function") throw new Error("PBStore: getAdminToken must be a function");

    this.pbUrl = pbUrl.replace(/\/+$/, "");
    this.getAdminToken = getAdminToken;
    this.log = log || (() => {});
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Make an authenticated fetch to PB.
   * @param {string} path - API path (e.g. /api/collections/workflows/records)
   * @param {object} [opts] - fetch options
   * @returns {Promise<Response>}
   */
  async _fetch(path, opts = {}) {
    const token = await this.getAdminToken();
    if (!token) {
      throw new Error("PBStore: no admin token available");
    }

    const url = `${this.pbUrl}${path}`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: token,
      ...(opts.headers || {}),
    };

    const res = await fetch(url, {
      ...opts,
      headers,
      signal: opts.signal || AbortSignal.timeout(15_000),
    });

    return res;
  }

  /**
   * Parse a PB API response, throwing on error.
   */
  async _parseResponse(res, context) {
    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    const errText = await res.text().catch(() => "");
    const err = new Error(`PB ${context}: ${res.status} ${errText.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  // ---------------------------------------------------------------------------
  // CRUD operations
  // ---------------------------------------------------------------------------

  /**
   * Create a record in a collection.
   * @param {string} collection - Collection name
   * @param {object} data - Record data
   * @returns {Promise<object>} Created record
   */
  async create(collection, data) {
    const res = await this._fetch(`/api/collections/${collection}/records`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    return this._parseResponse(res, `create ${collection}`);
  }

  /**
   * Get a single record by ID.
   * @param {string} collection
   * @param {string} id - Record ID
   * @returns {Promise<object>}
   */
  async getOne(collection, id) {
    const res = await this._fetch(`/api/collections/${collection}/records/${encodeURIComponent(id)}`);
    return this._parseResponse(res, `getOne ${collection}/${id}`);
  }

  /**
   * List records with pagination, filtering, and sorting.
   * @param {string} collection
   * @param {object} [opts]
   * @param {number} [opts.page=1]
   * @param {number} [opts.perPage=50]
   * @param {string} [opts.filter] - PB filter expression
   * @param {string} [opts.sort] - PB sort expression (e.g. "-created")
   * @returns {Promise<{page, perPage, totalPages, totalItems, items}>}
   */
  async getList(collection, { page = 1, perPage = 50, filter, sort } = {}) {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("perPage", String(perPage));
    if (filter) params.set("filter", filter);
    if (sort) params.set("sort", sort);

    const res = await this._fetch(`/api/collections/${collection}/records?${params}`);
    return this._parseResponse(res, `getList ${collection}`);
  }

  /**
   * Update a record by ID.
   * @param {string} collection
   * @param {string} id
   * @param {object} data - Fields to update
   * @returns {Promise<object>} Updated record
   */
  async update(collection, id, data) {
    const res = await this._fetch(`/api/collections/${collection}/records/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    return this._parseResponse(res, `update ${collection}/${id}`);
  }

  /**
   * Delete a record by ID.
   * @param {string} collection
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async delete(collection, id) {
    const res = await this._fetch(`/api/collections/${collection}/records/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (res.ok) return true;
    if (res.status === 404) return false;
    await this._parseResponse(res, `delete ${collection}/${id}`); // will throw
  }

  // ---------------------------------------------------------------------------
  // Fire-and-forget (for non-critical data like traces)
  // ---------------------------------------------------------------------------

  /**
   * Create a record asynchronously. Errors are logged but not thrown.
   * @param {string} collection
   * @param {object} data
   */
  createAsync(collection, data) {
    this.create(collection, data).catch((err) => {
      this.log("warn", "pb_store_async_create_failed", {
        component: "pb-store",
        collection,
        error: err.message,
      });
    });
  }

  /**
   * Update a record asynchronously. Errors are logged but not thrown.
   * @param {string} collection
   * @param {string} id
   * @param {object} data
   */
  updateAsync(collection, id, data) {
    this.update(collection, id, data).catch((err) => {
      this.log("warn", "pb_store_async_update_failed", {
        component: "pb-store",
        collection,
        id,
        error: err.message,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Batch operations
  // ---------------------------------------------------------------------------

  /**
   * Create multiple records. Executes in parallel with concurrency limit.
   * @param {string} collection
   * @param {object[]} items
   * @param {number} [concurrency=5]
   * @returns {Promise<{created: number, errors: number}>}
   */
  async createMany(collection, items, concurrency = 5) {
    let created = 0;
    let errors = 0;

    // Process in batches of `concurrency`
    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map((item) => this.create(collection, item)),
      );
      for (const r of results) {
        if (r.status === "fulfilled") created++;
        else {
          errors++;
          this.log("warn", "pb_store_batch_create_failed", {
            component: "pb-store",
            collection,
            error: r.reason?.message,
          });
        }
      }
    }

    return { created, errors };
  }

  /**
   * Find a single record matching a filter, or null if not found.
   * @param {string} collection
   * @param {string} filter - PB filter expression
   * @returns {Promise<object|null>}
   */
  async findOne(collection, filter) {
    try {
      const result = await this.getList(collection, { page: 1, perPage: 1, filter });
      return result.items?.[0] || null;
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Create or update a record. Tries to find by filter first.
   * @param {string} collection
   * @param {string} filter - PB filter expression to find existing record
   * @param {object} data
   * @returns {Promise<{record: object, created: boolean}>}
   */
  async upsert(collection, filter, data) {
    const existing = await this.findOne(collection, filter);
    if (existing) {
      const record = await this.update(collection, existing.id, data);
      return { record, created: false };
    }
    const record = await this.create(collection, data);
    return { record, created: true };
  }
}

module.exports = { PBStore };
