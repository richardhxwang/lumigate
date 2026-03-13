# LumiChat Design Spec
**Date**: 2026-03-14
**Version**: v2 (post-review)
**Status**: Approved
**Scope**: ChatGPT-style chat interface on LumiGate + PocketBase

---

## 1. Overview

LumiChat is a standalone AI chat interface at `/lumichat`, served by LumiGate. It uses PocketBase for user auth and data (sessions, messages, files), routes AI calls through LumiGate's existing `/v1/*` proxy, and supports multi-modal file attachments (images, PDF, Excel, audio, video).

**Key goals:**
- ChatGPT-style UX: collapsible sidebar, session history, markdown + code rendering
- File support: image, PDF, Excel, audio, video (each with appropriate delivery path)
- PocketBase as single source of truth
- Security-first: no onclick template injection, DOMPurify on markdown, CSP nonce, httpOnly cookies

---

## 2. PocketBase Setup

### Instance
Existing PocketBase at `localhost:8090`. LumiChat collections are created in the default `_pb_users_auth_` users collection (PB native auth), plus three custom collections.

### Collections

#### Native `users` collection
PocketBase's built-in auth collection. Fields used: `email`, `name`. No extra fields needed for v1.

#### `lc_sessions`
| Field | Type | Notes |
|-------|------|-------|
| `user` | relation → `users` | required, cascade delete sessions on user delete |
| `title` | text | AI-generated; default "New Chat" |
| `provider` | text | e.g. `openai` |
| `model` | text | e.g. `gpt-4.1-mini` |
| `created` | auto | |
| `updated` | auto | |

#### `lc_messages`
| Field | Type | Notes |
|-------|------|-------|
| `session` | relation → `lc_sessions` | required; **cascade delete = true** |
| `role` | select: `user\|assistant` | |
| `content` | text (large) | message text |
| `file_ids` | json | array of `lc_files` IDs (may be empty) |
| `created` | auto | |

#### `lc_files`
| Field | Type | Notes |
|-------|------|-------|
| `session` | relation → `lc_sessions` | required; **cascade delete = true** |
| `user` | relation → `users` | required |
| `file` | file | PB managed storage |
| `mime_type` | text | |
| `size_bytes` | number | |
| `extracted_text` | text (large) | PDF/Excel parsed text; empty for binary types |
| `synced` | bool | false until background sync completes |
| `created` | auto | |

**Note on cascade delete**: `lc_messages.session` and `lc_files.session` both have `cascade delete = true` set in PB collection config. Deleting a session deletes all its messages and files automatically via PB — LumiGate only needs to DELETE the session record.

**Note on `lc_files.message` omitted**: The two-phase write (create file → create message → link back) creates an unresolvable race. Instead, `lc_messages.file_ids` is a JSON array of file IDs. Messages are created after files are uploaded (or after fast-path base64 is sent to AI). Order of ops: upload file → get file ID → create message with file_ids → send to AI.

---

## 3. Architecture

```
Browser
  │
  ├── GET /lumichat                     → LumiGate serves lumichat.html (injects CSP nonce)
  │
  ├── POST /lc/auth/register            → proxy to PB /api/collections/users/records
  ├── POST /lc/auth/login               → proxy to PB auth-with-password → set httpOnly lc_token cookie
  ├── POST /lc/auth/logout              → clear lc_token cookie
  ├── GET  /lc/auth/me                  → validate JWT locally → return user info
  │
  ├── GET    /lc/sessions               → PB list (user filter, sort -updated)
  ├── POST   /lc/sessions               → PB create
  ├── PATCH  /lc/sessions/:id/title     → PB update title
  ├── DELETE /lc/sessions/:id           → PB delete (PB cascades messages + files)
  │
  ├── GET    /lc/sessions/:id/messages  → PB list, sort +created, perPage=200 (no pagination)
  ├── POST   /lc/messages               → PB create message record
  │
  ├── POST   /lc/files                  → multipart → PB file storage → return { id, url }
  │
  └── POST   /v1/:provider/v1/chat/completions  → existing AI proxy (extended to accept lc_token)
```

