"use strict";

/**
 * services/deep-search/orchestrator.js
 * Deep Search — multi-round iterative research engine.
 *
 * Architecture: GPT Deep Research style
 *   1. Decompose query into sub-questions (cheap model)
 *   2. Search SearXNG for each sub-question
 *   3. Rank snippets by relevance (cheap model, batch)
 *   4. Fetch full content for top results
 *   5. Evaluate pages: extract key findings + discover new leads (cheap model)
 *   6. New leads → back to step 2
 *   7. Final synthesis with expensive model → structured report
 */

const crypto = require("node:crypto");

const SEARXNG_URL = process.env.SEARXNG_URL || "http://lumigate-searxng:8080";
const FILE_PARSER_URL = process.env.FILE_PARSER_URL || "http://lumigate-file-parser:3100";

const MAX_WALL_CLOCK_MS = 5 * 60 * 1000; // 5 min hard limit
const MAX_CONTENT_EVAL = 3000;   // chars per page for evaluation
const MAX_CONTENT_SYNTH = 5000;  // chars per source for synthesis
const MAX_FINDINGS_FOR_SYNTH = 15;

// ── SearXNG search (self-contained, doesn't depend on chat.js) ──

async function searchWeb(query, timeRange = "month") {
  const params = new URLSearchParams({
    q: query, format: "json", language: "auto", safesearch: "0",
  });
  if (timeRange) params.set("time_range", timeRange);
  const res = await fetch(`${SEARXNG_URL}/search?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`SearXNG ${res.status}`);
  const data = await res.json();
  return (data.results || []).slice(0, 15).map(r => ({
    title: (r.title || "").slice(0, 200),
    url: r.url || "",
    snippet: (r.content || "").slice(0, 400),
  }));
}

// ── Content fetcher (HTML → text, with file-parser fallback) ──

async function fetchContent(url) {
  // Strategy 1: file-parser (handles PDF, HTML, etc.)
  try {
    const res = await fetch(`${FILE_PARSER_URL}/parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_url: url, filename: inferFilename(url) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.text || data.content || "";
      if (text.length > 100) return text;
    }
  } catch {}

  // Strategy 2: Direct HTML fetch + strip tags
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LumiGate/1.0)" },
      redirect: "follow",
    });
    if (!res.ok) return "";
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("html") && !ct.includes("text")) return "";
    const html = await res.text();
    return stripHtml(html);
  } catch {
    return "";
  }
}

function inferFilename(url) {
  try {
    const p = new URL(url).pathname;
    const last = p.split("/").filter(Boolean).pop() || "page.html";
    return last.includes(".") ? last : "page.html";
  } catch { return "page.html"; }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s{3,}/g, "\n")
    .trim()
    .slice(0, 50000);
}

// ── JSON repair ──

function parseJsonSafe(text) {
  let s = text.trim();
  // Strip markdown fences
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) s = m[1].trim();
  try { return JSON.parse(s); } catch {}
  // Try to extract array or object
  const arrMatch = s.match(/\[[\s\S]*\]/);
  if (arrMatch) try { return JSON.parse(arrMatch[0]); } catch {}
  const objMatch = s.match(/\{[\s\S]*\}/);
  if (objMatch) try { return JSON.parse(objMatch[0]); } catch {}
  return null;
}

// ── Prompts ──

const DECOMPOSE_PROMPT = `You are a research assistant. Break the following research question into 3-5 specific, diverse search queries that would help investigate it thoroughly. Return a JSON array of strings only.

Research question: `;

const RANK_PROMPT = `Rate each search result's relevance to the research question on a scale of 0-10.
Return a JSON array of objects: [{"index": 0, "score": 7}, ...]
Only include results with score >= 3.

Research question: {QUERY}

Results:
{RESULTS}`;

const EVALUATE_PROMPT = `You are evaluating a web page for a research project.
Research question: {QUERY}

Page content (truncated):
{CONTENT}

Return JSON:
{
  "relevant": true/false,
  "key_findings": "1-3 sentence summary of useful information found",
  "follow_up_queries": ["0-2 new search queries suggested by this content"]
}`;

const SYNTHESIS_PROMPT = `You are writing a comprehensive research report based on multiple sources.

Research question: {QUERY}

Sources:
{SOURCES}

Write a well-structured markdown report:
1. Start with a brief executive summary (2-3 sentences)
2. Organize findings into logical sections with ## headings
3. Cite sources inline as [Source N] where N matches the source number
4. End with a "Sources" section listing all cited URLs
5. Be thorough but concise — focus on actionable insights
6. If sources conflict, note the discrepancy
7. Write in the same language as the research question`;

// ── Orchestrator ──

/**
 * @param {object} deps
 * @param {object} deps.llm - { callCheap, callExpensive }
 * @param {function} [deps.log]
 */
