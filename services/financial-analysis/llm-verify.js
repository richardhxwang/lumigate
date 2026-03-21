"use strict";

/**
 * LLM fallback verification for failed/insufficient casting & notes checks.
 *
 * After analyze.py produces deterministic results, items with status "fail",
 * "not_tie", or "insufficient" are sent to a cheap LLM for a second opinion.
 * The LLM sees the original text context and the program's finding, then
 * decides whether the mismatch is real or due to missing/misread items.
 *
 * Uses LumiGate's upstream provider API directly (not /v1/chat) to avoid
 * re-entering the chat pipeline.  Defaults to deepseek-chat (cheapest).
 */

const FAIL_STATUSES = new Set(["fail", "not_tie", "insufficient", "partial"]);

// Maximum items to verify per batch prompt (keeps token usage bounded)
const BATCH_SIZE = 8;

// Maximum chars of original text context to include per item
const CONTEXT_WINDOW = 600;

// ── Context extraction ──────────────────────────────────────────────────────

/**
 * Extract a window of original text around a label/keyword.
 * Returns up to `chars` characters centered on the first occurrence.
 */
function extractContext(text, label, chars = CONTEXT_WINDOW) {
  if (!text || !label) return "";
  const idx = text.indexOf(label);
  if (idx === -1) {
    // Try fuzzy: lowercase, strip spaces
    const lower = text.toLowerCase();
    const needle = String(label).toLowerCase().replace(/[\s_]+/g, " ");
    const fi = lower.indexOf(needle);
    if (fi === -1) return text.slice(0, chars); // fallback: document head
    const start = Math.max(0, fi - Math.floor(chars / 2));
    return text.slice(start, start + chars);
  }
  const start = Math.max(0, idx - Math.floor(chars / 2));
  return text.slice(start, start + chars);
}

// ── Prompt builders ─────────────────────────────────────────────────────────

function buildCastingPrompt(items, context) {
  const itemsBlock = items.map((item, i) => {
    const parts = [];
    parts.push(`[${i + 1}] Check: ${item.check || item.label || "unknown"}`);
    if (item.formula) parts.push(`    Formula: ${item.formula}`);
    if (item.main_value != null) parts.push(`    Parent total (reported): ${item.main_value}`);
    if (item.detail_sum != null) parts.push(`    Sum of children (computed): ${item.detail_sum}`);
    if (item.reported != null) parts.push(`    Reported: ${item.reported}`);
    if (item.computed != null) parts.push(`    Computed: ${item.computed}`);
    if (item.difference != null) parts.push(`    Difference: ${item.difference}`);
    parts.push(`    Program status: ${item.status}`);
    if (Array.isArray(item.missing_fields) && item.missing_fields.length) {
      parts.push(`    Missing fields: ${item.missing_fields.join(", ")}`);
    }
    if (Array.isArray(item.detail_values)) {
      const childLines = item.detail_values
        .map((d) => `      - ${d.label || "?"}: ${d.value != null ? d.value : "N/A"}`)
        .join("\n");
      if (childLines) parts.push(`    Children:\n${childLines}`);
    }
    return parts.join("\n");
  }).join("\n\n");

  return `You are a financial auditor. The automated program extracted the following items from an annual report and flagged them as failed or insufficient. Your task: verify each item against the original text. Look for missing line items, rounding differences, or misread numbers.

=== ITEMS TO VERIFY ===
${itemsBlock}

=== ORIGINAL DOCUMENT EXCERPT ===
${context}

For EACH item, respond with a JSON object in an array. Fields:
- "index": item number (1-based)
- "verified": true if the reported total is actually correct (e.g. program missed a child item), false if the mismatch is real
- "explanation": brief reason (e.g. "Program missed 'Prepayments' worth 576 as a child item" or "Numbers genuinely do not add up")
- "missing_items": array of {label, value} for any items the program missed (empty array if none)
- "correct_total": the correct total if you can determine it, or null

Respond ONLY with a JSON array. No markdown fences, no explanation outside JSON.`;
}

