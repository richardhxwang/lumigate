"use strict";

function registerBuiltinLumigentTools(registry, bridges = {}) {
  if (!registry) throw new Error("registry is required");

  if (bridges.toolService?.webSearch) {
    registry.registerTool({
      name: "web_search",
      description: "Search the web for current information using SearXNG.",
      input_schema: {
        type: "object",
        properties: {
          q: { type: "string", description: "The search query string" },
          categories: { type: "string", description: "Comma-separated search categories" },
          time_range: { type: "string", enum: ["day", "week", "month", "year"], description: "Limit results to a time range" },
          language: { type: "string", description: "Search language code" },
        },
        required: ["q"],
      },
    }, bridges.toolService.webSearch);
  }

  if (bridges.toolService?.parseFile) {
    registry.registerTool({
      name: "parse_file",
      description: "Parse an uploaded file and extract text content for analysis.",
      input_schema: {
        type: "object",
        properties: {
          file_url: { type: "string", description: "URL to download the file from" },
          filename: { type: "string", description: "Original filename with extension" },
        },
        required: ["file_url", "filename"],
      },
    }, bridges.toolService.parseFile);
  }

  if (bridges.toolService?.transcribeAudio) {
    registry.registerTool({
      name: "transcribe_audio",
      description: "Transcribe audio to text using Whisper speech recognition.",
      input_schema: {
        type: "object",
        properties: {
          audio_url: { type: "string", description: "URL to download the audio file from" },
          content_type: { type: "string", description: "Audio MIME type" },
        },
        required: ["audio_url"],
      },
    }, bridges.toolService.transcribeAudio);
  }

  if (bridges.internalHttp?.visionAnalyze) {
    registry.registerTool({
      name: "vision_analyze",
      description: "Analyze an image using vision capabilities.",
      input_schema: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "URL of the image to analyze" },
          prompt: { type: "string", description: "Question or instruction about the image" },
          detail: { type: "string", enum: ["low", "high", "auto"], description: "Requested detail level" },
        },
        required: ["image_url"],
      },
    }, bridges.internalHttp.visionAnalyze);
  }

  if (bridges.internalHttp?.codeRun) {
    registry.registerTool({
      name: "code_run",
      description: "Execute code in a sandboxed environment and return stdout/stderr output.",
      input_schema: {
        type: "object",
        properties: {
          language: { type: "string", enum: ["python", "javascript"], description: "Programming language to execute" },
          code: { type: "string", description: "Source code to execute" },
          timeout: { type: "number", description: "Maximum execution time in milliseconds" },
          stdin: { type: "string", description: "Optional standard input" },
        },
        required: ["language", "code"],
      },
    }, bridges.internalHttp.codeRun);
  }

  if (bridges.mcp?.browserAction) {
    registry.registerTool({
      name: "browser_action",
      description: "Perform browser automation actions using Playwright MCP tools.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["navigate", "click", "fill", "screenshot", "get_text", "evaluate", "wait"], description: "The browser action to perform" },
          url: { type: "string", description: "URL to navigate to" },
          selector: { type: "string", description: "CSS or text selector for the target element" },
          value: { type: "string", description: "Value to fill into a form field" },
          script: { type: "string", description: "JavaScript to evaluate" },
          timeout: { type: "number", description: "Maximum wait time in milliseconds" },
        },
        required: ["action"],
      },
    }, bridges.mcp.browserAction);
  }
}

module.exports = { registerBuiltinLumigentTools };
