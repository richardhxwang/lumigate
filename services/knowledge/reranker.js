"use strict";

/**
 * services/knowledge/reranker.js — Cross-encoder reranking for RAG.
 *
 * Supports:
 *  - Cohere Rerank API (rerank-v3.5)
 *  - LLM-based reranking (gpt-4.1-nano or any small model via OpenAI-compatible API)
 *  - BGE reranker via Ollama (if available locally)
 *
 * If no provider is configured, reranking is skipped (passthrough).
 */

class Reranker {
  /**
   * @param {object} opts
   * @param {'cohere'|'llm'|'ollama'|'none'} [opts.provider='none']
   * @param {string} [opts.apiKey]    — Cohere API key or OpenAI-compatible key
   * @param {string} [opts.model]     — Model ID for the chosen provider
   * @param {string} [opts.baseUrl]   — Custom API base URL
   * @param {function} [opts.log]
   */
  constructor({ provider = "none", apiKey, model, baseUrl, log } = {}) {
    this.provider = provider.toLowerCase();
    this.apiKey = apiKey || "";
    this.model = model || this._defaultModel();
    this.baseUrl = baseUrl || this._defaultBaseUrl();
    this.log = log || (() => {});
  }

  _defaultModel() {
    switch (this.provider) {
      case "cohere": return "rerank-v3.5";
      case "llm": return "gpt-4.1-nano";
      case "ollama": return "bge-reranker-v2-m3";
      default: return "";
    }
  }

  _defaultBaseUrl() {
    switch (this.provider) {
      case "cohere": return "https://api.cohere.com";
      case "llm": return "https://api.openai.com";
      case "ollama": return process.env.OLLAMA_URL || "http://localhost:11434";
      default: return "";
    }
  }

  /**
   * Check if this reranker is functional (has credentials/provider).
   * @returns {boolean}
   */
  isAvailable() {
    if (this.provider === "none") return false;
    if (this.provider === "ollama") return true; // no key needed
    return !!this.apiKey;
  }

  /**
   * Rerank retrieved documents against a query.
   *
   * @param {string} query
   * @param {Array<{text: string, [key: string]: any}>} documents
   * @param {object} [opts]
   * @param {number} [opts.topK=5]
   * @returns {Promise<Array<{text: string, relevanceScore: number, [key: string]: any}>>}
   */
  async rerank(query, documents, { topK = 5 } = {}) {
    if (!documents || documents.length === 0) return [];
    if (!this.isAvailable()) {
      // Passthrough: return docs as-is with synthetic scores
      return documents.slice(0, topK).map((d, i) => ({
        ...d,
        relevanceScore: d.score ?? (1 - i * 0.05),
      }));
    }

    try {
      switch (this.provider) {
        case "cohere": return await this._rerankCohere(query, documents, topK);
        case "llm": return await this._rerankLLM(query, documents, topK);
        case "ollama": return await this._rerankOllama(query, documents, topK);
        default: return documents.slice(0, topK).map((d) => ({ ...d, relevanceScore: d.score ?? 0 }));
      }
    } catch (err) {
      this.log("warn", "rerank_error", {
        component: "reranker",
        provider: this.provider,
        error: err.message,
      });
      // Graceful fallback: return original order
      return documents.slice(0, topK).map((d) => ({ ...d, relevanceScore: d.score ?? 0 }));
    }
  }

  // ── Cohere Rerank ──────────────────────────────────────────────────────────

  async _rerankCohere(query, documents, topK) {
    const res = await fetch(`${this.baseUrl}/v2/rerank`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: documents.map((d) => d.text),
        top_n: topK,
        return_documents: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Cohere rerank error ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = await res.json();
    const results = (json.results || []).map((r) => ({
      ...documents[r.index],
      relevanceScore: r.relevance_score,
    }));

    return results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  // ── LLM-based Rerank (OpenAI-compatible) ───────────────────────────────────

  async _rerankLLM(query, documents, topK) {
    // Score each document in a single prompt (batch)
    const docList = documents.map((d, i) => `[Doc ${i}]: ${d.text.slice(0, 500)}`).join("\n\n");

    const prompt = `You are a relevance scoring system. Given a query and a list of documents, score each document's relevance to the query on a scale of 0-10 (10 = perfectly relevant, 0 = completely irrelevant).

Query: ${query}

Documents:
${docList}

Respond with ONLY a JSON array of scores in order, e.g. [8, 3, 7, ...]. No explanation.`;

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 200,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`LLM rerank error ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = await res.json();
    const content = json.choices?.[0]?.message?.content || "";

    // Parse the JSON array of scores
    let scores;
    try {
      const match = content.match(/\[[\d\s,.]+\]/);
      scores = match ? JSON.parse(match[0]) : [];
    } catch {
      scores = [];
    }

    // Map scores to documents
    const scored = documents.map((d, i) => ({
      ...d,
      relevanceScore: (scores[i] ?? 0) / 10, // Normalize to 0-1
    }));

    return scored
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, topK);
  }

  // ── Ollama BGE Reranker ────────────────────────────────────────────────────

  async _rerankOllama(query, documents, topK) {
    // Use Ollama's generate endpoint to score each doc
    // Batch them in a single prompt for efficiency
    const docList = documents.map((d, i) => `[${i}] ${d.text.slice(0, 400)}`).join("\n");

    const prompt = `Score each document's relevance to the query (0-10). Reply ONLY with a JSON array of numbers.
Query: ${query}
Documents:
${docList}`;

    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        options: { temperature: 0 },
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama rerank error ${res.status}`);
    }

    const json = await res.json();
    const content = json.response || "";

    let scores;
    try {
      const match = content.match(/\[[\d\s,.]+\]/);
      scores = match ? JSON.parse(match[0]) : [];
    } catch {
      scores = [];
    }

    const scored = documents.map((d, i) => ({
      ...d,
      relevanceScore: (scores[i] ?? 0) / 10,
    }));

    return scored
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, topK);
  }
}

module.exports = { Reranker };
