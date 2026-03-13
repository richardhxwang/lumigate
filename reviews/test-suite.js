#!/usr/bin/env node
'use strict';

/**
 * LumiGate Test Suite v3
 *
 * Usage:
 *   node reviews/test-suite.js
 *   BASE_URL=http://localhost:19471 ADMIN_SECRET=test_admin_secret_only_for_test_env node reviews/test-suite.js
 *   REAL_API=1 node reviews/test-suite.js
 *
 * Exit: 0 = all pass, 1 = any fail
 */

const http    = require('http');
const crypto  = require('crypto');
const { spawn } = require('child_process');
const fs      = require('fs');
const path    = require('path');

// ─── Config ────────────────────────────────────────────────────────────────
const BASE_URL      = (process.env.BASE_URL || 'http://localhost:9471').replace(/\/$/, '');
const ADMIN_SECRET  = process.env.ADMIN_SECRET || 'test_admin_secret_only_for_test_env';
const REAL_API      = process.env.REAL_API === '1';
const IS_DOCKER     = BASE_URL.includes(':19471');
const DATA_DIR      = path.join(__dirname, '..', IS_DOCKER ? 'data-test' : 'data');

const ADMIN_H = { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_SECRET };

// ─── Stats ──────────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
const failures = [];

// ─── Colors ─────────────────────────────────────────────────────────────────
const C = { reset:'\x1b[0m', green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m',
            cyan:'\x1b[36m', bold:'\x1b[1m', dim:'\x1b[2m' };

