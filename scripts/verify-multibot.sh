#!/usr/bin/env bash
# Post-restart check for the multi-bot build. Repo-only tooling: not part of the package.
#
#   bash scripts/verify-multibot.sh
#
# Prints what the running process actually holds: the bound bots, their cursors, the
# namespaced conversation keys, and what the settings-card API reports. Run it after a
# restart to confirm the v1 → v2 migration landed and that every bot has its own loop.
set -u

STATE_DIR="${DSH_WECHAT_STATE_DIR:-$HOME/.dsh/integrations/dsh-wechat}"
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
APP_NAME="${DSH_APP_NAME:-DeepSeek Harness}"

say() { printf '%s\n' "$*"; }

say "== 版本 =="
workspace_version="$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)"
installed_version="$(node -e '
  try {
    const { createRequire } = require("node:module");
    const req = createRequire(process.argv[1] + "/package.json");
    process.stdout.write(String(req("dsh-wechat/package.json").version));
  } catch { process.stdout.write("unknown"); }
' "$PROFILE_DIR" 2>/dev/null)"
running_version="$(node -e '
  const fs = require("node:fs");
  try {
    const state = JSON.parse(fs.readFileSync(process.argv[1] + "/state.json", "utf8"));
    const boot = Array.isArray(state.boots) ? state.boots.at(-1) : null;
    process.stdout.write(boot ? `${boot.version} (pid ${boot.pid}, ${boot.at})` : "no boot record");
  } catch { process.stdout.write("no state file"); }
' "$STATE_DIR" 2>/dev/null)"
say "  工作区 $workspace_version · 已装 $installed_version · 运行 $running_version"

say ""
say "== 状态文件（迁移结果）=="
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const state = JSON.parse(fs.readFileSync(path + "/state.json", "utf8"));
  const credentials = JSON.parse(fs.readFileSync(path + "/credentials.json", "utf8"));
  const isV2 = Boolean(credentials.bots);
  console.log("  schema:", state.version, "· 凭据 shape:", credentials.version ?? "(无)");
  if (!isV2) {
    console.log("  bots: v1 单 bot 文件（重启后才会迁移为 v2）");
    console.log("    · cursor:", state.cursor ? "有" : "（空）", "· 去重", (state.seenMessageIds ?? []).length, "条 · 令牌", Object.keys(state.contextTokens ?? {}).length, "个");
  } else {
    const bots = Object.keys(credentials.bots);
    console.log("  bots:", bots.length ? bots.join(", ") : "（未绑定）");
    for (const id of bots) {
      const bucket = state.bots?.[id] ?? {};
      // `connected` in the bucket is the last persisted flag; the API below is the live view.
      console.log(`    · ${id}: cursor ${bucket.cursor ? "有" : "（空）"} · 去重 ${(bucket.seenMessageIds ?? []).length} 条 · 令牌 ${Object.keys(bucket.contextTokens ?? {}).length} 个`);
    }
  }
  // Per-bot evidence of isolation: the cursor, dedupe window, reply tokens and outbound
  // count of each bot. Two bots talking to the same person must show up as two rows with
  // different numbers and two conversation keys.
  if (isV2) {
    const outbound = Array.isArray(state.outbound) ? state.outbound : [];
    console.log("  每只 bot 的活动（应各自独立）:");
    for (const id of Object.keys(credentials.bots)) {
      const bucket = state.bots?.[id] ?? {};
      const sent = outbound.filter((entry) => entry.botId === id);
      const last = sent.at(-1)?.at;
      console.log(`    · ${id}: 游标 ${bucket.cursor ? "有" : "空"} · 去重 ${(bucket.seenMessageIds ?? []).length} · 令牌 ${Object.keys(bucket.contextTokens ?? {}).length} · 出站 ${sent.length}${last ? `（最近 ${new Date(last).toLocaleString("zh-CN", { hour12: false })}）` : ""}`);
    }
  }

  const keys = Object.keys(state.sessions ?? {});
  console.log("  会话绑定:", keys.length, "个");
  for (const key of keys.slice(0, 5)) console.log(`    ${key} → ${state.sessions[key]}`);
  const perBot = {};
  for (const key of keys) {
    const parts = key.split(":");
    if (parts.length >= 3) perBot[parts[1]] = (perBot[parts[1]] ?? 0) + 1;
  }
  const botNames = Object.keys(perBot);
  if (botNames.length > 1) {
    console.log("  会话键分布:", botNames.map((id) => `${id} ${perBot[id]} 个`).join(" · "), "✅ 按 bot 隔离");
  }

  const legacy = keys.filter((key) => /^(p2p|group):[^:]+$/.test(key));
  console.log("  旧键（未命名空间）:", legacy.length ? legacy.join(", ") : "无 ✅");
  const leftovers = ["cursor", "seenMessageIds", "contextTokens"].filter((key) => {
    const value = state[key];
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    return Boolean(value);
  });
  console.log("  v1 顶层字段残留:", leftovers.length ? leftovers.join(", ") : "无 ✅");
' "$STATE_DIR" 2>&1 | sed 's/^/  /'

say ""
say "== 设置页 API =="
# The boot record names the host process; `lsof` output is not text-safe under every
# locale, so the port is extracted with sed and byte ordering forced.
pid="$(node -e '
  const fs = require("node:fs");
  try {
    const state = JSON.parse(fs.readFileSync(process.argv[1] + "/state.json", "utf8"));
    const boot = Array.isArray(state.boots) ? state.boots.at(-1) : null;
    process.stdout.write(boot && boot.pid ? String(boot.pid) : "");
  } catch { process.stdout.write(""); }
' "$STATE_DIR" 2>/dev/null)"
ports="$(LC_ALL=C lsof -nP -a -p "${pid:-0}" -iTCP -sTCP:LISTEN 2>/dev/null | sed -n 's/.*:\([0-9][0-9]*\) (LISTEN).*/\1/p' | sort -un)"
found=""
for port in $ports; do
  body="$(curl -s --max-time 2 "http://127.0.0.1:$port/dsh-wechat/api/status" 2>/dev/null)"
  case "$body" in
    *'"bots"'*) found="$body"; break ;;
    *'"connected"'*) [ -z "$found" ] && found="$body" ;;
  esac
done
if [ -z "$found" ]; then
  say "  （没找到运行中的 GUI 端口，或插件未加载）"
else
  say "  $found" | head -c 600
  say ""
  case "$found" in
    *'"bots"'*) say "  ✅ 返回 bots 列表（多 bot 已生效）" ;;
    *) say "  ⚠️ 还返回旧的单 bot 形状 —— 运行中的进程仍是旧版本，需要重启 DSH" ;;
  esac
fi

say ""
say "== 迁移备份 =="
ls -1 "$STATE_DIR" 2>/dev/null | grep -E '\.v1-backup-' | sed 's/^/  /' || say "  （无，说明还没发生过 v1→v2 迁移）"
