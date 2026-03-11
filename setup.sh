#!/usr/bin/env bash
# LumiGate — One-line installer & onboard wizard
# Usage: curl -fsSL https://raw.githubusercontent.com/richardhxwang/lumigate/main/setup.sh | bash
set -euo pipefail

# --- Colors ---
R='\033[0;31m' G='\033[0;32m' Y='\033[0;33m' B='\033[0;34m' C='\033[0;36m' W='\033[1;37m' N='\033[0m'

banner() {
  echo ""
  echo -e "${C}╔══════════════════════════════════════════╗${N}"
  echo -e "${C}║${W}       ✦  LumiGate Setup Wizard  ✦        ${C}║${N}"
  echo -e "${C}║${N}   Enterprise AI Gateway · 24MB footprint  ${C}║${N}"
  echo -e "${C}╚══════════════════════════════════════════╝${N}"
  echo ""
}

ok()   { echo -e "  ${G}✓${N} $1"; }
warn() { echo -e "  ${Y}!${N} $1"; }
fail() { echo -e "  ${R}✗${N} $1"; }
step() { echo -e "\n${B}[$1]${N} $2"; }

# --- Dependency check & install ---
check_deps() {
  step "1/5" "Checking dependencies"
  local missing=()

  # Git
  if command -v git &>/dev/null; then
    ok "git $(git --version | awk '{print $3}')"
  else
    missing+=(git)
    fail "git not found"
  fi

  # Docker
  if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    ok "docker $(docker --version | awk '{print $3}' | tr -d ',')"
  elif command -v docker &>/dev/null; then
    warn "docker installed but not running"
    echo -e "    ${Y}→ Please start Docker Desktop and re-run this script${N}"
    exit 1
  else
    missing+=(docker)
    fail "docker not found"
  fi

  # Docker Compose
  if docker compose version &>/dev/null 2>&1; then
    ok "docker compose $(docker compose version --short 2>/dev/null)"
  else
    missing+=(docker-compose)
    fail "docker compose not found"
  fi

  # curl
  if command -v curl &>/dev/null; then
    ok "curl"
  else
    missing+=(curl)
    fail "curl not found"
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo ""
    echo -e "  ${Y}Missing: ${missing[*]}${N}"
    echo ""
    read -rp "  Install missing dependencies? [Y/n] " yn
    yn=${yn:-Y}
    if [[ "$yn" =~ ^[Yy] ]]; then
      install_deps "${missing[@]}"
    else
      fail "Cannot continue without: ${missing[*]}"
      exit 1
    fi
  fi
}

install_deps() {
  local os
  os="$(uname -s)"
  for dep in "$@"; do
    echo -e "  ${C}Installing ${dep}...${N}"
    case "$os" in
      Darwin)
        if ! command -v brew &>/dev/null; then
          echo -e "  ${Y}Homebrew required on macOS. Installing...${N}"
          /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        fi
        case "$dep" in
          git) brew install git ;;
          docker|docker-compose) brew install --cask docker && echo -e "    ${Y}→ Open Docker Desktop, then re-run this script${N}" && exit 0 ;;
          curl) brew install curl ;;
        esac
        ;;
      Linux)
        if command -v apt-get &>/dev/null; then
          sudo apt-get update -qq
          case "$dep" in
            git) sudo apt-get install -y git ;;
            docker)
              curl -fsSL https://get.docker.com | sudo sh
              sudo usermod -aG docker "$USER"
              warn "Added $USER to docker group. You may need to log out and back in."
              ;;
            docker-compose) sudo apt-get install -y docker-compose-plugin ;;
            curl) sudo apt-get install -y curl ;;
          esac
        elif command -v dnf &>/dev/null; then
          case "$dep" in
            git) sudo dnf install -y git ;;
            docker) curl -fsSL https://get.docker.com | sudo sh ;;
            curl) sudo dnf install -y curl ;;
          esac
        else
          fail "Unsupported package manager. Please install ${dep} manually."
          exit 1
        fi
        ;;
    esac
    ok "${dep} installed"
  done
}

