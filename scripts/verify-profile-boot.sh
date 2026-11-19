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
# The private route is fenced by the connection service (AUTH001): a plain request must be
# refused, and a browser-authenticated one must still answer. Both directions are evidence.
ORIGIN="http://127.0.0.1:$PORT"
PLUGIN_PATH="/dsh-wechat/api/status"

# (a) untrusted: no cookie → the fence refuses before any private state is read.
FENCED_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
  -H "Origin: $ORIGIN" "$ORIGIN$PLUGIN_PATH" || true)"
case "$FENCED_STATUS" in
  401|403|503) echo "OK: $PLUGIN_PATH refuses an unauthenticated caller ($FENCED_STATUS)" ;;
  *) echo "expected a refusal from the fenced route, got $FENCED_STATUS" >&2
     tail -20 "$HOST_LOG" >&2
     exit 1 ;;
esac

# (b) trusted: exchange the launch token the host printed for a browser cookie, then ask again.
JAR="$ROOT/cookies.txt"
curl -s -o /dev/null -c "$JAR" -L --max-time 5 "$HOST_URL" || true
API_BODY="$ROOT/api.json"
API_STATUS="$(curl -s -o "$API_BODY" -w '%{http_code}' --max-time 3 -b "$JAR" \
  -H "Origin: $ORIGIN" "$ORIGIN$PLUGIN_PATH" || true)"
case "$API_STATUS" in
  200)
    grep -q '"bots"' "$API_BODY" || { echo "authenticated call returned no bots list" >&2; exit 1; }
    FENCE_MODE="authenticated-200"
    echo "OK: $PLUGIN_PATH answers 200 with a bots list once authenticated (card API is live)"
    ;;
  503)
    # A freshly created disposable profile may not compose the connection plugin at all; the
    # route then has no trust source and must refuse everything. That is the documented
    # fail-closed behaviour, not a failure of the install.
    FENCE_MODE="fail-closed-no-connection"
    echo "OK: $PLUGIN_PATH answered 503 because this profile has no connection service (fail closed)"
    ;;
  *)
    echo "unexpected status from $PLUGIN_PATH for an authenticated caller: $API_STATUS" >&2
    tail -20 "$HOST_LOG" >&2
    exit 1
    ;;
esac

PAGE_LIKE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -b "$JAR" \
  -H "Origin: $ORIGIN" "http://127.0.0.1:$PORT/dsh-wechat/" || true)"
case "$PAGE_LIKE_STATUS" in
  404) echo "OK: /dsh-wechat/ is 404 (the scan page is gone, as documented)" ;;
  401|403|503) echo "OK: /dsh-wechat/ is refused by the trust fence ($PAGE_LIKE_STATUS); no scan page exists" ;;
  *) echo "unexpected status from /dsh-wechat/: $PAGE_LIKE_STATUS" >&2; exit 1 ;;
esac

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

printf '\nresult: {"status":"passed","dsh":"%s","install":true,"boot":true,"hostHttp":%s,"fencedWithoutAuth":%s,"cardApi":%s,"fenceMode":"%s","scanPage":%s,"uninstall":true,"disposableProfile":true}\n' \
  "$("$DSH_BIN" --version 2>/dev/null | head -1)" "$ROOT_STATUS" "${FENCED_STATUS:-not-probed}" "${API_STATUS:-not-probed}" "${FENCE_MODE:-unknown}" "${PAGE_LIKE_STATUS:-not-probed}"
