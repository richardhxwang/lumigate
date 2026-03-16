/**
 * Collector — AI web collection module for LumiGate.
 *
 * DeepSeek: 纯 HTTP（PoW 机制可以不依赖浏览器）
 * 其他 (doubao, qwen, kimi): 通过 BrowserAdapter 框架，
 *   连接用户已登录的 Chrome，在浏览器上下文中静默执行请求。
 *   不启动新浏览器、不抢焦点。
 */

const BrowserAdapter = require('./adapters/browser');
const providers = require('./adapters/providers');
const DeepSeekAdapter = require('./adapters/deepseek');

// Browser-based providers: 只需 config 对象
const BROWSER_PROVIDERS = {
  doubao: providers.doubao,
  qwen: providers.qwen,
  kimi: providers.kimi,
};

// DeepSeek: 独立 adapter（纯 HTTP + PoW）
const PURE_HTTP_PROVIDERS = {
  deepseek: DeepSeekAdapter,
};

const ALL_PROVIDERS = [...Object.keys(PURE_HTTP_PROVIDERS), ...Object.keys(BROWSER_PROVIDERS)];

/**
 * Send a message via collector.
 *
 * @param {string} providerName
 * @param {string} model
 * @param {Array<{role: string, content: string}>} messages
 * @param {object|string} credentials
 * @param {AbortSignal} [signal]
 * @returns {AsyncGenerator<string>} SSE data lines (OpenAI format)
 */
async function* sendMessage(providerName, model, messages, credentials, signal) {
  // Pure HTTP adapter (DeepSeek)
  if (PURE_HTTP_PROVIDERS[providerName]) {
    const AdapterClass = PURE_HTTP_PROVIDERS[providerName];
    const adapter = new AdapterClass(credentials);
    await adapter.init();
    yield* adapter.chat(messages, model, signal);
    return;
  }

  // Browser-based adapter
  const config = BROWSER_PROVIDERS[providerName];
  if (!config) {
    throw new Error(`No collector adapter for: ${providerName}. Supported: ${ALL_PROVIDERS.join(', ')}`);
  }

  const adapter = new BrowserAdapter(config, credentials);
  await adapter.init();
  yield* adapter.chat(messages, model, signal);
}

/** Credential field descriptions (for Dashboard UI) */
const credentialFields = {
  deepseek: {
    fields: ['cookie', 'bearer'],
    instructions: '登录 chat.deepseek.com → F12 → Application → Cookies → 复制所有 cookie；Network → Headers → 复制 Authorization Bearer token',
  },
  doubao: {
    fields: ['sessionid', 'ttwid'],
    instructions: '确保 Chrome 以 --remote-debugging-port=9222 启动，且已登录 doubao.com。只需提供 sessionid（备用）',
  },
  kimi: {
    fields: ['(自动)'],
    instructions: '确保 Chrome 以 --remote-debugging-port=9222 启动，且已登录 kimi.com。无需手动填写凭据',
  },
  qwen: {
    fields: ['sessionToken'],
    instructions: '确保 Chrome 以 --remote-debugging-port=9222 启动，且已登录 chat.qwen.ai。只需提供 sessionToken（备用）',
  },
};

module.exports = {
  sendMessage,
  supportedProviders: ALL_PROVIDERS,
  credentialFields,
};