# --- Clone repo ---
clone_repo() {
  step "2/5" "Downloading LumiGate"
  local target="${LUMIGATE_DIR:-lumigate}"

  if [[ -d "$target" ]] && [[ -f "$target/server.js" ]]; then
    ok "Directory '$target' already exists — updating"
    cd "$target"
    git pull --ff-only 2>/dev/null || warn "Could not pull updates (offline or dirty tree)"
  else
    git clone --depth 1 https://github.com/richardhxwang/lumigate.git "$target" 2>/dev/null
    ok "Cloned to ./$target"
    cd "$target"
  fi
}

# --- Deploy mode selection ---
select_mode() {
  step "3/5" "Choose deployment mode"
  echo ""
  echo -e "  ${W}[1] Lite${N}  — Personal / small team (proxy + usage + chat)"
  echo -e "      Modules: usage, chat"
  echo -e "      Best for: personal projects, hobbyists, single admin"
  echo ""
  echo -e "  ${W}[2] Enterprise${N}  — Team / production (all features)"
  echo -e "      Modules: usage, budget, multikey, users, audit, metrics, backup, smart, chat"
  echo -e "      Best for: teams, multiple projects, compliance requirements"
  echo ""
  echo -e "  ${W}[3] Custom${N}  — Pick individual modules"
  echo ""

  local choice
  read -rp "  Select mode [1/2/3]: " choice
  choice=${choice:-1}

  case "$choice" in
    1)
      DEPLOY_MODE="lite"
      MODULES=""
      ok "Lite mode selected"
      ;;
    2)
      DEPLOY_MODE="enterprise"
      MODULES=""
      ok "Enterprise mode selected"
      ;;
    3)
      DEPLOY_MODE="custom"
      select_modules
      ;;
    *)
      DEPLOY_MODE="lite"
      MODULES=""
      ok "Defaulting to Lite mode"
      ;;
  esac
}

