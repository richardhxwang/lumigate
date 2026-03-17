"use strict";

const crypto = require("node:crypto");
const { validateExternalUrl } = require("../security/url-validator");

/**
 * Tool Registry — Fetches and caches tool schemas from microservices.
 * Used by the proxy middleware to inject tools[] into LLM requests
 * and execute tool_use responses.
 */

const DOC_GEN_URL = process.env.DOC_GEN_URL || "http://lumigate-doc-gen:3101";
const FILE_PARSER_URL = process.env.FILE_PARSER_URL || "http://lumigate-file-parser:3100";
const SEARXNG_URL = process.env.SEARXNG_URL || "http://lumigate-searxng:8080";
const WHISPER_URL = process.env.WHISPER_URL || "http://host.docker.internal:17863";

const REFRESH_TTL = 5 * 60_000; // 5 minutes

// Extra tools not served by doc-gen /tools
const EXTRA_TOOLS = [
  {
    name: "parse_file",
    description: "Parse an uploaded file (PDF/Excel/Word/PPTX/CSV) and extract text content for analysis.",
    input_schema: {
      type: "object",
      properties: {
        file_url: { type: "string", description: "URL to download the file from" },
        filename: { type: "string", description: "Original filename with extension" },
      },
      required: ["file_url", "filename"],
    },
  },
  {
    name: "transcribe_audio",
    description: "Transcribe audio to text using Whisper speech recognition.",
    input_schema: {
      type: "object",
      properties: {
        audio_url: { type: "string", description: "URL to download the audio file from" },
        content_type: { type: "string", description: "Audio MIME type (audio/wav, audio/webm, audio/ogg, audio/mp3)", default: "audio/wav" },
      },
      required: ["audio_url"],
    },
  },
];

const TOOL_SYSTEM_PROMPT = `You have access to the following tools to help users:
- generate_document: Generate Word (.docx) documents with headings, tables, lists, TOC
- generate_presentation: Generate PowerPoint (.pptx) slides with charts, layouts, speaker notes
- generate_spreadsheet: Generate Excel (.xlsx) with formulas, conditional formatting, charts
- convert_xlsx_to_pptx / convert_xlsx_to_docx: Convert between formats
- web_search: Search the web for current information
- parse_file: Parse uploaded files (PDF/Excel/Word/PPTX/CSV) to extract text
- transcribe_audio: Convert speech audio to text

When generating files, provide structured parameters. Tools return download links.
When searching, include relevant query terms. Summarize results for the user.`;

class ToolRegistry {
  constructor() {
    this.schemas = [];
    this.lastFetch = 0;
  }

  async refresh() {
    try {
      const res = await fetch(`${DOC_GEN_URL}/tools`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        this.schemas = Array.isArray(data) ? data : [];
      } else {
        console.warn(`[tool-registry] Failed to fetch doc-gen tools: ${res.status}`);
        this.schemas = [];
      }
    } catch (err) {
      console.warn(`[tool-registry] doc-gen unreachable: ${err.message}`);
      this.schemas = [];
    }
    // Append extra tools
    for (const tool of EXTRA_TOOLS) {
      if (!this.schemas.find(t => t.name === tool.name)) {
        this.schemas.push(tool);
      }
    }
    this.lastFetch = Date.now();
  }

  async getSchemas() {
    if (Date.now() - this.lastFetch > REFRESH_TTL) {
      await this.refresh();
    }
    return this.schemas;
  }

  getSystemPrompt() {
    return TOOL_SYSTEM_PROMPT;
  }
}

/**
 * Execute a tool call by routing to the appropriate microservice.
 * Returns { ok, data, file?, filename?, mimeType?, error? }
 */
