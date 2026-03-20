"use strict";

/**
 * services/knowledge/embedder.js — Embedding service abstraction.
 *
 * Supports:
 *  - OpenAI:  text-embedding-3-small (1536d), text-embedding-3-large (3072d)
 *  - Ollama:  nomic-embed-text (768d, free, self-hosted)
 *
 * Uses native fetch. Reads API keys from gateway config or env vars.
 */

const fs = require("fs");
const path = require("path");

/** Provider-specific default models and dimensions. */
const PROVIDER_DEFAULTS = {
  openai: { model: "text-embedding-3-small", dimension: 1536 },
  ollama: { model: "nomic-embed-text", dimension: 768 },
};

class Embedder {
  /**
   * @param {object} opts
   * @param {'openai'|'ollama'} [opts.provider='openai']
   * @param {string} [opts.apiKey]          — OpenAI API key (reads from gateway config if omitted)
   * @param {string} [opts.model]           — embedding model ID
   * @param {string} [opts.baseUrl]         — custom API base URL
   * @param {number} [opts.batchSize=128]   — max texts per API call
   * @param {function} [opts.log]
   */
  constructor({ provider = "openai", apiKey, model, baseUrl, batchSize, log } = {}) {
    this.provider = provider.toLowerCase();
    this.apiKey = apiKey || "";
    this.model = model || PROVIDER_DEFAULTS[this.provider]?.model || "text-embedding-3-small";
    this.dimension = PROVIDER_DEFAULTS[this.provider]?.dimension || 1536;
    this.batchSize = batchSize || 128;
    this.log = log || (() => {});

    // Resolve base URL per provider
    if (baseUrl) {
      this.baseUrl = baseUrl.replace(/\/+$/, "");
    } else if (this.provider === "ollama") {
      this.baseUrl = process.env.OLLAMA_URL || "http://localhost:11434";
    } else {
      this.baseUrl = "https://api.openai.com";
    }

    // Auto-resolve API key from gateway projects.json if not explicitly set
    if (!this.apiKey && this.provider === "openai") {
      this.apiKey = this._resolveApiKey();
    }
  }

  /**
   * Try to read OpenAI API key from gateway's projects.json (best-effort).
   * Falls back to OPENAI_API_KEY env var.
   * @returns {string}
   */
  _resolveApiKey() {
    // env var first
    if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;

    // Try reading from gateway projects.json
    try {
      const projectsPath = path.resolve(__dirname, "../../data/projects.json");
      const projects = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
      for (const p of projects) {
        if (p.keys) {
          for (const k of p.keys) {
            if (k.provider === "openai" && k.key) return k.key;
          }
        }
      }
    } catch {
      // silent — projects.json may not exist in all envs
    }
    return "";
  }

  /**
   * Generate embeddings for an array of texts.
   * Automatically batches to respect provider limits.
   *
   * @param {string[]} texts
   * @returns {Promise<number[][]>} — array of embedding vectors
   */
  async embed(texts) {
    if (!texts || texts.length === 0) return [];

    const results = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const vectors = await this._embedBatch(batch);
      results.push(...vectors);
    }
    return results;
  }

  /**
   * Embed a single text (convenience).
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async embedOne(text) {
    const [vector] = await this.embed([text]);
    return vector;
  }

  /**
   * @returns {number} — dimension of the embedding model
   */
  getDimension() {
    // Override dimension for known models
    const KNOWN = {
      "text-embedding-3-small": 1536,
      "text-embedding-3-large": 3072,
      "text-embedding-ada-002": 1536,
      "nomic-embed-text": 768,
      "mxbai-embed-large": 1024,
      "all-minilm": 384,
    };
    return KNOWN[this.model] || this.dimension;
  }

  // ── Provider-specific implementations ───────────────────────────────────────

  /**
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async _embedBatch(texts) {
    if (this.provider === "ollama") return this._embedOllama(texts);
    return this._embedOpenAI(texts);
  }

  /**
   * OpenAI embeddings API.
   * POST /v1/embeddings { model, input }
   */
  async _embedOpenAI(texts) {
    if (!this.apiKey) {
      throw new Error("Embedder: OpenAI API key not configured (set OPENAI_API_KEY or provide apiKey)");
    }

    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Embedder OpenAI error ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = await res.json();
    // OpenAI returns data sorted by index
    const sorted = (json.data || []).sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }

  /**
   * Ollama embeddings API.
   * POST /api/embeddings { model, prompt } (one at a time)
   * or POST /api/embed { model, input } (batch, Ollama 0.4+)
   */
  async _embedOllama(texts) {
    // Try batch API first (Ollama 0.4+)
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
      if (res.ok) {
        const json = await res.json();
        if (json.embeddings && json.embeddings.length === texts.length) {
          return json.embeddings;
        }
      }
    } catch {
      // fall through to single-request approach
    }

    // Fallback: one request per text
    const results = [];
    for (const text of texts) {
      const res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Embedder Ollama error ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = await res.json();
      results.push(json.embedding);
    }
    return results;
  }
}

module.exports = { Embedder, PROVIDER_DEFAULTS };
