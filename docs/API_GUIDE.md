# LumiGate — API Guide

Complete endpoint reference for LumiGate. Base URL: `http://localhost:9471` (or your public domain).

---

## Authentication

LumiGate supports four auth modes. Choose per project in the dashboard under **Edit Project → Security**.

### Mode 1 — Direct Key

Pass the project key in a header. Simplest; use for server-to-server calls only.

```
X-Project-Key: pk_your_project_key
```

### Mode 2 — HMAC Signature

The key signs the request but is never transmitted. Use for mobile/client apps.

```
timestamp = current unix seconds (string)
nonce     = random UUID
body      = JSON.stringify(requestBody)
signature = HMAC-SHA256(projectKey, timestamp + nonce + body)

Headers:
  X-Project-Id: your-project-name
  X-Signature:  <hex signature>
  X-Timestamp:  <timestamp>
  X-Nonce:      <nonce>
```

Server verifies: timestamp within ±5 min, nonce not reused, signature matches.

### Mode 3 — Ephemeral Token

Exchange key for a short-lived token (default TTL: 1 h).

```
POST /v1/token
Body: { "projectId": "your-project", "ttl": 3600 }
Auth: HMAC-signed (key never sent in body)

Response: { "token": "et_...", "expiresIn": 3600 }

Subsequent requests:
  Authorization: Bearer et_...
```

### Mode 4 — HMAC + Token (recommended for client apps)

Best of both worlds: key never transmitted, token is short-lived.

```
1. App startup  →  POST /v1/token  (HMAC-signed)  →  { token, expiresIn }
2. All requests →  Authorization: Bearer et_...
3. Token expires → HMAC re-exchange automatically
4. On 401       → invalidate cached token → re-exchange
```

### LumiChat / Admin auth

| Context | Header / Cookie |
|---------|----------------|
| Platform API | `X-Project-Key` or HMAC/token flow above |
| Admin API | `admin_token` cookie, or `X-Admin-Token` header |
| LumiChat API | `lc_token` cookie (set on login) |

---

## Core Endpoint — POST /v1/chat

The unified streaming chat proxy. All apps and providers use this single endpoint.

### Request

```http
POST /v1/chat
Content-Type: application/json
X-Project-Key: pk_...        (or Authorization: Bearer et_...)
```

```jsonc
{
  "provider": "anthropic",        // required — see provider list
  "model":    "claude-sonnet-4-6",// required
  "messages": [
    { "role": "user", "content": "Generate a quarterly sales Excel file" }
  ],
  "stream": true,                 // recommended; false returns full JSON

  // optional fields
  "web_search":        false,     // true | false | omit (auto-detect)
  "tools":             true,      // enable tool execution (default: true)
  "specialist_mode":   "cast",    // "cast" for financial analysis mode
  "specialist_category": "audit", // sub-category for specialist mode
  "app":               "lumitrade" // app context header (e.g. LumiTrade isolation)
}
```

**Providers:** `openai`, `anthropic`, `gemini`, `deepseek`, `minimax`, `kimi`, `doubao`, `qwen`

### SSE Response (stream: true)

The server sends a clean SSE stream. Three event types only — clients never see raw tool tags.

```
data: Hello, here is your

data:  spreadsheet

event: tool_status
data: {"message":"Generating Excel...","tool":"generate_spreadsheet"}

event: file_download
data: {"filename":"sales_Q1.xlsx","url":"/files/abc123.xlsx","size":48200,"mime":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}

data: The file is ready. It includes three sheets...

data: [DONE]
```

| Event | Data format | Purpose |
|-------|-------------|---------|
| `data` (implicit) | Plain text delta | Render directly into chat bubble |
| `event: tool_status` | `{ message, tool }` JSON | Show grey status hint during tool execution |
| `event: file_download` | `{ filename, url, size, mime }` JSON | Render as a download card |

### Non-stream Response (stream: false)

