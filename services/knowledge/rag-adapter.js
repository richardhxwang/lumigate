"use strict";

/**
 * services/knowledge/rag-adapter.js — Unified RAG interface.
 *
 * Tries RAGFlow first (primary), falls back to the self-built
 * KnowledgeBaseManager (builtin) on failure or if RAGFlow is unavailable.
 *
 * All public methods return results in the same normalized format used by
 * the rest of LumiGate (text + score + source).
 */

class RAGAdapter {
  /**
   * @param {object} opts
   * @param {import('./ragflow-client').RAGFlowClient|null} opts.ragflowClient
   * @param {import('./manager').KnowledgeBaseManager} opts.knowledgeManager
   * @param {function} [opts.log]
   */
  constructor({ ragflowClient, knowledgeManager, log } = {}) {
    this._ragflow = ragflowClient || null;
    this._builtin = knowledgeManager;
    this._log = log || (() => {});
    this._useRagflow = false;
  }

  // ── Initialization ──────────────────────────────────────────────────────────

  /**
   * Probe RAGFlow connectivity. If reachable, mark as primary backend.
   * Safe to call at startup — never throws.
   */
  async init() {
    if (!this._ragflow) {
      this._log("info", "rag_adapter_init", {
        component: "rag-adapter",
        backend: "builtin",
        msg: "RAGFlow client not configured — using built-in RAG only",
      });
      return;
    }

    try {
      await this._ragflow.ping();
      this._useRagflow = true;
      this._log("info", "rag_adapter_init", {
        component: "rag-adapter",
        backend: "ragflow",
        msg: "RAGFlow connected — using as primary RAG backend",
      });
    } catch (err) {
      this._useRagflow = false;
      this._log("warn", "rag_adapter_init", {
        component: "rag-adapter",
        backend: "builtin",
        msg: "RAGFlow unavailable — falling back to built-in RAG",
        error: err.message,
      });
    }
  }

  /** Whether RAGFlow is currently the active backend. */
  get isRagflowActive() {
    return this._useRagflow;
  }

  /** Current backend name string (for health/status endpoints). */
  get backendName() {
    return this._useRagflow ? "ragflow" : "builtin";
  }

  // ── Knowledge Base CRUD ─────────────────────────────────────────────────────

  /**
   * Create a knowledge base.
   * RAGFlow: creates a dataset. Builtin: creates a Qdrant collection + metadata.
   *
   * @param {object} opts
   * @param {string} opts.name
   * @param {string} [opts.description]
   * @param {string} [opts.chunkMethod]     — RAGFlow-specific
   * @param {object} [opts.parserConfig]    — RAGFlow-specific
   * @param {string} [opts.embeddingModel]  — builtin-specific
   * @returns {Promise<object>}
   */
  async createKB(opts) {
    if (this._useRagflow) {
      try {
        const ds = await this._ragflow.createDataset({
          name: opts.name,
          description: opts.description,
          chunkMethod: opts.chunkMethod,
          parserConfig: opts.parserConfig,
        });
        this._log("info", "rag_adapter_kb_created", {
          component: "rag-adapter",
          backend: "ragflow",
          kbId: ds.id || ds.dataset_id,
          name: opts.name,
        });
        return this._normalizeKB(ds, "ragflow");
      } catch (err) {
        this._log("warn", "rag_adapter_ragflow_create_failed", {
          component: "rag-adapter",
          error: err.message,
          name: opts.name,
        });
        // Fall through to builtin
      }
    }

    const meta = await this._builtin.create({
      name: opts.name,
      description: opts.description,
      embeddingModel: opts.embeddingModel,
    });
    return this._normalizeKB(meta, "builtin");
  }

  /**
   * Delete a knowledge base.
   *
   * @param {string} kbId
   * @param {string} [backend]  — 'ragflow' | 'builtin' | undefined (auto-detect)
   */
  async deleteKB(kbId, backend) {
    const target = backend || this._detectBackend(kbId);

    if (target === "ragflow" && this._useRagflow) {
      try {
        await this._ragflow.deleteDataset(kbId);
        return;
      } catch (err) {
        this._log("warn", "rag_adapter_ragflow_delete_failed", {
          component: "rag-adapter",
          error: err.message,
          kbId,
        });
      }
    }

    await this._builtin.delete(kbId);
  }

