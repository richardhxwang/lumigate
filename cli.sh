#!/usr/bin/env bash
# ============================================================
# lg — LumiGate CLI
# Install: ln -sf "$(pwd)/cli.sh" /usr/local/bin/lg
# ============================================================
set -euo pipefail

VERSION="1.0.0"

# --- Colors ---
R='\033[0;31m' G='\033[0;32m' Y='\033[0;33m' B='\033[0;34m'
C='\033[0;36m' W='\033[1m' D='\033[2m' N='\033[0m'

# --- Resolve project dir ---
# Priority: $LUMIGATE_DIR > script location > ~/.lumigate PROJECT_DIR
resolve_dir() {
  if [[ -n "${LUMIGATE_DIR:-}" ]] && [[ -f "${LUMIGATE_DIR}/server.js" ]]; then
    echo "$LUMIGATE_DIR"; return
  fi
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "${script_dir}/server.js" ]]; then
    echo "$script_dir"; return
  fi
  if [[ -f "${HOME}/.lumigate" ]]; then
    local dir
    dir=$(grep -E '^PROJECT_DIR=' "${HOME}/.lumigate" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
    if [[ -n "$dir" ]] && [[ -f "${dir}/server.js" ]]; then
      echo "$dir"; return
    fi
  fi
  echo ""
}

PROJECT_DIR="$(resolve_dir)"
CONFIG_FILE="${HOME}/.lumigate"

# --- Load config ---
GATEWAY_URL="${GATEWAY_URL:-}"
GATEWAY_SECRET="${GATEWAY_SECRET:-}"

