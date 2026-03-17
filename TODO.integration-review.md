# Integration TODO (ai-api-proxy <-> pocketbase)

## P0 - Immediate

- [ ] Strengthen LumiChat token auth on high-cost paths.
  - `/v1/chat` and `/lc/chat/gemini-native` must verify `lc_token` against PocketBase (not payload decode only).
- [ ] Lock down OAuth redirect handling.
  - Accept only relative redirects or allowlisted custom app schemes.
  - Reject/normalize all other redirects to `/lumichat`.
- [ ] Fix `/lc/auth/check-email` filter construction.
  - Build PB filter expression correctly (avoid malformed encoding and false negatives).
- [ ] Restore BYOK create-path compatibility.
  - Current PB migration sets `lc_user_apikeys.createRule=""`, so user-token create fails.
  - Route should create through server-side PB admin token with explicit `user=req.lcUser.id`.

## P1 - Near term

- [ ] Align PB create rules with gateway assumptions.
  - `lc_sessions`, `lc_files`, `lc_projects`, `lc_user_settings` create rules should enforce ownership at record creation (`user=@request.auth.id` style constraints where applicable).
- [ ] Add LumiChat to PB multi-project routing plan.
  - PB runs with `PB_MULTI_PROJECT=1`, but current LumiChat data path is still default `/api/collections/*`.
  - Decide: keep LumiChat in default DB intentionally, or move to `/api/p/{project}` and add `lumichat` project config/migrations.
- [ ] Reduce host coupling.
  - Replace fragile `host.docker.internal` dependency with explicit internal routing/network strategy for deployment portability.

## P2 - Security hygiene

- [ ] Rotate and purge all committed secrets in both repos.
  - API keys, tunnel tokens, PB admin creds, superuser tokens.
  - Keep only placeholders in `.env.example`.
- [ ] Add automated secret scanning and pre-commit check.

## Verification checklist

- [ ] Login/OAuth still works on web and app deep-link.
- [ ] `/lc/auth/check-email` returns correct existence for real addresses.
- [ ] BYOK add/list/delete works end-to-end.
- [ ] Forged local JWT payload cannot access `/v1/chat` or `/lc/chat/gemini-native`.
- [ ] Existing non-LumiChat project-key auth paths still work.
