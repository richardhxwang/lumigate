/**
 * Provider 配置表 — 每个 provider 只是一个配置对象。
 *
 * BrowserAdapter 框架根据这些配置：
 *   1. 连接 Chrome，找到对应网站的 tab
 *   2. 用 buildRequest() 构造请求
 *   3. 在浏览器中执行 fetch()
 *   4. 用 parseResponse() 解析响应为内容块
 */
const crypto = require('node:crypto');

// ═══════════════════════════════════════════════
// 豆包 (Doubao)
// ═══════════════════════════════════════════════
const doubao = {
  name: 'doubao',
  baseUrl: 'https://www.doubao.com',
  pageMatch: 'doubao.com',
  cookieDomain: '.doubao.com',

  buildCookie(cred) {
    const parts = [];
    if (cred.sessionid) parts.push(`sessionid=${cred.sessionid}`);
    if (cred.ttwid) parts.push(`ttwid=${decodeURIComponent(cred.ttwid)}`);
    return parts.join('; ');
  },

  async buildRequest(messages, model, cred) {
    // Use only the last user message as prompt (豆包 web UI style)
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const prompt = lastUser?.content || messages.map(m => m.content).join('\n');

    const params = new URLSearchParams({
      aid: '497858', device_platform: 'web', language: 'zh',
      pkg_type: 'release_version', real_aid: '497858', region: 'CN',
      samantha_web: '1', sys_region: 'CN', use_olympus_account: '1',
      version_code: '20800',
    });

    return {
      url: `https://www.doubao.com/samantha/chat/completion?${params}`,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Referer: 'https://www.doubao.com/chat/',
        Origin: 'https://www.doubao.com',
        'Agw-js-conv': 'str',
      },
      body: {
        messages: [{
          content: JSON.stringify({ text: prompt }),
          content_type: 2001, attachments: [], references: [],
        }],
        completion_option: {
          is_regen: false, with_suggest: false, need_create_conversation: true,
          launch_stage: 1, is_replace: false, is_delete: false,
          message_from: 0, event_id: '0',
        },
        conversation_id: '0',
        local_conversation_id: `local_16${Date.now().toString().slice(-14)}`,
        local_message_id: crypto.randomUUID(),
      },
    };
  },

  parseResponse(rawText) {
    const chunks = [];
    for (const line of rawText.split('\n')) {
      const trimmed = line.trim();
      // 去掉 "data: " 前缀
      const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6).trim() : trimmed;
      if (!jsonStr || jsonStr === '[DONE]') continue;

      try {
        const raw = JSON.parse(jsonStr);
        // event_type 2005 = 错误/验证码
        if (raw.event_type === 2005) {
          const errStr = typeof raw.event_data === 'string' ? raw.event_data : '';
          if (errStr.includes('"type":"verify"') || errStr.includes('"subtype":"slide"')) {
            throw new Error('豆包触发了验证码，请在浏览器中完成滑块验证后重试');
          }
          let msg = 'unknown';
          try { msg = JSON.parse(errStr).message || msg; } catch {}
          throw new Error(`豆包错误: ${msg}`);
        }
        if (raw.event_type === 2003) continue; // end
        if (raw.event_type !== 2001 || !raw.event_data) continue;

        const result = JSON.parse(raw.event_data);
        if (result.is_finish) continue;
        const m = result.message;
        if (!m || ![2001, 2008].includes(m.content_type) || !m.content) continue;
        const content = JSON.parse(m.content);
        if (content.text) chunks.push({ content: content.text });
      } catch (e) {
        if (e.message?.includes('豆包')) throw e;
        // 尝试标准 SSE 格式
        try {
          const m = jsonStr.match(/id:\s*\d+\s+event:\s*(\S+)\s+data:\s*(.+)/);
          if (m) {
            const data = JSON.parse(m[2]);
            if (m[1] === 'CHUNK_DELTA' && data.text) chunks.push({ content: data.text });
          }
        } catch {}
      }
    }
    return chunks;
  },
};

