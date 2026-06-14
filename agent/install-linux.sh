#!/usr/bin/env bash
set -euo pipefail

SERVER=""
TOKEN=""
TOKEN_FROM_STDIN="0"
NODE_NAME="$(hostname)"
INTERVAL="3"
PING_INTERVAL="60"
MODE="websocket"
INSTALL_DIR=""
SERVICE_NAME=""
INSTANCE_ID=""
SOURCE_URL=""
BUILD_FROM_SOURCE="0"
BINARY=""
BINARY_URL=""
BINARY_SHA256=""
CHECKSUM_URL=""
SKIP_CHECKSUM="0"
AUTO_BINARY_URL="0"
BINARY_CHECKSUM_REQUIRED="0"
DRY_RUN="0"
UNINSTALL="0"
UNINSTALL_ALL="0"
YES="0"
KEEP_FILES="0"
INSTALL_GHPROXY=""
PROXY=""
CF_MONITOR_REPOSITORY="kadidalax/cf-monitor"
CF_MONITOR_BRANCH="main"
CF_MONITOR_RELEASE_TAG="agent-latest"
CF_MONITOR_RELEASE_BASE="https://github.com/${CF_MONITOR_REPOSITORY}/releases/download/${CF_MONITOR_RELEASE_TAG}"
MOUNT_INCLUDE=""
MOUNT_EXCLUDE=""
NIC_INCLUDE=""
NIC_EXCLUDE=""
ALLOW_LOCAL_PING_TARGETS="0"
BLOCK_PRIVATE_PING_TARGETS="0"
DISABLE_WEB_SSH="0"
DISABLE_AUTO_UPDATE="0"
IGNORE_UNSAFE_CERT="0"

usage() {
  cat <<'EOF'
Usage:
  sudo ./install-linux.sh --server https://worker.example.com --token-stdin [options]
  sudo ./install-linux.sh --uninstall [options]

Options:
  --server URL              Worker URL, required.
  --token TOKEN             Agent token from admin panel. Prefer --token-stdin to avoid shell history.
  --token-stdin             Read the agent token from standard input.
  --name NAME               Node name, default: hostname.
  --interval SECONDS        Report interval, default: 3.
  --ping-interval SECONDS   Ping task poll interval, default: 60.
  --mode MODE               websocket or http, default: websocket.
  --instance-id ID          Instance id used for default service and install directory.
  --install-dir DIR         Install directory, default: /opt/cf-monitor/<instance-id>.
  --service-name NAME       systemd service name, default: cf-monitor-agent-<instance-id>.
  --install-service-name NAME
                            Komari-compatible alias for --service-name.
  --binary PATH             Existing agent binary.
  --binary-url URL          Download a prebuilt agent binary from this URL.
  --binary-sha256 HEX       Expected SHA256 for --binary-url.
  --checksum-url URL        URL of a SHA256SUMS file.
  --skip-checksum           Skip binary SHA256 verification.
  --release-tag TAG         GitHub release tag used for default binary downloads, default: agent-latest.
  --build-from-source       Build from local source or GitHub source archive. Requires Go.
  --source-url URL          Source archive used with --build-from-source.
  --source-sha256 HEX       Required SHA256 for downloaded source archives unless --skip-checksum is set.
  --proxy URL               Proxy used for --binary-url downloads, for example http://127.0.0.1:10808.
  --mount-include LIST      Comma-separated mountpoint/device patterns included in disk totals.
  --mount-exclude LIST      Comma-separated mountpoint/device patterns excluded from disk totals.
  --nic-include LIST        Comma-separated network interface patterns included in traffic totals.
  --nic-exclude LIST        Comma-separated network interface patterns excluded from traffic totals.
  --allow-local-ping-targets
                            Allow loopback, link-local, and metadata-service ping targets.
  --block-private-ping-targets
                            Block RFC1918 and IPv6 ULA ping targets in addition to local targets.
  --disable-web-ssh         Accepted for Komari option compatibility.
  --disable-auto-update     Accepted for Komari option compatibility.
  --ignore-unsafe-cert      Accepted for Komari option compatibility.
  --install-ghproxy URL     Accepted for Komari option compatibility.
  --dry-run                 Print actions without changing the system.
  --uninstall               Stop and remove the systemd service and env file.
  --uninstall-all           Stop all cf-monitor-agent* services and remove all installed agent files.
  --yes                     Confirm destructive --uninstall-all.
  --keep-files              With --uninstall, keep the install directory.
  -h, --help                Show help.
EOF
}

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

