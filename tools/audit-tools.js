"use strict";

/**
 * Audit Tools — Professional audit analytics for LumiGate.
 *
 * Tools:
 *   1. audit_sampling      — MUS, random, stratified sampling
 *   2. benford_analysis     — First-digit / first-two-digit distribution + chi-square
 *   3. journal_entry_testing — Flag unusual journal entries with risk scores
 *   4. variance_analysis    — Period-over-period, budget vs actual, ratios
 *   5. materiality_calculator — ISA 320 / PCAOB materiality computation
 *   6. reconciliation       — Auto-reconcile two datasets
 *   7. going_concern_check  — ISA 570 going concern indicators
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
  // Use regularized incomplete gamma via series expansion
  return gammaCDF(x, k, 2);
}

/** Gamma CDF via series expansion. */
function gammaCDF(x, shape, scale) {
  const z = x / scale;
  if (z <= 0) return 0;
  // Lower regularized incomplete gamma function P(a, x)
  return lowerRegGamma(shape, z);
}

/** Lower regularized incomplete gamma function P(a, x) via series. */
function lowerRegGamma(a, x) {
  if (x < 0) return 0;
  if (x === 0) return 0;
  if (x > a + 200) return 1; // convergence boundary

  // Series expansion: P(a,x) = (e^-x * x^a / Gamma(a)) * sum(x^n / (a+1)...(a+n))
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

/** Poisson factor for MUS sample size: n = -ln(1-confidence) / tolerable_error_rate. */
function poissonSampleSize(confidence, tolerableError) {
  if (tolerableError <= 0) return Infinity;
  return Math.ceil(-Math.log(1 - confidence) / tolerableError);
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
        description: "Random seed for reproducibility (optional)",
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

  if (!Array.isArray(population) || population.length === 0) {
    throw new Error("population must be a non-empty array of items");
  }

  const rand = seededRandom(seed || Date.now());
  const items = population.map((item, i) => ({
    _index: i,
    id: item.id || item.ID || `item_${i + 1}`,
    amount: Math.abs(Number(item.amount || item.Amount || item.value || 0)),
    description: item.description || item.desc || item.name || "",
    category: item.category || item[strata_field] || "",
    ...item,
  }));

  const totalAmount = items.reduce((s, it) => s + it.amount, 0);
  const popSize = items.length;

  if (method === "mus") {
    // Monetary Unit Sampling
    const tolerableError = materiality > 0 ? materiality / totalAmount : 0.05;
    const expErr = expected_error != null ? expected_error : 0;
    // MUS sample size via Poisson: n = total / sampling_interval
    // Sampling interval = tolerable_misstatement / reliability_factor
    // Reliability factor from Poisson table: -ln(1-confidence) for 0 expected errors
    const reliabilityFactor = -Math.log(1 - confidence);
    const adjustedReliability = expErr > 0
      ? reliabilityFactor + expErr * totalAmount / (materiality || totalAmount * 0.05) * 1.5
      : reliabilityFactor;
    const tolerableMisstatement = materiality || totalAmount * 0.05;
    const samplingInterval = tolerableMisstatement / adjustedReliability;
    const calcSize = Math.min(Math.ceil(totalAmount / samplingInterval), popSize);
    const sampleSize = overrideSize || calcSize;

    // Systematic selection with random start
    const interval = totalAmount / sampleSize;
    const start = rand() * interval;
    const selected = [];
    const selectedIndices = new Set();
    let cumulative = 0;

    // Always select items >= sampling interval (high-value items)
    const highValue = items.filter(it => it.amount >= samplingInterval);
    for (const hv of highValue) {
      if (!selectedIndices.has(hv._index)) {
        selectedIndices.add(hv._index);
        selected.push({ ...hv, selection_reason: "high_value_item" });
      }
    }

    // Systematic selection on remaining
    for (let target = start; selected.length < sampleSize && target < totalAmount; target += interval) {
      cumulative = 0;
      for (const item of items) {
        cumulative += item.amount;
        if (cumulative >= target && !selectedIndices.has(item._index)) {
          selectedIndices.add(item._index);
          selected.push({ ...item, selection_reason: "systematic_mus" });
          break;
        }
      }
    }

    return {
      data: {
        method: "MUS (Monetary Unit Sampling)",
        population_size: popSize,
        population_total: round2(totalAmount),
        confidence_level: confidence,
        materiality: round2(materiality || totalAmount * 0.05),
        reliability_factor: round4(adjustedReliability),
        sampling_interval: round2(samplingInterval),
        calculated_sample_size: calcSize,
        actual_sample_size: selected.length,
        high_value_items: highValue.length,
        selected_items: selected.map(cleanItem),
        coverage_amount: round2(selected.reduce((s, it) => s + it.amount, 0)),
        coverage_pct: round4(selected.reduce((s, it) => s + it.amount, 0) / totalAmount * 100),
      },
    };
  }

  if (method === "stratified") {
    // Stratified sampling: divide into strata, sample proportionally
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

    // Sample size per stratum: proportional to stratum total amount
    const expErr = expected_error != null ? expected_error : 0.01;
    const z = normInv(1 - (1 - confidence) / 2);
    const calcSize = overrideSize || Math.min(
      Math.ceil((z * z * expErr * (1 - expErr)) / (0.02 * 0.02)), // precision = 2%
      Math.ceil(popSize * 0.25) // cap at 25% of population
    );
    const sampleSize = Math.max(calcSize, strata.size * 2); // at least 2 per stratum

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

// Benford expected probabilities for first digit (1-9)
const BENFORD_FIRST = [
  0.30103, 0.17609, 0.12494, 0.09691, 0.07918,
  0.06695, 0.05799, 0.05115, 0.04576,
];

// Benford expected probabilities for first two digits (10-99)
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

  // First digit test
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

    const df = 8; // 9 digits - 1
    const pValue = 1 - chiSquareCDF(chiSquare, df);
    const mad = digitResults.reduce((s, d) => s + Math.abs(d.difference_pct / 100), 0) / 9;

    // MAD conformity thresholds (Nigrini 2012)
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

  // First two digits test
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
    const digitResults = [];
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

// ── Tool 3: Journal Entry Testing ─────────────────────────────────────────────

const JOURNAL_ENTRY_TESTING_SCHEMA = {
  name: "journal_entry_testing",
  description: "Automated journal entry testing for audit. Flags unusual entries: round amounts, weekend/holiday postings, just-below-threshold amounts, back-dated entries, entries with no description, unusual users, same debit/credit accounts. Returns flagged entries with risk scores and reasons.",
  input_schema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        description: "Array of journal entry records. Fields: id, date, posted_date, amount, debit_account, credit_account, user, description, approved_by",
        items: { type: "object" },
      },
      thresholds: {
        type: "object",
        description: "Approval thresholds. E.g. {\"manager\": 10000, \"director\": 50000, \"cfo\": 100000}",
      },
      usual_users: {
        type: "array",
        description: "List of expected/usual posting users. Entries by other users get flagged.",
        items: { type: "string" },
      },
      holidays: {
        type: "array",
        description: "List of holiday dates (YYYY-MM-DD format) to check against",
        items: { type: "string" },
      },
      round_threshold: {
        type: "number",
        description: "Minimum amount to flag as 'round number' (default: 1000)",
      },
    },
    required: ["entries"],
  },
};

