"use strict";

/**
 * Audit Tools — Professional audit analytics for LumiGate.
 *
 * Tools:
 *   1. audit_sampling         — MUS, random, stratified sampling
 *   2. benford_analysis       — First-digit / first-two-digit distribution + chi-square
 *   3. journal_entry_testing  — 15 standard JET tests with risk scoring
 *   4. variance_analysis      — Period-over-period, budget vs actual, ratios
 *   5. materiality_calculator — ISA 320 / PCAOB materiality computation
 *   6. reconciliation         — Auto-reconcile two datasets (exact, fuzzy, one-to-many)
 *   7. going_concern_check    — ISA 570 going concern indicators
 *   8. gl_extract             — Extract sub-ledger from GL by account code
 *   9. data_cleaning          — Auto-clean financial data
 *  10. audit_workpaper_fill   — Auto-fill audit working paper from source documents
 *  11. financial_analytics_review — Compare CY vs PY financial statements, calculate variances
 *
 * Each tool is registered via unifiedRegistry.registerTool(schema, handler).
 * Handlers are pure computation — no external dependencies.
 */

const { unifiedRegistry } = require("./unified-registry");

// ── Statistical helpers ────────────────────────────────────────────────────────

/** Normal distribution inverse CDF approximation (Beasley-Springer-Moro). */
function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2,
    -2.759285104469687e2, 1.383577518672690e2,
    -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2,
    -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1,
    -2.400758277161838e0, -2.549732539343734e0,
    4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1,
    2.445134137142996e0, 3.754408661907416e0,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Chi-square CDF approximation (Wilson-Hilferty). */
function chiSquareCDF(x, df) {
  if (df <= 0 || x < 0) return 0;
  const k = df / 2;
  return gammaCDF(x, k, 2);
}

/** Gamma CDF via series expansion. */
function gammaCDF(x, shape, scale) {
  const z = x / scale;
  if (z <= 0) return 0;
  return lowerRegGamma(shape, z);
}

/** Lower regularized incomplete gamma function P(a, x) via series. */
function lowerRegGamma(a, x) {
  if (x < 0) return 0;
  if (x === 0) return 0;
  if (x > a + 200) return 1;
  const lnGammaA = lnGamma(a);
  let sum = 1 / a;
  let term = 1 / a;
  for (let n = 1; n < 200; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < 1e-12 * Math.abs(sum)) break;
  }
  const lnResult = a * Math.log(x) - x - lnGammaA + Math.log(sum);
  return Math.min(1, Math.max(0, Math.exp(lnResult)));
}

/** Stirling's approximation for ln(Gamma(x)). */
function lnGamma(x) {
  if (x <= 0) return Infinity;
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.001208650973866179, -0.000005395239384953,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x - 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

/** Poisson factor for MUS sample size (legacy fallback). */
function poissonSampleSize(confidence, tolerableError) {
  if (tolerableError <= 0) return Infinity;
  return Math.ceil(-Math.log(1 - confidence) / tolerableError);
}

/**
 * AICPA / Deloitte confidence factor table for MUS.
 * Row = risk level, Column = expected misstatements count.
 * Used by Big 4 firms including Deloitte HK.
 */
const AICPA_FACTORS = {
  // Risk of Overreliance → confidence factors
  // "higher" = 10% risk (90% confidence), "lower" = 5% risk (95% confidence)
  higher: [2.31, 3.89, 5.33, 6.69, 8.00, 9.28, 10.54, 11.78],  // expected misstatements 0-7
  lower:  [3.00, 4.75, 6.30, 7.76, 9.16, 10.52, 11.85, 13.15],
};

/** Get AICPA confidence factor */
function getAicpaFactor(riskLevel = "lower", expectedMisstatements = 0) {
  const factors = AICPA_FACTORS[riskLevel] || AICPA_FACTORS.lower;
  const idx = Math.min(Math.max(Math.round(expectedMisstatements), 0), factors.length - 1);
  return factors[idx];
}

/** MUS sample size using AICPA factor table (Deloitte method) */
function musSampleSizeAicpa(populationTotal, tolerableMisstatement, riskLevel = "lower", expectedMisstatements = 0) {
  if (tolerableMisstatement <= 0) return Math.ceil(populationTotal);
  const factor = getAicpaFactor(riskLevel, expectedMisstatements);
  const interval = tolerableMisstatement / factor;
  return Math.ceil(populationTotal / interval);
}

/** Simple linear regression: returns { slope, intercept, r2 }. */
function linearRegression(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] || 0, r2: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; syy += ys[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-15) return { slope: 0, intercept: sy / n, r2: 0 };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const ssRes = ys.reduce((s, y, i) => s + (y - (slope * xs[i] + intercept)) ** 2, 0);
  const ssTot = ys.reduce((s, y) => s + (y - sy / n) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope, intercept, r2 };
}