```jsonc
{
  "content": "Here is your spreadsheet...",
  "files": [
    { "filename": "sales_Q1.xlsx", "url": "/files/abc123.xlsx", "size": 48200 }
  ],
  "usage": { "prompt_tokens": 312, "completion_tokens": 87 }
}
```

### Tool tag formats (server-normalizes all three)

```
DSML:    [TOOL:generate_spreadsheet]{"title":"Sales Q1"}[/TOOL]
XML:     <tool name="generate_spreadsheet">{"title":"Sales Q1"}</tool>
Native:  Anthropic tool_use blocks (passed through transparently)
```

User messages are scanned for embedded tool tags before forwarding — injection prevention.

### curl example

```bash
curl -N -X POST http://localhost:9471/v1/chat \
  -H "Content-Type: application/json" \
  -H "X-Project-Key: $KEY" \
  -d '{
    "provider": "deepseek",
    "model":    "deepseek-chat",
    "messages": [{"role":"user","content":"Search latest BYD news and summarize"}],
    "stream":   true
  }'
```

---

## Token Exchange — POST /v1/token

Exchange an HMAC-signed request for a short-lived ephemeral token.

```http
POST /v1/token
Content-Type: application/json
X-Project-Id: your-project
X-Signature:  <hmac>
X-Timestamp:  <unix seconds>
X-Nonce:      <uuid>
```

```json
{ "ttl": 3600 }
```

```json
{ "token": "et_abc123...", "expiresIn": 3600 }
```

---

## OTP

```http
POST /v1/otp/send    { "email": "user@example.com" }
POST /v1/otp/verify  { "email": "user@example.com", "code": "123456" }
```

---

## Platform APIs

All platform endpoints accept `multipart/form-data` file uploads unless noted.

### File Parsing — POST /platform/parse

Extracts text from PDF, XLSX, DOCX, PPTX, HTML, TXT, MD.

```http
POST /platform/parse
Content-Type: multipart/form-data
X-Project-Key: pk_...

file=@document.pdf
```

```json
{ "text": "Extracted content...", "pages": 12, "format": "pdf" }
```

### Audio Transcription

```http
POST /platform/audio/transcribe       (native path)
POST /platform/audio/transcriptions   (OpenAI-compatible)
Content-Type: multipart/form-data

file=@recording.mp3
model=whisper-1       (for OpenAI-compat path)
```

```json
{ "text": "Transcribed speech content..." }
```

### Vision Analysis — POST /platform/vision/analyze

```http
POST /platform/vision/analyze
Content-Type: multipart/form-data

image=@screenshot.png
prompt=Describe what you see    (optional)
```

```json
{ "description": "The image shows a bar chart with..." }
```

### Code Execution — POST /platform/code/run

Runs code in an isolated Docker sandbox.

```json
{
  "language": "python",
  "code": "import pandas as pd\nprint(pd.Series([1,2,3]).sum())"
}
```

```json
{ "stdout": "6\n", "stderr": "", "exitCode": 0, "runtime_ms": 840 }
```

Supported languages: `python`, `javascript`, `shell`

### CLI Sandbox — POST /platform/sandbox/exec

```json
{ "command": "echo hello", "timeout": 10000 }
```

### Tool Execution — POST /platform/tools/execute

Direct tool invocation without going through the chat proxy.

```json
{
  "tool": "generate_spreadsheet",
  "params": { "title": "Sales Report", "sheets": [...] }
}
```

### Lumigent

```http
POST /platform/lumigent/execute   Execute a Lumigent tool
GET  /platform/lumigent/tools     Tool catalog
GET  /platform/lumigent/traces    Execution traces
```

---

## LumiChat Auth — /lc/auth/*

### Login

```http
POST /lc/auth/login
{ "email": "user@example.com", "password": "secret" }
```

```json
{
  "token": "eyJ...",
  "user": { "id": "abc", "email": "user@example.com" }
}
```

Sets `lc_token` cookie automatically.

### Register

```http
POST /lc/auth/register
{ "email": "user@example.com", "password": "secret", "name": "Alice" }
```

### Other auth endpoints

