#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# LumiGate Migration Helper
# Migrates services from Mac Mini to NAS (绿联 DXP4800 Plus)
# ============================================================

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; }

# ── Configuration ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults — override via environment or flags
NAS_USER="${NAS_USER:-root}"
NAS_HOST="${NAS_HOST:-192.168.1.x}"
NAS_DEPLOY_DIR="${NAS_DEPLOY_DIR:-/opt/lumigate}"
MAC_MINI_HOST="${MAC_MINI_HOST:-192.168.1.x}"

# Source directories (Mac Mini)
LUMIGATE_DATA="${PROJECT_ROOT}/data"
PB_DATA="${PB_DATA:-/opt/pocketbase/pb_data}"

usage() {
    cat <<EOF
Usage: $(basename "$0") [command] [options]

Commands:
  preflight     Check prerequisites on both machines
  copy-data     Copy LumiGate data/ to NAS
  copy-pb       Copy PocketBase pb_data/ to NAS
  copy-code     Copy project files to NAS
  update-tunnel Update Cloudflare Tunnel configuration
  start-nas     Start Docker services on NAS
  verify        Health check all endpoints
  full          Run all steps in sequence

Options:
  --nas-host HOST       NAS IP address (default: $NAS_HOST)
  --nas-user USER       NAS SSH user (default: $NAS_USER)
  --nas-dir DIR         NAS deploy directory (default: $NAS_DEPLOY_DIR)
  --mac-host HOST       Mac Mini IP (default: $MAC_MINI_HOST)
  --pb-data DIR         PocketBase data dir (default: $PB_DATA)
  --dry-run             Show commands without executing
  -h, --help            Show this help

Examples:
  $(basename "$0") preflight --nas-host 192.168.1.100
  $(basename "$0") full --nas-host 192.168.1.100 --nas-user admin
  $(basename "$0") verify --nas-host 192.168.1.100
EOF
}

DRY_RUN=false

# Parse flags
parse_flags() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --nas-host)   NAS_HOST="$2"; shift 2 ;;
            --nas-user)   NAS_USER="$2"; shift 2 ;;
            --nas-dir)    NAS_DEPLOY_DIR="$2"; shift 2 ;;
            --mac-host)   MAC_MINI_HOST="$2"; shift 2 ;;
            --pb-data)    PB_DATA="$2"; shift 2 ;;
            --dry-run)    DRY_RUN=true; shift ;;
            -h|--help)    usage; exit 0 ;;
            *)            shift ;;
        esac
    done
}

run_cmd() {
    if $DRY_RUN; then
        echo -e "${YELLOW}[DRY-RUN]${NC} $*"
    else
        eval "$@"
    fi
}

# ── Step 1: Preflight checks ──
cmd_preflight() {
    info "Running preflight checks..."
    local errors=0

    # Check local prerequisites
    for cmd in ssh rsync docker curl; do
        if command -v "$cmd" &>/dev/null; then
            ok "$cmd available"
        else
            fail "$cmd not found"; ((errors++))
        fi
    done

    # Check LumiGate data directory
    if [[ -d "$LUMIGATE_DATA" ]]; then
        ok "LumiGate data/ exists ($(du -sh "$LUMIGATE_DATA" | cut -f1))"
    else
        fail "LumiGate data/ not found at $LUMIGATE_DATA"; ((errors++))
    fi

    # Check PocketBase data
    if [[ -d "$PB_DATA" ]]; then
        ok "PocketBase pb_data/ exists ($(du -sh "$PB_DATA" | cut -f1))"
    else
        warn "PocketBase pb_data/ not found at $PB_DATA (skippable)"
    fi

    # Check NAS connectivity
    info "Testing NAS connectivity ($NAS_HOST)..."
    if ping -c 1 -W 2 "$NAS_HOST" &>/dev/null; then
        ok "NAS reachable at $NAS_HOST"
    else
        fail "Cannot reach NAS at $NAS_HOST"; ((errors++))
    fi

    # Check SSH access
    if ssh -o ConnectTimeout=5 -o BatchMode=yes "$NAS_USER@$NAS_HOST" "echo ok" &>/dev/null; then
        ok "SSH access to $NAS_USER@$NAS_HOST"
    else
        warn "SSH access failed — ensure key-based auth is configured"
    fi

    # Check NAS Docker
    if ssh -o ConnectTimeout=5 "$NAS_USER@$NAS_HOST" "docker --version" &>/dev/null; then
        ok "Docker available on NAS"
    else
        fail "Docker not available on NAS"; ((errors++))
    fi

    if ssh -o ConnectTimeout=5 "$NAS_USER@$NAS_HOST" "docker compose version" &>/dev/null; then
        ok "Docker Compose available on NAS"
    else
        fail "Docker Compose not available on NAS"; ((errors++))
    fi

    echo ""
    if [[ $errors -gt 0 ]]; then
        fail "$errors preflight check(s) failed"
        return 1
    else
        ok "All preflight checks passed"
    fi
}