normalize_proxy_url() {
  local value="${1%/}"
  printf '%s' "$value"
}

with_github_proxy() {
  local url="$1"
  local proxy
  proxy="$(normalize_proxy_url "$INSTALL_GHPROXY")"
  if [[ -n "$proxy" ]]; then
    printf '%s/%s' "$proxy" "$url"
  else
    printf '%s' "$url"
  fi
}

download_file() {
  local url="$1"
  local output="$2"
  if [[ "$DRY_RUN" == "1" ]]; then
    if command -v curl >/dev/null 2>&1; then
      local curl_args=(-fsSL --retry 3 -o "$output")
      if [[ -n "$PROXY" ]]; then
        curl_args+=(--proxy "$PROXY")
      fi
      printf '[dry-run] curl'
      printf ' %q' "${curl_args[@]}" "$url"
      printf '\n'
    elif command -v wget >/dev/null 2>&1; then
      local wget_args=(-O "$output")
      if [[ -n "$PROXY" ]]; then
        wget_args+=(--execute "use_proxy=yes" --execute "http_proxy=$PROXY" --execute "https_proxy=$PROXY")
      fi
      printf '[dry-run] wget'
      printf ' %q' "${wget_args[@]}" "$url"
      printf '\n'
    else
      echo "[dry-run] download \"$url\" to \"$output\""
    fi
    return
  fi

  if command -v curl >/dev/null 2>&1; then
    local curl_args=(-fsSL --retry 3 -o "$output")
    if [[ -n "$PROXY" ]]; then
      curl_args+=(--proxy "$PROXY")
    fi
    curl "${curl_args[@]}" "$url"
  elif command -v wget >/dev/null 2>&1; then
    local wget_args=(-O "$output")
    if [[ -n "$PROXY" ]]; then
      wget_args+=(--execute "use_proxy=yes" --execute "http_proxy=$PROXY" --execute "https_proxy=$PROXY")
    fi
    wget "${wget_args[@]}" "$url"
  else
    echo "curl or wget is required to download files." >&2
    exit 1
  fi
}

is_sha256_hex() {
  [[ "$1" =~ ^[A-Fa-f0-9]{64}$ ]]
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    echo "sha256sum or shasum is required to verify downloads." >&2
    exit 1
  fi
}

url_basename() {
  local url="${1%%\?*}"
  url="${url%/}"
  printf '%s' "${url##*/}"
}

checksum_from_file() {
  local checksum_file="$1"
  local expected_name="$2"
  local line hash name

  while IFS= read -r line || [[ -n "$line" ]]; do
    set -- $line
    hash="${1:-}"
    name="${2:-}"
    name="${name#\*}"
    name="${name#./}"
    if is_sha256_hex "$hash" && [[ "$name" == "$expected_name" ]]; then
      printf '%s' "$hash"
      return 0
    fi
  done < "$checksum_file"

  return 1
}

