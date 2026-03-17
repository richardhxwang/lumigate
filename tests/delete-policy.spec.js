/**
 * Delete policy regression test for LumiChat PocketBase routes.
 *
 * Covers:
 * 1. project delete is blocked when sessions still reference it
 * 2. references endpoint reports dependent sessions
 * 3. project remap moves dependent sessions to another project
 * 4. session delete cascades messages
 * 5. project delete succeeds after dependent sessions are removed/remapped
 *
 * Run:
 *   node tests/delete-policy.spec.js
 */

const BASE = process.env.LC_API_BASE || "http://localhost:9471";
const EMAIL = process.env.LC_EMAIL || "test@lumigate.local";
const PASSWORD = process.env.LC_PASSWORD || "testpass123";

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

async function ensureTestAccount() {
  try {
    await fetch(`${BASE}/lc/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: EMAIL,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
        name: "Delete Policy Test User",
      }),
    });
  } catch {}
}

async function login() {
  const resp = await fetch(`${BASE}/lc/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!resp.ok) throw new Error(`Login failed: ${resp.status}`);
  const setCookie = resp.headers.get("set-cookie") || "";
  const tokenMatch = setCookie.match(/lc_token=([^;]+)/);
  if (!tokenMatch) throw new Error("No lc_token cookie returned");
  return tokenMatch[1];
}

async function api(path, { token, method = "GET", body } = {}) {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Cookie: `lc_token=${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { resp, data };
}

async function main() {
  await ensureTestAccount();
  const token = await login();
  const stamp = `dp-${Date.now()}`;

  log("Creating project...");
  const createdProject = await api("/lc/projects", {
    token,
    method: "POST",
    body: { name: `Delete Policy ${stamp}`, color: "#2274a5" },
  });
  if (!createdProject.resp.ok) throw new Error(`Project create failed: ${createdProject.resp.status} ${JSON.stringify(createdProject.data)}`);
  const projectId = createdProject.data.id;

  log("Creating target project for remap...");
  const targetProject = await api("/lc/projects", {
    token,
    method: "POST",
    body: { name: `Delete Policy Target ${stamp}`, color: "#44aa66" },
  });
  if (!targetProject.resp.ok) throw new Error(`Target project create failed: ${targetProject.resp.status} ${JSON.stringify(targetProject.data)}`);
  const targetProjectId = targetProject.data.id;

  log("Creating session under project...");
  const createdSession = await api("/lc/sessions", {
    token,
    method: "POST",
    body: { title: `Delete Session ${stamp}`, provider: "deepseek", model: "deepseek-chat", project: projectId },
  });
  if (!createdSession.resp.ok) throw new Error(`Session create failed: ${createdSession.resp.status} ${JSON.stringify(createdSession.data)}`);
  const sessionId = createdSession.data.id;

  log("Creating message under session...");
  const createdMessage = await api("/lc/messages", {
    token,
    method: "POST",
    body: { session: sessionId, role: "user", content: `Delete policy message ${stamp}` },
  });
  if (!createdMessage.resp.ok) throw new Error(`Message create failed: ${createdMessage.resp.status} ${JSON.stringify(createdMessage.data)}`);

  log("Checking project references...");
  const refs = await api(`/lc/projects/${projectId}/references`, { token });
  if (!refs.resp.ok) throw new Error(`References endpoint failed: ${refs.resp.status}`);
  if (!Array.isArray(refs.data.references) || !refs.data.references.some((ref) => ref.collectionKey === "sessions" && ref.count >= 1)) {
    throw new Error(`Expected session reference in project references: ${JSON.stringify(refs.data)}`);
  }

  log("Verifying project delete is blocked...");
  const blockedDelete = await api(`/lc/projects/${projectId}`, { token, method: "DELETE" });
  if (blockedDelete.resp.status !== 409) {
    throw new Error(`Expected 409 on project delete, got ${blockedDelete.resp.status} ${JSON.stringify(blockedDelete.data)}`);
  }

  log("Remapping session to target project...");
  const remap = await api(`/lc/projects/${projectId}/remap`, {
    token,
    method: "POST",
    body: { target_project_id: targetProjectId },
  });
  if (!remap.resp.ok) throw new Error(`Project remap failed: ${remap.resp.status} ${JSON.stringify(remap.data)}`);
  if (remap.data?.remap?.updatedCount < 1) throw new Error(`Expected at least 1 remapped session: ${JSON.stringify(remap.data)}`);

  log("Deleting session...");
  const deletedSession = await api(`/lc/sessions/${sessionId}`, { token, method: "DELETE" });
  if (!deletedSession.resp.ok) throw new Error(`Session delete failed: ${deletedSession.resp.status} ${JSON.stringify(deletedSession.data)}`);

  log("Checking messages were cascaded...");
  const messageList = await api(`/lc/sessions/${sessionId}/messages`, { token });
  if (!messageList.resp.ok) throw new Error(`Message list after delete failed: ${messageList.resp.status}`);
  if ((messageList.data.items || messageList.data || []).length !== 0) {
    throw new Error(`Expected 0 messages after session delete cascade: ${JSON.stringify(messageList.data)}`);
  }

  log("Deleting project after session removal...");
  const deletedProject = await api(`/lc/projects/${projectId}`, { token, method: "DELETE" });
  if (!deletedProject.resp.ok) {
    throw new Error(`Project delete after session cleanup failed: ${deletedProject.resp.status} ${JSON.stringify(deletedProject.data)}`);
  }

  log("Cleaning up target project...");
  const deletedTargetProject = await api(`/lc/projects/${targetProjectId}`, { token, method: "DELETE" });
  if (!deletedTargetProject.resp.ok) {
    throw new Error(`Target project cleanup failed: ${deletedTargetProject.resp.status} ${JSON.stringify(deletedTargetProject.data)}`);
  }

  log("PASS: delete policy regression passed.");
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
