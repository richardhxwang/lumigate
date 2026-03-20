"use strict";

/**
 * services/knowledge/ragflow-client.js — RAGFlow REST API client.
 *
 * Wraps the open-source RAGFlow engine (https://github.com/infiniflow/ragflow)
 * as the primary RAG backend for LumiGate.
 *
 * All methods use native fetch. Auth via `Authorization: Bearer {apiKey}`.
 */

const fs = require("fs");
const path = require("path");

class RAGFlowClient {
  /**
   * @param {object} opts
   * @param {string} [opts.baseUrl]  — RAGFlow API base URL (default: http://ragflow:9380)
   * @param {string} opts.apiKey     — RAGFlow API key
   * @param {function} [opts.log]
   */
  constructor({ baseUrl = "http://ragflow:9380", apiKey, log } = {}) {
    this._baseUrl = (baseUrl || "http://ragflow:9380").replace(/\/+$/, "");
    this._apiKey = apiKey || "";
    this._log = log || (() => {});
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** Build headers for every request. */
  _headers(extra = {}) {
    return {
      Authorization: `Bearer ${this._apiKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  /**
   * Execute a fetch request and parse the JSON response.
   * RAGFlow API returns `{ code: 0, data: ... }` on success.
   * Non-zero code or HTTP errors are thrown.
   */
  async _request(method, urlPath, { body, query, headers: extraHeaders, timeout = 30000 } = {}) {
    let url = `${this._baseUrl}${urlPath}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const opts = {
        method,
        headers: extraHeaders || this._headers(),
        signal: controller.signal,
      };

      if (body !== undefined) {
        opts.body = typeof body === "string" ? body : JSON.stringify(body);
      }

      const res = await fetch(url, opts);

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`RAGFlow HTTP ${res.status}: ${text.slice(0, 500)}`);
      }

      const json = await res.json();

      // RAGFlow convention: code 0 = success
      if (json.code !== undefined && json.code !== 0) {
        throw new Error(`RAGFlow API error (code ${json.code}): ${json.message || JSON.stringify(json).slice(0, 300)}`);
      }

      return json.data !== undefined ? json.data : json;
    } finally {
      clearTimeout(timer);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dataset (Knowledge Base) Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a dataset (knowledge base).
   * POST /api/v1/datasets
   *
   * @param {object} opts
   * @param {string} opts.name
   * @param {string} [opts.description]
   * @param {string} [opts.chunkMethod]     — 'naive' | 'manual' | 'qa' | 'table' | 'paper' | ...
   * @param {object} [opts.parserConfig]    — chunk size, delimiter, etc.
   * @returns {Promise<object>}             — created dataset object
   */
  async createDataset({ name, description, chunkMethod = "naive", parserConfig = {} } = {}) {
    const payload = { name };
    if (description) payload.description = description;
    if (chunkMethod) payload.chunk_method = chunkMethod;
    if (Object.keys(parserConfig).length > 0) payload.parser_config = parserConfig;

    return this._request("POST", "/api/v1/datasets", { body: payload });
  }

  /**
   * List datasets.
   * GET /api/v1/datasets
   *
   * @param {object} [opts]
   * @param {number} [opts.page=1]
   * @param {number} [opts.pageSize=30]
   * @param {string} [opts.name]           — filter by name (substring match)
   * @returns {Promise<object[]>}
   */
  async listDatasets({ page = 1, pageSize = 30, name } = {}) {
    const query = { page, page_size: pageSize };
    if (name) query.name = name;
    return this._request("GET", "/api/v1/datasets", { query });
  }

  /**
   * Get a single dataset by ID.
   * GET /api/v1/datasets/{dataset_id}
   *
   * @param {string} datasetId
   * @returns {Promise<object>}
   */
  async getDataset(datasetId) {
    return this._request("GET", `/api/v1/datasets/${encodeURIComponent(datasetId)}`);
  }

  /**
   * Delete a dataset.
   * DELETE /api/v1/datasets
   *
   * @param {string} datasetId
   * @returns {Promise<void>}
   */
  async deleteDataset(datasetId) {
    return this._request("DELETE", "/api/v1/datasets", {
      body: { ids: [datasetId] },
    });
  }

  /**
   * Update a dataset.
   * PUT /api/v1/datasets/{dataset_id}
   *
   * @param {string} datasetId
   * @param {object} updates     — { name, description, chunk_method, parser_config, ... }
   * @returns {Promise<object>}
   */
  async updateDataset(datasetId, updates) {
    return this._request("PUT", `/api/v1/datasets/${encodeURIComponent(datasetId)}`, {
      body: updates,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Document Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Upload a document to a dataset.
   * POST /api/v1/datasets/{dataset_id}/documents (multipart/form-data)
   *
   * @param {string} datasetId
   * @param {string|Buffer} filePathOrBuffer — path to local file or Buffer
   * @param {string} originalName            — filename to use in RAGFlow
   * @returns {Promise<object>}
   */
  async uploadDocument(datasetId, filePathOrBuffer, originalName) {
    let buffer;
    let filename = originalName || "document";

    if (Buffer.isBuffer(filePathOrBuffer)) {
      buffer = filePathOrBuffer;
    } else {
      buffer = fs.readFileSync(filePathOrBuffer);
      if (!originalName) filename = path.basename(filePathOrBuffer);
    }

    // Build multipart/form-data manually (no dependency on form-data lib)
    const boundary = "----RAGFlowUpload" + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename.replace(/"/g, "_")}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, buffer, footer]);

    return this._request("POST", `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents`, {
      body,
      headers: {
        Authorization: `Bearer ${this._apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      timeout: 120000, // uploads can be large
    });
  }

  /**
   * List documents in a dataset.
   * GET /api/v1/datasets/{dataset_id}/documents
   *
   * @param {string} datasetId
   * @param {object} [opts]
   * @param {number} [opts.page=1]
   * @param {number} [opts.pageSize=30]
   * @returns {Promise<object[]>}
   */
  async listDocuments(datasetId, { page = 1, pageSize = 30 } = {}) {
    return this._request("GET", `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents`, {
      query: { page, page_size: pageSize },
    });
  }

  /**
   * Delete documents from a dataset.
   * DELETE /api/v1/datasets/{dataset_id}/documents
   *
   * @param {string} datasetId
   * @param {string[]} documentIds
   * @returns {Promise<void>}
   */
  async deleteDocument(datasetId, documentIds) {
    const ids = Array.isArray(documentIds) ? documentIds : [documentIds];
    return this._request("DELETE", `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents`, {
      body: { ids },
    });
  }

  /**
   * Trigger document parsing (chunking + embedding).
   * POST /api/v1/datasets/{dataset_id}/chunks
   *
   * @param {string} datasetId
   * @param {string[]} documentIds
   * @returns {Promise<object>}
   */
  async parseDocuments(datasetId, documentIds) {
    const ids = Array.isArray(documentIds) ? documentIds : [documentIds];
    return this._request("POST", `/api/v1/datasets/${encodeURIComponent(datasetId)}/chunks`, {
      body: { document_ids: ids },
      timeout: 300000, // parsing can be slow for large docs
    });
  }

  /**
   * Get parsing status for a document by checking the document list.
   * RAGFlow documents have `run` (status) and `progress` fields.
   *
   * @param {string} datasetId
   * @param {string} documentId
   * @returns {Promise<{status: string, progress: number}|null>}
   */
  async getParsingStatus(datasetId, documentId) {
    const docs = await this.listDocuments(datasetId, { page: 1, pageSize: 100 });
    const docList = Array.isArray(docs) ? docs : (docs?.docs || docs?.documents || []);

    const doc = docList.find((d) => d.id === documentId);
    if (!doc) return null;

    return {
      status: doc.run || doc.status || "unknown",
      progress: doc.progress ?? 0,
      chunkCount: doc.chunk_num ?? doc.chunk_count ?? 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Chunk Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * List chunks for a document.
   * GET /api/v1/datasets/{dataset_id}/documents/{document_id}/chunks
   *
   * @param {string} datasetId
   * @param {string} documentId
   * @param {object} [opts]
   * @param {number} [opts.page=1]
   * @param {number} [opts.pageSize=30]
   * @returns {Promise<object[]>}
   */
  async listChunks(datasetId, documentId, { page = 1, pageSize = 30 } = {}) {
    return this._request(
      "GET",
      `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}/chunks`,
      { query: { page, page_size: pageSize } }
    );
  }

  /**
   * Delete chunks from a document.
   *
   * @param {string} datasetId
   * @param {string} documentId
   * @param {string[]} chunkIds
   * @returns {Promise<void>}
   */
  async deleteChunks(datasetId, documentId, chunkIds) {
    const ids = Array.isArray(chunkIds) ? chunkIds : [chunkIds];
    return this._request(
      "DELETE",
      `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}/chunks`,
      { body: { chunk_ids: ids } }
    );
  }

  /**
   * Update a chunk (e.g., edit content or toggle availability).
   *
   * @param {string} datasetId
   * @param {string} documentId
   * @param {string} chunkId
   * @param {object} updates     — { content, available, ... }
   * @returns {Promise<object>}
   */
  async updateChunk(datasetId, documentId, chunkId, updates) {
    return this._request(
      "PUT",
      `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}/chunks/${encodeURIComponent(chunkId)}`,
      { body: updates }
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Retrieval — RAGFlow's core hybrid search with reranking
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Retrieve relevant chunks from one or more datasets.
   * POST /api/v1/retrieval
   *
   * This is RAGFlow's core: hybrid retrieval (vector + keyword) with built-in reranking.
   *
   * @param {string[]} datasetIds
   * @param {string} question
   * @param {object} [opts]
   * @param {number} [opts.limit=5]                — top_k
   * @param {number} [opts.similarity=0.5]         — similarity threshold (0-1)
   * @param {number} [opts.keywordSimilarity=0.3]  — keyword weight
   * @returns {Promise<Array<{text: string, score: number, source: object}>>}
   */
  async retrieve(datasetIds, question, { limit = 5, similarity = 0.5, keywordSimilarity = 0.3 } = {}) {
    const ids = Array.isArray(datasetIds) ? datasetIds : [datasetIds];

    const payload = {
      question,
      dataset_ids: ids,
      top_k: limit,
      similarity_threshold: similarity,
      keyword_similarity_weight: keywordSimilarity,
    };

    const data = await this._request("POST", "/api/v1/retrieval", {
      body: payload,
      timeout: 30000,
    });

    // Normalize RAGFlow response to LumiGate chunk format
    const chunks = Array.isArray(data?.chunks) ? data.chunks
      : Array.isArray(data) ? data
      : [];

    return chunks.map((c) => ({
      text: c.content || c.content_with_weight || c.text || "",
      score: c.similarity ?? c.score ?? 0,
      source: {
        documentId: c.document_id || c.doc_id || null,
        filename: c.document_name || c.doc_name || c.document_keyword || "unknown",
        chunkIndex: c.chunk_order_idx ?? null,
        kbId: c.dataset_id || c.kb_id || (ids.length === 1 ? ids[0] : null),
        kbName: c.dataset_name || c.kb_name || null,
        ragflowChunkId: c.id || c.chunk_id || null,
      },
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Chat — RAGFlow's built-in assistant with RAG
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a chat assistant backed by datasets.
   * POST /api/v1/chats
   *
   * @param {object} opts
   * @param {string} opts.name
   * @param {string[]} opts.datasetIds
   * @param {string} [opts.model]            — LLM model to use inside RAGFlow
   * @param {object} [opts.promptConfig]
   * @returns {Promise<object>}
   */
  async createAssistant({ name, datasetIds, model, promptConfig } = {}) {
    const payload = { name };
    if (datasetIds) payload.dataset_ids = datasetIds;
    if (model) payload.llm = { model_name: model };
    if (promptConfig) payload.prompt = promptConfig;

    return this._request("POST", "/api/v1/chats", { body: payload });
  }

  /**
   * Send a message to a RAGFlow chat assistant.
   * POST /api/v1/chats/{chat_id}/completions
   *
   * @param {string} assistantId
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} [opts]
   * @param {boolean} [opts.stream=false]
   * @returns {Promise<object>}
   */
  async chat(assistantId, messages, { stream = false } = {}) {
    const payload = {
      messages,
      stream,
    };

    return this._request("POST", `/api/v1/chats/${encodeURIComponent(assistantId)}/completions`, {
      body: payload,
      timeout: 120000,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Health / Connectivity
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Ping RAGFlow to check availability.
   * Uses dataset list with page_size=1 as a lightweight health check,
   * since RAGFlow may not expose a dedicated health endpoint.
   *
   * @returns {Promise<boolean>} — true if reachable
   */
  async ping() {
    try {
      await this._request("GET", "/api/v1/datasets", {
        query: { page: 1, page_size: 1 },
        timeout: 5000,
      });
      return true;
    } catch (err) {
      this._log("warn", "ragflow_ping_failed", {
        component: "ragflow-client",
        error: err.message,
        baseUrl: this._baseUrl,
      });
      throw err;
    }
  }
}

module.exports = { RAGFlowClient };