verify_binary_sha256() {
  local file="$1"
  local source_url="$2"
  local checksum_required="$3"
  local expected="${BINARY_SHA256}"
  local expected_name
  expected_name="$(url_basename "$source_url")"

  if [[ "$SKIP_CHECKSUM" == "1" ]]; then
    echo "Warning: binary SHA256 verification skipped." >&2
    return 0
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    if [[ -n "$expected" || -n "$CHECKSUM_URL" || "$checksum_required" == "1" ]]; then
      echo "[dry-run] verify SHA256 for ${expected_name}"
    fi
    return 0
  fi

  if [[ -z "$expected" && -n "$CHECKSUM_URL" ]]; then
    local checksum_file
    checksum_file="$(mktemp /tmp/cf-monitor-checksums.XXXXXX)"
    if download_file "$CHECKSUM_URL" "$checksum_file"; then
      expected="$(checksum_from_file "$checksum_file" "$expected_name" || true)"
    elif [[ "$checksum_required" == "1" ]]; then
      rm -f "$checksum_file"
      echo "Failed to download required checksum file: $CHECKSUM_URL" >&2
      exit 1
    fi
    rm -f "$checksum_file"
  fi

  if [[ -z "$expected" ]]; then
    if [[ "$checksum_required" == "1" ]]; then
      echo "Missing SHA256 checksum for ${expected_name}." >&2
      exit 1
    fi
    echo "Warning: no SHA256 checksum provided for ${expected_name}; downloaded binary was not verified." >&2
    return 0
  fi

  if ! is_sha256_hex "$expected"; then
    echo "Invalid SHA256 checksum: $expected" >&2
    exit 1
  fi

  local actual expected_lower actual_lower
  actual="$(sha256_file "$file")"
  expected_lower="$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')"
  actual_lower="$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')"
  if [[ "$actual_lower" != "$expected_lower" ]]; then
    echo "SHA256 mismatch for ${expected_name}." >&2
    echo "Expected: ${expected_lower}" >&2
    echo "Actual:   ${actual_lower}" >&2
    exit 1
  fi

  echo "Verified SHA256 for ${expected_name}."
}

resolve_build_dir() {
  if [[ -f "$SCRIPT_DIR/main.go" ]]; then
    printf '%s' "$SCRIPT_DIR"
    return
  fi

  local source_archive
  local source_dir
  source_archive="${SOURCE_ARCHIVE:-}"
  source_dir="${SOURCE_DIR:-}"
  if [[ -z "$source_archive" || -z "$source_dir" ]]; then
    source_archive="$(mktemp /tmp/cf-monitor-source.XXXXXX.tar.gz)"
    source_dir="$(mktemp -d /tmp/cf-monitor-source.XXXXXX)"
    SOURCE_ARCHIVE="$source_archive"
    SOURCE_DIR="$source_dir"
  fi

  local source_url="${SOURCE_URL:-https://github.com/${CF_MONITOR_REPOSITORY}/archive/refs/heads/${CF_MONITOR_BRANCH}.tar.gz}"
  source_url="$(with_github_proxy "$source_url")"
  download_file "$source_url" "$source_archive" >&2
  verify_source_sha256 "$source_archive" "$source_url"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] tar -xzf \"$source_archive\" -C \"$source_dir\"" >&2
    printf '%s' "$source_dir/cf-monitor-${CF_MONITOR_BRANCH}/agent"
    return
  fi

  if ! command -v tar >/dev/null 2>&1; then
    echo "tar is required to extract the source archive." >&2
    exit 1
  fi

  tar -xzf "$source_archive" -C "$source_dir"
  local main_go
  main_go="$(find "$source_dir" -path '*/agent/main.go' -print -quit)"
  if [[ -z "$main_go" ]]; then
    echo "Cannot find agent/main.go in source archive: $source_url" >&2
    exit 1
  fi
  dirname "$main_go"
}

detect_binary_filename() {
  local os
  local arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m | tr '[:upper:]' '[:lower:]')"

  case "$os" in
    linux) os="linux" ;;
    darwin) os="darwin" ;;
    *) echo "Unsupported OS for prebuilt agent: $os" >&2; exit 1 ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "Unsupported CPU architecture for prebuilt agent: $arch" >&2; exit 1 ;;
  esac

  printf 'cf-monitor-agent-%s-%s' "$os" "$arch"
}

