#!/usr/bin/env bash
#
# Assemble the evidence bundle DSH STORE's reviewer asked for:
#
#   "install/start/uninstall 证据应逐个精确宿主版本绑定固定 Commit、CLI 版本、
#    临时 DSH_HOME/Profile、脱敏命令及退出状态，并保存组合基线与卸载后的差异。"
#
# Everything runs against a disposable DSH_HOME; the operator's real profile, credentials and
# running app are untouched. Output is a directory of plain text/JSON plus a sha256 index, so
# a reviewer can cite exact bytes instead of trusting a summary.
#
# Usage:
#   scripts/verify-admission-evidence.sh [output-dir]
#
# Env:
#   DSH_BIN   dsh executable (default: dsh on PATH)
#   SKIP_TESTS=1  skip the test suite step (it is the slowest part)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DSH_BIN="${DSH_BIN:-dsh}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${1:-$REPO_ROOT/evidence/$STAMP}"

COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
TARBALL="$(ls -1t dsh-wechat-*.tgz 2>/dev/null | head -1)"
if [ -z "$TARBALL" ]; then
  echo "no dsh-wechat-*.tgz found; run 'npm pack' first" >&2
  exit 2
fi
command -v "$DSH_BIN" >/dev/null || { echo "dsh CLI not on PATH (set DSH_BIN)" >&2; exit 2; }

mkdir -p "$OUT"
LOG="$OUT/commands.log"
: > "$LOG"
export EVIDENCE_LOG="$LOG"

DSH_VERSION="$("$DSH_BIN" --version 2>/dev/null | head -1)"
NODE_VERSION="$(node --version 2>/dev/null || echo unknown)"
OS_NAME="$(uname -s) $(uname -r) $(uname -m)"
TARBALL_SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"

log() { printf '%s\n' "$*" | tee -a "$LOG"; }

log "# evidence bundle $STAMP"
log "# repository https://github.com/zgat/dsh-wechat"
log "# commit     $COMMIT"
log "# dsh        $DSH_VERSION (CLI: $(command -v "$DSH_BIN"))"
log "# node       $NODE_VERSION"
log "# platform   $OS_NAME"
log "# tarball    $TARBALL sha256=$TARBALL_SHA"
log "# note       every step below ran with a fresh temp DSH_HOME; the real profile was never touched"

# ── 1. package surface the store inspects ────────────────────────────────────────────────
log ""
log "## 1. package surface"
{
  printf '$ git ls-files -s | awk '\''$1=="100755"'\''   # expect empty: no executable bits\n'
  git ls-files -s | awk '$1=="100755"'
  printf '# (end; %s executable entries)\n' "$(git ls-files -s | awk '$1=="100755"' | wc -l | tr -d ' ')"
  printf '\n$ git ls-files | grep -E "\\.(node|wasm|dll|dylib|so|exe|bin)$"   # expect empty\n'
  git ls-files | grep -E '\.(node|wasm|dll|dylib|so|exe|bin)$' || true
  printf '\n$ git grep -n child_process -- lib bin   # expect empty\n'
  git grep -n child_process -- lib bin || true
  printf '\n$ tar tzf %s | wc -l\n' "$TARBALL"
  tar tzf "$TARBALL" | wc -l
  printf '\n$ tar tzvf %s | awk '\''$1 ~ /^-/ {print $1}'\'' | sort -u\n' "$TARBALL"
  tar tzvf "$TARBALL" | awk '$1 ~ /^-/ {print $1}' | sort -u
} | tee -a "$LOG"

# ── 2. tests ────────────────────────────────────────────────────────────────────────────
log ""
log "## 2. test suite"
if [ "${SKIP_TESTS:-0}" = "1" ]; then
  log "  skipped (SKIP_TESTS=1)"
else
  printf '$ node --test --test-timeout=30000 test/\n' | tee -a "$LOG"
  node --test --test-timeout=30000 test/ > "$OUT/tests.log" 2>&1
  TEST_EXIT=$?
  grep -E '^ℹ (tests|pass|fail)' "$OUT/tests.log" | tee -a "$LOG"
  printf '  exit=%s (full output: tests.log)\n' "$TEST_EXIT" | tee -a "$LOG"
fi

# ── 3. disposable install / composition / uninstall ─────────────────────────────────────
log ""
log "## 3. install, composition, uninstall (temp DSH_HOME, no port bound)"
EVIDENCE_DIR="$OUT/install" EVIDENCE_LOG="$LOG" \
  bash scripts/verify-profile-install.sh "$TARBALL" > "$OUT/install.log" 2>&1
INSTALL_EXIT=$?
grep -E '^(OK|result|──)' "$OUT/install.log" | tee -a "$LOG"
printf '  exit=%s (full output: install.log; baseline/diff: install/)\n' "$INSTALL_EXIT" | tee -a "$LOG"

# ── 4. real boot inside that temp DSH_HOME ──────────────────────────────────────────────
log ""
log "## 4. boot the host in a temp DSH_HOME (system-assigned port)"
EVIDENCE_LOG="$LOG" bash scripts/verify-profile-boot.sh > "$OUT/boot.log" 2>&1
BOOT_EXIT=$?
grep -E '^(OK|result|note|──)' "$OUT/boot.log" | tee -a "$LOG"
printf '  exit=%s (full output: boot.log)\n' "$BOOT_EXIT" | tee -a "$LOG"

# ── 5. summary ──────────────────────────────────────────────────────────────────────────
RESULT_INSTALL="$(grep -oE '\{"status".*\}' "$OUT/install.log" | tail -1)"
RESULT_BOOT="$(grep -oE '\{"status".*\}' "$OUT/boot.log" | tail -1)"
TESTS_LINE="$(grep -E '^ℹ (pass|fail)' "$OUT/tests.log" 2>/dev/null | tr '\n' ' ' | sed 's/"/\\"/g')"

cat > "$OUT/summary.json" <<JSON
{
  "repositoryUrl": "https://github.com/zgat/dsh-wechat",
  "commit": "$COMMIT",
  "package": "$(node -p "require('./package.json').name + '@' + require('./package.json').version" 2>/dev/null)",
  "tarball": "$TARBALL",
  "tarballSha256": "$TARBALL_SHA",
  "dshCli": "$DSH_VERSION",
  "node": "$NODE_VERSION",
  "platform": "$OS_NAME",
  "disposableHome": true,
  "installExit": $INSTALL_EXIT,
  "bootExit": $BOOT_EXIT,
  "tests": "$TESTS_LINE",
  "install": $([ -n "$RESULT_INSTALL" ] && printf '%s' "$RESULT_INSTALL" || printf 'null'),
  "boot": $([ -n "$RESULT_BOOT" ] && printf '%s' "$RESULT_BOOT" || printf 'null'),
  "checkedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

# ── 6. sha256 index over the bundle ─────────────────────────────────────────────────────
( cd "$OUT" && find . -type f ! -name 'sha256sums.txt' -print0 | sort -z | xargs -0 shasum -a 256 > sha256sums.txt )

log ""
log "## 6. bundle"
log "  $OUT"
log "  files: $(cd "$OUT" && find . -type f | wc -l | tr -d ' ') (see sha256sums.txt)"
cat "$OUT/summary.json" | tee -a "$LOG"
if [ "$INSTALL_EXIT" -ne 0 ] || [ "$BOOT_EXIT" -ne 0 ]; then exit 1; fi