  /**
   * List all knowledge bases (merged from both backends if RAGFlow is active).
   *
   * @returns {Promise<object[]>}
   */
  async listKBs() {
    const results = [];

    // Always include builtin KBs
    try {
      const builtinList = await this._builtin.list();
      results.push(...builtinList.map((kb) => this._normalizeKB(kb, "builtin")));
    } catch (err) {
      this._log("warn", "rag_adapter_builtin_list_failed", {
        component: "rag-adapter",
        error: err.message,
      });
    }

    // If RAGFlow is active, also list its datasets
    if (this._useRagflow) {
      try {
        const rfList = await this._ragflow.listDatasets({ pageSize: 100 });
        const datasets = Array.isArray(rfList) ? rfList : (rfList?.datasets || []);
        results.push(...datasets.map((ds) => this._normalizeKB(ds, "ragflow")));
      } catch (err) {
        this._log("warn", "rag_adapter_ragflow_list_failed", {
          component: "rag-adapter",
          error: err.message,
        });
      }
    }

    return results;
  }

  // ── Document Management ─────────────────────────────────────────────────────

  /**
   * Add a document (file) to a knowledge base.
   *
   * @param {string} kbId
   * @param {string|Buffer} filePathOrBuffer
   * @param {string} originalName
   * @param {string} [backend]
   * @returns {Promise<object>}
   */
  async addDocument(kbId, filePathOrBuffer, originalName, backend) {
    const target = backend || this._detectBackend(kbId);

    if (target === "ragflow" && this._useRagflow) {
      try {
        const result = await this._ragflow.uploadDocument(kbId, filePathOrBuffer, originalName);
        // Auto-trigger parsing after upload
        const docId = result?.id || result?.document_id;
        if (docId) {
          try {
            await this._ragflow.parseDocuments(kbId, [docId]);
          } catch (parseErr) {
            this._log("warn", "rag_adapter_ragflow_parse_trigger_failed", {
              component: "rag-adapter",
              error: parseErr.message,
              kbId,
              docId,
            });
          }
        }
        return {
          documentId: docId,
          backend: "ragflow",
          filename: originalName,
        };
      } catch (err) {
        this._log("warn", "rag_adapter_ragflow_upload_failed", {
          component: "rag-adapter",
          error: err.message,
          kbId,
        });
        // Fall through to builtin
      }
    }

    const result = await this._builtin.addFile(kbId, filePathOrBuffer, originalName);
    return { ...result, backend: "builtin" };
  }

  /**
   * Remove a document from a knowledge base.
   *
   * @param {string} kbId
   * @param {string} docId
   * @param {string} [backend]
   */
  async removeDocument(kbId, docId, backend) {
    const target = backend || this._detectBackend(kbId);

    if (target === "ragflow" && this._useRagflow) {
      try {
        await this._ragflow.deleteDocument(kbId, [docId]);
        return;
      } catch (err) {
        this._log("warn", "rag_adapter_ragflow_remove_failed", {
          component: "rag-adapter",
          error: err.message,
          kbId,
          docId,
        });
      }
    }

    await this._builtin.removeDocument(kbId, docId);
  }

  // ── Retrieval — the key method ──────────────────────────────────────────────

