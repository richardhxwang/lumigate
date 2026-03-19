#!/bin/bash
# Combined entrypoint: Chromium (Xvfb + VNC) + Node.js (LumiGate)
# Chrome on 127.0.0.1:9223 — Node connects via localhost, no network issues

DISPLAY_NUM=99
export DISPLAY=:${DISPLAY_NUM}
RESOLUTION=${RESOLUTION:-1280x800x24}
LOG_DIR=/app/data/logs/runtime

mkdir -p "${LOG_DIR}"
# Mirror container stdout/stderr to file for persistent troubleshooting.
exec > >(tee -a "${LOG_DIR}/lumigate-runtime.log") 2>&1

# ── Fix permissions ──
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
rm -f /tmp/.X${DISPLAY_NUM}-lock 2>/dev/null
mkdir -p /home/chrome/.cache/chromium /home/chrome/.config/chromium/Crash\ Reports
mkdir -p /home/chrome/.chrome-profile
rm -f /home/chrome/.chrome-profile/SingletonLock 2>/dev/null
chown -R chrome:chrome /home/chrome 2>/dev/null
chown -R chrome:chrome /app/data 2>/dev/null

# ── Xvfb (virtual display) ──
Xvfb :${DISPLAY_NUM} -screen 0 ${RESOLUTION} -ac &
sleep 1

# ── Window manager ──
su chrome -c "fluxbox >>/app/data/logs/runtime/fluxbox.log 2>&1 &"
sleep 1

# ── VNC (password required for security) ──
if [ -z "$VNC_PASSWORD" ]; then
    export VNC_PASSWORD="lumi$(head -c 6 /dev/urandom | base64 | tr -d '/+=')"
    # Write to file only (not stdout) for security
    echo "$VNC_PASSWORD" > /tmp/.vnc_password
    echo "VNC_PASSWORD auto-generated (see /tmp/.vnc_password inside container)"
fi
x11vnc -display :${DISPLAY_NUM} -rfbport 5900 -passwd "$VNC_PASSWORD" -shared -forever -noxdamage >>/app/data/logs/runtime/x11vnc.log 2>&1 &

# ── noVNC (web remote desktop for login) ──
websockify --web /usr/share/novnc 7900 localhost:5900 >>/app/data/logs/runtime/websockify.log 2>&1 &

# ── Chromium (127.0.0.1:9223, same container = no Host header issue) ──
su chrome -c "chromium \
    --no-sandbox \
    --disable-dev-shm-usage \
    --remote-debugging-port=9223 \
    --remote-allow-origins=* \
    --user-data-dir=/home/chrome/.chrome-profile \
    --no-first-run \
    --disable-extensions \
    --disable-blink-features=AutomationControlled \
    --window-size=1280,800 \
    --disable-gpu \
    --lang=zh-CN \
    about:blank >>/app/data/logs/runtime/chromium.log 2>&1" &
CHROME_PID=$!

# Wait for Chrome to be ready
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:9223/json/version >/dev/null 2>&1 && break
  sleep 0.5
done
echo "Chrome ready on 127.0.0.1:9223"

# ── Node.js (LumiGate server) ──
export CDP_HOST=127.0.0.1
export CDP_PORT=9223

cd /app
exec node --max-old-space-size=256 server.js >>/app/data/logs/runtime/server.log 2>&1