function buildNotesPrompt(items, context) {
  const itemsBlock = items.map((item, i) => {
    const parts = [];
    parts.push(`[${i + 1}] ${item.note_id || item.check || "Note check"}`);
    if (item.note_label) parts.push(`    Note label: ${item.note_label}`);
    if (item.note_total != null) parts.push(`    Note total: ${item.note_total}`);
    if (item.statement_value != null) parts.push(`    Statement value: ${item.statement_value}`);
    if (item.current_total != null) parts.push(`    Current total (computed): ${item.current_total}`);
    if (item.current_sum != null) parts.push(`    Sum of components: ${item.current_sum}`);
    if (item.difference != null) parts.push(`    Difference: ${item.difference}`);
    parts.push(`    Program status: ${item.status || item.current_status || "unknown"}`);
    return parts.join("\n");
  }).join("\n\n");

  return `You are a financial auditor verifying footnote disclosures against financial statements. The program flagged these note items as mismatched or insufficient. Check against the original text.

=== ITEMS TO VERIFY ===
${itemsBlock}

=== ORIGINAL DOCUMENT EXCERPT ===
${context}

For EACH item, respond with a JSON object in an array. Fields:
- "index": item number (1-based)
- "verified": true if the values actually match (e.g. different line definition, rounding, restated figure), false if genuinely mismatched
- "explanation": brief reason
- "note_value": the correct note value if determinable, or null
- "statement_value": the correct statement value if determinable, or null

Respond ONLY with a JSON array. No markdown fences, no explanation outside JSON.`;
}

// ── LLM call ────────────────────────────────────────────────────────────────

/**
 * Call a provider's chat completions API directly.
 * @param {string} prompt - user message
 * @param {object} opts
 * @param {string} opts.baseUrl - provider base URL
 * @param {string} opts.apiKey - API key
 * @param {string} opts.provider - provider name (for URL/header formatting)
 * @param {string} opts.model - model ID
 * @param {Function} [opts.log] - logging function
 * @returns {string} LLM response text
 */
async function callLLM(prompt, { baseUrl, apiKey, provider = "deepseek", model = "deepseek-chat", log }) {
  // Build URL (same logic as routes/chat.js getChatUrl)
  let url;
  if (provider === "anthropic") url = `${baseUrl}/v1/messages`;
  else if (provider === "gemini") url = `${baseUrl}/v1beta/openai/chat/completions`;
  else if (provider === "doubao") url = `${baseUrl}/chat/completions`;
  else url = `${baseUrl}/v1/chat/completions`;

  // Build headers
  let headers;
  if (provider === "anthropic") {
    headers = { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  } else {
    headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  }

  const systemMsg = "You are a financial auditor verifying numbers extracted from annual reports. Be precise. Show calculations. Respond in JSON only.";

  // Build body (Anthropic uses different format)
  let body;
  if (provider === "anthropic") {
    body = JSON.stringify({
      model,
      max_tokens: 2048,
      temperature: 0,
      system: systemMsg,
      messages: [{ role: "user", content: prompt }],
    });
  } else {
    body = JSON.stringify({
      model,
      max_tokens: 2048,
      temperature: 0,
      stream: false,
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: prompt },
      ],
    });
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      if (log) log("warn", "llm_verify_api_error", { status: res.status, body: errText.slice(0, 200) });
      return "";
    }
    const data = await res.json();

    // Anthropic returns content[0].text, OpenAI-compatible returns choices[0].message.content
    if (provider === "anthropic") {
      return data.content?.[0]?.text || "";
    }
    return data.choices?.[0]?.message?.content || "";
  } catch (err) {
    if (log) log("warn", "llm_verify_call_failed", { error: err.message, provider, model });
    return "";
  }
}

// ── Response parser ─────────────────────────────────────────────────────────

function parseLLMResponse(text) {
  if (!text) return [];
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Try to extract JSON array from the response
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return [];
  }
}

// ── Batch helpers ───────────────────────────────────────────────────────────

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ── Main entry points ───────────────────────────────────────────────────────

/**
 * Collect all failed/insufficient items from the analysis result.
 * Returns { castingFails, notesFails, crossCheckFails } with source arrays.
 */