if [[ -f "$CONFIG_FILE" ]]; then
  [[ -z "$GATEWAY_URL" ]] && GATEWAY_URL=$(grep -E '^GATEWAY_URL=' "$CONFIG_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  [[ -z "$GATEWAY_SECRET" ]] && GATEWAY_SECRET=$(grep -E '^GATEWAY_SECRET=' "$CONFIG_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
fi
if [[ -n "$PROJECT_DIR" ]] && [[ -f "${PROJECT_DIR}/.env" ]]; then
  [[ -z "$GATEWAY_URL" ]] && GATEWAY_URL=$(grep -E '^GATEWAY_URL=' "${PROJECT_DIR}/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  [[ -z "$GATEWAY_SECRET" ]] && GATEWAY_SECRET=$(grep -E '^ADMIN_SECRET=' "${PROJECT_DIR}/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
fi
GATEWAY_URL="${GATEWAY_URL:-http://localhost:9471}"
GATEWAY_URL="${GATEWAY_URL%/}"

# --- Helpers ---
ok()   { echo -e "  ${G}✓${N} $1"; }
warn() { echo -e "  ${Y}!${N} $1"; }
fail() { echo -e "  ${R}✗${N} $1"; exit 1; }
hdr()  { echo ""; echo -e "${W}${B}$1${N}"; echo -e "${D}$(printf '─%.0s' $(seq 1 "${#1}"))${N}"; }
kv()   { printf "  ${W}%-16s${N} " "$1"; echo -e "$2"; }

need_dir() {
  if [[ -z "$PROJECT_DIR" ]]; then
    echo -e "${R}Error: LumiGate project directory not found${N}"
    echo -e "${D}Run 'lg setup' first, or set LUMIGATE_DIR${N}"
    exit 1
  fi
}

need_deps() {
  local missing=()
  command -v curl >/dev/null 2>&1 || missing+=("curl")
  command -v jq >/dev/null 2>&1 || missing+=("jq")
  if [[ ${#missing[@]} -gt 0 ]]; then
    fail "Missing: ${missing[*]}. Install with: brew install ${missing[*]}"
  fi
}

fmt_uptime() {
  local sec="$1" dd hh mm
  dd=$((sec/86400)); hh=$(((sec%86400)/3600)); mm=$(((sec%3600)/60))
  if ((dd>0)); then echo "${dd}d ${hh}h ${mm}m"
  elif ((hh>0)); then echo "${hh}h ${mm}m"
  else echo "${mm}m $((sec%60))s"; fi
}

# --- HTTP helpers ---
api() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -w "\n%{http_code}" --max-time 15
    -H "X-Admin-Token: ${GATEWAY_SECRET}")
  [[ "$method" != "GET" ]] && args+=(-X "$method")
  [[ -n "$data" ]] && args+=(-H "Content-Type: application/json" -d "$data")

  local resp
  resp=$(curl "${args[@]}" "${GATEWAY_URL}${path}" 2>&1) || {
    echo -e "${R}Cannot reach ${GATEWAY_URL}${N}"; exit 1
  }
  local code body
  code=$(echo "$resp" | tail -1)
  body=$(echo "$resp" | sed '$d')

  if [[ "$code" == "401" ]]; then
    echo -e "${R}Unauthorized — run 'lg config' to set credentials${N}"; exit 1
  fi
  if [[ "$code" -ge 400 ]]; then
    local err
    err=$(echo "$body" | jq -r '.error // "Unknown error"' 2>/dev/null || echo "$body")
    echo -e "${R}Error ($code): ${err}${N}"; exit 1
  fi
  echo "$body"
}

# ============================================================
# COMMANDS
# ============================================================

# --- lg setup ---
cmd_setup() {
  echo ""
  echo -e "${C}╔══════════════════════════════════════════╗${N}"
  echo -e "${C}║${W}       ✦  LumiGate Setup Wizard  ✦        ${C}║${N}"
  echo -e "${C}║${N}   Enterprise AI Gateway · 24MB footprint  ${C}║${N}"
  echo -e "${C}╚══════════════════════════════════════════╝${N}"
  echo ""

  # 1. Dependencies
  echo -e "${B}[1/5]${N} Checking dependencies"
  local missing=()
  for cmd in git docker curl; do
    if command -v "$cmd" &>/dev/null; then
      ok "$cmd"
    else
      missing+=("$cmd"); echo -e "  ${R}✗${N} $cmd not found"
    fi
  done
  if command -v docker &>/dev/null && ! docker info &>/dev/null 2>&1; then
    echo -e "  ${Y}!${N} Docker installed but not running — start it first"; exit 1
  fi
  if docker compose version &>/dev/null 2>&1; then
    ok "docker compose"
  else
    missing+=("docker-compose")
  fi
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo -e "\n  ${Y}Missing: ${missing[*]}${N}"
    echo -e "  macOS: ${D}brew install ${missing[*]}${N}"
    echo -e "  Linux: ${D}apt install ${missing[*]}${N}"
    exit 1
  fi

  # 2. Clone
  echo -e "\n${B}[2/5]${N} Downloading LumiGate"
  local target="${LUMIGATE_DIR:-lumigate}"
  if [[ -d "$target" ]] && [[ -f "$target/server.js" ]]; then
    ok "Directory '$target' exists — updating"
    cd "$target"
    git pull --ff-only 2>/dev/null || warn "Could not pull (offline or dirty)"
  else
    git clone --depth 1 https://github.com/richardhxwang/lumigate.git "$target" 2>/dev/null
    ok "Cloned to ./$target"
    cd "$target"
  fi
  PROJECT_DIR="$(pwd)"

  # 3. Mode
  echo -e "\n${B}[3/5]${N} Choose deployment mode"
  echo ""
  echo -e "  ${W}[1] Lite${N}     — proxy + usage + chat"
  echo -e "  ${W}[2] Enterprise${N} — all 9 modules"
  echo -e "  ${W}[3] Custom${N}   — pick modules"
  echo ""
  read -rp "  Select [1/2/3]: " mode_choice
  local deploy_mode="lite" modules=""
  case "${mode_choice:-1}" in
    2) deploy_mode="enterprise"; ok "Enterprise" ;;
    3) deploy_mode="custom"
       echo ""
       local all_mods=(usage budget multikey users audit metrics backup smart chat)
       local sel=()
       for m in "${all_mods[@]}"; do
         read -rp "  Enable ${m}? [y/N] " yn
         [[ "$yn" =~ ^[Yy] ]] && sel+=("$m")
       done
       [[ ${#sel[@]} -eq 0 ]] && sel=("usage" "chat")
       modules=$(IFS=,; echo "${sel[*]}")
       ok "Custom: $modules"
       ;;
    *) ok "Lite" ;;
  esac

  # 4. Credentials
  echo -e "\n${B}[4/5]${N} Configure"
  local secret
  while true; do
    read -rsp "  Admin password (min 8 chars): " secret; echo ""
    [[ ${#secret} -ge 8 ]] && break
    echo -e "  ${R}Too short${N}"
  done
  ok "Password set"

  echo -e "\n  ${W}API Keys${N} (Enter to skip)"
  local providers=(OPENAI ANTHROPIC GEMINI DEEPSEEK KIMI DOUBAO QWEN MINIMAX)
  declare -A keys
  for p in "${providers[@]}"; do
    read -rp "  ${p}: " k
    [[ -n "$k" ]] && keys[${p}_API_KEY]="$k"
  done

  echo ""
  read -rp "  Cloudflare Tunnel token (optional): " cf_token
  read -rp "  Port [9471]: " port

  # Generate .env
  {
    echo "# Generated by lg setup"
    echo "PORT=9471"
    echo "GATEWAY_PORT=${port:-9471}"
    echo "ADMIN_SECRET=${secret}"
    echo "DEPLOY_MODE=${deploy_mode}"
    [[ -n "$modules" ]] && echo "MODULES=${modules}"
    echo ""
    for key in "${!keys[@]}"; do echo "${key}=${keys[$key]}"; done
    [[ -n "${cf_token:-}" ]] && echo -e "\nCF_TUNNEL_TOKEN_LUMIGATE=${cf_token}"
  } > .env
  ok "Generated .env"

  # Save config
  {
    echo "PROJECT_DIR=${PROJECT_DIR}"
    echo "GATEWAY_URL=http://localhost:${port:-9471}"
    echo "GATEWAY_SECRET=${secret}"
  } > "$CONFIG_FILE"
  ok "Saved ~/.lumigate"

  # 5. Launch
  echo -e "\n${B}[5/5]${N} Launching"
  if [[ -n "${cf_token:-}" ]]; then
    docker compose up -d --build 2>&1 | tail -3
  else
    docker compose up -d --build nginx lumigate 2>&1 | tail -3
  fi

  local gp="${port:-9471}" w=0
  while (( w < 30 )); do
    curl -sf --connect-timeout 2 "http://127.0.0.1:${gp}/health" >/dev/null 2>&1 && break
    sleep 2; w=$((w+2))
  done

  if curl -sf "http://127.0.0.1:${gp}/health" >/dev/null 2>&1; then
    echo ""
    echo -e "${G}╔══════════════════════════════════════════╗${N}"
    echo -e "${G}║          LumiGate is running!            ║${N}"
    echo -e "${G}╚══════════════════════════════════════════╝${N}"
    echo ""
    echo -e "  Dashboard:  ${W}http://localhost:${gp}${N}"
    echo -e "  CLI:        ${W}lg status${N}"
    echo -e "  Symlink:    ${W}sudo ln -sf ${PROJECT_DIR}/cli.sh /usr/local/bin/lg${N}"
    echo ""
  else
    echo -e "  ${R}Didn't start in time. Check: docker compose logs${N}"
  fi
}

# --- lg config ---
cmd_config() {
  local action="${1:-show}"
  case "$action" in
    show)
      hdr "Config"
      kv "Config file:" "$CONFIG_FILE"
      kv "Project dir:" "${PROJECT_DIR:-${D}(not set)${N}}"
      kv "Gateway URL:" "$GATEWAY_URL"
      kv "Secret:" "${GATEWAY_SECRET:+${D}***${#GATEWAY_SECRET} chars***${N}}"
      if [[ -n "$PROJECT_DIR" ]] && [[ -f "${PROJECT_DIR}/.env" ]]; then
        echo ""
        echo -e "  ${W}.env:${N}"
        grep -E '^(DEPLOY_MODE|MODULES|GATEWAY_PORT)=' "${PROJECT_DIR}/.env" 2>/dev/null | while read -r line; do
          echo -e "    ${D}${line}${N}"
        done
      fi
      echo ""
      ;;
    set)
      local key="${2:-}" val="${3:-}"
      if [[ -z "$key" || -z "$val" ]]; then
        echo -e "${R}Usage: lg config set <key> <value>${N}"
        echo -e "${D}Keys: GATEWAY_URL, GATEWAY_SECRET, PROJECT_DIR${N}"
        echo -e "${D}      DEPLOY_MODE, MODULES (writes to .env)${N}"
        exit 1
      fi
      # Require admin secret for sensitive config changes
      case "$key" in
        GATEWAY_URL|GATEWAY_SECRET|PROJECT_DIR) ;; # local config, no auth needed
        *)
          if [[ -z "$GATEWAY_SECRET" ]]; then
            echo -n -e "  ${Y}Admin secret required: ${N}"
            read -rs _secret; echo ""
          else
            _secret="$GATEWAY_SECRET"
          fi
          # Try 1: Verify against running gateway (online mode)
          _verified=false
          if [[ -n "$GATEWAY_URL" ]]; then
            _code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 \
              -X POST "${GATEWAY_URL}/admin/login" \
              -H "Content-Type: application/json" \
              -d "{\"secret\":\"${_secret}\"}" 2>/dev/null)
            if [[ "$_code" == "200" ]]; then
              _verified=true
              ok "Authenticated (online)"
            elif [[ "$_code" == "000" ]]; then
              # Gateway unreachable — fallback to local .env
              warn "Gateway unreachable, verifying against local .env"
            else
              fail "Admin secret incorrect"
              exit 1
            fi
          fi
          # Try 2: Fallback to local .env comparison (offline / SSH)
          if [[ "$_verified" != "true" ]]; then
            local _env_secret=""
            if [[ -n "$PROJECT_DIR" ]] && [[ -f "${PROJECT_DIR}/.env" ]]; then
              _env_secret=$(grep -E '^ADMIN_SECRET=' "${PROJECT_DIR}/.env" 2>/dev/null | head -1 | cut -d= -f2-)
            fi
            if [[ -z "$_env_secret" ]]; then
              fail "Cannot verify: gateway offline and no ADMIN_SECRET in .env"
              exit 1
            fi
            if [[ "$_secret" == "$_env_secret" ]]; then
              ok "Authenticated (offline)"
            else
              fail "Admin secret incorrect"
              exit 1
            fi
          fi
          ;;
      esac
      case "$key" in
        GATEWAY_URL|GATEWAY_SECRET|PROJECT_DIR)
          # Update ~/.lumigate
          if [[ -f "$CONFIG_FILE" ]] && grep -qE "^${key}=" "$CONFIG_FILE" 2>/dev/null; then
            sed -i'' -e "s|^${key}=.*|${key}=${val}|" "$CONFIG_FILE"
          else
            echo "${key}=${val}" >> "$CONFIG_FILE"
          fi
          ok "${key} updated in ~/.lumigate"
          ;;
        DEPLOY_MODE|MODULES|GATEWAY_PORT|PORT|\
        OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|DEEPSEEK_API_KEY|\
        KIMI_API_KEY|DOUBAO_API_KEY|QWEN_API_KEY|MINIMAX_API_KEY|\
        CF_TUNNEL_TOKEN_LUMIGATE|ADMIN_SECRET)
          need_dir
          if grep -qE "^${key}=" "${PROJECT_DIR}/.env" 2>/dev/null; then
            sed -i'' -e "s|^${key}=.*|${key}=${val}|" "${PROJECT_DIR}/.env"
          else
            echo "${key}=${val}" >> "${PROJECT_DIR}/.env"
          fi
          ok "${key} updated in .env (restart to apply: lg restart)"
          # Also sync GATEWAY_SECRET if changing ADMIN_SECRET
          if [[ "$key" == "ADMIN_SECRET" ]]; then
            GATEWAY_SECRET="$val"
            if grep -qE '^GATEWAY_SECRET=' "$CONFIG_FILE" 2>/dev/null; then
              sed -i'' -e "s|^GATEWAY_SECRET=.*|GATEWAY_SECRET=${val}|" "$CONFIG_FILE"
            else
              echo "GATEWAY_SECRET=${val}" >> "$CONFIG_FILE"
            fi
          fi
          ;;
        *)
          echo -e "${R}Unknown key: ${key}${N}"
          echo -e "${D}Allowed: GATEWAY_URL, GATEWAY_SECRET, PROJECT_DIR,${N}"
          echo -e "${D}  DEPLOY_MODE, MODULES, GATEWAY_PORT, ADMIN_SECRET,${N}"
          echo -e "${D}  OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY,${N}"
          echo -e "${D}  DEEPSEEK_API_KEY, KIMI_API_KEY, DOUBAO_API_KEY,${N}"
          echo -e "${D}  QWEN_API_KEY, MINIMAX_API_KEY, CF_TUNNEL_TOKEN_LUMIGATE${N}"
          exit 1
          ;;
      esac
      ;;
    edit)
      "${EDITOR:-vi}" "$CONFIG_FILE"
      ;;
    env)
      need_dir
      "${EDITOR:-vi}" "${PROJECT_DIR}/.env"
      ;;
    *)
      echo -e "${R}Usage: lg config [show|set <k> <v>|edit|env]${N}"
      exit 1
      ;;
  esac
}