```http
POST   /lc/auth/logout
POST   /lc/auth/refresh
GET    /lc/auth/me           → full user profile (name, avatarUrl, tier)
PATCH  /lc/auth/profile      { "name": "New Name", "avatar": <file> }
```

---

## LumiChat Sessions & Messages — /lc/*

### Sessions

```http
GET    /lc/sessions              list all sessions for current user
POST   /lc/sessions              { "title": "New chat" }  → { id, title, createdAt }
DELETE /lc/sessions/:id
GET    /lc/sessions/:id/messages → [ { role, content, createdAt }, ... ]
```

### Messages

```http
POST /lc/messages
{
  "sessionId": "abc",
  "role": "user",
  "content": "Hello"
}
```

### Files

```http
POST /lc/files            multipart upload; returns { id, url, filename, size }
GET  /lc/files/serve/:id  stream file content
```

### Providers / Models (for UI dropdowns)

```http
GET /lc/providers           → [ { id, name, available } ]
GET /lc/models/:provider    → [ { id, name, contextLength } ]
```

### User tier and BYOK

```http
GET /lc/user/tier      → { tier, limits, usage }
GET /lc/user/apikeys   → list bring-your-own keys
```

---

## Memory — /lc/memory/*

```http
GET  /lc/memory/recall        recall memories relevant to current user
POST /lc/memory/ingest        { "text": "User prefers dark mode" }
```

FurNote pet profile sync:

```http
GET  /fn/memory/profile/:userId
POST /fn/memory/profile/:userId  { "pet": { "name": "Mochi", "breed": "Shiba" } }
```

---

## HKEX Filing Download — /v1/hkex/*

```http
POST /v1/hkex/download
{
  "stockCode": "00700",
  "dateFrom":  "2025-01-01",
  "dateTo":    "2025-03-31",
  "category":  "results"      // optional filter
}
```

Returns a ZIP file stream containing the matched announcements.

Search modal in LumiChat is triggered via `/hkex` slash command — autocomplete by stock code, English name, or 繁體中文 name.

---

## Template Fill — POST /v1/tools/fill-template

Auto-fills Word/Excel templates from uploaded structured data.

```http
POST /v1/tools/fill-template
Content-Type: multipart/form-data

template=@audit_workpaper.docx
data={ "client": "ACME Ltd", "period": "FY2025", ... }
```

Returns the filled file as a download.

---

## Knowledge Base — /v1/knowledge/*

```http
POST   /v1/knowledge                    create KB  { "name": "...", "description": "..." }
GET    /v1/knowledge                    list KBs
GET    /v1/knowledge/:id                KB detail + stats
DELETE /v1/knowledge/:id

POST   /v1/knowledge/:id/documents      add document (text or file, up to 50 MB)
GET    /v1/knowledge/:id/documents      list documents
DELETE /v1/knowledge/:id/documents/:docId

POST   /v1/knowledge/:id/search         search within one KB  { "query": "..." }
POST   /v1/knowledge/search             search across multiple KBs  { "query": "...", "kbIds": ["id1","id2"] }
```

---

## Workflows — /v1/workflows/*

```http
POST   /v1/workflows                    create workflow (DAG JSON)
GET    /v1/workflows                    list workflows
GET    /v1/workflows/:id
PUT    /v1/workflows/:id
DELETE /v1/workflows/:id

POST   /v1/workflows/:id/run            execute  { "inputs": { "var": "value" } }
POST   /v1/workflows/:id/resume         resume after human_approval node

GET    /v1/tasks                        list task queue
GET    /v1/tasks/:id                    task status + result
```

Node types: `llm`, `tool`, `condition`, `parallel`, `code`, `human_approval`, `template`

---

## Observability — /v1/traces/*

```http
GET /v1/traces                  list traces
  ?userId=&type=&status=&from=&to=&limit=

GET /v1/traces/stats            aggregate stats
  ?groupBy=type&from=&to=

GET /v1/traces/days             list days with trace data
GET /v1/traces/:id              full trace detail (steps, tool calls, durations)
```

---

