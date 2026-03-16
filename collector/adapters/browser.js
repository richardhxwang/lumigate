/**
 * BrowserAdapter — 通用浏览器代理框架。
 *
 * 连接已在后台运行的 Chrome（通过 CDP），在浏览器上下文中执行 fetch。
 * **不启动 Chrome、不弹窗口、不抢焦点。**
 *
 * Chrome 生命周期由外部管理：
 *   - 首次：node login.js doubao  → 启动 Chrome + 登录 + 隐藏（保持运行）
 *   - 之后：Chrome 一直在后台跑，本模块只连接它
 *   - 重启后：launchd 自动启动 Chrome（或手动 node login.js start）
 */
const { chromium } = require('playwright-core');
const BaseAdapter = require('./base');

const DEFAULT_CDP_HOST = process.env.CDP_HOST || 'localhost';
const DEFAULT_CDP_PORT = process.env.CDP_PORT || 9223;

// 单例 Chrome 连接（所有 provider 共享）
let _context = null;
let _connecting = null;

async function getContext(cdpHost, cdpPort) {
  if (_context) return _context;
  if (_connecting) return _connecting;

  _connecting = (async () => {
    const cdpUrl = `http://${cdpHost}:${cdpPort}`;
    let wsUrl = null;

    // Try /json/version first (works when Chrome allows external Host header)
    for (let i = 0; i < 5; i++) {
      try {
        const res = await fetch(`${cdpUrl}/json/version`, {
          signal: AbortSignal.timeout(1500),
          headers: { Host: `127.0.0.1:${cdpPort}` },
        });
        const data = await res.json();
        wsUrl = data.webSocketDebuggerUrl;
        // Fix WebSocket URL to use correct host
        if (wsUrl) wsUrl = wsUrl.replace('127.0.0.1', cdpHost).replace('localhost', cdpHost);
        if (wsUrl) break;
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }

    // Fallback: try direct CDP endpoint (Playwright can connect without /json/version)
    if (!wsUrl) {
      wsUrl = `ws://${cdpHost}:${cdpPort}`;
    }

    // Verify connection is possible
    try {
      // Quick TCP check
      await fetch(`http://${cdpHost}:${cdpPort}/`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
    } catch {}

    let browser;
    try {
      browser = await chromium.connectOverCDP(wsUrl);
    } catch (e) {
      _connecting = null;
      throw new Error(
        'Collector Chrome 未运行。请先执行：\n' +
        '  cd collector && node login.js start\n' +
        '或登录某个平台：\n' +
        '  node login.js doubao\n' +
        '原始错误: ' + e.message
      );
    }
    _context = browser.contexts()[0];
    browser.on('disconnected', () => { _context = null; });

    // 自动隐藏 Chrome（确保永远不可见）
    try {
      require('child_process').execSync(
        'osascript -e \'tell application "System Events" to set visible of process "Google Chrome" to false\'',
        { stdio: 'ignore' }
      );
    } catch {}

    _connecting = null;
    return _context;
  })();

  return _connecting;
}

// 每个 provider 缓存一个 page + 互斥锁防止并发冲突
const _locks = {}; // provider → Promise chain
const _pages = {};

class BrowserAdapter extends BaseAdapter {
  constructor(providerConfig, credentials) {
    super(providerConfig.name, credentials);
    this.config = providerConfig;
    const cred = typeof credentials === 'string' ? JSON.parse(credentials) : credentials;
    this.cdpHost = cred.cdpHost || DEFAULT_CDP_HOST;
    this.cdpPort = cred.cdpPort || DEFAULT_CDP_PORT;
    this.cred = cred;
  }

  async _getPage() {
    const name = this.config.name;
    if (_pages[name]) {
      try { _pages[name].url(); return _pages[name]; } catch { delete _pages[name]; }
    }

    const ctx = await getContext(this.cdpHost, this.cdpPort);

    // 找已有 tab（不创建窗口）
    let page = ctx.pages().find(p => p.url().includes(this.config.pageMatch));

    if (!page) {
      // 后台新建 tab（Chrome 已隐藏，不会弹窗）
      page = await ctx.newPage();
      await page.goto(this.config.baseUrl + '/', {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      }).catch(() => {});
    }

    _pages[name] = page;
    return page;
  }

  async init() {
    const page = await this._getPage();
    if (this.config.prepare) await this.config.prepare(page, this.cred);
  }

  async *chat(messages, model, signal) {
    // Per-provider mutex: serialize concurrent requests to same provider
    const name = this.config.name;
    const prev = _locks[name] || Promise.resolve();
    let unlock;
    _locks[name] = new Promise(r => { unlock = r; });
    await prev;

    try {
    const page = await this._getPage();

    // Provider 构造请求
    const req = await this.config.buildRequest(messages, model, this.cred, page);

    // Kimi RPC 特殊处理
    if (req._kimiRpc) {
      yield* this._handleKimiRpc(page, req, model);
      return;
    }

    // 在浏览器中静默执行 fetch
    const result = await page.evaluate(
      async ({ url, body, headers, timeoutMs }) => {
        try {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), timeoutMs || 120000);
          const res = await fetch(url, {
            method: 'POST',
            headers: headers || { 'Content-Type': 'application/json' },
            body: typeof body === 'string' ? body : JSON.stringify(body),
            signal: ctl.signal,
            credentials: 'include',
          });
          clearTimeout(t);
          if (!res.ok) return { ok: false, status: res.status, error: (await res.text()).slice(0, 500) };
          const reader = res.body?.getReader();
          if (!reader) return { ok: false, status: 500, error: 'No body' };
          const dec = new TextDecoder();
          let text = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            text += dec.decode(value, { stream: true });
          }
          return { ok: true, data: text };
        } catch (e) {
          return { ok: false, status: 0, error: String(e).slice(0, 500) };
        }
      },
      { url: req.url, body: req.body, headers: req.headers, timeoutMs: req.timeoutMs }
    );

    if (!result.ok) {
      // ChatGPT 403: 走 DOM 模拟 fallback（在输入框打字发送）
      if (result.status === 403 && this.config.useDomFallback) {
        yield* this._domFallback(page, messages, model);
        return;
      }
      if (result.status === 401 || result.status === 403) {
        throw new Error(`${this.name}: 认证过期，请运行 node login.js ${this.name}`);
      }
      throw new Error(`${this.name} API error: ${result.status} ${result.error}`);
    }

    // Provider 解析响应
    const chunks = this.config.parseResponse(result.data, model);
    let emitted = false;
    for (const chunk of chunks) {
      if (chunk.content) {
        emitted = true;
        yield this.formatSSE(this.toOpenAIChunk(chunk.content, model));
      }
    }

    if (!emitted) {
      throw new Error(`${this.name}: 未解析出内容，请运行 node login.js ${this.name} 重新登录`);
    }

    yield this.formatSSE(this.toOpenAIChunk(null, model, 'stop'));
    yield this.formatDone();
    } finally { if (unlock) unlock(); }
  }

  /** DOM 模拟 fallback（ChatGPT 403 时）：用 Playwright 在输入框打字 + Enter 发送 */
  async *_domFallback(page, messages, model) {
    const prompt = messages.map(m => m.content).join('\n\n');

    // 用 Playwright API 操作（比 evaluate 更可靠）
    const input = await page.$('#prompt-textarea') || await page.$('textarea') || await page.$('[contenteditable="true"]');
    if (!input) throw new Error('ChatGPT DOM fallback: 找不到输入框');

    await input.click();
    await input.fill(''); // 清空
    // fill 对 contenteditable 可能不行，用 type
    await page.keyboard.type(prompt, { delay: 10 });
    await new Promise(r => setTimeout(r, 500));
    await page.keyboard.press('Enter');
    const sent = { ok: true };

    if (!sent.ok) throw new Error(`ChatGPT DOM fallback: ${sent.error}`);

    // 轮询等待回复（最多 90s）
    let lastText = '', stableCount = 0;
    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const r = await page.evaluate(() => {
        const els = document.querySelectorAll('[data-message-author-role="assistant"]');
        const last = els.length ? els[els.length - 1] : null;
        const text = last ? last.textContent.replace(/[\u200B-\u200D\uFEFF]/g, '').trim() : '';
        const streaming = !!document.querySelector('button[aria-label*="Stop"]');
        return { text, streaming };
      });
      if (r.text && r.text !== lastText) { lastText = r.text; stableCount = 0; }
      else if (r.text) { stableCount++; if (!r.streaming && stableCount >= 2) break; }
    }

    if (!lastText) throw new Error('ChatGPT DOM fallback: 未检测到回复');

    yield this.formatSSE(this.toOpenAIChunk(lastText, model));
    yield this.formatSSE(this.toOpenAIChunk(null, model, 'stop'));
    yield this.formatDone();
  }

  async *_handleKimiRpc(page, req, model) {
    // 用 Playwright API 读 cookie（支持 httpOnly）
    const ctx = page.context();
    const cookies = await ctx.cookies(['https://www.kimi.com', 'https://kimi.com']);
    const kimiAuth = cookies.find(c => c.name === 'kimi-auth')?.value;
    if (!kimiAuth) throw new Error('Kimi: 未找到 kimi-auth cookie，请运行 node login.js kimi');

    const result = await page.evaluate(
      async ({ scenario, prompt, authToken }) => {
        try {
          const payload = {
            scenario,
            message: { role: 'user', blocks: [{ message_id: '', text: { content: prompt } }], scenario },
            options: { thinking: false },
          };
          const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
          const buf = new ArrayBuffer(5 + jsonBytes.byteLength);
          new DataView(buf).setUint8(0, 0x00);
          new DataView(buf).setUint32(1, jsonBytes.byteLength, false);
          new Uint8Array(buf, 5).set(jsonBytes);

          const res = await fetch('/apiv2/kimi.gateway.chat.v1.ChatService/Chat', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/connect+json',
              'Connect-Protocol-Version': '1',
              Accept: '*/*',
              'X-Language': 'zh-CN',
              'X-Msh-Platform': 'web',
              Authorization: `Bearer ${authToken}`,
            },
            body: buf,
            credentials: 'include',
          });
          if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };

          const arr = new Uint8Array(await res.arrayBuffer());
          const texts = [];
          let o = 0;
          while (o + 5 <= arr.length) {
            const len = new DataView(arr.buffer, arr.byteOffset + o + 1, 4).getUint32(0, false);
            if (o + 5 + len > arr.length) break;
            try {
              const obj = JSON.parse(new TextDecoder().decode(arr.slice(o + 5, o + 5 + len)));
              if (obj.error) return { error: obj.error.message || JSON.stringify(obj.error) };
              if (obj.block?.text?.content && ['set', 'append'].includes(obj.op || '')) {
                texts.push(obj.block.text.content);
              }
              if (obj.done) break;
            } catch {}
            o += 5 + len;
          }
          return { text: texts.join('') };
        } catch (e) { return { error: String(e) }; }
      },
      { scenario: req.scenario, prompt: req.prompt, authToken: kimiAuth }
    );

    const chunks = this.config.parseResponse(JSON.stringify(result), model);
    let emitted = false;
    for (const chunk of chunks) {
      if (chunk.content) {
        emitted = true;
        yield this.formatSSE(this.toOpenAIChunk(chunk.content, model));
      }
    }
    if (!emitted) throw new Error('Kimi: 未解析出内容，请运行 node login.js kimi');
    yield this.formatSSE(this.toOpenAIChunk(null, model, 'stop'));
    yield this.formatDone();
  }
}

module.exports = BrowserAdapter;
