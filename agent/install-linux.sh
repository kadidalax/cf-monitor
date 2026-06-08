#!/usr/bin/env bash
set -euo pipefail

SERVER=""
TOKEN=""
NODE_NAME="$(hostname)"
INTERVAL="3"
PING_INTERVAL="30"
MODE="websocket"
INSTALL_DIR="/opt/cf-monitor"
SERVICE_NAME="cf-monitor-agent"
BINARY=""
BINARY_URL=""
DRY_RUN="0"
UNINSTALL="0"
KEEP_FILES="0"
INSTALL_GHPROXY=""
PROXY=""
MOUNT_INCLUDE=""
MOUNT_EXCLUDE=""
NIC_INCLUDE=""
NIC_EXCLUDE=""
DISABLE_WEB_SSH="0"
DISABLE_AUTO_UPDATE="0"
IGNORE_UNSAFE_CERT="0"

usage() {
  cat <<'EOF'
Usage:
  sudo ./install-linux.sh --server https://worker.example.com --token TOKEN [options]
  sudo ./install-linux.sh --uninstall [options]

Options:
  --server URL              Worker URL, required.
  --token TOKEN             Agent token from admin panel. Required.
  --name NAME               Node name, default: hostname.
  --interval SECONDS        Report interval, default: 3.
  --ping-interval SECONDS   Ping task poll interval, default: 30.
  --mode MODE               websocket or http, default: websocket.
  --install-dir DIR         Install directory, default: /opt/cf-monitor.
  --service-name NAME       systemd service name, default: cf-monitor-agent.
  --install-service-name NAME
                            Komari-compatible alias for --service-name.
  --binary PATH             Existing agent binary. If omitted, build from current source.
  --binary-url URL          Download a prebuilt agent binary from this URL.
  --proxy URL               Proxy used for --binary-url downloads, for example http://127.0.0.1:10808.
  --mount-include LIST      Comma-separated mountpoint/device patterns included in disk totals.
  --mount-exclude LIST      Comma-separated mountpoint/device patterns excluded from disk totals.
  --nic-include LIST        Comma-separated network interface patterns included in traffic totals.
  --nic-exclude LIST        Comma-separated network interface patterns excluded from traffic totals.
  --disable-web-ssh         Accepted for Komari option compatibility.
  --disable-auto-update     Accepted for Komari option compatibility.
  --ignore-unsafe-cert      Accepted for Komari option compatibility.
  --install-ghproxy URL     Accepted for Komari option compatibility.
  --dry-run                 Print actions without changing the system.
  --uninstall               Stop and remove the systemd service and env file.
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
    --name) NODE_NAME="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --ping-interval) PING_INTERVAL="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --service-name|--install-service-name) SERVICE_NAME="${2:-}"; shift 2 ;;
    --binary) BINARY="${2:-}"; shift 2 ;;
    --binary-url) BINARY_URL="${2:-}"; shift 2 ;;
    --proxy) PROXY="${2:-}"; shift 2 ;;
    --mount-include) MOUNT_INCLUDE="${2:-}"; shift 2 ;;
    --mount-exclude) MOUNT_EXCLUDE="${2:-}"; shift 2 ;;
    --nic-include) NIC_INCLUDE="${2:-}"; shift 2 ;;
    --nic-exclude) NIC_EXCLUDE="${2:-}"; shift 2 ;;
    --disable-web-ssh) DISABLE_WEB_SSH="1"; shift ;;
    --disable-auto-update) DISABLE_AUTO_UPDATE="1"; shift ;;
    --ignore-unsafe-cert) IGNORE_UNSAFE_CERT="1"; shift ;;
    --install-ghproxy) INSTALL_GHPROXY="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN="1"; shift ;;
    --uninstall) UNINSTALL="1"; shift ;;
    --keep-files) KEEP_FILES="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ "$DRY_RUN" != "1" && "$(id -u)" -ne 0 ]]; then
  echo "Please run as root, for example: sudo ./install-linux.sh ..." >&2
  exit 1
fi

if [[ "$DRY_RUN" != "1" ]] && ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required for this installer." >&2
  exit 1
fi

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

if [[ -z "$SERVER" || -z "$TOKEN" ]]; then
  echo "--server and --token are required for install or upgrade." >&2
  usage
  exit 1
fi

if [[ "$MODE" != "websocket" && "$MODE" != "http" ]]; then
  echo "--mode must be websocket or http." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_BIN=""

if [[ -n "$BINARY" && -n "$BINARY_URL" ]]; then
  echo "Use either --binary or --binary-url, not both." >&2
  exit 1
fi

if [[ -n "$BINARY" ]]; then
  if [[ ! -f "$BINARY" ]]; then
    echo "Binary not found: $BINARY" >&2
    exit 1
  fi
  WORK_BIN="$BINARY"
elif [[ -n "$BINARY_URL" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    WORK_BIN="/tmp/cf-monitor-agent.dry-run"
    if command -v curl >/dev/null 2>&1; then
      curl_args=(-fL --retry 3 -o "$WORK_BIN")
      if [[ -n "$PROXY" ]]; then
        curl_args+=(--proxy "$PROXY")
      fi
      printf '[dry-run] curl'
      printf ' %q' "${curl_args[@]}" "$BINARY_URL"
      printf '\n'
    elif command -v wget >/dev/null 2>&1; then
      wget_args=(-O "$WORK_BIN")
      if [[ -n "$PROXY" ]]; then
        wget_args+=(--execute "use_proxy=yes" --execute "http_proxy=$PROXY" --execute "https_proxy=$PROXY")
      fi
      printf '[dry-run] wget'
      printf ' %q' "${wget_args[@]}" "$BINARY_URL"
      printf '\n'
    else
      echo "[dry-run] download \"$BINARY_URL\" to \"$WORK_BIN\""
    fi
  else
    WORK_BIN="$(mktemp /tmp/cf-monitor-agent.XXXXXX)"
    if command -v curl >/dev/null 2>&1; then
      curl_args=(-fL --retry 3 -o "$WORK_BIN")
      if [[ -n "$PROXY" ]]; then
        curl_args+=(--proxy "$PROXY")
      fi
      curl "${curl_args[@]}" "$BINARY_URL"
    elif command -v wget >/dev/null 2>&1; then
      wget_args=(-O "$WORK_BIN")
      if [[ -n "$PROXY" ]]; then
        wget_args+=(--execute "use_proxy=yes" --execute "http_proxy=$PROXY" --execute "https_proxy=$PROXY")
      fi
      wget "${wget_args[@]}" "$BINARY_URL"
    else
      echo "curl or wget is required to download --binary-url." >&2
      exit 1
    fi
    chmod 0755 "$WORK_BIN"
  fi
else
  if [[ "$DRY_RUN" != "1" ]] && ! command -v go >/dev/null 2>&1; then
    echo "Go is required to build the agent. Install Go or pass --binary PATH." >&2
    exit 1
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    WORK_BIN="/tmp/cf-monitor-agent.dry-run"
    echo "[dry-run] cd \"$SCRIPT_DIR\" && go build -trimpath -ldflags=\"-s -w\" -o \"$WORK_BIN\" ."
  else
    WORK_BIN="$(mktemp /tmp/cf-monitor-agent.XXXXXX)"
    (cd "$SCRIPT_DIR" && go build -trimpath -ldflags="-s -w" -o "$WORK_BIN" .)
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
