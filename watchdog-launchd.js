#!/usr/bin/env node
'use strict';

/**
 * AutoRums LaunchDaemon Watchdog
 * Monitors LumiGate + PocketBase; heals on Docker crash or container failure.
 *
 * Install (one-liner):  sudo node watchdog-launchd.js --full-install
 * Stop:                 sudo lg kill
 */

const { execSync, execFileSync } = require('child_process');
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const crypto = require('crypto');
const path   = require('path');

// ─── Services config ───────────────────────────────────────────────────────
const SERVICES = {
  lumigate: {
    label:      'LumiGate',
    healthUrl:  'http://localhost:9471/health',
    composeDir: '/Volumes/SSD Acer M7000/MacMini-Data/Projects/Project/General/ai-api-proxy',
  },
  pocketbase: {
    label:      'PocketBase',
    healthUrl:  'http://localhost:8090/api/health',
    composeDir: '/Volumes/SSD Acer M7000/MacMini-Data/Projects/Project/General/pocketbase',
  },
};

// ─── Global config ─────────────────────────────────────────────────────────
const CHECK_MS       = 2000;
const DOCKER_WAIT    = 150_000;     // 2.5 min for Docker Desktop to start
const EMAIL_COOLDOWN = 5 * 60_000; // 5 min between emails per service
const ACTION_PORT    = 19472;
const KILL_FLAG      = '/tmp/lg-watchdog-kill';
const PID_FILE       = '/tmp/lg-watchdog.pid';
const PLIST_DST      = '/Library/LaunchDaemons/com.lumigate.watchdog.plist';
const LOG_DIR        = SERVICES.lumigate.composeDir;
const RESEND_KEY     = 're_AezKqjRa_7fu5kdoaWEvJ3hgb3oweJXGq';
const FROM_EMAIL     = 'support@autorums.com';
const TO_EMAIL       = 'richard.hx.wang@gmail.com';
const NODE_BIN       = process.execPath;

// ─── Install mode ──────────────────────────────────────────────────────────
// --install        LaunchDaemon only
// --full-install   lg symlink + LaunchDaemon  (recommended one-liner)
const installMode = process.argv[2];
if (installMode === '--install' || installMode === '--full-install') {
  if (process.getuid() !== 0) {
    console.error('Error: requires sudo');
    process.exit(1);
  }

  if (installMode === '--full-install') {
    const cliSrc = path.join(__dirname, 'cli.sh');
    const cliDst = '/usr/local/bin/lg';
    try {
      fs.mkdirSync('/usr/local/bin', { recursive: true });
      try { fs.unlinkSync(cliDst); } catch {}
      fs.symlinkSync(cliSrc, cliDst);
      fs.chmodSync(cliSrc, 0o755);
      console.log(`lg installed → ${cliDst}`);
    } catch (e) {
      console.error(`Warning: could not install lg: ${e.message}`);
    }
  }

  const scriptPath = path.resolve(__filename);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.lumigate.watchdog</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${scriptPath}</string>
  </array>

  <key>KeepAlive</key>
  <true/>

  <key>RunAtLoad</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>5</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/watchdog-launchd.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/watchdog-launchd.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${process.env.HOME || '/var/root'}</string>
  </dict>
</dict>
</plist>`;

  fs.writeFileSync(PLIST_DST, plist);
  console.log(`Plist written → ${PLIST_DST}`);
  try { execSync(`launchctl unload "${PLIST_DST}" 2>/dev/null`); } catch {}
  execSync(`launchctl load "${PLIST_DST}"`);
  console.log('LaunchDaemon loaded — watchdog active (LumiGate + PocketBase).');
  console.log('Stop with: sudo lg kill');
  process.exit(0);
}

// ─── Runtime setup ─────────────────────────────────────────────────────────
fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit',    () => { try { fs.unlinkSync(PID_FILE); } catch {} });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));

// ─── Per-service state ─────────────────────────────────────────────────────
const svcState = {};
for (const key of Object.keys(SERVICES)) {
  svcState[key] = { prevUp: true, lastHealAt: 0, healing: false };
}
let currentToken = null;

// ─── Logging ───────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Shanghai', hour12: false });
  process.stdout.write(`[${ts}] ${msg}\n`);
}

// ─── Action HTTP server ─────────────────────────────────────────────────────
const actionServer = http.createServer((req, res) => {
  const u     = new URL(req.url, `http://localhost:${ACTION_PORT}`);
  const token = u.searchParams.get('token');

  const page = (title, body, bg = '#007aff') => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;
background:#f5f5f7}.card{background:#fff;border-radius:16px;padding:40px 48px;
max-width:480px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.1)}
h2{margin:0 0 12px;color:#1d1d1f}p{color:#666;line-height:1.6}
code{background:#f0f0f0;padding:2px 8px;border-radius:4px;font-size:.9em}</style>
</head><body><div class="card">${body}</div></body></html>`);
  };

  if (u.pathname === '/cancel' && token && token === currentToken) {
    page('自愈已停止', `<h2>🛑 自愈已停止</h2>
      <p>Watchdog 進程已退出。</p>
      <p>重新啟用：<br><code>sudo launchctl load ${PLIST_DST}</code></p>`, '#ff3b30');
    setTimeout(() => { log('User clicked Stop — exiting'); process.exit(0); }, 800);

  } else if (u.pathname === '/confirm' && token && token === currentToken) {
    page('繼續監控', `<h2>✅ 收到確認</h2>
      <p>LumiGate + PocketBase 繼續監控中。</p>
      <p>停止指令：<code>sudo lg kill</code></p>`);

  } else {
    res.writeHead(404); res.end('Not found');
  }
});
actionServer.listen(ACTION_PORT, '127.0.0.1', () => {
  log(`Action server → localhost:${ACTION_PORT}`);
});

// ─── Email ─────────────────────────────────────────────────────────────────
function sendEmail(subject, html) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ from: FROM_EMAIL, to: [TO_EMAIL], subject, html });
    const req  = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: {
        'Authorization':  `Bearer ${RESEND_KEY}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (r) => {
      r.resume();
      log(r.statusCode < 300 ? 'Email sent OK' : `Email HTTP ${r.statusCode}`);
      resolve();
    });
    req.on('error', (e) => { log(`Email error: ${e.message}`); resolve(); });
    req.write(body); req.end();
  });
}

