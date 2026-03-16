"use strict";

/**
 * ollama-detector.js — Semantic secret detection via local Ollama LLM.
 *
 * Calls an Ollama model to identify secrets, credentials, API keys, etc.
 * that regex patterns might miss. Gracefully degrades when Ollama is unavailable.
 */

const OLLAMA_SYSTEM_PROMPT = `You are a sensitive-data detector. Analyze the user message and identify any secrets, credentials, API keys, passwords, tokens, private keys, or other sensitive information.

Respond ONLY with a JSON array. Each element:
{"type": "api_key"|"password"|"token"|"private_key"|"credential"|"pii"|"other", "value": "the exact sensitive string", "reason": "brief explanation"}

If nothing sensitive is found, respond with an empty array: []

Important:
- Be aware of Chinese text — 密码、密钥、令牌、口令 all indicate secrets
- Look for patterns like key=value, password: xxx, token: xxx
- Detect high-entropy strings that look like secrets
- Do NOT flag obviously public information (URLs without auth, version numbers, etc.)`;

// Filter out env var references — these are not real secrets
const ENV_REF_RE = /^(?:process\.env\.\w+|\$\w+|\$\{\w+\}|os\.environ(?:\[|\.get\().*|ENV\[.*\])$/;

/**
 * Detect secrets in text using Ollama semantic analysis.
 *
 * @param {string} text - The text to analyze
 * @param {object} [config] - Configuration options
 * @param {string} [config.ollamaUrl='http://host.docker.internal:11434'] - Ollama API base URL
 * @param {string} [config.ollamaModel='qwen2.5:1.5b'] - Ollama model to use
 * @returns {Promise<Array<{type: string, value: string, start: number, end: number, score: number}>>}
 */
async function detectWithOllama(text, config = {}) {
  const ollamaUrl = config.ollamaUrl || "http://host.docker.internal:11434";
  const ollamaModel = config.ollamaModel || "qwen2.5:1.5b";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel,
        prompt: text,
        system: OLLAMA_SYSTEM_PROMPT,
        stream: false,
        options: {
          temperature: 0,
          num_predict: 512,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) return [];

    const data = await response.json();
    if (!data.response) return [];

    // Parse JSON from the response — Ollama may wrap in markdown code blocks
    let jsonStr = data.response.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((e) => e && typeof e.value === "string" && e.value.length > 0)
      .filter((e) => !ENV_REF_RE.test(e.value.trim()))
      .map((e) => {
        const idx = text.indexOf(e.value);
        return {
          type: e.type || "unknown",
          value: e.value,
          start: idx >= 0 ? idx : 0,
          end: idx >= 0 ? idx + e.value.length : e.value.length,
          score: 0.75,
        };
      });
  } catch (_err) {
    // Gracefully handle Ollama being unavailable, timing out, or returning bad JSON
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { detectWithOllama };
