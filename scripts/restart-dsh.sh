#!/usr/bin/env bash
#
# Restart the DSH desktop app so an updated plugin build actually loads.
#
# Why a restart is needed at all: DSH hot-applies profile *config*, but it keeps the
# plugin module it already imported. A new build on disk therefore only runs after
# the process is replaced (see README §4.4).
#
# Usage:
#   scripts/restart-dsh.sh                 quit and relaunch now
#   scripts/restart-dsh.sh --delay 25      wait 25s first (lets a chat reply go out)
#   scripts/restart-dsh.sh --cancel        cancel a pending delayed restart
#   scripts/restart-dsh.sh --verify-only   report ports + running plugin version
#   scripts/restart-dsh.sh --dry-run       print what would happen, change nothing
#
# The script is safe to launch in the background: a PID file makes `--cancel` work,
# and every step is logged so a failed relaunch is diagnosable after the fact.

set -uo pipefail

# launchd starts jobs with a minimal environment; make the tools this script needs
# findable regardless of who invoked it.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

APP_NAME="${DSH_APP_NAME:-DeepSeek Harness}"
WEB_PORT="${DSH_WEB_PORT:-19387}"
PLUGIN_PORT="${DSH_PLUGIN_PORT:-30989}"
STATE_DIR="${DSH_WECHAT_STATE_DIR:-$HOME/.dsh/integrations/dsh-wechat}"
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
LOG_FILE="${TMPDIR:-/tmp}/dsh-restart.log"
PID_FILE="${TMPDIR:-/tmp}/dsh-restart.pid"

DELAY=0
MODE="restart"

while [ $# -gt 0 ]; do
  case "$1" in
    --delay) DELAY="${2:?--delay needs seconds}"; shift 2 ;;
    --cancel) MODE="cancel"; shift ;;
    --verify-only) MODE="verify"; shift ;;
    --dry-run) MODE="dry-run"; shift ;;
    --app) APP_NAME="${2:?--app needs a name}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG_FILE" >&2; }

# --- discovery -------------------------------------------------------------

app_pid() {
  # The window server knows the app; fall back to whoever holds the web port.
  local pid
  pid="$(pgrep -x "DeepSeek Harness" 2>/dev/null | head -1)"
  [ -n "$pid" ] && { printf '%s' "$pid"; return; }
  lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $2}' | head -1
}

port_open() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

installed_version() {
  node -e '
    try {
      const { createRequire } = require("node:module");
      const req = createRequire(process.argv[1] + "/package.json");
      process.stdout.write(String(req("dsh-wechat/package.json").version));
    } catch { process.stdout.write("unknown"); }
  ' "$PROFILE_DIR" 2>/dev/null
}

running_version() {
  node -e '
    const fs = require("node:fs");
    try {
      const state = JSON.parse(fs.readFileSync(process.argv[1] + "/state.json", "utf8"));
      const boot = Array.isArray(state.boots) ? state.boots.at(-1) : null;
      process.stdout.write(boot ? `${boot.version} (pid ${boot.pid}, ${boot.at})` : "no boot record yet");
    } catch { process.stdout.write("no state file"); }
  ' "$STATE_DIR" 2>/dev/null
}

# --- modes -----------------------------------------------------------------

case "$MODE" in
  cancel)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      kill "$(cat "$PID_FILE")" 2>/dev/null && log "已取消待执行的重启（pid $(cat "$PID_FILE")）"
      rm -f "$PID_FILE"
    else
      log "没有待执行的重启"
    fi
    exit 0
    ;;
  verify)
    log "GUI 端口 $WEB_PORT: $(port_open "$WEB_PORT" && echo 在听 || echo 未监听)"
    log "扫码页端口 $PLUGIN_PORT: $(port_open "$PLUGIN_PORT" && echo 在听 || echo 未监听)"
    log "profile 已装版本: $(installed_version)"
    log "运行中的版本   : $(running_version)"
    exit 0
    ;;
esac

if [ "$MODE" = "dry-run" ]; then
  log "将执行：quit \"$APP_NAME\"（当前 pid $(app_pid || echo 未运行)）→ 等待退出 → open -a \"$APP_NAME\" → 等待端口 $WEB_PORT → 校验启动记录"
  [ "$DELAY" -gt 0 ] && log "会先等待 ${DELAY}s"
  exit 0
fi

# --- the restart -----------------------------------------------------------

# Re-entry guard. Anything that supervises this script (a launchd job relaunches its
# command on exit, for instance) would otherwise restart DSH forever: each run quits
# the app, relaunches it, exits, and gets started again. One restart per window.
GUARD_FILE="${TMPDIR:-/tmp}/dsh-restart.last"
GUARD_SECONDS="${DSH_RESTART_GUARD_SECONDS:-300}"
if [ -f "$GUARD_FILE" ] && [ "${DSH_RESTART_FORCE:-0}" != "1" ]; then
  LAST="$(cat "$GUARD_FILE" 2>/dev/null || echo 0)"
  NOW="$(date +%s)"
  if [ $((NOW - LAST)) -lt "$GUARD_SECONDS" ]; then
    log "护栏：$(( (NOW - LAST) )) 秒前刚重启过（窗口 ${GUARD_SECONDS}s），本次跳过。要强制：DSH_RESTART_FORCE=1 $0 ..."
    exit 0
  fi
fi
date +%s > "$GUARD_FILE"

echo "$$" > "$PID_FILE"
if [ "$DELAY" -gt 0 ]; then
  log "将在 ${DELAY}s 后重启 DSH（取消：$0 --cancel）"
  sleep "$DELAY"
fi

PID="$(app_pid)"
if [ -z "$PID" ]; then
  log "DSH 未在运行，直接启动"
else
  log "请求退出 DSH（pid $PID）"
  osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$PID" 2>/dev/null; then
    log "优雅退出超时，发送 SIGTERM"
    kill -TERM "$PID" 2>/dev/null || true
    for _ in $(seq 1 10); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
  fi
  if kill -0 "$PID" 2>/dev/null; then
    log "SIGTERM 后仍在，发送 SIGKILL"
    kill -9 "$PID" 2>/dev/null || true
    sleep 1
  fi
  log "DSH 已退出"
fi

log "重新启动 DSH"
open -a "$APP_NAME" || {
  log "open -a 失败：请手动打开 $APP_NAME（日志 $LOG_FILE）"
  exit 1
}

for _ in $(seq 1 120); do
  port_open "$WEB_PORT" && break
  sleep 0.5
done
if ! port_open "$WEB_PORT"; then
  log "60s 内端口 $WEB_PORT 未就绪 —— 应用可能仍在启动，或启动失败（日志 $LOG_FILE）"
  exit 1
fi
log "DSH 已回来（端口 $WEB_PORT 在听）"

# The plugin writes a boot record as it loads; wait for one from *this* launch.
for _ in $(seq 1 60); do
  case "$(running_version)" in
    "no boot record yet"|"no state file") sleep 1 ;;
    *) break ;;
  esac
done

INS="$(installed_version)"
RUN="$(running_version)"
log "profile 已装版本: $INS"
log "运行中的版本   : $RUN"
case "$RUN" in
  *"$INS"*) log "✅ 运行的已经是 $INS" ;;
  *) log "⚠️ 运行中的版本与已装版本不一致（旧构建可能仍未接线启动记录）；用 $0 --verify-only 复核" ;;
esac
rm -f "$PID_FILE"