# --- lg start/stop/restart/logs ---
cmd_start() {
  need_dir; cd "$PROJECT_DIR"
  echo -e "  Starting LumiGate..."
  docker compose up -d --build "${@:-}" 2>&1 | tail -5
  ok "Started"
}

cmd_stop() {
  need_dir; cd "$PROJECT_DIR"
  echo -e "  Stopping LumiGate..."
  docker compose stop 2>&1 | tail -5
  ok "Stopped"
}

cmd_restart() {
  need_dir; cd "$PROJECT_DIR"
  echo -e "  Restarting LumiGate..."
  docker compose up -d --build --force-recreate lumigate 2>&1 | tail -3
  sleep 3
  if curl -sf --connect-timeout 2 "${GATEWAY_URL}/health" >/dev/null 2>&1; then
    ok "Restarted — healthy"
  else
    warn "Restarted — waiting for health..."
  fi
}

cmd_down() {
  need_dir; cd "$PROJECT_DIR"
  echo -e "  Tearing down LumiGate..."
  docker compose down 2>&1 | tail -5
  ok "All containers removed"
}

cmd_logs() {
  need_dir; cd "$PROJECT_DIR"
  local service="${1:-lumigate}"
  local lines="${2:-50}"
  docker compose logs --tail "$lines" -f "$service"
}

