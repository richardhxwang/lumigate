'use strict';

const crypto = require('crypto');

/**
 * Evaluator — quality evaluation and A/B experiment tracking for traces.
 *
 * Evaluations are stored directly inside each trace JSON (trace.evaluations[]).
 * Experiments are stored in memory + flushed to data/traces/experiments.json.
 */
class Evaluator {
  /**
   * @param {object} opts
   * @param {object} opts.traceCollector — TraceCollector instance
   * @param {function} opts.log
   * @param {function} opts.aiCall — async (model, messages) => string  (for auto-eval)
   */
  constructor({ traceCollector, log, aiCall } = {}) {
    this.tc = traceCollector;
    this.log = log || (() => {});
    this.aiCall = aiCall || null;

    // In-memory experiment store
    this._experiments = new Map();
    this._loadExperiments();
  }

  // ---------------------------------------------------------------------------
  // Experiments persistence
  // ---------------------------------------------------------------------------

  _expFile() {
    const fs = require('fs');
    const path = require('path');
    return path.join(this.tc.dataDir, 'experiments.json');
  }

  _loadExperiments() {
    const fs = require('fs');
    try {
      const f = this._expFile();
      if (fs.existsSync(f)) {
        const data = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const exp of data) this._experiments.set(exp.experimentId, exp);
      }
    } catch {}
  }

  _saveExperiments() {
    const fs = require('fs');
    try {
      const arr = Array.from(this._experiments.values());
      const tmp = this._expFile() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
      fs.renameSync(tmp, this._expFile());
    } catch (e) {
      this.log('error', 'experiment save failed', { error: e.message });
    }
  }

  // ---------------------------------------------------------------------------
  // Rating
  // ---------------------------------------------------------------------------

  /**
   * Manually rate a trace.
   * @returns {object|null} The evaluation record, or null if trace not found
   */
  async rate(traceId, { score, feedback, evaluator = 'human', criteria } = {}) {
    const trace = await this.tc.getTrace(traceId);
    if (!trace) return null;

    const evaluation = {
      evalId: crypto.randomUUID(),
      traceId,
      evaluator,
      criteria: criteria || 'overall',
      score: Math.max(1, Math.min(5, Number(score) || 3)),
      feedback: feedback || null,
      timestamp: Date.now(),
    };

    if (!trace.evaluations) trace.evaluations = [];
    trace.evaluations.push(evaluation);

    // Re-persist trace
    try {
      await this.tc._persistTrace(trace);
    } catch (e) {
      this.log('error', 'eval persist failed', { traceId, error: e.message });
    }

    return evaluation;
  }

  // ---------------------------------------------------------------------------
  // Auto-evaluate
  // ---------------------------------------------------------------------------

  /**
   * Use an LLM to evaluate a trace's output quality.
   * Requires this.aiCall to be set.
   */
  async autoEvaluate(traceId, { criteria = ['relevance', 'accuracy'], model = 'gpt-4.1-nano' } = {}) {
    if (!this.aiCall) {
      return { error: 'AI call function not configured for auto-evaluation' };
    }

    const trace = await this.tc.getTrace(traceId);
    if (!trace) return { error: 'Trace not found' };

    // Collect input/output from spans
    const llmSpans = (trace.spans || []).filter(s => s.type === 'llm_call');
    if (llmSpans.length === 0) return { error: 'No LLM spans to evaluate' };

    const lastSpan = llmSpans[llmSpans.length - 1];
    const userInput = typeof lastSpan.input === 'string' ? lastSpan.input :
      (lastSpan.input?.messages ? lastSpan.input.messages.filter(m => m.role === 'user').map(m => m.content).join('\n') : JSON.stringify(lastSpan.input));
    const aiOutput = typeof lastSpan.output === 'string' ? lastSpan.output : JSON.stringify(lastSpan.output);

    const criteriaStr = criteria.join(', ');
    const prompt = `You are an AI output quality evaluator. Rate the following AI response on these criteria: ${criteriaStr}.

User Input:
${(userInput || '').slice(0, 2000)}

AI Output:
${(aiOutput || '').slice(0, 4000)}

For each criterion, provide a score from 1-5 and brief explanation.
Then provide an overall score from 1-5.

Respond in this exact JSON format:
{"scores":{"criterion_name":{"score":N,"reason":"..."},...},"overall":N,"summary":"..."}`;

    try {
      const result = await this.aiCall(model, [{ role: 'user', content: prompt }]);

      // Parse the JSON response
      let parsed;
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { overall: 3, summary: result, scores: {} };
      } catch {
        parsed = { overall: 3, summary: result, scores: {} };
      }

      const evaluations = [];

      // Store individual criterion evaluations
      for (const c of criteria) {
        const cScore = parsed.scores?.[c]?.score || parsed.overall || 3;
        const ev = await this.rate(traceId, {
          score: cScore,
          feedback: parsed.scores?.[c]?.reason || parsed.summary || '',
          evaluator: `auto:${model}`,
          criteria: c,
        });
        if (ev) evaluations.push(ev);
      }

      // Store overall
      const overall = await this.rate(traceId, {
        score: parsed.overall || 3,
        feedback: parsed.summary || '',
        evaluator: `auto:${model}`,
        criteria: 'overall',
      });
      if (overall) evaluations.push(overall);

      return { evaluations, raw: parsed };
    } catch (e) {
      this.log('error', 'auto-evaluate failed', { traceId, error: e.message });
      return { error: e.message };
    }
  }

  // ---------------------------------------------------------------------------
  // A/B Experiments
  // ---------------------------------------------------------------------------

  /**
   * Create a new experiment.
   */
  createExperiment({ name, description, variants = [] } = {}) {
    const experimentId = crypto.randomUUID();
    const exp = {
      experimentId,
      name: name || 'Unnamed experiment',
      description: description || '',
      variants: variants.map(v => typeof v === 'string' ? { name: v, records: [] } : { ...v, records: v.records || [] }),
      createdAt: Date.now(),
      status: 'active',
    };
    this._experiments.set(experimentId, exp);
    this._saveExperiments();
    return exp;
  }

  /**
   * Record a variant result in an experiment.
   */
  async recordVariant(experimentId, { traceId, variant, metrics } = {}) {
    const exp = this._experiments.get(experimentId);
    if (!exp) return { error: 'Experiment not found' };

    let v = exp.variants.find(x => x.name === variant);
    if (!v) {
      v = { name: variant, records: [] };
      exp.variants.push(v);
    }

    v.records.push({
      traceId: traceId || null,
      metrics: metrics || {},
      timestamp: Date.now(),
    });

    // Trim to prevent unbounded growth
    if (v.records.length > 10000) v.records = v.records.slice(-10000);

    this._saveExperiments();
    return { recorded: true };
  }

  /**
   * Get experiment with computed results.
   */
  async getExperimentResults(experimentId) {
    const exp = this._experiments.get(experimentId);
    if (!exp) return null;

    const variants = exp.variants.map(v => {
      const records = v.records || [];
      const scores = records.filter(r => r.metrics?.score != null).map(r => r.metrics.score);
      const durations = records.filter(r => r.metrics?.duration != null).map(r => r.metrics.duration);

      return {
        name: v.name,
        traceCount: records.length,
        avgScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null,
        avgDuration: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
        metrics: records.slice(-10), // last 10 records
      };
    });

    return {
      experimentId: exp.experimentId,
      name: exp.name,
      description: exp.description,
      status: exp.status,
      createdAt: exp.createdAt,
      variants,
    };
  }

  /**
   * List all experiments.
   */
  listExperiments() {
    return Array.from(this._experiments.values()).map(e => ({
      experimentId: e.experimentId,
      name: e.name,
      status: e.status,
      variantCount: e.variants.length,
      totalRecords: e.variants.reduce((sum, v) => sum + (v.records?.length || 0), 0),
      createdAt: e.createdAt,
    }));
  }

  // ---------------------------------------------------------------------------
  // Eval stats
  // ---------------------------------------------------------------------------

  /**
   * Get aggregate evaluation statistics.
   */
  async getEvalStats({ from, to } = {}) {
    const traceResult = await this.tc.listTraces({ from, to, limit: 10000 });

    let totalEvals = 0;
    let totalScore = 0;
    const byCriteria = {};
    const byEvaluator = {};

    for (const item of traceResult.items) {
      const trace = await this.tc.getTrace(item.traceId);
      if (!trace?.evaluations) continue;

      for (const ev of trace.evaluations) {
        totalEvals++;
        totalScore += ev.score;

        const c = ev.criteria || 'overall';
        if (!byCriteria[c]) byCriteria[c] = { count: 0, sum: 0 };
        byCriteria[c].count++;
        byCriteria[c].sum += ev.score;

        const e = ev.evaluator || 'unknown';
        if (!byEvaluator[e]) byEvaluator[e] = { count: 0, sum: 0 };
        byEvaluator[e].count++;
        byEvaluator[e].sum += ev.score;
      }
    }

    // Compute averages
    for (const k of Object.keys(byCriteria)) {
      byCriteria[k].avgScore = Math.round((byCriteria[k].sum / byCriteria[k].count) * 100) / 100;
      delete byCriteria[k].sum;
    }
    for (const k of Object.keys(byEvaluator)) {
      byEvaluator[k].avgScore = Math.round((byEvaluator[k].sum / byEvaluator[k].count) * 100) / 100;
      delete byEvaluator[k].sum;
    }

    return {
      totalEvaluations: totalEvals,
      avgScore: totalEvals ? Math.round((totalScore / totalEvals) * 100) / 100 : null,
      byCriteria,
      byEvaluator,
    };
  }
}

module.exports = { Evaluator };
