"use strict";

/**
 * services/memory/index.js — User Memory service barrel export + factory.
 *
 * Usage:
 *   const { createUserMemoryService } = require('./services/memory');
 *   const userMemory = createUserMemoryService({ vectorStore, embedder, pbStore, llmFetch, log });
 */

const { VectorStore } = require("../knowledge/vector-store");
const { Embedder } = require("../knowledge/embedder");
const {
  UserMemory,
  COLLECTION_PREFIX,
  PB_MEMORIES_COLLECTION,
  PB_PROFILES_COLLECTION,
  MAX_MEMORIES_PER_USER,
} = require("./user-memory");

/**
 * Factory: create a fully wired UserMemory instance.
 *
 * @param {object} opts
 * @param {string} [opts.qdrantUrl]          — Qdrant URL (default: env QDRANT_URL)
 * @param {string} [opts.qdrantApiKey]       — Qdrant API key (optional)
 * @param {string} [opts.embeddingProvider]  — 'openai' or 'ollama'
 * @param {string} [opts.embeddingApiKey]    — API key for embedding
 * @param {string} [opts.embeddingModel]     — embedding model ID
 * @param {string} [opts.embeddingBaseUrl]   — custom embedding API URL
 * @param {import('../pb-store').PBStore} opts.pbStore — PB store instance
 * @param {function} opts.llmFetch           — async (messages, opts?) => string
 * @param {function} [opts.log]
 * @returns {UserMemory}
 */
function createUserMemoryService(opts = {}) {
  const log = opts.log || (() => {});

  const vectorStore = opts.vectorStore || new VectorStore({
    qdrantUrl: opts.qdrantUrl,
    apiKey: opts.qdrantApiKey,
    log,
  });

  const embedder = opts.embedder || new Embedder({
    provider: opts.embeddingProvider,
    apiKey: opts.embeddingApiKey,
    model: opts.embeddingModel,
    baseUrl: opts.embeddingBaseUrl,
    log,
  });

  return new UserMemory({
    vectorStore,
    embedder,
    pbStore: opts.pbStore,
    llmFetch: opts.llmFetch,
    log,
  });
}

module.exports = {
  createUserMemoryService,
  UserMemory,
  COLLECTION_PREFIX,
  PB_MEMORIES_COLLECTION,
  PB_PROFILES_COLLECTION,
  MAX_MEMORIES_PER_USER,
};
