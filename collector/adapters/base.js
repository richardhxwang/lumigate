/**
 * Base adapter for collector web clients.
 * Provides SSE parsing, OpenAI format conversion, and streaming helpers.
 */
class BaseAdapter {
  constructor(name, credentials) {
    this.name = name;
    this.credentials = credentials;
  }

  /** Override in subclass */
  async init() {}

  /**
   * Send a chat message and return an async generator of SSE strings (OpenAI format).
   * @param {Array<{role: string, content: string}>} messages
   * @param {string} model
   * @param {AbortSignal} [signal]
   * @returns {AsyncGenerator<string>} yields SSE lines like "data: {...}\n\n"
   */
  async *chat(messages, model, signal) {
    throw new Error(`${this.name}: chat() not implemented`);
  }

  // ── SSE helpers ──────────────────────────────────────────────────────

  /** Parse raw SSE text into structured events */
  parseSSELines(text) {
    return text.split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => {
        const data = line.slice(6).trim();
        if (data === '[DONE]') return { done: true };
        try { return JSON.parse(data); } catch { return null; }
      })
      .filter(Boolean);
  }

  /** Format a single OpenAI chat.completion.chunk */
  toOpenAIChunk(content, model, finishReason = null) {
    return {
      id: `chatcmpl-collector-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: content ? { content } : {},
        finish_reason: finishReason,
      }],
    };
  }

  /** Encode a chunk as an SSE data line */
  formatSSE(chunk) {
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  /** Yield the final [DONE] SSE marker */
  formatDone() {
    return 'data: [DONE]\n\n';
  }

  // ── Stream reading helpers ───────────────────────────────────────────

  /**
   * Read a fetch Response body as an async generator of text chunks.
   * Handles ReadableStream (node 18+ fetch).
   */
  async *readStream(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Buffer-based SSE line splitter.
   * Yields complete lines from an async iterable of text chunks.
   */
  async *splitSSELines(chunks) {
    let buffer = '';
    for await (const chunk of chunks) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        yield line;
      }
    }
    if (buffer.trim()) {
      yield buffer;
    }
  }

  /** Merge multi-turn messages into a single string for platforms that need it */
  mergeMessages(messages) {
    return messages.map(m => {
      const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system';
      return `<|im_start|>${role}\n${m.content}\n`;
    }).join('') + '<|im_end|>\n';
  }

  /** Default User-Agent */
  get defaultUA() {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }
}

module.exports = BaseAdapter;