## Admin — /admin/*

All admin endpoints require `admin_token` cookie or `X-Admin-Token` header.

### MFA Setup

```http
GET    /admin/mfa/status
GET    /admin/mfa/qr              returns QR code PNG for TOTP app
POST   /admin/mfa/setup
POST   /admin/mfa/confirm         { "code": "123456" }
DELETE /admin/mfa
POST   /admin/mfa/verify          { "code": "123456" }
```

### Projects

```http
GET    /admin/projects
POST   /admin/projects            { "name": "myapp", "authMode": "hmac_token", "rpm": 120 }
PUT    /admin/projects/:name
DELETE /admin/projects/:name
POST   /admin/projects/:name/regenerate   → { "key": "pk_..." }
```

Project security fields: `authMode`, `rpm`, `ipAllowlist[]`, `maxBudgetUsd`, `budgetPeriod`, `allowedModels[]`, `anomalyAutoSuspend`

### API Keys (multi-key rotation)

```http
GET    /admin/keys/:provider
POST   /admin/keys/:provider      { "key": "sk-...", "label": "key-2" }
PUT    /admin/keys/:provider/:keyId
PUT    /admin/keys/:provider/reorder
DELETE /admin/keys/:provider/:keyId
```

### Usage & Budget

```http
GET /admin/usage             ?provider=&model=&from=&to=
GET /admin/usage/summary
GET /admin/metrics
```

### Audit Log

```http
GET /admin/audit             ?from=&to=&userId=&event=&limit=
```

### Backup / Restore

```http
POST /admin/backup
GET  /admin/backups
POST /admin/restore/:name
```

### User Management

```http
GET /admin/lc-users           list LumiChat users
GET /admin/lc-subscriptions   subscription management
GET /admin/collector/status   Chrome CDP session health
```

### Global Settings

```http
GET /admin/settings
PUT /admin/settings
  {
    "searchKeywordModel": "minimax/minimax-m2",
    "autoSearch": true,
    "toolInjectionGuard": true,
    "approvalFlow": false
  }
```

---

## System / Public

```http
GET /health              health + module/provider status (full detail for admin token)
GET /providers           provider availability  →  [ { id, name, baseUrl, available } ]
GET /models/:provider    model list
GET /collector/health    Chrome CDP session health
```

---

## Domain API — /api/domains/* (config-driven)

Generic CRUD over any configured PocketBase collection, with Excel-style filters.

```http
GET    /api/domains/:domain/schema
GET    /api/domains/:domain/:collection
POST   /api/domains/:domain/:collection
PATCH  /api/domains/:domain/:collection/:id
DELETE /api/domains/:domain/:collection/:id
```

Query contract:

```
filter[field][op]=value     ops: eq ne gt gte lt lte contains
sort=field:asc,field2:desc
perPage=50
include_deleted=1
trash_only=1
```

---

## RBAC — /v1/rbac/*

```http
GET    /v1/rbac/roles
POST   /v1/rbac/roles
GET    /v1/rbac/roles/:id
PUT    /v1/rbac/roles/:id
DELETE /v1/rbac/roles/:id
POST   /v1/rbac/assign       { "userId": "...", "roleId": "..." }
POST   /v1/rbac/check        { "userId": "...", "resource": "...", "action": "read" }
```

---

## Plugins — /v1/plugins/*

```http
GET    /v1/plugins
POST   /v1/plugins           install plugin from registry or URL
DELETE /v1/plugins/:id
POST   /v1/plugins/:id/enable
POST   /v1/plugins/:id/disable
```

---

## Error Format

All errors return standard JSON:

```json
{
  "error": "Unauthorized",
  "code":  401,
  "detail": "Invalid or expired token"
}
```

Common codes:

| Code | Meaning |
|------|---------|
| 401 | Auth failed — check key/token |
| 403 | Action not permitted for this project/user |
| 429 | RPM rate limit exceeded |
| 402 | Budget cap reached |
| 400 | Bad request — see `detail` |
| 503 | Provider unavailable / all keys exhausted |