set_release_base() {
  if [[ -z "$CF_MONITOR_RELEASE_TAG" ]]; then
    CF_MONITOR_RELEASE_TAG="agent-latest"
  fi
  if [[ "$CF_MONITOR_RELEASE_TAG" == -* || "$CF_MONITOR_RELEASE_TAG" == *" "* ]]; then
    echo "--release-tag cannot start with - or contain spaces." >&2
    exit 1
  fi
  CF_MONITOR_RELEASE_BASE="https://github.com/${CF_MONITOR_REPOSITORY}/releases/download/${CF_MONITOR_RELEASE_TAG}"
}

default_binary_url() {
  local filename
  filename="$(detect_binary_filename)" || exit 1
  printf '%s/%s' "$CF_MONITOR_RELEASE_BASE" "$filename"
}

sanitize_instance_id() {
  local raw="${1:-}"
  local cleaned
  cleaned="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_.-]+/-/g; s/^-+//; s/-+$//')"
  if [[ -z "$cleaned" ]]; then
    cleaned="default"
  fi
  printf '%s' "${cleaned:0:48}"
}

apply_instance_defaults() {
  local base
  base="$(sanitize_instance_id "${INSTANCE_ID:-${TOKEN:-default}}")"
  if [[ -z "$SERVICE_NAME" ]]; then
    SERVICE_NAME="cf-monitor-agent-${base}"
  fi
  if [[ -z "$INSTALL_DIR" ]]; then
    INSTALL_DIR="/opt/cf-monitor/${base}"
  fi
}

uninstall_all_agents() {
  if [[ "$YES" != "1" ]]; then
    echo "--uninstall-all requires --yes because it removes every cf-monitor-agent service and /opt/cf-monitor." >&2
    exit 1
  fi

  local unit
  for unit in /etc/systemd/system/cf-monitor-agent*.service; do
    [[ -e "$unit" ]] || continue
    run systemctl disable --now "$(basename "$unit")" || true
  done

  run rm -f /etc/systemd/system/cf-monitor-agent*.service
  run rm -f /etc/cf-monitor-agent*.env
  if [[ "$KEEP_FILES" != "1" ]]; then
    run rm -rf /opt/cf-monitor
  fi
  run systemctl daemon-reload
  echo "Uninstalled all CF Monitor agent services and files."
}

write_file() {
  local path="$1"
  local mode="$2"
  local content="$3"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] write ${path} (${mode})"
  else
    printf '%s\n' "$content" > "$path"
    chmod "$mode" "$path"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --token-stdin) TOKEN_FROM_STDIN="1"; shift ;;
    --name) NODE_NAME="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --ping-interval) PING_INTERVAL="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --instance-id) INSTANCE_ID="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --service-name|--install-service-name) SERVICE_NAME="${2:-}"; shift 2 ;;
    --build-from-source) BUILD_FROM_SOURCE="1"; shift ;;
    --source-url) SOURCE_URL="${2:-}"; shift 2 ;;
    --binary) BINARY="${2:-}"; shift 2 ;;
    --binary-url) BINARY_URL="${2:-}"; shift 2 ;;
    --binary-sha256) BINARY_SHA256="${2:-}"; shift 2 ;;
    --checksum-url) CHECKSUM_URL="${2:-}"; shift 2 ;;
    --skip-checksum) SKIP_CHECKSUM="1"; shift ;;
    --release-tag) CF_MONITOR_RELEASE_TAG="${2:-}"; shift 2 ;;
    --proxy) PROXY="${2:-}"; shift 2 ;;
    --mount-include) MOUNT_INCLUDE="${2:-}"; shift 2 ;;
    --mount-exclude) MOUNT_EXCLUDE="${2:-}"; shift 2 ;;
    --nic-include) NIC_INCLUDE="${2:-}"; shift 2 ;;
    --nic-exclude) NIC_EXCLUDE="${2:-}"; shift 2 ;;
    --allow-local-ping-targets) ALLOW_LOCAL_PING_TARGETS="1"; shift ;;
    --block-private-ping-targets) BLOCK_PRIVATE_PING_TARGETS="1"; shift ;;
    --disable-web-ssh) DISABLE_WEB_SSH="1"; shift ;;
    --disable-auto-update) DISABLE_AUTO_UPDATE="1"; shift ;;
    --ignore-unsafe-cert) IGNORE_UNSAFE_CERT="1"; shift ;;
    --install-ghproxy) INSTALL_GHPROXY="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN="1"; shift ;;
    --uninstall) UNINSTALL="1"; shift ;;
    --uninstall-all) UNINSTALL_ALL="1"; shift ;;
    --yes|-y) YES="1"; shift ;;
    --keep-files) KEEP_FILES="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