cmd_ps() {
  need_dir; cd "$PROJECT_DIR"
  docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
}

# --- lg watchdog ---
cmd_watchdog() {
  need_dir
  local action="${1:-status}"
  local wd="${PROJECT_DIR}/watchdog.sh"
  [[ ! -f "$wd" ]] && fail "watchdog.sh not found in ${PROJECT_DIR}"

  case "$action" in
    start)
      if pgrep -f "watchdog.sh" >/dev/null 2>&1; then
        warn "Watchdog already running (PID $(pgrep -f 'watchdog.sh' | head -1))"
      else
        bash "$wd" daemon &
        disown
        sleep 1
        ok "Watchdog started (PID $(pgrep -f 'watchdog.sh' | head -1 || echo '?'))"
      fi
      ;;
    stop)
      if pkill -f "watchdog.sh" 2>/dev/null; then
        ok "Watchdog stopped"
      else
        warn "Watchdog not running"
      fi
      ;;
    status)
      if pgrep -f "watchdog.sh" >/dev/null 2>&1; then
        ok "Watchdog running (PID $(pgrep -f 'watchdog.sh' | head -1))"
      else
        echo -e "  ${D}Watchdog not running${N}"
      fi
      ;;
    log|logs)
      local log="${PROJECT_DIR}/watchdog.log"
      if [[ -f "$log" ]]; then
        tail -"${2:-30}" "$log"
      else
        echo -e "  ${D}No watchdog log${N}"
      fi
      ;;
    *) echo -e "${R}Usage: lg watchdog [start|stop|status|log]${N}"; exit 1 ;;
  esac
}