async function executeJournalEntryTesting(input) {
  const {
    entries = [],
    thresholds = { manager: 10000, director: 50000, cfo: 100000 },
    usual_users = [],
    holidays = [],
    round_threshold = 1000,
  } = input;

  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("entries must be a non-empty array of journal entry records");
  }

  const holidaySet = new Set(holidays.map(h => h.trim()));
  const usualUserSet = new Set(usual_users.map(u => u.toLowerCase().trim()));
  const thresholdLevels = Object.entries(thresholds).sort((a, b) => a[1] - b[1]);

  const flagged = [];
  const stats = {
    total_entries: entries.length,
    total_amount: 0,
    flagged_count: 0,
    risk_distribution: { high: 0, medium: 0, low: 0 },
    flag_types: {},
  };

  for (const entry of entries) {
    const amount = Math.abs(Number(entry.amount || entry.Amount || 0));
    stats.total_amount += amount;

    const reasons = [];
    let riskScore = 0;

    // 1. Round number check
    if (amount >= round_threshold && amount % 1000 === 0) {
      const magnitude = Math.floor(Math.log10(amount));
      if (amount % Math.pow(10, magnitude) === 0) {
        reasons.push(`Exact round amount: ${amount}`);
        riskScore += magnitude >= 4 ? 3 : 2;
      }
    }

    // 2. Weekend / holiday check
    const dateStr = entry.posted_date || entry.date || entry.Date || "";
    if (dateStr) {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        const day = d.getDay();
        if (day === 0 || day === 6) {
          reasons.push(`Posted on weekend (${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]})`);
          riskScore += 3;
        }
        const isoDate = d.toISOString().split("T")[0];
        if (holidaySet.has(isoDate)) {
          reasons.push(`Posted on holiday (${isoDate})`);
          riskScore += 3;
        }
      }
    }

    // 3. Just below threshold
    for (const [level, threshold] of thresholdLevels) {
      const margin = threshold * 0.05; // within 5% below
      if (amount < threshold && amount >= threshold - margin && amount > 0) {
        reasons.push(`Just below ${level} threshold (${amount} vs ${threshold})`);
        riskScore += 4;
        break;
      }
    }

    // 4. Back-dated entry
    const entryDate = entry.date || entry.Date || "";
    const postedDate = entry.posted_date || entry.posted || "";
    if (entryDate && postedDate) {
      const ed = new Date(entryDate);
      const pd = new Date(postedDate);
      if (!isNaN(ed.getTime()) && !isNaN(pd.getTime())) {
        const diffDays = (pd - ed) / (1000 * 60 * 60 * 24);
        if (diffDays > 7) {
          reasons.push(`Back-dated by ${Math.round(diffDays)} days (entry: ${entryDate}, posted: ${postedDate})`);
          riskScore += diffDays > 30 ? 5 : 3;
        }
      }
    }

    // 5. Same debit and credit account
    const debit = (entry.debit_account || entry.debit || "").toString().trim();
    const credit = (entry.credit_account || entry.credit || "").toString().trim();
    if (debit && credit && debit === credit) {
      reasons.push(`Same debit and credit account: ${debit}`);
      riskScore += 5;
    }

    // 6. No description
    const desc = (entry.description || entry.memo || entry.narration || "").toString().trim();
    if (!desc) {
      reasons.push("No description/memo");
      riskScore += 2;
    }

    // 7. Unusual user
    const user = (entry.user || entry.posted_by || entry.created_by || "").toString().trim();
    if (user && usualUserSet.size > 0 && !usualUserSet.has(user.toLowerCase())) {
      reasons.push(`Unusual posting user: ${user}`);
      riskScore += 3;
    }

    // 8. No approval
    const approver = (entry.approved_by || entry.approver || "").toString().trim();
    if (!approver && amount >= (thresholdLevels[0]?.[1] || 10000)) {
      reasons.push(`No approval recorded for amount ${amount}`);
      riskScore += 4;
    }

    // 9. Late-night posting (if timestamp available)
    if (dateStr && dateStr.includes("T")) {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        const hour = d.getHours();
        if (hour >= 22 || hour < 6) {
          reasons.push(`Posted at unusual hour (${hour}:00)`);
          riskScore += 2;
        }
      }
    }

    if (reasons.length > 0) {
      const riskLevel = riskScore >= 8 ? "high" : riskScore >= 4 ? "medium" : "low";
      stats.risk_distribution[riskLevel]++;
      stats.flagged_count++;
      for (const r of reasons) {
        const key = r.split(":")[0].split("(")[0].trim();
        stats.flag_types[key] = (stats.flag_types[key] || 0) + 1;
      }
      flagged.push({
        entry_id: entry.id || entry.ID || entry.je_number || `entry_${entries.indexOf(entry) + 1}`,
        amount,
        date: dateStr,
        user: user || "unknown",
        description: desc || "(none)",
        debit_account: debit,
        credit_account: credit,
        risk_score: riskScore,
        risk_level: riskScore >= 8 ? "HIGH" : riskScore >= 4 ? "MEDIUM" : "LOW",
        flags: reasons,
      });
    }
  }

  flagged.sort((a, b) => b.risk_score - a.risk_score);

  return {
    data: {
      summary: stats,
      flagged_entries: flagged,
      top_risk_entries: flagged.slice(0, 20),
      recommendations: [
        stats.risk_distribution.high > 0 ? `${stats.risk_distribution.high} HIGH-risk entries require immediate investigation` : null,
        stats.flag_types["Just below"] ? `${stats.flag_types["Just below"]} entries just below approval thresholds — potential threshold manipulation` : null,
        stats.flag_types["Posted on weekend"] ? `${stats.flag_types["Posted on weekend"]} weekend postings — verify authorization` : null,
        stats.flag_types["Back-dated"] ? `${stats.flag_types["Back-dated"]} back-dated entries — verify business justification` : null,
        stats.flag_types["Same debit and credit account"] ? `${stats.flag_types["Same debit and credit account"]} self-reversing entries — potential fictitious transactions` : null,
        stats.flag_types["No description/memo"] ? `${stats.flag_types["No description/memo"]} entries without description — incomplete audit trail` : null,
      ].filter(Boolean),
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

  if (type === "trend" && periods.length > 0) {
    return executeTrendAnalysis(periods, materiality, materiality_pct);
  }

  // Period comparison or budget vs actual
  const label = type === "budget_vs_actual"
    ? { a: "Actual", b: "Budget" }
    : { a: "Current Period", b: "Prior Period" };

  const allKeys = [...new Set([...Object.keys(current), ...Object.keys(prior)])];
  const variances = [];
  let totalCurrentAbs = 0;
  let totalPriorAbs = 0;

  for (const key of allKeys) {
    const cur = Number(current[key] || 0);
    const pri = Number(prior[key] || 0);
    totalCurrentAbs += Math.abs(cur);
    totalPriorAbs += Math.abs(pri);
    const diff = cur - pri;
    const pctChange = pri !== 0 ? diff / Math.abs(pri) : (cur !== 0 ? Infinity : 0);
    const isMaterial = (materiality > 0 && Math.abs(diff) >= materiality) ||
      (Math.abs(pctChange) >= materiality_pct && Math.abs(diff) > 0);

    variances.push({
      account: key,
      [label.a.toLowerCase().replace(/ /g, "_")]: round2(cur),
      [label.b.toLowerCase().replace(/ /g, "_")]: round2(pri),
      variance: round2(diff),
      variance_pct: pctChange === Infinity ? "N/A (new)" : round4(pctChange * 100),
      direction: diff > 0 ? "increase" : diff < 0 ? "decrease" : "no change",
      material: isMaterial,
      flag: isMaterial ? "INVESTIGATE" : "OK",
    });
  }

  const materialItems = variances.filter(v => v.material);

  return {
    data: {
      analysis_type: type === "budget_vs_actual" ? "Budget vs Actual" : "Period-over-Period Comparison",
      total_accounts: allKeys.length,
      material_variances: materialItems.length,
      materiality_threshold_amount: materiality || "not set",
      materiality_threshold_pct: `${round2(materiality_pct * 100)}%`,
      variances: variances.sort((a, b) => Math.abs(typeof b.variance_pct === "number" ? b.variance_pct : 999) - Math.abs(typeof a.variance_pct === "number" ? a.variance_pct : 999)),
      flagged_items: materialItems,
      summary: materialItems.length > 0
        ? `${materialItems.length} of ${allKeys.length} accounts have material variances requiring investigation.`
        : "No material variances detected.",
    },
  };
}

function executeTrendAnalysis(periods, materiality, materialityPct) {
  // Collect all account keys across all periods
  const allKeys = new Set();
  for (const p of periods) {
    for (const k of Object.keys(p.data || {})) allKeys.add(k);
  }

  const trends = [];
  for (const key of allKeys) {
    const values = periods.map(p => Number(p.data?.[key] || 0));
    const labels = periods.map(p => p.period || p.year || p.label || "");
    const xs = values.map((_, i) => i);
    const reg = linearRegression(xs, values);

    const lastIdx = values.length - 1;
    const predicted = reg.slope * lastIdx + reg.intercept;
    const residual = values[lastIdx] - predicted;
    const residualPct = predicted !== 0 ? residual / Math.abs(predicted) : 0;

    // CAGR
    const first = values[0] || 1;
    const last = values[lastIdx] || 0;
    const n = values.length - 1;
    const cagr = n > 0 && first > 0 && last > 0 ? Math.pow(last / first, 1 / n) - 1 : 0;

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

  // Liquidity
  if (fd.current_assets != null && fd.current_liabilities != null && fd.current_liabilities !== 0) {
    const cr = fd.current_assets / fd.current_liabilities;
    ratios.push({ category: "Liquidity", name: "Current Ratio", value: round4(cr), benchmark: "1.5-3.0", flag: cr < 1 ? "WARNING" : "OK" });
  }
  if (fd.current_assets != null && fd.inventory != null && fd.current_liabilities != null && fd.current_liabilities !== 0) {
    const qr = (fd.current_assets - (fd.inventory || 0)) / fd.current_liabilities;
    ratios.push({ category: "Liquidity", name: "Quick Ratio", value: round4(qr), benchmark: "1.0-2.0", flag: qr < 0.8 ? "WARNING" : "OK" });
  }

  // Profitability
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

  // Leverage
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

  // Efficiency
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

  // Default benchmark ranges by entity type (ISA 320 / PCAOB guidance)
  const benchmarkRanges = {
    public: {
      revenue: [0.005, 0.01],      // 0.5% - 1%
      total_assets: [0.005, 0.01], // 0.5% - 1%
      net_income: [0.05, 0.10],    // 5% - 10%
      equity: [0.01, 0.02],        // 1% - 2%
      total_expenses: [0.005, 0.01],
    },
    private: {
      revenue: [0.005, 0.02],      // 0.5% - 2%
      total_assets: [0.005, 0.02],
      net_income: [0.05, 0.10],
      equity: [0.01, 0.02],
      total_expenses: [0.005, 0.02],
    },
    nonprofit: {
      revenue: [0.005, 0.02],
      total_assets: [0.005, 0.02],
      total_expenses: [0.005, 0.02],
    },
    government: {
      revenue: [0.005, 0.01],
      total_assets: [0.003, 0.01],
      total_expenses: [0.005, 0.01],
    },
  };

  const ranges = benchmarkRanges[entity_type] || benchmarkRanges.private;
  const benchmarks = [];

  const addBenchmark = (name, value, rangeKey) => {
    if (value == null || value === 0) return;
    const absVal = Math.abs(value);
    const range = ranges[rangeKey];
    if (!range) return;
    const lowPct = custom_benchmarks[`${rangeKey}_pct`] || range[0];
    const highPct = custom_benchmarks[`${rangeKey}_pct`] || range[1];
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

  // Select overall materiality: typically the most appropriate benchmark
  // For profit-oriented: revenue or net income (if stable)
  // For asset-heavy: total assets
  // Rule: use median of computed materialities
  const materialities = benchmarks.map(b => b.materiality).sort((a, b) => a - b);
  const medianIdx = Math.floor(materialities.length / 2);
  const overallMateriality = materialities.length % 2 === 0
    ? (materialities[medianIdx - 1] + materialities[medianIdx]) / 2
    : materialities[medianIdx];

  // Performance materiality: reduces overall by risk factor
  const perfPct = risk_level === "high" ? 0.50 : risk_level === "low" ? 0.75 : 0.65;
  const performanceMateriality = round2(overallMateriality * perfPct);

  // Trivial threshold (de minimis): 5% of overall materiality
  const trivialThreshold = round2(overallMateriality * 0.05);

  // SAD (Summary of Audit Differences) threshold
  const sadThreshold = round2(overallMateriality * 0.05);

  return {
    data: {
      entity_type,
      risk_level,
      benchmarks,
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

// ── Tool 6: Reconciliation ────────────────────────────────────────────────────

const RECONCILIATION_SCHEMA = {
  name: "reconciliation",
  description: "Auto-reconcile two datasets by matching on amount, date, reference, or description. Commonly used for bank-to-GL, sub-ledger-to-GL, or inter-company reconciliation. Returns matched pairs, unmatched items from each side, and differences.",
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
      match_fields: {
        type: "array",
        description: "Fields to match on. Options: 'amount', 'date', 'reference', 'description'. Default: ['amount']",
        items: { type: "string" },
      },
      tolerance_amount: {
        type: "number",
        description: "Amount tolerance for matching (e.g. 0.01 for penny rounding). Default: 0.01",
      },
      tolerance_days: {
        type: "number",
        description: "Date tolerance in days for matching (e.g. 3 for T+3). Default: 3",
      },
      allow_many_to_one: {
        type: "boolean",
        description: "Allow multiple items from one side to match a single item on the other (e.g. split payments). Default: false",
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
    match_fields = ["amount"],
    tolerance_amount = 0.01,
    tolerance_days = 3,
    allow_many_to_one = false,
  } = input;

  if (!dataset_a.length || !dataset_b.length) {
    throw new Error("Both datasets must be non-empty");
  }

  // Normalize items
  const normalize = (items, label) => items.map((item, i) => ({
    _idx: i,
    _source: label,
    id: item.id || item.ID || item.ref || `${label}_${i + 1}`,
    date: item.date || item.Date || "",
    amount: Number(item.amount || item.Amount || item.value || 0),
    reference: (item.reference || item.ref || item.check_no || "").toString().trim(),
    description: (item.description || item.desc || item.memo || item.narration || "").toString().trim().toLowerCase(),
  }));

  const itemsA = normalize(dataset_a, label_a);
  const itemsB = normalize(dataset_b, label_b);

  const matchedPairs = [];
  const usedA = new Set();
  const usedB = new Set();

  // Scoring function: how well do two items match?
  function matchScore(a, b) {
    let score = 0;
    let maxScore = 0;

    if (match_fields.includes("amount")) {
      maxScore += 10;
      if (Math.abs(a.amount - b.amount) <= tolerance_amount) score += 10;
      else if (Math.abs(a.amount - b.amount) <= tolerance_amount * 10) score += 5;
    }

    if (match_fields.includes("date") && a.date && b.date) {
      maxScore += 5;
      const da = new Date(a.date);
      const db = new Date(b.date);
      if (!isNaN(da.getTime()) && !isNaN(db.getTime())) {
        const diffDays = Math.abs(da - db) / (1000 * 60 * 60 * 24);
        if (diffDays <= tolerance_days) score += 5;
        else if (diffDays <= tolerance_days * 2) score += 2;
      }
    }

    if (match_fields.includes("reference") && a.reference && b.reference) {
      maxScore += 8;
      if (a.reference === b.reference) score += 8;
      else if (a.reference.includes(b.reference) || b.reference.includes(a.reference)) score += 4;
    }

    if (match_fields.includes("description") && a.description && b.description) {
      maxScore += 3;
      if (a.description === b.description) score += 3;
      else {
        // Simple word overlap
        const wordsA = new Set(a.description.split(/\s+/));
        const wordsB = new Set(b.description.split(/\s+/));
        const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
        const total = Math.max(wordsA.size, wordsB.size);
        if (total > 0 && overlap / total > 0.5) score += 2;
      }
    }

    return { score, maxScore, confidence: maxScore > 0 ? score / maxScore : 0 };
  }

  // Build match candidates sorted by score
  const candidates = [];
  for (const a of itemsA) {
    for (const b of itemsB) {
      const m = matchScore(a, b);
      if (m.confidence >= 0.5) { // minimum 50% match
        candidates.push({ a, b, ...m });
      }
    }
  }
  candidates.sort((x, y) => y.confidence - x.confidence);

  // Greedy matching
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
      match_confidence: round4(cand.confidence * 100) + "%",
      match_score: cand.score,
    });
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
      match_criteria: match_fields,
      tolerance: { amount: tolerance_amount, days: tolerance_days },
      summary: {
        [`${label_a}_count`]: itemsA.length,
        [`${label_b}_count`]: itemsB.length,
        matched_pairs: matchedPairs.length,
        [`unmatched_${label_a}`]: unmatchedA.length,
        [`unmatched_${label_b}`]: unmatchedB.length,
        match_rate_a: round4(usedA.size / itemsA.length * 100) + "%",
        match_rate_b: round4(usedB.size / itemsB.length * 100) + "%",
        total_matched_difference: round2(totalDifference),
        [`unmatched_${label_a}_total`]: round2(unmatchedATotal),
        [`unmatched_${label_b}_total`]: round2(unmatchedBTotal),
        net_reconciling_difference: round2(unmatchedATotal - unmatchedBTotal + totalDifference),
      },
      matched_pairs: matchedPairs,
      [`unmatched_${label_a}`]: unmatchedA,
      [`unmatched_${label_b}`]: unmatchedB,
      reconciling_items: [
        ...unmatchedA.map(i => ({ source: label_a, type: "unmatched", ...i })),
        ...unmatchedB.map(i => ({ source: label_b, type: "unmatched", ...i })),
        ...matchedPairs.filter(p => Math.abs(p.difference) > tolerance_amount).map(p => ({
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

  // ── Financial indicators ──

  // 1. Negative working capital
  if (cy.current_assets != null && cy.current_liabilities != null) {
    const wc = cy.current_assets - cy.current_liabilities;
    addIndicator("Financial", "Negative working capital", wc < 0, 3,
      `Working capital: ${round2(wc)} (CA: ${round2(cy.current_assets)}, CL: ${round2(cy.current_liabilities)})`);
  }

  // 2. Current ratio < 1
  if (cy.current_assets != null && cy.current_liabilities != null && cy.current_liabilities > 0) {
    const cr = cy.current_assets / cy.current_liabilities;
    addIndicator("Financial", "Current ratio below 1", cr < 1, 2,
      `Current ratio: ${round4(cr)}`);
  }

  // 3. Recurring losses
  if (cy.net_income != null && cy.net_income < 0) {
    const consecutive = (py.net_income != null && py.net_income < 0);
    addIndicator("Financial", "Net loss in current year", true, consecutive ? 4 : 2,
      `Net income: ${round2(cy.net_income)}${consecutive ? " (consecutive losses)" : ""}`);
  }

  // 4. Negative operating cash flow
  if (cy.operating_cash_flow != null && cy.operating_cash_flow < 0) {
    addIndicator("Financial", "Negative operating cash flow", true, 3,
      `Operating cash flow: ${round2(cy.operating_cash_flow)}`);
  }

  // 5. Negative retained earnings (accumulated deficit)
  if (cy.retained_earnings != null && cy.retained_earnings < 0) {
    addIndicator("Financial", "Accumulated deficit", true, 3,
      `Retained earnings: ${round2(cy.retained_earnings)}`);
  }

  // 6. Debt exceeds assets
  if (cy.total_liabilities != null && cy.total_assets != null) {
    addIndicator("Financial", "Liabilities exceed assets", cy.total_liabilities > cy.total_assets, 4,
      `Total assets: ${round2(cy.total_assets)}, Total liabilities: ${round2(cy.total_liabilities)}`);
  }

  // 7. High leverage
  if (cy.total_liabilities != null && cy.total_assets != null && cy.total_assets > 0) {
    const leverage = cy.total_liabilities / cy.total_assets;
    addIndicator("Financial", "High leverage ratio (>0.8)", leverage > 0.8, 2,
      `Debt-to-assets: ${round4(leverage)}`);
  }

  // 8. Interest coverage < 1
  if (cy.operating_cash_flow != null && cy.interest_expense != null && cy.interest_expense > 0) {
    const icr = cy.operating_cash_flow / cy.interest_expense;
    addIndicator("Financial", "Cannot cover interest payments", icr < 1, 4,
      `Interest coverage (OCF/Interest): ${round4(icr)}`);
  }

  // 9. Cash burn rate
  if (cy.cash != null && cy.operating_cash_flow != null && cy.operating_cash_flow < 0) {
    const monthsOfCash = cy.cash / (Math.abs(cy.operating_cash_flow) / 12);
    addIndicator("Financial", "Cash runway < 12 months", monthsOfCash < 12, monthsOfCash < 6 ? 5 : 3,
      `Estimated cash runway: ${round2(monthsOfCash)} months`);
  }

  // 10. Revenue decline
  if (cy.revenue != null && py.revenue != null && py.revenue > 0) {
    const decline = (cy.revenue - py.revenue) / py.revenue;
    addIndicator("Financial", "Significant revenue decline (>20%)", decline < -0.20, 3,
      `Revenue change: ${round4(decline * 100)}% (${round2(py.revenue)} -> ${round2(cy.revenue)})`);
  }

  // ── Qualitative indicators ──
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

  // Overall assessment
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
  ];

  for (const { schema, handler } of tools) {
    unifiedRegistry.registerTool(schema, handler);
  }

  console.log(`[audit-tools] Registered ${tools.length} audit tools`);
}

module.exports = {
  registerAuditTools,
  // Export individual handlers for direct use / testing
  executeAuditSampling,
  executeBenfordAnalysis,
  executeJournalEntryTesting,
  executeVarianceAnalysis,
  executeMaterialityCalculator,
  executeReconciliation,
  executeGoingConcernCheck,
};
