/**
 * routes/chat.js — Clean Chat Proxy (POST /v1/chat)
 *
 * Unified endpoint for all apps (LumiChat, FurNote, etc.).
 * Handles: auth, pre-search, specialist mode, system prompt assembly,
 * upstream fetch, SSE pipe, auto-continue, tool execution, follow-up calls.
 */
const express = require("express");
const path = require("path");
const { isComplexRequest, buildPlanningPrompt } = require("../lumigent/runtime");

module.exports = function createChatRouter(deps) {
  const {
    apiLimiter,
    safeEqual,
    INTERNAL_CHAT_KEY,
    getSessionRole,
    parseCookies,
    validateAuthToken,
    getLcUserTier,
    projects,
    projectKeyIndex,
    ephemeralTokens,
    verifyHmacSignature,
    selectApiKey,
    checkBudgetReset,
    PROVIDERS,
    COLLECTOR_SUPPORTED,
    getProviderAccessMode,
    hasCollectorToken,
    getCollectorCredentials,
    setCollectorHealth,
    lumigentRuntime,
    settings,
    recordUsage,
    log,
    lcPbFetch,
    lcNowIso,
    lcSupportsField,
    validPbId,
    normalizeAttachmentContextItems,
    extractMessagePlainText,
    stripAttachmentContextBlocks,
    contentHasAttachmentContext,
    getAttachmentSearchMode,
    buildFinancialAnalysisPromptBlock,
    buildStructuredAttachmentPayloadBlock,
    lcDecryptEncryptedPayload,
    lcUploadSafeName,
    detectLcUploadMime,
    lcB64urlToBuffer,
    extractTextForLcBuffer,
    describeImageBufferForModel,
    assertLcSessionOwned,
    uploadLcBufferRecord,
    buildRelevantAttachmentExcerpt,
    lcFileKindByMimeOrExt,
    assertRecordOwned,
    mergeArraysUnique,
    fetchLcAttachmentContextsByIds,
    runFinancialAnalysisForAttachments,
    LC_ENCRYPTED_UPLOAD_LIMIT_BYTES,
    LC_MODEL_ATTACHMENT_FULL_CHARS,
    shouldAutoContinueFinishReason,
    getContinuationPrompt,
    AUTO_CONTINUE_MAX_PASSES,
    SEARXNG_URL,
    lcUrlFetchMemory,
    LC_URL_FETCH_MEMORY_MAX_ITEMS,
    LC_URL_FETCH_MEMORY_MAX_CHARS,
    FILE_PARSER_URL,
    _collector, // getter function: () => _collector
    touchLcSession,
    clampPbMessageContent,
    getPbAdminToken,
    PB_URL,
    userMemory, // optional: UserMemory instance for long-term memory
  } = deps;

  const router = express.Router();


// --- Pre-search helpers ---
function needsWebSearch(text) {
  if (!text || text.length < 2) return false;
  // Broad detection — if there's any chance the question needs fresh data, search.
  // Better to search unnecessarily than to miss a time-sensitive query.
  return [
    // Explicit search intent
    /搜[索一下]|查[找一下询]|帮我[找查搜]/,
    // Time-sensitive signals (CN)
    /最新|最近|今[天日年]|昨[天日]|本[周月年]|上[周月]|这[几两]天|近[期来日]|目前|现在|当前|实时|刚[刚才]|新出/,
    // Topic signals — likely needs current data (CN)
    /新闻|天气|价格|股[价票]|汇率|发布|上线|更新|升级|版本|政策|法规|赛[事程]|比分|排[名行]|榜|票房|疫情|选举/,
    // Change/trend signals (CN)
    /变化|变动|趋势|走势|动态|进展|消息|情况|怎[么样]样了|有什么/,
    // English equivalents
    /search|look\s?up|latest|current|today|yesterday|this\s(?:week|month|year)|recent|now|just\s|new\s/i,
    /news|weather|price|stock|release|update|version|score|ranking|election/i,
    /what.?(?:happen|change|going\son)|how\smuch|who\s(?:is|won|died)|when\sdid/i,
    // Recommendation/comparison (often need current data)
    /best\s|top\s\d|recommend|comparison|vs\s|versus|alternative|worth\s/i,
    /推荐|对比|哪个好|值得|排行|评测|测评/,
  ].some(p => p.test(text));
}

function needsStrictFreshness(text) {
  if (!text || text.length < 2) return false;
  return [
    /最新|最近|今天|今日|昨天|本周|本月|本年|今年|现在|当前|实时|刚刚|刚才|近期|近况|进展|更新|发布|上线|版本|价格|股价|汇率|天气|新闻|政策|法规|比分|赛程|排名|票房|选举|疫情/,
    /\b(latest|current|today|yesterday|this\s(?:week|month|year)|now|recent|real[-\s]?time|breaking|live|price|stock|exchange\s*rate|weather|news|score|ranking|release|update|version)\b/i,
  ].some((p) => p.test(text));
}

function classifyChatIntent(text, { hasDirectUrl = false, hasRichUserInput = false, hasStoredAttachmentContext = false } = {}) {
  const src = String(text || "");
  const hasOfficialSignal = /(官方|官网|政府|监管|監管|公示|公告|official|government|regulator|regulatory|gov|authority|ministry|department|bureau)/i.test(src);
  const hasDocSignal = /(文件|文档|文檔|表格|表單|指南|手册|手冊|规程|規程|政策|pdf|docx?|xlsx?|pptx?|下载|下載|link|url|where|how|form|forms|filing|application)/i.test(src);
  const hasTaxSignal = /(报税|報稅|税务|稅務|tax|ird|inland revenue|franchise tax|irs|ftb)/i.test(src);
  const hasRegionSignal = /(香港|hk\b|hksar|california|加州|us\b|u\.s\.|美国|美國|uk\b|英国|singapore|新加坡)/i.test(src);
  const hasFormOrDownload = /(下载|下載|download|表格|表單|form|forms|pdf|docx?|xlsx?)/i.test(src);
  const hasSearchIntent = needsWebSearch(src) || /搜[索一下]|查[找一下询]|search|look\s?up|find/i.test(src);
  const officialFormLookup = (hasOfficialSignal && hasDocSignal && hasRegionSignal) || (hasFormOrDownload && hasTaxSignal && hasRegionSignal);

  if (hasDirectUrl) {
    return { kind: "url_fetch", subtype: "direct_url", officialFormLookup: false, searchIntent: true };
  }
  if (officialFormLookup) {
    return { kind: "web_lookup", subtype: "official_form", officialFormLookup: true, searchIntent: true };
  }
  if (hasRichUserInput || hasStoredAttachmentContext) {
    return { kind: "file_qa", subtype: "attachment", officialFormLookup: false, searchIntent: hasSearchIntent };
  }
  if (hasSearchIntent) {
    return { kind: "web_lookup", subtype: "general", officialFormLookup: false, searchIntent: true };
  }
  return { kind: "chat_only", subtype: "general", officialFormLookup: false, searchIntent: false };
}

function getOfficialFormFallbackResults(text) {
  const src = String(text || "");
  if (/(香港|hk\b|hksar|ird|inland revenue)/i.test(src)) {
    return [
      {
        title: "Hong Kong Inland Revenue Department - Tax Return Forms",
        url: "https://www.ird.gov.hk/eng/paf/form.htm",
        snippet: "Official HK tax return forms and related filing forms.",
      },
      {
        title: "Hong Kong Inland Revenue Department - Download Forms",
        url: "https://www.ird.gov.hk/eng/paf/download.htm",
        snippet: "Official HK forms download portal.",
      },
    ];
  }
  if (/(california|加州|ftb|franchise tax)/i.test(src)) {
    return [
      {
        title: "California Franchise Tax Board - Forms",
        url: "https://www.ftb.ca.gov/forms/",
        snippet: "Official California tax forms and publications.",
      },
    ];
  }
  return [];
}

function buildRequiredLinkLines(results, lang) {
  if (!Array.isArray(results) || !results.length) return "";
  const topLinks = results
    .filter((r) => r && r.url)
    .slice(0, 3)
    .map((r, i) => `${i + 1}. ${String(r.title || "Source").trim()}\n${String(r.url).trim()}`)
    .join("\n\n");
  if (!topLinks) return "";
  return lang === "zh" ? `官方链接：\n${topLinks}` : `Official links:\n${topLinks}`;
}

function extractSearchQuery(text) {
  return text
    .replace(/^(搜索?|查[找询一下]*|帮我|请|search|look\s?up|find\s+me|what is|who is|tell me about)\s*/i, "")
    .slice(0, 200).trim() || text.slice(0, 200);
}

function extractDirectUrls(text) {
  if (!text) return [];
  const src = String(text);
  const out = [];
  const seen = new Set();
  const blockedBareFileTlds = new Set([
    "xlsx", "xls", "csv", "tsv",
    "xlsm", "xlsb", "xltx", "xltm", "numbers",
    "docx", "doc", "pdf", "pptx", "ppt",
    "docm", "dotx", "dotm", "pptm", "potx", "potm", "ppsx", "ppsm", "pages", "key",
    "txt", "md", "json", "xml", "yaml", "yml",
    "log", "py", "js", "ts", "java", "go", "rs", "sh",
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg",
    "mp3", "wav", "m4a", "mp4", "mov", "avi", "mkv",
    "zip", "rar", "7z", "tar", "gz",
  ]);
  const patterns = [
    /\b(?:https?:\/\/|ttps?:\/\/|www\.)[^\s<>"'`，。！？；：、）】》]+/gi,
    /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]*)?/gi,
  ];
  const normalizeCandidateUrl = (raw) => {
    let s = String(raw || "").trim();
    if (!s) return "";
    const hadExplicitPrefix = /^(https?:\/\/|ttps?:\/\/|www\.)/i.test(s);
    s = s.replace(/[，。！？；：、,.!?;:]+$/g, "");
    // Strip trailing non-URL characters (e.g. Chinese instructions appended without space).
    while (s && !/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]$/.test(s)) s = s.slice(0, -1);
    // Trim unmatched right-side wrappers when users append instructions without space.
    while (/[)\]】》}>]$/.test(s) && !/[(\[{【《<]/.test(s)) s = s.slice(0, -1);
    // Prevent common local filenames (e.g. report.xlsx) from being treated as domains.
    if (!hadExplicitPrefix && !s.includes("/")) {
      // Prevent MIME-like fragments (e.g. vnd.openxmlformats-officedocument.spreadsheetml.sheet)
      // from being treated as URL domains.
      if (/^(?:vnd|application|text|audio|video|image|multipart|message|model|font)\./i.test(s)) return "";
      const m = s.match(/\.([a-z0-9]{2,10})$/i);
      const tail = String(m?.[1] || "").toLowerCase();
      if (tail && blockedBareFileTlds.has(tail)) return "";
    }
    if (/^ttps?:\/\//i.test(s)) s = `h${s}`;
    if (/^www\./i.test(s)) s = `https://${s}`;
    if (!/^[a-z][a-z0-9+\-.]*:\/\//i.test(s)) s = `https://${s}`;
    try {
      const u = new URL(s);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return u.toString();
    } catch {
      return "";
    }
  };
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) {
      const url = normalizeCandidateUrl(m[0]);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
      if (out.length >= 3) return out;
    }
  }
  return out.slice(0, 3);
}