/** Seeded pseudo-random (xorshift32) for reproducible sampling. */
function seededRandom(seed) {
  let s = seed | 0 || 42;
  return function () {
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Levenshtein distance for fuzzy string matching. */
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

/** String similarity 0-1 based on Levenshtein. */
function stringSimilarity(a, b) {
  if (!a || !b) return 0;
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (al === bl) return 1;
  const maxLen = Math.max(al.length, bl.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(al, bl) / maxLen;
}

/** Word-overlap similarity (Jaccard on words). */
function wordOverlap(a, b) {
  if (!a || !b) return 0;
  const wordsA = new Set(a.toLowerCase().trim().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().trim().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  return intersection / Math.max(wordsA.size, wordsB.size);
}

// ── Utility helpers ───────────────────────────────────────────────────────────

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

function cleanItem(item) {
  const { _index, ...rest } = item;
  return rest;
}

function autoStrataBoundaries(items) {
  const amounts = items.map(i => i.amount).sort((a, b) => a - b);
  const q25 = amounts[Math.floor(amounts.length * 0.25)] || 0;
  const q50 = amounts[Math.floor(amounts.length * 0.50)] || 0;
  const q75 = amounts[Math.floor(amounts.length * 0.75)] || 0;
  return [0, q25, q50, q75, Infinity];
}

function getStratumLabel(amount, boundaries) {
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (amount >= boundaries[i] && amount < boundaries[i + 1]) {
      if (boundaries[i + 1] === Infinity) return `>=${boundaries[i]}`;
      return `${boundaries[i]}-${boundaries[i + 1]}`;
    }
  }
  return "other";
}

/** Parse a date string into a Date, handling various formats. */
function parseDate(str) {
  if (!str) return null;
  if (str instanceof Date) return isNaN(str.getTime()) ? null : str;
  // Handle DD/MM/YYYY, DD-MM-YYYY
  const dmy = String(str).match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) {
    const d = new Date(`${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`);
    if (!isNaN(d.getTime())) return d;
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

/** Convert amount string to number: handle parentheses, currency symbols, commas. */
function parseAmount(val) {
  if (typeof val === "number") return val;
  if (val == null) return 0;
  let s = String(val).trim();
  // Check if wrapped in parentheses (negative)
  const isNeg = /^\(.*\)$/.test(s);
  // Remove currency symbols, commas, spaces, parentheses
  s = s.replace(/[($€¥£,\s)]/g, "");
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  return isNeg ? -Math.abs(n) : n;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ── Tool 1: Audit Sampling ────────────────────────────────────────────────────

const AUDIT_SAMPLING_SCHEMA = {
  name: "audit_sampling",
  description: "Statistical sampling for audit testing. Supports Monetary Unit Sampling (MUS), random, and stratified methods. Returns selected items, sample size calculation, and sampling interval.",
  input_schema: {
    type: "object",
    properties: {
      method: {
        type: "string",
        enum: ["mus", "random", "stratified"],
        description: "Sampling method: mus (Monetary Unit Sampling), random, or stratified",
      },
      population: {
        type: "array",
        description: "Array of items. Each item should have at least an 'amount' field and optionally 'id', 'description', 'category'.",
        items: { type: "object" },
      },
      confidence: {
        type: "number",
        description: "Confidence level (e.g. 0.95 for 95%). Default: 0.95",
      },
      materiality: {
        type: "number",
        description: "Materiality threshold (tolerable misstatement amount)",
      },
      expected_error: {
        type: "number",
        description: "Expected error rate as fraction (0-1). Default: 0 for MUS, 0.01 for random",
      },
      sample_size: {
        type: "number",
        description: "Override calculated sample size (optional)",
      },
      seed: {
        type: "number",
        description: "Random seed for reproducibility (integer)",
      },
      risk_level: {
        type: "string",
        enum: ["higher", "lower"],
        description: "Risk of overreliance: higher (10%, factor 2.31+) or lower (5%, factor 3.00+). Default: lower. Used with AICPA factor table.",
      },
      expected_misstatements: {
        type: "number",
        description: "Expected number of misstatements (0-7). Default: 0. Affects confidence factor.",
      },
      value_type: {
        type: "string",
        enum: ["positive", "negative", "absolute"],
        description: "Which values to sample: positive only, negative only, or absolute value. Default: absolute.",
      },
      mode: {
        type: "string",
        enum: ["full", "incremental", "reproduce", "fixed_extend"],
        description: "Sampling mode. full: standard sampling. incremental: keep existing samples, add new ones to reach target size. reproduce: regenerate exact same sample from seed. fixed_extend: keep a fixed list and fill remaining from population.",
      },
      existing_samples: {
        type: "array",
        description: "For incremental/fixed_extend mode: array of item IDs already sampled",
        items: { type: "string" },
      },
      strata_field: {
        type: "string",
        description: "Field name to stratify by (for stratified method). Default: auto-stratify by amount ranges",
      },
    },
    required: ["method", "population"],
  },
};

async function executeAuditSampling(input) {
  const {
    method = "random",
    population = [],
    confidence = 0.95,
    materiality = 0,
    expected_error,
    sample_size: overrideSize,
    seed = 0,
    strata_field,
  } = input;

  // New AICPA/mode parameters
  const riskLevel = input.risk_level || "lower";
  const expectedMisstatements = input.expected_misstatements || 0;
  const valueType = input.value_type || "absolute";
  const mode = input.mode || "full";
  const existingSamples = new Set((input.existing_samples || []).map(String));

  if (!Array.isArray(population) || population.length === 0) {
    throw new Error("population must be a non-empty array of items");
  }

  const rand = seededRandom(seed || Date.now());

  // Parse raw items with original amounts preserved
  const rawItems = population.map((item, i) => ({
    _index: i,
    id: String(item.id || item.ID || `item_${i + 1}`),
    _rawAmount: Number(item.amount || item.Amount || item.value || 0),
    description: item.description || item.desc || item.name || "",
    category: item.category || item[strata_field] || "",
    ...item,
  }));

  // Apply value_type filter and compute sampling amount
  let items;
  if (valueType === "positive") {
    items = rawItems.filter(it => it._rawAmount > 0).map(it => ({ ...it, amount: it._rawAmount }));
  } else if (valueType === "negative") {
    items = rawItems.filter(it => it._rawAmount < 0).map(it => ({ ...it, amount: Math.abs(it._rawAmount) }));
  } else {
    // absolute (default)
    items = rawItems.map(it => ({ ...it, amount: Math.abs(it._rawAmount) }));
  }

  if (items.length === 0) {
    throw new Error(`No items match value_type '${valueType}' filter`);
  }

  const totalAmount = items.reduce((s, it) => s + it.amount, 0);
  const popSize = items.length;

  if (method === "mus") {
    // ── AICPA / Deloitte factor table calculation ──
    const tolerableMisstatement = materiality || totalAmount * 0.05;
    const factor = getAicpaFactor(riskLevel, expectedMisstatements);
    const samplingInterval = tolerableMisstatement / factor;
    const calcSize = Math.min(Math.ceil(totalAmount / samplingInterval), popSize);
    const sampleSize = overrideSize || calcSize;

    // Helper: run systematic MUS selection on a list of items with given params
    function musSelect(pool, poolTotal, interval, size, rng) {
      const start = rng() * interval;
      const selected = [];
      const selectedIds = new Set();

      // High-value items (amount >= interval)
      const highValue = pool.filter(it => it.amount >= interval);
      for (const hv of highValue) {
        if (!selectedIds.has(hv.id)) {
          selectedIds.add(hv.id);
          selected.push({ ...hv, selection_reason: "high_value_item" });
        }
      }

      // Systematic selection
      for (let target = start; selected.length < size && target < poolTotal; target += interval) {
        let cumulative = 0;
        for (const item of pool) {
          cumulative += item.amount;
          if (cumulative >= target && !selectedIds.has(item.id)) {
            selectedIds.add(item.id);
            selected.push({ ...item, selection_reason: "systematic_mus" });
            break;
          }
        }
      }
      return selected;
    }

    let selected;
    let existingKept = 0;
    let newAdded = 0;

    if (mode === "reproduce") {
      // Reproduce: exact same seed + params → identical sample
      selected = musSelect(items, totalAmount, samplingInterval, sampleSize, rand);
      selected = selected.map(it => ({
        ...it,
        is_existing: existingSamples.has(it.id),
        is_new: !existingSamples.has(it.id),
      }));
      existingKept = selected.filter(it => it.is_existing).length;
      newAdded = selected.filter(it => it.is_new).length;

    } else if (mode === "incremental") {
      // Incremental: run full selection with new params, mark existing vs new.
      // Force-include existing samples even if they wouldn't be selected.
      const musResult = musSelect(items, totalAmount, samplingInterval, sampleSize, rand);
      const musIds = new Set(musResult.map(it => it.id));

      // Start with MUS-selected items, tagged
      selected = musResult.map(it => ({
        ...it,
        selection_reason: existingSamples.has(it.id) ? "carried_forward" : it.selection_reason,
        is_existing: existingSamples.has(it.id),
        is_new: !existingSamples.has(it.id),
      }));

      // Force-include existing samples not already in MUS result
      for (const item of items) {
        if (existingSamples.has(item.id) && !musIds.has(item.id)) {
          selected.push({
            ...item,
            selection_reason: "carried_forward",
            is_existing: true,
            is_new: false,
          });
        }
      }

      existingKept = selected.filter(it => it.is_existing).length;
      newAdded = selected.filter(it => it.is_new).length;

    } else if (mode === "fixed_extend") {
      // Fixed extend: keep existing samples fixed, fill remaining spots via MUS on residual pool
      selected = [];
      const residualPool = [];

      for (const item of items) {
        if (existingSamples.has(item.id)) {
          selected.push({
            ...item,
            selection_reason: "carried_forward",
            is_existing: true,
            is_new: false,
          });
        } else {
          residualPool.push(item);
        }
      }
      existingKept = selected.length;

      const remaining = Math.max(0, sampleSize - selected.length);
      if (remaining > 0 && residualPool.length > 0) {
        const residualTotal = residualPool.reduce((s, it) => s + it.amount, 0);
        const residualInterval = residualTotal / remaining;
        const newItems = musSelect(residualPool, residualTotal, residualInterval, remaining, rand);
        selected.push(...newItems.map(it => ({
          ...it,
          is_existing: false,
          is_new: true,
        })));
      }
      newAdded = selected.filter(it => it.is_new).length;

    } else {
      // Full mode (default): standard AICPA MUS
      selected = musSelect(items, totalAmount, samplingInterval, sampleSize, rand);
      selected = selected.map(it => ({
        ...it,
        is_existing: existingSamples.has(it.id),
        is_new: !existingSamples.has(it.id),
      }));
      existingKept = selected.filter(it => it.is_existing).length;
      newAdded = selected.filter(it => it.is_new).length;
    }

    const highValueCount = items.filter(it => it.amount >= samplingInterval).length;

    return {
      data: {
        method: "MUS (AICPA Factor Table)",
        mode,
        risk_level: riskLevel,
        aicpa_factor: factor,
        population_size: popSize,
        population_total: round2(totalAmount),
        materiality: round2(tolerableMisstatement),
        sampling_interval: round2(samplingInterval),
        calculated_sample_size: calcSize,
        actual_sample_size: selected.length,
        existing_kept: existingKept,
        new_added: newAdded,
        high_value_items: highValueCount,
        seed: seed || 0,
        selected_items: selected.map(it => {
          const cleaned = cleanItem(it);
          cleaned.is_existing = !!it.is_existing;
          cleaned.is_new = !!it.is_new;
          return cleaned;
        }),
        coverage_amount: round2(selected.reduce((s, it) => s + it.amount, 0)),
        coverage_pct: round4(selected.reduce((s, it) => s + it.amount, 0) / totalAmount * 100),
      },
    };
  }

  if (method === "stratified") {
    const strata = new Map();
    const boundaries = materiality > 0
      ? [0, materiality * 0.1, materiality * 0.5, materiality, Infinity]
      : autoStrataBoundaries(items);

    for (const item of items) {
      let stratum;
      if (strata_field && item[strata_field]) {
        stratum = String(item[strata_field]);
      } else {
        stratum = getStratumLabel(item.amount, boundaries);
      }
      if (!strata.has(stratum)) strata.set(stratum, []);
      strata.get(stratum).push(item);
    }

    const expErr = expected_error != null ? expected_error : 0.01;
    const z = normInv(1 - (1 - confidence) / 2);
    const calcSize = overrideSize || Math.min(
      Math.ceil((z * z * expErr * (1 - expErr)) / (0.02 * 0.02)),
      Math.ceil(popSize * 0.25)
    );
    const sampleSize = Math.max(calcSize, strata.size * 2);

    const stratumTotals = new Map();
    for (const [name, items_s] of strata) {
      stratumTotals.set(name, items_s.reduce((s, it) => s + it.amount, 0));
    }

    const selected = [];
    const stratumResults = [];
    for (const [name, stratumItems] of strata) {
      const stratumTotal = stratumTotals.get(name);
      const proportion = totalAmount > 0 ? stratumTotal / totalAmount : 1 / strata.size;
      const n = Math.max(1, Math.round(sampleSize * proportion));
      const shuffled = [...stratumItems].sort(() => rand() - 0.5);
      const picked = shuffled.slice(0, Math.min(n, shuffled.length));
      selected.push(...picked.map(p => ({ ...p, stratum: name })));
      stratumResults.push({
        stratum: name,
        population_count: stratumItems.length,
        population_amount: round2(stratumTotal),
        sample_count: picked.length,
        sample_amount: round2(picked.reduce((s, it) => s + it.amount, 0)),
      });
    }

    return {
      data: {
        method: "Stratified Sampling",
        population_size: popSize,
        population_total: round2(totalAmount),
        confidence_level: confidence,
        total_sample_size: selected.length,
        strata_count: strata.size,
        strata_summary: stratumResults,
        selected_items: selected.map(cleanItem),
      },
    };
  }

  // Random sampling (default)
  const expErr = expected_error != null ? expected_error : 0.01;
  const z = normInv(1 - (1 - confidence) / 2);
  const calcSize = overrideSize || Math.min(
    Math.ceil((z * z * expErr * (1 - expErr)) / (0.02 * 0.02)),
    popSize
  );
  const sampleSize = Math.max(1, Math.min(calcSize, popSize));
  const shuffled = [...items].sort(() => rand() - 0.5);
  const selected = shuffled.slice(0, sampleSize);

  return {
    data: {
      method: "Simple Random Sampling",
      population_size: popSize,
      population_total: round2(totalAmount),
      confidence_level: confidence,
      z_value: round4(z),
      expected_error_rate: expErr,
      calculated_sample_size: calcSize,
      actual_sample_size: selected.length,
      selected_items: selected.map(cleanItem),
      coverage_amount: round2(selected.reduce((s, it) => s + it.amount, 0)),
      coverage_pct: round4(selected.reduce((s, it) => s + it.amount, 0) / totalAmount * 100),
    },
  };
}

// ── Tool 2: Benford's Law Analysis ────────────────────────────────────────────

const BENFORD_ANALYSIS_SCHEMA = {
  name: "benford_analysis",
  description: "Benford's Law analysis for fraud detection. Computes first-digit and first-two-digit distributions, compares against expected Benford distribution. Returns chi-square test statistic, p-value, Mean Absolute Deviation (MAD), and flags anomalous digits.",
  input_schema: {
    type: "object",
    properties: {
      data: {
        type: "array",
        description: "Array of numbers to analyze (e.g. invoice amounts, journal entry amounts). Non-positive numbers are excluded.",
        items: { type: "number" },
      },
      test: {
        type: "string",
        enum: ["first_digit", "first_two_digits", "both"],
        description: "Which test to run. Default: both",
      },
      significance: {
        type: "number",
        description: "Significance level for flagging (e.g. 0.05). Default: 0.05",
      },
    },
    required: ["data"],
  },
};

const BENFORD_FIRST = [
  0.30103, 0.17609, 0.12494, 0.09691, 0.07918,
  0.06695, 0.05799, 0.05115, 0.04576,
];

function benfordTwoDigitExpected() {
  const probs = [];
  for (let d = 10; d <= 99; d++) {
    probs.push(Math.log10(1 + 1 / d));
  }
  return probs;
}

function extractFirstDigit(n) {
  const s = String(Math.abs(n)).replace(/^0+\.?0*/, "");
  const d = parseInt(s[0], 10);
  return d >= 1 && d <= 9 ? d : null;
}

function extractFirstTwoDigits(n) {
  const s = String(Math.abs(n)).replace(/^0+\.?0*/, "").replace(".", "");
  if (s.length < 2) return null;
  const d = parseInt(s.slice(0, 2), 10);
  return d >= 10 && d <= 99 ? d : null;
}

async function executeBenfordAnalysis(input) {
  const { data = [], test = "both", significance = 0.05 } = input;

  const numbers = data.filter(n => typeof n === "number" && n > 0 && isFinite(n));
  if (numbers.length < 50) {
    throw new Error(`Benford analysis requires at least 50 positive numbers (got ${numbers.length}). Benford's Law is not reliable for small datasets.`);
  }

  const results = {};

  if (test === "first_digit" || test === "both") {
    const observed = new Array(9).fill(0);
    let validCount = 0;
    for (const n of numbers) {
      const d = extractFirstDigit(n);
      if (d != null) { observed[d - 1]++; validCount++; }
    }

    const expected = BENFORD_FIRST.map(p => p * validCount);
    let chiSquare = 0;
    const digitResults = [];
    for (let i = 0; i < 9; i++) {
      const obs = observed[i];
      const exp = expected[i];
      const obsPct = obs / validCount;
      const expPct = BENFORD_FIRST[i];
      const diff = obsPct - expPct;
      const chiComp = exp > 0 ? (obs - exp) ** 2 / exp : 0;
      chiSquare += chiComp;
      digitResults.push({
        digit: i + 1,
        observed_count: obs,
        observed_pct: round4(obsPct * 100),
        expected_pct: round4(expPct * 100),
        difference_pct: round4(diff * 100),
        chi_component: round4(chiComp),
        flag: Math.abs(diff) > 0.03 ? "ANOMALY" : "OK",
      });
    }

    const df = 8;
    const pValue = 1 - chiSquareCDF(chiSquare, df);
    const mad = digitResults.reduce((s, d) => s + Math.abs(d.difference_pct / 100), 0) / 9;

    let madConformity;
    if (mad <= 0.006) madConformity = "Close conformity";
    else if (mad <= 0.012) madConformity = "Acceptable conformity";
    else if (mad <= 0.015) madConformity = "Marginally acceptable";
    else madConformity = "Nonconformity — investigate further";

    results.first_digit = {
      valid_numbers: validCount,
      chi_square: round4(chiSquare),
      degrees_of_freedom: df,
      p_value: round4(pValue),
      significant: pValue < significance,
      mad: round4(mad),
      mad_conformity: madConformity,
      digits: digitResults,
      anomalous_digits: digitResults.filter(d => d.flag === "ANOMALY").map(d => d.digit),
      conclusion: pValue < significance
        ? `Distribution significantly deviates from Benford's Law (p=${round4(pValue)}). MAD=${round4(mad)} (${madConformity}). Investigate flagged digits.`
        : `Distribution conforms to Benford's Law (p=${round4(pValue)}). MAD=${round4(mad)} (${madConformity}).`,
    };
  }

  if (test === "first_two_digits" || test === "both") {
    const observed = new Array(90).fill(0);
    let validCount = 0;
    for (const n of numbers) {
      const d = extractFirstTwoDigits(n);
      if (d != null) { observed[d - 10]++; validCount++; }
    }

    const benfordExpected = benfordTwoDigitExpected();
    const expected = benfordExpected.map(p => p * validCount);
    let chiSquare = 0;
    const flagged = [];
    for (let i = 0; i < 90; i++) {
      const obs = observed[i];
      const exp = expected[i];
      const chiComp = exp > 0 ? (obs - exp) ** 2 / exp : 0;
      chiSquare += chiComp;
      const obsPct = obs / validCount;
      const expPct = benfordExpected[i];
      const zScore = exp > 0 ? (obs - exp) / Math.sqrt(exp) : 0;
      const isAnomalous = Math.abs(zScore) > normInv(1 - significance / 2);
      if (isAnomalous && obs > 0) {
        flagged.push({
          digits: i + 10,
          observed_count: obs,
          observed_pct: round4(obsPct * 100),
          expected_pct: round4(expPct * 100),
          z_score: round4(zScore),
          excess: obs > exp ? "over-represented" : "under-represented",
        });
      }
    }

    const df = 89;
    const pValue = 1 - chiSquareCDF(chiSquare, df);

    results.first_two_digits = {
      valid_numbers: validCount,
      chi_square: round4(chiSquare),
      degrees_of_freedom: df,
      p_value: round4(pValue),
      significant: pValue < significance,
      flagged_combinations: flagged.sort((a, b) => Math.abs(b.z_score) - Math.abs(a.z_score)),
      top_anomalies: flagged.slice(0, 10),
      conclusion: pValue < significance
        ? `First-two-digit distribution deviates from Benford's Law (p=${round4(pValue)}). ${flagged.length} digit combinations flagged.`
        : `First-two-digit distribution conforms to Benford's Law (p=${round4(pValue)}).`,
    };
  }

  return { data: results };
}

// ── Tool 3: Journal Entry Testing — 15 Standard JET Tests ─────────────────────

const JET_TESTS = [
  { id: "JET01", name: "Weekend/Holiday Entries", desc: "Entries posted on weekends or public holidays" },
  { id: "JET02", name: "Round Amount Entries", desc: "Round amounts (multiples of 1000, 10000, 100000)" },
  { id: "JET03", name: "Below Approval Threshold", desc: "Amounts just below approval thresholds (within 5%)" },
  { id: "JET04", name: "No Description", desc: "Entries without description or memo" },
  { id: "JET05", name: "Unusual Accounts", desc: "Accounts used very infrequently (1-2 times per year)" },
  { id: "JET06", name: "Non-Accounting Staff", desc: "Entries posted by users not in usual accounting staff list" },
  { id: "JET07", name: "Backdated Entries", desc: "Posting date significantly later than entry/document date" },
  { id: "JET08", name: "Keyword Flagging", desc: "Description contains sensitive keywords (error, adjust, reverse, write-off, etc.)" },
  { id: "JET09", name: "Above Materiality", desc: "Single entry amount exceeds materiality threshold" },
  { id: "JET10", name: "Related Party", desc: "Entries involving related party or intercompany accounts" },
  { id: "JET11", name: "Manual/Top-side Entries", desc: "Manual journal entries not auto-generated by system" },
  { id: "JET12", name: "Self-balancing Entries", desc: "Entry where total debit equals total credit within a single line pair" },
  { id: "JET13", name: "Duplicate Entries", desc: "Same amount + date + account appearing more than once" },
  { id: "JET14", name: "Period-end Adjustments", desc: "Entries in last 3 days of period or first 3 days of next period" },
  { id: "JET15", name: "Unusual Account Combinations", desc: "Uncommon debit/credit account pairings (e.g. revenue direct to cash)" },
];

const SENSITIVE_KEYWORDS = [
  "error", "adjust", "reverse", "reversal", "write-off", "write off", "writeoff",
  "correction", "reclass", "reclassification", "void", "cancel",
  "manual", "override", "one-time", "one time", "exceptional",
  // Chinese keywords
  "冲回", "调整", "更正", "作废", "红冲", "蓝补", "重分类", "转出", "核销",
  "手工", "手动", "特殊", "异常",
];

// Related party / intercompany indicators
const RELATED_PARTY_KEYWORDS = [
  "related", "intercompany", "inter-company", "affiliate", "subsidiary",
  "parent", "group", "intragroup", "intra-group",
  "关联方", "集团", "母公司", "子公司", "关联交易", "内部往来",
];

// Unusual account combinations that may indicate fraud or error
// Revenue accounts paired directly with cash (skipping receivables)
const UNUSUAL_COMBOS = [
  { debit: /^1[0-2]/, credit: /^[456]/, reason: "Cash/bank directly to revenue/income (skipping receivables)" },
  { debit: /^[456]/, credit: /^1[0-2]/, reason: "Revenue/income directly to cash/bank" },
  { debit: /^[56]/, credit: /^[56]/, reason: "Revenue offset against another revenue account" },
  { debit: /^[67]/, credit: /^[67]/, reason: "Expense offset against another expense account" },
  { debit: /^2[0-4]/, credit: /^1[0-2]/, reason: "Liability directly reduced with cash (potential unauthorized payment)" },
];

const JOURNAL_ENTRY_TESTING_SCHEMA = {
  name: "journal_entry_testing",
  description: "Comprehensive 15-test Journal Entry Testing (JET) suite for audit. Tests: JET01-Weekend/Holiday, JET02-Round Amounts, JET03-Below Threshold, JET04-No Description, JET05-Unusual Accounts, JET06-Non-Accounting Staff, JET07-Backdated, JET08-Keywords, JET09-Above Materiality, JET10-Related Party, JET11-Manual Entries, JET12-Self-balancing, JET13-Duplicates, JET14-Period-end, JET15-Unusual Account Combos. Returns flagged entries with risk scores.",
  input_schema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        description: "Array of journal entries. Each: { date, account_code, account_name, description, debit, credit, posted_by, entry_id, currency, posted_date, source, approved_by }",
        items: { type: "object" },
      },
      materiality: {
        type: "number",
        description: "Overall materiality threshold. Entries above this are flagged (JET09). Default: 0 (skip test)",
      },
      year_end_date: {
        type: "string",
        description: "Year-end date (YYYY-MM-DD) for period-end test (JET14). Default: inferred from entries",
      },
      approval_threshold: {
        type: "number",
        description: "Approval threshold amount. Entries just below (within 5%) are flagged (JET03). Default: 100000",
      },
      holidays: {
        type: "array",
        description: "List of holiday dates (YYYY-MM-DD) for JET01. Default: empty",
        items: { type: "string" },
      },
      usual_users: {
        type: "array",
        description: "List of expected accounting staff usernames for JET06. Default: auto-detect top-frequency users",
        items: { type: "string" },
      },
      accounting_users: {
        type: "array",
        description: "Alias for usual_users — list of known accounting department staff",
        items: { type: "string" },
      },
      round_threshold: {
        type: "number",
        description: "Minimum amount to flag as round (JET02). Default: 1000",
      },
      related_party_accounts: {
        type: "array",
        description: "Account codes known to be related party / intercompany. Default: auto-detect via keywords",
        items: { type: "string" },
      },
      thresholds: {
        type: "object",
        description: "Multiple approval thresholds. E.g. { manager: 10000, director: 50000, cfo: 100000 }",
      },
    },
    required: ["entries"],
  },
};

async function executeJournalEntryTesting(input) {
  const {
    entries = [],
    materiality = 0,
    year_end_date,
    approval_threshold = 100000,
    holidays = [],
    usual_users,
    accounting_users,
    round_threshold = 1000,
    related_party_accounts = [],
    thresholds,
  } = input;

  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("entries must be a non-empty array of journal entry records");
  }

  // Normalize entries
  const normalized = entries.map((e, idx) => ({
    _idx: idx,
    entry_id: e.entry_id || e.id || e.ID || e.je_number || `JE_${idx + 1}`,
    date: e.date || e.Date || "",
    posted_date: e.posted_date || e.posted || "",
    account_code: String(e.account_code || e.debit_account || e.account || "").trim(),
    account_name: String(e.account_name || e.account_desc || "").trim(),
    credit_account: String(e.credit_account || e.credit_acct || "").trim(),
    debit: parseAmount(e.debit),
    credit: parseAmount(e.credit),
    amount: parseAmount(e.amount || 0) || Math.max(parseAmount(e.debit), parseAmount(e.credit)),
    description: String(e.description || e.memo || e.narration || "").trim(),
    posted_by: String(e.posted_by || e.user || e.created_by || "").trim(),
    approved_by: String(e.approved_by || e.approver || "").trim(),
    source: String(e.source || e.origin || "").trim().toLowerCase(),
    currency: String(e.currency || "").trim(),
  }));

  // Compute the effective amount for each entry
  for (const e of normalized) {
    if (e.amount === 0) e.amount = Math.max(Math.abs(e.debit), Math.abs(e.credit));
  }

  const holidaySet = new Set(holidays.map(h => h.trim()));

  // Build approval thresholds list
  const thresholdLevels = thresholds
    ? Object.entries(thresholds).sort((a, b) => a[1] - b[1])
    : [[`approval`, approval_threshold]];

  // JET05: Build account frequency map
  const accountFrequency = new Map();
  for (const e of normalized) {
    if (e.account_code) {
      accountFrequency.set(e.account_code, (accountFrequency.get(e.account_code) || 0) + 1);
    }
    if (e.credit_account) {
      accountFrequency.set(e.credit_account, (accountFrequency.get(e.credit_account) || 0) + 1);
    }
  }

  // JET06: Determine usual users (auto-detect if not provided)
  const knownUsers = usual_users || accounting_users;
  let usualUserSet;
  if (knownUsers && knownUsers.length > 0) {
    usualUserSet = new Set(knownUsers.map(u => u.toLowerCase().trim()));
  } else {
    // Auto-detect: users who posted >5% of total entries are considered "usual"
    const userCounts = new Map();
    for (const e of normalized) {
      if (e.posted_by) {
        const u = e.posted_by.toLowerCase();
        userCounts.set(u, (userCounts.get(u) || 0) + 1);
      }
    }
    usualUserSet = new Set();
    const threshold5pct = normalized.length * 0.05;
    for (const [user, count] of userCounts) {
      if (count >= threshold5pct) usualUserSet.add(user);
    }
  }

  // JET14: Determine period-end dates
  let periodEnd;
  if (year_end_date) {
    periodEnd = parseDate(year_end_date);
  } else {
    // Infer from data: find latest date
    const dates = normalized.map(e => parseDate(e.date)).filter(Boolean);
    if (dates.length > 0) {
      const maxDate = new Date(Math.max(...dates.map(d => d.getTime())));
      // Assume year-end is Dec 31 of that year or the max date's month-end
      periodEnd = new Date(maxDate.getFullYear(), 11, 31);
    }
  }

  // JET15: Build account combination frequency
  const comboFrequency = new Map();
  for (const e of normalized) {
    if (e.account_code && e.credit_account) {
      const combo = `${e.account_code}:${e.credit_account}`;
      comboFrequency.set(combo, (comboFrequency.get(combo) || 0) + 1);
    }
  }
  const totalCombos = normalized.filter(e => e.account_code && e.credit_account).length;

  // JET13: Build duplicate detection key
  const duplicateMap = new Map();
  for (const e of normalized) {
    const key = `${e.date}|${e.account_code}|${e.amount}`;
    if (!duplicateMap.has(key)) duplicateMap.set(key, []);
    duplicateMap.get(key).push(e);
  }

  // Related party accounts set
  const rpAccountSet = new Set(related_party_accounts.map(a => a.toLowerCase().trim()));

  // ── Run all 15 tests ──

  const flaggedEntries = [];
  const testCounts = {};
  const testAmounts = {};
  for (const t of JET_TESTS) {
    testCounts[t.id] = 0;
    testAmounts[t.id] = 0;
  }

  for (const e of normalized) {
    const flags = [];
    let riskScore = 0;

    // JET01: Weekend/Holiday Entries
    const entryDate = parseDate(e.date) || parseDate(e.posted_date);
    if (entryDate) {
      const day = entryDate.getDay();
      if (day === 0 || day === 6) {
        flags.push({ test: "JET01", reason: `Posted on ${DAY_NAMES[day]}`, risk: 3 });
        riskScore += 3;
      }
      const isoDate = entryDate.toISOString().split("T")[0];
      if (holidaySet.has(isoDate)) {
        flags.push({ test: "JET01", reason: `Posted on holiday (${isoDate})`, risk: 3 });
        riskScore += 3;
      }
    }

    // JET02: Round Amount Entries
    const amt = Math.abs(e.amount);
    if (amt >= round_threshold && amt % 1000 === 0) {
      const magnitude = amt >= 100000 ? "100K+" : amt >= 10000 ? "10K+" : "1K+";
      const riskPts = amt >= 100000 ? 3 : amt >= 10000 ? 2 : 1;
      flags.push({ test: "JET02", reason: `Round amount: ${amt} (${magnitude})`, risk: riskPts });
      riskScore += riskPts;
    }

    // JET03: Below Approval Threshold (within 5%)
    for (const [level, threshold] of thresholdLevels) {
      const margin = threshold * 0.05;
      if (amt < threshold && amt >= threshold - margin && amt > 0) {
        flags.push({ test: "JET03", reason: `Just below ${level} threshold (${amt} vs ${threshold}, ${round2((threshold - amt) / threshold * 100)}% below)`, risk: 4 });
        riskScore += 4;
        break;
      }
    }

    // JET04: No Description
    if (!e.description) {
      flags.push({ test: "JET04", reason: "No description/memo provided", risk: 2 });
      riskScore += 2;
    }

    // JET05: Unusual Accounts (frequency <= 2 in the dataset)
    if (e.account_code && (accountFrequency.get(e.account_code) || 0) <= 2) {
      flags.push({ test: "JET05", reason: `Rarely used account: ${e.account_code} ${e.account_name} (used ${accountFrequency.get(e.account_code)} time(s))`, risk: 2 });
      riskScore += 2;
    }

    // JET06: Non-Accounting Staff
    if (e.posted_by && usualUserSet.size > 0 && !usualUserSet.has(e.posted_by.toLowerCase())) {
      flags.push({ test: "JET06", reason: `Non-accounting user: ${e.posted_by}`, risk: 3 });
      riskScore += 3;
    }

    // JET07: Backdated Entries
    if (e.date && e.posted_date) {
      const docDate = parseDate(e.date);
      const postDate = parseDate(e.posted_date);
      if (docDate && postDate) {
        const diffDays = (postDate - docDate) / (1000 * 60 * 60 * 24);
        if (diffDays > 7) {
          const riskPts = diffDays > 30 ? 5 : 3;
          flags.push({ test: "JET07", reason: `Backdated by ${Math.round(diffDays)} days (doc: ${e.date}, posted: ${e.posted_date})`, risk: riskPts });
          riskScore += riskPts;
        }
      }
    }

    // JET08: Keyword Flagging
    const descLower = (e.description || "").toLowerCase();
    const matchedKeywords = SENSITIVE_KEYWORDS.filter(kw => descLower.includes(kw));
    if (matchedKeywords.length > 0) {
      flags.push({ test: "JET08", reason: `Sensitive keywords: ${matchedKeywords.join(", ")}`, risk: 2 + matchedKeywords.length });
      riskScore += 2 + matchedKeywords.length;
    }

    // JET09: Above Materiality
    if (materiality > 0 && amt >= materiality) {
      flags.push({ test: "JET09", reason: `Amount ${amt} exceeds materiality ${materiality} (${round2(amt / materiality * 100)}%)`, risk: 4 });
      riskScore += 4;
    }

    // JET10: Related Party
    const isRP = (
      rpAccountSet.has((e.account_code || "").toLowerCase()) ||
      rpAccountSet.has((e.credit_account || "").toLowerCase()) ||
      RELATED_PARTY_KEYWORDS.some(kw => descLower.includes(kw)) ||
      RELATED_PARTY_KEYWORDS.some(kw => (e.account_name || "").toLowerCase().includes(kw))
    );
    if (isRP) {
      flags.push({ test: "JET10", reason: `Related party/intercompany entry detected`, risk: 3 });
      riskScore += 3;
    }

    // JET11: Manual/Top-side Entries
    const isManual = (
      e.source === "manual" || e.source === "topside" || e.source === "top-side" ||
      e.source === "" || // no source often means manual
      descLower.includes("manual") || descLower.includes("top-side") || descLower.includes("topside") ||
      descLower.includes("手工") || descLower.includes("手动")
    );
    // Only flag if source is explicitly manual or description says so (empty source alone is too noisy)
    if (e.source === "manual" || e.source === "topside" || e.source === "top-side" ||
        descLower.includes("manual") || descLower.includes("top-side") || descLower.includes("topside") ||
        descLower.includes("手工") || descLower.includes("手动")) {
      flags.push({ test: "JET11", reason: `Manual/top-side entry (source: ${e.source || "keyword in description"})`, risk: 3 });
      riskScore += 3;
    }

    // JET12: Self-balancing Entries
    if (e.debit > 0 && e.credit > 0 && Math.abs(e.debit - e.credit) < 0.01) {
      flags.push({ test: "JET12", reason: `Self-balancing: debit ${e.debit} = credit ${e.credit}`, risk: 4 });
      riskScore += 4;
    } else if (e.account_code && e.credit_account && e.account_code === e.credit_account) {
      flags.push({ test: "JET12", reason: `Same debit and credit account: ${e.account_code}`, risk: 5 });
      riskScore += 5;
    }

    // JET13: Duplicate Entries
    const dupeKey = `${e.date}|${e.account_code}|${e.amount}`;
    const dupeGroup = duplicateMap.get(dupeKey) || [];
    if (dupeGroup.length > 1) {
      flags.push({ test: "JET13", reason: `Duplicate: ${dupeGroup.length} entries with same date/account/amount (${dupeKey})`, risk: 3 });
      riskScore += 3;
    }

    // JET14: Period-end Adjustments
    if (periodEnd && entryDate) {
      const diffFromEnd = (entryDate - periodEnd) / (1000 * 60 * 60 * 24);
      // Last 3 days of period or first 3 days of next period
      if (diffFromEnd >= -3 && diffFromEnd <= 3) {
        const side = diffFromEnd <= 0 ? "last 3 days of period" : "first 3 days of next period";
        flags.push({ test: "JET14", reason: `Period-end entry: ${side} (${entryDate.toISOString().split("T")[0]})`, risk: 2 });
        riskScore += 2;
      }
      // Also check quarter-ends
      const month = entryDate.getMonth(); // 0-based
      const dayOfMonth = entryDate.getDate();
      const daysInMonth = new Date(entryDate.getFullYear(), month + 1, 0).getDate();
      if ([2, 5, 8, 11].includes(month) && dayOfMonth >= daysInMonth - 2) {
        flags.push({ test: "JET14", reason: `Quarter-end entry: last 3 days of Q${Math.floor(month / 3) + 1}`, risk: 1 });
        riskScore += 1;
      }
    }

    // JET15: Unusual Account Combinations
    if (e.account_code && e.credit_account) {
      // Check against known unusual patterns
      for (const combo of UNUSUAL_COMBOS) {
        if (combo.debit.test(e.account_code) && combo.credit.test(e.credit_account)) {
          flags.push({ test: "JET15", reason: `Unusual combo: ${e.account_code} -> ${e.credit_account} (${combo.reason})`, risk: 3 });
          riskScore += 3;
          break;
        }
      }
      // Also flag very rare combinations (used only once)
      const comboKey = `${e.account_code}:${e.credit_account}`;
      if ((comboFrequency.get(comboKey) || 0) === 1 && totalCombos > 20) {
        flags.push({ test: "JET15", reason: `One-time account combination: ${e.account_code} -> ${e.credit_account}`, risk: 1 });
        riskScore += 1;
      }
    }

    // Record results
    if (flags.length > 0) {
      // Count per test
      const testsHit = new Set();
      for (const f of flags) {
        if (!testsHit.has(f.test)) {
          testCounts[f.test] = (testCounts[f.test] || 0) + 1;
          testAmounts[f.test] = (testAmounts[f.test] || 0) + amt;
          testsHit.add(f.test);
        }
      }

      flaggedEntries.push({
        entry_id: e.entry_id,
        date: e.date,
        account_code: e.account_code,
        account_name: e.account_name,
        credit_account: e.credit_account,
        description: e.description || "(none)",
        debit: e.debit,
        credit: e.credit,
        amount: amt,
        posted_by: e.posted_by || "unknown",
        currency: e.currency,
        risk_score: riskScore,
        risk_level: riskScore >= 10 ? "HIGH" : riskScore >= 5 ? "MEDIUM" : "LOW",
        tests_failed: flags.map(f => f.test),
        flags: flags.map(f => ({ test: f.test, name: JET_TESTS.find(t => t.id === f.test)?.name || f.test, reason: f.reason })),
      });
    }
  }

  // Sort by risk score descending
  flaggedEntries.sort((a, b) => b.risk_score - a.risk_score);

  // Compute overall risk score (1-5 scale)
  const flagRate = flaggedEntries.length / normalized.length;
  const highRiskCount = flaggedEntries.filter(e => e.risk_level === "HIGH").length;
  const avgRiskScore = flaggedEntries.length > 0
    ? flaggedEntries.reduce((s, e) => s + e.risk_score, 0) / flaggedEntries.length
    : 0;
  const overallRisk = Math.min(5, Math.max(1,
    flagRate * 10 + (highRiskCount / Math.max(1, normalized.length)) * 20 + avgRiskScore / 5
  ));

  const byTest = JET_TESTS.map(t => ({
    id: t.id,
    name: t.name,
    description: t.desc,
    count: testCounts[t.id] || 0,
    total_amount: round2(testAmounts[t.id] || 0),
  })).filter(t => t.count > 0);

  return {
    data: {
      summary: {
        total_entries: normalized.length,
        total_flagged: flaggedEntries.length,
        flag_rate: round4(flagRate * 100) + "%",
        risk_distribution: {
          high: flaggedEntries.filter(e => e.risk_level === "HIGH").length,
          medium: flaggedEntries.filter(e => e.risk_level === "MEDIUM").length,
          low: flaggedEntries.filter(e => e.risk_level === "LOW").length,
        },
        by_test: byTest,
      },
      flagged_entries: flaggedEntries,
      top_risk_entries: flaggedEntries.slice(0, 25),
      risk_score: round2(overallRisk),
      risk_level: overallRisk >= 4 ? "HIGH" : overallRisk >= 2.5 ? "MEDIUM" : "LOW",
      recommendations: [
        highRiskCount > 0 ? `${highRiskCount} HIGH-risk entries require immediate investigation` : null,
        testCounts["JET03"] > 0 ? `${testCounts["JET03"]} entries just below approval thresholds — potential threshold manipulation (JET03)` : null,
        testCounts["JET01"] > 0 ? `${testCounts["JET01"]} weekend/holiday postings — verify authorization (JET01)` : null,
        testCounts["JET07"] > 0 ? `${testCounts["JET07"]} backdated entries — verify business justification (JET07)` : null,
        testCounts["JET12"] > 0 ? `${testCounts["JET12"]} self-balancing entries — potential fictitious transactions (JET12)` : null,
        testCounts["JET13"] > 0 ? `${testCounts["JET13"]} duplicate entries — verify not double-posted (JET13)` : null,
        testCounts["JET10"] > 0 ? `${testCounts["JET10"]} related party entries — ensure proper disclosure (JET10)` : null,
        testCounts["JET08"] > 0 ? `${testCounts["JET08"]} entries with sensitive keywords — review adjustments (JET08)` : null,
        testCounts["JET14"] > 0 ? `${testCounts["JET14"]} period-end entries — increased scrutiny for earnings management (JET14)` : null,
        testCounts["JET15"] > 0 ? `${testCounts["JET15"]} unusual account combinations — verify business rationale (JET15)` : null,
      ].filter(Boolean),
      tests_applied: JET_TESTS.map(t => ({ id: t.id, name: t.name })),
    },
  };
}

// ── Tool 4: Variance Analysis ─────────────────────────────────────────────────

const VARIANCE_ANALYSIS_SCHEMA = {
  name: "variance_analysis",
  description: "Analytical procedures for audit: period-over-period comparison, budget vs actual, trend analysis with regression, and financial ratio analysis. Flags material variances based on configurable thresholds.",
  input_schema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["period_comparison", "budget_vs_actual", "trend", "ratio_analysis"],
        description: "Type of analysis. Default: period_comparison",
      },
      current: {
        type: "object",
        description: "Current period data. Key-value pairs of account names to amounts. E.g. {\"Revenue\": 1000000, \"COGS\": 600000}",
      },
      prior: {
        type: "object",
        description: "Prior period or budget data. Same structure as current.",
      },
      periods: {
        type: "array",
        description: "For trend analysis: array of {period, data} objects. E.g. [{\"period\":\"2021\",\"data\":{\"Revenue\":800000}}]",
        items: { type: "object" },
      },
      materiality: {
        type: "number",
        description: "Materiality threshold (absolute amount). Variances above this are flagged.",
      },
      materiality_pct: {
        type: "number",
        description: "Materiality threshold (percentage). E.g. 0.10 for 10%. Default: 0.10",
      },
      financial_data: {
        type: "object",
        description: "For ratio_analysis: {current_assets, current_liabilities, total_assets, total_liabilities, total_equity, revenue, cogs, net_income, ebitda, interest_expense, total_debt, inventory, receivables, payables}",
      },
    },
    required: [],
  },
};

