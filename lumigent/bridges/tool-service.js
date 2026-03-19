"use strict";

function createToolServiceBridge(options = {}) {
  const executeBuiltinTool = options.executeBuiltinTool;

  async function runBuiltin(name, input) {
    const result = await executeBuiltinTool(name, input || {});
    if (!result?.ok) throw new Error(result?.error || `${name} failed`);
    return result.file ? result : { data: result.data, duration: result.duration };
  }

  return {
    async webSearch(toolInput) {
      return runBuiltin("web_search", toolInput);
    },

    async parseFile(toolInput) {
      return runBuiltin("parse_file", toolInput);
    },

    async transcribeAudio(toolInput) {
      return runBuiltin("transcribe_audio", toolInput);
    },
  };
}

module.exports = { createToolServiceBridge };