# --- lg status ---
cmd_status() {
  need_deps
  hdr "Gateway Status"
  local health
  health=$(api GET "/health")
  local status up mode mods provs
  status=$(echo "$health" | jq -r '.status')
  up=$(echo "$health" | jq -r '.uptime')
  mode=$(echo "$health" | jq -r '.mode')
  mods=$(echo "$health" | jq -r '.modules | join(", ")')
  provs=$(echo "$health" | jq -r '.providers | join(", ")')
  local pcount=$(echo "$health" | jq '.providers | length')

  if [[ "$status" == "ok" ]]; then
    kv "Status:" "${G}● Online${N}"
  else
    kv "Status:" "${R}● ${status}${N}"
  fi
  kv "URL:" "$GATEWAY_URL"
  kv "Uptime:" "$(fmt_uptime "$up")"
  kv "Mode:" "$mode"
  kv "Modules:" "${D}${mods}${N}"
  kv "Providers:" "${G}${pcount}${N}/8 — ${provs}"

  # Watchdog status
  if pgrep -f "watchdog.sh" >/dev/null 2>&1; then
    kv "Watchdog:" "${G}● running${N}"
  else
    kv "Watchdog:" "${D}○ stopped${N}"
  fi
  echo ""
}

# --- lg providers ---
cmd_providers() {
  need_deps
  hdr "Providers"
  local data
  data=$(api GET "/providers")
  printf "\n  ${W}%-12s %-10s %s${N}\n" "PROVIDER" "STATUS" "BASE URL"
  echo -e "  ${D}$(printf '─%.0s' $(seq 1 60))${N}"
  echo "$data" | jq -r '.[] | "\(.name) \(.available) \(.baseUrl)"' | while read -r name avail url; do
    local s
    [[ "$avail" == "true" ]] && s="${G}● online${N} " || s="${R}○ no key${N} "
    printf "  %-12s ${s}  ${D}%s${N}\n" "$name" "$url"
  done
  echo ""
}

# --- lg test ---
cmd_test() {
  need_deps
  local provider="${1:-}" model="${2:-}"
  [[ -z "$provider" ]] && { echo -e "${R}Usage: lg test <provider> [model]${N}"; exit 1; }
  local q=""; [[ -n "$model" ]] && q="?model=${model}"
  echo -e "\n  ${D}Testing ${provider}${model:+ ($model)}...${N}"
  local r
  r=$(api GET "/admin/test/${provider}${q}")
  if [[ "$(echo "$r" | jq -r '.success')" == "true" ]]; then
    echo -e "  ${G}✓ Success${N}"
    kv "Model:" "$(echo "$r" | jq -r '.model')"
    kv "Reply:" "$(echo "$r" | jq -r '.reply')"
    kv "Latency:" "$(echo "$r" | jq -r '.latency')ms"
  else
    echo -e "  ${R}✗ Failed: $(echo "$r" | jq -r '.error')${N}"
  fi
  echo ""
}

