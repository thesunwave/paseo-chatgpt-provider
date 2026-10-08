#!/usr/bin/env bash
# Pinned, conservative macOS alpha installer for Paseo ChatGPT via Codexify.
set -euo pipefail

CODEXIFY_SHA=e14c5a353a4af842a0751c8e943a5977a0ccd304
CODEXIFY_REPO=https://github.com/thesunwave/codexify.git
PLUGIN_ID=chatgpt-codexify
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
STATE_DIR="${PASEO_CHATGPT_STATE_DIR:-$HOME/.local/share/paseo-chatgpt-codexify}"
CONFIG="${CODEXIFY_CONFIG:-$HOME/.codexify/codexify.config.json}"
SOCKET="${CODEXIFY_CHATGPT_BACKEND_SOCKET:-/Users/Shared/codexify-chatgpt/backend.sock}"
WORKSPACE="${PASEO_CHATGPT_WORKSPACE_ROOT:-/Users/Shared/PaseoWorkspaces}"
MODE=install
YES=0
NO_SERVICE=0
NO_BUILD=0

usage() {
  cat <<'HELP'
Usage: ./install.sh [--dry-run | --check | --uninstall] [options]
  --dry-run               Show planned actions; no changes
  --check                 Read-only environment and controller preflight
  --uninstall             Remove this installer's Paseo plugin (preserve Codexify/config)
  --yes                   Confirm trust and new-service installation
  --no-build              Only reuse an already running Codexify controller
  --no-service            Build/configure but do not install/start a Codexify service
  --config PATH           Codexify JSON file
  --socket PATH           Controller socket (must match Paseo daemon environment)
  --workspace-root PATH   Allowed project root
  --state-dir PATH        Installer-owned build and metadata
  --help
Supported: macOS alpha. Pin: e14c5a353a4af842a0751c8e943a5977a0ccd304
HELP
}
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
say() { printf '==> %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
while (( $# )); do
  case "$1" in
    --dry-run|--check|--uninstall)
      [[ "$MODE" == install ]] || fail "Choose only one operation"
      MODE="${1#--}";;
    --yes) YES=1;;
    --no-service) NO_SERVICE=1;;
    --no-build) NO_BUILD=1;;
    --config|--socket|--workspace-root|--state-dir)
      opt="$1"; shift; (( $# > 0 )) || fail "Missing argument for $opt"
      case "$opt" in
        --config) CONFIG="$1";;
        --socket) SOCKET="$1";;
        --workspace-root) WORKSPACE="$1";;
        --state-dir) STATE_DIR="$1";;
      esac;;
    --help|-h) usage; exit 0;;
    *) fail "Unknown option: $1";;
  esac
  shift
