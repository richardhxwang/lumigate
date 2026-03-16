const crypto = require('node:crypto');
const BaseAdapter = require('./base');

/**
 * ChatGPT Web Adapter — pure HTTP.
 *
 * Uses accessToken (obtained from /api/auth/session after browser login).
 * No Sentinel/Turnstile — works for basic requests but may get 403 under
 * heavy anti-bot enforcement. User can refresh token if blocked.
 */
class ChatGPTAdapter extends BaseAdapter {
  constructor(credentials) {
    super('chatgpt', credentials);
    const cred = typeof credentials === 'string' ? JSON.parse(credentials) : credentials;
    this.accessToken = cred.accessToken || '';
    this.cookie = cred.cookie || '';
    this.userAgent = cred.userAgent || this.defaultUA;
    this.baseUrl = 'https://chatgpt.com';
    this.deviceId = cred.deviceId || crypto.randomUUID();
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'oai-device-id': this.deviceId,
      'oai-language': 'en-US',
      Referer: `${this.baseUrl}/`,
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      Authorization: `Bearer ${this.accessToken}`,
      'User-Agent': this.userAgent,
      ...(this.cookie ? { Cookie: this.cookie } : {}),
    };
  }

  async init() {
    // Try to refresh accessToken from session if we have cookies
    if (this.cookie && !this.accessToken) {
      try {
        const res = await fetch(`${this.baseUrl}/api/auth/session`, {
          headers: {
            'User-Agent': this.userAgent,
            Cookie: this.cookie,
          },
        });
        if (res.ok) {
          const data = await res.json();
          if (data.accessToken) this.accessToken = data.accessToken;
          if (data.oaiDeviceId) this.deviceId = data.oaiDeviceId;
        }
      } catch {}
    }
  }

  async *chat(messages, model, signal) {
    const resolvedModel = model || 'gpt-4';
    const conversationId = undefined; // always new conversation
    const parentMessageId = crypto.randomUUID();
    const messageId = crypto.randomUUID();

    const prompt = messages.map(m => m.content).join('\n\n');

    const body = {
      action: 'next',
      messages: [{
        id: messageId,
        author: { role: 'user' },
        content: { content_type: 'text', parts: [prompt] },
      }],
      parent_message_id: parentMessageId,
      model: resolvedModel,
      timezone_offset_min: new Date().getTimezoneOffset(),
      history_and_training_disabled: false,
      conversation_mode: { kind: 'primary_assistant', plugin_ids: null },
      force_paragen: false,
      force_rate_limit: false,
      force_use_sse: true,
    };

    const res = await fetch(`${this.baseUrl}/backend-api/conversation`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 401) throw new Error('ChatGPT authentication failed. Please update your accessToken.');
      if (res.status === 403) throw new Error('ChatGPT 403 — anti-bot protection triggered. Try updating cookies/accessToken.');
      throw new Error(`ChatGPT API error: ${res.status} ${errText.slice(0, 300)}`);
    }

    // Parse ChatGPT's SSE format
    // ChatGPT sends: data: {"message":{"id":"...","content":{"parts":["text"]},...},...}
    let emittedContent = false;
    let lastContent = '';

    for await (const line of this.splitSSELines(this.readStream(res))) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6).trim();
      if (data === '[DONE]') break;

      try {
        const parsed = JSON.parse(data);
        const parts = parsed.message?.content?.parts;
        if (parts && Array.isArray(parts) && parts.length > 0) {
          const fullText = parts.join('');
          // ChatGPT sends cumulative content, extract the delta
          if (fullText.length > lastContent.length) {
            const delta = fullText.slice(lastContent.length);
            lastContent = fullText;
            if (delta) {
              emittedContent = true;
              yield this.formatSSE(this.toOpenAIChunk(delta, resolvedModel));
            }
          }
        }
      } catch {}
    }

    if (!emittedContent) {
      yield this.formatSSE(this.toOpenAIChunk('', resolvedModel, 'stop'));
    } else {
      yield this.formatSSE(this.toOpenAIChunk(null, resolvedModel, 'stop'));
    }
    yield this.formatDone();
  }
}

module.exports = ChatGPTAdapter;
