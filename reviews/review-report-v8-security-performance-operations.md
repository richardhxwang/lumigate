# LumiGate Security / Performance / Operations Review (v8)

Date: 2026-03-11  
Scope: `server.js`, `nginx/nginx.conf`, Docker runtime behavior, install/publish path  
Test env: isolated Compose project `lumigate_review_v8` on port `19475` using `reviews/docker-compose.test.yml`

## Executive Summary

- Core controls are effective: unauthenticated admin/proxy access is blocked, malformed cookie no longer crashes auth, and restart resilience stays stable under probe traffic.
- Performance remains strong for a single-node setup, but high-concurrency tail latency on `/health` is still wide under bursty conditions.
- Main operational gap is distribution readiness: Docker Hub package availability and multi-arch consistency need to be fully closed to support one-command install everywhere.

## Findings (Ordered by Severity)

### High

1. Docker package distribution is not yet universally pullable by default platform.
   - Evidence:
     - `docker pull richardhwang920/lumigate:latest` failed on ARM host without `--platform linux/amd64`.
     - Docker Hub tag exists but includes only `linux/amd64` runtime image at test time.
   - Risk:
     - "One-line install" fails for ARM users, causing onboarding breakage and support churn.
   - Recommendation:
     - Publish both `linux/amd64` and `linux/arm64` for Docker Hub and GHCR in CI (already started in workflow update; verify final tags include both architectures).

### Medium

1. Oversized body error semantics are inconsistent at edge vs app layer.
   - Evidence:
     - Oversized login request returned `413` with HTML response body (Nginx page), not JSON.
   - Risk:
     - Client integrations expecting JSON may fail parse/retry logic.
   - Recommendation:
     - Align `413` response format at Nginx layer to match API JSON contract, or clearly document edge-level HTML behavior.

2. Dependency audit pipeline is currently non-actionable.
   - Evidence:
     - `npm audit --omit=dev --audit-level=high` returned `400 Invalid package tree`.
   - Risk:
     - Vulnerability visibility in CI/local review is reduced.
   - Recommendation:
     - Regenerate lockfile in a clean environment and enforce `npm ci` + `npm audit` pass in CI.

### Low

1. Cookie-based admin session can appear to fail in plain HTTP CLI probes due to `Secure` cookie behavior.
   - Evidence:
     - Login + cookie-jar probe returned 401 for backup endpoints over HTTP.
     - Same endpoints succeed with `x-admin-token` header (`200`/`200`).
   - Risk:
     - Confusing operator diagnostics during local testing.
   - Recommendation:
     - Add explicit note in docs: CLI/API testing should use `x-admin-token` in HTTP local mode.

## Test Results

### 1) Security Tests

- Health endpoint:
  - `GET /health` => `200` with expected JSON status payload.
- Auth protection:
  - `GET /admin/projects` without auth => `401`.
  - Proxy call without project key => `401`.
- Malformed cookie robustness:
  - `GET /admin/auth` with malformed cookie => `{"authenticated":false}` (no crash).
- Oversized payload handling:
  - `POST /admin/login` with >10MB body => `413`.
- Rate limiting:
  - 12 repeated failed logins => `2` responses with `429`.
- Input/protocol abuse:
  - Path traversal probe (`/models/../../etc/passwd`) => `404`.
  - Method tampering (`TRACE /health`) => `405`.

### 2) Performance Tests

Tool: ApacheBench (`ab`)

- `/health` stress:
  - Command: `ab -n 5000 -c 200 http://localhost:19475/health`
  - Result: `1390.62 req/s`, errors `0`, p95 `1081ms`, p99 `2384ms`.
- Dashboard `/` stress:
  - Command: `ab -n 2000 -c 100 http://localhost:19475/`
  - Result: `787.87 req/s`, errors `0`, p95 `139ms`, p99 `1852ms`.

Resource snapshot after tests:
- App container: `50.15 MiB`
- Nginx container: `10.04 MiB`

### 3) Operations Tests

- Backup operations with admin header token:
  - `POST /admin/backup` => `200`
  - `GET /admin/backups` => `200`
- Restart resilience:
  - Health probe loop during app container restart:
  - Result: `ok=40 fail=0` (no observed downtime at probe interval).
- Isolated environment integrity:
  - Review stack ran under dedicated project and port; production stack remained untouched.

## What Is Working Well

- Authentication middleware and admin endpoint gating are effective.
- Defensive handling for malformed cookies is stable.
- Backup module availability and control path are functional in enterprise mode.
- Nginx buffering/caching behavior masks brief app restarts in observed probe scenario.

## Recommended Next Actions

1. Complete multi-arch publishing validation on Docker Hub (`amd64` + `arm64`) and re-test default `docker pull`.
2. Normalize edge `413` response format to JSON or document it clearly for API clients.
3. Fix lockfile/audit workflow so dependency vulnerability checks are consistently executable.
4. Add a short "local auth testing" note in README (`x-admin-token` for HTTP local probes).

## Commands Executed (Representative)

- `node -c server.js`
- `npm audit --omit=dev --audit-level=high`
- `docker compose -p lumigate_review_v8 -f reviews/docker-compose.test.yml up -d --build`
- `ab -n 5000 -c 200 http://localhost:19475/health`
- `ab -n 2000 -c 100 http://localhost:19475/`
- `docker stats --no-stream ...`
