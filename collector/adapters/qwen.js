const crypto = require('node:crypto');
const BaseAdapter = require('./base');

// Map Dashscope API model IDs → Qwen web chat model IDs
const QWEN_MODEL_MAP = {
  'qwen-flash': 'qwen3.5-flash',
  'qwen-turbo': 'qwen3.5-flash',
  'qwen3.5-plus': 'qwen3.5-plus',
  'qwen3-max': 'qwen3-max-2026-01-23',
  'qwen-long': 'qwen3.5-plus',
  'qwen-max': 'qwen-max-latest',
};

class QwenAdapter extends BaseAdapter {
  constructor(credentials) {
    super('qwen', credentials);
    const cred = typeof credentials === 'string' ? JSON.parse(credentials) : credentials;
    this.sessionToken = cred.sessionToken || '';
    this.cookie = cred.cookie || `qwen_session=${this.sessionToken}`;
    this.userAgent = cred.userAgent || this.defaultUA;
    this.baseUrl = 'https://chat.qwen.ai';
  }

  getHeaders(accept = 'application/json') {
    return {
      'Content-Type': 'application/json',
      Accept: accept,
      'User-Agent': this.userAgent,
      Referer: `${this.baseUrl}/`,
      Origin: this.baseUrl,
      Cookie: this.cookie,
    };
  }

  async createChat(signal) {
    const res = await fetch(`${this.baseUrl}/api/v2/chats/new`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Qwen create chat failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const chatId = data.data?.id ?? data.chat_id ?? data.id ?? data.chatId;
    if (!chatId) throw new Error('Qwen: no chat_id in response');
    return chatId;
  }

  async *chat(messages, model, signal) {
    const chatId = await this.createChat(signal);
    const resolvedModel = QWEN_MODEL_MAP[model] || model || 'qwen3.5-plus';
    const prompt = messages.map(m => m.content).join('\n\n');
    const fid = crypto.randomUUID();

    const requestBody = {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: resolvedModel,
      parent_id: null,
      messages: [{
        fid,
        parentId: null,
        childrenIds: [],
        role: 'user',
        content: prompt,
        user_action: 'chat',
        files: [],
        timestamp: Math.floor(Date.now() / 1000),
        models: [resolvedModel],
        chat_type: 't2t',
        feature_config: { thinking_enabled: true, output_schema: 'phase' },
      }],
    };

    const res = await fetch(`${this.baseUrl}/api/v2/chat/completions?chat_id=${chatId}`, {
      method: 'POST',
      headers: this.getHeaders('text/event-stream'),
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new Error('Qwen authentication failed. Please update your session token.');
      }
      throw new Error(`Qwen API error: ${res.status} ${errText}`);
    }

    // Parse SSE stream — Qwen uses standard SSE format
    let emittedContent = false;
    for await (const line of this.splitSSELines(this.readStream(res))) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') break;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        // Skip thinking phase — only emit output phase content
        if (delta.phase === 'think') continue;
        const content = delta.content;
        if (content) {
          emittedContent = true;
          yield this.formatSSE(this.toOpenAIChunk(content, resolvedModel));
        }
        const finishReason = parsed.choices?.[0]?.finish_reason;
        if (finishReason) {
          yield this.formatSSE(this.toOpenAIChunk(null, resolvedModel, finishReason));
        }
      } catch {}
    }

    if (!emittedContent) {
      yield this.formatSSE(this.toOpenAIChunk('', resolvedModel, 'stop'));
    }
    yield this.formatDone();
  }
}

module.exports = QwenAdapter;
