"use strict";

/**
 * services/knowledge/compressor.js — Contextual compression for RAG.
 *
 * Extracts only the relevant parts from retrieved chunks and filters
 * out documents that are actually irrelevant despite high similarity scores.
 */

class ContextualCompressor {
  /**
   * @param {object} opts
   * @param {function} opts.llmFetch — async function(messages, opts) => string
   * @param {function} [opts.log]
   */
  constructor({ llmFetch, log } = {}) {
    if (!llmFetch) throw new Error("ContextualCompressor requires llmFetch function");
    this.llmFetch = llmFetch;
    this.log = log || (() => {});
  }

  /**
   * Extract only the relevant parts from retrieved documents.
   * For each document, asks an LLM to extract only the parts relevant to the query.
   *
   * @param {string} query
   * @param {Array<{text: string, [key: string]: any}>} documents
   * @returns {Promise<Array<{text: string, originalText: string, [key: string]: any}>>}
   */
  async compress(query, documents) {
    if (!documents || documents.length === 0) return [];

    this.log("info", "contextual_compress", {
      component: "compressor",
      query: query.slice(0, 100),
      docCount: documents.length,
    });

    // Process documents in parallel (bounded concurrency)
    const CONCURRENCY = 5;
    const results = [];

    for (let i = 0; i < documents.length; i += CONCURRENCY) {
      const batch = documents.slice(i, i + CONCURRENCY);
      const compressed = await Promise.all(
        batch.map((doc) => this._compressOne(query, doc)),
      );
      results.push(...compressed);
    }

    // Filter out docs that compressed to empty
    return results.filter((d) => d.text.trim().length > 0);
  }

  /**
   * Compress a single document.
   * @param {string} query
   * @param {{text: string, [key: string]: any}} doc
   * @returns {Promise<{text: string, originalText: string, [key: string]: any}>}
   */
  async _compressOne(query, doc) {
    const prompt = `Given the following document and a user query, extract ONLY the sentences and information that are directly relevant to answering the query. If nothing is relevant, respond with "IRRELEVANT".

Do not add any explanation, commentary, or new information. Just extract the relevant parts verbatim.

Query: ${query}

Document:
${doc.text}

Relevant extract:`;

    try {
      const response = await this.llmFetch(
        [{ role: "user", content: prompt }],
        { temperature: 0, maxTokens: Math.max(200, Math.ceil(doc.text.length * 0.8)) },
      );

      const extracted = (response || "").trim();

      if (extracted === "IRRELEVANT" || extracted.length === 0) {
        return { ...doc, text: "", originalText: doc.text };
      }

      return { ...doc, text: extracted, originalText: doc.text };
    } catch (err) {
      this.log("warn", "compress_one_failed", {
        component: "compressor",
        error: err.message,
      });
      // On error, keep original text
      return { ...doc, originalText: doc.text };
    }
  }

  /**
   * Filter: Remove documents that are actually irrelevant despite high similarity scores.
   * Each document is scored 0-1 by an LLM for relevance.
   *
   * @param {string} query
   * @param {Array<{text: string, [key: string]: any}>} documents
   * @param {object} [opts]
   * @param {number} [opts.threshold=0.5] — minimum relevance score (0-1) to keep
   * @returns {Promise<Array<{text: string, filterScore: number, [key: string]: any}>>}
   */
  async filter(query, documents, { threshold = 0.5 } = {}) {
    if (!documents || documents.length === 0) return [];

    this.log("info", "contextual_filter", {
      component: "compressor",
      query: query.slice(0, 100),
      docCount: documents.length,
      threshold,
    });

    // Build a batch prompt for efficiency
    const docList = documents
      .map((d, i) => `[Doc ${i}]: ${d.text.slice(0, 400)}`)
      .join("\n\n");

    const prompt = `You are a relevance filter. Given a query and documents, score each document's relevance to the query from 0.0 to 1.0 (1.0 = highly relevant, 0.0 = irrelevant).

Respond with ONLY a JSON array of numbers, e.g. [0.9, 0.2, 0.7]. No explanation.

Query: ${query}

${docList}`;

    try {
      const response = await this.llmFetch(
        [{ role: "user", content: prompt }],
        { temperature: 0, maxTokens: 200 },
      );

      let scores;
      try {
        const match = response.match(/\[[\d\s,.]+\]/);
        scores = match ? JSON.parse(match[0]) : [];
      } catch {
        scores = [];
      }

      return documents
        .map((d, i) => ({
          ...d,
          filterScore: typeof scores[i] === "number" ? scores[i] : 1,
        }))
        .filter((d) => d.filterScore >= threshold);
    } catch (err) {
      this.log("warn", "contextual_filter_failed", {
        component: "compressor",
        error: err.message,
      });
      // On error, pass all documents through
      return documents.map((d) => ({ ...d, filterScore: 1 }));
    }
  }
}

module.exports = { ContextualCompressor };