function inferFilenameFromUrl(urlText, idx = 1) {
  try {
    const u = new URL(String(urlText || ""));
    const pathName = decodeURIComponent(u.pathname || "");
    const raw = path.basename(pathName || "") || `url-${idx}.txt`;
    const safe = raw.replace(/[\\/:*?"<>|]/g, "_").trim();
    return safe || `url-${idx}.txt`;
  } catch {
    return `url-${idx}.txt`;
  }
}

function formatUrlFetchContext(items) {
  if (!Array.isArray(items) || !items.length) return "";
  return "[Direct URL Fetch Context]\n" + items.map((it, i) => (
    `${i + 1}. URL: ${it.url}\n` +
    `Source: ${it.filename}\n` +
    `${it.text || ""}`
  )).join("\n\n");
}

function normalizeChatSessionId(raw) {
  const s = String(raw || "").trim();
  return /^[a-z0-9]{15}$/.test(s) ? s : "";
}

function urlFetchMemoryKey(owner, sessionId) {
  return `${String(owner || "anon")}::${String(sessionId || "")}`;
}

function getUrlFetchMemoryContext(owner, sessionId) {
  const key = urlFetchMemoryKey(owner, sessionId);
  const rec = lcUrlFetchMemory.get(key);
  if (!rec || !Array.isArray(rec.items) || rec.items.length === 0) return "";
  return formatUrlFetchContext(rec.items);
}

function rememberUrlFetchContexts(owner, sessionId, fetchedItems) {
  if (!Array.isArray(fetchedItems) || fetchedItems.length === 0) return;
  const key = urlFetchMemoryKey(owner, sessionId);
  const prev = lcUrlFetchMemory.get(key);
  const merged = [...(Array.isArray(prev?.items) ? prev.items : []), ...fetchedItems];
  const dedup = [];
  const seen = new Set();
  for (const item of merged) {
    const u = String(item?.url || "").trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    dedup.push({
      url: u,
      filename: String(item?.filename || "url.txt"),
      text: String(item?.text || "").slice(0, 40_000),
    });
  }
  let trimmed = dedup.slice(-LC_URL_FETCH_MEMORY_MAX_ITEMS);
  let total = trimmed.reduce((n, it) => n + (it.text || "").length, 0);
  while (trimmed.length > 1 && total > LC_URL_FETCH_MEMORY_MAX_CHARS) {
    const first = trimmed.shift();
    total -= (first?.text || "").length;
  }
  lcUrlFetchMemory.set(key, { items: trimmed, updatedAt: Date.now() });
}

async function executeWebSearchForChat(query, timeRange = "month") {
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&language=auto&safesearch=0${timeRange ? `&time_range=${timeRange}` : ""}`;
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`SearXNG ${r.status}`);
  const data = await r.json();
  let results = (data.results || []).slice(0, 15).map(item => ({
    title: item.title || "", url: item.url || "", content: (item.content || "").slice(0, 400),
  }));

  // Adaptive re-fetch: if fewer than 3 results have titles containing query keywords, refine
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const highRelevance = results.filter(r => {
    const title = (r.title || "").toLowerCase();
    return keywords.some(kw => title.includes(kw));
  });
  if (highRelevance.length < 3 && results.length >= 3) {
    try {
      // Retry with refined query (add quotes around key phrase) and no time range restriction
      const refined = `"${query}"`;
      const url2 = `${SEARXNG_URL}/search?q=${encodeURIComponent(refined)}&format=json&language=auto&safesearch=0`;
      const r2 = await fetch(url2, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
      if (r2.ok) {
        const data2 = await r2.json();
        const extra = (data2.results || []).slice(0, 15).map(item => ({
          title: item.title || "", url: item.url || "", content: (item.content || "").slice(0, 400),
        }));
        // Merge, dedup by URL
        const seen = new Set(results.map(r => r.url));
        for (const item of extra) {
          if (!seen.has(item.url) && results.length < 30) {
            seen.add(item.url);
            results.push(item);
          }
        }
      }
    } catch {}
  }

  return results;
}

// --- Memory tool handlers (GPT-style: AI decides when to save/recall) ---
// Returns result for memory_save/memory_search, or null for non-memory tools.
// userId must be a real PB user ID — no fallback to project name or "api".
async function handleMemoryTool(toolName, toolInput, userId) {
  if (toolName !== "memory_search" && toolName !== "memory_save") return null;
  if (!userMemory) return { ok: false, error: "Memory service not available", duration: 0 };
  if (!userId) return { ok: false, error: "Memory requires user login", duration: 0 };
  const startTime = Date.now();
  try {
    if (toolName === "memory_search") {
      const query = toolInput.query || toolInput.text || "";
      const mode = toolInput.mode || "search";
      if (mode === "all") {
        const all = await userMemory._getAllMemories(userId, 100);
        const profile = await userMemory._getProfile(userId);
        const formatted = userMemory._formatContext(profile, userMemory._deduplicateMemories(all), { fullDump: true });
        return { ok: true, data: { memories: formatted || "No memories stored yet.", count: all.length }, duration: Date.now() - startTime };
      }
      const result = await userMemory.recall(userId, query, { limit: 15 });
      return { ok: true, data: { memories: result || "No relevant memories found.", query }, duration: Date.now() - startTime };
    }
    if (toolName === "memory_save") {
      const text = toolInput.text || "";
      if (!text) return { ok: false, error: "No text to save", duration: Date.now() - startTime };
      await userMemory._ensureCollection(userId);
      await userMemory._storeFact(userId, {
        category: toolInput.category || "fact",
        text: text.slice(0, 500),
        entity_type: toolInput.entity_type || null,
        entity_id: toolInput.entity_id || null,
        importance: Math.min(5, Math.max(1, Number(toolInput.importance) || 3)),
      }, { sessionId: toolInput._session_id || "" });
      return { ok: true, data: { saved: true, text }, duration: Date.now() - startTime };
    }
  } catch (err) {
    return { ok: false, error: err.message, duration: Date.now() - startTime };
  }
  return null;
}

function formatSearchContext(results) {
  if (!results.length) return "";
  // Pass all results — model decides relevance (like GPT/Claude approach)
  return "[Web Search Results — Reference Material]\n" + results.map((r, i) =>
    `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content}`
  ).join("\n\n");
}

// --- Native function calling support ---
// Providers that support structured tool/function calling in their API
const NATIVE_TOOL_PROVIDERS = new Set(['openai', 'deepseek', 'anthropic', 'gemini']);

/**
 * Convert unified tool schemas to provider-specific format.
 * @param {string} providerName
 * @param {object[]} schemas - Array of { name, description, input_schema }
 * @returns {object|undefined} Provider-formatted tools param, or undefined
 */
function formatNativeTools(providerName, schemas) {
  if (!schemas || !schemas.length) return undefined;
  if (providerName === 'anthropic') {
    // Anthropic: tools: [{ name, description, input_schema }]
    return schemas.map(s => ({
      name: s.name,
      description: s.description,
      input_schema: s.input_schema,
    }));
  }
  // OpenAI / DeepSeek / Gemini (via OpenAI-compat endpoint):
  // tools: [{ type: "function", function: { name, description, parameters } }]
  return schemas.map(s => ({
    type: 'function',
    function: {
      name: s.name,
      description: s.description,
      parameters: s.input_schema,
    }
  }));
}

/**
 * Map slash-command specialist_mode IDs to actual registered tool names.
 * When user selects /audit jet, specialist_mode = "audit_jet" → we must include
 * the corresponding tool "journal_entry_testing" in the native tool list.
 */
const SPECIALIST_MODE_TO_TOOLS = {
  audit_jet:            ["journal_entry_testing"],
  audit_mus:            ["audit_sampling"],
  audit_benford:        ["benford_analysis"],
  audit_materiality:    ["materiality_calculator"],
  audit_reconciliation: ["reconciliation"],
  audit_going_concern:  ["going_concern_check"],
  audit_gl_extract:     ["gl_extract"],
  audit_data_clean:     ["data_cleaning"],
  audit_ppe:            ["variance_analysis"],  // PPE rollforward uses variance analysis
  audit_far:            ["financial_analytics_review"],
};

// All audit tool names (used to include the full set when any audit specialist is active)
const ALL_AUDIT_TOOL_NAMES = new Set([
  "audit_sampling", "benford_analysis", "journal_entry_testing",
  "variance_analysis", "materiality_calculator", "reconciliation",
  "going_concern_check", "gl_extract", "data_cleaning",
  "audit_workpaper_fill", "financial_analytics_review",
]);

/**
 * Select relevant tools based on user message content and specialist mode.
 * Avoids sending all 22+ tool schemas every request (saves tokens).
 * @param {string} userMessage
 * @param {object[]} allSchemas
 * @param {string} [specialistMode] - specialist_mode from slash command (e.g. "audit_jet")
 * @returns {object[]}
 */
function selectRelevantTools(userMessage, allSchemas, specialistMode) {
  if (!allSchemas || !allSchemas.length) return [];
  const msg = String(userMessage || "").toLowerCase();
  const sMode = String(specialistMode || "").toLowerCase();

  // Core tools: always include (deep_search and hkex_download NOT here — only via explicit /slash command)
  const alwaysInclude = new Set([
    'web_search', 'generate_spreadsheet', 'generate_document',
    'generate_presentation', 'code_run', 'parse_file', 'use_template',
    'fill_template', 'memory_search', 'memory_save',
  ]);

  // If specialist mode is an audit tool, always include all audit tools
  const isAuditSpecialist = sMode.startsWith("audit_") || ALL_AUDIT_TOOL_NAMES.has(sMode);

  // Audit tools: include if specialist mode is audit OR message mentions audit/financial keywords
  const auditKeywords = /audit|sampling|journal|entry|entries|benford|material|reconcil|going.?concern|gl\b|general\s*ledger|抽样|分录|审计|对账|重大性|持续经营/i;
  const includeAudit = isAuditSpecialist || auditKeywords.test(msg);

  // Financial analysis
  const financeKeywords = /financial.?statement|tie.?out|balance.?sheet|income.?statement|cash.?flow|variance|财务报表|资产负债|利润表|现金流/i;
  const includeFinance = financeKeywords.test(msg);

  // HKEX
  const hkexKeywords = /hkex|stock.?exchange|公告|年报|annual\s*report|filing|披露/i;
  const includeHkex = hkexKeywords.test(msg);

  // Vision/audio
  const mediaKeywords = /image|picture|photo|vision|看图|图片|截图|audio|transcribe|录音|语音|voice/i;
  const includeMedia = mediaKeywords.test(msg);

  // Browser
  const browserKeywords = /browse|browser|screenshot|网页|打开|open\s+url|scrape|crawl/i;
  const includeBrowser = browserKeywords.test(msg);

  return allSchemas.filter(s => {
    if (alwaysInclude.has(s.name)) return true;
    if (includeAudit && ALL_AUDIT_TOOL_NAMES.has(s.name)) return true;
    if (includeFinance && s.name === 'financial_statement_analyze') return true;
    if (includeHkex && s.name === 'hkex_download') return true;
    if (includeMedia && /^(vision_analyze|transcribe_audio)$/.test(s.name)) return true;
    if (includeBrowser && s.name === 'browser_action') return true;
    return false;
  });
}

// --- Provider URL/headers/body builders ---
function getChatUrl(providerName, provider) {
  const base = provider.baseUrl;
  if (providerName === "anthropic") return `${base}/v1/messages`;
  if (providerName === "gemini") return `${base}/v1beta/openai/chat/completions`;
  if (providerName === "doubao") return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function getChatHeaders(providerName, apiKey) {
  if (providerName === "anthropic") {
    return { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

// Default max output tokens per provider — models that support higher limits get more room
// This prevents long-form generation (file creation, DCF analysis, etc.) from cutting off mid-output
// No max_tokens limit — let each provider use its own maximum
// Only Anthropic requires max_tokens (API mandate)
function getMaxTokens(providerName, model) {
  // Anthropic API requires max_tokens field; use model maximum
  if (providerName === "anthropic") {
    if (/opus/.test(model)) return 32768;
    if (/sonnet-4-6/.test(model)) return 16384;
    if (/sonnet/.test(model)) return 8192;
    return 8192; // haiku etc
  }
  return undefined; // omit → provider uses its own max
}

function buildChatBody(providerName, model, messages, systemPrompt, stream, nativeTools) {
  const maxTok = getMaxTokens(providerName, model);
  if (providerName === "anthropic") {
    const sysMessages = messages.filter(m => m.role === "system");
    const nonSysMessages = messages.filter(m => m.role !== "system");
    let system = sysMessages.map(m => m.content).join("\n\n");
    if (systemPrompt) system = system ? systemPrompt + "\n\n" + system : systemPrompt;
    const body = {
      model, max_tokens: maxTok, stream,
      system: system || undefined,
      messages: nonSysMessages.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    };
    if (nativeTools) body.tools = nativeTools;
    return body;
  }
  // OpenAI-compatible providers
  // User's system prompt has highest priority — put server prompts BEFORE it
  const msgs = [...messages];
  if (systemPrompt) {
    const sysMsg = msgs.find(m => m.role === "system");
    if (sysMsg) sysMsg.content = systemPrompt + "\n\n" + (sysMsg.content || "");
    else msgs.unshift({ role: "system", content: systemPrompt });
  }
  const body = { model, max_tokens: maxTok, stream, messages: msgs, stream_options: stream ? { include_usage: true } : undefined };
  if (nativeTools) body.tools = nativeTools;
  return body;
}

function stripInternalChatFields(body) {
  if (!body || typeof body !== "object") return body;
  const next = { ...body };
  delete next.encrypted_payload_text;
  delete next.session_id;
  delete next.user_message_id;
  delete next.lang;
  return next;
}

// Tool tag markers for the clean SSE pipe
const TOOL_TAG_MARKERS = [
  "[TOOL:", "<｜DSML｜function_calls>", "<︱DSML︱function_calls>",
  "<|DSML|function_calls>", "<minimax:tool_call>", "<tool_call>",
];

router.post("/", apiLimiter, express.json({ limit: process.env.LC_CHAT_BODY_LIMIT || "256mb" }), async (req, res) => {
  const { provider: providerName, model: modelId, messages, stream: wantStream = true } = req.body || {};
  if (!providerName || !modelId || !Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "Missing required fields: provider, model, messages (array)" });
  }
  const provider = PROVIDERS[providerName?.toLowerCase()];
  if (!provider) return res.status(400).json({ error: "Unknown or unsupported provider" });

  // i18n for tool_status messages — follows client lang param or Accept-Language
  const lang = req.body.lang || (req.headers["accept-language"]?.startsWith("zh") ? "zh" : "en");
  const L = lang === "zh"
    ? { searching: q => `正在搜索: ${q}`, searchDone: n => `搜索完成，找到 ${n} 条结果`, fetchingUrl: u => `正在抓取链接: ${u}`, fetchDone: n => `链接抓取完成，共 ${n} 个`, processing: "正在处理...", genExcel: t => `正在生成 Excel: ${t}`, genDoc: t => `正在生成文档: ${t}`, genPPT: t => `正在生成 PPT: ${t}`, toolDone: (n, s) => `${n} 已生成 (${s})`, toolLabel: n => ({ web_search:"搜索", search:"搜索", generate_spreadsheet:"生成 Excel", generate_document:"生成文档", generate_presentation:"生成 PPT", use_template:"使用模板" }[n] || n.replace(/_/g," ")) }
    : { searching: q => `Searching: ${q}`, searchDone: n => `Found ${n} results`, fetchingUrl: u => `Fetching URL: ${u}`, fetchDone: n => `URL fetch done (${n})`, processing: "Processing...", genExcel: t => `Generating Excel: ${t}`, genDoc: t => `Generating document: ${t}`, genPPT: t => `Generating PPT: ${t}`, toolDone: (n, s) => `${n} generated (${s})`, toolLabel: n => ({ web_search:"Search", search:"Search", generate_spreadsheet:"Generate Excel", generate_document:"Generate document", generate_presentation:"Generate PPT", use_template:"Use template" }[n] || n.replace(/_/g," ")) };
  let requestAttachmentContexts = normalizeAttachmentContextItems(req.body?.attachment_contexts);
  let userQueryText = String(req.body?.user_query_text || "").trim();
  const specialistMode = String(req.body?.specialist_mode || "").trim().toLowerCase();
  const specialistCategory = String(req.body?.specialist_category || "").trim().toLowerCase();
  const isDeepSearch = req.body?.deep_search === true;
  const isHkexDownload = req.body?.hkex_download === true;
  if (!userQueryText) {
    const lastUser = [...messages].reverse().find((m) => m?.role === "user");
    userQueryText = stripAttachmentContextBlocks(extractMessagePlainText(lastUser?.content));
  }

  // ── Auth: user auth cookie → admin session → project key/HMAC/token ──
  let projectName, authUserId;
  const projectKey = req.headers["x-project-key"] || (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const lcCookies = parseCookies(req);
  const authToken = lcCookies.auth_token;
  const authPayload = authToken ? validateAuthToken(authToken) : null;
  if (authPayload?.id) authUserId = authPayload.id;

  // Optional encrypted upload bundle from LumiChat extension.
  if (typeof req.body?.encrypted_payload_text === "string" && req.body.encrypted_payload_text.trim()) {
    try {
      const parsed = lcDecryptEncryptedPayload(req.body.encrypted_payload_text.trim());
      const files = Array.isArray(parsed?.files) ? parsed.files : [];
      const chunks = [];
      const currentQueryText = userQueryText || (() => {
        const lastUser = [...messages].reverse().find((m) => m?.role === "user");
        return extractMessagePlainText(lastUser?.content);
      })();
      const fileLabels = [];
      const uploadedFileIds = [];
      let totalBytes = 0;
      const lcSessionId = validPbId(req.body?.session_id) ? req.body.session_id : null;
      const lcUserMessageId = validPbId(req.body?.user_message_id) ? req.body.user_message_id : null;
      for (const item of files) {
        const name = lcUploadSafeName(item?.name || "file");
        const mime = detectLcUploadMime(name, item?.mime || "application/octet-stream");
        const data = lcB64urlToBuffer(item?.data_b64 || "");
        fileLabels.push(name);
        totalBytes += data.length;
        if (!data.length) continue;
        if (totalBytes > LC_ENCRYPTED_UPLOAD_LIMIT_BYTES) {
          return res.status(413).json({ error: "Encrypted upload too large" });
        }
        const extracted = await extractTextForLcBuffer(data, name, mime);
        let text = String(extracted?.text || "").trim();
        if (!text && String(mime || "").startsWith("image/")) {
          // Encrypted image bundles do not carry image_url parts; produce textual visual context server-side.
          text = await describeImageBufferForModel(data, {
            prompt: "Describe this image in detail, extract visible text exactly when possible, and summarize entities, numbers, and layout.",
          });
        }
        if (authToken && authUserId && lcSessionId) {
          try {
            await assertLcSessionOwned(lcSessionId, { ownerId: authUserId, token: authToken });
            const saved = await uploadLcBufferRecord({
              buffer: data,
              originalName: name,
              mimeType: mime,
              sessionId: lcSessionId,
              userId: authUserId,
              token: authToken,
            });
            if (saved?.id) uploadedFileIds.push(saved.id);
          } catch (uploadErr) {
            log("warn", "Encrypted upload PB save failed", { file: name, error: uploadErr.message, traceId: req.traceId });
          }
        }
        if (!text) continue;
        const excerpt = buildRelevantAttachmentExcerpt(text, currentQueryText, LC_MODEL_ATTACHMENT_FULL_CHARS);
        if (excerpt) {
          chunks.push({
            name,
            kind: lcFileKindByMimeOrExt(mime, name),
            mime,
            note: "parsed attachment text",
            source: "encrypted_upload",
            text: excerpt,
          });
        }
      }
      if (uploadedFileIds.length && authToken && lcUserMessageId) {
        try {
          await assertRecordOwned("messages", { id: lcUserMessageId, ownerId: authUserId, token: authToken });
          const existingMsgResp = await lcPbFetch(`/api/collections/lc_messages/records/${lcUserMessageId}`, {
            headers: { Authorization: `Bearer ${authToken}` },
          });
          const existingMsg = existingMsgResp.ok ? await existingMsgResp.json() : null;
          const nextFileIds = mergeArraysUnique(existingMsg?.file_ids, uploadedFileIds);
          const patchBody = { file_ids: nextFileIds };
          if (lcSupportsField("messages", "updated_at")) patchBody.updated_at = lcNowIso();
          await lcPbFetch(`/api/collections/lc_messages/records/${lcUserMessageId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
            body: JSON.stringify(patchBody),
          });
        } catch (patchErr) {
          log("warn", "Encrypted upload message patch failed", { messageId: lcUserMessageId, error: patchErr.message, traceId: req.traceId });
        }
      }
      if (chunks.length) requestAttachmentContexts = requestAttachmentContexts.concat(chunks);
      req._hasEncryptedAttachment = files.length > 0;
      req._encryptedAttachmentFileNames = fileLabels;
      log("info", "Encrypted payload processed", { files: files.length, extractedChunks: chunks.length, storedFiles: uploadedFileIds.length, traceId: req.traceId });
    } catch (err) {
      const status = Number(err?.status) || 400;
      return res.status(status).json({ error: err?.message || "Encrypted payload processing failed" });
    }
  }

  if (safeEqual(projectKey, INTERNAL_CHAT_KEY)) {
    projectName = "_chat";
  } else if (["root", "admin"].includes(getSessionRole(req))) {
    projectName = "_chat";
  } else if (!projectKey && authToken) {
    if (authPayload) {
      // Allow embedded apps (e.g. LumiTrade) to track usage under their own project
      const appSource = (req.headers["x-app-source"] || "").trim().toLowerCase();
      const APP_SOURCE_PROJECTS = { lumitrade: "_lumitrade" };
      projectName = APP_SOURCE_PROJECTS[appSource] || "_lumichat";
      if (authPayload.id) authUserId = authPayload.id;
    }
  }
  if (!projectName) {
    if (projectKey.startsWith("et_")) {
      const tokenInfo = ephemeralTokens.get(projectKey);
      if (!tokenInfo || Date.now() > tokenInfo.expiresAt) return res.status(401).json({ error: "Token expired or invalid" });
      if (!tokenInfo.project.enabled) return res.status(403).json({ error: "Project disabled" });
      projectName = tokenInfo.project.name;
    } else if (req.headers["x-signature"]) {
      const projId = req.headers["x-project-id"];
      if (projId) {
        const candidate = projects.find(p => p.enabled && p.name === projId && p.authMode === "hmac");
        if (candidate) {
          const hmacResult = verifyHmacSignature(candidate, req);
          if (!hmacResult.ok) return res.status(401).json({ error: hmacResult.error });
          projectName = candidate.name;
        }
      }
      if (!projectName) return res.status(401).json({ error: "HMAC verification failed" });
    } else {
      const proj = ((k) => { const _p = projectKeyIndex.get(k); return _p && _p.enabled ? _p : undefined; })(projectKey);
      if (!proj) return res.status(401).json({ error: "Invalid or missing credentials" });
      if (proj.authMode === "hmac") return res.status(403).json({ error: "This project requires HMAC signature authentication" });
      projectName = proj.name;
    }
  }

  // Resolve project object for policy checks
  const proj = projects.find(p => p.name === projectName) || {};

  // Per-project model allowlist (data may use either field name)
  const modelAllowlist = proj.allowedModels || proj.modelAllowlist;
  if (modelAllowlist?.length && !modelAllowlist.includes(modelId)) {
    return res.status(403).json({ error: "Model not allowed for this project" });
  }

  // Per-project rate limit
  if (proj.maxRpm) {
    const rl = checkProjectRateLimit(proj, req);
    if (!rl.ok) return res.status(429).json({ error: rl.reason === "ip" ? "Per-IP rate limit exceeded" : "Project rate limit exceeded" });
  }

  // Per-project budget enforcement
  if (typeof checkBudgetReset === "function") checkBudgetReset(proj);
  if (proj.maxBudgetUsd != null && (proj.budgetUsedUsd || 0) >= proj.maxBudgetUsd) {
    return res.status(429).json({ error: "Project budget exceeded" });
  }

  // Resolve API key — fallback to Collector if no key available
  const selectedKey = selectApiKey(providerName.toLowerCase(), projectName);
  const pnLower = providerName.toLowerCase();
  // When access mode is explicitly "collector" AND collector tokens exist, prefer Collector over API key
  const accessMode = typeof getProviderAccessMode === "function" ? getProviderAccessMode(pnLower) : "api_key";
  const collectorAvailable = COLLECTOR_SUPPORTED.includes(pnLower) && hasCollectorToken(pnLower);
  const useCollector = collectorAvailable && (accessMode === "collector" || !(selectedKey?.apiKey || provider.apiKey));
  const apiKey = useCollector ? null : (selectedKey?.apiKey || provider.apiKey);
  if (!apiKey && !useCollector) return res.status(403).json({ error: "No API key configured for this provider" });

  if (authToken && authUserId) {
    try {
      const queryTextForAttachments = (() => {
        if (userQueryText) return userQueryText;
        const lastUser = [...messages].reverse().find((m) => m?.role === "user");
        return stripAttachmentContextBlocks(extractMessagePlainText(lastUser?.content));
      })();
      const hasDirectUrlInQuery = extractDirectUrls(queryTextForAttachments).length > 0;
      const historicalFileIds = [...new Set(
        messages.flatMap((m) => Array.isArray(m?.file_ids) ? m.file_ids : []).filter(Boolean)
      )];
      // URL-first questions should not be polluted by previous attachments in the same session.
      if (!hasDirectUrlInQuery && historicalFileIds.length) {
        const items = await fetchLcAttachmentContextsByIds(historicalFileIds, {
          token: authToken,
          ownerId: authUserId,
          queryText: queryTextForAttachments,
        });
        if (items.length) {
          requestAttachmentContexts = requestAttachmentContexts.concat(items.map((item) => ({
            file_id: item.id,
            name: item.name,
            kind: item.kind,
            mime: item.mime,
            note: "historical attachment context",
            source: "history",
            text: item.context,
          })));
          req._hasHistoricalAttachmentContext = true;
        }
      }
    } catch (attachmentErr) {
      log("warn", "Historical attachment context inject failed", { error: attachmentErr.message, traceId: req.traceId });
    }
  }
  let specialistAnalysisResult = null;
  if (specialistMode === "financial_statement_analysis") {
    // Start SSE early so we can emit casting progress
    if (wantStream && !res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
    }
    if (wantStream) emitToolStatus({ text: lang === "zh" ? "正在分析财务报表..." : "Analyzing financial statements...", icon: "file" });
    specialistAnalysisResult = await runFinancialAnalysisForAttachments({
      query: userQueryText || "",
      attachments: requestAttachmentContexts,
      lang,
    });
    if (wantStream) emitToolStatus({ text: lang === "zh" ? "财务分析完成" : "Financial analysis complete", icon: "file", done: true });
    const llmVStats = specialistAnalysisResult?.llm_verification?.stats;
    log("info", "Financial specialist pre-analysis completed", {
      ok: !!specialistAnalysisResult?.ok,
      checks: Array.isArray(specialistAnalysisResult?.checks) ? specialistAnalysisResult.checks.length : 0,
      missing: Array.isArray(specialistAnalysisResult?.missing_fields) ? specialistAnalysisResult.missing_fields.length : 0,
      llm_verify: llmVStats ? { items: llmVStats.items_verified, rescued: llmVStats.pass_llm, still_fail: llmVStats.still_fail } : null,
      traceId: req.traceId,
    });
  }

  // ── Pre-search ──
  // Models with built-in web search don't need SearXNG
  // Only models with ACTUAL API-level search (not ChatGPT web browsing which is UI-only)
  // Only models with CONFIRMED working API-level search
  // Kimi removed: Collector mode doesn't trigger web search on Kimi's web UI
  const MODELS_WITH_SEARCH = new Set([
    // Gemini grounding REMOVED: Google Search grounding requires native Gemini API
    // (generateContent with tools:[{google_search:{}}]). It does NOT work through
    // the OpenAI-compatible endpoint (/v1beta/openai/chat/completions) that LumiGate uses.
    // So Gemini models need SearXNG like everyone else.
  ]);
  const modelHasSearch = MODELS_WITH_SEARCH.has(modelId);

  let searchContext = "";
  let urlFetchContext = "";
  let officialFallbackLinkLines = "";
  const chatSessionId = normalizeChatSessionId(req.body?.session_id);
  const urlFetchOwner = authUserId || projectName || "api";
  const rememberedUrlFetchContext = chatSessionId ? getUrlFetchMemoryContext(urlFetchOwner, chatSessionId) : "";
  const hasStoredAttachmentContext = !!req._hasHistoricalAttachmentContext || requestAttachmentContexts.length > 0 || messages.some((m) => contentHasAttachmentContext(m?.content));
  const hasRichUserInput = (() => {
    // Only treat CURRENT turn multimodal parts as rich input.
    // Historical attachment context should not suppress fresh web-search intents.
    if (req._hasEncryptedAttachment) return true;
    const last = messages.filter(m => m.role === "user").pop();
    if (!last || !Array.isArray(last.content)) return false;
    return last.content.some((p) => p && typeof p === "object" && p.type && p.type !== "text");
  })();
  const userText = userQueryText || (() => {
    const last = messages.filter(m => m.role === "user").pop();
    if (!last) return "";
    if (typeof last.content === "string") return last.content;
    if (Array.isArray(last.content)) return last.content.filter(p => p.type === "text").map(p => p.text).join(" ");
    return "";
  })();
  const userTextForUrlDetection = stripAttachmentContextBlocks(userText);
  const directUrlsRaw = extractDirectUrls(userTextForUrlDetection);
  // Guardrail: when request is attachment-centric, never auto-enter URL-fetch flow.
  // This prevents file content/context from accidentally triggering "fetch URL".
  const directUrls = hasRichUserInput ? [] : directUrlsRaw;
  if (hasRichUserInput && directUrlsRaw.length) {
    log("info", "Direct URL fetch suppressed for attachment-centric request", {
      urls: directUrlsRaw.slice(0, 3),
      traceId: req.traceId,
    });
  }
  const hasDirectUrl = directUrls.length > 0;
  const userIntentText = userTextForUrlDetection || userText;
  const chatIntent = classifyChatIntent(userIntentText, {
    hasDirectUrl,
    hasRichUserInput,
    hasStoredAttachmentContext,
  });
  const likelyAttachmentQuestion = (() => {
    if (hasRichUserInput || hasStoredAttachmentContext) return true;
    return /(上传|附件|文件|文档|表格|工作簿|sheet|spreadsheet|excel|csv|pdf|word|docx|ppt|pptx|image|图片|截图|录音|音频|transcript|file|document|attachment)/i.test(userIntentText);
  })();
  const strictEvidenceMode = hasDirectUrl || likelyAttachmentQuestion || hasRichUserInput || hasStoredAttachmentContext;
  const explicitSearchIntent = /搜[索一下]|查[找一下询]|帮我[找查搜]|search|look\s?up|find\s+me|web\s+search|browse|下载|下載|download|表格|表單|form|forms|报税|報稅|tax\s+form/i.test(userIntentText);
  const obviousWebNeed = needsWebSearch(userIntentText);
  const strictFreshnessNeed = needsStrictFreshness(userIntentText);
  const explicitNoExternalIntent = /仅根据|只根据|仅基于|只基于|仅用|只用|不要联网|不联网|不需要联网|不要搜索|不用搜索|无需搜索|不要外部数据|不要市场数据|仅看附件|只看附件|仅看图片|只看图片|only\s+based\s+on|based\s+only\s+on|no\s+web\s+search|without\s+search|do\s+not\s+search|do\s+not\s+use\s+web\s+search|offline\s+only|attachment\s+only|unless\s+the\s+file\s+is\s+insufficient|unless\s+the\s+attachment\s+is\s+insufficient/i.test(userIntentText);
  const encryptedAttachmentImplicitOnly = (req._hasEncryptedAttachment || hasStoredAttachmentContext) && !obviousWebNeed && req.body.web_search !== true;
  const attachmentOnlyInterpretation = hasRichUserInput && (explicitNoExternalIntent || encryptedAttachmentImplicitOnly);
  // Skip SearXNG if model has built-in search (unless explicitly forced via web_search:true)
  const autoSearchOn = settings.autoSearchEnabled !== false;
  const attachmentMode = getAttachmentSearchMode();
  let shouldAutoSearch;

  if (hasRichUserInput) {
    if (attachmentMode === "off") shouldAutoSearch = false;
    else if (attachmentOnlyInterpretation) shouldAutoSearch = false;
    else if (hasStoredAttachmentContext && req.body.web_search === undefined && !explicitSearchIntent) shouldAutoSearch = false;
    else shouldAutoSearch = strictFreshnessNeed || explicitSearchIntent; // attachment-first default: only search on explicit search or explicit freshness need
  } else {
    shouldAutoSearch = obviousWebNeed;
  }
  if ((specialistMode === "financial_statement_analysis" || SPECIALIST_MODE_TO_TOOLS[specialistMode]) && req.body.web_search !== true) {
    shouldAutoSearch = false;
  }
  if (isDeepSearch) {
    shouldAutoSearch = false; // deep_search tool does its own searching
    doSearch = false;
  }

  if (hasRichUserInput && attachmentMode === "assistant_decide" && req.body.web_search === undefined && !attachmentOnlyInterpretation && !shouldAutoSearch) {
    log("info", "Attachment search deferred to primary model/runtime", {
      provider: providerName,
      model: modelId,
      encryptedAttachment: !!req._hasEncryptedAttachment,
      obviousWebNeed,
      traceId: req.traceId,
    });
  }

  let doSearch = req.body.web_search === true || (!modelHasSearch && req.body.web_search !== false && autoSearchOn && shouldAutoSearch);
  const isOfficialDocLookup = (() => {
    const hasOfficialSignal = /(官方|官网|政府|监管|監管|公示|公告|official|government|regulator|regulatory|gov|authority|ministry|department|bureau)/i.test(userText);
    const hasDocSignal = /(文件|文档|文檔|表格|表單|指南|手册|手冊|规程|規程|政策|pdf|docx?|xlsx?|pptx?|下载|下載|link|url|where|how|form|forms|filing|application)/i.test(userText);
    const hasJurisdictionOrEntity = /(美国|美國|us\b|u\.s\.|california|加州|香港|hk\b|hksar|新加坡|singapore|英国|uk\b|欧盟|eu\b|irs|ftb|sec|sfc|hkex|公司|corporate|business|company)/i.test(userText);
    return (hasOfficialSignal && hasDocSignal) || (hasOfficialSignal && hasJurisdictionOrEntity && hasDocSignal);
  })();
  const isTaxFormDownloadIntent = (() => {
    const hasFormOrDownload = /(下载|下載|download|表格|表單|form|forms|pdf|docx?|xlsx?)/i.test(userText);
    const hasTaxSignal = /(报税|報稅|税务|稅務|tax|ird|inland revenue|franchise tax|irs|ftb)/i.test(userText);
    const hasRegionSignal = /(香港|hk\b|hksar|california|加州|us\b|u\.s\.|美国|美國|uk\b|英国|singapore|新加坡)/i.test(userText);
    return hasFormOrDownload && hasTaxSignal && hasRegionSignal;
  })();
  const forceOfficialSearch = !hasDirectUrl && req.body.web_search !== false && !explicitNoExternalIntent
    && (chatIntent.officialFormLookup || isOfficialDocLookup || isTaxFormDownloadIntent);
  if (forceOfficialSearch) {
    doSearch = true;
  }
  log("info", "Chat intent classified", {
    intent: chatIntent.kind,
    subtype: chatIntent.subtype,
    forceOfficialSearch,
    hasDirectUrl,
    hasRichUserInput,
    hasStoredAttachmentContext,
    traceId: req.traceId,
  });
  if (hasDirectUrl && req.body.web_search !== true) {
    // URL-first: when the user gave a concrete link, fetch that link directly first.
    doSearch = false;
  }
  if (hasRichUserInput && attachmentOnlyInterpretation) {
    log("info", "Auto-search skipped for attachment-only interpretation", { provider: providerName, model: modelId, traceId: req.traceId });
  } else if (hasRichUserInput && doSearch) {
    log("info", "Auto-search enabled for attachment task", { provider: providerName, model: modelId, traceId: req.traceId });
  }
  // emitToolStatus — available throughout the handler for pre-search + streaming phases
  let emitToolStatus = function(p) { if (!wantStream || res.writableEnded) return; res.write("event: tool_status\ndata: " + JSON.stringify(p) + "\n\n"); res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "" }, tool_status: p }] }) + "\n\n"); };

  if (hasDirectUrl) {
    // Start SSE early so frontend sees url fetch status
    if (wantStream && !res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
    }
    try {
      const fetched = [];
      for (let i = 0; i < directUrls.length; i++) {
        const u = directUrls[i];
        if (wantStream) emitToolStatus({ text: L.fetchingUrl(u), icon: "file" });
        try {
          const parsed = await lumigentRuntime.executeToolCall("parse_file", {
            file_url: u,
            filename: inferFilenameFromUrl(u, i + 1),
          });
          const text = String(parsed?.data?.text || "").trim();
          if (parsed?.ok && text) fetched.push({ url: u, filename: inferFilenameFromUrl(u, i + 1), text: text.slice(0, 50000) });
        } catch (e) {
          log("warn", "Direct URL fetch failed", { url: u, error: e.message, traceId: req.traceId });
        }
      }
      urlFetchContext = formatUrlFetchContext(fetched);
      if (chatSessionId && fetched.length) {
        rememberUrlFetchContexts(urlFetchOwner, chatSessionId, fetched);
      }
      if (wantStream) emitToolStatus({ text: L.fetchDone(fetched.length), icon: "file", done: true });
    } catch (e) {
      log("warn", "Direct URL fetch flow failed", { error: e.message, traceId: req.traceId });
    }
  }

  if (doSearch) {
    // Start SSE early so frontend sees search status
    if (wantStream && !res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
    }
    try {
      // Generate 2-3 search keywords via cheap AI (fast, <2s)
      let queries = [extractSearchQuery(userText)];
      try {
        // Preferred provider/model from settings, then fallback chain.
        const ALL_KW = [
          { p: "minimax", m: "MiniMax-M1" }, { p: "deepseek", m: "deepseek-chat" },
          { p: "openai", m: "gpt-4.1-nano" }, { p: "gemini", m: "gemini-2.5-flash" },
          { p: "qwen", m: "qwen-turbo" },
        ];
        const prefP = settings.searchKeywordProvider || "minimax";
        const prefM = settings.searchKeywordModel || "MiniMax-M1";
        const KW_MODELS = [{ p: prefP, m: prefM }, ...ALL_KW.filter(x => x.p !== prefP || x.m !== prefM)];
        const todayStr = new Date().toISOString().slice(0, 10);
        const kwPrompt = strictFreshnessNeed
          ? `Today is ${todayStr}. Generate 2-3 short search engine queries to find the most relevant and up-to-date information for this question. Include the current year (${new Date().getFullYear()}) or specific date range in at least one query to ensure fresh results. Output ONLY a JSON array of strings, nothing else.\n\nQuestion: ${userText.slice(0, 300)}`
          : `Generate 2-3 short search engine queries to find authoritative and accurate information for this question. Prefer official/primary sources over secondary summaries. Output ONLY a JSON array of strings, nothing else.\n\nQuestion: ${userText.slice(0, 300)}`;
        let kwText = "";
        for (const c of KW_MODELS) {
          if (kwText) break;
          const prov = PROVIDERS[c.p]; if (!prov) continue;
          const k = (selectApiKey(c.p, "_lumichat") || {}).apiKey || prov.apiKey;
          if (k) {
            // API path
            try {
              const kRes = await fetch(getChatUrl(c.p, prov), {
                method: "POST", headers: getChatHeaders(c.p, k), signal: AbortSignal.timeout(5000),
                body: JSON.stringify({ model: c.m, max_tokens: 100, temperature: 0.3, stream: false, messages: [{ role: "user", content: kwPrompt }] }),
              });
              if (kRes.ok) { const d = await kRes.json(); kwText = d.choices?.[0]?.message?.content || ""; }
            } catch {}
          } else if (COLLECTOR_SUPPORTED.includes(c.p) && hasCollectorToken(c.p)) {
            // Collector path (free)
            try {
              const collector = _collector();
              if (!collector) throw new Error("Collector unavailable");
              const creds = getCollectorCredentials(c.p);
              let full = "";
              for await (const chunk of collector.sendMessage(c.p, c.m, [{ role: "user", content: kwPrompt }], creds)) {
                const m = chunk.match(/^data: (.+)$/m);
                if (m && m[1] !== "[DONE]") { try { const j = JSON.parse(m[1]); full += j.choices?.[0]?.delta?.content || ""; } catch {} }
              }
              if (full) kwText = full;
            } catch {}
          }
        }
        if (kwText) {
          const kMatch = kwText.match(/\[[\s\S]*\]/);
          if (kMatch) {
            const parsed = JSON.parse(kMatch[0]).filter(q => typeof q === "string" && q.trim()).slice(0, 3);
            if (parsed.length >= 2) queries = parsed;
          }
        }
      } catch {} // keyword generation failed — use original query

      // Search each keyword, send tool_status animation for each
      let allResults = [];
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i].trim();
        if (!q) continue;
        if (wantStream) emitToolStatus({ text: L.searching(q), icon: "search" });
        try {
          const results = await executeWebSearchForChat(q, "month");
          allResults.push(...results);
        } catch {}
      }
      // Fallback: if time-limited search returned too few results, retry without time range
      if (allResults.length < 3) {
        for (const q of queries) {
          if (!q.trim()) continue;
          try {
            const results = await executeWebSearchForChat(q.trim(), "");
            allResults.push(...results);
          } catch {}
        }
      }
      // Official-document fallback: force one round of official-intent queries.
      if (isOfficialDocLookup && allResults.length < 3) {
        const officialQueries = /(加州|california)/i.test(userText)
          ? [
              "California Franchise Tax Board official forms and publications",
              "site:ftb.ca.gov business tax forms",
              "California corporate tax return form 100 official",
            ]
          : [
              `${extractSearchQuery(userText)} official site`,
              `site:.gov ${extractSearchQuery(userText)}`,
              `${extractSearchQuery(userText)} pdf official`,
            ];
        for (const oq of officialQueries) {
          try {
            const results = await executeWebSearchForChat(oq, "");
            allResults.push(...results);
          } catch {}
        }
      }
      // Deduplicate by URL
      const seen = new Set();
      allResults = allResults.filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; }).slice(0, 30);
      // Hard fallback for official tax-form lookup when upstream search is empty.
      if ((chatIntent.officialFormLookup || isTaxFormDownloadIntent) && allResults.length === 0) {
        allResults = getOfficialFormFallbackResults(userText);
      }
      searchContext = formatSearchContext(allResults);
      if ((chatIntent.officialFormLookup || isOfficialDocLookup || isTaxFormDownloadIntent) && allResults.length) {
        officialFallbackLinkLines = buildRequiredLinkLines(allResults, lang);
      }
      if (isOfficialDocLookup && /(加州|california)/i.test(userText)) {
        const officialShortcut = [
          "Official source shortcuts:",
          "- California Franchise Tax Board (FTB) forms: https://www.ftb.ca.gov/forms/",
          "- California FTB homepage: https://www.ftb.ca.gov/",
        ].join("\n");
        searchContext = [searchContext, officialShortcut].filter(Boolean).join("\n\n");
      }
      if (wantStream) emitToolStatus({ text: L.searchDone(allResults.length), icon: "search", done: true });
    } catch (e) {
      log("warn", "Pre-search failed", { error: e.message });
    }
  }

  // ── Sanitize ALL messages: strip tool markers to prevent injection ──
  // Attack vectors: direct tags, orphan open tags, HTML-encoded tags, system role injection.
  // Clean all roles except the tool prompt we inject ourselves.
  function stripToolMarkers(text) {
    if (typeof text !== "string") return text;
    // Decode HTML entities first: &#91; → [  &#93; → ]  &#123; → {  &#125; → }
    let s = text.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
               .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCharCode(parseInt(c, 16)));
    // Complete tag pairs: [TOOL:xxx]...[/TOOL]
    s = s.replace(/\[TOOL:\w+\][\s\S]*?\[\/TOOL\]/g, "");
    // Orphan open tags (no closing tag): [TOOL:xxx]... to end
    s = s.replace(/\[TOOL:\w+\][^[]*$/g, "");
    // Orphan open tags mid-text: [TOOL:xxx]{...} without [/TOOL]
    s = s.replace(/\[TOOL:\w+\]\s*\{[^}]*\}/g, "");
    // Any remaining [TOOL:...] pattern
    s = s.replace(/\[TOOL:\w+\]/g, "");
    // DSML pairs and orphans
    s = s.replace(/<(?:｜DSML｜|︱DSML︱|\|DSML\|)function_calls>[\s\S]*?<\/(?:｜DSML｜|︱DSML︱|\|DSML\|)function_calls>/g, "");
    s = s.replace(/<(?:｜DSML｜|︱DSML︱|\|DSML\|)\w+[^>]*>/g, "");
    // XML tool_call pairs and orphans
    s = s.replace(/<(?:minimax:)?tool_call>[\s\S]*?<\/(?:minimax:)?tool_call>/g, "");
    s = s.replace(/<(?:minimax:)?tool_call>/g, "");
    return s;
  }
  for (const m of messages) {
    if (typeof m.content === "string") {
      m.content = stripToolMarkers(m.content);
    }
  }

  // ── Long-term user memory recall (before system prompt) ──
  let memoryContext = "";
  if (userMemory && authUserId && userQueryText) {
    try {
      memoryContext = await userMemory.recall(authUserId, userQueryText, { limit: 8 });
    } catch (memErr) {
      log("warn", "User memory recall failed (non-blocking)", { userId: authUserId, error: memErr.message });
    }
  }

  // ── Build system prompt: search context + tool prompt ──
  let injectedSystemPrompt = "";
  if (memoryContext) {
    injectedSystemPrompt += memoryContext + "\n";
  }
  injectedSystemPrompt += "Output policy: provide the final answer directly. Do not expose chain-of-thought, hidden reasoning, or step-by-step internal deliberation. Keep explanations brief and result-focused unless the user explicitly asks for detailed steps.\n\n";
  const finalUrlFetchContext = [urlFetchContext, rememberedUrlFetchContext].filter(Boolean).join("\n\n");
  if (finalUrlFetchContext) {
    injectedSystemPrompt += `${finalUrlFetchContext}\n\nDirect URL rule: if the user provided specific URL(s), prioritize these fetched URL contents as the primary evidence. Do not replace them with generic web search summaries. If fetched URL content is empty or insufficient, state that explicitly and ask for another link.\n\n`;
  }
  if (searchContext) {
    const dateGuard = isOfficialDocLookup
      ? `IMPORTANT: For official forms/filings/regulatory pages, prioritize official government sources (e.g., .gov and recognized tax authority domains) even if the page is not year-stamped. Do not reject authoritative evergreen form pages just because they are not labeled with the current year.`
      : (strictFreshnessNeed
          ? `IMPORTANT: This is a freshness-sensitive query. Prioritize the most recent search results. When answering current/latest events, ONLY cite results from ${new Date().getFullYear()} unless the user explicitly asks for historical information.`
          : `IMPORTANT: This is not inherently freshness-sensitive. Prioritize authoritative primary sources and factual correctness. Do not force current-year filtering unless the user explicitly asks for latest/current information.`);
    injectedSystemPrompt += `Today is ${new Date().toISOString().slice(0, 10)}. The current year is ${new Date().getFullYear()}.\n${searchContext}\n\n${dateGuard}\n\nSearch result usage rules:\n1. SYNTHESIZE the search results into a coherent, well-structured answer. Do NOT list or dump raw search results. The user wants an answer, not a reading list.\n2. Combine information from multiple sources to give a comprehensive response. Resolve contradictions by favoring more authoritative or recent sources.\n3. Cite sources inline with URLs where relevant (e.g., "according to [Source](url)"), but the answer must be self-contained — readable without clicking any link.\n4. If the search results are all outdated or irrelevant, explicitly state that no recent information was found rather than presenting old results as current.\n\n`;
    injectedSystemPrompt += "If search context contains relevant sources for forms/downloads, provide direct clickable URLs first. Do not claim missing attachments in this case.\n\n";
  }
  const suppressAttachmentGrounding = forceOfficialSearch && !hasDirectUrl && !hasRichUserInput;
  if ((hasRichUserInput || hasStoredAttachmentContext) && !suppressAttachmentGrounding) {
    injectedSystemPrompt += "=== CORE PRINCIPLES ===\n";
    injectedSystemPrompt += "Principle 1 — Evidence First: When attachments are present, answer from their content. If data is missing, say so clearly. Before claiming data is absent, enumerate at least one matched section/table heading and the key numbers you found. Do not invent, infer from training data, or substitute general knowledge for missing file facts.\n\n";
    injectedSystemPrompt += "Principle 2 — Computational Verification: For financial data, proactively perform arithmetic checks (totals, cross-checks, balance sheet equation). Show formulas and results. Prefer explicit formulas using matched table numbers and state whether they tie.\n\n";
    injectedSystemPrompt += "Principle 3 — Multilingual Tolerance: Treat Chinese/English/Traditional/Simplified, full names/abbreviations as equivalent. For example: Note 6 = 附注6 = 附註6 = 六.; Balance Sheet = Statement of Financial Position = 綜合財務狀況表 = 资产负债表; Revenue = Turnover = 营业收入 = 營業額. Infer intended terms from minor keyboard slips or obvious misspellings; only ask for clarification when ambiguity remains high.\n\n";
    injectedSystemPrompt += "Principle 4 — Honest Uncertainty: When data is insufficient, state what is missing. Do not guess or fabricate, but do not refuse to try over minor gaps.\n\n";
  }
  if (likelyAttachmentQuestion && !suppressAttachmentGrounding) {
    injectedSystemPrompt += "Supplementary — file questions: only answer with facts actually present in the available attachment context. If the context is missing or does not contain the requested fact, say that clearly.\n\n";
  }
  if (strictEvidenceMode && !suppressAttachmentGrounding) {
    injectedSystemPrompt += "Supplementary — strict evidence: do not mix in facts from other sessions/files. Use only the current provided evidence context. If insufficient, state directly what is missing. Never mention retrieval process phrases like '根据您提供的URL' / 'I accessed the URL'. Start directly with the answer.\n\n";
  }
  if (specialistMode === "financial_statement_analysis") {
    injectedSystemPrompt += `Specialist mode: Financial Statement Analysis (${specialistCategory || "finance"}). Act as a financial reporting checker.\n\n`;
    injectedSystemPrompt += "Always attempt deterministic tie-out checks with explicit arithmetic when data is available, including but not limited to: (1) balance-sheet line items vs note breakdowns, (2) current + non-current splits vs maturity buckets, (3) rollforward opening + additions - reductions - expenses = closing, (4) bridge checks such as revenue-COGS=gross profit and opening cash + CFO + CFI + CFF = closing cash.\n\n";
    injectedSystemPrompt += "Output format requirement: for each check, provide `check`, `formula`, `reported`, `computed`, `difference`, `status(tie/not_tie)`.\n\n";
    injectedSystemPrompt += "If a requested check cannot be completed from current evidence, explicitly list missing fields and do not guess.\n\n";
    const precomputedBlock = buildFinancialAnalysisPromptBlock(specialistAnalysisResult || {});
    if (precomputedBlock) {
      injectedSystemPrompt += `${precomputedBlock}\n\nUse Financial Analysis JSON as deterministic ground truth for tie/not_tie status. You may explain it naturally, but do not contradict computed checks.\n`;
      injectedSystemPrompt += "Status meanings: 'pass'/'tie' = program verified correct. 'pass_llm' = program flagged mismatch but LLM verification confirmed it is actually correct (e.g. missing child item found) — treat as correct but note lower confidence. 'fail'/'not_tie' = both program and LLM confirm mismatch — this is a real discrepancy.\n\n";
    }
  }
  // ── Audit specialist mode: slash commands like /audit jet, /audit mus, etc. ──
  // These work as normal AI tool calls — the AI sees the tool in its system prompt
  // and decides to call it. No server-side pre-computation needed (unlike financial_statement_analysis).
  if (specialistMode && SPECIALIST_MODE_TO_TOOLS[specialistMode]) {
    const primaryToolNames = SPECIALIST_MODE_TO_TOOLS[specialistMode];
    const toolDescriptions = {
      audit_jet: "Journal Entry Testing (JET) — run 15 standard tests on general ledger data",
      audit_mus: "Monetary Unit Sampling (MUS/AICPA) — statistical audit sampling",
      audit_benford: "Benford's Analysis — first-digit distribution fraud detection",
      audit_materiality: "Materiality Calculator — ISA 320 materiality levels",
      audit_reconciliation: "Reconciliation — auto-reconcile two datasets",
      audit_going_concern: "Going Concern Check — ISA 570 going concern indicators",
      audit_gl_extract: "GL Extract — extract sub-ledger by account code",
      audit_data_clean: "Data Cleaning — clean and normalize financial data",
      audit_ppe: "PPE Rollforward — fixed asset movement schedule + depreciation rates",
      audit_far: "Financial Analytics Review — year-over-year variance analysis",
    };
    const desc = toolDescriptions[specialistMode] || specialistMode.replace(/_/g, " ");
    injectedSystemPrompt += `\nSpecialist mode: Audit — ${desc}.\n`;
    injectedSystemPrompt += `The user has specifically selected this audit tool. You MUST call the appropriate tool function (${primaryToolNames.join(", ")}) to process any attached data. Do not attempt to perform the analysis manually — use the tool.\n`;
    injectedSystemPrompt += "If the user has not provided data/attachments yet, ask them to upload the relevant file (e.g., general ledger, trial balance, financial statements).\n\n";
  }
  const structuredInputBlock = buildStructuredAttachmentPayloadBlock({
    userQuery: userTextForUrlDetection || userText,
    attachments: requestAttachmentContexts,
  });
  if (structuredInputBlock) {
    injectedSystemPrompt += `${structuredInputBlock}\n\nStructured-input rule: use user_query as the task and attachments[] as the only file evidence source. If evidence is insufficient, say so directly.\n\n`;
  }
  // Small models: no full tool prompt, just a polite redirect hint
  const SMALL_MODEL_PATTERNS = /nano|(?<![a-z])mini(?!max)|flash-lite|(?<![a-z])haiku|(?<![a-z])8b(?![a-z])|(?<![a-z])7b(?![a-z])/i;
  const isSmallModel = SMALL_MODEL_PATTERNS.test(modelId);
  if (isSmallModel) {
    injectedSystemPrompt += "\nYou are a lightweight model. If the user asks to generate files (Excel, Word, PPT), politely tell them to switch to a more capable model such as DeepSeek, GPT-4.1, or Claude Sonnet. Do NOT attempt to generate files yourself.\n";
  }
  // ── Planning prompt for complex multi-step requests ──
  if (!isSmallModel && isComplexRequest(userText)) {
    injectedSystemPrompt += "\n" + buildPlanningPrompt(lang) + "\n";
  }

  // ── Tool mode: native function calling vs prompt injection ──
  const toolsEnabled = req.body.tools !== false && !isSmallModel;
  const useNativeTools = toolsEnabled && NATIVE_TOOL_PROVIDERS.has(pnLower) && !useCollector;
  let nativeToolsParam = undefined;

  if (toolsEnabled) {
    if (useNativeTools) {
      // Native function calling: pass structured tool schemas to the provider API
      try {
        const allSchemas = lumigentRuntime.registry
          ? await lumigentRuntime.registry.getSchemas()
          : [];
        let relevant = selectRelevantTools(userText, allSchemas, specialistMode);
        // Force-include tools only when explicitly triggered by /slash commands
        if (isDeepSearch && !relevant.some(s => s.name === 'deep_search')) {
          const ds = allSchemas.find(s => s.name === 'deep_search');
          if (ds) relevant = [...relevant, ds];
        }
        if (isHkexDownload && !relevant.some(s => s.name === 'hkex_download')) {
          const hkexSchema = allSchemas.find(s => s.name === 'hkex_download');
          if (hkexSchema) relevant = [...relevant, hkexSchema];
        }
        if (relevant.length > 0) {
          nativeToolsParam = formatNativeTools(pnLower, relevant);
          log("info", "Native tools enabled", { provider: pnLower, model: modelId, toolCount: relevant.length, tools: relevant.map(s => s.name) });
        }
      } catch (e) {
        log("warn", "Failed to prepare native tools, falling back to prompt injection", { error: e.message });
        nativeToolsParam = undefined;
      }
      // For native tool providers, still inject a minimal tool usage hint (but not the full schema list)
      if (nativeToolsParam) {
        injectedSystemPrompt += "\nYou have tools available via function calling. Use them when the user asks to generate files, search the web, run code, or perform analysis. Do NOT output [TOOL:...] text markers — use the native tool calling mechanism instead.\n\nMemory tools (use like ChatGPT memory):\n- memory_save: Proactively save anything worth remembering — personal info, projects they mention, decisions, preferences, key discussion points, deadlines. Do this silently.\n- memory_search: Use mode=\"search\" for targeted queries (\"what project were they working on\"). Use mode=\"all\" for broad recall (\"what do I know about this user\"). When the current topic might connect to past conversations, search proactively to provide continuity.\n- Be natural — never say \"I saved to memory\" or \"let me check my database\". Just know things.\n";
      } else {
        // Native tools preparation failed — fall back to prompt injection
        try {
          const toolPrompt = lumigentRuntime.getSystemPrompt();
          if (toolPrompt && !toolPrompt.includes("No tools")) injectedSystemPrompt += toolPrompt;
        } catch {}
      }
    } else {
      // Non-native providers (MiniMax, Kimi, Doubao, Qwen): use prompt injection
      try {
        const toolPrompt = lumigentRuntime.getSystemPrompt();
        if (toolPrompt && !toolPrompt.includes("No tools")) injectedSystemPrompt += toolPrompt;
      } catch {}
    }
  }

  // ── Deep Search mode: force AI to use deep_search tool ──
  if (isDeepSearch) {
    injectedSystemPrompt += `\nIMPORTANT: The user has activated Deep Search mode. You MUST call the deep_search tool with the user's question as the query. Do not answer from your own knowledge — use the tool to perform multi-round research and return a comprehensive report with citations. Call deep_search now.\n`;
  }

  // ── HKEX Download mode: force AI to use hkex_download tool ──
  if (isHkexDownload) {
    injectedSystemPrompt += `\nIMPORTANT: The user wants to download HKEX filings. Follow these steps:
1. First, briefly acknowledge the request in 1-2 sentences (e.g. "正在为您从港交所下载...").
2. Then call the hkex_download tool with these EXACT parameter names:
   - stock_code: string (e.g. "00700", pad to 5 digits)
   - doc_type: "annual" | "interim" | "results" | "circular" | "all"
   - date_from: "YYYY-MM-DD" (optional)
   - date_to: "YYYY-MM-DD" (optional, defaults to today)
   Do NOT use "start_date" or "end_date" — the correct names are date_from and date_to.
3. Do NOT tell the user to visit hkexnews.hk — you have the tool to do it.
4. If the tool returns 0 results: the stock code is CORRECT (it was selected from the official HKEX stock list). Simply relay the tool's message — do NOT say the code is wrong or invalid. Suggest trying a different doc_type or date range.
5. If the tool indicates fallback results (e.g. Annual Results instead of Annual Report), clearly tell the user what was found and that no Annual Report exists for this period.\n`;
  }

  // ── Build provider request ──
  const chatUrl = getChatUrl(pnLower, provider);
  const headers = getChatHeaders(pnLower, apiKey);
  const body = stripInternalChatFields(buildChatBody(pnLower, modelId, messages, injectedSystemPrompt.trim(), wantStream, nativeToolsParam));

  try {
    // ── Collector path: use Chrome CDP when no API key ──
    if (useCollector) {
      let collector;
      collector = _collector();
      if (!collector) { return res.status(503).json({ error: "Collector module not available" }); }
      const credentials = getCollectorCredentials(providerName.toLowerCase());
      // Inject system prompt into messages for collector
      const collectorMsgs = [...messages];
      if (injectedSystemPrompt.trim()) {
        const sysMsg = collectorMsgs.find(m => m.role === "system");
        if (sysMsg) sysMsg.content = injectedSystemPrompt.trim() + "\n\n" + (sysMsg.content || "");
        else collectorMsgs.unshift({ role: "system", content: injectedSystemPrompt.trim() });
      }
      if (!res.headersSent && wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
      }
      try {
        let _cInThink = false;
        let _cThinkBuf = "";
        let _cFullText = ""; // accumulate for tool tag detection
        for await (const chunk of collector.sendMessage(providerName.toLowerCase(), modelId, collectorMsgs, credentials)) {
          if (res.writableEnded) break;
          if (wantStream) {
            let out = chunk;
            const m = out.match(/^data: (.+)$/m);
            if (m && m[1] !== "[DONE]") {
              try {
                const j = JSON.parse(m[1]);
                let c = j.choices?.[0]?.delta?.content || "";
                if (c) {
                  // Strip <think> tags (with cross-chunk buffer)
                  if (_cInThink) { _cThinkBuf += c; const end = _cThinkBuf.indexOf("</think>"); if (end !== -1) { _cInThink = false; c = _cThinkBuf.slice(end + 8); _cThinkBuf = ""; } else { if (_cThinkBuf.length > 100) _cThinkBuf = _cThinkBuf.slice(-8); c = ""; } }
                  if (c.includes("<think>")) { const s = c.indexOf("<think>"); const e = c.indexOf("</think>", s); if (e !== -1) c = c.slice(0, s) + c.slice(e + 8); else { c = c.slice(0, s); _cInThink = true; _cThinkBuf = ""; } }
                  if (!c) continue;
                  _cFullText += c;
                  j.choices[0].delta.content = c;
                  out = `data: ${JSON.stringify(j)}\n\n`;
                }
              } catch {}
            }
            res.write(out);
          }
        }
        // Check for tool tags in accumulated text (Collector doesn't go through clean pipe)
        const hasCollectorTools = TOOL_TAG_MARKERS.some(m => _cFullText.includes(m));
        if (hasCollectorTools && !res.writableEnded) {
          log("info", "Collector: tool tags detected, executing", { provider: providerName });
          const toolResults = await lumigentRuntime.executeTextToolCalls(_cFullText, authUserId || projectName || "api").catch(e => {
            log("error", "Collector tool exec failed", { error: e.message }); return [];
          });
          for (const tr of toolResults) {
            if ((tr.downloadUrl || tr.base64 || tr.filename) && !res.writableEnded) {
              emitFileDownload({
                filename: tr.filename, size: tr.size, mimeType: tr.mimeType,
                downloadUrl: tr.downloadUrl || "", base64: !tr.downloadUrl ? tr.base64 : undefined,
              });
              const icon = tr.tool?.includes("spread") ? "spreadsheet" : "file";
              const sizeStr = tr.size > 1048576 ? `${(tr.size / 1048576).toFixed(1)} MB` : `${(tr.size / 1024).toFixed(1)} KB`;
              emitToolStatus({ text: L.toolDone(tr.filename, sizeStr), icon, done: true });
            }
          }
        }
        setCollectorHealth(pnLower, true);
        if (!res.writableEnded) { if (wantStream) res.write("data: [DONE]\n\n"); res.end(); }
      } catch (e) {
        setCollectorHealth(pnLower, false, e.message);
        log("error", "Collector error in /v1/chat", { provider: providerName, error: e.message });
        const isAuthErr = /401|403|expired|login|auth|session|cookie|rate.?limit/i.test(e.message);
        if (!res.headersSent) return res.status(isAuthErr ? 401 : 502).json({ error: isAuthErr ? `${providerName} session expired — please re-login via Dashboard` : "Collector error" });
        if (!res.writableEnded) {
          if (isAuthErr) res.write(`event: collector_auth\ndata: ${JSON.stringify({ provider: pnLower, message: L.searching ? `${providerName} session expired` : `${providerName} 登录已过期` })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: isAuthErr ? `\n\n[${providerName} session expired — re-login needed]` : `\n\n[Error: ${e.message}]` } }] })}\n\n`);
          res.write("data: [DONE]\n\n"); res.end();
        }
      }
      return;
    }

    // ── API path: direct fetch to provider ──
    const upstreamRes = await fetch(chatUrl, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    if (!upstreamRes.ok) {
      const status = upstreamRes.status;
      const errMap = { 400: "Bad request to AI provider", 401: "AI provider authentication failed", 403: "AI provider access denied", 404: "Model not found", 429: "AI provider rate limit exceeded", 500: "AI provider internal error", 502: "AI provider unavailable", 503: "AI provider temporarily unavailable" };
      const errMsg = errMap[status] || `AI provider error (${status})`;
      let upstreamBodySnippet = "";
      try { upstreamBodySnippet = (await upstreamRes.text()).slice(0, 1200); } catch {}
      log("warn", "AI provider bad response", {
        provider: providerName,
        model: modelId,
        status,
        url: chatUrl,
        hasEncryptedPayload: !!req.body?.encrypted_payload_text,
        stream: !!wantStream,
        messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
        upstreamBodySnippet,
      });
      if (upstreamRes.body?.cancel) {
        // body may already be locked/consumed after upstreamRes.text(); avoid unhandled rejection
        await upstreamRes.body.cancel().catch(() => {});
      }
      if (!res.headersSent) return res.status(status >= 500 ? 502 : status).json({ error: errMsg });
      log("warn", "Upstream error after headers sent", { provider: providerName, status });
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `\n\n[Error: ${errMsg}]` } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
      }
      return res.end();
    }

    // ── Non-streaming response ──
    if (!wantStream) {
      const data = await upstreamRes.json();
      // Extract content, strip tool tags, execute tools
      let content = "";
      let nonStreamNativeToolCalls = [];
      if (pnLower === "anthropic") {
        const blocks = data.content || [];
        content = blocks.filter(b => b.type === "text").map(b => b.text).join("");
        // Extract native tool_use blocks from Anthropic response
        for (const b of blocks) {
          if (b.type === "tool_use") {
            nonStreamNativeToolCalls.push({ id: b.id, name: b.name, arguments: JSON.stringify(b.input || {}) });
          }
        }
      } else {
        content = data.choices?.[0]?.message?.content || "";
        // Extract native tool_calls from OpenAI/DeepSeek/Gemini response
        const msgToolCalls = data.choices?.[0]?.message?.tool_calls;
        if (Array.isArray(msgToolCalls)) {
          for (const tc of msgToolCalls) {
            if (tc.type === "function" && tc.function) {
              nonStreamNativeToolCalls.push({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments || "{}" });
            }
          }
        }
      }

      // Handle native tool calls in non-streaming mode
      if (nonStreamNativeToolCalls.length > 0) {
        const toolResults = [];
        for (const tc of nonStreamNativeToolCalls) {
          let toolInput = {};
          try { toolInput = JSON.parse(tc.arguments || "{}"); } catch {}
          try {
            // Memory tools handled locally (need userMemory + userId context)
            const memResult = await handleMemoryTool(tc.name, toolInput, authUserId);
            const result = memResult || await lumigentRuntime.executeToolCall(tc.name, {
              ...toolInput,
              _caller_user_id: authUserId || projectName || "api",
              _caller_provider: providerName,
              _caller_model: modelId,
              _progress_sink: wantStream ? (msg) => emitToolStatus({ text: msg?.text || "", icon: "search", done: msg?.done }) : undefined,
            });
            if (result?.ok) {
              if (result.file) {
                let downloadUrl = "";
                try { downloadUrl = await lumigentRuntime.persistFile({ userId: authUserId || projectName || "api", toolName: tc.name, filename: result.filename, mimeType: result.mimeType, file: result.file }); } catch {}
                toolResults.push({ tool: tc.name, filename: result.filename, mimeType: result.mimeType, size: result.file.length, downloadUrl, base64: !downloadUrl ? result.file.toString("base64") : undefined });
              } else if (result.data) {
                toolResults.push({ tool: tc.name, data: result.data });
              }
            } else if (result?._errorContext) {
              toolResults.push({ tool: tc.name, ok: false, error: result._errorContext.message, suggestions: result._errorContext.suggestions });
            }
          } catch (e) { log("warn", "Non-stream native tool execution failed", { tool: tc.name, error: e.message }); }
        }
        const _nsContent1 = content || "已处理完成。";
        if (userMemory && authUserId && userQueryText && _nsContent1) {
          userMemory.ingest(authUserId, {
            userMessage: userQueryText,
            assistantMessage: _nsContent1.slice(0, 4000),
            provider: providerName,
            model: modelId,
            sessionId: req.body?.session_id || "",
          }).catch(e => log("warn", "memory_ingest_failed", { component: "user-memory", userId: authUserId, error: e.message }));
        }
        return res.json({
          choices: [{ message: { role: "assistant", content: _nsContent1 } }],
          tool_results: toolResults.length ? toolResults : undefined,
        });
      }

      // Fallback: text-based tool tags
      const hasToolTags = TOOL_TAG_MARKERS.some(m => content.includes(m));
      if (hasToolTags) {
        let toolResults = [];
        try {
          toolResults = await lumigentRuntime.executeTextToolCalls(content, authUserId || projectName || "api");
        } catch (e) { log("warn", "Non-stream tool execution failed", { error: e.message }); }
        const cleanContent = content.replace(/\[TOOL:\w+\][\s\S]*?\[\/TOOL\]/g, "")
          .replace(/<(?:｜DSML｜|︱DSML︱|\|DSML\|)function_calls>[\s\S]*?<\/(?:｜DSML｜|︱DSML︱|\|DSML\|)function_calls>/g, "")
          .replace(/<(?:minimax:)?tool_call>[\s\S]*?<\/(?:minimax:)?tool_call>/g, "").trim();
        const _nsContent2 = cleanContent !== "" ? cleanContent : "已处理完成。";
        if (userMemory && authUserId && userQueryText && _nsContent2) {
          userMemory.ingest(authUserId, {
            userMessage: userQueryText,
            assistantMessage: _nsContent2.slice(0, 4000),
            provider: providerName,
            model: modelId,
            sessionId: req.body?.session_id || "",
          }).catch(e => log("warn", "memory_ingest_failed", { component: "user-memory", userId: authUserId, error: e.message }));
        }
        return res.json({
          choices: [{ message: { role: "assistant", content: _nsContent2 } }],
          tool_results: toolResults.length ? toolResults : undefined,
        });
      }
      // Plain non-streaming response (no tools)
      if (userMemory && authUserId && userQueryText && content) {
        userMemory.ingest(authUserId, {
          userMessage: userQueryText,
          assistantMessage: content.slice(0, 4000),
          provider: providerName,
          model: modelId,
          sessionId: req.body?.session_id || "",
        }).catch(e => log("warn", "memory_ingest_failed", { component: "user-memory", userId: authUserId, error: e.message }));
      }
      return res.json({ choices: [{ message: { role: "assistant", content } }] });
    }

    // ── Streaming response — Clean SSE Pipe ──
    if (!res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
    }

    let fullText = "";       // all accumulated content
    let sentLength = 0;      // how much of fullText has been sent to client
    let toolTagStart = -1;   // index where tool tag begins (-1 = not found)
    let streamUsage = null;
    // Keep only a very small tail for tool-tag detection to avoid visible chunk jumps.
    // Test route gets an even more aggressive "ultra-smooth" profile.
    const referer = String(req.headers.referer || "");
    const isLumichatTestClient = referer.includes("/lumichat/test");
    // Hold buffer: just enough to detect "[TOOL:" (6 chars). Keep small to avoid stutter.
    const TOOL_TAG_HOLD_CHARS = isLumichatTestClient ? 4 : 7;
    const TOOL_TAG_FAST_HOLD_CHARS = isLumichatTestClient ? 1 : 3;
    const TOOL_TAG_FAST_FLUSH_MS = isLumichatTestClient ? 80 : 100;
    let pendingSinceTs = 0;

    const isAnthropic = pnLower === "anthropic";

    // Strip <think>...</think> blocks from streaming content (MiniMax, DeepSeek-R1)
    let inThink = false;

    // ── Native tool call accumulation state ──
    // For OpenAI/DeepSeek/Gemini: tool_calls are streamed as deltas with index, name, arguments fragments
    // For Anthropic: content blocks with type "tool_use" have id, name, and input_json_delta
    // nativeToolCalls: array of { id, name, arguments (string, accumulated) }
    let nativeToolCalls = [];
    // Anthropic uses content block index to track which tool_use block we're accumulating
    let anthropicToolBlocks = new Map(); // blockIndex -> { id, name, arguments }

    function sendDelta(text) {
      if (!text || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ model: modelId, choices: [{ delta: { content: text } }] })}\n\n`);
    }

    // Upgrade emitToolStatus with model field now that streaming phase has begun
    emitToolStatus = function(payload) {
      if (res.writableEnded) return;
      res.write(`event: tool_status\ndata: ${JSON.stringify(payload)}\n\n`);
      res.write(`data: ${JSON.stringify({ model: modelId, choices: [{ delta: { content: "" }, tool_status: payload }] })}\n\n`);
    };

    function emitFileDownload(payload) {
      if (res.writableEnded) return;
      res.write(`event: file_download\ndata: ${JSON.stringify(payload)}\n\n`);
      res.write(`data: ${JSON.stringify({ model: modelId, choices: [{ delta: { content: "" }, file_download: payload }] })}\n\n`);
    }

    let _thinkBuf = ""; // buffer for cross-chunk </think> detection
    function pipeContent(delta) {
      if (inThink) {
        _thinkBuf += delta;
        const end = _thinkBuf.indexOf("</think>");
        if (end !== -1) {
          // Forward accumulated thinking content as reasoning_content
          const thinkContent = _thinkBuf.slice(0, end);
          if (thinkContent && !res.writableEnded) {
            res.write(`data: ${JSON.stringify({ model: modelId, choices: [{ delta: { reasoning_content: thinkContent } }] })}\n\n`);
          }
          inThink = false;
          delta = _thinkBuf.slice(end + 8);
          _thinkBuf = "";
        } else {
          // Forward thinking chunks in real-time as reasoning_content
          if (_thinkBuf.length > 8 && !res.writableEnded) {
            const toSend = _thinkBuf.slice(0, -8); // keep last 8 for cross-chunk </think> detection
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: toSend } }] })}\n\n`);
            _thinkBuf = _thinkBuf.slice(-8);
          }
          return;
        }
      }
      if (delta.includes("<think>")) {
        const start = delta.indexOf("<think>");
        const end = delta.indexOf("</think>", start);
        if (end !== -1) {
          // Complete <think>...</think> in one chunk — forward as reasoning_content
          const thinkContent = delta.slice(start + 7, end);
          if (thinkContent && !res.writableEnded) {
            res.write(`data: ${JSON.stringify({ model: modelId, choices: [{ delta: { reasoning_content: thinkContent } }] })}\n\n`);
          }
          delta = delta.slice(0, start) + delta.slice(end + 8);
        }
        else {
          const before = delta.slice(0, start);
          inThink = true; _thinkBuf = "";
          delta = before;
        }
        if (!delta) return;
      }
      fullText += delta;
      if (toolTagStart >= 0) return;
      if (fullText.length > sentLength && pendingSinceTs === 0) pendingSinceTs = Date.now();

      const scanFrom = Math.max(0, sentLength - 30);
      for (const marker of TOOL_TAG_MARKERS) {
        const idx = fullText.indexOf(marker, scanFrom);
        if (idx !== -1) {
          toolTagStart = idx;
          if (idx > sentLength) { sendDelta(fullText.slice(sentLength, idx)); sentLength = idx; }
          emitToolStatus({ text: L.processing, icon: "file" });
          return;
        }
      }

      const waitedMs = pendingSinceTs ? (Date.now() - pendingSinceTs) : 0;
      const holdChars = waitedMs >= TOOL_TAG_FAST_FLUSH_MS ? TOOL_TAG_FAST_HOLD_CHARS : TOOL_TAG_HOLD_CHARS;
      const safeEnd = fullText.length - holdChars;
      if (safeEnd > sentLength) {
        sendDelta(fullText.slice(sentLength, safeEnd));
        sentLength = safeEnd;
        if (sentLength >= fullText.length) pendingSinceTs = 0;
      }
    }

    async function consumeStreamResponse(streamRes) {
      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let sseEventType = "";
      let finishReason = "";
      let interrupted = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("event: ")) { sseEventType = line.slice(7).trim(); continue; }
            if (!line.startsWith("data: ")) { if (line === "") sseEventType = ""; continue; }
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;

            try {
              const j = JSON.parse(data);
              if (isAnthropic) {
                // ── Anthropic native tool_use handling ──
                if (j.type === "content_block_start" && j.content_block?.type === "tool_use") {
                  // A new tool_use block begins
                  const block = j.content_block;
                  anthropicToolBlocks.set(j.index, { id: block.id, name: block.name, arguments: "" });
                  emitToolStatus({ text: `${L.toolLabel(block.name)}...`, icon: block.name.includes("search") ? "search" : "file" });
                } else if (j.type === "content_block_delta" && j.delta?.type === "input_json_delta") {
                  // Accumulate JSON argument fragments for the tool_use block
                  const tb = anthropicToolBlocks.get(j.index);
                  if (tb) tb.arguments += (j.delta.partial_json || "");
                } else if (j.type === "content_block_stop") {
                  // Block finished — if it was a tool_use, finalize it
                  const tb = anthropicToolBlocks.get(j.index);
                  if (tb) {
                    nativeToolCalls.push({ id: tb.id, name: tb.name, arguments: tb.arguments });
                    anthropicToolBlocks.delete(j.index);
                  }
                } else if (j.type === "content_block_delta" && j.delta?.type === "text_delta") {
                  pipeContent(j.delta.text || "");
                } else if (j.type === "message_delta") {
                  if (j.usage) streamUsage = { prompt_tokens: j.usage.input_tokens || 0, completion_tokens: j.usage.output_tokens || 0 };
                  if (j.delta?.stop_reason) finishReason = ({ end_turn: "stop", max_tokens: "length", tool_use: "tool_calls" }[j.delta.stop_reason] || j.delta.stop_reason || finishReason);
                }
              } else {
                // ── OpenAI / DeepSeek / Gemini native tool_calls handling ──
                if (j.usage) streamUsage = j.usage;
                const choice = j.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta;
                if (!delta) continue;

                // Reasoning content (DeepSeek Reasoner) — forward as <think> tags so client can display collapsible block
                if (delta.reasoning_content) {
                  const rc = delta.reasoning_content;
                  res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: rc } }] })}\n\n`);
                }
                // Text content
                if (delta.content) pipeContent(delta.content);

                // Native tool_calls streaming
                if (Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    // Initialize entry if this is a new tool call
                    if (!nativeToolCalls[idx]) {
                      nativeToolCalls[idx] = { id: tc.id || "", name: "", arguments: "" };
                    }
                    if (tc.id) nativeToolCalls[idx].id = tc.id;
                    if (tc.function?.name) {
                      nativeToolCalls[idx].name = tc.function.name;
                      emitToolStatus({ text: `${L.toolLabel(tc.function.name)}...`, icon: tc.function.name.includes("search") ? "search" : "file" });
                    }
                    if (tc.function?.arguments) nativeToolCalls[idx].arguments += tc.function.arguments;
                  }
                }

                if (choice.finish_reason) finishReason = choice.finish_reason;
              }
            } catch {}
            sseEventType = "";
          }
        }
      } catch (readErr) {
        interrupted = true;
        log("warn", "Stream read interrupted", { provider: providerName, error: readErr.message, textLen: fullText.length });
      }
      return { finishReason, interrupted };
    }

    let { finishReason: finalFinishReason, interrupted: streamInterrupted } = await consumeStreamResponse(upstreamRes);

    for (let pass = 0; pass < AUTO_CONTINUE_MAX_PASSES && (shouldAutoContinueFinishReason(finalFinishReason) || streamInterrupted) && toolTagStart < 0 && nativeToolCalls.filter(tc => tc && tc.name).length === 0 && !res.writableEnded; pass++) {
      log("info", "Auto-continuing response", { provider: providerName, model: modelId, pass: pass + 1, finishReason: finalFinishReason, interrupted: streamInterrupted });
      const continuationMessages = [
        ...messages,
        { role: "assistant", content: fullText },
        { role: "user", content: getContinuationPrompt(lang) },
      ];
      const continuationBody = buildChatBody(providerName.toLowerCase(), modelId, continuationMessages, injectedSystemPrompt.trim(), true);
      const continuationRes = await fetch(chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(continuationBody),
        signal: AbortSignal.timeout(120000),
      });
      if (!continuationRes.ok || !continuationRes.body) {
        log("warn", "Auto-continue request failed", { provider: providerName, model: modelId, status: continuationRes.status });
        break;
      }
      const continuationState = await consumeStreamResponse(continuationRes);
      finalFinishReason = continuationState.finishReason;
      streamInterrupted = continuationState.interrupted;
    }

    // ── Stream ended — flush remaining content and handle tools ──

    // Filter out empty/incomplete native tool calls
    nativeToolCalls = nativeToolCalls.filter(tc => tc && tc.name);
    const hasNativeToolCalls = nativeToolCalls.length > 0;

    // ── Helper: consume a follow-up streaming response, extract text + native tool calls, stream deltas to client ──
    async function consumeFollowUpStream(streamRes) {
      if (!streamRes.ok || !streamRes.body) return { text: "", finishReason: "error", nativeToolCalls: [] };
      const fReader = streamRes.body.getReader();
      const fDec = new TextDecoder();
      let fBuf = "";
      let fText = "";
      let fFinish = "stop";
      const fNativeTools = [];
      const fAnthBlocks = new Map();
      try {
        while (true) {
          const { done: fDone, value: fVal } = await fReader.read();
          if (fDone) break;
          fBuf += fDec.decode(fVal, { stream: true });
          const fLines = fBuf.split("\n");
          fBuf = fLines.pop() || "";
          for (const fl of fLines) {
            if (!fl.startsWith("data: ")) continue;
            const fd = fl.slice(6).trim();
            if (fd === "[DONE]") continue;
            try {
              const fj = JSON.parse(fd);
              if (isAnthropic) {
                if (fj.type === "content_block_start" && fj.content_block?.type === "tool_use") {
                  fAnthBlocks.set(fj.index, { id: fj.content_block.id, name: fj.content_block.name, arguments: "" });
                } else if (fj.type === "content_block_delta" && fj.delta?.type === "input_json_delta") {
                  const tb = fAnthBlocks.get(fj.index);
                  if (tb) tb.arguments += (fj.delta.partial_json || "");
                } else if (fj.type === "content_block_stop") {
                  const tb = fAnthBlocks.get(fj.index);
                  if (tb) { fNativeTools.push({ id: tb.id, name: tb.name, arguments: tb.arguments }); fAnthBlocks.delete(fj.index); }
                } else if (fj.type === "content_block_delta" && fj.delta?.type === "text_delta") {
                  const c = fj.delta.text || ""; fText += c; sendDelta(c);
                } else if (fj.type === "message_delta" && fj.delta?.stop_reason) {
                  fFinish = ({ end_turn: "stop", max_tokens: "length", tool_use: "tool_calls" }[fj.delta.stop_reason] || fj.delta.stop_reason);
                }
              } else {
                const choice = fj.choices?.[0]; if (!choice) continue;
                const delta = choice.delta;
                if (delta?.content) { fText += delta.content; sendDelta(delta.content); }
                if (Array.isArray(delta?.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!fNativeTools[idx]) fNativeTools[idx] = { id: tc.id || "", name: "", arguments: "" };
                    if (tc.id) fNativeTools[idx].id = tc.id;
                    if (tc.function?.name) fNativeTools[idx].name = tc.function.name;
                    if (tc.function?.arguments) fNativeTools[idx].arguments += tc.function.arguments;
                  }
                }
                if (choice.finish_reason) fFinish = choice.finish_reason;
              }
            } catch {}
          }
        }
      } catch (e) { log("warn", "Follow-up stream read error", { error: e.message }); }
      return { text: fText, finishReason: fFinish, nativeToolCalls: fNativeTools.filter(tc => tc && tc.name) };
    }

    // ── Helper: fetchAI callback factory for the agent loop ──
    function makeAgentFetchAI(includeTools) {
      return async function agentFetchAI(loopMessages) {
        const reqBody = buildChatBody(pnLower, modelId, loopMessages, "", true, includeTools ? nativeToolsParam : undefined);
        const streamRes = await fetch(chatUrl, { method: "POST", headers, body: JSON.stringify(reqBody), signal: AbortSignal.timeout(90000) });
        return consumeFollowUpStream(streamRes);
      };
    }

    // ── Shared agent loop event handlers ──
    const agentOnToolStatus = (status) => {
      if (res.writableEnded) return;
      const icon = status.tool?.includes("search") ? "search" : status.tool?.includes("spread") ? "spreadsheet" : status.tool?.includes("present") ? "presentation" : "file";
      // Include iteration info so frontend can detect multi-step agent tasks
      const iterPrefix = status.iteration > 1 ? `[Step ${status.iteration}] ` : "";
      emitToolStatus({ text: iterPrefix + status.message, icon, done: status.state !== "running" });
    };
    const agentOnFileDownload = (fileInfo) => {
      emitFileDownload({ filename: fileInfo.filename, size: fileInfo.size, mimeType: fileInfo.mimeType, downloadUrl: fileInfo.downloadUrl || "", base64: fileInfo.base64 || undefined });
    };
    const agentOnIteration = (info) => {
      log("info", "Agent loop iteration", { ...info, provider: providerName, model: modelId });
    };

    // ── Multi-step Agent Loop: Plan -> Execute -> Observe -> Reflect -> Repeat ──
    if (hasNativeToolCalls && !res.writableEnded) {
      // Flush any remaining text content before entering agent loop
      if (sentLength < fullText.length) { sendDelta(fullText.slice(sentLength)); sentLength = fullText.length; }

      log("info", "Agent loop: native tool calls detected", {
        provider: providerName, model: modelId,
        tools: nativeToolCalls.map(tc => tc.name),
        count: nativeToolCalls.length,
      });

      // Build agent loop messages starting from the conversation so far
      const agentMessages = [...messages, { role: "assistant", content: fullText || "I'm executing the requested tools." }];

      // Inject planning prompt for complex requests
      if (isComplexRequest(userText)) {
        const planPrompt = buildPlanningPrompt(lang);
        const sysMsg = agentMessages.find(m => m.role === "system");
        if (sysMsg) sysMsg.content = (sysMsg.content || "") + "\n\n" + planPrompt;
      }

      // First iteration: tool calls are already parsed from the initial stream — return them without an AI call
      let _nativeFirstCallDone = false;
      const nativeAgentFetchAI = async (loopMessages) => {
        if (!_nativeFirstCallDone) {
          _nativeFirstCallDone = true;
          return { text: "", finishReason: "tool_calls", nativeToolCalls };
        }
        return makeAgentFetchAI(true)(loopMessages);
      };

      const agentResult = await lumigentRuntime.executeAgentLoop({
        messages: agentMessages,
        fetchAI: nativeAgentFetchAI,
        onDelta: () => {}, // deltas streamed by consumeFollowUpStream inside makeAgentFetchAI
        onToolStatus: agentOnToolStatus,
        onFileDownload: agentOnFileDownload,
        onIteration: agentOnIteration,
        maxIterations: 8,
        userId: authUserId || projectName || "api",
        planningEnabled: isComplexRequest(userText),
        lang,
      }).catch(e => {
        log("error", "Agent loop (native) failed", { error: e.message, provider: providerName });
        return { text: "", toolResults: [], iterations: 0, plan: null };
      });

      log("info", "Agent loop (native) completed", {
        provider: providerName, model: modelId,
        iterations: agentResult.iterations,
        toolResultCount: (agentResult.toolResults || []).length,
        hasPlan: !!agentResult.plan,
      });

    } else if (toolTagStart >= 0) {
      // Tool tags detected — send updated status with actual tool name, then execute
      const tagContent = fullText.slice(toolTagStart);
      let detectedToolName = "tool";
      const tnMatch = tagContent.match(/\[TOOL:(\w+)\]/) || tagContent.match(/invoke\s+name="(\w+)"/);
      if (tnMatch) detectedToolName = tnMatch[1];
      const toolAliasMap = {
        search: "web_search",
        websearch: "web_search",
        search_tool: "web_search",
        browse: "web_search",
        tool: "web_search",
        name: "web_search",
      };
      const detectedToolNameNormRaw = String(detectedToolName || "").trim().toLowerCase();
      const detectedToolNameNorm = toolAliasMap[detectedToolNameNormRaw] || detectedToolNameNormRaw;
      detectedToolName = detectedToolNameNorm || detectedToolName;
      const hasSearchIntentInUserText = needsWebSearch(String(userText || ""));
      const isSearchLikeTool = (
        /search|websearch|browse/.test(detectedToolNameNorm)
        || detectedToolNameNorm === "tool"
        || detectedToolNameNorm === "name"
        || detectedToolNameNorm === "search_tool"
        || hasSearchIntentInUserText
      );
      const detectedLabel = L.toolLabel(detectedToolName);
      let detectedQuery = "";
      const dqMatch = tagContent.match(/"(?:query|title|filename)"\s*:\s*"([^"]*)"/);
      if (dqMatch) detectedQuery = dqMatch[1];
      const detectedIcon = isSearchLikeTool ? "search" : detectedToolName.includes("spread") ? "spreadsheet" : "file";
      const statusText = detectedQuery ? `${detectedLabel}: ${detectedQuery}` : `${detectedLabel}...`;
      emitToolStatus({ text: statusText, icon: detectedIcon });

      log("info", "Agent loop: text tool tags detected", { provider: providerName, tool: detectedToolName, textLen: fullText.length });

      const cleanAssistantText = fullText.slice(0, toolTagStart).trim();

      // Build agent loop messages
      const textAgentMessages = [...messages, { role: "assistant", content: fullText }];

      // First iteration: return the already-received text so the loop parses tool tags from it
      let _textFirstCallDone = false;
      const textAgentFetchAI = async (loopMessages) => {
        if (!_textFirstCallDone) {
          _textFirstCallDone = true;
          return { text: fullText, finishReason: "stop", nativeToolCalls: [] };
        }
        // Subsequent iterations: call AI with tools enabled for multi-step
        return makeAgentFetchAI(!!nativeToolsParam)(loopMessages);
      };

      const textAgentResult = await lumigentRuntime.executeAgentLoop({
        messages: textAgentMessages,
        fetchAI: textAgentFetchAI,
        onDelta: () => {}, // deltas streamed by consumeFollowUpStream
        onToolStatus: agentOnToolStatus,
        onFileDownload: agentOnFileDownload,
        onIteration: agentOnIteration,
        maxIterations: 8,
        userId: authUserId || projectName || "api",
        planningEnabled: isComplexRequest(userText),
        lang,
      }).catch(e => {
        log("error", "Agent loop (text) failed", { error: e.message, provider: providerName });
        return { text: "", toolResults: [], iterations: 0, plan: null };
      });

      let toolResults = textAgentResult.toolResults || [];

      log("info", "Agent loop (text) completed", {
        provider: providerName, model: modelId,
        iterations: textAgentResult.iterations,
        toolResultCount: toolResults.length,
        hasPlan: !!textAgentResult.plan,
      });

      // ── Post-loop UX: search salvage, file_download, search links, official form ──
      const shouldSearchSalvage = isSearchLikeTool || (forceOfficialSearch && !hasDirectUrl) || (chatIntent.kind === "web_lookup" && !hasDirectUrl);
      if (toolResults.length === 0 && shouldSearchSalvage) {
        try {
          const q = String(detectedQuery || extractSearchQuery(userText || "") || "").trim();
          log("info", "Search salvage attempt", { provider: providerName, model: modelId, tool: detectedToolNameNorm, query: q.slice(0, 160), traceId: req.traceId });
          if (q) {
            let salvageResults = await executeWebSearchForChat(q, "month").catch(() => []);
            if (!salvageResults.length) salvageResults = await executeWebSearchForChat(q, "").catch(() => []);
            if (!salvageResults.length && chatIntent.officialFormLookup) salvageResults = getOfficialFormFallbackResults(userText);
            if (salvageResults.length) {
              toolResults.push({ tool: "web_search", data: { results: salvageResults, query: q }, duration: 0 });
              emitToolStatus({ text: L.searchDone(salvageResults.length), icon: "search", done: true });
            }
          }
        } catch (salvageErr) {
          log("warn", "Search salvage failed", { error: salvageErr.message, provider: providerName, model: modelId, traceId: req.traceId });
        }
      }

      // Fallback message if still no tool results
      if (toolResults.length === 0) {
        emitToolStatus({ text: `${detectedLabel} done`, icon: detectedIcon, done: true });
        const isNonUrlTool = detectedToolNameNorm && !['web_search','browse','search','fetch','url'].some(k => detectedToolNameNorm.includes(k));
        if (isNonUrlTool) {
          log("info", "Non-URL tool triggered but no results — skipping fallback message", { tool: detectedToolNameNorm, provider: providerName });
        } else {
          const sourceHint = directUrls?.[0] ? ` ${String(directUrls[0]).slice(0, 180)}` : "";
          const shouldUseSearchFallback = isSearchLikeTool || (forceOfficialSearch && !hasDirectUrl) || (!hasDirectUrl && explicitSearchIntent) || (chatIntent.kind === "web_lookup" && !hasDirectUrl);
          const fallback = shouldUseSearchFallback
            ? (lang === "zh" ? `未获取到有效搜索结果，请稍后重试或提供更具体关键词。` : `No usable search results were returned. Please retry or provide more specific keywords.`)
            : (lang === "zh"
                ? (sourceHint ? `未能从当前链接提取可读内容：${sourceHint}` : `未能提取可读内容，请提供可访问链接后重试。`)
                : (sourceHint ? `Could not extract readable content from the current link:${sourceHint}` : `Could not extract readable content. Please provide an accessible URL and retry.`));
          log("warn", "Tool fallback emitted", { provider: providerName, model: modelId, traceId: req.traceId, detectedToolNameNorm, hasSearchIntentInUserText, isSearchLikeTool, hasDirectUrl: !!(directUrls && directUrls.length), fallbackType: shouldUseSearchFallback ? "search_no_result" : "url_extract_failed" });
          sendDelta((cleanAssistantText ? "\n\n" : "") + fallback);
          if (chatIntent.officialFormLookup && !hasDirectUrl) {
            const policyLinks = buildRequiredLinkLines(getOfficialFormFallbackResults(userText), lang);
            if (policyLinks) sendDelta(`\n\n${policyLinks}\n`);
          }
        }
      }

      // Emit file_download for results not already emitted by the agent loop
      for (const tr of toolResults) {
        if ((tr.downloadUrl || tr.base64 || tr.filename) && !tr._fileEmitted) {
          emitFileDownload({ filename: tr.filename, size: tr.size, mimeType: tr.mimeType, downloadUrl: tr.downloadUrl || "", base64: !tr.downloadUrl ? tr.base64 : undefined });
          const icon = tr.tool?.includes("spread") ? "spreadsheet" : tr.tool?.includes("present") ? "presentation" : "file";
          const sizeStr = tr.size > 1048576 ? `${(tr.size / 1048576).toFixed(1)} MB` : `${(tr.size / 1024).toFixed(1)} KB`;
          emitToolStatus({ text: L.toolDone(tr.filename, sizeStr), icon, done: true });
        }
      }

      // Ensure search links are always returned as clickable URLs
      const searchLinkRows = [];
      for (const tr of toolResults) {
        if (!tr?.data?.results || !Array.isArray(tr.data.results)) continue;
        for (const r of tr.data.results.slice(0, 5)) {
          const url = String(r?.url || "").trim();
          if (!url) continue;
          searchLinkRows.push({ title: String(r?.title || "Source").trim(), url });
        }
      }
      if (searchLinkRows.length && !res.writableEnded) {
        const lines = (lang === "zh" ? "官方/来源链接：\n" : "Source links:\n") +
          searchLinkRows.map((x, i) => `${i + 1}. ${x.title}\n${x.url}`).join("\n\n");
        sendDelta((cleanAssistantText ? "\n\n" : "") + lines + "\n\n");
      }
      // Deterministic policy for official-form lookups
      if (chatIntent.officialFormLookup && !res.writableEnded) {
        const deterministicLinks = searchLinkRows.length
          ? searchLinkRows
          : getOfficialFormFallbackResults(userText).map((r) => ({ title: r.title || "Source", url: r.url || "" })).filter((r) => r.url);
        if (deterministicLinks.length) {
          const lines = (lang === "zh" ? "可直接打开以下官方链接：\n" : "Open these official links directly:\n")
            + deterministicLinks.slice(0, 3).map((x, i) => `${i + 1}. ${x.title}\n${x.url}`).join("\n\n");
          sendDelta(`\n\n${lines}\n`);
        }
      }
    } else {
      // No tool tags — flush remaining held content
      if (sentLength < fullText.length) sendDelta(fullText.slice(sentLength));
      // Deterministic fallback: official/tax-form lookup must return clickable links.
      if ((forceOfficialSearch || chatIntent.officialFormLookup) && officialFallbackLinkLines) {
        const hasUrl = /https?:\/\/\S+/i.test(fullText);
        const looksLikeAttachmentRefusal = /(没有找到任何可供参考的附件|没有附件|未提供链接|无法访问您提供的URL|cannot access|can't access|no attachment|no file content)/i.test(fullText);
        if (!hasUrl || looksLikeAttachmentRefusal) {
          sendDelta(`\n\n${officialFallbackLinkLines}\n`);
        }
      }
    }

    // Usage tracking
    try {
      if (streamUsage) {
        const tokens = { input: streamUsage.prompt_tokens || 0, cacheHit: 0, output: streamUsage.completion_tokens || 0 };
        recordUsage(projectName, providerName.toLowerCase(), modelId, tokens);
      }
    } catch {}

    // Emit final chunk with finish_reason and usage (OpenAI-compatible)
    if (!res.writableEnded) {
      const finalChunk = { model: modelId, choices: [{ delta: {}, finish_reason: finalFinishReason || "stop" }] };
      if (streamUsage) finalChunk.usage = streamUsage;
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
    }
    res.end();

    // ── Long-term user memory ingest (fire-and-forget, after response) ──
    if (userMemory && authUserId && userQueryText && fullText) {
      userMemory.ingest(authUserId, {
        userMessage: userQueryText,
        assistantMessage: fullText.slice(0, 4000),
        provider: providerName,
        model: modelId,
        sessionId: req.body?.session_id || "",
      }).catch(e => log("warn", "memory_ingest_failed", { component: "user-memory", userId: authUserId, error: e.message }));
    }
  } catch (err) {
    log("error", "Clean chat proxy error", { provider: providerName, error: err.message });
    if (!res.headersSent) res.status(502).json({ error: "Chat proxy error" });
    else if (!res.writableEnded) res.end();
  }
});

  return router;
};
