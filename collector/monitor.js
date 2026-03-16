#!/usr/bin/env node
/**
 * Collector Risk Monitor
 *
 * Periodically tests each collector provider for anti-bot risk.
 * If risk is high → logs warning + can notify via webhook.
 *
 * Usage:
 *   node monitor.js                    # one-shot check
 *   node monitor.js --loop 300         # check every 300s (5min)
 *   node monitor.js --webhook <url>    # send alerts to webhook
 *
 * Risk levels:
 *   ok       - provider responds normally
 *   warning  - slow response or partial errors
 *   blocked  - captcha/403/session expired
 *   down     - provider unreachable
 */
const path = require('path');

const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = process.env.CDP_PORT || 9223;
const WEBHOOK_URL = process.argv.find((a, i) => process.argv[i - 1] === '--webhook') || process.env.MONITOR_WEBHOOK;
const LOOP_SEC = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--loop') || '0');

const PROVIDERS = {
  doubao: {
    name: 'Doubao',
    testUrl: 'https://www.doubao.com/chat/',
    checkFn: async (page) => {
      const cookies = await page.context().cookies(['https://www.doubao.com']);
      if (!cookies.find(c => c.name === 'sessionid')) return { risk: 'blocked', reason: 'No sessionid cookie - need to re-login' };
      // Try a lightweight request
      const r = await page.evaluate(async () => {
        try {
          const res = await fetch('/im/conversation/info?aid=497858', { credentials: 'include' });
          return { status: res.status, ok: res.ok };
        } catch (e) { return { error: e.message }; }
      });
      if (r.error) return { risk: 'down', reason: r.error };
      if (r.status === 403 || r.status === 401) return { risk: 'blocked', reason: `HTTP ${r.status} - session expired or captcha required` };
      return { risk: 'ok' };
    },
  },
  kimi: {
    name: 'Kimi',
    testUrl: 'https://www.kimi.com/',
    checkFn: async (page) => {
      const cookies = await page.context().cookies(['https://www.kimi.com']);
      if (!cookies.find(c => c.name === 'kimi-auth')) return { risk: 'blocked', reason: 'No kimi-auth cookie - need to re-login' };
      return { risk: 'ok' };
    },
  },
  qwen: {
    name: 'Qwen',
    testUrl: 'https://chat.qwen.ai/',
    checkFn: async (page) => {
      // Qwen is generally lenient, just check page loads
      const r = await page.evaluate(async () => {
        try {
          const res = await fetch('/api/v2/chats/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          return { status: res.status };
        } catch (e) { return { error: e.message }; }
      });
      if (r.error) return { risk: 'down', reason: r.error };
      if (r.status === 401 || r.status === 403) return { risk: 'blocked', reason: `HTTP ${r.status} - need to re-login` };
      return { risk: 'ok' };
    },
  },
};

const RISK_EMOJI = { ok: '✓', warning: '⚠', blocked: '✗', down: '✗' };

async function checkAll() {
  let chromium;
  try { chromium = require('playwright-core').chromium; } catch {
    console.error('playwright-core not installed'); process.exit(1);
  }

  let browser, ctx;
  try {
    const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(3000) });
    const { webSocketDebuggerUrl } = await res.json();
    const ws = webSocketDebuggerUrl.replace('127.0.0.1', CDP_HOST).replace('localhost', CDP_HOST);
    browser = await chromium.connectOverCDP(ws);
    ctx = browser.contexts()[0];
  } catch (e) {
    console.error('Cannot connect to Chrome:', e.message);
    return { error: 'Chrome not running' };
  }

  const results = {};
  const ts = new Date().toISOString().slice(0, 19);
  console.log(`\n[${ts}] Collector Risk Check`);
  console.log('─'.repeat(50));

  for (const [key, provider] of Object.entries(PROVIDERS)) {
    try {
      let page = ctx.pages().find(p => p.url().includes(new URL(provider.testUrl).hostname));
      if (!page) {
        page = await ctx.newPage();
        await page.goto(provider.testUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      }

      const start = Date.now();
      const result = await Promise.race([
        provider.checkFn(page),
        new Promise(resolve => setTimeout(() => resolve({ risk: 'warning', reason: 'Check timed out (10s)' }), 10000)),
      ]);
      const elapsed = Date.now() - start;

      results[key] = { ...result, elapsed };
      const emoji = RISK_EMOJI[result.risk] || '?';
      const detail = result.reason ? ` — ${result.reason}` : (result.detail ? ` (${result.detail})` : '');
      console.log(`  ${emoji} ${provider.name.padEnd(12)} ${result.risk.padEnd(8)} ${elapsed}ms${detail}`);
    } catch (e) {
      results[key] = { risk: 'down', reason: e.message, elapsed: 0 };
      console.log(`  ✗ ${provider.name.padEnd(12)} down     — ${e.message.slice(0, 60)}`);
    }
  }

  // Alert if any provider is blocked
  const blocked = Object.entries(results).filter(([, r]) => r.risk === 'blocked');
  if (blocked.length > 0 && WEBHOOK_URL) {
    const msg = `⚠ Collector Alert: ${blocked.map(([k, r]) => `${PROVIDERS[k].name}: ${r.reason}`).join('; ')}`;
    console.log(`\nSending alert: ${msg.slice(0, 100)}...`);
    try {
      await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: msg, type: 'collector_risk', blocked: blocked.map(([k]) => k), ts }),
      });
    } catch {}
  }

  console.log('─'.repeat(50));
  return results;
}

(async () => {
  if (LOOP_SEC > 0) {
    console.log(`Monitor running every ${LOOP_SEC}s. Webhook: ${WEBHOOK_URL || 'none'}`);
    while (true) {
      await checkAll().catch(e => console.error('Check error:', e.message));
      await new Promise(r => setTimeout(r, LOOP_SEC * 1000));
    }
  } else {
    await checkAll();
    process.exit(0);
  }
})();
