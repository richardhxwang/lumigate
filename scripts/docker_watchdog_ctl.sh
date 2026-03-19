#!/usr/bin/env bash
set -euo pipefail

# Hard control for Docker Desktop auto-restart/watchdog services on macOS.
# Usage:
#   ./scripts/docker_watchdog_ctl.sh status
#   ./scripts/docker_watchdog_ctl.sh hard-stop
#   ./scripts/docker_watchdog_ctl.sh start

ACTION="${1:-status}"
UID_NUM="$(id -u)"
GUI_DOMAIN="gui/${UID_NUM}"

SYS_LABELS=(
  "com.docker.socket"
  "com.docker.vmnetd"
)
GUI_LABELS=(
  "com.docker.helper"
)

APP_BIN_MATCHES=(
  "/Applications/Docker.app/Contents/MacOS/com.docker"
  "/Applications/Docker.app/Contents/MacOS/Docker Desktop.app/Contents"
)

disable_label() {
  local domain="$1" label="$2"
  launchctl disable "${domain}/${label}" >/dev/null 2>&1 || true
}

enable_label() {
  local domain="$1" label="$2"
  launchctl enable "${domain}/${label}" >/dev/null 2>&1 || true
}

bootout_label() {
  local domain="$1" label="$2"
  launchctl bootout "${domain}/${label}" >/dev/null 2>&1 || true
}

bootstrap_label() {
  local domain="$1" plist="$2"
  launchctl bootstrap "${domain}" "${plist}" >/dev/null 2>&1 || true
}

print_status() {
  echo "== Docker launchd status =="
  echo "-- user (${GUI_DOMAIN}) --"
  launchctl print-disabled "${GUI_DOMAIN}" 2>/dev/null | grep -E "com\\.docker|docker" || true
  echo "-- system --"
  sudo launchctl print-disabled system 2>/dev/null | grep -E "com\\.docker|docker" || true
  echo "-- running processes --"
  ps aux | grep -E "com\\.docker|Docker Desktop|vpnkit|containerd" | grep -v grep || true
}

hard_stop() {
  echo "[1/4] quit Docker app"
  osascript -e 'quit app "Docker"' >/dev/null 2>&1 || true
  sleep 1

  echo "[2/4] disable + bootout user watchdog labels"
  for label in "${GUI_LABELS[@]}"; do
    disable_label "${GUI_DOMAIN}" "${label}"
    bootout_label "${GUI_DOMAIN}" "${label}"
  done

  echo "[3/4] disable + bootout system Docker helper labels (sudo)"
  for label in "${SYS_LABELS[@]}"; do
    sudo launchctl disable "system/${label}" >/dev/null 2>&1 || true
    sudo launchctl bootout "system/${label}" >/dev/null 2>&1 || true
  done

  echo "[4/4] kill remaining Docker processes"
  for pat in "${APP_BIN_MATCHES[@]}"; do
    pkill -9 -f "${pat}" >/dev/null 2>&1 || true
  done
  sleep 1
  print_status
}

start_again() {
  echo "[1/3] re-enable system labels (sudo)"
  for label in "${SYS_LABELS[@]}"; do
    sudo launchctl enable "system/${label}" >/dev/null 2>&1 || true
  done
  bootstrap_label "system" "/Library/LaunchDaemons/com.docker.socket.plist"
  bootstrap_label "system" "/Library/LaunchDaemons/com.docker.vmnetd.plist"

  echo "[2/3] re-enable user labels"
  for label in "${GUI_LABELS[@]}"; do
    enable_label "${GUI_DOMAIN}" "${label}"
  done

  echo "[3/3] start Docker app"
  open -a Docker
  echo "Docker Desktop start requested."
}

case "${ACTION}" in
  status) print_status ;;
  hard-stop) hard_stop ;;
  start) start_again ;;
  *)
    echo "Unknown action: ${ACTION}" >&2
    echo "Usage: $0 {status|hard-stop|start}" >&2
    exit 2
    ;;
esac