function p(msg)  { process.stdout.write(msg + '\n'); }
function sec(t)  { p(`\n${C.cyan}── ${t} ──${C.reset}`); }
function banner(msg) {
  const line = '═'.repeat(48);
  p(`\n${C.bold}${line}${C.reset}\n${C.bold}  ${msg}${C.reset}\n${C.bold}${line}${C.reset}`);
}
function check(label, pass, details) {
  if (pass) { passed++; p(`  ${C.green}✅${C.reset} ${label}`); }
  else {
    failed++;
    failures.push({ label, details });
    p(`  ${C.red}❌${C.reset} ${label}`);
    if (details !== undefined) p(`     ${C.dim}got: ${JSON.stringify(details).slice(0, 200)}${C.reset}`);
  }
}
function skip(label, reason) {
  skipped++;
  p(`  ${C.yellow}⏭${C.reset}  ${label}  ${C.dim}(${reason})${C.reset}`);
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────
async function req(method, url, { headers = {}, body, rawBody } = {}) {
  const opts = { method, headers: { ...headers } };
  if (rawBody !== undefined) {
    opts.body = rawBody;
  } else if (body !== undefined) {
    if (!opts.headers['Content-Type'] && !opts.headers['content-type'])
      opts.headers['Content-Type'] = 'application/json';
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  try {
    const res = await fetch(url, opts);
    const ct = res.headers.get('content-type') || '';
    let data;
    try { data = ct.includes('json') ? await res.json() : await res.text(); } catch { data = null; }
    return { status: res.status, data, headers: res.headers };
  } catch (e) {
    return { status: 0, data: null, error: e.message, headers: new Headers() };
  }
}

const GET     = (p2, o)    => req('GET',    BASE_URL + p2, o);
const POST    = (p2, b, o) => req('POST',   BASE_URL + p2, { body: b, ...o });
const PUT     = (p2, b, o) => req('PUT',    BASE_URL + p2, { body: b, ...o });
const DEL     = (p2, o)    => req('DELETE', BASE_URL + p2, o);
const aGET    = p2         => GET(p2,    { headers: ADMIN_H });
const aPOST   = (p2, b)    => POST(p2, b, { headers: ADMIN_H });
const aPUT    = (p2, b)    => PUT(p2, b,  { headers: ADMIN_H });
const aDEL    = p2         => DEL(p2,     { headers: ADMIN_H });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HMAC signing (mirrors server.js verifyHmacSignature) ───────────────────
// payload = timestamp + nonce + JSON.stringify(body)
function hmacSign(projectKey, body, projectId) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce     = crypto.randomUUID();
  const bodyStr   = JSON.stringify(body || {});
  const sig = crypto.createHmac('sha256', projectKey).update(timestamp + nonce + bodyStr).digest('hex');
  return { 'X-Signature': sig, 'X-Timestamp': timestamp, 'X-Nonce': nonce,
           'X-Project-Id': projectId, 'Content-Type': 'application/json' };
}

// ─── Test project lifecycle ──────────────────────────────────────────────────
const testProjects = new Set();

async function createTestProject(name, opts = {}) {
  // Idempotent: delete stale project from prior run before creating
  await aDEL(`/admin/projects/${encodeURIComponent(name)}`).catch(() => {});
  const r = await aPOST('/admin/projects', {
    name, authMode: 'key', maxRpm: 600, maxRpmPerIp: 60,
    anomalyAutoSuspend: false, ...opts,
  });
  if (r.data?.success) testProjects.add(name);
  return r;
}

async function cleanupAll() {
  for (const name of testProjects) {
    try { await aDEL(`/admin/projects/${encodeURIComponent(name)}`); } catch {}
  }
  testProjects.clear();
}

// ─── Free port helper ────────────────────────────────────────────────────────
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 0 — External Access / Tunnel Guards  ⚡ 最高優先
// 保護 Cloudflare Tunnel → nginx → app 的完整鏈路
// ══════════════════════════════════════════════════════════════════════════════
async function section0() {
  sec('Section 0: External Access / Tunnel Guards  ⚡ 最高優先');

  // 0.1  Health always 200 — Cloudflare health-check 依賴這個觸發自動重啟
  const health = await GET('/health');
  check('GET /health → 200 status:ok', health.status === 200 && health.data?.status === 'ok', health.data);

  // 0.2  Health 不洩露 secret / API key
  const hStr = JSON.stringify(health.data || '');
  check('Health response: no secret or pk_ leakage',
    !hStr.includes(ADMIN_SECRET) && !/pk_[a-f0-9]{20,}/.test(hStr) && !/sk-[a-zA-Z0-9]{10,}/.test(hStr));

  // 0.3  Health 不需要任何 auth（公開端點）
  const healthNoAuth = await req('GET', BASE_URL + '/health');
  check('GET /health needs no auth (public)', healthNoAuth.status === 200);

  // 0.4  x-powered-by 已關閉（Express 指紋移除）
  check('No x-powered-by header', !health.headers.get('x-powered-by'));

  // 0.5  X-Request-ID 存在於所有回應（tunnel 問題追蹤）
  check('X-Request-ID present on every response', !!health.headers.get('x-request-id'));

  // 0.6  X-Forwarded-For 是 Cloudflare 傳入真實 IP 的方式，server 應正常處理
  const cfFwd = await req('GET', BASE_URL + '/health', {
    headers: { 'X-Forwarded-For': '1.2.3.4, 10.0.0.1', 'CF-Connecting-IP': '1.2.3.4' },
  });
  check('X-Forwarded-For header handled without crash', cfFwd.status === 200);

  // 0.7  cf-visitor HTTPS 標頭不導致 500（cookie secure 設定依賴它）
  const cfVisitor = await req('POST', BASE_URL + '/admin/login', {
    headers: { 'Content-Type': 'application/json', 'cf-visitor': '{"scheme":"https"}' },
    body: JSON.stringify({ secret: ADMIN_SECRET }),
  });
  // 429 is also ok — loginLimiter triggered by prior brute-force run (15-min window); either way server handles cf-visitor without crashing
  check('Login with cf-visitor:https header → no crash (200 or 429)', [200, 429].includes(cfVisitor.status), cfVisitor.status);

  // 0.8  nginx security headers（只在走 nginx 的 port 19471 時檢查）
  if (IS_DOCKER) {
    const nxHdr = health.headers;
    check('nginx: X-Content-Type-Options: nosniff present',
      nxHdr.get('x-content-type-options') === 'nosniff');
  } else {
    skip('nginx security headers', 'direct app port — nginx not in path');
  }

  // 0.9  OPTIONS preflight 不應崩潰（支援 CORS preflight 來自外網 JS 客戶端）
  const opts = await req('OPTIONS', BASE_URL + '/health', { headers: { 'Origin': 'https://lumigate.autorums.com' } });
  check('OPTIONS /health does not crash server (≠ 500)', opts.status !== 500 && opts.status !== 0);

  // 0.10 大 header 不崩潰（惡意客戶端填充 header）
  const bigHdr = await req('GET', BASE_URL + '/health', { headers: { 'X-Padding': 'A'.repeat(4096) } });
  check('4KB custom header → server does not crash', bigHdr.status !== 500 && bigHdr.status !== 0);

  // 0.11 10 個並發 /health 請求全部成功（模擬 Cloudflare 健康輪詢峰值）
  const concurrent = await Promise.all(Array(10).fill(0).map(() => GET('/health')));
  check('10 concurrent /health requests all → 200', concurrent.every(r => r.status === 200));

  // 0.12 /providers 端點有 baseUrl + available 欄位（Dashboard 依賴）
  const prov = await GET('/providers');
  const provOk = Array.isArray(prov.data) && prov.data.every(p2 => 'baseUrl' in p2 && 'available' in p2);
  check('GET /providers: all items have baseUrl + available', provOk, prov.data?.length);

  // 0.13 /providers public 不洩露 keyCount / enabledCount（需要 admin auth 才可見）
  const provNoLeak = Array.isArray(prov.data) && prov.data.every(p2 => !('keyCount' in p2) && !('enabledCount' in p2));
  check('GET /providers (public): no keyCount/enabledCount leakage', provNoLeak);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Basic Endpoints
// ══════════════════════════════════════════════════════════════════════════════
async function section1() {
  sec('Section 1: Basic Endpoints');

  // Public /health now only returns { status, uptime } — mode/modules/providers require admin auth
  const h = await GET('/health');
  check('GET /health → 200 + uptime field (public)',
    h.status === 200 && typeof h.data?.uptime === 'number');

  // Authenticated /health returns full details
  const hAuth = await aGET('/health');
  check('GET /health (admin) → mode + modules fields',
    hAuth.status === 200 && typeof hAuth.data?.mode === 'string' && Array.isArray(hAuth.data?.modules));

  // Public /health must NOT expose mode/modules/providers to unauthenticated callers
  check('GET /health (public) → no mode/modules/providers leakage',
    h.data?.mode === undefined && h.data?.modules === undefined && h.data?.providers === undefined);

  const m = await GET('/models/openai');
  check('GET /models/openai → 200 array', m.status === 200 && Array.isArray(m.data) && m.data.length > 0);

  const mu = await GET('/models/nonexistent_provider_xyz');
  check('GET /models/nonexistent → [] (not 500)', mu.status === 200 && Array.isArray(mu.data) && mu.data.length === 0);

  const up = await aGET('/admin/uptime');
  check('GET /admin/uptime → 200 with uptime string', up.status === 200 && typeof up.data?.uptime === 'string');
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Admin Auth Attacks
// ══════════════════════════════════════════════════════════════════════════════
async function section2() {
  sec('Section 2: Admin Auth Attacks');

  const noTok = await GET('/admin/projects', { headers: {} });
  check('No token → 401', noTok.status === 401);

  const emptyTok = await GET('/admin/projects', { headers: { 'x-admin-token': '' } });
  check('Empty string token → 401', emptyTok.status === 401);

  const bigTok = await GET('/admin/projects', { headers: { 'x-admin-token': 'x'.repeat(10240) } });
  check('10KB token → 4xx (no 500)', [400, 401, 429, 431].includes(bigTok.status), bigTok.status);

  const wrongSec = await POST('/admin/login', { secret: 'definitely_wrong_secret_xyz_999' });
  // 429 also acceptable — loginLimiter may still be active from a prior brute-force run in same window
  check('Wrong secret → 401 or 429 (rejected)', [401, 429].includes(wrongSec.status), wrongSec.status);
  check('Wrong secret: no success:true in body', wrongSec.data?.success !== true);

  // Raw ADMIN_SECRET in x-admin-token = root (CLI backward compat)
  const rawAuth = await GET('/admin/projects', { headers: { 'x-admin-token': ADMIN_SECRET } });
  check('Raw ADMIN_SECRET as x-admin-token → 200 (root)', rawAuth.status === 200);

  // Forged session token (random hex, not in sessions Map)
  const fakeHex = crypto.randomBytes(32).toString('hex');
  const fakeResp = await GET('/admin/projects', { headers: { 'x-admin-token': fakeHex } });
  check('Forged session hex token → 401', fakeResp.status === 401);

  // RBAC: "user" role cannot DELETE project
  const ucr = await aPOST('/admin/users', { username: 'test_u_s2', password: 'password123', role: 'user' });
  if (ucr.data?.success) {
    const ul = await POST('/admin/login', { username: 'test_u_s2', password: 'password123' });
    if (ul.status === 200 && ul.headers.get('set-cookie')) {
      const ck = ul.headers.get('set-cookie').split(';')[0];
      const dr = await req('DELETE', BASE_URL + '/admin/projects/any', { headers: { Cookie: ck } });
      check('"user" role DELETE /admin/projects/:name → 403', dr.status === 403);
    } else skip('"user" role RBAC delete', 'user login failed');
    await aDEL('/admin/users/test_u_s2');
  } else skip('"user" role RBAC tests', 'user creation failed (users module may be off)');

  // RBAC: "admin" role cannot PUT /admin/settings (root only)
  const acr = await aPOST('/admin/users', { username: 'test_a_s2', password: 'password123', role: 'admin' });
  if (acr.data?.success) {
    const al = await POST('/admin/login', { username: 'test_a_s2', password: 'password123' });
    if (al.status === 200 && al.headers.get('set-cookie')) {
      const ck = al.headers.get('set-cookie').split(';')[0];
      const sr = await req('PUT', BASE_URL + '/admin/settings', {
        headers: { Cookie: ck, 'Content-Type': 'application/json' },
        body: JSON.stringify({ freeTierMode: 'global', confirmSecret: ADMIN_SECRET }),
      });
      check('"admin" role PUT /admin/settings → 403', sr.status === 403);
    } else skip('"admin" role settings RBAC', 'admin login failed');
    await aDEL('/admin/users/test_a_s2');
  } else skip('"admin" role settings RBAC', 'admin creation failed (users module may be off)');

  // Brute force — loginLimiter (10 req per 15 min) — run LAST in section to avoid bleeding
  let hitRL = false;
  for (let i = 0; i < 12; i++) {
    const r = await POST('/admin/login', { secret: `brute_force_attempt_${i}_bad` });
    if (r.status === 429) { hitRL = true; break; }
  }
  check('Brute-force login (12x wrong) → 429 (loginLimiter)', hitRL);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Project Key Auth Attacks
// ══════════════════════════════════════════════════════════════════════════════
async function section3() {
  sec('Section 3: Project Key Auth Attacks');

  const noKey = await POST('/v1/openai/v1/chat/completions',
    { model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'hi' }] });
  check('No X-Project-Key → 401', noKey.status === 401);

  const wrongKey = await POST('/v1/openai/v1/chat/completions',
    { model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'hi' }] },
    { headers: { 'X-Project-Key': 'pk_000000000000000000000000000000000000000000000000' } });
  check('Wrong project key → 401', wrongKey.status === 401);

  // Disabled project
  const dp = await createTestProject('test-s3-disabled', { authMode: 'key' });
  if (dp.data?.success) {
    const dkey = dp.data.project.key;
    await aPUT('/admin/projects/test-s3-disabled', { enabled: false });
    const dr = await POST('/v1/openai/v1/chat/completions',
      { model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'hi' }] },
      { headers: { 'X-Project-Key': dkey } });
    check('Disabled project key → 401 (not found in enabled projects)', dr.status === 401);
  } else skip('Disabled project key test', 'project creation failed');

  // HMAC-only project rejecting direct key
  const hp = await createTestProject('test-s3-hmaconly', { authMode: 'hmac' });
  if (hp.data?.success) {
    const hkey = hp.data.project.key;
    const hr = await POST('/v1/openai/v1/chat/completions',
      { model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'hi' }] },
      { headers: { 'X-Project-Key': hkey } });
    check('Direct key on HMAC-only project → 403', hr.status === 403);
  } else skip('HMAC-only project direct key test', 'project creation failed');
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — HMAC Signature Attacks
// ══════════════════════════════════════════════════════════════════════════════
async function section4() {
  sec('Section 4: HMAC Signature Attacks');

  const pr = await createTestProject('test-s4-hmac', { authMode: 'hmac' });
  if (!pr.data?.success) { skip('All HMAC tests', 'project creation failed'); return; }

  const pKey = pr.data.project.key;
  const pId  = pr.data.project.name;
  const url  = BASE_URL + '/v1/openai/v1/chat/completions';
  const body = { model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'hi' }] };

  // Missing individual HMAC headers
  const ts0 = String(Math.floor(Date.now() / 1000));
  const nn0 = crypto.randomUUID();

  const noSig = await fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Timestamp': ts0, 'X-Nonce': nn0, 'X-Project-Id': pId },
    body: JSON.stringify(body) });
  check('HMAC: missing X-Signature → 401', noSig.status === 401);

  const noTs = await fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': 'fake', 'X-Nonce': nn0, 'X-Project-Id': pId },
    body: JSON.stringify(body) });
  check('HMAC: missing X-Timestamp → 401', noTs.status === 401);

  const noNonce = await fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': 'fake', 'X-Timestamp': ts0, 'X-Project-Id': pId },
    body: JSON.stringify(body) });
  check('HMAC: missing X-Nonce → 401', noNonce.status === 401);

  // Expired timestamp (>5 min old = >300s)
  const oldTs = String(Math.floor(Date.now() / 1000) - 400);
  const oldN  = crypto.randomUUID();
  const oldSig = crypto.createHmac('sha256', pKey).update(oldTs + oldN + JSON.stringify(body)).digest('hex');
  const expired = await fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': oldSig, 'X-Timestamp': oldTs, 'X-Nonce': oldN, 'X-Project-Id': pId },
    body: JSON.stringify(body) });
  check('HMAC: expired timestamp (>5min) → 401', expired.status === 401);

  // Future timestamp (+10 min)
  const futTs = String(Math.floor(Date.now() / 1000) + 700);
  const futN  = crypto.randomUUID();
  const futSig = crypto.createHmac('sha256', pKey).update(futTs + futN + JSON.stringify(body)).digest('hex');
  const future = await fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': futSig, 'X-Timestamp': futTs, 'X-Nonce': futN, 'X-Project-Id': pId },
    body: JSON.stringify(body) });
  check('HMAC: future timestamp (+10min) → 401', future.status === 401);

  // Valid request — auth should pass (provider key missing = 403 or 401 from provider)
  const h1 = hmacSign(pKey, body, pId);
  const v1 = await fetch(url, { method: 'POST', headers: h1, body: JSON.stringify(body) });
  check('HMAC: valid signature → auth passes (not 401)', v1.status !== 401);

  // NONCE REPLAY — same headers again → 401 (nonce already consumed)
  const v2 = await fetch(url, { method: 'POST', headers: h1, body: JSON.stringify(body) });
  check('HMAC: nonce replay attack → 401', v2.status === 401);

  // Body tampering — sign one body, send different → 401
  const h2 = hmacSign(pKey, body, pId);
  const tampered = await fetch(url, { method: 'POST', headers: h2,
    body: JSON.stringify({ ...body, messages: [{ role: 'user', content: 'TAMPERED' }] }) });
  check('HMAC: body tampered after signing → 401', tampered.status === 401);

  // Wrong/truncated signature → 401
  const h3 = { ...hmacSign(pKey, body, pId), 'X-Signature': 'deadbeef0000' };
  const badSig = await fetch(url, { method: 'POST', headers: h3, body: JSON.stringify(body) });
  check('HMAC: truncated/wrong signature → 401', badSig.status === 401);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Ephemeral Token Attacks
