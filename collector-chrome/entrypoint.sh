#!/bin/bash

DISPLAY_NUM=99
export DISPLAY=:${DISPLAY_NUM}
RESOLUTION=${RESOLUTION:-1280x800x24}

# Fix permissions (runs as root)
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
rm -f /tmp/.X${DISPLAY_NUM}-lock 2>/dev/null
chown -R chrome:chrome /home/chrome/.chrome-profile 2>/dev/null
rm -f /home/chrome/.chrome-profile/SingletonLock 2>/dev/null

# Start Xvfb
Xvfb :${DISPLAY_NUM} -screen 0 ${RESOLUTION} -ac &
sleep 1

# Window manager
su chrome -c "fluxbox &>/dev/null &"
sleep 1

# VNC
if [ -n "$VNC_PASSWORD" ]; then
    su chrome -c "x11vnc -display :${DISPLAY_NUM} -rfbport 5900 -passwd '$VNC_PASSWORD' -shared -forever -noxdamage &>/dev/null &"
else
    su chrome -c "x11vnc -display :${DISPLAY_NUM} -rfbport 5900 -nopw -shared -forever -noxdamage &>/dev/null &"
fi

# noVNC
websockify --web /usr/share/novnc 7900 localhost:5900 &>/dev/null &

# Start Chromium on port 9223 (127.0.0.1 only)
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
    about:blank" &
CHROME_PID=$!

# Wait for Chrome to be ready
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:9223/json/version >/dev/null 2>&1; then
    echo "Chrome ready on 127.0.0.1:9223"
    break
  fi
  sleep 0.5
done

# Reverse proxy on 0.0.0.0:9222 → 127.0.0.1:9223
# Using socat with a workaround: Chrome checks Host header,
# but socat doesn't change it. We use iptables REDIRECT instead.
# Simpler: just use socat and accept that /json/* won't work,
# but WebSocket upgrade (used by Playwright) DOES work through socat.
socat TCP-LISTEN:9222,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9223 &
echo "CDP proxy: 0.0.0.0:9222 -> 127.0.0.1:9223"

# Wait for Chrome
wait $CHROME_PID