set_release_base

if [[ "$DRY_RUN" != "1" && "$(id -u)" -ne 0 ]]; then
  echo "Please run as root, for example: sudo ./install-linux.sh ..." >&2
  exit 1
fi

if [[ "$DRY_RUN" != "1" ]] && ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required for this installer." >&2
  exit 1
fi

if [[ "$UNINSTALL_ALL" == "1" ]]; then
  uninstall_all_agents
  exit 0
fi

apply_instance_defaults

if [[ -z "$SERVICE_NAME" ]]; then
  echo "--service-name cannot be empty." >&2
  exit 1
fi

if [[ -z "$INSTALL_DIR" || "$INSTALL_DIR" == "/" ]]; then
  echo "--install-dir cannot be empty or /." >&2
  exit 1
fi

ENV_FILE="/etc/${SERVICE_NAME}.env"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ "$UNINSTALL" == "1" ]]; then
  run systemctl disable --now "$SERVICE_NAME" || true
  run rm -f "$UNIT_FILE"
  run rm -f "$ENV_FILE"
  if [[ "$KEEP_FILES" != "1" ]]; then
    run rm -rf "$INSTALL_DIR"
  fi
  run systemctl daemon-reload
  echo "Uninstalled ${SERVICE_NAME}."
  exit 0
fi

if [[ -z "$TOKEN" && -n "${CF_MONITOR_TOKEN:-}" ]]; then
  TOKEN="$CF_MONITOR_TOKEN"
fi

if [[ -z "$TOKEN" && "$TOKEN_FROM_STDIN" == "1" ]]; then
  IFS= read -r TOKEN || true
fi

if [[ -z "$TOKEN" && -t 0 && "$DRY_RUN" != "1" ]]; then
  read -r -s -p "Agent token: " TOKEN
  printf '\n'
fi

if [[ -z "$SERVER" || -z "$TOKEN" ]]; then
  echo "--server and an agent token are required for install or upgrade." >&2
  usage
  exit 1
fi

if [[ "$MODE" != "websocket" && "$MODE" != "http" ]]; then
  echo "--mode must be websocket or http." >&2
  exit 1
fi

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
WORK_BIN=""

if [[ -n "$BINARY" && ( -n "$BINARY_URL" || "$BUILD_FROM_SOURCE" == "1" ) ]]; then
  echo "Use only one of --binary, --binary-url, or --build-from-source." >&2
  exit 1
fi

if [[ -n "$BINARY_URL" && "$BUILD_FROM_SOURCE" == "1" ]]; then
  echo "Use only one of --binary-url or --build-from-source." >&2
  exit 1
fi

if [[ -n "$BINARY" ]]; then
  if [[ ! -f "$BINARY" ]]; then
    echo "Binary not found: $BINARY" >&2
    exit 1
  fi
  WORK_BIN="$BINARY"
  if [[ -n "$BINARY_SHA256" || -n "$CHECKSUM_URL" ]]; then
    verify_binary_sha256 "$WORK_BIN" "$BINARY" "0"
  fi
else
  if [[ -z "$BINARY_URL" && "$BUILD_FROM_SOURCE" != "1" ]]; then
    DEFAULT_BINARY_URL="$(default_binary_url)" || exit 1
    if [[ -z "$CHECKSUM_URL" ]]; then
      CHECKSUM_URL="$(with_github_proxy "${CF_MONITOR_RELEASE_BASE}/SHA256SUMS")"
    fi
    BINARY_CHECKSUM_REQUIRED="1"
    if ! BINARY_URL="$(with_github_proxy "$DEFAULT_BINARY_URL")"; then
      exit 1
    fi
    AUTO_BINARY_URL="1"
  fi