  /**
   * Retrieve relevant chunks from one or more knowledge bases.
   * Tries RAGFlow first, falls back to builtin on error.
   *
   * @param {string[]} kbIds
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.limit=5]
   * @param {number} [opts.scoreThreshold=0.5]
   * @param {number} [opts.similarity=0.5]
   * @param {number} [opts.keywordSimilarity=0.3]
   * @returns {Promise<Array<{text: string, score: number, source: object}>>}
   */
  async retrieve(kbIds, query, opts = {}) {
    const ids = Array.isArray(kbIds) ? kbIds : [kbIds];
    if (!ids.length || !query) return [];

    if (this._useRagflow) {
      try {
        const results = await this._ragflow.retrieve(ids, query, {
          limit: opts.limit || 5,
          similarity: opts.similarity ?? opts.scoreThreshold ?? 0.5,
          keywordSimilarity: opts.keywordSimilarity ?? 0.3,
        });
        this._log("debug", "rag_adapter_retrieve", {
          component: "rag-adapter",
          backend: "ragflow",
          kbIds: ids,
          chunks: results.length,
        });
        return results;
      } catch (err) {
        this._log("warn", "rag_adapter_ragflow_retrieve_failed", {
          component: "rag-adapter",
          error: err.message,
          kbIds: ids,
          msg: "Falling back to built-in RAG",
        });
        // Fall through to builtin
      }
    }

    // Builtin fallback
    const results = await this._builtin.retrieveMulti(ids, query, {
      limit: opts.limit || 5,
      scoreThreshold: opts.scoreThreshold ?? 0.5,
    });

    this._log("debug", "rag_adapter_retrieve", {
      component: "rag-adapter",
      backend: "builtin",
      kbIds: ids,
      chunks: results.length,
    });

    return results;
  }

  /**
   * Format retrieved chunks into a context string for injection into chat.
   * Same format as KnowledgeBaseManager.formatContext().
   *
   * @param {Array<{text: string, score: number, source: object}>} results
   * @returns {string}
   */
  formatContext(results) {
    return this._builtin.formatContext(results);
  }

  /**
   * Enrich a chat message with RAG context.
   * Retrieves, formats, and returns a context string ready for system prompt injection.
   *
   * @param {string[]} kbIds
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.maxTokens=4000]    — approximate token budget for context
   * @param {number} [opts.limit=8]
   * @param {number} [opts.scoreThreshold=0.5]
   * @returns {Promise<{context: string, chunks: number, backend: string}>}
   */
  async enrichChatContext(kbIds, query, { maxTokens = 4000, limit = 8, scoreThreshold = 0.5 } = {}) {
    const results = await this.retrieve(kbIds, query, { limit, scoreThreshold });

    if (!results.length) {
      return { context: "", chunks: 0, backend: this.backendName };
    }

    // Rough token budget: ~4 chars per token
    const charBudget = maxTokens * 4;
    let totalChars = 0;
    const trimmedResults = [];

    for (const r of results) {
      const textLen = (r.text || "").length;
      if (totalChars + textLen > charBudget && trimmedResults.length > 0) break;
      trimmedResults.push(r);
      totalChars += textLen;
    }

    const context = this.formatContext(trimmedResults);

    return {
      context,
      chunks: trimmedResults.length,
      backend: this.backendName,
    };
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /**
   * Normalize a KB/dataset object from either backend into a common shape.
   */
  _normalizeKB(obj, backend) {
    if (backend === "ragflow") {
      return {
        id: obj.id || obj.dataset_id,
        name: obj.name || "",
        description: obj.description || "",
        backend: "ragflow",
        documentCount: obj.document_count ?? obj.doc_num ?? 0,
        chunkMethod: obj.chunk_method || "naive",
        createdAt: obj.create_time || obj.created_at || null,
        updatedAt: obj.update_time || obj.updated_at || null,
      };
    }

    // Builtin
    return {
      id: obj.id,
      name: obj.name || "",
      description: obj.description || "",
      backend: "builtin",
      documentCount: obj.documentCount ?? (obj.documents || []).length,
      embeddingModel: obj.embeddingModel || null,
      createdAt: obj.createdAt || null,
      updatedAt: obj.updatedAt || null,
    };
  }

  /**
   * Heuristic: detect whether a KB ID belongs to RAGFlow or builtin.
   * RAGFlow IDs are typically UUIDs (with dashes), builtin IDs are hex strings.
   * Defaults to current active backend.
   */
  _detectBackend(kbId) {
    if (!kbId) return this._useRagflow ? "ragflow" : "builtin";

    // RAGFlow UUIDs contain dashes
    if (kbId.includes("-") && kbId.length > 20) return "ragflow";

    // Builtin IDs are 16-char hex
    if (/^[0-9a-f]{16}$/.test(kbId)) return "builtin";

    // Default to active backend
    return this._useRagflow ? "ragflow" : "builtin";
  }
}

module.exports = { RAGAdapter };