async function executeVarianceAnalysis(input) {
  const {
    type = "period_comparison",
    current = {},
    prior = {},
    periods = [],
    materiality = 0,
    materiality_pct = 0.10,
    financial_data = {},
  } = input;

  if (type === "ratio_analysis") {
    return executeRatioAnalysis(financial_data);
  }

  if (type === "trend" && periods.length >= 2) {
    return executeTrendAnalysis(periods, materiality, materiality_pct);
  }

  // Period comparison / Budget vs Actual
  const label = type === "budget_vs_actual" ? "Budget" : "Prior";
  const allKeys = new Set([...Object.keys(current), ...Object.keys(prior)]);
  const variances = [];

  for (const key of allKeys) {
    const curVal = Number(current[key] || 0);
    const priorVal = Number(prior[key] || 0);
    const diff = curVal - priorVal;
    const pctChange = priorVal !== 0 ? diff / Math.abs(priorVal) : (curVal !== 0 ? 1 : 0);
    const isMaterial = (materiality > 0 && Math.abs(diff) >= materiality) ||
      Math.abs(pctChange) >= materiality_pct;

    variances.push({
      account: key,
      current: round2(curVal),
      [label.toLowerCase()]: round2(priorVal),
      variance: round2(diff),
      variance_pct: round4(pctChange * 100),
      flag: isMaterial ? "MATERIAL" : "OK",
      direction: diff > 0 ? "increase" : diff < 0 ? "decrease" : "unchanged",
    });
  }

  variances.sort((a, b) => Math.abs(b.variance_pct) - Math.abs(a.variance_pct));
  const materialVars = variances.filter(v => v.flag === "MATERIAL");

  return {
    data: {
      analysis_type: type === "budget_vs_actual" ? "Budget vs Actual" : "Period-over-Period Comparison",
      accounts_analyzed: variances.length,
      material_variances: materialVars.length,
      materiality_threshold: materiality > 0 ? `${materiality} (amount)` : `${materiality_pct * 100}% (percentage)`,
      variances,
      material_items: materialVars,
      summary: materialVars.length > 0
        ? `${materialVars.length} material variances identified out of ${variances.length} accounts.`
        : "No material variances identified.",
    },
  };
}