function collectFailedItems(analysisResult) {
  const castingFails = [];
  const notesFails = [];
  const crossCheckFails = [];

  // 1. Main checks (tie-out checks from analyze.py)
  const checks = Array.isArray(analysisResult.checks) ? analysisResult.checks : [];
  for (const c of checks) {
    if (FAIL_STATUSES.has(c.status)) {
      castingFails.push({ ...c, _source: "checks" });
    }
  }

  // 2. Cross-checks (detail breakdowns)
  const crossChecks = Array.isArray(analysisResult.cross_checks) ? analysisResult.cross_checks : [];
  for (const xc of crossChecks) {
    if (FAIL_STATUSES.has(xc.status)) {
      crossCheckFails.push({ ...xc, _source: "cross_checks" });
    }
  }

  // 3. Casting sheet addition failures
  const castingSheet = Array.isArray(analysisResult.casting_sheet) ? analysisResult.casting_sheet : [];
  for (const entry of castingSheet) {
    if (entry.addition_check === "fail") {
      castingFails.push({
        check: `casting_addition_${entry.label || entry.section || "unknown"}`,
        label: entry.label,
        section: entry.section,
        main_value: entry.value,
        detail_sum: entry.children_sum,
        detail_values: entry.children,
        difference: entry.addition_difference,
        status: "fail",
        formula: entry.addition_formula,
        _source: "casting_sheet",
      });
    }
  }

  // 4. Casting cross-statement failures
  const crossStmt = Array.isArray(analysisResult.casting_cross_statement) ? analysisResult.casting_cross_statement : [];
  for (const m of crossStmt) {
    if (FAIL_STATUSES.has(m.status)) {
      crossCheckFails.push({ ...m, _source: "casting_cross_statement" });
    }
  }

  // 5. Notes verification internal failures
  const notesVerification = Array.isArray(analysisResult.notes_verification) ? analysisResult.notes_verification : [];
  for (const nv of notesVerification) {
    if (FAIL_STATUSES.has(nv.current_status)) {
      notesFails.push({ ...nv, status: nv.current_status, _source: "notes_verification" });
    }
  }

  // 6. Notes vs statement match failures
  const notesStmtMatches = Array.isArray(analysisResult.notes_statement_matches) ? analysisResult.notes_statement_matches : [];
  for (const nsm of notesStmtMatches) {
    if (FAIL_STATUSES.has(nsm.status)) {
      notesFails.push({ ...nsm, _source: "notes_statement_matches" });
    }
  }

  // 7. Notes prior-year failures
  const notesPriorYear = Array.isArray(analysisResult.notes_prior_year) ? analysisResult.notes_prior_year : [];
  for (const npy of notesPriorYear) {
    if (FAIL_STATUSES.has(npy.status)) {
      notesFails.push({ ...npy, _source: "notes_prior_year" });
    }
  }

  return { castingFails, notesFails, crossCheckFails };
}

/**
 * Run LLM fallback verification on all failed/insufficient items.
 *
 * @param {object} analysisResult - full output from analyze.py
 * @param {string} originalText - concatenated original document text
 * @param {object} opts
 * @param {string} opts.baseUrl - provider base URL
 * @param {string} opts.apiKey - API key for the provider
 * @param {string} [opts.provider='deepseek'] - provider name
 * @param {string} [opts.model='deepseek-chat'] - model ID
 * @param {Function} [opts.log] - logging function
 * @returns {object} { verified: [...items with llm fields], stats }
 */
async function verifyFailedItems(analysisResult, originalText, opts = {}) {
  const { baseUrl, apiKey, provider = "deepseek", model = "deepseek-chat", log: logFn } = opts;

  if (!baseUrl || !apiKey) {
    if (logFn) logFn("warn", "llm_verify_skipped", { reason: "no API credentials for LLM verification" });
    return { verified: [], stats: { skipped: true, reason: "no_credentials" } };
  }

  const { castingFails, notesFails, crossCheckFails } = collectFailedItems(analysisResult);
  const totalFails = castingFails.length + notesFails.length + crossCheckFails.length;

  if (totalFails === 0) {
    return { verified: [], stats: { total_failed: 0, llm_calls: 0 } };
  }

  // Cap total items to verify (cost control)
  const MAX_VERIFY = 30;
  const allFails = [...castingFails, ...crossCheckFails].slice(0, MAX_VERIFY);
  const noteFails = notesFails.slice(0, MAX_VERIFY - allFails.length);

  const results = [];
  let llmCalls = 0;

  // Verify casting + cross-check failures
  if (allFails.length > 0) {
    const batches = chunkArray(allFails, BATCH_SIZE);
    for (const batch of batches) {
      const searchLabel = batch[0].check || batch[0].label || "";
      const context = extractContext(originalText, searchLabel, CONTEXT_WINDOW * 2);
      const prompt = buildCastingPrompt(batch, context);
      const raw = await callLLM(prompt, { baseUrl, apiKey, provider, model, log: logFn });
      llmCalls++;
      const parsed = parseLLMResponse(raw);

      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const llmItem = parsed.find((p) => p.index === i + 1) || parsed[i] || {};
        results.push({
          check: item.check || item.label || "unknown",
          source: item._source,
          original_status: item.status,
          llm_verified: !!llmItem.verified,
          llm_explanation: String(llmItem.explanation || ""),
          llm_missing_items: Array.isArray(llmItem.missing_items) ? llmItem.missing_items : [],
          llm_correct_total: llmItem.correct_total ?? null,
          final_status: llmItem.verified ? "pass_llm" : item.status,
        });
      }
    }
  }

  // Verify notes failures
  if (noteFails.length > 0) {
    const batches = chunkArray(noteFails, BATCH_SIZE);
    for (const batch of batches) {
      const searchLabel = batch[0].note_id || batch[0].note_label || batch[0].check || "";
      const context = extractContext(originalText, searchLabel, CONTEXT_WINDOW * 2);
      const prompt = buildNotesPrompt(batch, context);
      const raw = await callLLM(prompt, { baseUrl, apiKey, provider, model, log: logFn });
      llmCalls++;
      const parsed = parseLLMResponse(raw);

      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const llmItem = parsed.find((p) => p.index === i + 1) || parsed[i] || {};
        results.push({
          check: item.note_id || item.check || item.note_label || "unknown",
          source: item._source,
          original_status: item.status || item.current_status || "unknown",
          llm_verified: !!llmItem.verified,
          llm_explanation: String(llmItem.explanation || ""),
          llm_note_value: llmItem.note_value ?? null,
          llm_statement_value: llmItem.statement_value ?? null,
          final_status: llmItem.verified ? "pass_llm" : (item.status || item.current_status || "fail"),
        });
      }
    }
  }

  const passLlmCount = results.filter((r) => r.final_status === "pass_llm").length;
  const stillFailCount = results.filter((r) => r.final_status !== "pass_llm").length;

  return {
    verified: results,
    stats: {
      total_failed: totalFails,
      items_verified: results.length,
      llm_calls: llmCalls,
      pass_llm: passLlmCount,
      still_fail: stillFailCount,
      provider,
      model,
    },
  };
}

