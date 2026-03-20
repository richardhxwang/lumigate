"use strict";

/**
 * services/knowledge/manager.js — Knowledge Base lifecycle manager.
 *
 * Orchestrates: chunking -> embedding -> vector storage.
 * Metadata persisted as JSON in data/knowledge/ (atomic writes).
 * Vectors stored in Qdrant collections (one per knowledge base).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { BM25Index } = require("./bm25");

/** Collection name prefix to namespace LumiGate KBs in Qdrant. */
const COLLECTION_PREFIX = "lg_kb_";

/** Escape single quotes for PocketBase filter strings. */
function pbEscape(val) { return String(val || '').replace(/'/g, "\\'"); }

class KnowledgeBaseManager {
  /**
   * @param {object} opts
   * @param {import('./vector-store').VectorStore} opts.vectorStore
   * @param {import('./embedder').Embedder} opts.embedder
   * @param {import('./chunker').Chunker} opts.chunker
   * @param {string} [opts.dataDir]
   * @param {string} [opts.fileParserUrl]
   * @param {import('./reranker').Reranker} [opts.reranker]
   * @param {import('./query-transform').QueryTransformer} [opts.queryTransformer]
   * @param {import('./compressor').ContextualCompressor} [opts.compressor]
   * @param {function} [opts.log]
   */
  constructor({ vectorStore, embedder, chunker, dataDir, fileParserUrl, reranker, queryTransformer, compressor, pbStore, log } = {}) {
    this.vectorStore = vectorStore;
    this.embedder = embedder;
    this.chunker = chunker;
    this.dataDir = dataDir || path.resolve(__dirname, "../../data/knowledge");
    this.fileParserUrl = fileParserUrl || process.env.FILE_PARSER_URL || "http://lumigate-file-parser:3100";
    this.reranker = reranker || null;
    this.queryTransformer = queryTransformer || null;
    this.compressor = compressor || null;
    this._pbStore = pbStore || null;
    this.log = log || (() => {});

    /** @type {Map<string, BM25Index>} kbId -> BM25 index (lazy-loaded) */
    this._bm25Cache = new Map();

    // Ensure data directory exists
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  // ── Internal: metadata persistence ──────────────────────────────────────────

  _metaPath(kbId) {
    return path.join(this.dataDir, `${kbId}.json`);
  }

  /**
   * Atomic write (tmp + rename) — consistent with gateway pattern.
   */
  _saveMeta(kbId, meta) {
    const target = this._metaPath(kbId);
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), "utf8");
    fs.renameSync(tmp, target);
  }

  _loadMeta(kbId) {
    const p = this._metaPath(kbId);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  }

  _deleteMeta(kbId) {
    const p = this._metaPath(kbId);
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }

  /** Qdrant collection name for a KB. */
  _collectionName(kbId) {
    return `${COLLECTION_PREFIX}${kbId}`;
  }

  /** Generate a point ID from documentId + chunkIndex (deterministic UUID-like string). */
  _pointId(documentId, chunkIndex) {
    const hash = crypto.createHash("md5").update(`${documentId}:${chunkIndex}`).digest("hex");
    // Qdrant supports UUID-format IDs: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    return [
      hash.slice(0, 8),
      hash.slice(8, 12),
      hash.slice(12, 16),
      hash.slice(16, 20),
      hash.slice(20, 32),
    ].join("-");
  }

  // ── BM25 index management ──────────────────────────────────────────────────

  /** Path to BM25 index file for a KB. */
  _bm25Path(kbId) {
    const dir = path.join(this.dataDir, kbId);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "bm25-index.json");
  }

  /**
   * Get or load the BM25 index for a KB.
   * @param {string} kbId
   * @returns {BM25Index}
   */
  _getBM25Index(kbId) {
    if (this._bm25Cache.has(kbId)) return this._bm25Cache.get(kbId);

    const filePath = this._bm25Path(kbId);
    let idx = BM25Index.load(filePath);
    if (!idx) idx = new BM25Index();

    // LRU eviction: keep cache bounded
    if (this._bm25Cache.size > 20) {
      const oldest = this._bm25Cache.keys().next().value;
      this._bm25Cache.delete(oldest);
    }

    this._bm25Cache.set(kbId, idx);
    return idx;
  }

  /**
   * Persist BM25 index to disk (atomic write).
   * @param {string} kbId
   */
  _saveBM25Index(kbId) {
    const idx = this._bm25Cache.get(kbId);
    if (!idx) return;
    idx.save(this._bm25Path(kbId));
  }

  // ── Knowledge Base CRUD ─────────────────────────────────────────────────────

  /**
   * Create a new knowledge base.
   * @param {object} opts
   * @param {string} opts.name
   * @param {string} [opts.description]
   * @param {string} [opts.embeddingModel]  — override default model
   * @returns {Promise<object>} — KB metadata
   */
  async create({ name, description = "", embeddingModel } = {}) {
    if (!name || typeof name !== "string") {
      throw new Error("Knowledge base name is required");
    }

    const kbId = crypto.randomBytes(8).toString("hex");
    const dimension = this.embedder.getDimension();
    const collectionName = this._collectionName(kbId);

    // Create Qdrant collection
    await this.vectorStore.createCollection(collectionName, { dimension });

    const meta = {
      id: kbId,
      name: name.trim(),
      description: description.trim(),
      embeddingModel: embeddingModel || this.embedder.model,
      embeddingDimension: dimension,
      documents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this._saveMeta(kbId, meta);

    // Sync to PocketBase (async, non-blocking)
    if (this._pbStore) {
      this._pbStore.createAsync("knowledge_bases", {
        name: meta.name,
        description: meta.description,
        embedding_model: meta.embeddingModel,
        embedding_dimension: dimension,
        document_count: 0,
        chunk_count: 0,
        status: "active",
        config: meta,
      });
    }

    this.log("info", "kb_created", {
      component: "knowledge",
      kbId,
      name: meta.name,
      dimension,
    });

    return meta;
  }

  /**
   * List all knowledge bases.
   * @returns {Promise<object[]>}
   */
  async list() {
    const files = fs.readdirSync(this.dataDir).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
    const results = [];

    for (const f of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.dataDir, f), "utf8"));
        // Add document count summary
        results.push({
          id: meta.id,
          name: meta.name,
          description: meta.description,
          embeddingModel: meta.embeddingModel,
          documentCount: (meta.documents || []).length,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
        });
      } catch {
        // Skip corrupt files
      }
    }

    return results.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  }

  /**
   * Get full KB detail including document list and vector stats.
   * @param {string} kbId
   * @returns {Promise<object|null>}
   */
  async get(kbId) {
    const meta = this._loadMeta(kbId);
    if (!meta) return null;

    // Try to get vector count from Qdrant
    try {
      const info = await this.vectorStore.getCollectionInfo(this._collectionName(kbId));
      meta.vectorCount = info?.points_count ?? info?.vectors_count ?? 0;
      meta.status = info?.status || "unknown";
    } catch {
      meta.vectorCount = 0;
      meta.status = "unavailable";
    }

    return meta;
  }

  /**
   * Delete a knowledge base and all its vectors.
   * @param {string} kbId
   */
  async delete(kbId) {
    const meta = this._loadMeta(kbId);
    if (!meta) throw new Error(`Knowledge base ${kbId} not found`);

    // Delete Qdrant collection
    try {
      await this.vectorStore.deleteCollection(this._collectionName(kbId));
    } catch (err) {
      this.log("warn", "kb_delete_collection_failed", {
        component: "knowledge",
        kbId,
        error: err.message,
      });
    }

    this._deleteMeta(kbId);

    // Delete from PocketBase (async, non-blocking)
    if (this._pbStore) {
      this._pbStore.findOne("knowledge_bases", `name='${pbEscape(meta.name)}'`).then((rec) => {
        if (rec) this._pbStore.delete("knowledge_bases", rec.id).catch(() => {});
      }).catch(() => {});
    }

    this.log("info", "kb_deleted", { component: "knowledge", kbId, name: meta.name });
  }

  // ── Document management ─────────────────────────────────────────────────────

  /**
   * Add a text document to a knowledge base.
   * Chunks -> embeds -> stores in Qdrant.
   *
   * @param {string} kbId
   * @param {object} opts
   * @param {string} opts.text
   * @param {string} [opts.filename]
   * @param {object} [opts.metadata]
   * @returns {Promise<{documentId: string, chunkCount: number}>}
   */
  async addDocument(kbId, { text, filename = "untitled", metadata = {} } = {}) {
    const meta = this._loadMeta(kbId);
    if (!meta) throw new Error(`Knowledge base ${kbId} not found`);
    if (!text || typeof text !== "string" || !text.trim()) {
      throw new Error("Document text is required");
    }

    const documentId = crypto.randomBytes(8).toString("hex");

    // 1. Chunk
    const chunks = this.chunker.chunk(text, {
      ...metadata,
      documentId,
      filename,
      kbId,
    });

    if (chunks.length === 0) {
      throw new Error("Document produced zero chunks (text may be too short or empty)");
    }

    // 2. Embed
    const chunkTexts = chunks.map((c) => c.text);
    const vectors = await this.embedder.embed(chunkTexts);

    // 3. Build Qdrant points
    const points = chunks.map((chunk, i) => ({
      id: this._pointId(documentId, i),
      vector: vectors[i],
      payload: {
        text: chunk.text,
        documentId,
        filename,
        kbId,
        chunkIndex: i,
        ...chunk.metadata,
      },
    }));

    // 4. Store in Qdrant
    await this.vectorStore.upsert(this._collectionName(kbId), points);

    // 4b. Update BM25 index
    const bm25 = this._getBM25Index(kbId);
    for (const point of points) {
      bm25.addDocument(String(point.id), point.payload.text);
    }
    this._saveBM25Index(kbId);

    // 5. Update metadata
    meta.documents.push({
      id: documentId,
      filename,
      chunkCount: chunks.length,
      charCount: text.length,
      addedAt: new Date().toISOString(),
    });
    meta.updatedAt = new Date().toISOString();
    this._saveMeta(kbId, meta);

    // Sync document record + KB stats to PocketBase (async, non-blocking)
    if (this._pbStore) {
      this._pbStore.createAsync("kb_documents", {
        kb_id: kbId,
        filename,
        file_type: metadata.mimeType || "",
        file_size: text.length,
        chunk_count: chunks.length,
        status: "ready",
        metadata: metadata || {},
      });
      // Update document_count on the KB record
      this._pbStore.findOne("knowledge_bases", `name='${pbEscape(meta.name)}'`).then((rec) => {
        if (rec) {
          this._pbStore.updateAsync("knowledge_bases", rec.id, {
            document_count: meta.documents.length,
          });
        }
      }).catch(() => {});
    }

    this.log("info", "kb_document_added", {
      component: "knowledge",
      kbId,
      documentId,
      filename,
      chunkCount: chunks.length,
    });

    return { documentId, chunkCount: chunks.length };
  }

  /**
   * Add a file to a knowledge base. Calls file-parser service to extract text.
   *
   * @param {string} kbId
   * @param {string|Buffer} filePathOrBuffer — path to file or Buffer
   * @param {string} originalName
   * @returns {Promise<{documentId: string, chunkCount: number}>}
   */
  async addFile(kbId, filePathOrBuffer, originalName) {
    const meta = this._loadMeta(kbId);
    if (!meta) throw new Error(`Knowledge base ${kbId} not found`);

    let buffer;
    if (Buffer.isBuffer(filePathOrBuffer)) {
      buffer = filePathOrBuffer;
    } else {
      buffer = fs.readFileSync(filePathOrBuffer);
    }

    // Call file-parser service
    const boundary = "----LumiGateKB" + crypto.randomBytes(8).toString("hex");
    const parts = [];
    parts.push(`--${boundary}\r\n`);
    parts.push(`Content-Disposition: form-data; name="file"; filename="${(originalName || "file").replace(/"/g, "_")}"\r\n`);
    parts.push(`Content-Type: application/octet-stream\r\n\r\n`);
    const header = Buffer.from(parts.join(""));
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, buffer, footer]);

    const res = await fetch(`${this.fileParserUrl}/parse`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`File parser error ${res.status}: ${errText.slice(0, 300)}`);
    }

    const parsed = await res.json();
    if (!parsed.ok || !parsed.text) {
      throw new Error(`File parser returned no text for ${originalName}`);
    }

    return this.addDocument(kbId, {
      text: parsed.text,
      filename: originalName || parsed.filename || "file",
      metadata: {
        mimeType: parsed.mimeType,
        pages: parsed.pages,
        source: "file-upload",
      },
    });
  }

  /**
   * Remove a document and all its vectors.
   * @param {string} kbId
   * @param {string} documentId
   */
  async removeDocument(kbId, documentId) {
    const meta = this._loadMeta(kbId);
    if (!meta) throw new Error(`Knowledge base ${kbId} not found`);

    const docIdx = meta.documents.findIndex((d) => d.id === documentId);
    if (docIdx < 0) throw new Error(`Document ${documentId} not found in KB ${kbId}`);

    const doc = meta.documents[docIdx];

    // Delete vectors by filter (all points with this documentId)
    await this.vectorStore.deleteByFilter(this._collectionName(kbId), {
      must: [{ key: "documentId", match: { value: documentId } }],
    });

    // Remove from BM25 index — remove all chunk point IDs for this document
    const bm25 = this._getBM25Index(kbId);
    for (let i = 0; i < (doc.chunkCount || 100); i++) {
      bm25.removeDocument(this._pointId(documentId, i));
    }
    this._saveBM25Index(kbId);

    // Update metadata
    meta.documents.splice(docIdx, 1);
    meta.updatedAt = new Date().toISOString();
    this._saveMeta(kbId, meta);

    this.log("info", "kb_document_removed", {
      component: "knowledge",
      kbId,
      documentId,
      filename: doc.filename,
    });
  }

  /**
   * List documents in a knowledge base.
   * @param {string} kbId
   * @returns {Promise<object[]>}
   */
  async listDocuments(kbId) {
    const meta = this._loadMeta(kbId);
    if (!meta) throw new Error(`Knowledge base ${kbId} not found`);
    return meta.documents || [];
  }

  // ── RAG retrieval ───────────────────────────────────────────────────────────

  /**
   * Retrieve relevant chunks from a knowledge base with full RAG pipeline.
   *
   * Pipeline: Query Transform -> Hybrid Search (Vector + BM25 + RRF) -> Rerank -> Compress -> Format
   *
   * @param {string} kbId
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.limit=5]
   * @param {'vector'|'bm25'|'hybrid'} [opts.strategy='hybrid']
   * @param {'none'|'hyde'|'multi_query'|'step_back'} [opts.queryTransform='none']
   * @param {boolean} [opts.rerank=true]            — use reranker if available
   * @param {boolean} [opts.compress=false]          — contextual compression
   * @param {number} [opts.scoreThreshold=0.5]
   * @param {boolean} [opts.parentRetrieval=true]    — return parent chunks when available
   * @returns {Promise<Array<{text: string, score: number, source: object}>>}
   */
  async retrieve(kbId, query, {
    limit = 5,
    strategy = "hybrid",
    queryTransform = "none",
    rerank = true,
    compress = false,
    scoreThreshold = 0.5,
    parentRetrieval = true,
  } = {}) {
    const meta = this._loadMeta(kbId);
    if (!meta) throw new Error(`Knowledge base ${kbId} not found`);
    if (!query || typeof query !== "string") throw new Error("Query is required");

    const collectionName = this._collectionName(kbId);

    // ── Step 1: Query Transformation ──────────────────────────────────────
    let searchQueries = [query];
    let embedQuery = query;

    if (this.queryTransformer && queryTransform !== "none") {
      try {
        switch (queryTransform) {
          case "hyde":
            embedQuery = await this.queryTransformer.hyde(query);
            break;
          case "multi_query":
            searchQueries = await this.queryTransformer.multiQuery(query);
            break;
          case "step_back":
            embedQuery = await this.queryTransformer.stepBack(query);
            searchQueries = [query, embedQuery]; // Search with both
            break;
        }
      } catch (err) {
        this.log("warn", "query_transform_failed", {
          component: "knowledge",
          kbId,
          transform: queryTransform,
          error: err.message,
        });
        // Fallback: use original query
      }
    }

    // ── Step 2: Search (Vector / BM25 / Hybrid) ──────────────────────────
    const fetchLimit = Math.max(limit * 3, 20); // Fetch extra for reranking
    let allResults = [];

    for (const sq of searchQueries) {
      const queryVector = await this.embedder.embedOne(
        queryTransform === "hyde" ? embedQuery : sq,
      );

      let results;
      if (strategy === "bm25") {
        // BM25-only search
        const bm25 = this._getBM25Index(kbId);
        const bm25Results = bm25.search(sq, { limit: fetchLimit });
        // Fetch payloads from Qdrant for the BM25 results
        results = await this._fetchPayloadsForBM25(collectionName, bm25Results);
      } else if (strategy === "hybrid") {
        // Hybrid: Vector + BM25 with RRF fusion
        const bm25 = this._getBM25Index(kbId);
        results = await this.vectorStore.hybridSearch(
          collectionName,
          queryVector,
          bm25,
          sq,
          { limit: fetchLimit, scoreThreshold },
        );
      } else {
        // Vector-only (original behavior)
        results = await this.vectorStore.search(
          collectionName,
          queryVector,
          { limit: fetchLimit, scoreThreshold },
        );
      }

      allResults.push(...results);
    }

    // Deduplicate by point ID (multi-query may produce duplicates)
    const seenIds = new Set();
    allResults = allResults.filter((r) => {
      const id = String(r.id);
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    // Sort by score descending
    allResults.sort((a, b) => b.score - a.score);

    // ── Step 3: Parent chunk retrieval ────────────────────────────────────
    if (parentRetrieval) {
      allResults = this._resolveParentChunks(allResults);
    }

    // Map to standard format
    let mapped = allResults.map((r) => ({
      text: r.payload?.text || "",
      score: r.score,
      source: {
        documentId: r.payload?.documentId,
        filename: r.payload?.filename,
        chunkIndex: r.payload?.chunkIndex,
        startChar: r.payload?.startChar,
        endChar: r.payload?.endChar,
        kbId,
        kbName: meta.name,
      },
      // Keep payload for reranker
      _payload: r.payload,
    }));

    // ── Step 4: Rerank ────────────────────────────────────────────────────
    if (rerank && this.reranker && this.reranker.isAvailable()) {
      try {
        const reranked = await this.reranker.rerank(query, mapped, { topK: fetchLimit });
        mapped = reranked.map((r) => ({
          ...r,
          score: r.relevanceScore ?? r.score,
        }));
      } catch (err) {
        this.log("warn", "rerank_failed", {
          component: "knowledge",
          kbId,
          error: err.message,
        });
      }
    }

    // Trim to requested limit
    mapped = mapped.slice(0, compress ? limit * 2 : limit);

    // ── Step 5: Contextual Compression ────────────────────────────────────
    if (compress && this.compressor) {
      try {
        mapped = await this.compressor.compress(query, mapped);
        mapped = mapped.slice(0, limit);
      } catch (err) {
        this.log("warn", "compress_failed", {
          component: "knowledge",
          kbId,
          error: err.message,
        });
        mapped = mapped.slice(0, limit);
      }
    }

    // Clean up internal fields
    return mapped.map(({ _payload, ...rest }) => rest);
  }

  /**
   * Resolve parent chunks: when a child chunk matches, replace its text
   * with the parent text for more context.
   * @param {Array<{id, score, payload}>} results
   * @returns {Array<{id, score, payload}>}
   */
  _resolveParentChunks(results) {
    const parentSeen = new Set();
    const resolved = [];

    for (const r of results) {
      if (r.payload?.isChildChunk && r.payload?.parentText) {
        const parentKey = `${r.payload.documentId}:${r.payload.parentIndex}`;
        if (parentSeen.has(parentKey)) continue; // Skip duplicate parents
        parentSeen.add(parentKey);

        resolved.push({
          ...r,
          payload: {
            ...r.payload,
            text: r.payload.parentText, // Use parent text instead of child
            originalChildText: r.payload.text,
          },
        });
      } else {
        resolved.push(r);
      }
    }

    return resolved;
  }

  /**
   * Fetch Qdrant payloads for BM25 results (which only have docId/score).
   * @param {string} collectionName
   * @param {Array<{docId: string, score: number}>} bm25Results
   * @returns {Promise<Array<{id, score, payload}>>}
   */
  async _fetchPayloadsForBM25(collectionName, bm25Results) {
    if (!bm25Results.length) return [];

    const results = [];
    const BATCH = 50;

    for (let i = 0; i < bm25Results.length; i += BATCH) {
      const batch = bm25Results.slice(i, i + BATCH);
      const ids = batch.map((r) => r.docId);

      try {
        const res = await this.vectorStore._request(
          "POST",
          `/collections/${encodeURIComponent(collectionName)}/points`,
          { ids, with_payload: true },
        );

        const points = res?.result || [];
        for (const point of points) {
          const bm25Entry = batch.find((b) => b.docId === String(point.id));
          results.push({
            id: point.id,
            score: bm25Entry?.score || 0,
            payload: point.payload,
          });
        }
      } catch (err) {
        this.log("warn", "bm25_payload_fetch_failed", {
          component: "knowledge",
          error: err.message,
        });
      }
    }

    return results;
  }

  /**
   * Retrieve from multiple knowledge bases and merge results.
   *
   * @param {string[]} kbIds
   * @param {string} query
   * @param {object} [opts] — same options as retrieve()
   * @returns {Promise<Array<{text: string, score: number, source: object}>>}
   */
  async retrieveMulti(kbIds, query, opts = {}) {
    if (!kbIds || kbIds.length === 0) return [];

    const limit = opts.limit || 5;
    // Query all KBs in parallel, request extra results per KB for better merge
    const perKbLimit = Math.max(limit, Math.ceil(limit * 1.5 / kbIds.length));
    const promises = kbIds.map((id) =>
      this.retrieve(id, query, { ...opts, limit: perKbLimit }).catch((err) => {
        this.log("warn", "kb_retrieve_error", {
          component: "knowledge",
          kbId: id,
          error: err.message,
        });
        return [];
      }),
    );

    const allResults = (await Promise.all(promises)).flat();

    // Sort by score descending, deduplicate by text hash, take top N
    const seen = new Set();
    return allResults
      .sort((a, b) => b.score - a.score)
      .filter((r) => {
        const key = r.text.slice(0, 200);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit);
  }

  /**
   * Format retrieved chunks into a context string with full citations.
   *
   * @param {Array<{text: string, score: number, source: object}>} results
   * @returns {string}
   */
  formatContext(results) {
    if (!results || results.length === 0) return "";

    const lines = results.map((r, i) => {
      const src = r.source || {};
      const parts = [];
      if (src.filename) parts.push(`source: "${src.filename}"`);
      if (src.startChar != null && src.endChar != null) {
        parts.push(`chars: ${src.startChar}-${src.endChar}`);
      }
      if (src.chunkIndex != null) {
        parts.push(`chunk: ${src.chunkIndex + 1}`);
      }
      parts.push(`relevance: ${(r.score * 100).toFixed(0)}%`);

      return `[${i + 1}] ${parts.join(", ")}\n> ${r.text.replace(/\n/g, "\n> ")}`;
    });

    return "Retrieved from knowledge base:\n\n" + lines.join("\n\n---\n\n");
  }

  // ── Chat integration ──────────────────────────────────────────────────────

  /**
   * Enrich chat context by retrieving from multiple KBs.
   * Designed to be called from the chat pipeline.
   *
   * @param {string[]} kbIds — knowledge base IDs to search
   * @param {string} userQuery — the user's question
   * @param {object} [opts]
   * @param {number} [opts.maxTokens=4000]          — token budget for context
   * @param {'vector'|'bm25'|'hybrid'} [opts.strategy='hybrid']
   * @param {'none'|'hyde'|'multi_query'|'step_back'} [opts.queryTransform='none']
   * @param {boolean} [opts.rerank=true]
   * @param {boolean} [opts.compress=false]
   * @returns {Promise<{context: string, citations: Array, tokensUsed: number}>}
   */
  async enrichChatContext(kbIds, userQuery, {
    maxTokens = 4000,
    strategy = "hybrid",
    queryTransform = "none",
    rerank = true,
    compress = false,
  } = {}) {
    if (!kbIds || kbIds.length === 0 || !userQuery) {
      return { context: "", citations: [], tokensUsed: 0 };
    }

    // Retrieve more results than typical, then truncate to token budget
    const results = await this.retrieveMulti(kbIds, userQuery, {
      limit: 10,
      strategy,
      queryTransform,
      rerank,
      compress,
      scoreThreshold: 0.3,
    });

    if (results.length === 0) {
      return { context: "", citations: [], tokensUsed: 0 };
    }

    // Build context string, truncating to fit within token budget
    // Rough estimate: 1 token ~= 4 characters
    const maxChars = maxTokens * 4;
    const citations = [];
    const contextParts = [];
    let totalChars = 0;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const src = r.source || {};
      const citation = {
        index: i + 1,
        filename: src.filename || "unknown",
        chunkIndex: src.chunkIndex,
        relevance: r.score,
        kbId: src.kbId,
        kbName: src.kbName,
      };

      const citParts = [];
      if (src.filename) citParts.push(`source: "${src.filename}"`);
      if (src.chunkIndex != null) citParts.push(`chunk: ${src.chunkIndex + 1}`);
      citParts.push(`relevance: ${(r.score * 100).toFixed(0)}%`);

      const entry = `[${i + 1}] ${citParts.join(", ")}\n> ${r.text.replace(/\n/g, "\n> ")}`;

      if (totalChars + entry.length > maxChars && contextParts.length > 0) {
        break; // Token budget exceeded
      }

      contextParts.push(entry);
      citations.push(citation);
      totalChars += entry.length;
    }

    const context = contextParts.length > 0
      ? "Retrieved from knowledge base:\n\n" + contextParts.join("\n\n---\n\n")
      : "";

    return {
      context,
      citations,
      tokensUsed: Math.ceil(totalChars / 4),
    };
  }

  // ── RAG Orchestrator integration ──────────────────────────────────────────────

  /**
   * Advanced RAG retrieval via the orchestrator pipeline.
   * Delegates to RAGOrchestrator for adaptive, self-correcting retrieval.
   *
   * Requires setOrchestrator() to be called first; otherwise falls back to
   * simple retrieveMulti().
   *
   * @param {string} query
   * @param {string[]} kbIds
   * @param {object} [options]        — passed through to RAGOrchestrator.orchestrate()
   * @returns {Promise<{context: string, citations: Array, strategy: string, retrievalStats: object, fallbackUsed: boolean}>}
   */
  async orchestrate(query, kbIds, options = {}) {
    if (this._orchestrator) {
      return this._orchestrator.orchestrate(query, kbIds, options);
    }

    // Fallback: no orchestrator wired — use simple retrieval
    this.log("warn", "kb_orchestrate_no_orchestrator", {
      component: "knowledge",
      msg: "RAGOrchestrator not configured, falling back to simple retrieval",
    });

    const results = await this.retrieveMulti(kbIds, query, {
      limit: options.maxChunks || 5,
      scoreThreshold: options.scoreThreshold ?? 0.7,
    });

    return {
      context: this.formatContext(results),
      citations: results.map((r) => ({
        text: (r.text || "").slice(0, 150),
        source: r.source?.filename || "unknown",
        documentId: r.source?.documentId || null,
        score: r.score || 0,
      })),
      strategy: "simple_fallback",
      retrievalStats: { chunksRetrieved: results.length },
      fallbackUsed: false,
    };
  }

  /**
   * Wire the RAG orchestrator instance.
   * Called by the service factory (index.js) after construction.
   *
   * @param {import('./orchestrator').RAGOrchestrator} orchestrator
   */
  setOrchestrator(orchestrator) {
    this._orchestrator = orchestrator;
  }
}

module.exports = { KnowledgeBaseManager, COLLECTION_PREFIX };