function executeTrendAnalysis(periods, materiality, materialityPct) {
  const labels = periods.map(p => p.period || p.label || "");
  const allKeys = new Set();
  for (const p of periods) {
    if (p.data && typeof p.data === "object") {
      Object.keys(p.data).forEach(k => allKeys.add(k));
    }
  }

  const trends = [];
  for (const key of allKeys) {
    const values = periods.map(p => Number(p.data?.[key] || 0));
    const xs = values.map((_, i) => i);
    const reg = linearRegression(xs, values);
    const lastIdx = values.length - 1;
    const predicted = reg.slope * lastIdx + reg.intercept;
    const residual = values[lastIdx] - predicted;
    const cagr = values[0] > 0 && values[lastIdx] > 0
      ? Math.pow(values[lastIdx] / values[0], 1 / lastIdx) - 1
      : 0;
    const residualPct = predicted !== 0 ? residual / Math.abs(predicted) : 0;
    const isMaterial = (materiality > 0 && Math.abs(residual) >= materiality) ||
      Math.abs(residualPct) >= materialityPct;

    trends.push({
      account: key,
      values: values.map(round2),
      periods: labels,
      trend_slope: round4(reg.slope),
      trend_intercept: round2(reg.intercept),
      r_squared: round4(reg.r2),
      cagr: round4(cagr * 100) + "%",
      latest_predicted: round2(predicted),
      latest_actual: round2(values[lastIdx]),
      residual: round2(residual),
      residual_pct: round4(residualPct * 100),
      flag: isMaterial ? "DEVIATION" : "OK",
    });
  }

  return {
    data: {
      analysis_type: "Trend Analysis (Regression)",
      periods_analyzed: periods.length,
      accounts: trends.length,
      flagged: trends.filter(t => t.flag === "DEVIATION").length,
      trends: trends.sort((a, b) => Math.abs(b.residual_pct) - Math.abs(a.residual_pct)),
    },
  };
}

function executeRatioAnalysis(fd) {
  const ratios = [];

  if (fd.current_assets != null && fd.current_liabilities != null && fd.current_liabilities !== 0) {
    const cr = fd.current_assets / fd.current_liabilities;
    ratios.push({ category: "Liquidity", name: "Current Ratio", value: round4(cr), benchmark: "1.5-3.0", flag: cr < 1 ? "WARNING" : "OK" });
  }
  if (fd.current_assets != null && fd.inventory != null && fd.current_liabilities != null && fd.current_liabilities !== 0) {
    const qr = (fd.current_assets - (fd.inventory || 0)) / fd.current_liabilities;
    ratios.push({ category: "Liquidity", name: "Quick Ratio", value: round4(qr), benchmark: "1.0-2.0", flag: qr < 0.8 ? "WARNING" : "OK" });
  }
  if (fd.net_income != null && fd.revenue != null && fd.revenue !== 0) {
    const npm = fd.net_income / fd.revenue;
    ratios.push({ category: "Profitability", name: "Net Profit Margin", value: round4(npm * 100) + "%", benchmark: "Industry-dependent", flag: npm < 0 ? "WARNING" : "OK" });
  }
  if (fd.revenue != null && fd.cogs != null && fd.revenue !== 0) {
    const gpm = (fd.revenue - fd.cogs) / fd.revenue;
    ratios.push({ category: "Profitability", name: "Gross Profit Margin", value: round4(gpm * 100) + "%", benchmark: "Industry-dependent", flag: gpm < 0 ? "WARNING" : "OK" });
  }
  if (fd.net_income != null && fd.total_assets != null && fd.total_assets !== 0) {
    const roa = fd.net_income / fd.total_assets;
    ratios.push({ category: "Profitability", name: "ROA", value: round4(roa * 100) + "%", benchmark: ">5%", flag: roa < 0.02 ? "WARNING" : "OK" });
  }
  if (fd.net_income != null && fd.total_equity != null && fd.total_equity !== 0) {
    const roe = fd.net_income / fd.total_equity;
    ratios.push({ category: "Profitability", name: "ROE", value: round4(roe * 100) + "%", benchmark: ">10%", flag: roe < 0.05 ? "WARNING" : "OK" });
  }
  if (fd.total_liabilities != null && fd.total_equity != null && fd.total_equity !== 0) {
    const de = fd.total_liabilities / fd.total_equity;
    ratios.push({ category: "Leverage", name: "Debt-to-Equity", value: round4(de), benchmark: "<2.0", flag: de > 3 ? "WARNING" : "OK" });
  }
  if (fd.total_liabilities != null && fd.total_assets != null && fd.total_assets !== 0) {
    const da = fd.total_liabilities / fd.total_assets;
    ratios.push({ category: "Leverage", name: "Debt-to-Assets", value: round4(da), benchmark: "<0.6", flag: da > 0.7 ? "WARNING" : "OK" });
  }
  if (fd.ebitda != null && fd.interest_expense != null && fd.interest_expense !== 0) {
    const icr = fd.ebitda / fd.interest_expense;
    ratios.push({ category: "Leverage", name: "Interest Coverage", value: round4(icr), benchmark: ">3.0", flag: icr < 1.5 ? "WARNING" : "OK" });
  }
  if (fd.receivables != null && fd.revenue != null && fd.revenue !== 0) {
    const dso = (fd.receivables / fd.revenue) * 365;
    ratios.push({ category: "Efficiency", name: "Days Sales Outstanding", value: round2(dso), benchmark: "<45 days", flag: dso > 60 ? "WARNING" : "OK" });
  }
  if (fd.inventory != null && fd.cogs != null && fd.cogs !== 0) {
    const dio = (fd.inventory / fd.cogs) * 365;
    ratios.push({ category: "Efficiency", name: "Days Inventory Outstanding", value: round2(dio), benchmark: "<60 days", flag: dio > 90 ? "WARNING" : "OK" });
  }
  if (fd.payables != null && fd.cogs != null && fd.cogs !== 0) {
    const dpo = (fd.payables / fd.cogs) * 365;
    ratios.push({ category: "Efficiency", name: "Days Payable Outstanding", value: round2(dpo), benchmark: "30-60 days", flag: dpo > 90 ? "WARNING" : "OK" });
  }

  const warnings = ratios.filter(r => r.flag === "WARNING");

  return {
    data: {
      analysis_type: "Financial Ratio Analysis",
      ratios,
      warning_count: warnings.length,
      warnings,
      summary: warnings.length > 0
        ? `${warnings.length} ratios outside normal ranges — review required.`
        : "All ratios within acceptable ranges.",
    },
  };
}

// ── Tool 5: Materiality Calculator ────────────────────────────────────────────

const MATERIALITY_CALCULATOR_SCHEMA = {
  name: "materiality_calculator",
  description: "Calculate audit materiality levels based on ISA 320/PCAOB guidelines. Uses multiple benchmarks (revenue, total assets, net income, equity) and returns overall materiality, performance materiality, and trivial threshold (de minimis).",
  input_schema: {
    type: "object",
    properties: {
      revenue: { type: "number", description: "Total revenue" },
      total_assets: { type: "number", description: "Total assets" },
      net_income: { type: "number", description: "Net income (pre-tax)" },
      equity: { type: "number", description: "Total equity / net assets" },
      total_expenses: { type: "number", description: "Total expenses (optional benchmark)" },
      entity_type: {
        type: "string",
        enum: ["public", "private", "nonprofit", "government"],
        description: "Entity type affects benchmark selection. Default: private",
      },
      risk_level: {
        type: "string",
        enum: ["low", "normal", "high"],
        description: "Overall audit risk level. Affects performance materiality %. Default: normal",
      },
      custom_benchmarks: {
        type: "object",
        description: "Override default benchmark percentages. E.g. {\"revenue_pct\": 0.005}",
      },
    },
    required: [],
  },
};