---

## 4. LumiGate Backend Changes

### New env vars
```
PB_URL=http://localhost:8090
PB_LUMICHAT_PROJECT=_pb_users_auth_   # collection namespace
```

No PB admin credentials needed at runtime — all operations use the user's own PB JWT. Collection setup (one-time) is done manually via PB admin UI or migration script.

### JWT validation (no per-request round-trip to PB)
PocketBase signs JWTs with an HMAC-SHA256 key stored in `pb_data/data.db`. LumiGate validates JWTs locally:

```js
import jwt from 'jsonwebtoken';

// PB_JWT_SECRET loaded from PB's data.db at startup, or configured as env var
function validateLcToken(token) {
  try {
    return jwt.verify(token, PB_JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}
```

**Alternative (simpler, no jwt lib needed)**: Call `GET /api/collections/users/auth-refresh` only when the token is within 5 minutes of expiry (check `exp` claim locally first). On valid non-expiring tokens, skip the PB round-trip entirely.

**Chosen approach**: Decode JWT locally (`Buffer.from(token.split('.')[1], 'base64url')`), check `exp`, check `collectionId`. No extra npm dependency. If expired → 401. No PB call needed for validation.

```js
function requireLcAuth(req, res, next) {
  const token = req.cookies?.lc_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (payload.exp * 1000 < Date.now()) return res.status(401).json({ error: 'Session expired' });
    req.lcUser = payload; // { id, email, collectionId, ... }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
```

**Authorization model**: LumiGate never uses `req.lcUser.id` to construct PB filter queries. All PB API calls forward the raw `lc_token` as `Authorization: Bearer <token>` — PB enforces ownership and row-level access. `req.lcUser` is used only for logging and rate-limiting. This closes the unverified-payload identity-scoping risk without requiring HMAC key extraction.

### Cookie config
```js
res.cookie('lc_token', pbToken, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'Strict',
  path: '/',          // must be '/' — needed for /v1/* AI proxy routes
  maxAge: 7 * 24 * 60 * 60 * 1000  // 7 days (match PB token TTL)
});
```

### Body limit for file uploads
The existing 10MB limit on `express.json()` is preserved. The `/lc/files` route uses `multer` (already available or added) with its own limits:

```js
const lcUpload = multer({
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max for video
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => cb(null, `lc-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  }),
});
// Files are streamed from disk to PB, then unlinked. Never loaded into heap.
// Required: import os from 'os'
app.post('/lc/files', requireLcAuth, lcUpload.single('file'), handleLcFileUpload);
```

The multer middleware is registered only on `/lc/files` — it does not affect the existing 10MB express.json limit on all other routes.

### AI proxy extension
The existing proxy auth middleware checks, in order: admin session → project key → ephemeral token → HMAC. A new check is added: **LumiChat token**.

```js
// After existing auth checks, before proxy fires:
if (!projectName && req.cookies?.lc_token) {
  const payload = validateLcTokenPayload(req.cookies.lc_token);
  if (payload) {
    projectName = '_lumichat';   // reserved internal project
    req._proxyProjectName = '_lumichat';
    req._proxyProject = LUMICHAT_PROXY_PROJECT; // { maxRpm: 120, privacyMode: false, ... }
  }
}
```

`LUMICHAT_PROXY_PROJECT` is a hardcoded in-memory config object (not in projects.json). Rate limits for LumiChat users are set in `data/settings.json` under a `lumichatRpm` key, defaulting to 120 RPM shared across all LumiChat users.

### Rate limiting for AI title generation
Title generation requests include a custom header `X-LumiChat-Internal: title`. The proxy middleware deducts these from a separate counter (not the user-visible RPM limit). Maximum 1 in-flight title generation per session.

### New routes summary
```js
// Auth (no auth required)
app.post('/lc/auth/register', lcAuthRegister);
app.post('/lc/auth/login', lcAuthLogin);      // sets lc_token cookie
app.post('/lc/auth/logout', lcAuthLogout);    // clears cookie
app.get('/lc/auth/me', requireLcAuth, lcAuthMe);