# --- lg projects ---
cmd_projects() {
  need_deps
  local action="${1:-list}"
  case "$action" in
    list|"")
      hdr "Projects"
      local data
      data=$(api GET "/admin/projects")
      local cnt=$(echo "$data" | jq 'length')
      if [[ "$cnt" -eq 0 ]]; then
        echo -e "\n  ${D}No projects. Create one: lg projects add <name>${N}\n"; return
      fi
      printf "\n  ${W}%-20s %-10s %-12s %s${N}\n" "NAME" "STATUS" "CREATED" "KEY"
      echo -e "  ${D}$(printf '─%.0s' $(seq 1 70))${N}"
      echo "$data" | jq -r '.[] | "\(.name)\t\(.enabled)\t\(.createdAt)\t\(.key)"' | while IFS=$'\t' read -r name en cr key; do
        local st; [[ "$en" == "true" ]] && st="${G}enabled${N} " || st="${R}disabled${N}"
        printf "  %-20s ${st}  %-12s ${D}%s${N}\n" "$name" "${cr:0:10}" "${key:0:16}..."
      done
      echo ""
      ;;
    add)
      local name="${2:-}"
      [[ -z "$name" ]] && { echo -e "${R}Usage: lg projects add <name>${N}"; exit 1; }
      local r
      r=$(api POST "/admin/projects" "{\"name\":\"${name}\"}")
      if [[ "$(echo "$r" | jq -r '.success')" == "true" ]]; then
        ok "Project '${name}' created"
        echo -e "  ${W}Key:${N} ${Y}$(echo "$r" | jq -r '.project.key')${N}"
      else
        echo -e "  ${R}✗ $(echo "$r" | jq -r '.error')${N}"
      fi
      echo ""
      ;;
    del|delete|rm)
      local name="${2:-}"
      [[ -z "$name" ]] && { echo -e "${R}Usage: lg projects del <name>${N}"; exit 1; }
      local r
      r=$(api DELETE "/admin/projects/${name}")
      [[ "$(echo "$r" | jq -r '.success')" == "true" ]] && ok "Deleted '${name}'" || echo -e "  ${R}✗ $(echo "$r" | jq -r '.error')${N}"
      ;;
    *) echo -e "${R}Usage: lg projects [list|add <name>|del <name>]${N}"; exit 1 ;;
  esac
}

# --- lg usage ---
cmd_usage() {
  need_deps
  local days="${1:-7}"
  hdr "Usage (${days} days)"
  local s
  s=$(api GET "/admin/usage/summary?days=${days}")
  kv "Requests:" "$(echo "$s" | jq -r '.totalRequests')"
  kv "Cost:" "${Y}\$$(echo "$s" | jq -r '.totalCost') USD${N}"

  echo -e "\n  ${W}By project:${N}"
  printf "  ${W}%-20s %10s %12s${N}\n" "PROJECT" "REQUESTS" "COST"
  echo -e "  ${D}$(printf '─%.0s' $(seq 1 44))${N}"
  echo "$s" | jq -r '.byProject | to_entries[] | "\(.key)\t\(.value.requests)\t\(.value.cost)"' 2>/dev/null | while IFS=$'\t' read -r name req cost; do
    printf "  %-20s %10s ${Y}%12s${N}\n" "$name" "$req" "\$${cost}"
  done

  echo -e "\n  ${W}By model:${N}"
  printf "  ${W}%-30s %8s %12s${N}\n" "MODEL" "CALLS" "COST"
  echo -e "  ${D}$(printf '─%.0s' $(seq 1 52))${N}"
  echo "$s" | jq -r '
    [.byProject | to_entries[] | .value.models | to_entries[] |
      { model: .key, count: .value.count, cost: .value.cost }
    ] | group_by(.model) | map({
      model: .[0].model, count: (map(.count)|add), cost: (map(.cost)|add)
    }) | sort_by(-.cost)[] | "\(.model)\t\(.count)\t\(.cost)"
  ' 2>/dev/null | while IFS=$'\t' read -r model cnt cost; do
    printf "  %-30s %8s ${Y}%12s${N}\n" "$model" "$cnt" "\$${cost}"
  done
  echo ""
}

# --- lg models ---
cmd_models() {
  need_deps
  local provider="${1:-}"
  [[ -z "$provider" ]] && { echo -e "${R}Usage: lg models <provider>${N}"; exit 1; }
  hdr "Models — ${provider}"
  local data
  data=$(api GET "/models/${provider}")
  printf "\n  ${W}%-28s %-10s %8s %8s %8s${N}\n" "MODEL" "TIER" "IN/1M" "CACHE" "OUT/1M"
  echo -e "  ${D}$(printf '─%.0s' $(seq 1 72))${N}"
  echo "$data" | jq -r '.[] | "\(.id)\t\(.tier)\t\(.price.in)\t\(.price.cacheIn)\t\(.price.out)\t\(.desc)"' | \
  while IFS=$'\t' read -r id tier pi pc po desc; do
    local tc
    case "$tier" in
      economy) tc="${G}${tier}${N}   " ;; standard) tc="${Y}${tier}${N}  " ;;
      flagship) tc="${R}${tier}${N}  " ;; *) tc="$tier" ;;
    esac
    printf "  %-28s ${tc} %7s %7s %7s\n" "$id" "\$${pi}" "\$${pc}" "\$${po}"
    echo -e "  ${D}  └ ${desc}${N}"
  done
  echo ""
}

# --- lg key ---
cmd_key() {
  need_deps
  local provider="${1:-}" key="${2:-}"
  [[ -z "$provider" || -z "$key" ]] && { echo -e "${R}Usage: lg key <provider> <api-key>${N}"; exit 1; }
  local r
  r=$(api POST "/admin/key" "{\"provider\":\"${provider}\",\"apiKey\":\"${key}\"}")
  [[ "$(echo "$r" | jq -r '.success')" == "true" ]] && ok "Key updated for '${provider}'" || echo -e "  ${R}✗ $(echo "$r" | jq -r '.error')${N}"
  echo ""
}