async function executeMaterialityCalculator(input) {
  const {
    revenue, total_assets, net_income, equity, total_expenses,
    entity_type = "private",
    risk_level = "normal",
    custom_benchmarks = {},
  } = input;

  const benchmarkRanges = {
    public: {
      revenue: [0.005, 0.01], total_assets: [0.005, 0.01],
      net_income: [0.05, 0.10], equity: [0.01, 0.02], total_expenses: [0.005, 0.01],
    },
    private: {
      revenue: [0.005, 0.02], total_assets: [0.005, 0.02],
      net_income: [0.05, 0.10], equity: [0.01, 0.02], total_expenses: [0.005, 0.02],
    },
    nonprofit: {
      revenue: [0.005, 0.02], total_assets: [0.005, 0.02], total_expenses: [0.005, 0.02],
    },
    government: {
      revenue: [0.005, 0.01], total_assets: [0.003, 0.01], total_expenses: [0.005, 0.01],
    },
  };

  const ranges = benchmarkRanges[entity_type] || benchmarkRanges.private;
  const benchmarks = [];

  const addBenchmark = (name, value, rangeKey) => {
    if (value == null || value === 0) return;
    const absVal = Math.abs(value);
    const range = ranges[rangeKey];
    if (!range) return;
    const midPct = (range[0] + range[1]) / 2;
    benchmarks.push({
      benchmark: name,
      base_amount: round2(absVal),
      low_pct: `${round4(range[0] * 100)}%`,
      high_pct: `${round4(range[1] * 100)}%`,
      materiality_low: round2(absVal * range[0]),
      materiality_mid: round2(absVal * midPct),
      materiality_high: round2(absVal * range[1]),
      applied_pct: `${round4(midPct * 100)}%`,
      materiality: round2(absVal * midPct),
    });
  };

  addBenchmark("Revenue", revenue, "revenue");
  addBenchmark("Total Assets", total_assets, "total_assets");
  addBenchmark("Net Income (pre-tax)", net_income, "net_income");
  addBenchmark("Equity", equity, "equity");
  addBenchmark("Total Expenses", total_expenses, "total_expenses");

  if (benchmarks.length === 0) {
    throw new Error("At least one financial figure (revenue, total_assets, net_income, equity) is required");
  }

  const materialities = benchmarks.map(b => b.materiality).sort((a, b) => a - b);
  const medianIdx = Math.floor(materialities.length / 2);
  const overallMateriality = materialities.length % 2 === 0
    ? (materialities[medianIdx - 1] + materialities[medianIdx]) / 2
    : materialities[medianIdx];

  const perfPct = risk_level === "high" ? 0.50 : risk_level === "low" ? 0.75 : 0.65;
  const performanceMateriality = round2(overallMateriality * perfPct);
  const trivialThreshold = round2(overallMateriality * 0.05);
  const sadThreshold = round2(overallMateriality * 0.05);

  return {
    data: {
      entity_type, risk_level, benchmarks,
      overall_materiality: round2(overallMateriality),
      performance_materiality: performanceMateriality,
      performance_materiality_pct: `${round2(perfPct * 100)}% of overall`,
      trivial_threshold: trivialThreshold,
      sad_threshold: sadThreshold,
      selected_method: "Median of applicable benchmarks",
      guidance: [
        `Overall Materiality: ${round2(overallMateriality).toLocaleString()} — misstatements above this are material`,
        `Performance Materiality: ${performanceMateriality.toLocaleString()} — used to determine nature/timing/extent of procedures`,
        `Trivial Threshold: ${trivialThreshold.toLocaleString()} — misstatements below this are clearly trivial (de minimis)`,
        `SAD Threshold: ${sadThreshold.toLocaleString()} — accumulate differences above this on the Summary of Audit Differences`,
      ],
      isa_reference: "ISA 320 (Materiality in Planning and Performing an Audit), ISA 450 (Evaluation of Misstatements)",
    },
  };
}

// ── Tool 6: Reconciliation (Enhanced) ─────────────────────────────────────────

const RECONCILIATION_SCHEMA = {
  name: "reconciliation",
  description: "Auto-reconcile two datasets by matching on amount, date, reference, or description. Supports exact, fuzzy (tolerance), one-to-many, and description-based matching. Commonly used for bank-to-GL, sub-ledger-to-GL, or inter-company reconciliation.",
  input_schema: {
    type: "object",
    properties: {
      dataset_a: {
        type: "array",
        description: "First dataset (e.g. bank statement). Each item: {id, date, amount, reference, description}",
        items: { type: "object" },
      },
      dataset_b: {
        type: "array",
        description: "Second dataset (e.g. general ledger). Same structure.",
        items: { type: "object" },
      },
      label_a: { type: "string", description: "Label for dataset A (e.g. 'Bank Statement'). Default: 'Dataset A'" },
      label_b: { type: "string", description: "Label for dataset B (e.g. 'General Ledger'). Default: 'Dataset B'" },
      match_on: {
        type: "array",
        description: "Fields to match on. Options: 'amount', 'date', 'reference', 'description'. Default: ['amount']",
        items: { type: "string" },
      },
      match_fields: {
        type: "array",
        description: "Alias for match_on",
        items: { type: "string" },
      },
      tolerance: {
        type: "number",
        description: "Amount tolerance for fuzzy matching (e.g. 0.01 for penny rounding). Default: 0.01",
      },
      tolerance_amount: {
        type: "number",
        description: "Alias for tolerance",
      },
      tolerance_days: {
        type: "number",
        description: "Date tolerance in days for matching (e.g. 3 for T+3). Default: 3",
      },
      allow_many_to_one: {
        type: "boolean",
        description: "Allow multiple items from one side to match a single item on the other (split payments). Default: false",
      },
    },
    required: ["dataset_a", "dataset_b"],
  },
};

async function executeReconciliation(input) {
  const {
    dataset_a = [],
    dataset_b = [],
    label_a = "Dataset A",
    label_b = "Dataset B",
    tolerance = 0.01,
    tolerance_amount,
    tolerance_days = 3,
    allow_many_to_one = false,
  } = input;

  const matchFields = input.match_on || input.match_fields || ["amount"];
  const amtTolerance = tolerance_amount != null ? tolerance_amount : tolerance;

  if (!dataset_a.length || !dataset_b.length) {
    throw new Error("Both datasets must be non-empty");
  }

  const normalize = (items, label) => items.map((item, i) => ({
    _idx: i,
    _source: label,
    id: item.id || item.ID || item.ref || `${label}_${i + 1}`,
    date: item.date || item.Date || "",
    amount: Number(item.amount || item.Amount || item.value || item.debit || item.credit || 0),
    reference: (item.reference || item.ref || item.check_no || "").toString().trim(),
    description: (item.description || item.desc || item.memo || item.narration || "").toString().trim(),
  }));

  const itemsA = normalize(dataset_a, label_a);
  const itemsB = normalize(dataset_b, label_b);

  const matchedPairs = [];
  const usedA = new Set();
  const usedB = new Set();

  // Scoring function
  function matchScore(a, b) {
    let score = 0;
    let maxScore = 0;

    if (matchFields.includes("amount")) {
      maxScore += 10;
      if (Math.abs(a.amount - b.amount) <= amtTolerance) score += 10;
      else if (Math.abs(a.amount - b.amount) <= amtTolerance * 10) score += 5;
    }

    if (matchFields.includes("date") && a.date && b.date) {
      maxScore += 5;
      const da = parseDate(a.date);
      const db = parseDate(b.date);
      if (da && db) {
        const diffDays = Math.abs(da - db) / (1000 * 60 * 60 * 24);
        if (diffDays <= tolerance_days) score += 5;
        else if (diffDays <= tolerance_days * 2) score += 2;
      }
    }

    if (matchFields.includes("reference") && a.reference && b.reference) {
      maxScore += 8;
      if (a.reference === b.reference) score += 8;
      else if (a.reference.includes(b.reference) || b.reference.includes(a.reference)) score += 4;
    }

    if (matchFields.includes("description") && a.description && b.description) {
      maxScore += 5;
      const similarity = Math.max(
        stringSimilarity(a.description, b.description),
        wordOverlap(a.description, b.description)
      );
      if (similarity >= 0.9) score += 5;
      else if (similarity >= 0.7) score += 4;
      else if (similarity >= 0.5) score += 3;
      else if (similarity >= 0.3) score += 1;
    }

    return { score, maxScore, confidence: maxScore > 0 ? score / maxScore : 0 };
  }

  // Phase 1: Exact matching (highest confidence first)
  const candidates = [];
  for (const a of itemsA) {
    for (const b of itemsB) {
      const m = matchScore(a, b);
      if (m.confidence >= 0.5) {
        candidates.push({ a, b, ...m });
      }
    }
  }
  candidates.sort((x, y) => y.confidence - x.confidence);

  // Greedy one-to-one matching
  for (const cand of candidates) {
    if (!allow_many_to_one) {
      if (usedA.has(cand.a._idx) || usedB.has(cand.b._idx)) continue;
    } else {
      if (usedA.has(cand.a._idx) && usedB.has(cand.b._idx)) continue;
    }
    usedA.add(cand.a._idx);
    usedB.add(cand.b._idx);
    matchedPairs.push({
      [`${label_a}_id`]: cand.a.id,
      [`${label_b}_id`]: cand.b.id,
      [`${label_a}_amount`]: round2(cand.a.amount),
      [`${label_b}_amount`]: round2(cand.b.amount),
      difference: round2(cand.a.amount - cand.b.amount),
      [`${label_a}_date`]: cand.a.date,
      [`${label_b}_date`]: cand.b.date,
      match_type: cand.confidence >= 0.9 ? "exact" : cand.confidence >= 0.7 ? "fuzzy" : "weak",
      match_confidence: round4(cand.confidence * 100) + "%",
      match_score: cand.score,
    });
  }

  // Phase 2: One-to-many matching for unmatched items
  const oneToManyMatches = [];
  if (allow_many_to_one) {
    // Try to match multiple unmatched B items to a single unmatched A item
    const unmatchedAItems = itemsA.filter(a => !usedA.has(a._idx));
    const unmatchedBItems = itemsB.filter(b => !usedB.has(b._idx));

    for (const aItem of unmatchedAItems) {
      // Find combination of B items that sum to A's amount
      const bCandidates = unmatchedBItems
        .filter(b => !usedB.has(b._idx) && Math.abs(b.amount) <= Math.abs(aItem.amount) + amtTolerance)
        .sort((x, y) => y.amount - x.amount);

      if (bCandidates.length < 2) continue;

      // Greedy subset-sum: try to find a subset that matches
      let remaining = aItem.amount;
      const matched = [];
      for (const b of bCandidates) {
        if (Math.abs(remaining - b.amount) <= amtTolerance) {
          matched.push(b);
          remaining -= b.amount;
          break;
        } else if (b.amount <= remaining + amtTolerance && b.amount > 0) {
          matched.push(b);
          remaining -= b.amount;
        }
      }

      if (matched.length >= 2 && Math.abs(remaining) <= amtTolerance * matched.length) {
        usedA.add(aItem._idx);
        for (const b of matched) usedB.add(b._idx);
        oneToManyMatches.push({
          type: "one_to_many",
          [`${label_a}_id`]: aItem.id,
          [`${label_a}_amount`]: round2(aItem.amount),
          [`${label_b}_ids`]: matched.map(b => b.id),
          [`${label_b}_amounts`]: matched.map(b => round2(b.amount)),
          [`${label_b}_total`]: round2(matched.reduce((s, b) => s + b.amount, 0)),
          difference: round2(aItem.amount - matched.reduce((s, b) => s + b.amount, 0)),
          match_count: matched.length,
        });
      }
    }
  }

  const unmatchedA = itemsA.filter(a => !usedA.has(a._idx)).map(a => ({
    id: a.id, date: a.date, amount: round2(a.amount), reference: a.reference, description: a.description,
  }));
  const unmatchedB = itemsB.filter(b => !usedB.has(b._idx)).map(b => ({
    id: b.id, date: b.date, amount: round2(b.amount), reference: b.reference, description: b.description,
  }));

  const totalDifference = matchedPairs.reduce((s, p) => s + p.difference, 0);
  const unmatchedATotal = unmatchedA.reduce((s, i) => s + i.amount, 0);
  const unmatchedBTotal = unmatchedB.reduce((s, i) => s + i.amount, 0);

  return {
    data: {
      label_a, label_b,
      match_criteria: matchFields,
      tolerance: { amount: amtTolerance, days: tolerance_days },
      summary: {
        [`${label_a}_count`]: itemsA.length,
        [`${label_b}_count`]: itemsB.length,
        matched_pairs: matchedPairs.length,
        one_to_many_matches: oneToManyMatches.length,
        [`unmatched_${label_a}`]: unmatchedA.length,
        [`unmatched_${label_b}`]: unmatchedB.length,
        match_rate: round4((usedA.size / itemsA.length + usedB.size / itemsB.length) / 2 * 100) + "%",
        match_rate_a: round4(usedA.size / itemsA.length * 100) + "%",
        match_rate_b: round4(usedB.size / itemsB.length * 100) + "%",
        total_matched_difference: round2(totalDifference),
        [`unmatched_${label_a}_total`]: round2(unmatchedATotal),
        [`unmatched_${label_b}_total`]: round2(unmatchedBTotal),
        net_reconciling_difference: round2(unmatchedATotal - unmatchedBTotal + totalDifference),
      },
      matched: matchedPairs,
      one_to_many: oneToManyMatches,
      unmatched_a: unmatchedA,
      unmatched_b: unmatchedB,
      differences: matchedPairs.filter(p => Math.abs(p.difference) > amtTolerance).map(p => ({
        [`${label_a}_id`]: p[`${label_a}_id`],
        [`${label_b}_id`]: p[`${label_b}_id`],
        diff: p.difference,
      })),
      reconciling_items: [
        ...unmatchedA.map(i => ({ source: label_a, type: "unmatched", ...i })),
        ...unmatchedB.map(i => ({ source: label_b, type: "unmatched", ...i })),
        ...matchedPairs.filter(p => Math.abs(p.difference) > amtTolerance).map(p => ({
          source: "matched_difference",
          type: "timing_or_amount_difference",
          difference: p.difference,
          [`${label_a}_id`]: p[`${label_a}_id`],
          [`${label_b}_id`]: p[`${label_b}_id`],
        })),
      ],
    },
  };
}