function buildEmail(incidents) {
  // incidents: [{ service, event, details, healResult }]
  const token      = crypto.randomBytes(20).toString('hex');
  currentToken     = token;
  const ts         = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Shanghai', hour12: false });
  const cancelUrl  = `http://localhost:${ACTION_PORT}/cancel?token=${token}`;
  const confirmUrl = `http://localhost:${ACTION_PORT}/confirm?token=${token}`;

  const cards = incidents.map(({ service, event, details, healResult }) => {
    const ok = healResult.startsWith('✅');
    return `
  <div style="margin-bottom:16px">
    <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:10px;
      padding:12px 16px;margin-bottom:8px">
      <div style="font-weight:600;color:#856404">${service} — ${event}</div>
      <div style="color:#533f03;font-size:13px;margin-top:4px">${details}</div>
    </div>
    <div style="background:${ok ? '#d4edda' : '#f8d7da'};
      border:1px solid ${ok ? '#28a745' : '#dc3545'};border-radius:10px;
      padding:12px 16px">
      <div style="font-weight:600;color:#155724;margin-bottom:4px">自愈結果</div>
      <div style="color:#155724;font-size:13px;white-space:pre-wrap">${healResult}</div>
    </div>
  </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:20px;background:#f5f5f7;
  font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif">
<div style="max-width:580px;margin:0 auto;background:#fff;border-radius:16px;
  padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.08)">

  <h2 style="margin:0 0 4px;color:#1d1d1f;font-size:20px">⚠️ 服務崩潰警告</h2>
  <p style="margin:0 0 20px;color:#86868b;font-size:13px">${ts}</p>

  ${cards}

  <div style="text-align:center;margin:24px 0">
    <a href="${confirmUrl}" style="display:inline-block;background:#007aff;color:#fff;
      text-decoration:none;padding:12px 28px;border-radius:10px;margin:0 6px 8px;
      font-weight:600;font-size:15px">✅ 已了解，繼續監控</a>
    <a href="${cancelUrl}" style="display:inline-block;background:#ff3b30;color:#fff;
      text-decoration:none;padding:12px 28px;border-radius:10px;margin:0 6px 8px;
      font-weight:600;font-size:15px">🛑 停止自愈</a>
  </div>

  <hr style="border:none;border-top:1px solid #e5e5e5;margin:0 0 16px">
  <p style="color:#86868b;font-size:12px;margin:0;line-height:1.8">
    終端停止：<code style="background:#f5f5f5;padding:1px 6px;border-radius:4px">sudo lg kill</code><br>
    重新啟用：<code style="background:#f5f5f5;padding:1px 6px;border-radius:4px">sudo launchctl load ${PLIST_DST}</code>
  </p>
</div></body></html>`;

  return { token, html };
}

// ─── Health checks ─────────────────────────────────────────────────────────
function isDockerUp() {
  try { execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 4000 }); return true; }
  catch { return false; }
}