# ── Step 2: Copy project files to NAS ──
cmd_copy_code() {
    info "Copying project files to NAS..."

    # Create target directory
    run_cmd ssh "$NAS_USER@$NAS_HOST" "mkdir -p $NAS_DEPLOY_DIR"

    # Sync project files (exclude data, node_modules, .git)
    run_cmd rsync -avz --progress \
        --exclude 'data/' \
        --exclude 'node_modules/' \
        --exclude '.git/' \
        --exclude '*.log' \
        --exclude '.env' \
        "$PROJECT_ROOT/" "$NAS_USER@$NAS_HOST:$NAS_DEPLOY_DIR/"

    ok "Project files synced to $NAS_HOST:$NAS_DEPLOY_DIR"
}

# ── Step 3: Copy LumiGate data/ ──
cmd_copy_data() {
    info "Copying LumiGate data/ to NAS..."

    if [[ ! -d "$LUMIGATE_DATA" ]]; then
        fail "data/ directory not found at $LUMIGATE_DATA"
        return 1
    fi

    # Create data directory on NAS
    run_cmd ssh "$NAS_USER@$NAS_HOST" "mkdir -p $NAS_DEPLOY_DIR/data"

    # Sync data (preserve permissions, compress)
    run_cmd rsync -avz --progress \
        "$LUMIGATE_DATA/" "$NAS_USER@$NAS_HOST:$NAS_DEPLOY_DIR/data/"

    ok "LumiGate data synced ($(du -sh "$LUMIGATE_DATA" | cut -f1))"
}

# ── Step 4: Copy PocketBase pb_data/ ──
cmd_copy_pb() {
    info "Copying PocketBase pb_data/ to NAS..."

    if [[ ! -d "$PB_DATA" ]]; then
        warn "PocketBase pb_data/ not found at $PB_DATA — skipping"
        return 0
    fi

    local nas_pb_dir="${NAS_DEPLOY_DIR}/pb_data"
    run_cmd ssh "$NAS_USER@$NAS_HOST" "mkdir -p $nas_pb_dir"

    # Sync PocketBase data (SQLite + attachments)
    run_cmd rsync -avz --progress \
        "$PB_DATA/" "$NAS_USER@$NAS_HOST:$nas_pb_dir/"

    ok "PocketBase pb_data synced ($(du -sh "$PB_DATA" | cut -f1))"
}

# ── Step 5: Update Cloudflare Tunnel ──
cmd_update_tunnel() {
    info "Cloudflare Tunnel configuration notes:"
    echo ""
    echo "  The CF Tunnel token in .env can be reused as-is."
    echo "  The tunnel will automatically connect from the NAS."
    echo ""
    echo "  If the tunnel's ingress rules reference specific IPs,"
    echo "  update them in the Cloudflare Zero Trust dashboard:"
    echo "    https://one.dash.cloudflare.com/"
    echo ""
    echo "  Steps:"
    echo "    1. Copy .env to NAS: scp .env $NAS_USER@$NAS_HOST:$NAS_DEPLOY_DIR/deploy/nas/.env"
    echo "    2. Verify CF_TUNNEL_TOKEN_LUMIGATE is set"
    echo "    3. Start services — tunnel will auto-register"
    echo ""
    ok "Tunnel config reminder displayed"
}

# ── Step 6: Start services on NAS ──
cmd_start_nas() {
    info "Starting Docker services on NAS..."

    # Check .env exists
    if ! ssh "$NAS_USER@$NAS_HOST" "test -f $NAS_DEPLOY_DIR/deploy/nas/.env"; then
        fail ".env not found on NAS at $NAS_DEPLOY_DIR/deploy/nas/.env"
        echo "  Copy it: scp deploy/nas/.env $NAS_USER@$NAS_HOST:$NAS_DEPLOY_DIR/deploy/nas/.env"
        return 1
    fi

    run_cmd ssh "$NAS_USER@$NAS_HOST" \
        "cd $NAS_DEPLOY_DIR/deploy/nas && docker compose up -d --build"

    info "Waiting 30s for services to initialize..."
    sleep 30

    ok "Docker services started on NAS"
}

