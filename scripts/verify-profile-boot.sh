#!/usr/bin/env bash
#
# Disposable-profile boot evidence: starts a real DSH host with dsh-wechat mounted,
# proves the plugin came up (its HTTP route answers), then tears everything down.
#
# Complements scripts/verify-profile-install.sh, which covers install / composition /
# uninstall. That script deliberately does not boot; this one does, so the three
# operations DSH STORE asks about (install / start / uninstall) all have evidence.
#
# Isolation: a fresh DSH_HOME, an OS-assigned port (`--port 0`) and `--no-open`, so
# the operator's running DSH, its ports and its credentials are untouched. The plugin
# itself is patched to `autoLogin: false` for the boot, so no QR login or network
# traffic is attempted — this measures "does it start", not "does WeChat work".
#
# Usage:
#   scripts/verify-profile-boot.sh [path/to/dsh-wechat-<version>.tgz]

set -euo pipefail

TARBALL="${1:-$(ls -1t dsh-wechat-*.tgz 2>/dev/null | head -1)}"
[ -n "$TARBALL" ] || { echo "no tarball found; run 'npm pack' first or pass a path" >&2; exit 2; }
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"

DSH_BIN="${DSH_BIN:-dsh}"
command -v "$DSH_BIN" >/dev/null || { echo "the dsh CLI is not on PATH (set DSH_BIN)" >&2; exit 2; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-wechat-boot-XXXXXX")"
HOST_LOG="$ROOT/host.log"
HOST_PID=""
cleanup() {
  if [ -n "$HOST_PID" ] && kill -0 "$HOST_PID" 2>/dev/null; then
    kill -TERM "$HOST_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$HOST_PID" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$HOST_PID" 2>/dev/null || true
  fi
  rm -rf "$ROOT"
}
trap cleanup EXIT

export DSH_HOME="$ROOT/home"
export DSH_TELEMETRY_DISABLED=1
export npm_config_cache="$ROOT/npm-cache"
mkdir -p "$DSH_HOME"

step() { printf '\n── %s\n' "$1"; }

# A quiet boot: the plugin must not try to log in during a start check.
cat > "$ROOT/quiet.yml" <<'YAML'
- id: dsh-wechat
  config:
    enabled: true
    accessPolicy: allowlist
    autoLogin: false
    loginPage: true
    loginPagePort: 0
    openLoginPage: false
    logLevel: info
YAML

step "1/4 install into the disposable profile"
"$DSH_BIN" plugin --profile web add --ignore-scripts --config.auto-install-peers=false "$TARBALL"

step "2/4 boot the host (OS-assigned port, no browser)"
"$DSH_BIN" --profile web --patch "$ROOT/quiet.yml" --port 0 --no-open > "$HOST_LOG" 2>&1 &
HOST_PID=$!

# The host prints its own line (`dsh web: http://127.0.0.1:<port>/?token=…`). Do not
# match a bare 127.0.0.1 URL: the plugin's standalone scan page prints one too, on a
# different port, and probing that instead measures the wrong server.
HOST_URL=""
for _ in $(seq 1 120); do
  HOST_URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+' "$HOST_LOG" | head -1 || true)"
  [ -n "$HOST_URL" ] && break
  kill -0 "$HOST_PID" 2>/dev/null || break
  sleep 0.5
done
if [ -z "$HOST_URL" ]; then
  echo "the host never printed its URL; log follows" >&2
  tail -20 "$HOST_LOG" >&2
  exit 1
fi
PORT="$(printf '%s' "$HOST_URL" | grep -oE ':[0-9]+/' | tr -d ':/')"
echo "host is listening on 127.0.0.1:$PORT (pid $HOST_PID)"

# The host may answer its own URL with a redirect (the browser-trust fence) — any HTTP
# answer proves the transport is up; the plugin route below is the real discriminator.
ROOT_STATUS=""
for _ in $(seq 1 60); do
  ROOT_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$HOST_URL" || true)"
  case "$ROOT_STATUS" in 200|303|302|307|308) break ;; esac
  sleep 0.5
done
case "$ROOT_STATUS" in
  200|302|303|307|308) echo "OK: the host answers its own URL (HTTP $ROOT_STATUS)" ;;
  *) echo "the host did not answer its own URL (got $ROOT_STATUS)" >&2; exit 1 ;;
esac

step "3/4 the plugin mounted in that host"
# The plugin's route is token-guarded, so a missing token must be a 403: only the
# plugin can answer that on this origin.
PLUGIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/dsh-wechat/" || true)"
if [ "$PLUGIN_STATUS" != "403" ]; then
  echo "expected 403 from the plugin route (token missing), got $PLUGIN_STATUS" >&2
  tail -20 "$HOST_LOG" >&2
  exit 1
fi
echo "OK: /dsh-wechat/ answers 403 without a token (route is mounted)"

# …and with the plugin's one-time token the same route serves the scan page, which is
# the strongest available proof that the plugin is live inside that host.
PLUGIN_TOKEN="$(grep -oE '微信扫码页已就绪：http://127\.0\.0\.1:[0-9]+/t/[0-9a-f]+/' "$HOST_LOG" | head -1 | grep -oE '/t/[0-9a-f]+/' | tr -d '/t')"
if [ -n "$PLUGIN_TOKEN" ]; then
  PAGE_STATUS="$(curl -s -o "$ROOT/page.html" -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/dsh-wechat/?t=$PLUGIN_TOKEN" || true)"
  if [ "$PAGE_STATUS" != "200" ] || ! grep -q '<!doctype html>' "$ROOT/page.html"; then
    echo "the plugin route did not serve its page with a valid token (status $PAGE_STATUS)" >&2
    exit 1
  fi
  echo "OK: the plugin serves its scan page through the host origin (200, html)"
else
  PLUGIN_STATUS="403"
  echo "note: no plugin token in the log; the route 403 alone is the evidence" >&2
  PLUGIN_TOKEN=""
fi

step "4/4 stop the host and uninstall"
kill -TERM "$HOST_PID" 2>/dev/null || true
for _ in $(seq 1 30); do kill -0 "$HOST_PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$HOST_PID" 2>/dev/null; then kill -9 "$HOST_PID" 2>/dev/null || true; fi
HOST_PID=""
"$DSH_BIN" plugin --profile web remove dsh-wechat
"$DSH_BIN" --profile web --dump-config > "$ROOT/after.txt"
if grep -q 'dsh-wechat' "$ROOT/after.txt"; then
  echo "the plugin row survived the uninstall" >&2
  exit 1
fi
echo "OK: host stopped, plugin removed, composition back to baseline"

printf '\nresult: {"status":"passed","dsh":"%s","install":true,"boot":true,"hostHttp":%s,"pluginRouteNoToken":403,"pluginPageWithToken":%s,"uninstall":true,"disposableProfile":true}\n' \
  "$("$DSH_BIN" --version 2>/dev/null | head -1)" "$ROOT_STATUS" "${PAGE_STATUS:-not-probed}"