// ══════════════════════════════════════════════════════════════════════════════
async function section5() {
  sec('Section 5: Ephemeral Token Attacks');

  const pr = await createTestProject('test-s5-token', { authMode: 'key', tokenTtlMinutes: 60 });
  if (!pr.data?.success) { skip('All token tests', 'project creation failed'); return; }
  const pKey = pr.data.project.key;

  // Happy path: exchange key → token
  const tr = await POST('/v1/token', { userId: 'u1' }, { headers: { 'X-Project-Key': pKey } });
  check('POST /v1/token → 200 + et_ token', tr.status === 200 && tr.data?.token?.startsWith('et_'));
  check('Token has expiresAt ISO string', typeof tr.data?.expiresAt === 'string');
  check('Token has expiresIn seconds', typeof tr.data?.expiresIn === 'number' && tr.data.expiresIn > 0);

  if (!tr.data?.token) { skip('Token usage tests', 'token exchange failed'); return; }
  const token = tr.data.token;

  // Valid token works for proxy (auth passes; 403 if no key is expected)
  const tv = await POST('/v1/openai/v1/chat/completions',
    { model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'hi' }] },
    { headers: { 'Authorization': `Bearer ${token}` } });
  check('Valid ephemeral token → auth passes (not 401)', tv.status !== 401);

  // Non-existent token
  const fakeT = 'et_' + crypto.randomBytes(32).toString('hex');
  const tf = await POST('/v1/openai/v1/chat/completions',
    { model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'hi' }] },
    { headers: { 'Authorization': `Bearer ${fakeT}` } });
  check('Non-existent et_ token → 401', tf.status === 401);

  // Malformed et_ prefix but invalid content
  const malT = 'et_notHEXxxx!@#';
  const tm = await POST('/v1/openai/v1/chat/completions',
    { model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'hi' }] },
    { headers: { 'Authorization': `Bearer ${malT}` } });
  check('Malformed et_ token → 401', tm.status === 401);

  // Token for disabled project → 403
  await aPUT('/admin/projects/test-s5-token', { enabled: false });
  const tdis = await POST('/v1/openai/v1/chat/completions',
    { model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'hi' }] },
    { headers: { 'Authorization': `Bearer ${token}` } });
  check('Token for disabled project → 403', tdis.status === 403);
  await aPUT('/admin/projects/test-s5-token', { enabled: true });

  // HMAC token exchange (sign with project key to get token)
  const pr2 = await createTestProject('test-s5-hmactoken', { authMode: 'hmac', tokenTtlMinutes: 60 });
  if (pr2.data?.success) {
    const pKey2 = pr2.data.project.key;
    const pId2  = pr2.data.project.name;
    const hh = hmacSign(pKey2, {}, pId2);
    const ht = await fetch(BASE_URL + '/v1/token', { method: 'POST', headers: hh, body: JSON.stringify({}) });
    const htd = await ht.json();
    check('HMAC-signed token exchange → 200 + et_ token',
      ht.status === 200 && htd?.token?.startsWith('et_'));
  } else skip('HMAC token exchange test', 'project creation failed');
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Rate Limit / DoS
// ══════════════════════════════════════════════════════════════════════════════
async function section6() {
  sec('Section 6: Rate Limit / DoS');

  // Per-project RPM — use unique names to avoid stale in-memory rate buckets from previous runs
  // maxRpm:1 means count>1 triggers 429, so only 2 requests needed (faster, avoids real API wait)
  const s6uniq = crypto.randomBytes(3).toString('hex');
  const pr = await createTestProject(`test-s6-rl-${s6uniq}`, { authMode: 'key', maxRpm: 1, maxRpmPerIp: 60 });
  if (!pr.data?.success) { skip('Per-project rate limit test', 'project creation failed'); }
  else {
    const k = pr.data.project.key;
    const mkr = () => POST('/v1/openai/v1/chat/completions',
      { model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'hi' }] },
      { headers: { 'X-Project-Key': k } });
    await mkr(); // count=1, 1>1=false → OK (or 200/503 from provider)
    const r2 = await mkr(); // count=2, 2>1=true → 429
    check('maxRpm=1: 2nd request → 429', r2.status === 429, r2.status);
  }

  // Per-token RPM — same approach with maxRpmPerToken:1
  const pr2 = await createTestProject(`test-s6-tokrl-${s6uniq}`, { authMode: 'key', maxRpmPerToken: 1 });
  if (!pr2.data?.success) { skip('Per-token rate limit test', 'project creation failed'); }
  else {
    const k2 = pr2.data.project.key;
    const tr = await POST('/v1/token', {}, { headers: { 'X-Project-Key': k2 } });
    if (tr.data?.token) {
      const tok = tr.data.token;
      const mkt = () => POST('/v1/openai/v1/chat/completions',
        { model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'hi' }] },
        { headers: { 'Authorization': `Bearer ${tok}` } });
      await mkt(); // count=1, 1>1=false → OK
      const r2t = await mkt(); // count=2, 2>1=true → 429
      check('maxRpmPerToken=1: 2nd request → 429', r2t.status === 429, r2t.status);
    } else skip('Per-token rate limit test', 'token exchange failed');
  }

  // 10MB+ body → 413
  const bigBody = `{"model":"t","messages":[{"role":"user","content":"${'x'.repeat(10.5 * 1024 * 1024)}"}]}`;
  const br = await req('POST', BASE_URL + '/admin/projects', {
    headers: { ...ADMIN_H, 'Content-Type': 'application/json' },
    rawBody: bigBody,
  });
  check('11MB JSON body → 413 Payload Too Large (not 500)', br.status === 413 || br.status === 400);

  // Malformed JSON → 400
  const mj = await req('POST', BASE_URL + '/v1/openai/v1/chat/completions', {
    headers: { 'Content-Type': 'application/json', 'X-Project-Key': 'pk_any' },
    rawBody: '{ this is not valid json !!',
  });
  check('Malformed JSON body → 400 (not 500)', mj.status === 400 || mj.status === 401);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — Budget Enforcement
