const crypto = require('node:crypto');
const BaseAdapter = require('./base');

const DOUBAO_API_BASE = 'https://www.doubao.com';

class DoubaoAdapter extends BaseAdapter {
  constructor(credentials) {
    super('doubao', credentials);
    const cred = typeof credentials === 'string' ? JSON.parse(credentials) : credentials;
    this.sessionid = cred.sessionid || '';
    this.ttwid = cred.ttwid || '';
    this.userAgent = cred.userAgent || this.defaultUA;

    // Default query parameters
    this.config = {
      aid: cred.aid || '497858',
      device_platform: 'web',
      language: cred.language || 'zh',
      pkg_type: 'release_version',
      real_aid: cred.aid || '497858',
      region: cred.region || 'CN',
      samantha_web: '1',
      sys_region: 'CN',
      use_olympus_account: '1',
      version_code: cred.version_code || '20800',
    };
    // Optional dynamic params
    if (cred.fp) this.config.fp = cred.fp;
    if (cred.tea_uuid) this.config.tea_uuid = cred.tea_uuid;
    if (cred.device_id) this.config.device_id = cred.device_id;
    if (cred.web_tab_id) this.config.web_tab_id = cred.web_tab_id;
    if (cred.msToken) this.config.msToken = cred.msToken;
    if (cred.a_bogus) this.config.a_bogus = cred.a_bogus;
  }

  getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': this.userAgent,
      Referer: 'https://www.doubao.com/chat/',
      Origin: 'https://www.doubao.com',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Agw-js-conv': 'str',
    };
    const ttwid = this.ttwid ? decodeURIComponent(this.ttwid) : '';
    headers.Cookie = ttwid
      ? `sessionid=${this.sessionid}; ttwid=${ttwid}`
      : `sessionid=${this.sessionid}`;
    return headers;
  }

  buildQueryParams() {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(this.config)) {
      if (value != null && key !== 'msToken' && key !== 'a_bogus') {
        params.append(key, String(value));
      }
    }
    if (this.config.msToken) params.append('msToken', this.config.msToken);
    if (this.config.a_bogus) params.append('a_bogus', this.config.a_bogus);
    return params.toString();
  }

  /** Parse single-line SSE: "id: 123 event: CHUNK_DELTA data: {...}" */
  parseSingleLineSSE(line) {
    const m = line.match(/id:\s*\d+\s+event:\s*(\S+)\s+data:\s*(.+)/);
    if (!m) return null;
    return { event: m[1].trim(), data: m[2].trim() };
  }

  /** Extract text from samantha JSON line format */
  extractSamanthaText(line) {
    try {
      const raw = JSON.parse(line);
      if (raw.code != null && raw.code !== 0) return null;
      if (raw.event_type === 2003) return null; // end
      // 2005 = error/captcha event
      if (raw.event_type === 2005 && raw.event_data) {
        let errMsg = 'unknown error', errCode = 0;
        try {
          const errData = JSON.parse(raw.event_data);
          errMsg = errData.message || errMsg;
          errCode = errData.code || errCode;
        } catch {}
        // Detect captcha by checking raw string for known patterns
        const rawStr = typeof raw.event_data === 'string' ? raw.event_data : JSON.stringify(raw.event_data);
        if (rawStr.includes('"type":"verify"') || rawStr.includes('"subtype":"slide"')) {
          throw new Error(`Doubao requires captcha verification (slide). Please complete captcha in browser then retry. (code: ${errCode})`);
        }
        throw new Error(`Doubao error: ${errMsg} (code: ${errCode})`);
      }
      if (raw.event_type !== 2001 || !raw.event_data) return null;
      const result = JSON.parse(raw.event_data);
      if (result.is_finish) return null;
      const msg = result.message;
      if (!msg || ![2001, 2008].includes(msg.content_type) || !msg.content) return null;
      const content = JSON.parse(msg.content);
      return content.text || null;
    } catch (e) {
      // Re-throw known errors (captcha, rate limit)
      if (e.message?.startsWith('Doubao')) throw e;
      return null;
    }
  }

  /** Extract text from standard SSE event */
  extractEventText(event) {
    if (!event.event || !event.data) return null;
    try {
      const data = JSON.parse(event.data);
      switch (event.event) {
        case 'CHUNK_DELTA':
          return data.text || null;
        case 'STREAM_CHUNK':
          if (data.patch_op) {
            const texts = data.patch_op
              .map(p => p.patch_value?.tts_content)
              .filter(Boolean);
            return texts.join('') || null;
          }
          return null;
        case 'STREAM_MSG_NOTIFY':
          if (data.content?.content_block) {
            const texts = data.content.content_block
              .map(b => b.content?.text_block?.text)
              .filter(Boolean);
            return texts.join('') || null;
          }
          return null;
        case 'STREAM_ERROR':
          throw new Error(`Doubao error: ${data.error_msg} (code: ${data.error_code})`);
        default:
          return null;
      }
    } catch (e) {
      if (e.message?.startsWith('Doubao error')) throw e;
      return null;
    }
  }

  async *chat(messages, model, signal) {
    const queryParams = this.buildQueryParams();
    const url = `${DOUBAO_API_BASE}/samantha/chat/completion?${queryParams}`;
    const text = this.mergeMessages(messages);
    const body = JSON.stringify({
      messages: [{
        content: JSON.stringify({ text }),
        content_type: 2001,
        attachments: [],
        references: [],
      }],
      completion_option: {
        is_regen: false,
        with_suggest: true,
        need_create_conversation: true,
        launch_stage: 1,
        is_replace: false,
        is_delete: false,
        message_from: 0,
        event_id: '0',
      },
      conversation_id: '0',
      local_conversation_id: `local_16${Date.now().toString().slice(-14)}`,
      local_message_id: crypto.randomUUID(),
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body,
      signal,
    });

    if (!res.ok) throw new Error(`Doubao API error: ${res.status} ${await res.text()}`);

    let emittedContent = false;
    let currentEvent = {};

    for await (const line of this.splitSSELines(this.readStream(res))) {
      const trimmed = line.trim();
      if (trimmed === '') {
        // Multi-line event boundary
        if (currentEvent.event && currentEvent.data) {
          const text = this.extractEventText(currentEvent);
          if (text) {
            emittedContent = true;
            yield this.formatSSE(this.toOpenAIChunk(text, model));
          }
        }
        currentEvent = {};
        continue;
      }

      // Try single-line format
      const single = this.parseSingleLineSSE(trimmed);
      if (single) {
        const text = this.extractEventText(single);
        if (text) {
          emittedContent = true;
          yield this.formatSSE(this.toOpenAIChunk(text, model));
        }
        currentEvent = {};
        continue;
      }

      // Try samantha JSON format
      const dataLine = trimmed.startsWith('data: ') ? trimmed.slice(6).trim() : trimmed;
      const samanthaText = this.extractSamanthaText(dataLine);
      if (samanthaText) {
        emittedContent = true;
        yield this.formatSSE(this.toOpenAIChunk(samanthaText, model));
        currentEvent = {};
        continue;
      }

      // Multi-line SSE fields
      if (trimmed.startsWith('id: ')) currentEvent.id = trimmed.slice(4).trim();
      else if (trimmed.startsWith('event: ')) currentEvent.event = trimmed.slice(7).trim();
      else if (trimmed.startsWith('data: ')) currentEvent.data = trimmed.slice(6).trim();
    }

    // Process final event
    if (currentEvent.event && currentEvent.data) {
      const text = this.extractEventText(currentEvent);
      if (text) {
        emittedContent = true;
        yield this.formatSSE(this.toOpenAIChunk(text, model));
      }
    }

    if (!emittedContent) {
      throw new Error('Doubao: received SSE events but could not parse any text. Session may be expired.');
    }

    yield this.formatSSE(this.toOpenAIChunk(null, model, 'stop'));
    yield this.formatDone();
  }
}

module.exports = DoubaoAdapter;
