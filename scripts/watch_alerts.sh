#!/usr/bin/env bash
set -euo pipefail

ALERTMANAGER_URL="${ALERTMANAGER_URL:-http://127.0.0.1:19093}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-8}"

echo "Watching firing alerts from ${ALERTMANAGER_URL} every ${INTERVAL_SECONDS}s"
echo "Press Ctrl+C to stop."

while true; do
  now="$(date '+%Y-%m-%d %H:%M:%S')"
  payload="$(curl -sS "${ALERTMANAGER_URL}/api/v2/alerts?active=true&silenced=false&inhibited=false")"
  count="$(printf '%s' "${payload}" | jq 'length')"
  echo ""
  echo "[${now}] active alerts: ${count}"
  if [[ "${count}" != "0" ]]; then
    printf '%s' "${payload}" | jq -r '
      .[] |
      "- \(.labels.alertname) severity=\(.labels.severity // "n/a") service=\(.labels.compose_service // "n/a") status=\(.status.state // "n/a")
         summary: \(.annotations.summary // "")
         since: \(.startsAt // "")"
    '
  fi
  sleep "${INTERVAL_SECONDS}"
done
