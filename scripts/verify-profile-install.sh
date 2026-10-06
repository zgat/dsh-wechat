#!/usr/bin/env bash
#
# Disposable-profile evidence: install, compose and uninstall dsh-wechat without
# touching the operator's real DSH home.
#
# Why: DSH STORE asks for "disposable Profile install/start/uninstall evidence"
# before treating a plugin as reviewed. This script produces exactly that, and it is
# reproducible by anyone with a DSH CLI on PATH.
#
# Usage:
#   scripts/verify-profile-install.sh [path/to/dsh-wechat-<version>.tgz]
#
# Everything happens under a fresh DSH_HOME in $TMPDIR, so the real profile, the
# real credentials and the running app are untouched. The script never boots a
# second host (no port is bound); "start" is limited to composition, which is what
# `--dump-config` can prove offline. Boot evidence would need a bound port and is
# deliberately out of scope here.

set -euo pipefail

TARBALL="${1:-$(ls -1t dsh-wechat-*.tgz 2>/dev/null | head -1)}"
[ -n "$TARBALL" ] || { echo "no tarball found; run 'npm pack' first or pass a path" >&2; exit 2; }
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"

DSH_BIN="${DSH_BIN:-dsh}"
command -v "$DSH_BIN" >/dev/null || { echo "the dsh CLI is not on PATH (set DSH_BIN)" >&2; exit 2; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-wechat-profile-XXXXXX")"
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT

export DSH_HOME="$ROOT/home"
export DSH_TELEMETRY_DISABLED=1
export npm_config_cache="$ROOT/npm-cache"
mkdir -p "$DSH_HOME"

step() { printf '\n── %s\n' "$1"; }

step "1/4 baseline composition (no plugin)"
"$DSH_BIN" --profile web --dump-config > "$ROOT/before.txt"
if grep -q 'dsh-wechat' "$ROOT/before.txt"; then
  echo "unexpected: the fresh profile already contains dsh-wechat" >&2
  exit 1
fi
echo "OK: dsh-wechat is absent from the baseline profile"

step "2/4 install into the disposable profile"
"$DSH_BIN" plugin --profile web add --ignore-scripts --config.auto-install-peers=false "$TARBALL"
"$DSH_BIN" --profile web --dump-config > "$ROOT/after.txt"
grep -q 'dsh-wechat' "$ROOT/after.txt" || { echo "dsh-wechat row missing after install" >&2; exit 1; }
echo "OK: the plugin row is composed into the profile"

step "3/4 declared entry and lifecycle"
python3 - "$TARBALL" <<'PY'
import json, subprocess, sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
    member = next(name for name in archive.getnames() if name.endswith('package/package.json'))
    manifest = json.load(archive.extractfile(member))
scripts = [name for name in ('preinstall', 'install', 'postinstall', 'prepare') if name in manifest.get('scripts', {})]
print(f"  package      : {manifest['name']}@{manifest['version']}")
print(f"  bundle patch : {manifest['dsh']['bundle']['patch']}")
print(f"  dshReleases  : {json.dumps(manifest['dsh']['compatibility']['dshReleases'])}")
print(f"  engines/os   : {manifest.get('engines')} / {manifest.get('os')}")
print(f"  dependencies : {len(manifest.get('dependencies', {}))} runtime, peers: {len(manifest.get('peerDependencies', {}))}")
print(f"  lifecycle    : {scripts or 'none'}")
assert not scripts, 'lifecycle scripts would run code at install time'
assert not manifest.get('dependencies'), 'runtime dependencies are not allowed by the store contract'
PY

step "4/4 uninstall"
"$DSH_BIN" plugin --profile web remove dsh-wechat
"$DSH_BIN" --profile web --dump-config > "$ROOT/removed.txt"
if grep -q 'dsh-wechat' "$ROOT/removed.txt"; then
  echo "dsh-wechat row still present after removal" >&2
  exit 1
fi
echo "OK: the row is gone and the profile is back to its baseline shape"

printf '\nresult: {"status":"passed","dsh":"%s","tarball":"%s","install":true,"composition":true,"uninstall":true,"disposableProfile":true,"booted":false}\n' \
  "$("$DSH_BIN" --version 2>/dev/null | head -1)" "$(basename "$TARBALL")"
