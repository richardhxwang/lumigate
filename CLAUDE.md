# LumiGate — Project-Focused Dev Guide

## What this repo is
Self-hosted multi-provider AI gateway (Express + Nginx + Docker), optimized for SME and low-memory hosts.
Chat UI: `public/lumichat.html` (LumiChat). Dashboard: `public/index.html`.

## Run (most common)
```bash
docker compose up -d --build              # prod — ALWAYS use --build when changing any file in public/ or server.js
docker compose -f reviews/docker-compose.test.yml -p ai-api-proxy-test up -d --build  # isolated test
node server.js                            # direct dev run
```

## ⚠️ CRITICAL: Docker deployment rule
`public/` is baked into the Docker image — NOT volume-mounted.
**`docker compose restart` does NOT pick up file changes.**
You MUST run `docker compose up -d --build lumigate` after every edit to server.js or public/*.

## Verify quickly
```bash
node -c server.js
curl http://localhost:9471/health
```

## Files that matter first
- `server.js`: auth, modules, proxy, usage, backup/audit/metrics APIs
- `public/lumichat.html`: LumiChat UI — SSE streaming, PocketBase auth, settings modal
- `nginx/nginx.conf`: reverse proxy, health fallback, security headers
- `public/index.html`: dashboard + admin flows
- `docker-compose.yml`: prod deployment
- `reviews/docker-compose.test.yml`: isolated test/chaos environment

## Project rules (high signal)
- Keep port `9471` as default.
- Keep `/providers` response fields `baseUrl` + `available` (UI relies on both).
- Keep all data writes atomic (`*.tmp` + rename), never write partial JSON directly.
- Never log secrets (`ADMIN_SECRET`, API keys, tunnel tokens).
- Use `safeEqual()` for secret comparison; do not replace with plain equality.
- Keep 10MB body limit unless there is a scoped and tested reason to change it.

## Mode policy
- `lite`: keep data-plane security/perf behavior; trim management modules only.
- `enterprise`: enable governance modules (`audit`, `metrics`, `backup`, etc.).
- Any mode change must be root-controlled and clearly visible in UI/health output.

## Before merging changes
1. Syntax check passes: `node -c server.js`
2. Health endpoint responds: `curl http://localhost:9471/health`
3. Auth/limit behavior unchanged unless intentionally modified.
4. If touching proxy paths, verify `/v1/{provider}/...` compatibility.
5. Rebuild Docker image: `docker compose up -d --build lumigate`

---

## LumiChat UI — Design & Style Rules

### Visual style: macOS 26 / Apple HIG
- **No emoji anywhere in UI.** Use flat monochrome SVG icons only. Emoji in buttons, status icons, mode indicators etc. must all be replaced with SVG.
- **Frosted glass**: `backdrop-filter: blur(16-28px) saturate(160%)` with semi-transparent backgrounds.
- **Dark mode base**: `--bg:#212121`, `--sb:#171717`, `--inp:#2f2f2f`
- **Light mode base**: `--bg:#ffffff`, `--sb:#f7f7f8`, `--inp:#f4f4f5`
- **Accent**: `#10a37f` (green), hover `#0d9268`
- **Border radii** (CSS vars, always use these):
  - `--r1: 8px` — chips, tags, small buttons
  - `--r2: 12px` — inputs, cards
  - `--r3: 16px` — dropdowns, medium panels
  - `--r4: 20px` — sheets
  - `--r5: 26px` — large modals, auth card
- **Typography**: `-apple-system, BlinkMacSystemFont, system-ui, sans-serif`
- Style reference: ChatGPT / Apple Settings.app / macOS 26 Liquid Glass

### Send button
- Circular (`border-radius: 50%`), frosted glass style
- Dark: `rgba(255,255,255,0.15)` bg, `rgba(255,255,255,0.22)` border
- Light: `rgba(0,0,0,0.08)` bg, `rgba(0,0,0,0.14)` border
- Hover: scale(1.06), Active: scale(0.94)

### Model header label
- Default shows current selected model name (NOT "LumiChat")
- Use `fmtModel(id)` to strip date suffixes: `gpt-4o-2024-11-20` → `gpt-4o`
- Update `mdlLabel.textContent = fmtModel(selectedModel)` on login, model select, session load

### Provider pill (model dropdown)
- Selected pill dark mode: white text on accent bg
- Selected pill light mode: **black text** (`color:#000!important`) on slightly darker accent — NOT white (white is invisible on light bg)

### Input bar alignment
- `#preset-pick-wrap`: `display:flex; align-items:center` so it aligns with `.tb` buttons (height 32px)
- `#preset-pick-btn`: `height:32px; padding:0 6px` to match toolbar button height

### SSE streaming performance
- Use a `Text node` approach: `streamNode = document.createTextNode(''); aEl.appendChild(streamNode)`
- In rAF: `streamNode.data += pendingDelta; pendingDelta = ''` — do NOT do `textContent = fullString`
- Full-string replacement gets progressively slower as response grows
- Auto-scroll: only scroll if `scrollHeight - clientHeight - scrollTop < 120` (avoid scroll when user is reading up)
- On stream end: `streamEl.textContent = ''` then call `renderMarkdown(streamEl, streamText)`

### Settings modal
- Large centered modal (macOS Settings.app style), NOT a small panel
- Tabs: Chat | Presets | Appearance
- Response Mode: flat SVG icons (lock, clock, lightbulb, dashed-lock), monochrome, color on select

### Preset system
- `BUILTIN_PRESETS` array with 10 built-in templates (Encourager, Witty, Professional, Coder, Medical, Translator, Tutor, Concise, Creative Writer, Devil's Advocate)
- User clicks chip → instantly added to "My Presets" with `builtinKey` stored
- Used templates show greyed-out (`.used` class, `pointer-events:none`)
- Max 8 user presets enforced

### PocketBase auth
- JWT only contains `id`, `email`, `collectionId`, `exp` — NOT `name` or `avatar`
- Must fetch full user record via `GET /lc/auth/me` to get name/avatarUrl
- Display name: use `currentUser.name || emailPrefix` where `emailPrefix = email.split('@')[0]`
- Avatar initial: first char of display name, uppercased

### Session keepalive
- Track activity via `mousemove/keydown/click/touchstart/scroll`
- Refresh PB token every 30min IF user was active in last 10min
- Server endpoint: `POST /lc/auth/refresh` → calls PB `/api/collections/users/auth-refresh`

### Mid-stream message handling
- New message during stream: queue in `pendingQueue`, process in `finally` block
- Do NOT abort current stream (Claude Code style — treat as additional context)

---

## LumiChat — Technical Notes

### Key JS globals
```js
let selectedProvider, selectedModel       // current selection
let streamEl, streamText, streamNode, pendingDelta  // SSE state
let rafId                                 // requestAnimationFrame id
```

### localStorage keys
- `lc_settings` — `{memory, sensitivity, presets[], compact}`
- `lc_theme` — `'light'` or `'dark'`
- `lc_compact` — `'1'` or `''`

### Sensitivity (Response Mode)
- 4 levels: `strict`, `default`, `creative`, `unrestricted`
- Mapped to system prompt directives in `SENS_PROMPTS`
- Saved in `lc_settings.sensitivity`, persists across sessions

### `getActiveSystemPrompt()`
Concatenates: global memory + sensitivity directive + active preset prompt

### HMAC signing (for project auth mode)
```
timestamp + nonce + JSON.stringify(body) → HMAC-SHA256(projectKey, payload)
Headers: X-Signature, X-Timestamp, X-Nonce
```
