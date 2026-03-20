"use strict";

/**
 * services/knowledge/query-transform.js — Query transformation strategies for RAG.
 *
 * Techniques:
 *  - HyDE: Hypothetical Document Embedding — embed a generated answer, not the query
 *  - Multi-query: Rephrase from multiple angles for better recall
 *  - Step-back: Broaden the query for conceptual retrieval
 */

class QueryTransformer {
  /**
   * @param {object} opts
   * @param {function} opts.llmFetch — async function(messages, opts) => string
   *   messages: [{role, content}], opts: {model, temperature, maxTokens}
   *   Returns the assistant's response text.
   * @param {function} [opts.log]
   */
  constructor({ llmFetch, log } = {}) {
    if (!llmFetch) throw new Error("QueryTransformer requires llmFetch function");
    this.llmFetch = llmFetch;
    this.log = log || (() => {});
  }

  /**
   * HyDE: Generate a hypothetical document that would answer the query,
   * then use that document's embedding for retrieval instead of the raw query.
   *
   * @param {string} query
   * @returns {Promise<string>} — the hypothetical passage (to be embedded)
   */
  async hyde(query) {
    this.log("info", "query_transform_hyde", { component: "query-transform", query: query.slice(0, 100) });

    const prompt = `Write a short, factual passage (2-4 sentences) that would directly answer the following question. Do not include any preamble or explanation — just the passage content as if it were extracted from an authoritative document.

Question: ${query}`;

    try {
      const response = await this.llmFetch(
        [{ role: "user", content: prompt }],
        { temperature: 0.3, maxTokens: 300 },
      );
      return response || query; // Fallback to original query on empty response
    } catch (err) {
      this.log("warn", "query_transform_hyde_failed", {
        component: "query-transform",
        error: err.message,
      });
      return query; // Graceful fallback
    }
  }

  /**
   * Multi-query: Generate multiple reformulations of the query from different angles.
   * Search with each, then merge results for better recall.
   *
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.count=3] — number of query variants to generate
   * @returns {Promise<string[]>} — array of query strings (includes original)
   */
  async multiQuery(query, { count = 3 } = {}) {
    this.log("info", "query_transform_multi_query", { component: "query-transform", query: query.slice(0, 100), count });

    const prompt = `Generate ${count} different versions of the following search query. Each version should approach the topic from a different angle or use different keywords to improve search recall. Return ONLY a JSON array of strings, no explanation.

Original query: ${query}

Example output: ["version 1", "version 2", "version 3"]`;

    try {
      const response = await this.llmFetch(
        [{ role: "user", content: prompt }],
        { temperature: 0.7, maxTokens: 500 },
      );

      let variants;
      try {
        const match = response.match(/\[[\s\S]*\]/);
        variants = match ? JSON.parse(match[0]) : [];
      } catch {
        variants = [];
      }

      // Ensure we have valid strings, prepend original query
      const valid = variants.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim());
      return [query, ...valid.slice(0, count)];
    } catch (err) {
      this.log("warn", "query_transform_multi_query_failed", {
        component: "query-transform",
        error: err.message,
      });
      return [query]; // Fallback to just the original
    }
  }

  /**
   * Step-back: Generate a broader, more general version of the query.
   * Useful when the original query is too specific to match relevant documents.
   *
   * @param {string} query
   * @returns {Promise<string>} — the step-back query
   */
  async stepBack(query) {
    this.log("info", "query_transform_step_back", { component: "query-transform", query: query.slice(0, 100) });

    const prompt = `Given the following specific question, generate a broader, more general question that would help retrieve background knowledge needed to answer the original question. Return ONLY the broader question, nothing else.

Specific question: ${query}

Example:
- Specific: "What specific Python error causes a TypeError when adding str and int?"
- Broader: "How does Python type coercion and error handling work?"

Broader question:`;

    try {
      const response = await this.llmFetch(
        [{ role: "user", content: prompt }],
        { temperature: 0.3, maxTokens: 150 },
      );
      return (response || "").trim() || query;
    } catch (err) {
      this.log("warn", "query_transform_step_back_failed", {
        component: "query-transform",
        error: err.message,
      });
      return query;
    }
  }
}

module.exports = { QueryTransformer };