async function executeToolCall(toolName, toolInput) {
  const startTime = Date.now();
  try {
    switch (toolName) {
      case "generate_document": {
        const res = await fetch(`${DOC_GEN_URL}/generate/docx`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toolInput),
        });
        if (!res.ok) throw new Error(`doc-gen returned ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const filename = (toolInput.title || "document").replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "_") + ".docx";
        return { ok: true, file: buffer, filename, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", duration: Date.now() - startTime };
      }
      case "generate_presentation": {
        const res = await fetch(`${DOC_GEN_URL}/generate/pptx`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toolInput),
        });
        if (!res.ok) throw new Error(`doc-gen returned ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const filename = (toolInput.title || "presentation").replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "_") + ".pptx";
        return { ok: true, file: buffer, filename, mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", duration: Date.now() - startTime };
      }
      case "generate_spreadsheet": {
        const res = await fetch(`${DOC_GEN_URL}/generate/xlsx`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toolInput),
        });
        if (!res.ok) throw new Error(`doc-gen returned ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const filename = (toolInput.title || "spreadsheet").replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "_") + ".xlsx";
        return { ok: true, file: buffer, filename, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", duration: Date.now() - startTime };
      }
      case "convert_xlsx_to_pptx": {
        const res = await fetch(`${DOC_GEN_URL}/convert/xlsx-to-pptx`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toolInput),
        });
        if (!res.ok) throw new Error(`doc-gen returned ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        return { ok: true, file: buffer, filename: "converted.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", duration: Date.now() - startTime };
      }
      case "convert_xlsx_to_docx": {
        const res = await fetch(`${DOC_GEN_URL}/convert/xlsx-to-docx`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toolInput),
        });
        if (!res.ok) throw new Error(`doc-gen returned ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        return { ok: true, file: buffer, filename: "converted.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", duration: Date.now() - startTime };
      }
      case "web_search": {
        const q = toolInput.q || toolInput.query || toolInput.search || "";
        if (!q) return { ok: false, error: "Missing search query", duration: Date.now() - startTime };
        const params = new URLSearchParams({ q, format: "json" });
        if (toolInput.categories) params.set("categories", toolInput.categories);
        if (toolInput.time_range) params.set("time_range", toolInput.time_range);
        if (toolInput.language) params.set("language", toolInput.language);
        const res = await fetch(`${SEARXNG_URL}/search?${params}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`searxng returned ${res.status}`);
        const data = await res.json();
        const results = (data.results || []).slice(0, 8).map(r => ({
          title: r.title, url: r.url, content: r.content,
        }));
        return { ok: true, data: { results, query: q }, duration: Date.now() - startTime };
      }
      case "parse_file": {
        const fileUrlCheck = await validateExternalUrl(toolInput.file_url);
        if (!fileUrlCheck.ok) return { ok: false, error: `Blocked file_url: ${fileUrlCheck.error}`, duration: Date.now() - startTime };
        const fileRes = await fetch(toolInput.file_url, { signal: AbortSignal.timeout(30000) });
        if (!fileRes.ok) throw new Error(`Failed to download file: ${fileRes.status}`);
        const fileBuffer = Buffer.from(await fileRes.arrayBuffer());
        // Build multipart form data manually
        const boundary = "----FormBoundary" + crypto.randomBytes(8).toString("hex");
        const parts = [];
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${toolInput.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
        const header = Buffer.from(parts[0]);
        const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([header, fileBuffer, footer]);
        const parseRes = await fetch(`${FILE_PARSER_URL}/parse`, {
          method: "POST",
          headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
          body,
          signal: AbortSignal.timeout(30000),
        });
        if (!parseRes.ok) throw new Error(`file-parser returned ${parseRes.status}`);
        const parseData = await parseRes.json();
        return { ok: true, data: { text: parseData.text, filename: toolInput.filename, pages: parseData.pages }, duration: Date.now() - startTime };
      }
      case "transcribe_audio": {
        const audioUrlCheck = await validateExternalUrl(toolInput.audio_url);
        if (!audioUrlCheck.ok) return { ok: false, error: `Blocked audio_url: ${audioUrlCheck.error}`, duration: Date.now() - startTime };
        const audioRes = await fetch(toolInput.audio_url, { signal: AbortSignal.timeout(30000) });
        if (!audioRes.ok) throw new Error(`Failed to download audio: ${audioRes.status}`);
        const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
        const contentType = toolInput.content_type || "audio/wav";
        const whisperRes = await fetch(`${WHISPER_URL}/transcribe`, {
          method: "POST",
          headers: { "Content-Type": contentType },
          body: audioBuffer,
          signal: AbortSignal.timeout(30000),
        });
        if (!whisperRes.ok) throw new Error(`whisper returned ${whisperRes.status}`);
        const whisperData = await whisperRes.json();
        return { ok: true, data: { text: whisperData.text }, duration: Date.now() - startTime };
      }
      default:
        return { ok: false, error: `Unknown tool: ${toolName}`, duration: Date.now() - startTime };
    }
  } catch (err) {
    return { ok: false, error: err.message, duration: Date.now() - startTime };
  }
}

const registry = new ToolRegistry();
// Pre-warm on import
registry.refresh().catch(() => {});

module.exports = { registry, executeToolCall, TOOL_SYSTEM_PROMPT };