// ═══════════════════════════════════════════════
// 通义千问 (Qwen)
// ═══════════════════════════════════════════════
const qwen = {
  name: 'qwen',
  baseUrl: 'https://chat.qwen.ai',
  pageMatch: 'qwen.ai',
  cookieDomain: '.qwen.ai',

  buildCookie(cred) {
    if (cred.sessionToken) return `qwen_session=${cred.sessionToken}`;
    return '';
  },

  // Qwen 需要先创建 chat session，再发消息
  async buildRequest(messages, model, cred, page) {
    const resolvedModel = model || 'qwen3.5-plus';
    const prompt = messages.map(m => m.content).join('\n\n');

    // Step 1: 在浏览器中创建 chat（后台，不抢焦点）
    const chatResult = await page.evaluate(async (baseUrl) => {
      try {
        const res = await fetch(`${baseUrl}/api/v2/chats/new`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!res.ok) return { ok: false, error: `${res.status}` };
        const data = await res.json();
        return { ok: true, chatId: data.data?.id ?? data.chat_id ?? data.id };
      } catch (e) { return { ok: false, error: String(e) }; }
    }, 'https://chat.qwen.ai');

    if (!chatResult.ok || !chatResult.chatId) {
      throw new Error(`Qwen 创建对话失败: ${chatResult.error}`);
    }

    const fid = crypto.randomUUID();
    return {
      url: `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatResult.chatId}`,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: {
        stream: true, version: '2.1', incremental_output: true,
        chat_id: chatResult.chatId, chat_mode: 'normal',
        model: resolvedModel, parent_id: null,
        messages: [{
          fid, parentId: null, childrenIds: [], role: 'user',
          content: prompt, user_action: 'chat', files: [],
          timestamp: Math.floor(Date.now() / 1000),
          models: [resolvedModel], chat_type: 't2t',
          feature_config: { thinking_enabled: true, output_schema: 'phase' },
        }],
      },
      timeoutMs: 300000,
    };
  },

  parseResponse(rawText) {
    const chunks = [];
    for (const line of rawText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') break;
      try {
        const obj = JSON.parse(data);
        const c = obj.choices?.[0]?.delta?.content;
        if (c) chunks.push({ content: c });
      } catch {}
    }
    return chunks;
  },
};

// ═══════════════════════════════════════════════
// ChatGPT
// ═══════════════════════════════════════════════
const chatgpt = {
  name: 'chatgpt',
  baseUrl: 'https://chatgpt.com',
  pageMatch: 'chatgpt.com',
  cookieDomain: '.chatgpt.com',

  async buildRequest(messages, model, cred, page) {
    const resolvedModel = model || 'gpt-4';
    const prompt = messages.map(m => m.content).join('\n\n');

    // Step 1: 获取 accessToken 和 deviceId（通过 session API）
    const session = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/auth/session', { credentials: 'include' });
        if (!r.ok) return { error: `session ${r.status}` };
        const d = await r.json();
        return { token: d.accessToken, deviceId: d.oaiDeviceId };
      } catch (e) { return { error: String(e) }; }
    });
    if (!session.token) throw new Error('ChatGPT: 无法获取 session，请重新登录');

    return {
      url: 'https://chatgpt.com/backend-api/conversation',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'oai-language': 'en-US',
        'oai-device-id': session.deviceId || crypto.randomUUID(),
        Authorization: `Bearer ${session.token}`,
      },
      body: {
        action: 'next',
        messages: [{
          id: crypto.randomUUID(),
          author: { role: 'user' },
          content: { content_type: 'text', parts: [prompt] },
        }],
        parent_message_id: crypto.randomUUID(),
        model: resolvedModel,
        timezone_offset_min: new Date().getTimezoneOffset(),
        history_and_training_disabled: false,
        conversation_mode: { kind: 'primary_assistant', plugin_ids: null },
        force_paragen: false, force_rate_limit: false, force_use_sse: true,
      },
    };
  },

  // ChatGPT 403 时用 DOM 模拟 fallback
  useDomFallback: true,

  parseResponse(rawText) {
    // ChatGPT 返回累计内容，需要计算 delta
    const chunks = [];
    let lastContent = '';
    for (const line of rawText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6).trim();
      if (data === '[DONE]') break;
      try {
        const obj = JSON.parse(data);
        const parts = obj.message?.content?.parts;
        if (parts && Array.isArray(parts)) {
          const full = parts.join('');
          if (full.length > lastContent.length) {
            chunks.push({ content: full.slice(lastContent.length) });
            lastContent = full;
          }
        }
      } catch {}
    }
    return chunks;
  },
};

// ═══════════════════════════════════════════════
// Kimi (Moonshot)
// ═══════════════════════════════════════════════
const kimi = {
  name: 'kimi',
  baseUrl: 'https://www.kimi.com',
  pageMatch: 'kimi.com',
  cookieDomain: '.kimi.com',

  // Kimi 使用 Connect RPC 二进制协议，但在浏览器中可以用 ArrayBuffer 处理
  async buildRequest(messages, model) {
    const prompt = messages.map(m => m.content).join('\n\n');
    const scenario = model?.includes('search') ? 'SCENARIO_SEARCH'
      : model?.includes('research') ? 'SCENARIO_RESEARCH'
      : model?.includes('k1') ? 'SCENARIO_K1' : 'SCENARIO_K2';

    // 返回特殊标记，让 page.evaluate 内部处理二进制编码
    return {
      _kimiRpc: true,
      scenario,
      prompt,
    };
  },

  parseResponse(rawText) {
    // rawText 是从 page.evaluate 返回的 JSON 文本数组
    try {
      const result = JSON.parse(rawText);
      if (result.error) throw new Error(`Kimi 错误: ${result.error}`);
      if (result.text) return [{ content: result.text }];
    } catch (e) {
      if (e.message?.includes('Kimi')) throw e;
    }
    return [];
  },
};

module.exports = { doubao, qwen, kimi };
