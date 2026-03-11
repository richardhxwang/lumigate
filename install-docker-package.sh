#!/usr/bin/env bash
# LumiGate Docker package one-click installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/richardhxwang/lumigate/main/install-docker-package.sh | bash

set -euo pipefail

IMAGE_DEFAULT="richardhwang920/lumigate:latest"
CONTAINER_NAME="${CONTAINER_NAME:-lumigate}"
HOST_PORT="${HOST_PORT:-9471}"
DATA_DIR="${DATA_DIR:-$PWD/data}"
IMAGE="${IMAGE:-$IMAGE_DEFAULT}"
PLATFORM_OVERRIDE="${PLATFORM_OVERRIDE:-}"
AUTO_YES="${AUTO_YES:-0}"
ADMIN_SECRET="${ADMIN_SECRET:-}"

R='\033[0;31m'; G='\033[0;32m'; Y='\033[0;33m'; C='\033[0;36m'; N='\033[0m'
ok()   { echo -e "${G}✓${N} $1"; }
warn() { echo -e "${Y}!${N} $1"; }
err()  { echo -e "${R}✗${N} $1"; }
info() { echo -e "${C}•${N} $1"; }

yes_no() {
  local prompt="$1"
  local default="${2:-Y}"
  if [[ "$AUTO_YES" == "1" ]]; then
    [[ "$default" =~ ^[Yy]$ ]] && return 0 || return 1
  fi
  local answer
  read -rp "$prompt [$default/n] " answer
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy]$ ]]
}

require_sudo() {
  if [[ "$EUID" -ne 0 ]]; then
    if command -v sudo >/dev/null 2>&1; then
      echo "sudo"
    else
      err "This action requires root privileges (sudo not found)."
      exit 1
    fi
  else
    echo ""
  fi
}

install_docker_macos() {
  if ! command -v brew >/dev/null 2>&1; then
    warn "Homebrew not found. Installing Homebrew first."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [[ -x /opt/homebrew/bin/brew ]]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [[ -x /usr/local/bin/brew ]]; then
      eval "$(/usr/local/bin/brew shellenv)"
    fi
  fi
  brew install --cask docker
  warn "Please open Docker Desktop once, wait until it shows 'Engine running', then re-run this installer."
  exit 0
}

install_docker_linux() {
  local sudo_cmd
  sudo_cmd="$(require_sudo)"
  curl -fsSL https://get.docker.com | ${sudo_cmd} sh
  if [[ -n "${SUDO_USER:-}" ]]; then
    ${sudo_cmd} usermod -aG docker "$SUDO_USER" || true
    warn "Added $SUDO_USER to docker group. You may need to log out and back in."
  elif [[ -n "${USER:-}" ]]; then
    ${sudo_cmd} usermod -aG docker "$USER" || true
    warn "Added $USER to docker group. You may need to log out and back in."
  fi
}

ensure_docker_installed() {
  if command -v docker >/dev/null 2>&1; then
    ok "Docker is installed."
    return
  fi

  warn "Docker is not installed."
  if ! yes_no "Install Docker now?" "Y"; then
    err "Docker is required. Exiting."
    exit 1
  fi

  case "$(uname -s)" in
    Darwin) install_docker_macos ;;
    Linux)  install_docker_linux ;;
    *)
      err "Unsupported OS for auto-install. Install Docker manually, then re-run."
      exit 1
      ;;
  esac
}

ensure_docker_running() {
  if docker info >/dev/null 2>&1; then
    ok "Docker daemon is running."
    return
  fi
  err "Docker is installed but daemon is not running."
  warn "Start Docker Desktop / Docker service and re-run."
  exit 1
}

