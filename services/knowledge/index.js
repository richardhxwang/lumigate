"use strict";

/**
 * services/knowledge/index.js — Knowledge Base service barrel export.
 *
 * Usage:
 *   const { createKnowledgeService } = require('./services/knowledge');
 *   const kb = createKnowledgeService({ log });
 *   await kb.manager.create({ name: 'My KB' });
 */

const { VectorStore } = require("./vector-store");
const { Embedder, PROVIDER_DEFAULTS } = require("./embedder");
const { Chunker } = require("./chunker");
const { BM25Index, tokenize } = require("./bm25");
const { Reranker } = require("./reranker");
const { QueryTransformer } = require("./query-transform");
const { ContextualCompressor } = require("./compressor");
const { KnowledgeBaseManager, COLLECTION_PREFIX } = require("./manager");
const { RAGOrchestrator, RAG_STRATEGIES } = require("./orchestrator");
const { RAGFlowClient } = require("./ragflow-client");
const { RAGAdapter } = require("./rag-adapter");

/**
 * Factory: create a fully wired knowledge service instance.
 *
 * @param {object} [opts]
 * @param {string} [opts.qdrantUrl]
 * @param {string} [opts.qdrantApiKey]
 * @param {string} [opts.embeddingProvider]  — 'openai' or 'ollama'
 * @param {string} [opts.embeddingApiKey]
 * @param {string} [opts.embeddingModel]
 * @param {string} [opts.embeddingBaseUrl]
 * @param {number} [opts.chunkSize]
 * @param {number} [opts.chunkOverlap]
 * @param {string} [opts.chunkStrategy]      — 'recursive' | 'semantic' | 'fixed' | 'parentChild'
 * @param {number} [opts.parentChunkSize]    — parent chunk size for parentChild strategy
 * @param {number} [opts.childChunkSize]     — child chunk size for parentChild strategy
 * @param {string} [opts.dataDir]
 * @param {string} [opts.fileParserUrl]
 * @param {function} [opts.llmFetch]         — async (messages, opts?) => string, for RAG orchestrator
 * @param {function} [opts.webSearchFn]      — async (query) => results, for RAG fallback
 * @param {string} [opts.rerankerProvider]   — 'cohere' | 'llm' | 'ollama' | 'none'
 * @param {string} [opts.rerankerApiKey]
 * @param {string} [opts.rerankerModel]
 * @param {string} [opts.rerankerBaseUrl]
 * @param {function} [opts.log]
 * @returns {{ vectorStore, embedder, chunker, manager, orchestrator, reranker, queryTransformer, compressor }}
 */
function createKnowledgeService(opts = {}) {
  const log = opts.log || (() => {});

  const vectorStore = new VectorStore({
    qdrantUrl: opts.qdrantUrl,
    apiKey: opts.qdrantApiKey,
    log,
  });

  const embedder = new Embedder({
    provider: opts.embeddingProvider,
    apiKey: opts.embeddingApiKey,
    model: opts.embeddingModel,
    baseUrl: opts.embeddingBaseUrl,
    log,
  });

  const chunker = new Chunker({
    chunkSize: opts.chunkSize,
    overlap: opts.chunkOverlap,
    strategy: opts.chunkStrategy,
    parentChunkSize: opts.parentChunkSize,
    childChunkSize: opts.childChunkSize,
  });

  // ── RAG pipeline components (optional, degrade gracefully) ──────────────

  const reranker = new Reranker({
    provider: opts.rerankerProvider || "none",
    apiKey: opts.rerankerApiKey,
    model: opts.rerankerModel,
    baseUrl: opts.rerankerBaseUrl,
    log,
  });

  let queryTransformer = null;
  if (opts.llmFetch) {
    queryTransformer = new QueryTransformer({ llmFetch: opts.llmFetch, log });
  }

  let compressor = null;
  if (opts.llmFetch) {
    compressor = new ContextualCompressor({ llmFetch: opts.llmFetch, log });
  }

  const manager = new KnowledgeBaseManager({
    vectorStore,
    embedder,
    chunker,
    dataDir: opts.dataDir,
    fileParserUrl: opts.fileParserUrl,
    reranker,
    queryTransformer,
    compressor,
    pbStore: opts.pbStore,
    log,
  });

  // Wire the RAG orchestrator into the manager
  const orchestrator = new RAGOrchestrator({
    knowledgeManager: manager,
    llmFetch: opts.llmFetch || null,
    webSearchFn: opts.webSearchFn || null,
    log,
  });
  manager.setOrchestrator(orchestrator);

  return {
    vectorStore,
    embedder,
    chunker,
    manager,
    orchestrator,
    reranker,
    queryTransformer,
    compressor,
  };
}

module.exports = {
  createKnowledgeService,
  VectorStore,
  Embedder,
  Chunker,
  BM25Index,
  Reranker,
  QueryTransformer,
  ContextualCompressor,
  KnowledgeBaseManager,
  RAGOrchestrator,
  RAG_STRATEGIES,
  PROVIDER_DEFAULTS,
  COLLECTION_PREFIX,
  RAGFlowClient,
  RAGAdapter,
};
