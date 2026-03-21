"use strict";

/**
 * services/deep-search/llm-helper.js
 * Non-streaming LLM calls for Deep Search orchestrator.
 * Auto-selects cheapest available model for grunt work.
 */

// Cheap model candidates in cost order
const CHEAP_CANDIDATES = [
  { provider: "deepseek", model: "deepseek-chat" },       // $0.27/M in
  { provider: "openai",   model: "gpt-4.1-nano" },        // $0.10/M in
  { provider: "openai",   model: "gpt-4.1-mini" },        // $0.40/M in
  { provider: "qwen",     model: "qwen-plus" },           // ~$0.50/M in
  { provider: "gemini",   model: "gemini-2.0-flash" },    // free tier
];

/**
 * Create an LLM helper bound to the gateway's provider infrastructure.
 * @param {object} deps
 * @param {object} deps.PROVIDERS - Provider config map
 * @param {function} deps.selectApiKey - (providerName, projectName) => {apiKey, keyId}
 * @param {function} [deps.log] - Logger
 */
function createLlmHelper({ PROVIDERS, selectApiKey, log = () => {} }) {

  // Find the cheapest model with a working API key
  let _cheapModelCache = null;

  function selectCheapModel() {
    if (_cheapModelCache) return _cheapModelCache;
    for (const c of CHEAP_CANDIDATES) {
      const prov = PROVIDERS[c.provider];
      if (!prov) continue;
      const key = prov.apiKey || selectApiKey(c.provider, "_deep_search")?.apiKey;
      if (key) {
        _cheapModelCache = { provider: c.provider, model: c.model, apiKey: key, baseUrl: prov.baseUrl };
        log("info", "deep_search_cheap_model", { provider: c.provider, model: c.model });
        return _cheapModelCache;
      }
    }
    return null;
  }

  /**
   * Resolve an expensive model config for final synthesis.
   * Uses caller's selected model, or falls back to best available.
   */
  function resolveExpensiveModel(callerProvider, callerModel) {
    if (callerProvider && callerModel) {
      const prov = PROVIDERS[callerProvider];
      if (prov) {
        const key = prov.apiKey || selectApiKey(callerProvider, "_deep_search")?.apiKey;
        if (key) return { provider: callerProvider, model: callerModel, apiKey: key, baseUrl: prov.baseUrl };
      }
    }
    // Fallback: try flagship models
    const flagships = [
      { provider: "anthropic", model: "claude-sonnet-4-6" },
      { provider: "openai", model: "gpt-4o" },
      { provider: "deepseek", model: "deepseek-chat" },
    ];
    for (const f of flagships) {
      const prov = PROVIDERS[f.provider];
      if (!prov) continue;
      const key = prov.apiKey || selectApiKey(f.provider, "_deep_search")?.apiKey;
      if (key) return { provider: f.provider, model: f.model, apiKey: key, baseUrl: prov.baseUrl };
    }
    // Last resort: use cheap model
    return selectCheapModel();
  }

  /**
   * Make a non-streaming LLM call.
   * @param {object} modelConfig - { provider, model, apiKey, baseUrl }
   * @param {Array} messages - [{role, content}]
   * @param {object} [opts]
   * @param {number} [opts.maxTokens=2048]
   * @param {number} [opts.temperature=0]
   * @param {boolean} [opts.jsonMode=false]
   * @returns {Promise<{text: string, usage: {input: number, output: number}}>}
   */
  async function callLLM(modelConfig, messages, { maxTokens = 2048, temperature = 0, jsonMode = false } = {}) {
    if (!modelConfig) throw new Error("No model config available");
    const { provider, model, apiKey, baseUrl } = modelConfig;

    const isAnthropic = provider === "anthropic";
    const url = isAnthropic
      ? `${baseUrl}/v1/messages`
      : provider === "gemini"
        ? `${baseUrl}/v1beta/openai/chat/completions`
        : provider === "doubao"
          ? `${baseUrl}/chat/completions`
          : `${baseUrl}/v1/chat/completions`;

    const headers = isAnthropic
      ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

    let body;
    if (isAnthropic) {
      const system = messages.find(m => m.role === "system")?.content || "";
      const nonSystem = messages.filter(m => m.role !== "system");
      body = { model, messages: nonSystem, max_tokens: maxTokens, temperature };
      if (system) body.system = system;
    } else {
      body = { model, messages, max_tokens: maxTokens, temperature, stream: false };
      if (jsonMode) body.response_format = { type: "json_object" };
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`LLM ${provider}/${model} returned ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();

    // Extract text + usage (provider-specific)
    let text, usage;
    if (isAnthropic) {
      text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      usage = { input: data.usage?.input_tokens || 0, output: data.usage?.output_tokens || 0 };
    } else {
      text = data.choices?.[0]?.message?.content || "";
      usage = { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 };
    }

    return { text, usage };
  }

  /**
   * Call cheap model for grunt work.
   */
  async function callCheap(messages, opts = {}) {
    const model = selectCheapModel();
    if (!model) throw new Error("No cheap model available for deep search");
    return callLLM(model, messages, opts);
  }

  /**
   * Call expensive model for synthesis.
   */
  async function callExpensive(callerProvider, callerModel, messages, opts = {}) {
    const model = resolveExpensiveModel(callerProvider, callerModel);
    if (!model) throw new Error("No model available for synthesis");
    return callLLM(model, messages, { maxTokens: 8192, ...opts });
  }

  return { callCheap, callExpensive, selectCheapModel, resolveExpensiveModel };
}

module.exports = { createLlmHelper };