function createOrchestrator({ llm, log = () => {} }) {

  /**
   * Run deep search.
   * @param {string} query
   * @param {object} opts
   * @param {number} [opts.maxRounds=5]
   * @param {string} [opts.callerProvider] - Provider of caller's selected model
   * @param {string} [opts.callerModel] - Caller's selected model (for synthesis)
   * @param {function} [opts.onProgress] - (msg) => void
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{report: string, sources: Array, stats: object}>}
   */
  async function run(query, opts = {}) {
    const maxRounds = opts.maxRounds || 5;
    const onProgress = opts.onProgress || (() => {});
    const startTime = Date.now();

    const state = {
      visitedUrls: new Set(),
      contentHashes: new Set(),
      findings: [],      // { url, title, snippet, summary, fullContent, score }
      followUpQueue: [],
      tokensUsed: 0,
      round: 0,
      searchCount: 0,
      fetchCount: 0,
    };

    const aborted = () => opts.signal?.aborted || (Date.now() - startTime > MAX_WALL_CLOCK_MS);
    const trackTokens = (usage) => { state.tokensUsed += (usage?.input || 0) + (usage?.output || 0); };

    try {
      // ── Step 1: Decompose ──
      onProgress({ phase: "decompose", round: 0, total: maxRounds, message: "Analyzing research question..." });

      const decompResult = await llm.callCheap([
        { role: "system", content: "Return only a JSON array of strings. No explanation." },
        { role: "user", content: DECOMPOSE_PROMPT + query },
      ], { maxTokens: 512, temperature: 0.3 });
      trackTokens(decompResult.usage);

      const subQueries = parseJsonSafe(decompResult.text);
      if (!Array.isArray(subQueries) || subQueries.length === 0) {
        // Fallback: use original query as-is
        state.followUpQueue.push(query);
      } else {
        state.followUpQueue.push(...subQueries.filter(q => typeof q === "string").slice(0, 5));
      }

      log("info", "deep_search_decomposed", { query, subQueries: state.followUpQueue.length });

      // ── Main Loop ──
      while (state.round < maxRounds && state.followUpQueue.length > 0 && !aborted()) {
        state.round++;
        const batch = state.followUpQueue.splice(0, 3);

        // ── Step 2: Search ──
        onProgress({ phase: "search", round: state.round, total: maxRounds, message: `Round ${state.round}/${maxRounds}: Searching ${batch.length} queries...` });

        let allResults = [];
        for (const q of batch) {
          if (aborted()) break;
          try {
            const results = await searchWeb(q, state.round <= 2 ? "month" : "year");
            state.searchCount++;
            // Dedup
            const fresh = results.filter(r => {
              if (!r.url || state.visitedUrls.has(r.url)) return false;
              state.visitedUrls.add(r.url);
              return true;
            });
            allResults.push(...fresh);
          } catch (e) {
            log("warn", "deep_search_search_failed", { query: q, error: e.message });
          }
        }

        if (allResults.length === 0) {
          onProgress({ phase: "search", round: state.round, total: maxRounds, message: `Round ${state.round}: No new results` });
          // If 3+ consecutive empty rounds, bail
          if (state.round >= 3 && state.findings.length === 0) {
            onProgress({ phase: "search", round: state.round, total: maxRounds, message: "Broadening search..." });
            state.followUpQueue.push(query); // retry with original
          }
          continue;
        }

        // ── Step 3: Rank snippets (batch) ──
        onProgress({ phase: "rank", round: state.round, total: maxRounds, message: `Round ${state.round}: Evaluating ${allResults.length} results...` });

        let ranked;
        try {
          const resultsStr = allResults.map((r, i) => `[${i}] ${r.title}\n${r.snippet}`).join("\n\n");
          const rankPrompt = RANK_PROMPT
            .replace("{QUERY}", query)
            .replace("{RESULTS}", resultsStr);

          const rankResult = await llm.callCheap([
            { role: "system", content: "Return only JSON. No explanation." },
            { role: "user", content: rankPrompt },
          ], { maxTokens: 1024 });
          trackTokens(rankResult.usage);

          ranked = parseJsonSafe(rankResult.text);
          if (!Array.isArray(ranked)) ranked = allResults.map((_, i) => ({ index: i, score: 5 }));
        } catch {
          ranked = allResults.map((_, i) => ({ index: i, score: 5 }));
        }

        // Sort by score, pick top 5 with score >= 6
        const topIndices = ranked
          .filter(r => typeof r.score === "number" && r.score >= 6)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map(r => r.index)
          .filter(i => i >= 0 && i < allResults.length);

        if (topIndices.length === 0) {
          // Nothing scored high enough — take top 3 anyway
          const fallback = ranked.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 3);
          topIndices.push(...fallback.map(r => r.index).filter(i => i >= 0 && i < allResults.length));
        }

        // ── Step 4: Fetch full content ──
        let fetchedCount = 0;
        for (const idx of topIndices) {
          if (aborted()) break;
          const result = allResults[idx];
          if (!result) continue;

          onProgress({ phase: "fetch", round: state.round, total: maxRounds, message: `Round ${state.round}: Reading ${result.title.slice(0, 50)}...` });

          try {
            const fullContent = await fetchContent(result.url);
            state.fetchCount++;
            if (!fullContent || fullContent.length < 50) continue;

            // Content dedup (hash first 500 chars)
            const hash = crypto.createHash("md5").update(fullContent.slice(0, 500)).digest("hex");
            if (state.contentHashes.has(hash)) continue;
            state.contentHashes.add(hash);

            fetchedCount++;

            // ── Step 5: Evaluate page ──
            const evalPrompt = EVALUATE_PROMPT
              .replace("{QUERY}", query)
              .replace("{CONTENT}", fullContent.slice(0, MAX_CONTENT_EVAL));

            const evalResult = await llm.callCheap([
              { role: "system", content: "Return only JSON. No explanation." },
              { role: "user", content: evalPrompt },
            ], { maxTokens: 512 });
            trackTokens(evalResult.usage);

            const evaluation = parseJsonSafe(evalResult.text);
            if (!evaluation) continue;

            if (evaluation.relevant !== false) {
              state.findings.push({
                url: result.url,
                title: result.title,
                snippet: result.snippet,
                summary: evaluation.key_findings || result.snippet,
                fullContent: fullContent.slice(0, MAX_CONTENT_SYNTH),
                score: ranked.find(r => r.index === idx)?.score || 5,
              });
            }

            // Discover new leads
            if (Array.isArray(evaluation.follow_up_queries)) {
              for (const fq of evaluation.follow_up_queries) {
                if (typeof fq === "string" && fq.length > 5 && state.followUpQueue.length < 20) {
                  state.followUpQueue.push(fq);
                }
              }
            }
          } catch (e) {
            log("warn", "deep_search_fetch_failed", { url: result.url, error: e.message });
          }
        }

        onProgress({
          phase: "round_done", round: state.round, total: maxRounds,
          message: `Round ${state.round} done: ${state.findings.length} sources, ${fetchedCount} pages read`,
        });

        log("info", "deep_search_round", {
          round: state.round, findings: state.findings.length,
          fetched: fetchedCount, tokensUsed: state.tokensUsed,
          followUpQueue: state.followUpQueue.length,
        });
      }

      // ── Step 7: Synthesis ──
      if (state.findings.length === 0) {
        return {
          report: `No relevant information found for: "${query}". Try rephrasing the question or broadening the topic.`,
          sources: [],
          stats: buildStats(state, startTime),
        };
      }

      onProgress({ phase: "synthesize", round: state.round, total: maxRounds, message: `Synthesizing report from ${state.findings.length} sources...` });

      // Sort by score, take top N
      const topFindings = state.findings
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_FINDINGS_FOR_SYNTH);

      const sourcesStr = topFindings.map((f, i) =>
        `[Source ${i + 1}] ${f.title}\nURL: ${f.url}\nSummary: ${f.summary}\n\nContent:\n${f.fullContent}`
      ).join("\n\n---\n\n");

      const synthPrompt = SYNTHESIS_PROMPT
        .replace("{QUERY}", query)
        .replace("{SOURCES}", sourcesStr);

      const synthResult = await llm.callExpensive(
        opts.callerProvider, opts.callerModel,
        [{ role: "user", content: synthPrompt }],
        { maxTokens: 8192, temperature: 0.2 },
      );
      trackTokens(synthResult.usage);

      onProgress({
        phase: "complete", round: state.round, total: maxRounds,
        message: `Research complete: ${state.findings.length} sources, ${state.round} rounds`,
      });

      return {
        report: synthResult.text,
        sources: topFindings.map((f, i) => ({
          index: i + 1, title: f.title, url: f.url, score: f.score,
        })),
        stats: buildStats(state, startTime),
      };

    } catch (err) {
      log("error", "deep_search_error", { query, error: err.message, round: state.round });
      // Return partial results if we have any
      if (state.findings.length > 0) {
        return {
          report: `Research was interrupted: ${err.message}\n\nPartial findings:\n` +
            state.findings.map((f, i) => `${i + 1}. **${f.title}**\n   ${f.summary}\n   ${f.url}`).join("\n\n"),
          sources: state.findings.map((f, i) => ({ index: i + 1, title: f.title, url: f.url, score: f.score })),
          stats: buildStats(state, startTime),
        };
      }
      throw err;
    }
  }

  function buildStats(state, startTime) {
    return {
      rounds: state.round,
      searches: state.searchCount,
      pagesFetched: state.fetchCount,
      relevantSources: state.findings.length,
      tokensUsed: state.tokensUsed,
      durationMs: Date.now() - startTime,
    };
  }

  return { run };
}

module.exports = { createOrchestrator };
