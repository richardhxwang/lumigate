"use strict";

function createInternalHttpBridge(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const port = options.port;
  const authKey = options.authKey;

  async function postJson(path, body) {
    const r = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authKey}`,
      },
      body: JSON.stringify(body || {}),
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data: d };
  }

  return {
    async visionAnalyze(toolInput) {
      const out = await postJson("/platform/vision/analyze", {
        image_url: toolInput.image_url,
        prompt: toolInput.prompt,
        detail: toolInput.detail,
      });
      if (!out.ok) throw new Error(out.data.error || out.data.message || `Vision analyze failed (${out.status})`);
      return { data: out.data };
    },

    async codeRun(toolInput) {
      const out = await postJson("/platform/code/run", toolInput || {});
      if (!out.ok && out.data && Object.keys(out.data).length) return { data: out.data };
      if (!out.ok) throw new Error(`Code run failed (${out.status})`);
      return { data: out.data };
    },

    async sandboxExec(toolInput) {
      const out = await postJson("/platform/sandbox/exec", toolInput || {});
      if (!out.ok && out.data && Object.keys(out.data).length) return { data: out.data };
      if (!out.ok) throw new Error(`Sandbox exec failed (${out.status})`);
      return { data: out.data };
    },

    async ragRetrieve(toolInput) {
      const out = await postJson("/platform/rag/retrieve", toolInput || {});
      if (!out.ok && out.data && Object.keys(out.data).length) return { data: out.data };
      if (!out.ok) throw new Error(`RAG retrieve failed (${out.status})`);
      return { data: out.data };
    },

    async ragTrace(toolInput) {
      const out = await postJson("/platform/rag/trace", toolInput || {});
      if (!out.ok && out.data && Object.keys(out.data).length) return { data: out.data };
      if (!out.ok) throw new Error(`RAG trace failed (${out.status})`);
      return { data: out.data };
    },
  };
}

module.exports = { createInternalHttpBridge };