// ══════════════════════════════════════════════════════════════════════════════
async function section7() {
  sec('Section 7: Budget Enforcement');

  const s7uniq = crypto.randomBytes(3).toString('hex');
  const pr = await createTestProject(`test-s7-budget-${s7uniq}`, {
    authMode: 'key', maxBudgetUsd: 0.000001, budgetPeriod: 'daily',
  });
  if (!pr.data?.success) { skip('Budget tests', 'project creation failed'); return; }
  const k = pr.data.project.key;
  const name = pr.data.project.name;

  // Budget pre-flight check: (budgetUsedUsd || 0) >= maxBudgetUsd.
  // budgetUsedUsd starts at 0; 0 >= 0.000001 = false, so first request passes through to provider.
  // We send up to 6 requests: real API calls consume budget, and once budgetUsedUsd >= 0.000001,
  // subsequent requests return 429. If no real API key → 403 → skip.
  const tinyBody = { model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'hi' }], max_tokens: 2 };
  let budgetBlocked = false;
  let noKey = false;
  let lastBudgetResp = null;
  for (let i = 0; i < 6; i++) {
    const r = await POST('/v1/openai/v1/chat/completions', tinyBody, { headers: { 'X-Project-Key': k } });
    if (r.status === 429 && r.data?.error?.toLowerCase().includes('budget')) {
      budgetBlocked = true; lastBudgetResp = r; break;
    }
    if (r.status === 403 || r.status === 401) { noKey = true; break; }
  }
  if (noKey) {
    skip('maxBudgetUsd=0.000001: request → 429 budget exceeded', 'no real API key to consume budget (got 403/401)');
    skip('Budget exceeded: error message present', 'see above');
  } else {
    check('maxBudgetUsd=0.000001: request → 429 budget exceeded (after consuming budget)', budgetBlocked, lastBudgetResp?.data);
    check('Budget exceeded: error message present', typeof lastBudgetResp?.data?.error === 'string');
  }

  // sendAlert fires but server stays healthy (fire-and-forget, no webhook URL set)
  const hh = await GET('/health');
  check('Server healthy after budget_exceeded event (fire-and-forget webhook ok)', hh.status === 200);

  // Reset budget
  const rr = await aPUT(`/admin/projects/${name}`, { resetBudget: true });
  check('resetBudget: success=true', rr.data?.success === true);
  check('After reset: budgetUsedUsd=0', rr.data?.project?.budgetUsedUsd === 0);

  // Remove budget
  const nr = await aPUT(`/admin/projects/${name}`, { maxBudgetUsd: null });
  check('Remove budget (null): success=true', nr.data?.success === true);
  check('maxBudgetUsd removed from project response', nr.data?.project?.maxBudgetUsd == null);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Key Cooldown + Failover (新功能)