# ── Step 7: Verify all endpoints ──
cmd_verify() {
    info "Verifying service health..."
    local errors=0

    # NAS services
    declare -A NAS_ENDPOINTS=(
        ["LumiGate"]="http://$NAS_HOST:9471/health"
        ["SearXNG"]="http://$NAS_HOST:18780"
        ["File Parser"]="http://$NAS_HOST:18782/health"
        ["Doc Gen"]="http://$NAS_HOST:18783/health"
        ["Gotenberg"]="http://$NAS_HOST:18785/health"
        ["MCPJungle"]="http://$NAS_HOST:18790/health"
        ["Whisper (NAS)"]="http://$NAS_HOST:17863/health"
    )

    echo ""
    info "NAS endpoints ($NAS_HOST):"
    for name in "${!NAS_ENDPOINTS[@]}"; do
        local url="${NAS_ENDPOINTS[$name]}"
        if curl -sf --max-time 5 "$url" &>/dev/null; then
            ok "  $name — $url"
        else
            fail "  $name — $url"; ((errors++))
        fi
    done

    # Mac Mini services
    echo ""
    info "Mac Mini endpoints ($MAC_MINI_HOST):"

    declare -A MAC_ENDPOINTS=(
        ["Ollama"]="http://$MAC_MINI_HOST:11434/"
        ["Whisper (Mac)"]="http://$MAC_MINI_HOST:17863/health"
    )

    for name in "${!MAC_ENDPOINTS[@]}"; do
        local url="${MAC_ENDPOINTS[$name]}"
        if curl -sf --max-time 5 "$url" &>/dev/null; then
            ok "  $name — $url"
        else
            warn "  $name — $url (may not be running yet)"
        fi
    done

    # Cross-machine connectivity
    echo ""
    info "Cross-machine connectivity:"
    if curl -sf --max-time 5 "http://$MAC_MINI_HOST:11434/" &>/dev/null; then
        ok "  NAS can reach Ollama on Mac Mini"
    else
        warn "  NAS cannot reach Ollama on Mac Mini (check firewall)"
    fi

    echo ""
    if [[ $errors -gt 0 ]]; then
        fail "$errors service(s) failed health check"
        return 1
    else
        ok "All services healthy"
    fi
}

# ── Full migration ──
cmd_full() {
    echo "============================================"
    echo "  LumiGate Migration: Mac Mini -> NAS"
    echo "============================================"
    echo ""
    info "NAS: $NAS_USER@$NAS_HOST:$NAS_DEPLOY_DIR"
    info "Mac Mini: $MAC_MINI_HOST"
    echo ""

    cmd_preflight || { fail "Preflight failed — fix issues above"; exit 1; }
    echo ""
    cmd_copy_code
    echo ""
    cmd_copy_data
    echo ""
    cmd_copy_pb
    echo ""
    cmd_update_tunnel
    echo ""
    cmd_start_nas
    echo ""
    cmd_verify

    echo ""
    echo "============================================"
    ok "Migration complete!"
    echo ""
    echo "Next steps:"
    echo "  1. Verify LumiChat at https://lumigate.autorums.com"
    echo "  2. Start Mac Mini services: cd deploy/mac && docker compose up -d"
    echo "  3. Update OLLAMA_URL in NAS .env to Mac Mini IP"
    echo "  4. Stop old services on Mac Mini (except Ollama + Whisper)"
    echo "============================================"
}

# ── Main ──
COMMAND="${1:-}"
shift || true
parse_flags "$@"

case "$COMMAND" in
    preflight)      cmd_preflight ;;
    copy-code)      cmd_copy_code ;;
    copy-data)      cmd_copy_data ;;
    copy-pb)        cmd_copy_pb ;;
    update-tunnel)  cmd_update_tunnel ;;
    start-nas)      cmd_start_nas ;;
    verify)         cmd_verify ;;
    full)           cmd_full ;;
    ""|help|-h|--help) usage ;;
    *)
        fail "Unknown command: $COMMAND"
        echo ""
        usage
        exit 1
        ;;
esac