// ── Tool 7: Going Concern Check ───────────────────────────────────────────────

const GOING_CONCERN_CHECK_SCHEMA = {
  name: "going_concern_check",
  description: "Evaluate going concern indicators per ISA 570 / PCAOB AS 2415. Checks financial indicators (negative working capital, recurring losses, debt covenants, cash burn), operating indicators, and other red flags. Returns risk assessment with required disclosures.",
  input_schema: {
    type: "object",
    properties: {
      current_year: {
        type: "object",
        description: "Current year financials: {revenue, net_income, current_assets, current_liabilities, total_assets, total_liabilities, cash, operating_cash_flow, total_debt, interest_expense, retained_earnings}",
      },
      prior_year: {
        type: "object",
        description: "Prior year financials (same structure). Used for trend comparison.",
      },
      qualitative_factors: {
        type: "object",
        description: "Qualitative indicators: {pending_litigation, regulatory_issues, loss_key_customer, loss_key_supplier, loss_key_personnel, labor_difficulties, supply_shortages, debt_covenant_breach, loan_defaults, restructuring, going_private}",
      },
      industry: {
        type: "string",
        description: "Industry context for benchmarking (optional)",
      },
    },
    required: ["current_year"],
  },
};

async function executeGoingConcernCheck(input) {
  const {
    current_year: cy = {},
    prior_year: py = {},
    qualitative_factors: qf = {},
    industry = "",
  } = input;

  const indicators = [];
  let totalScore = 0;

  function addIndicator(category, name, condition, score, detail) {
    if (condition) {
      indicators.push({ category, indicator: name, severity: score >= 3 ? "HIGH" : score >= 2 ? "MEDIUM" : "LOW", score, detail });
      totalScore += score;
    }
  }

  if (cy.current_assets != null && cy.current_liabilities != null) {
    const wc = cy.current_assets - cy.current_liabilities;
    addIndicator("Financial", "Negative working capital", wc < 0, 3,
      `Working capital: ${round2(wc)} (CA: ${round2(cy.current_assets)}, CL: ${round2(cy.current_liabilities)})`);
  }
  if (cy.current_assets != null && cy.current_liabilities != null && cy.current_liabilities > 0) {
    const cr = cy.current_assets / cy.current_liabilities;
    addIndicator("Financial", "Current ratio below 1", cr < 1, 2, `Current ratio: ${round4(cr)}`);
  }
  if (cy.net_income != null && cy.net_income < 0) {
    const consecutive = (py.net_income != null && py.net_income < 0);
    addIndicator("Financial", "Net loss in current year", true, consecutive ? 4 : 2,
      `Net income: ${round2(cy.net_income)}${consecutive ? " (consecutive losses)" : ""}`);
  }
  if (cy.operating_cash_flow != null && cy.operating_cash_flow < 0) {
    addIndicator("Financial", "Negative operating cash flow", true, 3, `Operating cash flow: ${round2(cy.operating_cash_flow)}`);
  }
  if (cy.retained_earnings != null && cy.retained_earnings < 0) {
    addIndicator("Financial", "Accumulated deficit", true, 3, `Retained earnings: ${round2(cy.retained_earnings)}`);
  }
  if (cy.total_liabilities != null && cy.total_assets != null) {
    addIndicator("Financial", "Liabilities exceed assets", cy.total_liabilities > cy.total_assets, 4,
      `Total assets: ${round2(cy.total_assets)}, Total liabilities: ${round2(cy.total_liabilities)}`);
  }
  if (cy.total_liabilities != null && cy.total_assets != null && cy.total_assets > 0) {
    const leverage = cy.total_liabilities / cy.total_assets;
    addIndicator("Financial", "High leverage ratio (>0.8)", leverage > 0.8, 2, `Debt-to-assets: ${round4(leverage)}`);
  }
  if (cy.operating_cash_flow != null && cy.interest_expense != null && cy.interest_expense > 0) {
    const icr = cy.operating_cash_flow / cy.interest_expense;
    addIndicator("Financial", "Cannot cover interest payments", icr < 1, 4, `Interest coverage (OCF/Interest): ${round4(icr)}`);
  }
  if (cy.cash != null && cy.operating_cash_flow != null && cy.operating_cash_flow < 0) {
    const monthsOfCash = cy.cash / (Math.abs(cy.operating_cash_flow) / 12);
    addIndicator("Financial", "Cash runway < 12 months", monthsOfCash < 12, monthsOfCash < 6 ? 5 : 3,
      `Estimated cash runway: ${round2(monthsOfCash)} months`);
  }
  if (cy.revenue != null && py.revenue != null && py.revenue > 0) {
    const decline = (cy.revenue - py.revenue) / py.revenue;
    addIndicator("Financial", "Significant revenue decline (>20%)", decline < -0.20, 3,
      `Revenue change: ${round4(decline * 100)}% (${round2(py.revenue)} -> ${round2(cy.revenue)})`);
  }

  addIndicator("Operating", "Pending litigation", !!qf.pending_litigation, 2,
    typeof qf.pending_litigation === "string" ? qf.pending_litigation : "Pending litigation reported");
  addIndicator("Operating", "Regulatory issues", !!qf.regulatory_issues, 2,
    typeof qf.regulatory_issues === "string" ? qf.regulatory_issues : "Regulatory issues reported");
  addIndicator("Operating", "Loss of key customer", !!qf.loss_key_customer, 3,
    typeof qf.loss_key_customer === "string" ? qf.loss_key_customer : "Key customer lost");
  addIndicator("Operating", "Loss of key supplier", !!qf.loss_key_supplier, 2,
    typeof qf.loss_key_supplier === "string" ? qf.loss_key_supplier : "Key supplier lost");
  addIndicator("Operating", "Loss of key personnel", !!qf.loss_key_personnel, 2,
    typeof qf.loss_key_personnel === "string" ? qf.loss_key_personnel : "Key personnel departed");
  addIndicator("Operating", "Labor difficulties", !!qf.labor_difficulties, 1,
    typeof qf.labor_difficulties === "string" ? qf.labor_difficulties : "Labor difficulties reported");
  addIndicator("Operating", "Supply shortages", !!qf.supply_shortages, 2,
    typeof qf.supply_shortages === "string" ? qf.supply_shortages : "Supply chain disruptions");
  addIndicator("Compliance", "Debt covenant breach", !!qf.debt_covenant_breach, 4,
    typeof qf.debt_covenant_breach === "string" ? qf.debt_covenant_breach : "Debt covenant breach reported");
  addIndicator("Compliance", "Loan defaults", !!qf.loan_defaults, 5,
    typeof qf.loan_defaults === "string" ? qf.loan_defaults : "Loan defaults reported");

  let assessment;
  if (totalScore >= 15) {
    assessment = "SUBSTANTIAL DOUBT — Going concern is in significant doubt. Consider adverse/disclaimer opinion or emphasis-of-matter paragraph.";
  } else if (totalScore >= 8) {
    assessment = "ELEVATED RISK — Material uncertainty exists. Evaluate management's plans and consider emphasis-of-matter paragraph.";
  } else if (totalScore >= 4) {
    assessment = "MODERATE RISK — Some indicators present. Document assessment and monitor. Evaluate management representations.";
  } else {
    assessment = "LOW RISK — No significant going concern indicators identified at this time.";
  }

  const highSeverity = indicators.filter(i => i.severity === "HIGH");

  return {
    data: {
      assessment,
      total_risk_score: totalScore,
      risk_level: totalScore >= 15 ? "SUBSTANTIAL_DOUBT" : totalScore >= 8 ? "ELEVATED" : totalScore >= 4 ? "MODERATE" : "LOW",
      indicators_found: indicators.length,
      high_severity_count: highSeverity.length,
      indicators: indicators.sort((a, b) => b.score - a.score),
      required_actions: [
        totalScore >= 8 ? "Obtain written representations from management regarding their plans to mitigate going concern" : null,
        totalScore >= 8 ? "Evaluate whether management's plans are feasible and likely to be effective" : null,
        totalScore >= 15 ? "Consider impact on audit opinion — emphasis of matter or modified opinion" : null,
        totalScore >= 15 ? "Evaluate adequacy of going concern disclosures in financial statements" : null,
        highSeverity.length > 0 ? `Investigate ${highSeverity.length} high-severity indicators in detail` : null,
        indicators.some(i => i.indicator.includes("cash runway")) ? "Request 12-month cash flow projections from management" : null,
        indicators.some(i => i.indicator.includes("covenant")) ? "Review debt agreements and waiver correspondence" : null,
      ].filter(Boolean),
      isa_reference: "ISA 570 (Going Concern), PCAOB AS 2415 (Consideration of an Entity's Ability to Continue as a Going Concern)",
      industry: industry || "Not specified",
    },
  };
}

// ── Tool 8: GL Extract — Sub-ledger extraction ───────────────────────────────

const GL_EXTRACT_SCHEMA = {
  name: "gl_extract",
  description: "Extract sub-ledger entries from General Ledger by account code filter. Supports prefix matching, wildcards, regex, and date range filtering. Groups by sub-account with subtotals and running balances.",
  input_schema: {
    type: "object",
    properties: {
      gl_data: {
        type: "array",
        description: "Full GL dataset. Each entry: { date, account_code, account_name, description, debit, credit, reference, entry_id }",
        items: { type: "object" },
      },
      account_filter: {
        description: "Account code filter. String or array. Supports prefix ('6001'), wildcard ('60*'), regex ('/^6[0-9]{3}/'), or exact codes.",
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      },
      date_from: {
        type: "string",
        description: "Start date filter (inclusive, YYYY-MM-DD). Default: no start filter",
      },
      date_to: {
        type: "string",
        description: "End date filter (inclusive, YYYY-MM-DD). Default: no end filter",
      },
      include_summary: {
        type: "boolean",
        description: "Include sub-account summary with subtotals. Default: true",
      },
    },
    required: ["gl_data", "account_filter"],
  },
};

async function executeGLExtract(input) {
  const {
    gl_data = [],
    account_filter,
    date_from,
    date_to,
    include_summary = true,
  } = input;

  if (!Array.isArray(gl_data) || gl_data.length === 0) {
    throw new Error("gl_data must be a non-empty array of GL entries");
  }
  if (!account_filter) {
    throw new Error("account_filter is required");
  }

  // Build filter matchers
  const filters = Array.isArray(account_filter) ? account_filter : [account_filter];
  const matchers = filters.map(f => {
    const fStr = String(f).trim();
    // Regex filter: /pattern/
    if (fStr.startsWith("/") && fStr.lastIndexOf("/") > 0) {
      const lastSlash = fStr.lastIndexOf("/");
      const pattern = fStr.slice(1, lastSlash);
      const flags = fStr.slice(lastSlash + 1);
      try {
        return { type: "regex", re: new RegExp(pattern, flags) };
      } catch {
        return { type: "prefix", prefix: fStr };
      }
    }
    // Wildcard: 60* or 6???
    if (fStr.includes("*") || fStr.includes("?")) {
      const rePattern = fStr.replace(/\*/g, ".*").replace(/\?/g, ".");
      return { type: "regex", re: new RegExp(`^${rePattern}$`, "i") };
    }
    // Prefix match (default)
    return { type: "prefix", prefix: fStr };
  });

  function matchesAccount(code) {
    const codeStr = String(code || "").trim();
    return matchers.some(m => {
      if (m.type === "regex") return m.re.test(codeStr);
      return codeStr.startsWith(m.prefix);
    });
  }

  // Parse date boundaries
  const dateFrom = date_from ? parseDate(date_from) : null;
  const dateTo = date_to ? parseDate(date_to) : null;

  // Normalize and filter entries
  const extracted = [];
  for (const row of gl_data) {
    const code = String(row.account_code || row.account || row.acct_code || "").trim();
    if (!matchesAccount(code)) continue;

    const entryDate = parseDate(row.date || row.Date);
    if (dateFrom && entryDate && entryDate < dateFrom) continue;
    if (dateTo && entryDate && entryDate > dateTo) continue;

    // Remove blank rows (both debit and credit are 0/null)
    const debit = parseAmount(row.debit);
    const credit = parseAmount(row.credit);
    if (debit === 0 && credit === 0) continue;

    extracted.push({
      date: row.date || row.Date || "",
      account_code: code,
      account_name: String(row.account_name || row.account_desc || row.acct_name || "").trim(),
      description: String(row.description || row.memo || row.narration || "").trim(),
      debit: round2(debit),
      credit: round2(credit),
      net: round2(debit - credit),
      reference: String(row.reference || row.ref || row.entry_id || "").trim(),
      entry_id: String(row.entry_id || row.id || "").trim(),
      currency: String(row.currency || "").trim(),
    });
  }

  // Sort by date, then account code
  extracted.sort((a, b) => {
    const da = parseDate(a.date);
    const db = parseDate(b.date);
    if (da && db && da.getTime() !== db.getTime()) return da - db;
    return a.account_code.localeCompare(b.account_code);
  });

  // Group by sub-account
  const subAccounts = new Map();
  for (const e of extracted) {
    if (!subAccounts.has(e.account_code)) {
      subAccounts.set(e.account_code, {
        account_code: e.account_code,
        account_name: e.account_name,
        entries: [],
        total_debit: 0,
        total_credit: 0,
      });
    }
    const group = subAccounts.get(e.account_code);
    group.entries.push(e);
    group.total_debit += e.debit;
    group.total_credit += e.credit;
  }

  // Build summary with running balances
  const summary = [];
  for (const [code, group] of subAccounts) {
    let runningBalance = 0;
    const entriesWithBalance = group.entries.map(e => {
      runningBalance += e.net;
      return { ...e, running_balance: round2(runningBalance) };
    });

    summary.push({
      account_code: group.account_code,
      account_name: group.account_name,
      entry_count: group.entries.length,
      total_debit: round2(group.total_debit),
      total_credit: round2(group.total_credit),
      net_balance: round2(group.total_debit - group.total_credit),
      entries: entriesWithBalance,
    });
  }

  const totalDebit = extracted.reduce((s, e) => s + e.debit, 0);
  const totalCredit = extracted.reduce((s, e) => s + e.credit, 0);

  return {
    data: {
      filter_applied: filters,
      date_range: {
        from: date_from || "(no start filter)",
        to: date_to || "(no end filter)",
      },
      total_gl_records: gl_data.length,
      extracted_records: extracted.length,
      sub_accounts_found: subAccounts.size,
      total_debit: round2(totalDebit),
      total_credit: round2(totalCredit),
      net_balance: round2(totalDebit - totalCredit),
      sub_account_summary: include_summary ? summary.map(s => ({
        account_code: s.account_code,
        account_name: s.account_name,
        entry_count: s.entry_count,
        total_debit: s.total_debit,
        total_credit: s.total_credit,
        net_balance: s.net_balance,
      })) : undefined,
      entries: include_summary
        ? summary.flatMap(s => s.entries)
        : extracted,
    },
  };
}

