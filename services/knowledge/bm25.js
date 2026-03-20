"use strict";

/**
 * services/knowledge/bm25.js — BM25 keyword search index.
 *
 * Pure JS implementation with no external dependencies.
 * Supports English + Chinese tokenization (character-level for CJK).
 * Persistence via JSON serialize/deserialize.
 */

const fs = require("fs");
const path = require("path");

// ── Stopwords ───────────────────────────────────────────────────────────────

const ENGLISH_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could", "should",
  "may", "might", "shall", "can", "need", "must", "it", "its", "this", "that",
  "these", "those", "i", "me", "my", "we", "our", "you", "your", "he", "him",
  "his", "she", "her", "they", "them", "their", "what", "which", "who", "whom",
  "when", "where", "why", "how", "not", "no", "nor", "so", "if", "then", "than",
  "too", "very", "just", "about", "above", "after", "again", "all", "also", "am",
  "any", "because", "before", "between", "both", "each", "few", "here", "into",
  "more", "most", "other", "out", "over", "own", "same", "some", "such", "there",
  "through", "under", "until", "up", "while", "as",
]);

const CHINESE_STOPWORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
  "没有", "看", "好", "自己", "这", "他", "她", "它", "们", "那", "些",
  "什么", "吗", "吧", "呢", "啊", "哦", "嗯", "把", "被", "让", "给",
  "从", "向", "对", "以", "而", "为", "与", "或", "但", "如果", "因为",
  "所以", "可以", "这个", "那个", "没", "能", "得", "地", "还",
]);

// CJK Unicode ranges
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

/**
 * Tokenize text: split on whitespace + punctuation, lowercase, remove stopwords.
 * For Chinese characters, split each character as a separate token.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text) return [];

  const tokens = [];
  // Split by whitespace and punctuation (but keep CJK chars intact for separate handling)
  const rawTokens = text.toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean);

  for (const token of rawTokens) {
    if (CJK_REGEX.test(token)) {
      // Split CJK text into individual characters
      for (const ch of token) {
        if (CJK_REGEX.test(ch) && !CHINESE_STOPWORDS.has(ch)) {
          tokens.push(ch);
        } else if (!CJK_REGEX.test(ch) && ch.length > 1) {
          // Non-CJK part mixed in
          const lower = ch.toLowerCase();
          if (!ENGLISH_STOPWORDS.has(lower) && lower.length > 1) {
            tokens.push(lower);
          }
        }
      }
    } else {
      if (!ENGLISH_STOPWORDS.has(token) && token.length > 1) {
        tokens.push(token);
      }
    }
  }

  return tokens;
}

class BM25Index {
  /**
   * @param {object} [opts]
   * @param {number} [opts.k1=1.2] — term frequency saturation parameter
   * @param {number} [opts.b=0.75] — document length normalization
   */
  constructor({ k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;

    /** @type {Map<string, Map<string, number>>} term -> { docId -> termFreq } */
    this.invertedIndex = new Map();

    /** @type {Map<string, number>} docId -> document length (token count) */
    this.docLengths = new Map();

    /** @type {number} total document count */
    this.docCount = 0;

    /** @type {number} average document length */
    this.avgDocLength = 0;
  }

  /**
   * Add a document to the index.
   * @param {string} docId
   * @param {string} text
   */
  addDocument(docId, text) {
    // Remove old entry if exists
    this.removeDocument(docId);

    const tokens = tokenize(text);
    this.docLengths.set(docId, tokens.length);
    this.docCount++;

    // Count term frequencies
    const tf = new Map();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    // Update inverted index
    for (const [term, freq] of tf) {
      if (!this.invertedIndex.has(term)) {
        this.invertedIndex.set(term, new Map());
      }
      this.invertedIndex.get(term).set(docId, freq);
    }

    // Recompute average doc length
    this._recomputeAvgLength();
  }

  /**
   * Remove a document from the index.
   * @param {string} docId
   */
  removeDocument(docId) {
    if (!this.docLengths.has(docId)) return;

    // Remove from inverted index
    for (const [term, postings] of this.invertedIndex) {
      postings.delete(docId);
      if (postings.size === 0) {
        this.invertedIndex.delete(term);
      }
    }

    this.docLengths.delete(docId);
    this.docCount--;
    this._recomputeAvgLength();
  }

  /**
   * Search the index.
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.limit=20]
   * @returns {Array<{docId: string, score: number}>}
   */
  search(query, { limit = 20 } = {}) {
    if (this.docCount === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    /** @type {Map<string, number>} docId -> BM25 score */
    const scores = new Map();

    for (const term of queryTokens) {
      const postings = this.invertedIndex.get(term);
      if (!postings) continue;

      // IDF: log((N - n + 0.5) / (n + 0.5) + 1)
      const n = postings.size;
      const idf = Math.log((this.docCount - n + 0.5) / (n + 0.5) + 1);

      for (const [docId, tf] of postings) {
        const dl = this.docLengths.get(docId) || 0;
        // BM25 term score
        const tfNorm = (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * dl / this.avgDocLength));
        const termScore = idf * tfNorm;

        scores.set(docId, (scores.get(docId) || 0) + termScore);
      }
    }

    // Sort by score descending
    return Array.from(scores.entries())
      .map(([docId, score]) => ({ docId, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Recompute average document length. */
  _recomputeAvgLength() {
    if (this.docCount === 0) {
      this.avgDocLength = 0;
      return;
    }
    let total = 0;
    for (const len of this.docLengths.values()) total += len;
    this.avgDocLength = total / this.docCount;
  }

  /**
   * Serialize index to a plain object for JSON persistence.
   * @returns {object}
   */
  serialize() {
    const invertedIndex = {};
    for (const [term, postings] of this.invertedIndex) {
      invertedIndex[term] = Object.fromEntries(postings);
    }

    return {
      k1: this.k1,
      b: this.b,
      invertedIndex,
      docLengths: Object.fromEntries(this.docLengths),
      docCount: this.docCount,
      avgDocLength: this.avgDocLength,
    };
  }

  /**
   * Deserialize from a plain object.
   * @param {object} data
   * @returns {BM25Index}
   */
  static deserialize(data) {
    const idx = new BM25Index({ k1: data.k1, b: data.b });
    idx.docCount = data.docCount || 0;
    idx.avgDocLength = data.avgDocLength || 0;
    idx.docLengths = new Map(Object.entries(data.docLengths || {}));

    for (const [term, postings] of Object.entries(data.invertedIndex || {})) {
      idx.invertedIndex.set(term, new Map(Object.entries(postings)));
    }

    // Ensure numeric values (JSON may stringify numbers in map values)
    for (const [term, postings] of idx.invertedIndex) {
      for (const [docId, freq] of postings) {
        if (typeof freq === "string") postings.set(docId, Number(freq));
      }
    }
    for (const [docId, len] of idx.docLengths) {
      if (typeof len === "string") idx.docLengths.set(docId, Number(len));
    }

    return idx;
  }

  /**
   * Save index to a JSON file (atomic write).
   * @param {string} filePath
   */
  save(filePath) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.serialize()), "utf8");
    fs.renameSync(tmp, filePath);
  }

  /**
   * Load index from a JSON file.
   * @param {string} filePath
   * @returns {BM25Index|null}
   */
  static load(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return BM25Index.deserialize(data);
    } catch {
      return null;
    }
  }
}

module.exports = { BM25Index, tokenize };