maybe_login_dockerhub() {
  if [[ -n "${DOCKERHUB_USERNAME:-}" && -n "${DOCKERHUB_TOKEN:-}" ]]; then
    info "Logging in to Docker Hub using environment credentials."
    printf '%s' "$DOCKERHUB_TOKEN" | docker login -u "$DOCKERHUB_USERNAME" --password-stdin >/dev/null
    ok "Docker Hub login succeeded."
    return
  fi

  if [[ "$AUTO_YES" == "1" ]]; then
    warn "AUTO_YES=1 but Docker Hub credentials not provided; skipping login."
    return
  fi

  if yes_no "Login to Docker Hub before pulling image?" "Y"; then
    local username token
    read -rp "Docker Hub username: " username
    read -rsp "Docker Hub access token (input hidden): " token
    echo ""
    if [[ -z "$username" || -z "$token" ]]; then
      err "Username/token cannot be empty."
      exit 1
    fi
    printf '%s' "$token" | docker login -u "$username" --password-stdin >/dev/null
    ok "Docker Hub login succeeded."
  else
    warn "Skipping Docker Hub login."
  fi
}

pull_image() {
  local pull_log
  pull_log="$(mktemp)"
  local pull_platform=""
  if [[ -n "$PLATFORM_OVERRIDE" ]]; then
    pull_platform="--platform $PLATFORM_OVERRIDE"
  fi

  info "Pulling image: $IMAGE"
  if docker pull ${pull_platform} "$IMAGE" >"$pull_log" 2>&1; then
    ok "Image pulled successfully."
    rm -f "$pull_log"
    return
  fi

  if [[ "$(cat "$pull_log")" == *"no matching manifest"* ]]; then
    warn "No native manifest for current architecture. Retrying with --platform linux/amd64."
    PLATFORM_OVERRIDE="linux/amd64"
    if docker pull --platform linux/amd64 "$IMAGE" >"$pull_log" 2>&1; then
      ok "Image pulled successfully with linux/amd64."
      rm -f "$pull_log"
      return
    fi
  fi

  err "Failed to pull image: $IMAGE"
  echo "---- docker pull output ----"
  cat "$pull_log"
  echo "----------------------------"
  rm -f "$pull_log"
  exit 1
}

prepare_secret() {
  if [[ -n "$ADMIN_SECRET" ]]; then
    return
  fi
  if [[ "$AUTO_YES" == "1" ]]; then
    ADMIN_SECRET="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)"
    return
  fi
  read -rsp "ADMIN_SECRET (min 8 chars): " ADMIN_SECRET
  echo ""
  if [[ ${#ADMIN_SECRET} -lt 8 ]]; then
    err "ADMIN_SECRET must be at least 8 characters."
    exit 1
  fi
}

run_container() {
  mkdir -p "$DATA_DIR"
  local exists="0"
  while IFS= read -r name; do
    if [[ "$name" == "$CONTAINER_NAME" ]]; then
      exists="1"
      break
    fi
  done < <(docker ps -a --format '{{.Names}}')
  if [[ "$exists" == "1" ]]; then
    if yes_no "Container '$CONTAINER_NAME' exists. Replace it?" "Y"; then
      docker rm -f "$CONTAINER_NAME" >/dev/null
      ok "Removed existing container."
    else
      err "Cannot continue with existing container name."
      exit 1
    fi
  fi

  local run_platform=""
  if [[ -n "$PLATFORM_OVERRIDE" ]]; then
    run_platform="--platform $PLATFORM_OVERRIDE"
  fi

  docker run -d --name "$CONTAINER_NAME" \
    ${run_platform} \
    -p "${HOST_PORT}:9471" \
    -e "ADMIN_SECRET=${ADMIN_SECRET}" \
    -v "${DATA_DIR}:/app/data" \
    "$IMAGE" >/dev/null

  ok "Container started: $CONTAINER_NAME"
}

verify_health() {
  info "Waiting for health endpoint..."
  for _ in $(seq 1 20); do
    if curl -s --max-time 2 "http://localhost:${HOST_PORT}/health" >/dev/null 2>&1; then
      ok "LumiGate is up: http://localhost:${HOST_PORT}"
      return
    fi
    sleep 1
  done
  warn "Container started, but health check did not pass yet."
  warn "Inspect logs with: docker logs -f ${CONTAINER_NAME}"
}

main() {
  info "LumiGate Docker one-click installer"
  ensure_docker_installed
  ensure_docker_running
  maybe_login_dockerhub
  pull_image
  prepare_secret
  run_container
  verify_health
}

main "$@"