// ── Tool 9: Data Cleaning — Auto-clean financial data ─────────────────────────

const DATA_CLEANING_SCHEMA = {
  name: "data_cleaning",
  description: "Auto-clean financial data. Operations: deduplicate, normalize_dates (unify to ISO), normalize_amounts (handle parentheses as negatives, remove currency symbols), remove_blanks (remove zero/null rows), split_combined (split combined debit/credit columns), fill_missing_codes (fill account codes from descriptions), currency_convert (convert to base currency).",
  input_schema: {
    type: "object",
    properties: {
      data: {
        type: "array",
        description: "Array of data rows to clean. Each row is an object with field names as keys.",
        items: { type: "object" },
      },
      operations: {
        type: "array",
        description: "List of cleaning operations to apply in order. Options: deduplicate, normalize_dates, normalize_amounts, remove_blanks, split_combined, fill_missing_codes, currency_convert",
        items: { type: "string" },
      },
      amount_fields: {
        type: "array",
        description: "Field names that contain amounts (for normalize_amounts, remove_blanks). Default: auto-detect",
        items: { type: "string" },
      },
      date_fields: {
        type: "array",
        description: "Field names that contain dates (for normalize_dates). Default: auto-detect",
        items: { type: "string" },
      },
      combined_field: {
        type: "string",
        description: "Field containing combined debit/credit amounts (for split_combined). Positive = debit, negative = credit.",
      },
      account_code_mapping: {
        type: "object",
        description: "Mapping of description keywords to account codes (for fill_missing_codes). E.g. { 'salary': '6001', 'rent': '6201' }",
      },
      exchange_rates: {
        type: "object",
        description: "Exchange rates to base currency (for currency_convert). E.g. { 'USD': 1, 'EUR': 1.08, 'CNY': 0.14 }",
      },
      base_currency: {
        type: "string",
        description: "Target base currency for conversion. Default: 'USD'",
      },
    },
    required: ["data", "operations"],
  },
};

async function executeDataCleaning(input) {
  const {
    data = [],
    operations = [],
    amount_fields: amtFieldsInput,
    date_fields: dateFieldsInput,
    combined_field,
    account_code_mapping = {},
    exchange_rates = {},
    base_currency = "USD",
  } = input;

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("data must be a non-empty array");
  }
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("operations must be a non-empty array of cleaning operations");
  }

  let rows = data.map((row, i) => ({ _original_idx: i, ...row }));
  const log = [];
  let totalChanges = 0;

  // Auto-detect amount fields
  const amountFields = amtFieldsInput || detectAmountFields(rows);
  const dateFields = dateFieldsInput || detectDateFields(rows);

  for (const op of operations) {
    const before = rows.length;

    switch (op) {
      case "deduplicate": {
        const seen = new Set();
        const deduped = [];
        let removed = 0;
        for (const row of rows) {
          // Create a canonical key from all non-internal fields
          const { _original_idx, ...rest } = row;
          const key = JSON.stringify(rest, Object.keys(rest).sort());
          if (seen.has(key)) {
            removed++;
          } else {
            seen.add(key);
            deduped.push(row);
          }
        }
        rows = deduped;
        log.push({ operation: "deduplicate", removed, remaining: rows.length });
        totalChanges += removed;
        break;
      }

      case "normalize_dates": {
        let changed = 0;
        for (const row of rows) {
          for (const field of dateFields) {
            if (row[field] != null) {
              const d = parseDate(row[field]);
              if (d) {
                const iso = d.toISOString().split("T")[0];
                if (iso !== row[field]) {
                  row[field] = iso;
                  changed++;
                }
              }
            }
          }
        }
        log.push({ operation: "normalize_dates", fields: dateFields, dates_normalized: changed });
        totalChanges += changed;
        break;
      }

      case "normalize_amounts": {
        let changed = 0;
        for (const row of rows) {
          for (const field of amountFields) {
            if (row[field] != null && typeof row[field] !== "number") {
              const original = row[field];
              const parsed = parseAmount(original);
              if (parsed !== original) {
                row[field] = parsed;
                changed++;
              }
            }
          }
        }
        log.push({ operation: "normalize_amounts", fields: amountFields, amounts_normalized: changed });
        totalChanges += changed;
        break;
      }

      case "remove_blanks": {
        const filtered = rows.filter(row => {
          // Keep row if at least one amount field is non-zero
          return amountFields.some(f => {
            const val = parseAmount(row[f]);
            return val !== 0 && val != null;
          });
        });
        const removed = rows.length - filtered.length;
        rows = filtered;
        log.push({ operation: "remove_blanks", removed, remaining: rows.length });
        totalChanges += removed;
        break;
      }

      case "split_combined": {
        let changed = 0;
        const splitField = combined_field || detectCombinedField(rows);
        if (splitField) {
          for (const row of rows) {
            const val = parseAmount(row[splitField]);
            if (val > 0) {
              row.debit = round2(val);
              row.credit = 0;
              changed++;
            } else if (val < 0) {
              row.debit = 0;
              row.credit = round2(Math.abs(val));
              changed++;
            } else {
              row.debit = 0;
              row.credit = 0;
            }
          }
          log.push({ operation: "split_combined", source_field: splitField, rows_split: changed });
        } else {
          log.push({ operation: "split_combined", error: "No combined field detected or specified" });
        }
        totalChanges += changed;
        break;
      }

      case "fill_missing_codes": {
        let filled = 0;
        const mapping = account_code_mapping;
        const mappingEntries = Object.entries(mapping);
        if (mappingEntries.length === 0) {
          log.push({ operation: "fill_missing_codes", error: "No account_code_mapping provided" });
          break;
        }
        for (const row of rows) {
          const code = String(row.account_code || row.acct_code || "").trim();
          if (code) continue; // Already has a code
          const desc = String(row.description || row.memo || row.narration || "").toLowerCase();
          if (!desc) continue;
          for (const [keyword, acctCode] of mappingEntries) {
            if (desc.includes(keyword.toLowerCase())) {
              row.account_code = acctCode;
              filled++;
              break;
            }
          }
        }
        log.push({ operation: "fill_missing_codes", codes_filled: filled, mapping_rules: mappingEntries.length });
        totalChanges += filled;
        break;
      }

      case "currency_convert": {
        let converted = 0;
        if (Object.keys(exchange_rates).length === 0) {
          log.push({ operation: "currency_convert", error: "No exchange_rates provided" });
          break;
        }
        for (const row of rows) {
          const currency = String(row.currency || "").trim().toUpperCase();
          if (!currency || currency === base_currency.toUpperCase()) continue;
          const rate = exchange_rates[currency];
          if (rate == null) continue;
          for (const field of amountFields) {
            if (typeof row[field] === "number" && row[field] !== 0) {
              row[`${field}_original`] = row[field];
              row[`${field}_original_currency`] = currency;
              row[field] = round2(row[field] * rate);
              converted++;
            }
          }
          row.currency = base_currency.toUpperCase();
        }
        log.push({ operation: "currency_convert", base_currency, amounts_converted: converted, rates_used: Object.keys(exchange_rates).length });
        totalChanges += converted;
        break;
      }

      default:
        log.push({ operation: op, error: `Unknown operation: ${op}` });
    }
  }

  // Clean internal fields
  const cleaned = rows.map(row => {
    const { _original_idx, ...rest } = row;
    return rest;
  });

  return {
    data: {
      original_count: data.length,
      cleaned_count: cleaned.length,
      total_changes: totalChanges,
      operations_log: log,
      cleaned_data: cleaned,
    },
  };
}

/** Auto-detect fields that look like amounts. */
function detectAmountFields(rows) {
  if (rows.length === 0) return ["amount", "debit", "credit"];
  const sample = rows[0];
  const amountKeywords = ["amount", "debit", "credit", "value", "balance", "total", "sum", "price", "cost", "fee"];
  const fields = [];
  for (const key of Object.keys(sample)) {
    const kl = key.toLowerCase();
    if (amountKeywords.some(kw => kl.includes(kw))) fields.push(key);
    else if (typeof sample[key] === "number" && !kl.includes("id") && !kl.includes("idx") && !kl.includes("code")) {
      fields.push(key);
    }
  }
  return fields.length > 0 ? fields : ["amount", "debit", "credit"];
}

/** Auto-detect fields that look like dates. */
function detectDateFields(rows) {
  if (rows.length === 0) return ["date"];
  const sample = rows[0];
  const dateKeywords = ["date", "posted", "created", "modified", "time", "timestamp"];
  const fields = [];
  for (const key of Object.keys(sample)) {
    const kl = key.toLowerCase();
    if (dateKeywords.some(kw => kl.includes(kw))) fields.push(key);
    else if (typeof sample[key] === "string" && parseDate(sample[key])) {
      fields.push(key);
    }
  }
  return fields.length > 0 ? fields : ["date"];
}

/** Auto-detect a combined amount field (single field containing +/- values). */
function detectCombinedField(rows) {
  if (rows.length === 0) return null;
  const sample = rows.slice(0, Math.min(20, rows.length));
  for (const key of Object.keys(sample[0])) {
    const kl = key.toLowerCase();
    if (kl.includes("amount") || kl.includes("value") || kl.includes("balance")) {
      const values = sample.map(r => parseAmount(r[key]));
      const hasPos = values.some(v => v > 0);
      const hasNeg = values.some(v => v < 0);
      if (hasPos && hasNeg) return key;
    }
  }
  return null;
}

// ── Tool 10: Audit Workpaper Fill ─────────────────────────────────────────────

const AUDIT_WORKPAPER_FILL_SCHEMA = {
  name: "audit_workpaper_fill",
  description: "Auto-fill audit working paper template from extracted source documents. Maps fields from invoices, delivery notes, bank statements, tax forms, and customs declarations to working paper template columns. Uses intelligent field matching based on column headers and document types.",
  input_schema: {
    type: "object",
    properties: {
      template_structure: {
        type: "object",
        description: "Working paper template structure. { sheets: [{ name, headers: [string], rows?: [...] }] }",
      },
      source_documents: {
        type: "array",
        description: "Extracted data from source documents. Each: { type: 'invoice'|'delivery_note'|'bank_statement'|'tax_form'|'customs_declaration', name: string, extracted_data: object }",
        items: { type: "object" },
      },
      mapping_hints: {
        type: "object",
        description: "Optional mapping hints. E.g. { 'Supplier Name': 'supplier', 'Invoice Date': 'date' }",
      },
    },
    required: ["template_structure", "source_documents"],
  },
};

// Standard field aliases for each document type
const DOC_FIELD_ALIASES = {
  invoice: {
    supplier: ["supplier", "vendor", "seller", "company", "from", "supplier_name", "vendor_name"],
    date: ["date", "invoice_date", "issue_date", "bill_date"],
    amount: ["amount", "net_amount", "subtotal", "invoice_amount", "total_amount"],
    tax: ["tax", "vat", "gst", "tax_amount", "vat_amount", "sales_tax"],
    gross_amount: ["total", "gross", "gross_amount", "total_amount", "total_with_tax", "grand_total"],
    invoice_no: ["invoice_no", "invoice_number", "inv_no", "bill_no", "number", "ref", "reference"],
    items: ["items", "line_items", "details", "products"],
    currency: ["currency", "ccy"],
    due_date: ["due_date", "payment_due", "maturity_date"],
    payment_terms: ["payment_terms", "terms"],
  },
  delivery_note: {
    date: ["date", "delivery_date", "ship_date", "dispatch_date"],
    items: ["items", "line_items", "goods", "products"],
    quantities: ["quantities", "qty", "quantity"],
    receiver: ["receiver", "recipient", "delivered_to", "consignee"],
    delivery_no: ["delivery_no", "dn_number", "shipping_no", "waybill"],
    address: ["address", "delivery_address", "ship_to"],
  },
  bank_statement: {
    date: ["date", "transaction_date", "value_date", "posting_date"],
    description: ["description", "narrative", "memo", "details", "particulars"],
    debit: ["debit", "withdrawal", "dr", "payment"],
    credit: ["credit", "deposit", "cr", "receipt"],
    balance: ["balance", "closing_balance", "running_balance"],
    reference: ["reference", "ref", "check_no", "cheque_no", "transaction_ref"],
  },
  tax_form: {
    tax_type: ["tax_type", "type", "form_type"],
    period: ["period", "tax_period", "filing_period", "quarter"],
    amount: ["amount", "tax_amount", "total_tax", "tax_due", "tax_payable"],
    filing_date: ["filing_date", "due_date", "date_filed", "submission_date"],
    taxable_income: ["taxable_income", "taxable_amount", "assessable_income"],
  },
  customs_declaration: {
    goods: ["goods", "description", "commodities", "items", "merchandise"],
    value: ["value", "declared_value", "customs_value", "cif_value", "fob_value"],
    duty: ["duty", "customs_duty", "import_duty", "tariff"],
    date: ["date", "declaration_date", "import_date", "entry_date"],
    hs_code: ["hs_code", "tariff_code", "commodity_code"],
    origin: ["origin", "country_of_origin", "source_country"],
  },
};