select_modules() {
  echo ""
  echo -e "  ${W}Available modules:${N}  (core proxy is always included)"
  echo ""

  local all_mods=("usage:Usage tracking — per-project/model token counts, cost estimation"
                   "budget:Budget enforcement — per-project spending limits, auto-reset"
                   "multikey:Multi-key management — multiple API keys per provider, priority"
                   "users:User management — RBAC, multi-user accounts, role-based access"
                   "audit:Audit logging — structured event log, 17 event types, query API"
                   "metrics:SLI metrics — request/error/latency counters, /admin/metrics"
                   "backup:Backup/restore — daily auto-backup, one-click restore, 10 versions"
                   "smart:Smart routing — auto model selection by task complexity"
                   "chat:Chat interface — built-in chat UI for testing providers")

  local selected=()
  for item in "${all_mods[@]}"; do
    local mod_name="${item%%:*}"
    local mod_desc="${item#*:}"
    read -rp "  Enable ${mod_name}? (${mod_desc}) [y/N] " yn
    if [[ "$yn" =~ ^[Yy] ]]; then
      selected+=("$mod_name")
      ok "$mod_name enabled"
    fi
  done

  if [[ ${#selected[@]} -eq 0 ]]; then
    warn "No modules selected — adding 'usage' and 'chat' as minimum"
    selected=("usage" "chat")
  fi

  MODULES=$(IFS=,; echo "${selected[*]}")
  ok "Custom modules: $MODULES"
}

# --- API key configuration ---
configure_keys() {
  step "4/5" "Configure API keys & admin password"
  echo ""

  # Admin secret
  local secret
  while true; do
    read -rsp "  Admin password (min 8 chars): " secret
    echo ""
    if [[ ${#secret} -ge 8 ]]; then
      break
    fi
    fail "Password too short, try again"
  done
  ok "Admin password set"
  ADMIN_SECRET="$secret"

  echo ""
  echo -e "  ${W}API Provider Keys${N}  (press Enter to skip)"
  echo ""

  local providers=("OPENAI_API_KEY:OpenAI (sk-...)"
                    "ANTHROPIC_API_KEY:Anthropic (sk-ant-...)"
                    "GEMINI_API_KEY:Google Gemini (AIza...)"
                    "DEEPSEEK_API_KEY:DeepSeek (sk-...)"
                    "KIMI_API_KEY:Kimi/Moonshot (sk-...)"
                    "DOUBAO_API_KEY:Doubao/ByteDance"
                    "QWEN_API_KEY:Qwen/Alibaba (sk-...)"
                    "MINIMAX_API_KEY:MiniMax")

  declare -A KEYS
  local has_key=false
  for item in "${providers[@]}"; do
    local env_name="${item%%:*}"
    local label="${item#*:}"
    read -rp "  ${label}: " key_val
    if [[ -n "$key_val" ]]; then
      KEYS[$env_name]="$key_val"
      ok "$env_name configured"
      has_key=true
    fi
  done

  if [[ "$has_key" == "false" ]]; then
    warn "No API keys configured. You can add them later in the dashboard."
  fi

  # Cloudflare tunnel
  echo ""
  read -rp "  Cloudflare Tunnel token (optional, Enter to skip): " cf_token
  CF_TOKEN="${cf_token:-}"
  if [[ -n "$CF_TOKEN" ]]; then
    ok "Cloudflare Tunnel configured"
  fi

  # Port
  read -rp "  Gateway port [9471]: " port
  GATEWAY_PORT="${port:-9471}"
}

# --- Generate .env ---
generate_env() {
  local env_file=".env"
  {
    echo "# LumiGate configuration — generated by setup.sh"
    echo "PORT=9471"
    echo "GATEWAY_PORT=${GATEWAY_PORT}"
    echo "ADMIN_SECRET=${ADMIN_SECRET}"
    echo ""
    echo "# Deploy mode: lite, enterprise, or custom"
    echo "DEPLOY_MODE=${DEPLOY_MODE}"
    if [[ -n "$MODULES" ]]; then
      echo "MODULES=${MODULES}"
    fi
    echo ""
    echo "# API Provider Keys"
    for key in "${!KEYS[@]}"; do
      echo "${key}=${KEYS[$key]}"
    done
    if [[ -n "$CF_TOKEN" ]]; then
      echo ""
      echo "# Cloudflare Tunnel"
      echo "CF_TUNNEL_TOKEN_LUMIGATE=${CF_TOKEN}"
    fi
  } > "$env_file"
  ok "Generated .env"
}

# --- Launch ---
launch() {
  step "5/5" "Launching LumiGate"

  # Build and start
  if [[ -n "$CF_TOKEN" ]]; then
    docker compose up -d --build 2>&1 | tail -5
  else
    docker compose up -d --build nginx lumigate 2>&1 | tail -5
  fi

  # Wait for healthy
  echo -e "  ${C}Waiting for services...${N}"
  local waited=0
  while (( waited < 30 )); do
    if curl -s --connect-timeout 2 "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1; then
      break
    fi
    sleep 2
    waited=$((waited + 2))
  done

  if curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1; then
    local health
    health=$(curl -s "http://127.0.0.1:${GATEWAY_PORT}/health")
    echo ""
    echo -e "${G}╔══════════════════════════════════════════╗${N}"
    echo -e "${G}║          LumiGate is running! 🚀         ║${N}"
    echo -e "${G}╚══════════════════════════════════════════╝${N}"
    echo ""
    echo -e "  Dashboard:  ${W}http://localhost:${GATEWAY_PORT}${N}"
    echo -e "  Health:     ${W}http://localhost:${GATEWAY_PORT}/health${N}"
    echo -e "  Mode:       ${W}${DEPLOY_MODE}${N}"
    if [[ -n "$MODULES" ]]; then
      echo -e "  Modules:    ${W}${MODULES}${N}"
    fi
    echo ""
    echo -e "  ${C}Tip:${N} Run ${W}./watchdog.sh daemon${N} to enable auto-recovery"
    echo ""
  else
    fail "Services didn't start in time. Check: docker compose logs"
  fi
}

# --- Main ---
banner
check_deps
clone_repo
select_mode
configure_keys
generate_env
launch