function checkHttp(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ─── Docker Desktop recovery ───────────────────────────────────────────────
async function bringUpDocker() {
  log('Docker is down — opening Docker Desktop...');
  try { execFileSync('open', ['-a', 'Docker'], { stdio: 'pipe' }); }
  catch (e) { log(`open -a Docker failed: ${e.message}`); return false; }

  const deadline = Date.now() + DOCKER_WAIT;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (isDockerUp()) { log('Docker Desktop is up'); return true; }
    log(`Waiting for Docker... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
  }
  log('Docker Desktop did not come up in time');
  return false;
}

// ─── Compose start ─────────────────────────────────────────────────────────
function startCompose(svcKey) {
  const { label, composeDir } = SERVICES[svcKey];
  log(`Starting ${label} via docker compose...`);
  try {
    const out = execSync(
      `cd "${composeDir}" && docker compose up -d --build 2>&1`,
      { stdio: 'pipe', timeout: 300_000, encoding: 'utf8' }
    );
    return out.slice(-600).trim();
  } catch (e) {
    return `Error: ${e.message.slice(0, 400)}`;
  }
}

// ─── Per-service heal ──────────────────────────────────────────────────────
async function healService(svcKey, event, details, dockerWasDown = false) {
  const st = svcState[svcKey];
  if (st.healing) return null;
  st.healing = true;

  let healResult = '';
  try {
    if (dockerWasDown) {
      // Docker was just brought back up — give it a moment before compose
      await sleep(3000);
    }
    const out = startCompose(svcKey);
    healResult = `✅ docker compose up -d --build 完成\n${out}`;

    await sleep(10_000);
    const up = await checkHttp(SERVICES[svcKey].healthUrl);
    healResult += up ? '\n✅ /health 確認正常' : '\n⚠️ /health 仍無回應（可能仍在啟動中）';
  } catch (e) {
    healResult = `❌ 自愈出錯：${e.message}`;
  } finally {
    st.healing = false;
  }

  return { service: SERVICES[svcKey].label, event, details, healResult };
}

// ─── Docker crash: heal all services ──────────────────────────────────────
async function healAll(dockerEvent) {
  // Mark all services as healing to prevent duplicate triggers
  for (const st of Object.values(svcState)) st.healing = true;

  let healResult = '';
  const ok = await bringUpDocker();
  if (!ok) {
    healResult = '❌ Docker Desktop 無法在 2.5 分鐘內啟動';
    for (const st of Object.values(svcState)) { st.healing = false; st.lastHealAt = Date.now(); }
    const { html } = buildEmail([{
      service: 'Docker', event: dockerEvent,
      details: 'docker info 無回應', healResult,
    }]);
    await sendEmail(`⚠️ Docker 崩潰 — 自愈失敗`, html);
    return;
  }

  await sleep(5000);  // let daemon fully stabilize

  // Bring up all services in parallel
  const results = await Promise.all(
    Object.keys(SERVICES).map(key => healService(key,
      `${SERVICES[key].label} 隨 Docker 崩潰`, 'Docker daemon 重啟後恢復', true))
  );

  for (const st of Object.values(svcState)) { st.lastHealAt = Date.now(); st.healing = false; }

  const { html } = buildEmail(results.filter(Boolean));
  const names    = results.filter(Boolean).map(r => r.service).join(' + ');
  await sendEmail(`⚠️ Docker 崩潰已自愈 — ${names}`, html);
  log('Docker crash heal complete');
}

// ─── Utilities ─────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main loop ─────────────────────────────────────────────────────────────
async function monitor() {
  log(`AutoRums Watchdog started  PID=${process.pid}  services: ${Object.keys(SERVICES).join(', ')}`);

  let prevDockerUp = true;
  let dockerHealing = false;

  while (true) {
    if (fs.existsSync(KILL_FLAG)) {
      log('Kill flag — exiting');
      try { fs.unlinkSync(KILL_FLAG); } catch {}
      process.exit(0);
    }

    const now      = Date.now();
    const dockerUp = isDockerUp();

    if (!dockerUp && prevDockerUp) {
      log('🔴 Docker daemon is down!');
      if (!dockerHealing) {
        dockerHealing = true;
        healAll('Docker 崩潰').catch(e => log(`healAll error: ${e.message}`))
          .finally(() => { dockerHealing = false; });
      }

    } else if (dockerUp) {
      if (!prevDockerUp) log('🟢 Docker daemon up');

      if (!dockerHealing) {
        // Check each service independently
        for (const [key, svc] of Object.entries(SERVICES)) {
          const st = svcState[key];
          if (st.healing) continue;

          const up = await checkHttp(svc.healthUrl);

          if (!up && st.prevUp) {
            log(`🔴 ${svc.label} health check failed`);
            if (now - st.lastHealAt > EMAIL_COOLDOWN) {
              st.lastHealAt = now;
              healService(key, `${svc.label} 容器崩潰`, 'Docker 正常但 /health 無回應')
                .then(async (result) => {
                  if (!result) return;
                  const { html } = buildEmail([result]);
                  await sendEmail(`⚠️ ${svc.label} 崩潰已自愈`, html);
                })
                .catch(e => log(`healService(${key}) error: ${e.message}`));
            }
          } else if (up && !st.prevUp) {
            log(`🟢 ${svc.label} recovered`);
          }

          st.prevUp = up;
        }
      }
    }

    prevDockerUp = dockerUp;
    await sleep(CHECK_MS);
  }
}

monitor().catch((e) => { log(`Fatal: ${e.message}`); process.exit(1); });