// Sessions
app.get('/lc/sessions', requireLcAuth, lcListSessions);
app.post('/lc/sessions', requireLcAuth, lcCreateSession);
app.patch('/lc/sessions/:id/title', requireLcAuth, lcUpdateTitle);
app.delete('/lc/sessions/:id', requireLcAuth, lcDeleteSession);

// Messages
app.get('/lc/sessions/:id/messages', requireLcAuth, lcListMessages);
app.post('/lc/messages', requireLcAuth, lcCreateMessage);

// Files
app.post('/lc/files', requireLcAuth, lcUpload.single('file'), lcUploadFile);
app.get('/lc/files/serve/:id', requireLcAuth, lcServeFile);            // stream file from PB
app.post('/lc/files/gemini-upload/:pbFileId', requireLcAuth, lcGeminiUpload); // upload to Gemini File API

// Static
app.get('/lumichat', (req, res) => res.sendFile('lumichat.html', { nonce: generateNonce() }));
```

---

## 5. File Handling

### Strategy by type

| Type | Size limit | Pre-AI step | AI delivery | PB upload timing |
|------|-----------|------------|-------------|-----------------|
| Image (jpg/png/gif/webp) | 20MB | FileReader → base64 | base64 in `image_url` | After AI request fires (async) |
| PDF | 50MB | pdf.js text extraction | text in message content | After AI request fires (async) |
| Excel/CSV | 20MB | SheetJS → CSV text | text in message content | After AI request fires (async) |
| Audio | 25MB | FileReader → base64 | base64 in `input_audio` | After AI request fires (async) |
| Video | 500MB | Upload to PB first (blocking) → get public URL → proxy via `/lc/files/proxy/:id` | URL sent to Gemini File API via LumiGate | Blocking (before AI request) |

### Video + Gemini File API
PocketBase file URLs (`localhost:8090/...`) are internal and unreachable by Gemini. Solution:

1. User selects video → LumiGate uploads to PB (returns file ID)
2. LumiGate exposes `/lc/files/serve/:id` — a streaming proxy that fetches from PB and streams to the caller
3. This URL is not sent to Gemini directly either (it's behind auth)
4. Instead: LumiGate uploads the video to **Gemini File API** server-side:
   ```
   POST /lc/files/gemini-upload/:pbFileId
   → LumiGate fetches file from PB
   → uploads to generativelanguage.googleapis.com/upload/v1beta/files
   → returns { geminiFileUri: "files/xyz123" }
   ```
5. Frontend uses `geminiFileUri` in the message to Gemini

This means video upload has two steps: PB upload + Gemini File API upload. Both happen server-side. Total upload time is the bottleneck.

### Background sync failure handling
For async uploads (images, PDF, audio):
- Frontend keeps a local `pendingUploads` Map: `{ localId → { blob, mime, sessionId } }`
- On upload success: remove from map, update message `file_ids` via PATCH
- On upload failure: retry up to 3 times with exponential backoff
- On page unload with pending uploads: show browser `beforeunload` warning
- Message is saved to PB with `file_ids: []` initially; PATCH adds IDs when uploads complete

---

## 6. Frontend (lumichat.html)

### Libraries (all served locally, no CDN)
- `marked.js` — markdown parsing
- `DOMPurify` — sanitize marked output before innerHTML assignment
- `highlight.js` — code block syntax highlighting
- `pdf.js` — client-side PDF text extraction
- `SheetJS (xlsx.js)` — client-side Excel/CSV parsing

All JS files served from `/public/lumichat-libs/` by LumiGate.

### UI Layout
```
┌──────────────────────────────────────────────────────────┐
│ [≡]  LumiChat              [provider] [model]  [👤 user] │
├──────────────┬───────────────────────────────────────────┤
│  [+ New]     │                                           │
│              │   Session title  (click to rename)        │
│  ──────────  │  ─────────────────────────────────────    │
│  Today       │                                           │
│  > Session A │   [user message bubble]                   │
│  > Session B │                                           │
│  ──────────  │   [assistant bubble with markdown]        │
│  Yesterday   │     code blocks, bold, lists              │
│  > Session C │                                           │
│              │  ─────────────────────────────────────    │
│  [Load more] │   [📎] [file chips]                       │
│              │   [textarea                      ] [▲]    │
└──────────────┴───────────────────────────────────────────┘
```

### Security (no exceptions)
- **Event handling**: all dynamic elements use `data-*` attributes + `addEventListener`. Zero `onclick="..."` template strings anywhere in lumichat.html.
- **User content**: always `textContent` for direct insertion. Never `innerHTML` with user-controlled strings.
- **Markdown**: `el.innerHTML = DOMPurify.sanitize(marked.parse(content))` — DOMPurify is mandatory.
- **CSP nonce**: LumiGate generates a fresh nonce per `/lumichat` page load. CSP header: `script-src 'self' 'nonce-{n}'; style-src 'self' 'nonce-{n}'`. No `unsafe-inline`.
- **Cookie**: `httpOnly`, `SameSite=Strict`, `Secure` in prod, `path=/`.
- **File type validation**: check both MIME type and file extension. Reject mismatches.

### Session management
- On load: fetch `/lc/sessions` → render sidebar; if no sessions, show empty state
- Clicking a session: fetch `/lc/sessions/:id/messages` (perPage=200, sort=+created) → render all
- New chat: create session locally (temp ID) → POST to PB on first message send
- Delete session: DELETE `/lc/sessions/:id` → PB cascades; remove from sidebar

### Message rendering
- User messages: `textContent` (no markdown)
- Assistant messages: `DOMPurify.sanitize(marked.parse(content))` → `innerHTML`
- Streaming: append chunks to `fullText`, call `scheduleRender()` (rAF-debounced)
- Code blocks: `highlight.js` applied after marked renders

### AI title generation
After first assistant reply completes:
1. Check session title is still "New Chat"
2. Send background fetch to cheapest available model (not Anthropic — compat path may be slow)
3. Prompt: `"Summarize this conversation in max 5 words for a chat history title. Reply with ONLY the title, no quotes."`
4. Include header `X-LumiChat-Internal: title` (excluded from user RPM)
5. On response: PATCH `/lc/sessions/:id/title` → update sidebar

### History truncation
- Fetch all messages from PB (perPage=200) — displayed in full
- When sending to AI: slice last 40 messages
- Display a subtle indicator: "🔢 Sending last 40 of N messages to AI" when truncation occurs

---

## 7. Implementation Sequence

Security hardening happens **before** frontend development begins.

1. **Fix existing LumiGate XSS** (HIGH-1/2/3 from audit): onclick → data-* pattern, deployMode textContent
2. **Add CSP nonce** to LumiGate for `/lumichat` route (and optionally dashboard)
3. **PocketBase collections**: create `lc_sessions`, `lc_messages`, `lc_files` via PB admin UI with correct cascade settings
4. **LumiGate backend**: env vars, `requireLcAuth`, `/lc/auth/*` routes, cookie config
5. **LumiGate backend**: `/lc/sessions/*` and `/lc/messages` routes
6. **LumiGate backend**: `/lc/files` upload route + multer
7. **LumiGate backend**: AI proxy `lc_token` extension, `_lumichat` internal project
8. **lumichat.html**: auth flow (login/register/logout)
9. **lumichat.html**: sidebar + session management UI
10. **lumichat.html**: message rendering + streaming (text only first)
11. **lumichat.html**: file upload (images, PDF, Excel, audio — base64/extraction path)
12. **lumichat.html**: video upload + Gemini File API server-side proxy
13. **lumichat.html**: background PB sync for async uploads
14. **lumichat.html**: AI session title generation
15. **Polish**: animations, mobile responsive, error states, loading skeletons

---

## 8. Out of Scope (v1)

- Voice input/push-to-talk
- Multi-user collaboration on a session
- Message editing or regeneration
- Plugin / tool-calling UI
- Mobile native app
- Public sharing of sessions