async function executeAuditWorkpaperFill(input) {
  const {
    template_structure = {},
    source_documents = [],
    mapping_hints = {},
  } = input;

  if (!template_structure.sheets || !Array.isArray(template_structure.sheets)) {
    throw new Error("template_structure must contain a 'sheets' array with { name, headers }");
  }
  if (!Array.isArray(source_documents) || source_documents.length === 0) {
    throw new Error("source_documents must be a non-empty array");
  }

  const filledSheets = [];
  const mappingReport = [];
  let totalFieldsMapped = 0;
  let totalFieldsUnmapped = 0;

  for (const sheet of template_structure.sheets) {
    const headers = sheet.headers || [];
    if (headers.length === 0) {
      filledSheets.push({ name: sheet.name, headers: [], rows: [], note: "No headers defined" });
      continue;
    }

    const rows = [];

    // For each source document, try to fill a row
    for (const doc of source_documents) {
      const docType = (doc.type || "").toLowerCase().replace(/[\s-]/g, "_");
      const extracted = doc.extracted_data || doc.data || {};
      const aliases = DOC_FIELD_ALIASES[docType] || {};

      const row = [];
      const rowMapping = [];

      for (const header of headers) {
        const headerLower = header.toLowerCase().replace(/[_\s-]+/g, " ").trim();
        let value = null;
        let mappedFrom = null;

        // 1. Check explicit mapping hints
        if (mapping_hints[header]) {
          const hintKey = mapping_hints[header];
          if (extracted[hintKey] != null) {
            value = extracted[hintKey];
            mappedFrom = `hint:${hintKey}`;
          }
        }

        // 2. Direct field match
        if (value == null) {
          for (const [key, val] of Object.entries(extracted)) {
            if (key.toLowerCase().replace(/[_\s-]+/g, " ").trim() === headerLower) {
              value = val;
              mappedFrom = `direct:${key}`;
              break;
            }
          }
        }

        // 3. Alias matching — score all candidates, pick best match
        if (value == null) {
          let bestAliasScore = 0;
          let bestAliasValue = null;
          let bestAliasFrom = null;

          for (const [semanticField, aliasList] of Object.entries(aliases)) {
            let bestScore = 0;
            for (const alias of aliasList) {
              const aliasNorm = alias.replace(/[_\s-]+/g, " ").trim();
              if (headerLower === aliasNorm) { bestScore = Math.max(bestScore, 10); continue; }
              if (headerLower.includes(aliasNorm) && aliasNorm.length > 3) { bestScore = Math.max(bestScore, 6 + aliasNorm.length / 10); continue; }
              if (aliasNorm.includes(headerLower) && headerLower.length > 3) { bestScore = Math.max(bestScore, 5 + headerLower.length / 10); continue; }
              const sim = stringSimilarity(headerLower, aliasNorm);
              if (sim > 0.7) bestScore = Math.max(bestScore, sim * 5);
            }

            if (bestScore > bestAliasScore) {
              let candidateValue = null;
              let candidateFrom = null;
              for (const alias of aliasList) {
                if (extracted[alias] != null) {
                  candidateValue = extracted[alias];
                  candidateFrom = `alias:${semanticField}->${alias}`;
                  break;
                }
              }
              if (candidateValue == null && extracted[semanticField] != null) {
                candidateValue = extracted[semanticField];
                candidateFrom = `alias:${semanticField}`;
              }
              if (candidateValue != null) {
                bestAliasScore = bestScore;
                bestAliasValue = candidateValue;
                bestAliasFrom = candidateFrom;
              }
            }
          }

          if (bestAliasValue != null) {
            value = bestAliasValue;
            mappedFrom = bestAliasFrom;
          }
        }

        // 4. Fuzzy match — Levenshtein on field names
        if (value == null) {
          let bestSimilarity = 0;
          let bestKey = null;
          for (const key of Object.keys(extracted)) {
            const sim = stringSimilarity(headerLower, key.toLowerCase().replace(/[_\s-]+/g, " "));
            if (sim > 0.6 && sim > bestSimilarity) {
              bestSimilarity = sim;
              bestKey = key;
            }
          }
          if (bestKey) {
            value = extracted[bestKey];
            mappedFrom = `fuzzy:${bestKey} (${round2(bestSimilarity * 100)}%)`;
          }
        }

        // 5. Special derived fields
        if (value == null) {
          // Amount with tax = amount + tax
          if (headerLower.includes("total") && headerLower.includes("tax")) {
            const amt = findFieldValue(extracted, aliases.amount || []);
            const tax = findFieldValue(extracted, aliases.tax || []);
            if (amt != null && tax != null) {
              value = round2(parseAmount(amt) + parseAmount(tax));
              mappedFrom = "derived:amount+tax";
            }
          }
          // Net amount = gross - tax
          if (headerLower.includes("net") && value == null) {
            const gross = findFieldValue(extracted, aliases.gross_amount || []);
            const tax = findFieldValue(extracted, aliases.tax || []);
            if (gross != null && tax != null) {
              value = round2(parseAmount(gross) - parseAmount(tax));
              mappedFrom = "derived:gross-tax";
            }
          }
        }

        row.push(value);
        if (value != null) {
          totalFieldsMapped++;
          rowMapping.push({ header, source: mappedFrom, value: typeof value === "object" ? "(complex)" : value });
        } else {
          totalFieldsUnmapped++;
          rowMapping.push({ header, source: null, value: null });
        }
      }

      rows.push(row);
      mappingReport.push({
        document: doc.name || doc.type || `doc_${source_documents.indexOf(doc) + 1}`,
        document_type: docType,
        fields_mapped: rowMapping.filter(m => m.source != null).length,
        fields_unmapped: rowMapping.filter(m => m.source == null).length,
        mapping_details: rowMapping,
      });
    }

    filledSheets.push({
      name: sheet.name,
      headers,
      rows,
      rows_filled: rows.length,
    });
  }

  const totalFields = totalFieldsMapped + totalFieldsUnmapped;

  return {
    data: {
      sheets_processed: filledSheets.length,
      documents_processed: source_documents.length,
      total_fields: totalFields,
      fields_mapped: totalFieldsMapped,
      fields_unmapped: totalFieldsUnmapped,
      mapping_rate: totalFields > 0 ? round4(totalFieldsMapped / totalFields * 100) + "%" : "0%",
      filled_template: {
        sheets: filledSheets,
      },
      mapping_report: mappingReport,
      unmapped_fields: mappingReport.flatMap(r =>
        r.mapping_details.filter(m => m.source == null).map(m => ({
          document: r.document,
          header: m.header,
        }))
      ),
    },
  };
}

/** Find a value in extracted data by trying multiple alias keys. */
function findFieldValue(extracted, aliases) {
  for (const alias of aliases) {
    if (extracted[alias] != null) return extracted[alias];
  }
  return null;
}

// ── 11. Financial Analytics Review (FAR) ──────────────────────────────────────

const FINANCIAL_ANALYTICS_REVIEW_SCHEMA = {
  name: "financial_analytics_review",
  description: "Generate Financial Analytics Review: compare current year vs prior year financial statements line-by-line, calculate variances, and provide explanations. Can use a prior year template for formatting.",
  input_schema: {
    type: "object",
    properties: {
      current_year: {
        type: "object",
        description: "Current year financial data: { income_statement: [{item, amount}], balance_sheet: [{item, amount}], cash_flow: [{item, amount}] }",
      },
      prior_year: {
        type: "object",
        description: "Prior year financial data (same structure as current_year)",
      },
      template_analysis: {
        type: "array",
        description: "Prior year analysis text for each line item (optional, AI will mimic the style). Each: { item: string, analysis: string }",
        items: { type: "object" },
      },
      materiality: {
        type: "number",
        description: "Materiality threshold (absolute amount). Variances above this are flagged as material.",
      },
      currency: {
        type: "string",
        description: "Currency code (default: HKD)",
      },
    },
    required: ["current_year", "prior_year"],
  },
};

async function executeFinancialAnalyticsReview(input) {
  const {
    current_year = {},
    prior_year = {},
    template_analysis = [],
    materiality = Infinity,
    currency = "HKD",
  } = input;

  const STATEMENT_KEYS = ["income_statement", "balance_sheet", "cash_flow"];
  const STATEMENT_LABELS = {
    income_statement: "Income Statement",
    balance_sheet: "Balance Sheet",
    cash_flow: "Cash Flow Statement",
  };

  // Build lookup from template_analysis for prior year explanations
  const templateMap = {};
  if (Array.isArray(template_analysis)) {
    for (const t of template_analysis) {
      if (t && t.item) {
        templateMap[t.item.toLowerCase().trim()] = t.analysis || "";
      }
    }
  }

  // Build prior year lookup per statement
  function buildLookup(items) {
    const map = {};
    if (!Array.isArray(items)) return map;
    for (const row of items) {
      if (row && row.item != null) {
        map[String(row.item).toLowerCase().trim()] = row.amount ?? 0;
      }
    }
    return map;
  }

  const review = [];
  let totalItems = 0;
  let materialItems = 0;
  let largestVariancePct = { item: null, pct: 0 };

  for (const key of STATEMENT_KEYS) {
    const currentItems = Array.isArray(current_year[key]) ? current_year[key] : [];
    const priorLookup = buildLookup(prior_year[key] || []);

    const items = [];

    for (const row of currentItems) {
      if (!row || row.item == null) continue;

      const itemName = String(row.item);
      const itemKey = itemName.toLowerCase().trim();
      const currentAmt = row.amount ?? 0;
      const priorAmt = priorLookup[itemKey];

      totalItems++;

      if (priorAmt === undefined) {
        // New item in current year, no prior year comparator
        items.push({
          item: itemName,
          current: currentAmt,
          prior: null,
          variance: null,
          variance_pct: null,
          material: Math.abs(currentAmt) > materiality,
          flag: "new_item",
          prior_analysis: templateMap[itemKey] || null,
          suggested_analysis: `New item in current year: ${currency} ${currentAmt.toLocaleString()}`,
        });
        if (Math.abs(currentAmt) > materiality) materialItems++;
        continue;
      }

      const variance = currentAmt - priorAmt;
      const variancePct = priorAmt !== 0
        ? (variance / Math.abs(priorAmt)) * 100
        : (currentAmt !== 0 ? Infinity : 0);
      const isMaterial = Math.abs(variance) > materiality || Math.abs(variancePct) > 10;
      const flag = variance > 0 ? "increase" : variance < 0 ? "decrease" : "unchanged";

      if (isMaterial) materialItems++;

      // Track largest variance by percentage
      if (isFinite(variancePct) && Math.abs(variancePct) > Math.abs(largestVariancePct.pct)) {
        largestVariancePct = { item: itemName, pct: Math.round(variancePct * 100) / 100 };
      }

      // Generate suggested analysis
      let suggestedAnalysis = "";
      if (flag === "unchanged") {
        suggestedAnalysis = `${itemName} remained unchanged at ${currency} ${currentAmt.toLocaleString()}.`;
      } else {
        const dir = flag === "increase" ? "increased" : "decreased";
        const pctStr = isFinite(variancePct) ? `${Math.abs(variancePct).toFixed(1)}%` : "N/A";
        suggestedAnalysis = `${itemName} ${dir} by ${currency} ${Math.abs(variance).toLocaleString()} (${pctStr}) from ${currency} ${priorAmt.toLocaleString()} to ${currency} ${currentAmt.toLocaleString()}.`;
        if (isMaterial) {
          suggestedAnalysis += " This variance exceeds materiality and warrants further investigation.";
        }
      }

      items.push({
        item: itemName,
        current: currentAmt,
        prior: priorAmt,
        variance: Math.round(variance * 100) / 100,
        variance_pct: isFinite(variancePct) ? Math.round(variancePct * 100) / 100 : null,
        material: isMaterial,
        flag,
        prior_analysis: templateMap[itemKey] || null,
        suggested_analysis: suggestedAnalysis,
      });
    }

    if (items.length > 0) {
      review.push({
        statement: STATEMENT_LABELS[key] || key,
        items,
      });
    }
  }

  return {
    review,
    summary: {
      material_items: materialItems,
      total_items: totalItems,
      largest_variance_pct: largestVariancePct.item ? largestVariancePct : null,
      currency,
      materiality_threshold: isFinite(materiality) ? materiality : null,
    },
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

function registerAuditTools() {
  const tools = [
    { schema: AUDIT_SAMPLING_SCHEMA, handler: executeAuditSampling },
    { schema: BENFORD_ANALYSIS_SCHEMA, handler: executeBenfordAnalysis },
    { schema: JOURNAL_ENTRY_TESTING_SCHEMA, handler: executeJournalEntryTesting },
    { schema: VARIANCE_ANALYSIS_SCHEMA, handler: executeVarianceAnalysis },
    { schema: MATERIALITY_CALCULATOR_SCHEMA, handler: executeMaterialityCalculator },
    { schema: RECONCILIATION_SCHEMA, handler: executeReconciliation },
    { schema: GOING_CONCERN_CHECK_SCHEMA, handler: executeGoingConcernCheck },
    { schema: GL_EXTRACT_SCHEMA, handler: executeGLExtract },
    { schema: DATA_CLEANING_SCHEMA, handler: executeDataCleaning },
    { schema: AUDIT_WORKPAPER_FILL_SCHEMA, handler: executeAuditWorkpaperFill },
    { schema: FINANCIAL_ANALYTICS_REVIEW_SCHEMA, handler: executeFinancialAnalyticsReview },
  ];

  for (const { schema, handler } of tools) {
    unifiedRegistry.registerTool(schema, handler);
  }

  console.log(`[audit-tools] Registered ${tools.length} audit tools`);
}

// Also export in the module format requested
module.exports = {
  registerAuditTools,
  tools: [
    { name: "journal_entry_testing", description: JOURNAL_ENTRY_TESTING_SCHEMA.description, input_schema: JOURNAL_ENTRY_TESTING_SCHEMA.input_schema, execute: executeJournalEntryTesting },
    { name: "gl_extract", description: GL_EXTRACT_SCHEMA.description, input_schema: GL_EXTRACT_SCHEMA.input_schema, execute: executeGLExtract },
    { name: "data_cleaning", description: DATA_CLEANING_SCHEMA.description, input_schema: DATA_CLEANING_SCHEMA.input_schema, execute: executeDataCleaning },
    { name: "reconciliation", description: RECONCILIATION_SCHEMA.description, input_schema: RECONCILIATION_SCHEMA.input_schema, execute: executeReconciliation },
    { name: "audit_workpaper_fill", description: AUDIT_WORKPAPER_FILL_SCHEMA.description, input_schema: AUDIT_WORKPAPER_FILL_SCHEMA.input_schema, execute: executeAuditWorkpaperFill },
    { name: "audit_sampling", description: AUDIT_SAMPLING_SCHEMA.description, input_schema: AUDIT_SAMPLING_SCHEMA.input_schema, execute: executeAuditSampling },
    { name: "benford_analysis", description: BENFORD_ANALYSIS_SCHEMA.description, input_schema: BENFORD_ANALYSIS_SCHEMA.input_schema, execute: executeBenfordAnalysis },
    { name: "variance_analysis", description: VARIANCE_ANALYSIS_SCHEMA.description, input_schema: VARIANCE_ANALYSIS_SCHEMA.input_schema, execute: executeVarianceAnalysis },
    { name: "materiality_calculator", description: MATERIALITY_CALCULATOR_SCHEMA.description, input_schema: MATERIALITY_CALCULATOR_SCHEMA.input_schema, execute: executeMaterialityCalculator },
    { name: "going_concern_check", description: GOING_CONCERN_CHECK_SCHEMA.description, input_schema: GOING_CONCERN_CHECK_SCHEMA.input_schema, execute: executeGoingConcernCheck },
    { name: "financial_analytics_review", description: FINANCIAL_ANALYTICS_REVIEW_SCHEMA.description, input_schema: FINANCIAL_ANALYTICS_REVIEW_SCHEMA.input_schema, execute: executeFinancialAnalyticsReview },
  ],
  registerAll(registry) {
    for (const t of this.tools) registry.registerTool(t.name, t);
  },
  // Direct exports for testing
  executeAuditSampling,
  executeBenfordAnalysis,
  executeJournalEntryTesting,
  executeVarianceAnalysis,
  executeMaterialityCalculator,
  executeReconciliation,
  executeGoingConcernCheck,
  executeGLExtract,
  executeDataCleaning,
  executeAuditWorkpaperFill,
  executeFinancialAnalyticsReview,
};