/**
 * Merge LLM verification results back into the analysis output.
 * Adds `llm_verification` top-level key and annotates individual items.
 */
function mergeVerificationIntoResult(analysisResult, verificationResult) {
  if (!verificationResult || !verificationResult.verified?.length) {
    return analysisResult;
  }

  const merged = { ...analysisResult };

  // Build lookup: source+check → verification
  const lookup = new Map();
  for (const v of verificationResult.verified) {
    const key = `${v.source}::${v.check}`;
    lookup.set(key, v);
  }

  // Annotate checks array
  if (Array.isArray(merged.checks)) {
    merged.checks = merged.checks.map((c) => {
      const v = lookup.get(`checks::${c.check}`);
      if (!v) return c;
      return { ...c, llm_verified: v.llm_verified, llm_explanation: v.llm_explanation, final_status: v.final_status };
    });
  }

  // Annotate cross_checks
  if (Array.isArray(merged.cross_checks)) {
    merged.cross_checks = merged.cross_checks.map((xc) => {
      const v = lookup.get(`cross_checks::${xc.check}`) || lookup.get(`casting_cross_statement::${xc.check}`);
      if (!v) return xc;
      return { ...xc, llm_verified: v.llm_verified, llm_explanation: v.llm_explanation, final_status: v.final_status };
    });
  }

  // Annotate casting_sheet
  if (Array.isArray(merged.casting_sheet)) {
    merged.casting_sheet = merged.casting_sheet.map((entry) => {
      const checkId = `casting_addition_${entry.label || entry.section || "unknown"}`;
      const v = lookup.get(`casting_sheet::${checkId}`);
      if (!v) return entry;
      return { ...entry, llm_verified: v.llm_verified, llm_explanation: v.llm_explanation, final_status: v.final_status };
    });
  }

  // Annotate notes arrays
  for (const arrKey of ["notes_verification", "notes_statement_matches", "notes_prior_year"]) {
    if (Array.isArray(merged[arrKey])) {
      merged[arrKey] = merged[arrKey].map((item) => {
        const itemCheck = item.note_id || item.check || item.note_label || "";
        const v = lookup.get(`${arrKey}::${itemCheck}`);
        if (!v) return item;
        return { ...item, llm_verified: v.llm_verified, llm_explanation: v.llm_explanation, final_status: v.final_status };
      });
    }
  }

  // Add top-level verification summary
  merged.llm_verification = {
    verified: verificationResult.verified,
    stats: verificationResult.stats,
  };

  // Update summary line
  const stats = verificationResult.stats;
  if (stats.items_verified > 0) {
    merged.summary = (merged.summary || "") +
      ` LLM verification: ${stats.items_verified} items checked, ${stats.pass_llm} rescued (pass_llm), ${stats.still_fail} confirmed fail.`;
  }

  return merged;
}

module.exports = {
  verifyFailedItems,
  mergeVerificationIntoResult,
  collectFailedItems,
  extractContext,
  FAIL_STATUSES,
};
