"use strict";

/**
 * services/knowledge/orchestrator.js — RAG Orchestrator.
 *
 * Adaptive, self-correcting retrieval agent implementing a state-machine pipeline:
 *   Query Analyze -> Route -> Rewrite -> Retrieve -> Grade -> Assess -> [Fallback] -> Generate Context -> Validate -> Cite
 *
 * Supports multiple RAG strategies: simple, standard, thorough, agentic.
 * Graceful degradation: if any step fails, falls back to simpler behavior.
 */

// ── RAG Strategy Presets ────────────────────────────────────────────────────────

const RAG_STRATEGIES = {
  /** Fast: single query, no grading, rerank only. */
  simple: {
    queryTransform: "none",
    grade: false,
    rerank: true,
    compress: false,
    hallucinationCheck: false,
    fallbackToWeb: false,
    maxRetries: 0,
  },
  /** Balanced: HyDE query transform + grading + rerank. Good default. */
  standard: {
    queryTransform: "hyde",
    grade: true,
    rerank: true,
    compress: false,
    hallucinationCheck: false,
    fallbackToWeb: false,
    maxRetries: 1,
  },
  /** High quality: multi-query + full grading + rerank + compression. */
  thorough: {
    queryTransform: "multi_query",
    grade: true,
    rerank: true,
    compress: true,
    hallucinationCheck: false,
    fallbackToWeb: true,
    maxRetries: 2,
  },
  /** Full state machine: auto routing + fallback + hallucination check. */
  agentic: {
    queryTransform: "auto",
    grade: true,
    rerank: true,
    compress: true,
    hallucinationCheck: true,
    fallbackToWeb: true,
    maxRetries: 2,
  },
};

// ── Timeouts ────────────────────────────────────────────────────────────────────

const TIMEOUT_GRADE_MS = 5000;
const TIMEOUT_HYDE_MS = 10000;
const TIMEOUT_CLASSIFY_MS = 5000;
const TIMEOUT_HALLUCINATION_MS = 10000;

// ── Helpers ─────────────────────────────────────────────────────────────────────

/**
 * Wrap a promise with a timeout. Resolves to fallback on timeout instead of rejecting.
 */
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/**
 * Deduplicate chunks by their text content (first 200 chars as key).
 */