# --- lg mode ---
cmd_mode() {
  local new_mode="${1:-}"
  if [[ -z "$new_mode" ]]; then
    # Show current mode
    need_deps
    local h
    h=$(api GET "/health")
    local mode mods
    mode=$(echo "$h" | jq -r '.mode')
    mods=$(echo "$h" | jq -r '.modules | join(", ")')
    echo -e "\n  Mode: ${W}${mode}${N}"
    echo -e "  Modules: ${D}${mods}${N}"
    echo ""
    echo -e "  ${D}Change: lg mode lite|enterprise|custom${N}"
    echo -e "  ${D}Custom: lg config set MODULES usage,audit,chat${N}"
    echo ""
    return
  fi
  need_dir
  case "$new_mode" in
    lite|enterprise|custom)
      if grep -qE '^DEPLOY_MODE=' "${PROJECT_DIR}/.env" 2>/dev/null; then
        sed -i'' -e "s|^DEPLOY_MODE=.*|DEPLOY_MODE=${new_mode}|" "${PROJECT_DIR}/.env"
      else
        echo "DEPLOY_MODE=${new_mode}" >> "${PROJECT_DIR}/.env"
      fi
      ok "Mode → ${new_mode}"
      echo -e "  ${D}Run 'lg restart' to apply${N}"
      ;;
    *) echo -e "${R}Modes: lite, enterprise, custom${N}"; exit 1 ;;
  esac
}

# --- lg backup/restore ---
cmd_backup() {
  need_deps
  local action="${1:-create}"
  case "$action" in
    create)
      local r
      r=$(api POST "/admin/backup")
      [[ "$(echo "$r" | jq -r '.success')" == "true" ]] && ok "Backup: $(echo "$r" | jq -r '.name')" || echo -e "  ${R}✗ $(echo "$r" | jq -r '.error')${N}"
      ;;
    list)
      hdr "Backups"
      api GET "/admin/backups" | jq -r '.[] | "  \(.name)  (\(.files) files)"'
      echo ""
      ;;
    restore)
      local name="${2:-}"
      [[ -z "$name" ]] && { echo -e "${R}Usage: lg backup restore <name>${N}"; exit 1; }
      local r
      r=$(api POST "/admin/restore/${name}")
      [[ "$(echo "$r" | jq -r '.success')" == "true" ]] && ok "Restored from ${name}" || echo -e "  ${R}✗ $(echo "$r" | jq -r '.error')${N}"
      ;;
    *) echo -e "${R}Usage: lg backup [create|list|restore <name>]${N}"; exit 1 ;;
  esac
}

# --- lg update ---
cmd_update() {
  need_dir; cd "$PROJECT_DIR"
  echo -e "  Pulling latest..."
  git pull --ff-only || { warn "Pull failed"; return; }
  ok "Code updated"
  echo -e "  Rebuilding..."
  docker compose up -d --build --force-recreate lumigate 2>&1 | tail -3
  sleep 4
  if curl -sf --connect-timeout 2 "${GATEWAY_URL}/health" >/dev/null 2>&1; then
    ok "Updated and healthy"
  else
    warn "Updated but health check pending"
  fi
}

# --- lg install ---
cmd_install() {
  local target="/usr/local/bin/lg"
  local src
  if [[ -n "$PROJECT_DIR" ]]; then
    src="${PROJECT_DIR}/cli.sh"
  else
    src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cli.sh"
  fi
  if [[ -L "$target" ]] || [[ -f "$target" ]]; then
    warn "${target} already exists"
    read -rp "  Overwrite? [y/N] " yn
    [[ ! "$yn" =~ ^[Yy] ]] && exit 0
  fi
  sudo ln -sf "$src" "$target" && ok "Installed: lg → ${src}" || fail "Failed to create symlink"
}

