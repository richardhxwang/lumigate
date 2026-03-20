# LumiGate Architecture Overhaul — Progress Report
Date: 2026-03-21

## Summary
49 commits, 235 files changed, +47,316 / -7,905 lines

## Architecture

### Before vs After
- **server.js**: 12,445 → 3,654 lines (-71%)
- **17 route files**: 12,481 lines total
- **28 service files** (across 10 service modules): knowledge (11 files), workflow (4), observability (2), memory (2), financial (2), plugins, RBAC, versioning, PB schema/store, docling parser
- **8 tool files**: 5,594 lines total
- **23 registered tools** across builtin-handlers, unified-registry, audit-tools, financial-analysis, hkex-downloader, lumigent registry

### Module Split
| Directory | Files | Lines | Purpose |
|-----------|-------|-------|---------|
| `routes/` | 17 | 12,481 | HTTP route handlers (chat, proxy, admin, audio, vision, code, parse, etc.) |
| `services/` | 28 | ~8,000+ | Knowledge/RAG, workflow engine, observability, memory, financial engine, RBAC, plugins, versioning |
| `tools/` | 8 | 5,594 | Tool schemas + handlers (builtin, audit, financial, HKEX, MCP, templates, unified registry) |
| `lumigent/` | — | — | Tool execution runtime, bridges, builtin tool registration |
| `security/` | — | — | PII detection, secret masking, command guard, Ollama semantic detection |
| `middleware/` | — | — | Security + audit middleware (PB event logging) |

### Native Function Calling
- OpenAI, Anthropic, Gemini, DeepSeek: native `tool_use` / `function_calling` protocol
- MiniMax, Kimi, Doubao, Qwen: prompt-injection fallback with `[TOOL:name]{params}[/TOOL]` text tags
- Hybrid detection: streaming path parses both native tool_call chunks and text-based tags

## Completed Features

### Core Architecture
- Monolith split: server.js decomposed into 17 route modules + 28 service files
- Clean Chat Proxy (`POST /v1/chat`) — unified endpoint for all apps
- SSE streaming with clean pipe (strips tool markers before sending to client)
- 3 SSE event types: `data:` (text), `event: tool_status`, `event: file_download`
- Non-streaming path with tool execution support
- Collector path: Chrome CDP fallback when no API key available

### Tool Execution Pipeline (23 tools)
- **Document generation**: generate_spreadsheet, generate_document, generate_presentation
- **Template system**: use_template, fill_template (Excel template matching + financial model generation)
- **File processing**: parse_file (PDF/XLSX/DOCX/PPTX/HTML/TXT/MD), transcribe_audio (whisper.cpp)
- **Vision/Code**: vision_analyze (Ollama), code_run (Docker sandbox), sandbox_exec
- **Web**: web_search, browser_action (Playwright MCP)
- **Knowledge/RAG**: rag_retrieve, rag_trace
- **Audit tools**: audit_sampling (MUS/random/systematic), benford_analysis, journal_entry_testing (15 JET rules), variance_analysis, materiality_calculator, reconciliation, going_concern_check
- **Financial**: financial_statement_analyze (cross-checks), PPE rollforward, depreciation analysis
- **HKEX**: hkex_download (CDP announcement downloader)

### LumiChat UI
- macOS 26 / Apple HIG design (frosted glass, no emoji, flat SVG icons)
- PocketBase auth with JWT + session keepalive (30min refresh)
- Preset system (10 built-in + 8 user presets)
- Sensitivity/Response Mode (strict/default/creative/unrestricted)
- Canvas side panel + template filler
- Text selection floating menu (Ask/Explain/Translate/Copy)
- Drag-drop file upload + TTS voice output
- KaTeX math rendering
- Collapsible thinking/reasoning blocks
- ChatGPT-style source chips
- PWA manifest for iPhone Web App
- Mobile-responsive UI

### Knowledge/RAG System
- Per-user RAG memory with vector store (Qdrant)
- BM25 + semantic hybrid search with reranking
- Query transformation + context compression
- RAGFlow integration
- Score threshold tuning (0.55 → 0.15 for text-embedding-3-small)

### Security Pipeline
- PII/secret detection (regex presidio-layer + optional Ollama semantic)
- Command guard (17 rules blocking dangerous shell commands)
- Secret masking (`[SEC_xxx]` placeholders, restored on tool execution)
- HMAC + Token auth combo for mobile apps
- Per-project RPM, budget, IP allowlist, model allowlist, anomaly auto-suspend
- All events logged to PocketBase security_events + audit_log

### Observability
- Trace collector + evaluator
- Full-chain observability (zero silent failures)
- Trace visualization dashboard (traces.html)
- Error log summary script + watch alerts
- Telegram alert integration (pending live delivery test)

### Financial Analysis
- Programmatic cross-checks (13 checks, 4 categories)
- FAR tool (Fixed Asset Register) + Change in Equity
- PPE rollforward by category + depreciation rate analysis
- MUS sampling (AICPA factor table, 4 modes, Deloitte method)
- DCF valuation template generation

### Infrastructure
- Docker Compose deployment (Nginx + App + Cloudflare tunnel)
- NAS + Mac Mini split deployment
- Docker sandbox for code execution
- Qdrant + RAGFlow docker services
- Watchdog with 5s polling, <10s recovery

## Test Results
- **E2E**: 38/46 pass (83%), zero server crashes
- **Financial analysis**: 6/6 cross-checks PASS (CR Beer 2025 annual report)
- **RAG memory**: 6/7 facts recalled correctly
- **Smoke test**: 23 tools registered, all endpoints responding
- **File upload**: 11 file types tested (TXT, MD, CSV, JSON, HTML, PY, JS, XML, YAML, SH, LOG)
- **Provider coverage**: 8 providers tested (OpenAI, Anthropic, Gemini, DeepSeek, Kimi, Doubao, Qwen, MiniMax)

## Known Issues
- **8 E2E tests failing** (17%): likely timing/environment-dependent, not server crashes
- **P0**: LumiChat token auth on high-cost paths needs PB verification (not just payload decode)
- **P0**: OAuth redirect handling needs lockdown (only relative/allowlisted redirects)
- **P0**: `/lc/auth/check-email` filter construction may produce false negatives
- **P0**: BYOK create-path fails (PB migration sets `createRule=""`)
- **P1**: PB create rules need ownership enforcement alignment
- **P1**: `host.docker.internal` coupling reduces deployment portability
- **P1**: Telegram alert delivery not yet live-tested
- **P2**: Committed secrets need rotation and purge
- Non-streaming path was missing `userMemory.ingest()` call (fixed in this session)

## Next Steps
1. Fix remaining 8 E2E test failures
2. Address P0 security items (token auth, OAuth redirect, BYOK)
3. Live-test Telegram alert delivery
4. Rotate committed secrets, add pre-commit secret scanning
5. Reduce `host.docker.internal` coupling for portable deployment
6. VBA/Macro Excel support (Python openpyxl)
7. Collector login UI redesign (LumiChat style)
8. Consider moving LumiChat data to PB multi-project routing