function deduplicateChunks(chunks) {
  const seen = new Set();
  return chunks.filter((c) => {
    const key = (c.text || "").slice(0, 200);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Orchestrator ────────────────────────────────────────────────────────────────

class RAGOrchestrator {
  /**
   * @param {object} opts
   * @param {import('./manager').KnowledgeBaseManager} opts.knowledgeManager
   * @param {function} [opts.llmFetch]       — async (messages, opts?) => string
   * @param {function} [opts.webSearchFn]    — async (query) => Array<{title, url, content}>
   * @param {function} [opts.log]
   */
  constructor({ knowledgeManager, llmFetch, webSearchFn, log } = {}) {
    this.km = knowledgeManager;
    this.llmFetch = llmFetch || null;
    this.webSearchFn = webSearchFn || null;
    this.log = log || (() => {});
  }

  // ── Main entry point ────────────────────────────────────────────────────────

  /**
   * Orchestrate the full RAG pipeline.
   *
   * @param {string} query
   * @param {string[]} kbIds           — knowledge base IDs to search
   * @param {object} [options]
   * @param {string} [options.strategy='standard']   — RAG strategy preset name or custom config
   * @param {number} [options.maxChunks=10]
   * @param {number} [options.scoreThreshold=0.5]
   * @param {boolean} [options.enableWebFallback]
   * @param {boolean} [options.enableHallucinationCheck]
   * @param {string} [options.queryTransform]        — override strategy's transform
   * @returns {Promise<RAGResult>}
   */
  async orchestrate(query, kbIds, options = {}) {
    const startTime = Date.now();
    const stats = {
      queriesExecuted: 0,
      chunksRetrieved: 0,
      chunksGraded: 0,
      chunksRelevant: 0,
      retries: 0,
      stepsCompleted: [],
      timings: {},
    };

    // Resolve strategy config
    const strategyName = options.strategy || "standard";
    const strategyConfig =
      typeof strategyName === "object"
        ? strategyName
        : { ...(RAG_STRATEGIES[strategyName] || RAG_STRATEGIES.standard) };

    // Apply overrides
    if (options.queryTransform) strategyConfig.queryTransform = options.queryTransform;
    if (options.enableWebFallback !== undefined) strategyConfig.fallbackToWeb = options.enableWebFallback;
    if (options.enableHallucinationCheck !== undefined) strategyConfig.hallucinationCheck = options.enableHallucinationCheck;

    const maxChunks = options.maxChunks || 10;
    const scoreThreshold = options.scoreThreshold ?? 0.5;

    try {
      // ── Step 1: Analyze query ───────────────────────────────────────────────
      let analysis;
      if (strategyConfig.queryTransform === "auto" && this.llmFetch) {
        const t0 = Date.now();
        analysis = await this._analyzeQuery(query);
        stats.timings.analyze = Date.now() - t0;
        stats.stepsCompleted.push("analyze");

        // Short-circuit: no retrieval needed
        if (!analysis.needsRetrieval) {
          return this._buildResult({
            context: "",
            citations: [],
            strategy: "direct",
            stats,
            fallbackUsed: false,
            startTime,
            analysis,
          });
        }
      } else {
        // Skip classification — assume retrieval is needed
        analysis = {
          type: "factual",
          needsRetrieval: true,
          complexity: "simple",
          suggestedStrategy: strategyConfig.queryTransform,
        };
      }

      // ── Step 2: Route — pick retrieval approach ─────────────────────────────
      const route = this._route(analysis, strategyConfig);
      stats.stepsCompleted.push("route");

      // ── Step 3: Query rewrite / decomposition ──────────────────────────────
      const t1 = Date.now();
      const queries = await this._rewriteQuery(query, route, strategyConfig);
      stats.timings.rewrite = Date.now() - t1;
      stats.stepsCompleted.push("rewrite");

      // ── Step 4: Retrieve ────────────────────────────────────────────────────
      const t2 = Date.now();
      let chunks = await this._retrieve(queries, kbIds, {
        limit: Math.ceil(maxChunks * 1.5), // fetch extra for grading/reranking
        scoreThreshold,
      });
      stats.timings.retrieve = Date.now() - t2;
      stats.queriesExecuted = queries.length;
      stats.chunksRetrieved = chunks.length;
      stats.stepsCompleted.push("retrieve");

      // ── Step 5: Grade (CRAG) ───────────────────────────────────────────────
      let relevantChunks = chunks;
      if (strategyConfig.grade && this.llmFetch && chunks.length > 0) {
        const t3 = Date.now();
        const gradeResult = await this._gradeChunks(query, chunks);
        stats.timings.grade = Date.now() - t3;
        stats.chunksGraded = chunks.length;
        stats.chunksRelevant = gradeResult.relevant.length;
        relevantChunks = gradeResult.relevant;
        stats.stepsCompleted.push("grade");
      }

      // ── Step 6: Assess sufficiency ─────────────────────────────────────────
      let sufficiency = this._assessSufficiency(query, relevantChunks, scoreThreshold);
      stats.stepsCompleted.push("assess");

      // ── Step 7: Retry / Fallback loop ──────────────────────────────────────
      let fallbackUsed = false;
      let retryCount = 0;
      const maxRetries = strategyConfig.maxRetries || 0;

      while (sufficiency !== "sufficient" && retryCount < maxRetries) {
        retryCount++;
        stats.retries = retryCount;

        if (sufficiency === "partial") {
          // Refine: rewrite query differently and retry
          const refinedQueries = await this._refineQuery(query, queries, retryCount);
          const moreChunks = await this._retrieve(refinedQueries, kbIds, {
            limit: maxChunks,
            scoreThreshold: Math.max(0.3, scoreThreshold - 0.1 * retryCount),
          });
          stats.queriesExecuted += refinedQueries.length;

          // Merge and deduplicate
          const merged = deduplicateChunks([...relevantChunks, ...moreChunks]);

          if (strategyConfig.grade && this.llmFetch) {
            const newOnly = moreChunks.filter(
              (c) => !relevantChunks.some((r) => (r.text || "").slice(0, 200) === (c.text || "").slice(0, 200))
            );
            if (newOnly.length > 0) {
              const graded = await this._gradeChunks(query, newOnly);
              relevantChunks = deduplicateChunks([...relevantChunks, ...graded.relevant]);
            }
          } else {
            relevantChunks = merged;
          }

          stats.chunksRetrieved += moreChunks.length;
        } else if (sufficiency === "insufficient" && strategyConfig.fallbackToWeb && this.webSearchFn) {
          // Web search fallback
          const webResults = await this._webSearchFallback(query);
          if (webResults.length > 0) {
            relevantChunks = deduplicateChunks([...relevantChunks, ...webResults]);
            fallbackUsed = true;
          }
          // Only try web search once
          break;
        } else {
          break;
        }

        sufficiency = this._assessSufficiency(query, relevantChunks, scoreThreshold);
      }

      if (sufficiency === "insufficient" && strategyConfig.fallbackToWeb && this.webSearchFn && !fallbackUsed) {
        const webResults = await this._webSearchFallback(query);
        if (webResults.length > 0) {
          relevantChunks = deduplicateChunks([...relevantChunks, ...webResults]);
          fallbackUsed = true;
        }
      }

      stats.stepsCompleted.push("fallback_loop");

      // ── Step 8: Rerank ─────────────────────────────────────────────────────
      if (strategyConfig.rerank && relevantChunks.length > 1) {
        relevantChunks = this._rerank(relevantChunks, query);
        stats.stepsCompleted.push("rerank");
      }

      // Trim to maxChunks
      relevantChunks = relevantChunks.slice(0, maxChunks);

      // ── Step 9: Compress (optional) ────────────────────────────────────────
      if (strategyConfig.compress && this.llmFetch && relevantChunks.length > 0) {
        const t4 = Date.now();
        relevantChunks = await this._compressChunks(query, relevantChunks);
        stats.timings.compress = Date.now() - t4;
        stats.stepsCompleted.push("compress");
      }

      // ── Build context string ───────────────────────────────────────────────
      const context = this._formatContext(relevantChunks);
      const citations = this._extractCitations(relevantChunks);

      return this._buildResult({
        context,
        citations,
        strategy: strategyName,
        stats,
        fallbackUsed,
        startTime,
        analysis,
        chunks: relevantChunks,
      });
    } catch (err) {
      this.log("error", "rag_orchestrate_error", {
        component: "rag-orchestrator",
        error: err.message,
        query: query.slice(0, 100),
      });

      // Graceful degradation: fall back to simple vector search
      try {
        const fallbackChunks = await this.km.retrieveMulti(kbIds, query, {
          limit: maxChunks,
          scoreThreshold,
        });
        return this._buildResult({
          context: this.km.formatContext(fallbackChunks),
          citations: this._extractCitations(fallbackChunks),
          strategy: "fallback_simple",
          stats: { ...stats, error: err.message },
          fallbackUsed: false,
          startTime,
        });
      } catch (fallbackErr) {
        return this._buildResult({
          context: "",
          citations: [],
          strategy: "error",
          stats: { ...stats, error: err.message, fallbackError: fallbackErr.message },
          fallbackUsed: false,
          startTime,
        });
      }
    }
  }

  // ── Step implementations ──────────────────────────────────────────────────────

  /**
   * Step 1: Classify the query to determine routing.
   * Uses LLM with a tight timeout — if it fails, defaults to factual/simple.
   */
  async _analyzeQuery(query) {
    const defaultAnalysis = {
      type: "factual",
      needsRetrieval: true,
      complexity: "simple",
      suggestedStrategy: "hyde",
    };

    if (!this.llmFetch) return defaultAnalysis;

    const prompt = `Classify this user query for a RAG system. Respond with ONLY a JSON object, no markdown.

Query: "${query.slice(0, 500)}"

Respond with:
{
  "type": one of "factual", "analytical", "creative", "chitchat", "code", "math",
  "needsRetrieval": boolean (does this need external knowledge from documents?),
  "complexity": one of "simple", "multi_hop", "comparative",
  "suggestedStrategy": one of "none", "hyde", "multi_query", "decompose"
}

Rules:
- chitchat (greetings, thanks, small talk) -> needsRetrieval: false
- creative (write a poem, story) -> needsRetrieval: false unless about specific facts
- math/code with no domain context -> needsRetrieval: false
- factual questions about specific topics -> needsRetrieval: true
- "Compare X and Y" -> complexity: "comparative"
- "What is the relationship between A, B, and C" -> complexity: "multi_hop"`;

    try {
      const raw = await withTimeout(
        this.llmFetch([{ role: "user", content: prompt }], { temperature: 0, maxTokens: 200 }),
        TIMEOUT_CLASSIFY_MS,
        null,
      );

      if (!raw) return defaultAnalysis;

      const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);

      return {
        type: parsed.type || "factual",
        needsRetrieval: parsed.needsRetrieval !== false,
        complexity: parsed.complexity || "simple",
        suggestedStrategy: parsed.suggestedStrategy || "hyde",
      };
    } catch (err) {
      this.log("warn", "rag_analyze_fallback", {
        component: "rag-orchestrator",
        error: err.message,
      });
      return defaultAnalysis;
    }
  }

  /**
   * Step 2: Route to the appropriate retrieval approach based on analysis.
   */
  _route(analysis, strategyConfig) {
    // If strategy forces a specific transform, use it
    if (strategyConfig.queryTransform !== "auto") {
      return {
        approach: strategyConfig.queryTransform === "none" ? "direct" : "single",
        queryTransform: strategyConfig.queryTransform,
      };
    }

    switch (analysis.complexity) {
      case "multi_hop":
        return { approach: "multi_hop", queryTransform: "decompose" };
      case "comparative":
        return { approach: "comparative", queryTransform: "decompose" };
      default:
        return {
          approach: "single",
          queryTransform: analysis.suggestedStrategy || "hyde",
        };
    }
  }

  /**
   * Step 3: Rewrite / decompose the query based on route.
   * Returns an array of query strings to execute.
   */
  async _rewriteQuery(query, route, strategyConfig) {
    const transform = route.queryTransform || strategyConfig.queryTransform;

    if (transform === "none" || !this.llmFetch) {
      return [query];
    }

    if (transform === "hyde") {
      return [await this._hydeTransform(query)];
    }

    if (transform === "multi_query") {
      return await this._multiQueryTransform(query);
    }

    if (transform === "decompose") {
      return await this._decomposeTransform(query);
    }

    // Unknown transform — use original
    return [query];
  }

  /**
   * HyDE: Hypothetical Document Embeddings.
   * Ask LLM to generate a hypothetical answer, use that for embedding search.
   */
  async _hydeTransform(query) {
    if (!this.llmFetch) return query;

    const prompt = `Write a short paragraph (3-5 sentences) that would be a perfect answer to this question. Write it as if it's from a reference document, not as a response to the user. Be factual and specific.

Question: ${query.slice(0, 500)}

Paragraph:`;

    try {
      const result = await withTimeout(
        this.llmFetch([{ role: "user", content: prompt }], { temperature: 0.3, maxTokens: 300 }),
        TIMEOUT_HYDE_MS,
        null,
      );

      if (result && result.length > 20) {
        this.log("debug", "rag_hyde_generated", {
          component: "rag-orchestrator",
          originalLength: query.length,
          hydeLength: result.length,
        });
        return result;
      }
    } catch (err) {
      this.log("warn", "rag_hyde_fallback", {
        component: "rag-orchestrator",
        error: err.message,
      });
    }

    return query;
  }

  /**
   * Multi-query: Generate 3 different phrasings of the same question.
   */
  async _multiQueryTransform(query) {
    if (!this.llmFetch) return [query];

    const prompt = `Generate 3 different search queries that would help answer this question. Each should approach the topic from a different angle. Respond with ONLY a JSON array of strings, no markdown.

Question: ${query.slice(0, 500)}

Example response: ["query 1", "query 2", "query 3"]`;

    try {
      const raw = await withTimeout(
        this.llmFetch([{ role: "user", content: prompt }], { temperature: 0.5, maxTokens: 300 }),
        TIMEOUT_HYDE_MS,
        null,
      );

      if (!raw) return [query];

      const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);

      if (Array.isArray(parsed) && parsed.length > 0) {
        // Always include the original query
        const queries = [query, ...parsed.filter((q) => typeof q === "string" && q.length > 5)];
        return [...new Set(queries)].slice(0, 4);
      }
    } catch (err) {
      this.log("warn", "rag_multi_query_fallback", {
        component: "rag-orchestrator",
        error: err.message,
      });
    }

    return [query];
  }

  /**
   * Decompose: Break a complex query into sub-queries.
   */
  async _decomposeTransform(query) {
    if (!this.llmFetch) return [query];

    const prompt = `Break this complex question into 2-4 simpler sub-questions that, when answered together, would fully answer the original. Respond with ONLY a JSON array of strings, no markdown.

Question: ${query.slice(0, 500)}

Example: "Compare Apple and Google revenue" -> ["Apple annual revenue recent years", "Google annual revenue recent years"]`;

    try {
      const raw = await withTimeout(
        this.llmFetch([{ role: "user", content: prompt }], { temperature: 0.3, maxTokens: 400 }),
        TIMEOUT_HYDE_MS,
        null,
      );

      if (!raw) return [query];

      const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);

      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter((q) => typeof q === "string" && q.length > 5).slice(0, 4);
      }
    } catch (err) {
      this.log("warn", "rag_decompose_fallback", {
        component: "rag-orchestrator",
        error: err.message,
      });
    }

    return [query];
  }

  /**
   * Step 4: Execute retrieval across all queries and knowledge bases.
   * Runs queries in parallel, deduplicates results.
   */
  async _retrieve(queries, kbIds, { limit = 10, scoreThreshold = 0.5 } = {}) {
    if (!queries.length || !kbIds.length) return [];

    const perQueryLimit = Math.ceil(limit / queries.length) + 2;

    const allPromises = queries.map((q) =>
      this.km.retrieveMulti(kbIds, q, { limit: perQueryLimit, scoreThreshold }).catch((err) => {
        this.log("warn", "rag_retrieve_error", {
          component: "rag-orchestrator",
          error: err.message,
          query: q.slice(0, 80),
        });
        return [];
      })
    );

    const results = (await Promise.all(allPromises)).flat();

    // Deduplicate and sort by score
    return deduplicateChunks(results).sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  /**
   * Step 5: Grade each chunk for relevance (CRAG — Corrective RAG).
   * Uses a fast LLM call per chunk. Chunks are graded in parallel batches.
   */
  async _gradeChunks(query, chunks) {
    if (!this.llmFetch || chunks.length === 0) {
      return { relevant: chunks, irrelevant: [], scores: new Map() };
    }

    // Grade in a single batch prompt for efficiency (cheaper than per-chunk calls)
    const relevant = [];
    const irrelevant = [];
    const scores = new Map();

    // Batch grading: send all chunks at once
    const BATCH_SIZE = 8;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const batchResults = await this._gradeBatch(query, batch);

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const score = batchResults[j] ?? 0.5; // default to moderate if grading fails
        scores.set(chunk, score);

        if (score >= 0.5) {
          relevant.push({ ...chunk, gradeScore: score });
        } else {
          irrelevant.push({ ...chunk, gradeScore: score });
        }
      }
    }

    // Sort relevant by grade score descending
    relevant.sort((a, b) => (b.gradeScore || 0) - (a.gradeScore || 0));

    this.log("debug", "rag_graded", {
      component: "rag-orchestrator",
      total: chunks.length,
      relevant: relevant.length,
      irrelevant: irrelevant.length,
    });

    return { relevant, irrelevant, scores };
  }

  /**
   * Grade a batch of chunks in a single LLM call.
   * Returns an array of scores (0.0 to 1.0) matching the input chunk order.
   */
  async _gradeBatch(query, chunks) {
    const defaultScores = chunks.map(() => 0.5);
    if (!this.llmFetch) return defaultScores;

    const chunkList = chunks
      .map((c, i) => `[${i}] ${(c.text || "").slice(0, 300)}`)
      .join("\n\n");

    const prompt = `You are a relevance grader. Given a query and retrieved text chunks, rate each chunk's relevance to the query.

Query: "${query.slice(0, 300)}"

Chunks:
${chunkList}

Respond with ONLY a JSON array of numbers (0.0 to 1.0), one per chunk. 1.0 = perfectly relevant, 0.0 = completely irrelevant.
Example for 3 chunks: [0.9, 0.2, 0.7]`;

    try {
      const raw = await withTimeout(
        this.llmFetch([{ role: "user", content: prompt }], { temperature: 0, maxTokens: 100 }),
        TIMEOUT_GRADE_MS,
        null,
      );

      if (!raw) return defaultScores;

      const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);

      if (Array.isArray(parsed) && parsed.length === chunks.length) {
        return parsed.map((s) => {
          const n = Number(s);
          return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
        });
      }
    } catch (err) {
      this.log("warn", "rag_grade_batch_fallback", {
        component: "rag-orchestrator",
        error: err.message,
      });
    }

    return defaultScores;
  }

  /**
   * Step 6: Assess whether retrieved relevant chunks are sufficient.
   */
  _assessSufficiency(query, relevantChunks, scoreThreshold = 0.5) {
    if (!relevantChunks || relevantChunks.length === 0) return "insufficient";

    const avgScore =
      relevantChunks.reduce((sum, c) => sum + (c.gradeScore || c.score || 0), 0) /
      relevantChunks.length;

    if (relevantChunks.length >= 3 && avgScore >= 0.7) return "sufficient";
    if (relevantChunks.length >= 1 && avgScore >= 0.4) return "partial";
    return "insufficient";
  }

  /**
   * Step 7a: Refine query for retry — rephrase differently.
   */
  async _refineQuery(originalQuery, previousQueries, retryCount) {
    if (!this.llmFetch) {
      // Simple fallback: just add "details about" prefix
      return [`details about ${originalQuery}`];
    }

    const prompt = `The following search queries did not return sufficient results. Generate 2 alternative search queries that approach the topic differently. Respond with ONLY a JSON array of strings.

Original question: "${originalQuery.slice(0, 300)}"
Previous queries tried: ${JSON.stringify(previousQueries.slice(0, 3))}
Attempt: ${retryCount}

Try: broader terms, synonyms, related concepts, or different phrasing.`;

    try {
      const raw = await withTimeout(
        this.llmFetch([{ role: "user", content: prompt }], { temperature: 0.7, maxTokens: 200 }),
        TIMEOUT_HYDE_MS,
        null,
      );

      if (raw) {
        const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.filter((q) => typeof q === "string" && q.length > 3).slice(0, 2);
        }
      }
    } catch {
      // ignore
    }

    return [`details about ${originalQuery}`];
  }

  /**
   * Step 7b: Web search fallback.
   */
  async _webSearchFallback(query) {
    if (!this.webSearchFn) return [];

    try {
      const results = await withTimeout(
        this.webSearchFn(query),
        10000,
        [],
      );

      if (!Array.isArray(results) || results.length === 0) return [];

      // Convert web results to chunk format
      return results.slice(0, 5).map((r) => ({
        text: `${r.title || ""}\n${r.content || r.snippet || ""}`.trim(),
        score: 0.6, // moderate confidence for web results
        source: {
          filename: r.url || r.title || "web",
          documentId: "web_search",
          chunkIndex: 0,
          kbId: "web",
          kbName: "Web Search",
          url: r.url,
        },
      }));
    } catch (err) {
      this.log("warn", "rag_web_fallback_error", {
        component: "rag-orchestrator",
        error: err.message,
      });
      return [];
    }
  }

  /**
   * Rerank chunks using score-based heuristic.
   * If a dedicated reranker model is available in the future, it would plug in here.
   */
  _rerank(chunks, query) {
    // Simple reranking: combine vector score + grade score + keyword overlap boost
    const queryTerms = new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 2)
    );

    return chunks
      .map((chunk) => {
        const vectorScore = chunk.score || 0;
        const gradeScore = chunk.gradeScore || vectorScore;

        // Keyword overlap bonus (BM25-lite)
        const text = (chunk.text || "").toLowerCase();
        let keywordHits = 0;
        for (const term of queryTerms) {
          if (text.includes(term)) keywordHits++;
        }
        const keywordBoost = queryTerms.size > 0 ? (keywordHits / queryTerms.size) * 0.1 : 0;

        const combinedScore = gradeScore * 0.6 + vectorScore * 0.3 + keywordBoost;

        return { ...chunk, rerankScore: combinedScore };
      })
      .sort((a, b) => (b.rerankScore || 0) - (a.rerankScore || 0));
  }

  /**
   * Step 9 (optional): Compress chunks — keep only the most relevant sentences.
   */
  async _compressChunks(query, chunks) {
    if (!this.llmFetch || chunks.length === 0) return chunks;

    const chunkTexts = chunks.map((c) => c.text || "").join("\n---\n");

    const prompt = `Given this question and retrieved text passages, extract ONLY the sentences that are directly relevant to answering the question. Remove filler, headers, and irrelevant content. Keep the relevant text verbatim (do not paraphrase).

Question: "${query.slice(0, 300)}"

Passages:
${chunkTexts.slice(0, 3000)}

Relevant excerpts (one per line, keep source text exact):`;

    try {
      const raw = await withTimeout(
        this.llmFetch([{ role: "user", content: prompt }], { temperature: 0, maxTokens: 1500 }),
        TIMEOUT_HYDE_MS,
        null,
      );

      if (raw && raw.length > 20) {
        // Return as a single compressed chunk, preserving the first chunk's source info
        return [
          {
            text: raw.trim(),
            score: chunks[0]?.score || 0.8,
            gradeScore: chunks[0]?.gradeScore || 0.8,
            source: chunks[0]?.source || {},
            compressed: true,
            originalChunkCount: chunks.length,
          },
        ];
      }
    } catch (err) {
      this.log("warn", "rag_compress_fallback", {
        component: "rag-orchestrator",
        error: err.message,
      });
    }

    // Compression failed — return originals
    return chunks;
  }

  // ── Hallucination check (Self-RAG) ────────────────────────────────────────────

  /**
   * Post-generation check: does the response stay grounded in the retrieved context?
   * Called externally after the LLM generates a response.
   *
   * @param {string} query
   * @param {string} context     — the context that was injected
   * @param {string} response    — the LLM's generated response
   * @returns {Promise<{isGrounded: boolean, unsupportedClaims: string[]}>}
   */
  async checkHallucination(query, context, response) {
    const defaultResult = { isGrounded: true, unsupportedClaims: [] };

    if (!this.llmFetch || !context || !response) return defaultResult;

    const prompt = `You are a hallucination detector. Given a context (retrieved documents) and an AI response, identify any claims in the response that are NOT supported by the context.

Context:
${context.slice(0, 3000)}

Response:
${response.slice(0, 2000)}

If all claims are supported by the context, respond: {"isGrounded": true, "unsupportedClaims": []}
If there are unsupported claims, respond: {"isGrounded": false, "unsupportedClaims": ["claim 1", "claim 2"]}

Respond with ONLY the JSON object, no markdown.`;

    try {
      const raw = await withTimeout(
        this.llmFetch([{ role: "user", content: prompt }], { temperature: 0, maxTokens: 500 }),
        TIMEOUT_HALLUCINATION_MS,
        null,
      );

      if (!raw) return defaultResult;

      const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);

      return {
        isGrounded: parsed.isGrounded !== false,
        unsupportedClaims: Array.isArray(parsed.unsupportedClaims)
          ? parsed.unsupportedClaims.filter((c) => typeof c === "string")
          : [],
      };
    } catch (err) {
      this.log("warn", "rag_hallucination_check_error", {
        component: "rag-orchestrator",
        error: err.message,
      });
      return defaultResult;
    }
  }

  // ── Citation extraction ───────────────────────────────────────────────────────

  /**
   * Extract citations from the chunks used.
   * Maps each chunk back to its source document/file.
   */
  _extractCitations(chunks) {
    if (!chunks || chunks.length === 0) return [];

    const seen = new Set();
    const citations = [];

    for (const chunk of chunks) {
      const src = chunk.source || {};
      const key = `${src.documentId || ""}:${src.filename || ""}:${src.chunkIndex ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      citations.push({
        text: (chunk.text || "").slice(0, 150) + (chunk.text && chunk.text.length > 150 ? "..." : ""),
        source: src.filename || "unknown",
        documentId: src.documentId || null,
        chunkIndex: src.chunkIndex ?? null,
        kbId: src.kbId || null,
        kbName: src.kbName || null,
        url: src.url || null,
        score: chunk.rerankScore || chunk.gradeScore || chunk.score || 0,
      });
    }

    return citations;
  }

  // ── Context formatting ────────────────────────────────────────────────────────

  /**
   * Format relevant chunks into a context string for LLM injection.
   */
  _formatContext(chunks) {
    if (!chunks || chunks.length === 0) return "";

    const lines = chunks.map((c, i) => {
      const src = c.source || {};
      const srcLabel = src.filename ? ` [${src.filename}]` : "";
      const score = c.rerankScore || c.gradeScore || c.score || 0;
      return `[${i + 1}]${srcLabel} (relevance: ${(score * 100).toFixed(0)}%)\n${c.text}`;
    });

    return "Retrieved from knowledge base:\n\n" + lines.join("\n\n---\n\n");
  }

  // ── Result builder ────────────────────────────────────────────────────────────

  _buildResult({ context, citations, strategy, stats, fallbackUsed, startTime, analysis, chunks }) {
    return {
      context: context || "",
      citations: citations || [],
      strategy: strategy || "unknown",
      retrievalStats: {
        ...stats,
        totalTimeMs: Date.now() - (startTime || Date.now()),
        analysis: analysis || null,
      },
      fallbackUsed: fallbackUsed || false,
    };
  }
}

module.exports = { RAGOrchestrator, RAG_STRATEGIES };
