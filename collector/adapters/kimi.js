const BaseAdapter = require('./base');

class KimiAdapter extends BaseAdapter {
  constructor(credentials) {
    super('kimi', credentials);
    const cred = typeof credentials === 'string' ? JSON.parse(credentials) : credentials;
    this.cookie = cred.cookie || '';
    this.userAgent = cred.userAgent || this.defaultUA;
    this.baseUrl = 'https://www.kimi.com';
  }

  /** Extract kimi-auth token from cookie string */
  getAuthToken() {
    const match = this.cookie.match(/(?:^|;\s*)kimi-auth=([^;]+)/);
    if (!match) throw new Error('Kimi: kimi-auth not found in cookie. Login at www.kimi.com and copy cookies.');
    return match[1];
  }

  getScenario(model) {
    if (model?.includes('search')) return 'SCENARIO_SEARCH';
    if (model?.includes('research')) return 'SCENARIO_RESEARCH';
    if (model?.includes('k1')) return 'SCENARIO_K1';
    return 'SCENARIO_K2';
  }

  /** Encode JSON payload into Connect RPC binary frame: [0x00][4-byte length BE][JSON bytes] */
  encodeConnectFrame(payload) {
    const jsonBytes = Buffer.from(JSON.stringify(payload), 'utf8');
    const frame = Buffer.alloc(5 + jsonBytes.length);
    frame.writeUInt8(0x00, 0);
    frame.writeUInt32BE(jsonBytes.length, 1);
    jsonBytes.copy(frame, 5);
    return frame;
  }

  /** Decode Connect RPC binary response into array of JSON objects */
  decodeConnectFrames(buffer) {
    const results = [];
    let offset = 0;
    while (offset + 5 <= buffer.length) {
      const len = buffer.readUInt32BE(offset + 1);
      if (offset + 5 + len > buffer.length) break;
      const chunk = buffer.subarray(offset + 5, offset + 5 + len);
      try {
        results.push(JSON.parse(chunk.toString('utf8')));
      } catch {}
      offset += 5 + len;
    }
    return results;
  }

  async *chat(messages, model, signal) {
    const kimiAuth = this.getAuthToken();
    const scenario = this.getScenario(model);

    // Merge messages into single prompt
    const prompt = messages.map(m => m.content).join('\n\n');

    const requestPayload = {
      scenario,
      message: {
        role: 'user',
        blocks: [{ message_id: '', text: { content: prompt } }],
        scenario,
      },
      options: { thinking: false },
    };

    const body = this.encodeConnectFrame(requestPayload);

    const res = await fetch(`${this.baseUrl}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/connect+json',
        'Connect-Protocol-Version': '1',
        Accept: '*/*',
        Origin: this.baseUrl,
        Referer: `${this.baseUrl}/`,
        'X-Language': 'zh-CN',
        'X-Msh-Platform': 'web',
        Authorization: `Bearer ${kimiAuth}`,
        'User-Agent': this.userAgent,
        Cookie: this.cookie,
      },
      body,
      signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Kimi API error: ${res.status} ${errText.slice(0, 400)}`);
    }

    // Read entire response as binary buffer
    const responseBuffer = Buffer.from(await res.arrayBuffer());
    const frames = this.decodeConnectFrames(responseBuffer);

    let emittedContent = false;
    for (const obj of frames) {
      if (obj.error) {
        throw new Error(`Kimi error: ${obj.error.message || obj.error.code || JSON.stringify(obj.error)}`);
      }
      if (obj.block?.text?.content && ['set', 'append'].includes(obj.op || '')) {
        emittedContent = true;
        yield this.formatSSE(this.toOpenAIChunk(obj.block.text.content, model));
      }
      if (obj.done) break;
    }

    if (!emittedContent) {
      yield this.formatSSE(this.toOpenAIChunk('', model, 'stop'));
    } else {
      yield this.formatSSE(this.toOpenAIChunk(null, model, 'stop'));
    }
    yield this.formatDone();
  }
}

module.exports = KimiAdapter;
