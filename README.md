# LumiGate

Self-hosted AI Agent Platform. One endpoint, 8 providers, server-side tool execution, enterprise auth.

## Quick Start

```bash
git clone https://github.com/richardhxwang/lumigate.git && cd lumigate
cp .env.example .env   # add your API keys
docker compose up -d --build
```

Dashboard at `http://localhost:9471`. Chat UI at `http://localhost:9471/lumichat.html`.

## What is LumiGate

LumiGate is a unified AI gateway that sits between your apps and 8 AI providers. Send a single `POST /v1/chat` request — the server handles provider routing, web search, file generation, and tool execution. Clients only receive clean text and download events. No tool logic on the frontend.

Ships with LumiChat, a production chat UI with SSE streaming, PocketBase auth, file attachments, voice input, and dark/light mode.

Runs on a NAS, mini PC, or any Docker host.

## Architecture

```
┌──────────┐                ┌──────────────────────────────┐
│ LumiChat │──cookie──▶     │        LumiGate Server       │
│ iOS App  │──HMAC────▶     │                              │
│ Any App  │──Token───▶     │  /v1/chat → Auth → AI Proxy  │
└──────────┘                │    → Tool Execute → Clean SSE │
                            └──────┬────────┬────────┬─────┘
                                   │        │        │
                            ┌──────┴──┐ ┌───┴───┐ ┌──┴────────┐
                            │ 8 AI    │ │DocGen │ │PocketBase │
                            │Providers│ │SearXNG│ │(Auth/Data)│
                            └─────────┘ └───────┘ └───────────┘
```

## API

```bash
curl -N -X POST http://localhost:9471/v1/chat \
  -H "Content-Type: application/json" \
  -H "X-Project-Key: $KEY" \
  -d '{
    "provider": "deepseek",
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Generate Excel: quarterly sales"}],
    "stream": true
  }'
```

SSE response delivers three event types:

| Event | Purpose |
|-------|---------|
| `data` (default) | Clean text chunks — render directly |
| `event: tool_status` | Progress hints (e.g. "Generating Excel...") |
| `event: file_download` | File metadata — render as download card |

Optional fields: `web_search` (bool, auto-detected if omitted), `tools` (bool, default true).

## Providers

| Provider | Auth | Example Models |
|----------|------|----------------|
| OpenAI | API Key | GPT-4.1, o3, o4-mini |
| Anthropic | API Key | Claude Opus 4, Sonnet 4 |
| Gemini | API Key | Gemini 2.5 Flash/Pro |
| DeepSeek | API Key | DeepSeek-Chat, R1 |
| MiniMax | API Key | MiniMax-M1, M2.5 |
| Kimi | Collector | Moonshot |
| Doubao | Collector | ByteDance |
| Qwen | Collector | Tongyi Qwen |

Collector providers use headless Chrome via CDP. Admin logs in once through VNC; Chrome maintains the session.

## Features

### Clean Chat Proxy

Single `POST /v1/chat` endpoint for all providers. Tool tags are intercepted and executed server-side — clients never see them. Works with any model, no native function calling required.

### Tool Execution

AI models trigger tools via text tags (`[TOOL:name]{params}[/TOOL]`). The server intercepts, executes, and streams results back as clean events.

Available tools: `generate_spreadsheet` (Excel with formulas), `generate_document` (Word), `generate_presentation` (PowerPoint), `use_template` (224 professional templates), `web_search`, `parse_file`, `transcribe_audio`, `vision_analyze`, `code_run`.

### LumiChat

Built-in chat UI. SSE streaming with markdown rendering, 8-provider model switching, file attachments, voice input, presets, PocketBase auth, mobile responsive.

### Security

- **Auth**: HMAC + ephemeral token exchange (key never transmitted)
- **PII detection**: 20+ regex patterns + optional Ollama semantic analysis
- **Secret masking**: detected secrets replaced with `[SEC_xxx]` before reaching the LLM
- **Command guard**: blocks dangerous shell commands in AI output
- **SSRF protection**: private IP/hostname blocklist with DNS resolution check
- **Per-project limits**: RPM, budget cap, IP allowlist, model allowlist, anomaly auto-suspend
- **Audit trail**: all events logged to PocketBase

### MCP Gateway

MCPJungle + Playwright for browser automation and external tool server integration.

## Auth Modes

| Mode | Mechanism | Best For |
|------|-----------|----------|
| Direct Key | `X-Project-Key` header | Server-to-server |
| HMAC Signature | Client signs request; key never transmitted | Mobile apps |
| Ephemeral Token | Short-lived token via `/v1/token` | Session-bound access |
| HMAC + Token | HMAC to exchange, token for requests | **Client apps (recommended)** |

## Deploy Modes

| Mode | Modules | Use Case |
|------|---------|----------|
| Lite | usage, chat | Personal use |
| Enterprise | All 9 modules | Teams, compliance |
| Custom | Pick & choose | Tailored setups |

## License

MIT