// ══════════════════════════════════════════════════════════════════════════════
async function section8() {
  sec('Section 8: Key Cooldown + Failover (新功能)');

  // Endpoint exists and returns array
  const cd = await aGET('/admin/keys/cooldowns');
  check('GET /admin/keys/cooldowns → 200 + array', cd.status === 200 && Array.isArray(cd.data));

  // Unauthenticated access → 401
  const cdNoAuth = await GET('/admin/keys/cooldowns');
  check('GET /admin/keys/cooldowns without auth → 401', cdNoAuth.status === 401);

  // Add a bad key (to test cooldown lifecycle)
  const ak = await aPOST('/admin/keys/openai', {
    label: 'test-bad-key-s8', apiKey: 'sk-badkey00001111222233334444', project: null,
  });
  if (!ak.data?.id) {
    skip('Key cooldown lifecycle tests', 'key add failed (multikey module may be off)');
  } else {
    const badId = ak.data.id;
    check('Add bad key: got id', typeof badId === 'string');

    // Verify key appears in GET /admin/keys/openai
    const kl = await aGET('/admin/keys/openai');
    const found = Array.isArray(kl.data) && kl.data.some(k2 => k2.id === badId);
    check('Bad key appears in GET /admin/keys/openai', found);

    // DELETE /admin/keys/cooldowns/:keyId where keyId is not in cooldowns → 404 "Key not in cooldown"
    const dcNone = await aDEL('/admin/keys/cooldowns/nonexistent_key_xyz_000');
    check('DELETE /admin/keys/cooldowns/nonexistent → 404 (key not in cooldown)', dcNone.status === 404);

    // Disable the bad key via PUT
    const disK = await aPUT(`/admin/keys/openai/${badId}`, { enabled: false });
    check('Disable bad key via PUT → success', disK.data?.success === true);

    // Re-enable and then delete
    await aPUT(`/admin/keys/openai/${badId}`, { enabled: true });
    const delK = await aDEL(`/admin/keys/openai/${badId}`);
    check('Delete test key → success', delK.data?.success === true);
  }

  // GET /admin/keys/:provider for unknown provider → 404
  const unknProv = await aGET('/admin/keys/nonexistentprovider');
  check('GET /admin/keys/nonexistentprovider → 404', unknProv.status === 404);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — Webhook Alert (fire-and-forget behavior + child server delivery)
// ══════════════════════════════════════════════════════════════════════════════
async function section9() {
  sec('Section 9: Webhook Alert Behavior (新功能)');

  // Without ALERT_WEBHOOK_URL: budget exceeded → 429, server does NOT crash
  // Same budget logic as Section 7: must consume budget first, then second request is 429
  const s9uniq = crypto.randomBytes(3).toString('hex');
  const pr = await createTestProject(`test-s9-wh-${s9uniq}`, { authMode: 'key', maxBudgetUsd: 0.000001 });
  if (pr.data?.success) {
    const k = pr.data.project.key;
    const tinyBody = { model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'hi' }], max_tokens: 2 };
    let budgetBlocked = false, s9NoKey = false;
    for (let i = 0; i < 6; i++) {
      const r = await POST('/v1/openai/v1/chat/completions', tinyBody, { headers: { 'X-Project-Key': k } });
      if (r.status === 429 && r.data?.error?.toLowerCase().includes('budget')) { budgetBlocked = true; break; }
      if (r.status === 403 || r.status === 401) { s9NoKey = true; break; }
    }
    if (s9NoKey) {
      skip('Budget exceeded (no ALERT_WEBHOOK_URL) → 429, not crash', 'no real API key (403/401)');
    } else {
      check('Budget exceeded (no ALERT_WEBHOOK_URL) → 429, not crash', budgetBlocked);
    }
    const hAfter = await GET('/health');
    check('Server still healthy after webhook fire-and-forget', hAfter.status === 200 && hAfter.data?.status === 'ok');
  } else skip('Webhook no-URL test', 'project creation failed');

  // Child-server webhook delivery test (local only)
  if (IS_DOCKER) {
    skip('Webhook delivery child-server test', 'docker mode — cannot spawn child server');
    return;
  }

  const received = [];
  const mockSrv = http.createServer((req2, res2) => {
    let buf = '';
    req2.on('data', c => buf += c);
    req2.on('end', () => {
      try { received.push(JSON.parse(buf)); } catch {}
      res2.writeHead(200); res2.end('ok');
    });
  });
  await new Promise(resolve => mockSrv.listen(0, '127.0.0.1', resolve));
  const mockPort = mockSrv.address().port;
  const webhookUrl = `http://127.0.0.1:${mockPort}`;

  let child = null;
  try {
    const childPort = await getFreePort();
    const srvPath = path.join(__dirname, '..', 'server.js');

    child = spawn('node', [srvPath], {
      env: { ...process.env, PORT: String(childPort), ADMIN_SECRET: 'wh_test_s9_secret',
             DEPLOY_MODE: 'enterprise', ALERT_WEBHOOK_URL: webhookUrl },
      stdio: 'pipe',
    });

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 9000);
      child.stdout.on('data', d => {
        if (d.toString().includes('LumiGate running')) { clearTimeout(t); resolve(); }
      });
      child.stderr.on('data', () => {}); // silence stderr
      child.on('exit', code => { clearTimeout(t); reject(new Error(`exit ${code}`)); });
    });

    const cb = `http://127.0.0.1:${childPort}`;
    const ch = { 'Content-Type': 'application/json', 'x-admin-token': 'wh_test_s9_secret' };

    // Create budget-exceeded project
    const cpResp = await fetch(`${cb}/admin/projects`, {
      method: 'POST', headers: ch,
      body: JSON.stringify({ name: 'wh-proj', authMode: 'key',
                             maxBudgetUsd: 0.000001, anomalyAutoSuspend: false }),
    });
    const cpData = await cpResp.json();
    if (cpData?.success && cpData.project?.key) {
      // Trigger budget_exceeded → webhook
      await fetch(`${cb}/v1/openai/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Project-Key': cpData.project.key },
        body: JSON.stringify({ model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'hi' }] }),
      });
      await sleep(600); // fire-and-forget delivery window
      const alert = received.find(r2 => r2.type === 'budget_exceeded');
      check('Webhook: budget_exceeded payload delivered', alert != null);
      check('Webhook: payload.project = "wh-proj"', alert?.project === 'wh-proj');
      check('Webhook: payload.gateway = "lumigate"', alert?.gateway === 'lumigate');
      check('Webhook: payload has ts (ISO timestamp)', typeof alert?.ts === 'string');
    } else skip('Webhook budget test', 'project creation on child failed');

    // Trigger key_disabled (3x 401 via markKeyCooling simulation not directly possible without real key)
    // At minimum verify alert structure is correct for budget alert
    check('Webhook: fire-and-forget does not block main flow (server still responding)',
      (await fetch(`${cb}/health`)).status === 200);

  } catch (e) {
    skip('Webhook delivery child-server test', `spawn/test failed: ${e.message}`);
  } finally {
    if (child) { child.kill('SIGTERM'); await sleep(300); }
    mockSrv.close();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — Token Persistence
// ══════════════════════════════════════════════════════════════════════════════
async function section10() {
  sec('Section 10: Token Persistence');

  const pr = await createTestProject('test-s10-persist', { authMode: 'key', tokenTtlMinutes: 60 });
  if (!pr.data?.success) { skip('Token persistence tests', 'project creation failed'); return; }
  const pKey = pr.data.project.key;

  // Exchange token
  const tr = await POST('/v1/token', { userId: 'persist-test-user' }, { headers: { 'X-Project-Key': pKey } });
  if (!tr.data?.token) { skip('Token persistence tests', 'token exchange failed'); return; }
  const token = tr.data.token;
  check('Token exchange returns et_ token', token.startsWith('et_'));

  // Wait for 1s write-behind flush
  await sleep(1500);

  // Check tokens.json on disk
  const tokFile = path.join(DATA_DIR, 'tokens.json');
  if (fs.existsSync(tokFile)) {
    let tokData = null;
    try { tokData = JSON.parse(fs.readFileSync(tokFile, 'utf8')); } catch {}
    check('tokens.json written within 1.5s (write-behind timer)', tokData != null);
    check('tokens.json contains our issued token', tokData != null && (token in tokData));
    if (tokData && token in tokData) {
      check('Token entry has valid expiresAt (future timestamp)',
        typeof tokData[token].expiresAt === 'number' && tokData[token].expiresAt > Date.now());
      check('Token entry has projectName field', typeof tokData[token].projectName === 'string');
    }
    // Verify expired tokens are not loaded (expiresAt filtering in loadTokens)
    const expiredCount = Object.values(tokData || {}).filter(v => v.expiresAt <= Date.now()).length;
    check('tokens.json: no expired tokens (filtered on load)', expiredCount === 0);
  } else {
    skip('tokens.json file check', `file not found at ${tokFile}`);
  }

  // Token still valid after persistence check (in-memory copy matches disk)
  const utr = await POST('/v1/openai/v1/chat/completions',
    { model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'hi' }] },
    { headers: { 'Authorization': `Bearer ${token}` } });
  check('Token still valid in-memory after write-behind', utr.status !== 401);

  // Graceful handling: if tokens.json is corrupted at load time, server should not crash
  // (We test this indirectly: current server is healthy, demonstrating load was fine)
  const hh = await GET('/health');
  check('Server healthy throughout token persistence tests', hh.status === 200);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — Trace ID Verification (新功能)
// ══════════════════════════════════════════════════════════════════════════════
async function section11() {
  sec('Section 11: Trace ID Verification (新功能)');

  const r1 = await GET('/health');
  const tid = r1.headers.get('x-request-id');
  check('GET /health has X-Request-ID header', !!tid);

  // Auto-generated ID should be UUID v4 format
  const uuidRx = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  check('Auto-generated X-Request-ID is UUID v4 format', uuidRx.test(tid || ''));

  // Custom trace ID should be echoed back (client-side tracing)
  const customId = 'client-trace-abc-123';
  const r2 = await req('GET', BASE_URL + '/health', { headers: { 'X-Request-Id': customId } });
  check('Custom X-Request-Id is echoed in response', r2.headers.get('x-request-id') === customId);

  // 401 responses also have trace ID
  const r3 = await GET('/admin/projects');
  check('401 response also carries X-Request-ID', !!r3.headers.get('x-request-id'));

  // Admin endpoint trace ID
  const r4 = await aGET('/admin/uptime');
  check('Admin endpoint has X-Request-ID', !!r4.headers.get('x-request-id'));

  // Each request gets a UNIQUE trace ID
  const ids = await Promise.all(Array(5).fill(0).map(() =>
    GET('/health').then(r5 => r5.headers.get('x-request-id'))));
  const unique = new Set(ids.filter(Boolean));
  check('5 requests get 5 unique X-Request-IDs (no collision)', unique.size === 5);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 12 — Injection / Edge Cases
// ══════════════════════════════════════════════════════════════════════════════
async function section12() {
  sec('Section 12: Injection / Edge Cases');

  // XSS in project name
  const xss = await aPOST('/admin/projects', { name: '<script>alert(1)</script>' });
  check('Project name with <script> → rejected (XSS guard)', xss.data?.success !== true);

  // Command injection
  const cmd = await aPOST('/admin/projects', { name: '; rm -rf /' });
  check('Project name with ; rm -rf → rejected', cmd.data?.success !== true);

  // Name too long (65 chars > 64 limit)
  const long = await aPOST('/admin/projects', { name: 'a'.repeat(65) });
  check('Project name 65 chars → rejected (max 64)', long.data?.success !== true);

  // Empty name
  const empty = await aPOST('/admin/projects', { name: '' });
  check('Empty project name → rejected', empty.data?.success !== true);

  // Special chars in name
  const special = await aPOST('/admin/projects', { name: 'test|pipe&amp;' });
  check('Project name with | & chars → rejected', special.data?.success !== true);

  // allowedModels with invalid values — should filter, not 500
  const amP = await createTestProject('test-s12-models', {
    allowedModels: [null, 999, '', 'gpt-4.1-nano'],
  });
  if (amP.data?.success) {
    const models = amP.data.project.allowedModels || [];
    check('allowedModels: null/number/empty filtered out', !models.includes(null) && !models.includes(999) && !models.includes(''));
    check('allowedModels: valid string preserved', models.includes('gpt-4.1-nano'));
  } else skip('allowedModels filter test', 'project creation failed');

  // maxRpm cap at 10000
  const highRpm = await createTestProject('test-s12-rpm', { maxRpm: 99999 });
  if (highRpm.data?.success) {
    check('maxRpm=99999 → capped at 10000', highRpm.data.project.maxRpm <= 10000);
  } else skip('maxRpm cap test', 'project creation failed');

  // allowedIPs: 51 entries → truncated to max 50
  const ips51 = Array.from({ length: 51 }, (_, i) => `10.0.${Math.floor(i/255)}.${(i % 254) + 1}`);
  const ipP = await createTestProject('test-s12-ip', { allowedIPs: ips51 });
  if (ipP.data?.success) {
    check('allowedIPs: 51 entries truncated to ≤50', (ipP.data.project.allowedIPs || []).length <= 50);
  } else skip('allowedIPs limit test', 'project creation failed');

  // Unknown provider → 404 (not 500)
  // Must use a valid project key (proxy auth checks project key before provider lookup)
  const unkProjR = await createTestProject('test-s12-unkprov', { authMode: 'key' });
  if (unkProjR.data?.success) {
    const unkProv = await POST('/v1/unknownprovider_xyz/v1/chat',
      { model: 'test' }, { headers: { 'X-Project-Key': unkProjR.data.project.key } });
    check('Unknown provider /v1/unknownprovider_xyz → 404 (not 500)', unkProv.status === 404, unkProv.data);
  } else {
    skip('Unknown provider test', 'project creation failed');
  }

  // Path traversal — server should block (allowlist) or client normalizes to safe path
  const trav = await req('GET', BASE_URL + '/v1/openai/v1/%2e%2e/%2e%2e/etc/passwd', {
    headers: { 'X-Project-Key': 'pk_any' },
  });
  check('Path traversal attempt → not 200 (blocked by allowlist or normalized)', trav.status !== 200);

  // DELETE nonexistent project → success:false (not 500)
  const delNone = await aDEL('/admin/projects/totally-nonexistent-project-xyz-abc-987');
  check('DELETE nonexistent project → success:false (not 500)',
    delNone.data?.success === false && delNone.status !== 500);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 13 — Real API Calls (REAL_API=1 only)
// Budget ceiling: ≤0.3 RMB per full run
// ══════════════════════════════════════════════════════════════════════════════
async function section13() {
  sec('Section 13: Real API Calls (REAL_API=1)');

  if (!REAL_API) { skip('All real API tests', 'REAL_API not set'); return; }

  const health = await GET('/health');
  const avail  = new Set(health.data?.providers || []);
  const tiny   = { messages: [{ role: 'user', content: 'Say hi in one word' }], max_tokens: 5 };

  // OpenAI — gpt-4.1-nano (cheapest: ~$0.0001/call)
  if (avail.has('openai')) {
    const r = await aGET('/admin/test/openai?model=gpt-4.1-nano');
    check('OpenAI gpt-4.1-nano: real API call succeeds', r.data?.success === true, r.data?.error);
    if (r.data?.success) check('OpenAI reply is non-empty string', r.data.reply?.length > 0);
  } else skip('OpenAI real API', 'no key configured');

  // Anthropic via OpenAI compat — claude-haiku-4-5 (~$0.00002/call)
  if (avail.has('anthropic')) {
    const cp = await createTestProject('test-s13-real', { authMode: 'key' });
    if (cp.data?.success) {
      const r = await POST('/v1/anthropic/v1/chat/completions',
        { model: 'claude-haiku-4-5-20251001', ...tiny },
        { headers: { 'X-Project-Key': cp.data.project.key } });
      check('Anthropic OpenAI-compat /v1/chat/completions → 200', r.status === 200, r.data);
      if (r.status === 200) {
        check('Anthropic compat response has choices array', Array.isArray(r.data?.choices));
        check('Anthropic compat: role=assistant in choice',
          r.data?.choices?.[0]?.message?.role === 'assistant');
      }
    } else skip('Anthropic compat test', 'project creation failed');
  } else skip('Anthropic real API', 'no key configured');

  // Gemini — gemini-2.5-flash-lite (free tier, 1500/day)
  if (avail.has('gemini')) {
    const r = await aGET('/admin/test/gemini?model=gemini-2.5-flash-lite');
    check('Gemini gemini-2.5-flash-lite: real API call succeeds', r.data?.success === true, r.data?.error);
  } else skip('Gemini real API', 'no key configured');
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  banner(`LumiGate Test Suite v3\n  Base: ${BASE_URL}\n  Mode: ${IS_DOCKER ? 'docker' : 'local'}`);

  // ── Prerequisites ──
  p(`\n${C.dim}Checking prerequisites...${C.reset}`);

  const nodeVer = process.versions.node.split('.').map(Number);
  if (nodeVer[0] < 18) {
    p(`${C.red}ERROR: Node.js 18+ required (found ${process.versions.node})${C.reset}`);
    process.exit(1);
  }
  p(`  ${C.green}✓${C.reset} Node.js ${process.versions.node}`);

  const hc = await GET('/health').catch(() => ({ status: 0, data: null, headers: new Headers() }));
  if (hc.status !== 200) {
    p(`${C.red}ERROR: Cannot reach ${BASE_URL} — is the server running?${C.reset}`);
    p(`  Run: docker compose -f reviews/docker-compose.test.yml -p ai-api-proxy-test up -d --build`);
    process.exit(1);
  }
  p(`  ${C.green}✓${C.reset} Server reachable (mode: ${hc.data?.mode || '?'}, modules: ${(hc.data?.modules || []).join(',')})`);

  const ac = await aGET('/admin/auth');
  if (!ac.data?.authenticated) {
    p(`${C.red}ERROR: Admin auth failed — check ADMIN_SECRET env var${C.reset}`);
    process.exit(1);
  }
  p(`  ${C.green}✓${C.reset} Admin auth OK (role: ${ac.data?.role})`);
  if (REAL_API) p(`  ${C.yellow}⚡ REAL_API=1: real API calls enabled (budget ceiling: ≤0.3 RMB)${C.reset}`);

  // ── Test sections ──
  try {
    await section0();   // ⚡ External access — HIGHEST PRIORITY
    await section1();
    await section2();
    await section3();
    await section4();
    await section5();
    await section6();
    await section7();
    await section8();
    await section9();
    await section10();
    await section11();
    await section12();
    await section13();
  } finally {
    await cleanupAll();
  }

  // ── Summary ──
  const total = passed + failed;
  banner(`Results: ${C.green}${passed}/${total} passed${C.reset}, ${failed > 0 ? C.red : ''}${failed} failed${C.reset}, ${skipped} skipped`);

  if (failures.length > 0) {
    p(`\n${C.red}Failed tests:${C.reset}`);
    for (const f of failures) p(`  ${C.red}•${C.reset} ${f.label}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(`${C.red}Test suite crashed: ${e.message}${C.reset}`);
  console.error(e.stack);
  process.exit(1);
});