# --- lg help ---
cmd_help() {
  echo ""
  echo -e "${W}${B}lg${N} — LumiGate CLI v${VERSION}"
  echo ""
  echo -e "${W}Lifecycle:${N}"
  printf "  ${C}%-32s${N} %s\n" "setup"                  "Interactive setup wizard"
  printf "  ${C}%-32s${N} %s\n" "start"                  "Start all containers"
  printf "  ${C}%-32s${N} %s\n" "stop"                   "Stop all containers"
  printf "  ${C}%-32s${N} %s\n" "restart"                "Rebuild & restart app"
  printf "  ${C}%-32s${N} %s\n" "down"                   "Tear down all containers"
  printf "  ${C}%-32s${N} %s\n" "update"                 "Pull latest + rebuild"
  printf "  ${C}%-32s${N} %s\n" "logs [service] [lines]" "Tail container logs"
  printf "  ${C}%-32s${N} %s\n" "ps"                     "Show container status"
  echo ""
  echo -e "${W}Config:${N}"
  printf "  ${C}%-32s${N} %s\n" "config"                 "Show current config"
  printf "  ${C}%-32s${N} %s\n" "config set <key> <val>" "Update config value"
  printf "  ${C}%-32s${N} %s\n" "config edit"            "Edit ~/.lumigate"
  printf "  ${C}%-32s${N} %s\n" "config env"             "Edit .env file"
  echo ""
  echo -e "${W}Gateway:${N}"
  printf "  ${C}%-32s${N} %s\n" "status"                 "Health, providers, uptime"
  printf "  ${C}%-32s${N} %s\n" "providers"              "List providers"
  printf "  ${C}%-32s${N} %s\n" "test <provider> [model]" "Test provider"
  printf "  ${C}%-32s${N} %s\n" "mode [lite|enterprise|custom]" "View/change deploy mode"
  printf "  ${C}%-32s${N} %s\n" "models <provider>"      "List models & pricing"
  printf "  ${C}%-32s${N} %s\n" "key <provider> <key>"   "Update API key"
  echo ""
  echo -e "${W}Projects:${N}"
  printf "  ${C}%-32s${N} %s\n" "projects"               "List projects"
  printf "  ${C}%-32s${N} %s\n" "projects add <name>"    "Create project"
  printf "  ${C}%-32s${N} %s\n" "projects del <name>"    "Delete project"
  printf "  ${C}%-32s${N} %s\n" "usage [days]"           "Usage summary"
  echo ""
  echo -e "${W}Operations:${N}"
  printf "  ${C}%-32s${N} %s\n" "backup [create|list]"   "Manage backups"
  printf "  ${C}%-32s${N} %s\n" "backup restore <name>"  "Restore from backup"
  printf "  ${C}%-32s${N} %s\n" "watchdog [start|stop|status|log]" "Auto-recovery daemon"
  printf "  ${C}%-32s${N} %s\n" "install"                "Symlink lg to /usr/local/bin"
  echo ""
}

# ============================================================
# MAIN
# ============================================================
if [[ $# -eq 0 ]]; then
  # No args — show quick overview
  echo ""
  echo -e "${W}lg${N} ${D}v${VERSION}${N} — LumiGate CLI"
  echo ""

  # Try to show live status if gateway is reachable
  if curl -sf --connect-timeout 1 "${GATEWAY_URL}/health" >/dev/null 2>&1; then
    _h=$(curl -s --connect-timeout 2 "${GATEWAY_URL}/health")
    _mode=$(echo "$_h" | jq -r '.mode' 2>/dev/null)
    _up=$(echo "$_h" | jq -r '.uptime' 2>/dev/null)
    _provs=$(echo "$_h" | jq -r '.providers | join(", ")' 2>/dev/null)
    echo -e "  ${G}●${N} Online  ${D}│${N}  ${_mode}  ${D}│${N}  $(fmt_uptime "$_up")  ${D}│${N}  ${_provs}"
  else
    echo -e "  ${R}●${N} Offline  ${D}(${GATEWAY_URL})${N}"
  fi

  echo ""
  echo -e "  ${C}lg status${N}          Health & providers"
  echo -e "  ${C}lg config${N}          View/edit config"
  echo -e "  ${C}lg start${N}           Start containers"
  echo -e "  ${C}lg restart${N}         Rebuild & restart"
  echo -e "  ${C}lg logs${N}            Tail logs"
  echo -e "  ${C}lg projects${N}        Manage projects"
  echo -e "  ${C}lg usage${N}           Cost & usage"
  echo -e "  ${C}lg help${N}            All commands"
  echo ""
  exit 0
fi

COMMAND="$1"
shift

case "$COMMAND" in
  setup)      cmd_setup ;;
  config)     cmd_config "$@" ;;
  start)      cmd_start "$@" ;;
  stop)       cmd_stop ;;
  restart)    cmd_restart ;;
  down)       cmd_down ;;
  logs)       cmd_logs "$@" ;;
  ps)         cmd_ps ;;
  update)     cmd_update ;;
  install)    cmd_install ;;
  status)     cmd_status ;;
  providers)  cmd_providers ;;
  test)       cmd_test "$@" ;;
  projects)   cmd_projects "$@" ;;
  usage)      cmd_usage "$@" ;;
  mode)       cmd_mode "$@" ;;
  models)     cmd_models "$@" ;;
  key|apikey)  cmd_key "$@" ;;
  backup)     cmd_backup "$@" ;;
  watchdog|wd) cmd_watchdog "$@" ;;
  help|--help|-h) cmd_help ;;
  -v|--version) echo "lg v${VERSION}" ;;
  *)
    echo -e "${R}Unknown: ${COMMAND}${N}"
    echo -e "Run ${C}lg help${N} for commands."
    exit 1
    ;;
esac
