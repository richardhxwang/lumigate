"use strict";

/**
 * detector.js — Combined secret detection: regex (presidio-layer) + Ollama semantic.
 *
 * Merges results from both engines and deduplicates by value,
 * keeping the highest-confidence match for each unique secret.
 */

const { detectPII } = require("./presidio-layer");
const { detectWithOllama } = require("./ollama-detector");

/**
 * Deduplicate entities by value, keeping the highest score for each.
 * @param {Array<{type: string, value: string, start: number, end: number, score: number}>} entities
 * @returns {Array<{type: string, value: string, start: number, end: number, score: number}>}
 */
function deduplicateEntities(entities) {
  const seen = new Map();
  for (const e of entities) {
    const existing = seen.get(e.value);
    if (!existing || e.score > existing.score) {
      seen.set(e.value, e);
    }
  }
  return [...seen.values()].sort((a, b) => a.start - b.start);
}

/**
 * Detect secrets in text using regex patterns and optionally Ollama semantic analysis.
 *
 * @param {string} text - The text to analyze
 * @param {object} [options] - Configuration options
 * @param {boolean} [options.ollama=true] - Whether to run Ollama detection (set false for regex-only)
 * @param {string} [options.ollamaUrl] - Ollama API base URL
 * @param {string} [options.ollamaModel] - Ollama model to use
 * @returns {Promise<{found: boolean, entities: Array<{type: string, value: string, start: number, end: number, score: number}>}>}
 */
async function detectSecrets(text, options = {}) {
  // 1. Fast regex detection
  const regexResult = detectPII(text);
  let allEntities = [...regexResult.entities];

  // 2. Optional Ollama semantic detection
  if (options.ollama !== false) {
    const ollamaEntities = await detectWithOllama(text, {
      ollamaUrl: options.ollamaUrl,
      ollamaModel: options.ollamaModel,
    });
    allEntities = allEntities.concat(ollamaEntities);
  }

  // 3. Deduplicate
  const entities = deduplicateEntities(allEntities);

  return {
    found: entities.length > 0,
    entities,
  };
}

module.exports = { detectSecrets };
