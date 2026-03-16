"use strict";
const { detectPII } = require("./presidio-layer");
const { SecretMapping, deepTransform } = require("./secret-mapping");
const { detectWithOllama } = require("./ollama-detector");
const { detectSecrets } = require("./detector");
const { checkCommand } = require("./command-guard");

const sessionMappings = new Map(); // sessionId → { mapping, lastActive }

function getMapping(sessionId) {
  if (!sessionMappings.has(sessionId)) {
    sessionMappings.set(sessionId, { mapping: new SecretMapping(), lastActive: Date.now() });
  }
  const entry = sessionMappings.get(sessionId);
  entry.lastActive = Date.now();
  return entry.mapping;
}

// Cleanup inactive sessions every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, entry] of sessionMappings) {
    if (entry.lastActive < cutoff) sessionMappings.delete(id);
  }
}, 5 * 60_000).unref();

module.exports = { detectPII, SecretMapping, getMapping, deepTransform, sessionMappings, detectWithOllama, detectSecrets, checkCommand };