done
[[ "$(uname -s)" == Darwin ]] || fail "Only macOS is supported for this alpha"
for path in "$STATE_DIR" "$CONFIG" "$SOCKET" "$WORKSPACE"; do
  [[ "$path" == /* ]] || fail "Absolute paths required: $path"
done
[[ ! -L "$CONFIG" ]] || fail "Refusing symlinked config: $CONFIG"
SOCKET_DIR="$(dirname "$SOCKET")"
BIN="$STATE_DIR/bin/codexify"
SOURCE="$STATE_DIR/src/codexify"
MARKER="$STATE_DIR/installed-provider"
if [[ -x "$STATE_DIR/paseo-cli/node_modules/.bin/paseo" ]]; then
  export PATH="$STATE_DIR/paseo-cli/node_modules/.bin:$PATH"
fi

# A live controller may belong to a pre-existing service. Never replace it.
controller_ready() {
  [[ -S "$SOCKET" ]] && have python3 || return 1
  python3 - "$SOCKET" <<'PY' >/dev/null 2>&1
import json, socket, sys, uuid
s = socket.socket(socket.AF_UNIX)
s.settimeout(2)
try:
    s.connect(sys.argv[1])
    s.sendall((json.dumps({"id":str(uuid.uuid4()),"op":"pool","workspace":""})+"\n").encode())
    data = b""
    while not data.endswith(b"\n") and len(data) < 100000:
        chunk = s.recv(4096)
        if not chunk: break
        data += chunk
    response = json.loads(data)
    assert isinstance(response.get("ok"), bool)
finally:
    s.close()
PY
}

preflight() {
  say "Codexify commit: $CODEXIFY_SHA"
  say "Controller socket: $SOCKET"
  say "Config: $CONFIG"
  say "Workspace root: $WORKSPACE"
  for tool in git cargo python3 paseo; do
    say "$tool: $(command -v "$tool" || echo missing)"
  done
  if controller_ready; then say "Controller: responding"; else say "Controller: unavailable"; fi
  if [[ -f "$CONFIG" ]] && have python3; then
    python3 - "$CONFIG" "$SOCKET" "$WORKSPACE" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f: config=json.load(f)
    exp=config.get("experimental") or {}
    print("Config checks: bridge=%s socket=%s delegated=%s" % (
        exp.get("chatgptBridge") is True,
        exp.get("chatgptBackendControllerSocket")==sys.argv[2],
        sys.argv[3] in (exp.get("chatgptBackendDelegatedRoots") or [])))
except (ValueError, TypeError, OSError) as e:
    print("Config unreadable: %s" % e)
PY
  else say "Config: missing"; fi
  if have paseo; then paseo plugin ls "$PLUGIN_ID" || true; fi
}

if [[ "$MODE" == check ]]; then preflight; exit 0; fi
if [[ "$MODE" == uninstall ]]; then
  [[ -f "$MARKER" ]] || fail "No installer-owned provider marker; refusing to remove another install"
  [[ "$(cat "$MARKER")" == "$ROOT" ]] || fail "Installer marker belongs to a different checkout"
  have paseo || fail "paseo CLI required for uninstall"
  if (( ! YES )); then
    read -r -p "Remove Paseo plugin $PLUGIN_ID? Keep Codexify and config [y/N] " response
    [[ "$response" =~ ^[yY]$ ]] || fail "Cancelled"
  fi
  paseo plugin remove "$PLUGIN_ID"
  rm -f "$MARKER"
  say "Plugin removed. Codexify service, binaries, config and backups were preserved."
  exit 0
fi

say "Paseo ChatGPT alpha installer"
say "Source: $ROOT"
say "Codexify pinned revision: $CODEXIFY_SHA"
say "Socket: $SOCKET"
say "Config: $CONFIG"
say "Workspace: $WORKSPACE"
if [[ "$MODE" == dry-run ]]; then
  say "Would check dependencies, reuse a live controller or build the pinned Codexify."
  say "Would create safe directories, back up/merge config, install the Paseo plugin."
  say "Would install a NEW per-user Codexify service only if none exists."
  say "Will NOT replace binaries, stop or restart an existing Codexify service."
  exit 0
fi

[[ -f "$ROOT/paseo-plugin.json" ]] || fail "Plugin manifest is missing"
if (( ! YES )); then
  say "Plugin code runs unsandboxed as the Paseo daemon user; review sources first."
  read -r -p "Continue installing trusted code? [y/N] " response
  [[ "$response" =~ ^[yY]$ ]] || fail "Cancelled"
fi
have git || fail "git is missing; install Xcode Command Line Tools"
if ! have python3; then
  have brew || fail "Python 3 is required; install Homebrew and retry"
  say "Installing Python 3 using Homebrew"
  brew install python
fi
if ! have paseo; then
  if ! have npm; then
    have brew || fail "Node.js/npm is required; install Homebrew and retry"
    say "Installing Node.js using Homebrew"
    brew install node
  fi
  say "Installing Paseo CLI under installer-owned state directory"
  mkdir -p "$STATE_DIR/paseo-cli"
  npm install --prefix "$STATE_DIR/paseo-cli" --no-audit --no-fund @getpaseo/cli@0.10.3
  export PATH="$STATE_DIR/paseo-cli/node_modules/.bin:$PATH"
  have paseo || fail "Paseo CLI installation failed"
fi

# The configured socket is intentionally the same as the provider's baked-in default.
# A custom socket requires CODEXIFY_CHATGPT_BACKEND_SOCKET in the Paseo daemon environment.
if [[ "$SOCKET" != "/Users/Shared/codexify-chatgpt/backend.sock" ]]; then
  say "WARNING: custom socket requires CODEXIFY_CHATGPT_BACKEND_SOCKET in Paseo daemon environment"
fi
[[ ! -L "$SOCKET_DIR" ]] || fail "Socket directory must not be a symlink"
if [[ -d "$SOCKET_DIR" && ! -O "$SOCKET_DIR" ]] && ! controller_ready; then
  fail "Socket dir belongs to another user and controller is unavailable: $SOCKET_DIR"
fi
if [[ ! -d "$SOCKET_DIR" ]]; then
  mkdir -p "$SOCKET_DIR"
  chmod 700 "$SOCKET_DIR"
fi
if [[ ! -d "$WORKSPACE" ]]; then mkdir -p "$WORKSPACE"; fi

if controller_ready; then
  say "Existing controller is responding. Leaving its service/config/binary untouched."
else
  (( ! NO_BUILD )) || fail "No live controller; --no-build requested"
  if ! have cargo; then
    have brew || fail "Rust/Cargo is required; install Homebrew or Rust and retry"
    say "Installing Rust/Cargo using Homebrew"
    brew install rust
  fi
  mkdir -p "$STATE_DIR/bin" "$STATE_DIR/src"
  if [[ ! -d "$SOURCE/.git" ]]; then
    git clone --filter=blob:none --branch feat/paseo-rich-tool-details "$CODEXIFY_REPO" "$SOURCE"
  fi
  if ! git -C "$SOURCE" cat-file -e "$CODEXIFY_SHA^{commit}"; then
    git -C "$SOURCE" fetch origin "$CODEXIFY_SHA"
  fi
  git -C "$SOURCE" checkout --detach "$CODEXIFY_SHA"
  [[ "$(git -C "$SOURCE" rev-parse HEAD)" == "$CODEXIFY_SHA" ]] || fail "Codexify pinned SHA mismatch"
  if [[ ! -x "$BIN" ]] || [[ ! -f "$STATE_DIR/codexify-revision" ]] ||
       [[ "$(cat "$STATE_DIR/codexify-revision")" != "$CODEXIFY_SHA" ]]; then
    say "Compiling Codexify at pinned revision (may take several minutes)"
    (cd "$SOURCE" && cargo build --locked --release)
    install -m 755 "$SOURCE/target/release/codexify" "$BIN"
    printf '%s\n' "$CODEXIFY_SHA" >"$STATE_DIR/codexify-revision"
  fi
  # Never mutate config of a running service. Requires a deliberate restart.
  status_code=0
  "$BIN" service status --json >/dev/null 2>&1 || status_code=$?
  case "$status_code" in
    4) ;; # No service exists: safe to create a per-user service
    0|3) fail "An existing Codexify service exists but its controller is missing; not replacing or restarting it";;
    *) fail "Unable to determine Codexify service state (exit $status_code)";;
  esac
  mkdir -p "$(dirname "$CONFIG")"
  python3 "$ROOT/scripts/merge-codexify-config.py" \
    --config "$CONFIG" --socket "$SOCKET" \
    --workspace-root "$WORKSPACE" --work-dir "$HOME/projects"
  if (( ! NO_SERVICE )); then
    if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
      fail "Port 3000 is already in use; refusing to start another Codexify service"
    fi
    say "Installing a new per-user Codexify service"
    "$BIN" --config "$CONFIG" service install
  else
    say "Service installation skipped (--no-service)."
  fi
fi

say "Installing Paseo plugin from local repository"
if [[ -f "$MARKER" ]] && paseo plugin ls "$PLUGIN_ID" 2>/dev/null | grep -q "$PLUGIN_ID"; then
  say "Plugin already installed by this installer; leaving it in place"
else
  paseo plugin install "$ROOT"
fi
mkdir -p "$STATE_DIR"
printf '%s\n' "$ROOT" >"$MARKER"
say "Installed. Check Paseo Settings > Plugins: Enable plugins (requires your consent)."
say "ChatGPT connector/tunnel credentials are NOT automatically provisioned."
say "Run Codexify quickstart if needed, then attach a dedicated ChatGPT conversation."
preflight
