"use strict";

/**
 * FurNote API smoke test.
 * Covers: auth -> pet profile -> chat message -> rag search -> report generate/list.
 *
 * Usage:
 *   node tests/furnote-smoke.spec.js
 *   BASE_URL=http://127.0.0.1:9471 node tests/furnote-smoke.spec.js
 */

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:9471";
const EMAIL = `fn_smoke_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`;
const PASSWORD = "Passw0rd!Passw0rd!";

function fail(msg, details) {
  console.error("[FAIL]", msg);
  if (details) console.error(typeof details === "string" ? details : JSON.stringify(details, null, 2));
  process.exit(1);
}

async function jreq(path, opts = {}, token = "") {
  const headers = {
    "content-type": "application/json",
    ...(opts.headers || {}),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

function expectOk(name, result) {
  if (!result.ok) fail(`${name} failed`, result);
}

async function main() {
  console.log("[info] BASE_URL =", BASE_URL);

  const reg = await jreq("/fn/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email: EMAIL,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    }),
  });
  expectOk("register", reg);
  const login = await jreq("/fn/auth/login", {
    method: "POST",
    body: JSON.stringify({
      identity: EMAIL,
      password: PASSWORD,
    }),
  });
  expectOk("login", login);
  if (!login.body?.token) fail("login did not return token", login.body);
  const token = login.body.token;
  console.log("[ok] register + login");

  const profile = await jreq("/fn/auth/me", { method: "GET" }, token);
  expectOk("auth me", profile);
  const ownerId = profile.body?.user?.id || "";
  if (!ownerId) fail("auth me missing user id", profile.body);
  console.log("[ok] auth me owner =", ownerId);

  const petLocalId = `pet-${Date.now()}`;
  const pet = await jreq("/api/domains/fn/pets", {
    method: "POST",
    body: JSON.stringify({
      local_id: petLocalId,
      name: "Milo",
      species: "cat",
      sex: "male",
      owner_note: "smoke-test",
    }),
  }, token);
  expectOk("create pet", pet);
  console.log("[ok] create pet");

  const convLocalId = `conv-${Date.now()}`;
  const conv = await jreq("/api/domains/fn/conversations", {
    method: "POST",
    body: JSON.stringify({
      local_id: convLocalId,
      pet_local_id: petLocalId,
      title: "Smoke Conversation",
      mode: "chat",
    }),
  }, token);
  expectOk("create conversation", conv);

  const msg = await jreq("/api/domains/fn/messages", {
    method: "POST",
    body: JSON.stringify({
      local_id: `msg-${Date.now()}`,
      conversation_local_id: convLocalId,
      role: "user",
      content: "猫咪打喷嚏两天了怎么办？",
    }),
  }, token);
  expectOk("create message", msg);
  console.log("[ok] conversation + message");

  const rag = await jreq("/api/fn/rag/search", {
    method: "POST",
    body: JSON.stringify({
      query: "喷嚏",
      top_k: 5,
      scope_mode: "project_then_shared",
    }),
  }, token);
  expectOk("rag search", rag);
  if (!Array.isArray(rag.body?.chunks)) fail("rag search missing chunks[]", rag.body);
  console.log("[ok] rag search chunks =", rag.body.chunks.length);

  const report = await jreq("/api/fn/reports/generate", {
    method: "POST",
    body: JSON.stringify({
      period: "weekly",
      pet_local_id: petLocalId,
    }),
  }, token);
  if (!(report.ok || report.status === 202)) fail("report generate failed", report);
  console.log("[ok] report generate status =", report.status);

  const snapshots = await jreq("/api/fn/reports/snapshots?limit=5", {
    method: "GET",
  }, token);
  expectOk("report snapshots", snapshots);
  if (!Array.isArray(snapshots.body?.items)) fail("report snapshots missing items[]", snapshots.body);
  console.log("[ok] report snapshots items =", snapshots.body.items.length);

  console.log("[pass] furnote smoke ok");
}

main().catch((err) => fail("unexpected error", err?.stack || err?.message || String(err)));