fi

if [[ -n "$BINARY_URL" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    WORK_BIN="/tmp/cf-monitor-agent.dry-run"
    download_file "$BINARY_URL" "$WORK_BIN"
    verify_binary_sha256 "$WORK_BIN" "$BINARY_URL" "$BINARY_CHECKSUM_REQUIRED"
  else
    WORK_BIN="$(mktemp /tmp/cf-monitor-agent.XXXXXX)"
    if download_file "$BINARY_URL" "$WORK_BIN"; then
      chmod 0755 "$WORK_BIN"
      verify_binary_sha256 "$WORK_BIN" "$BINARY_URL" "$BINARY_CHECKSUM_REQUIRED"
    elif [[ "$AUTO_BINARY_URL" == "1" ]]; then
      echo "Prebuilt agent binary was not found at ${BINARY_URL}; falling back to source build." >&2
      rm -f "$WORK_BIN"
      WORK_BIN=""
      BINARY_URL=""
      BUILD_FROM_SOURCE="1"
    else
      rm -f "$WORK_BIN"
      exit 1
    fi
  fi
fi

if [[ -z "$WORK_BIN" && "$BUILD_FROM_SOURCE" == "1" ]]; then
  if [[ "$DRY_RUN" != "1" ]] && ! command -v go >/dev/null 2>&1; then
    echo "Go is required to build the agent from source after the prebuilt binary was unavailable. Install Go, publish release assets, or pass --binary-url." >&2
    exit 1
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    WORK_BIN="/tmp/cf-monitor-agent.dry-run"
    BUILD_DIR="$(resolve_build_dir)"
    echo "[dry-run] cd \"$BUILD_DIR\" && go build -trimpath -ldflags=\"-s -w\" -o \"$WORK_BIN\" ."
  else
    WORK_BIN="$(mktemp /tmp/cf-monitor-agent.XXXXXX)"
    BUILD_DIR="$(resolve_build_dir)"
    (cd "$BUILD_DIR" && go build -trimpath -ldflags="-s -w" -o "$WORK_BIN" .)
  fi
fi

run mkdir -p "$INSTALL_DIR"
run install -m 0755 "$WORK_BIN" "$INSTALL_DIR/cf-monitor-agent"

ENV_CONTENT=$(cat <<EOF
CF_MONITOR_SERVER=${SERVER}
CF_MONITOR_TOKEN=${TOKEN}
CF_MONITOR_NAME=${NODE_NAME}
CF_MONITOR_MODE=${MODE}
CF_MONITOR_MOUNT_INCLUDE=${MOUNT_INCLUDE}
CF_MONITOR_MOUNT_EXCLUDE=${MOUNT_EXCLUDE}
CF_MONITOR_NIC_INCLUDE=${NIC_INCLUDE}
CF_MONITOR_NIC_EXCLUDE=${NIC_EXCLUDE}
CF_MONITOR_ALLOW_LOCAL_PING_TARGETS=${ALLOW_LOCAL_PING_TARGETS}
CF_MONITOR_BLOCK_PRIVATE_PING_TARGETS=${BLOCK_PRIVATE_PING_TARGETS}
EOF
)
write_file "$ENV_FILE" "600" "$ENV_CONTENT"

UNIT_CONTENT=$(cat <<EOF
[Unit]
Description=CF Monitor Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
ExecStart=${INSTALL_DIR}/cf-monitor-agent --interval ${INTERVAL} --ping-interval ${PING_INTERVAL}
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LockPersonality=true
RestrictRealtime=true
RestrictSUIDSGID=true
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
EOF
)
write_file "$UNIT_FILE" "644" "$UNIT_CONTENT"

run systemctl daemon-reload
run systemctl enable "$SERVICE_NAME"
run systemctl restart "$SERVICE_NAME"

echo "Installed ${SERVICE_NAME}."
echo "Status: systemctl status ${SERVICE_NAME}"
echo "Logs:   journalctl -u ${SERVICE_NAME} -f"
