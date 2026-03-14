#!/usr/bin/env bash
# LumiGate Watchdog — lightweight 5s polling, <10s recovery, RPO=0
# CPU: ~0.1% idle (docker inspect is local socket, no HTTP)
# Memory: ~2MB (bash + sleep)
# Usage: ./watchdog.sh          (foreground)
#        ./watchdog.sh daemon    (background, writes to watchdog.log)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

POLL=5                    # seconds between checks
MAX_FAILS=2               # consecutive failures before action (= 10s)
HEALTH_URL="http://127.0.0.1:${GATEWAY_PORT:-9471}/health"
LOG="$SCRIPT_DIR/watchdog.log"
LOG_MAX=2097152           # 2MB max log
DOCKER_COOLDOWN=120       # min seconds between Docker resets
LOOP=0                    # loop counter
FAIL=0
last_reset=0

log() { local m="[$(date '+%m-%d %H:%M:%S')] $1"; echo "$m"; echo "$m" >> "$LOG"; }

# Lightweight Docker check — just ping the socket
docker_ok() { docker ps -q --filter name=lumigate >/dev/null 2>&1; }

# Container state via inspect (no HTTP, no curl, local unix socket only)
container_state() {
  docker inspect --format='{{.State.Status}}:{{.State.Health.Status}}' lumigate 2>/dev/null || echo "missing:none"
}

# HTTP health (only called to confirm after container looks OK but state unclear)
http_ok() { curl -sf --connect-timeout 2 --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; }

# Fast restart: just start existing container, no rebuild
restart() {
  log "ACTION: Restarting lumigate..."
  docker start lumigate 2>/dev/null || docker compose up -d lumigate 2>&1 | tail -1
  local w=0
  while (( w < 10 )); do
    sleep 1; w=$((w+1))
    local s; s=$(container_state)
    [[ "$s" == *"healthy"* ]] && { log "RECOVERED in ${w}s"; return; }
  done
  log "WARNING: not healthy after ${w}s restart"
}

# Docker daemon recovery (macOS / Linux)
reset_docker() {
  local now; now=$(date +%s)
  (( now - last_reset < DOCKER_COOLDOWN )) && { log "SKIP: Docker reset cooldown"; return; }
  last_reset=$now
  log "CRITICAL: Docker daemon down"

  if [[ "$(uname)" == "Darwin" ]]; then
    killall Docker 2>/dev/null || true
    sleep 2
    # Docker.raw sanity check
    local raw="$HOME/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw"
    if [[ -f "$raw" ]]; then
      local sz; sz=$(stat -f%z "$raw" 2>/dev/null || echo 0)
      (( sz < 1048576 )) && { log "Docker.raw corrupt (${sz}B), removing"; rm -f "$raw"; }
    fi
    open -a Docker
    local w=0; while ! docker_ok && (( w < 60 )); do sleep 2; w=$((w+2)); done
    docker_ok && { log "Docker back (${w}s)"; restart; } || log "FATAL: Docker won't start"
  elif command -v synoservice &>/dev/null; then
    # Synology DSM (older: synoservice, newer DSM 7: synoservicectl)
    log "Synology DSM: restarting Container Manager..."
    sudo synoservice --restart pkgctl-ContainerManager 2>/dev/null \
      || sudo synoservicectl --restart pkgctl-ContainerManager 2>/dev/null \
      || true
    local w=0; while ! docker_ok && (( w < 60 )); do sleep 2; w=$((w+2)); done
    docker_ok && { log "Docker back (${w}s)"; restart; } || log "FATAL: Synology Docker won't start"
  else
    # Generic Linux (server with systemd or SysV init)
    sudo systemctl restart docker 2>/dev/null || sudo service docker restart 2>/dev/null || true
    sleep 3
    docker_ok && { log "Docker back"; restart; } || log "FATAL: Docker restart failed"
  fi
}

# Daemon mode
if [[ "${1:-}" == "daemon" ]]; then
  log "Watchdog daemon PID $$"
  exec >> "$LOG" 2>&1
fi

# Install mode
if [[ "${1:-}" == "install" ]]; then
  if [[ "$(uname)" == "Darwin" ]]; then
    plist="$HOME/Library/LaunchAgents/com.lumigate.watchdog.plist"
    cat > "$plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.lumigate.watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>$SCRIPT_DIR/watchdog.sh</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$SCRIPT_DIR/watchdog.log</string>
  <key>StandardErrorPath</key><string>$SCRIPT_DIR/watchdog.log</string>
</dict>
</plist>
PLIST
    launchctl load "$plist" && log "LaunchAgent installed: $plist" || log "WARN: launchctl load failed"
  else
    cat > /tmp/lumigate-watchdog.service << UNIT
[Unit]
Description=LumiGate Watchdog
After=network.target docker.service
[Service]
Type=simple
ExecStart=$SCRIPT_DIR/watchdog.sh daemon
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
    sudo mv /tmp/lumigate-watchdog.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now lumigate-watchdog
    log "systemd service installed"
  fi
  exit 0
fi

log "Watchdog started (poll=${POLL}s, threshold=${MAX_FAILS})"

while true; do
  LOOP=$((LOOP + 1))

  # Log rotation — check every 200 loops (~16min)
  if (( LOOP % 200 == 0 )) && [[ -f "$LOG" ]]; then
    local sz; sz=$(stat -f%z "$LOG" 2>/dev/null || stat -c%s "$LOG" 2>/dev/null || echo 0)
    (( sz > LOG_MAX )) && { mv "$LOG" "$LOG.1"; log "Log rotated"; }
  fi

  # Step 1: Is Docker alive?
  if ! docker_ok; then
    reset_docker
    FAIL=0; sleep "$POLL"; continue
  fi

  # Step 2: Container state (no network, just docker socket)
  local state; state=$(container_state)
  case "$state" in
    running:healthy|running:starting)
      (( FAIL > 0 )) && log "OK: restored after ${FAIL} failure(s)"
      FAIL=0
      ;;
    running:unhealthy)
      FAIL=$((FAIL + 1))
      log "UNHEALTHY (${FAIL}/${MAX_FAILS})"
      (( FAIL >= MAX_FAILS )) && { restart; FAIL=0; }
      ;;
    exited:*|dead:*|missing:*)
      log "ALERT: container $state"
      restart; FAIL=0
      ;;
    *)
      # Unknown state — confirm with HTTP
      if http_ok; then
        FAIL=0
      else
        FAIL=$((FAIL + 1))
        log "UNKNOWN state=$state, HTTP fail (${FAIL}/${MAX_FAILS})"
        (( FAIL >= MAX_FAILS )) && { restart; FAIL=0; }
      fi
      ;;
  esac

  sleep "$POLL"
done
