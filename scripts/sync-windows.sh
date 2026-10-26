#!/usr/bin/env bash
# Push the plugin runtime files to the Windows machine over SSH and verify them by SHA-256.
#
#   scripts/sync-windows.sh           overwrite the remote copy, then verify every file
#   scripts/sync-windows.sh --check   only compare (exit 1 when the remote differs)
#   scripts/sync-windows.sh --backup  copy the old remote directory to <WIN_DIR>\..\backups\ first
#
# What is pushed is exactly `package.json` plus the entries of its "files" list, so the Windows copy never gets
# tests, sources or notes. Nothing else on the remote is deleted. DSH has to be restarted on the Windows machine
# for the new files to take effect.
#
# Overrides: WIN_HOST (ssh alias, default "win"), WIN_DIR (default C:\dsh-plugins\dsh-cost-meter).
set -euo pipefail

WIN_HOST="${WIN_HOST:-win}"
WIN_DIR="${WIN_DIR:-C:\\dsh-plugins\\dsh-cost-meter}"
MODE="sync"
BACKUP_FIRST=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --backup) BACKUP_FIRST=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
SOCK="$(mktemp -u "${TMPDIR:-/tmp}/cm-sync.XXXXXX")"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/cm-stage.XXXXXX")"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ControlMaster=auto -o "ControlPath=$SOCK" -o ControlPersist=60)
# Queries run with -n: inside the `while read` loops below ssh would otherwise swallow the file list from stdin.
SSH=(ssh -n "${SSH_OPTS[@]}" "$WIN_HOST")
SSH_STREAM=(ssh "${SSH_OPTS[@]}" "$WIN_HOST")
cleanup() { ssh -O exit -o "ControlPath=$SOCK" "$WIN_HOST" >/dev/null 2>&1 || true; rm -rf "$STAGE" "$SOCK"; }
trap cleanup EXIT

# Never push a stale generated client.js.
node scripts/build-client.mjs --check >/dev/null || { echo "client.js is stale: run npm run build first" >&2; exit 2; }

# Stage package.json + the "files" entries ("dir/*.ext" patterns are expanded one level).
node -e '
const fs = require("fs"), path = require("path")
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"))
const out = ["package.json"]
for (const entry of pkg.files) {
  const m = entry.match(/^(.*)\/\*(\.[a-z]+)$/)
  if (m) fs.readdirSync(m[1]).filter((f) => f.endsWith(m[2])).forEach((f) => out.push(m[1] + "/" + f))
  else out.push(entry)
}
process.stdout.write(out.join("\n") + "\n")
' > "$STAGE.list"
trap 'cleanup; rm -f "$STAGE.list"' EXIT
while IFS= read -r file; do
  [ -f "$file" ] || { echo "missing file listed for the package: $file" >&2; exit 2; }
  mkdir -p "$STAGE/$(dirname "$file")"
  cp "$file" "$STAGE/$file"
done < "$STAGE.list"

remote_version() {
  "${SSH[@]}" "cmd /c type $WIN_DIR\\package.json" 2>/dev/null | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1 | tr -d '\r'
}

# SHA-256 of a remote file (empty when the file is missing). certutil output is localised, so take the hash line.
remote_hash() {
  "${SSH[@]}" "cmd /c certutil -hashfile $WIN_DIR\\$(echo "$1" | tr / '\\') SHA256" 2>/dev/null \
    | LC_ALL=C tr -d '\r ' | LC_ALL=C grep -E '^[0-9a-fA-F]{64}$' | head -1 | LC_ALL=C tr 'A-F' 'a-f' || true
}

DIFFS=0
verify() {
  DIFFS=0
  while IFS= read -r file; do
    local want have
    want="$(shasum -a 256 "$STAGE/$file" | cut -d' ' -f1)"
    have="$(remote_hash "$file")"
    if [ "$want" = "$have" ]; then echo "  same     $file"; else echo "  DIFFERS  $file"; DIFFS=$((DIFFS + 1)); fi
  done < "$STAGE.list"
}

OLD="$(remote_version)"
NEW="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
echo "remote ${WIN_HOST}:${WIN_DIR}  version ${OLD:-unknown} (local $NEW)"

if [ "$MODE" = "check" ]; then
  verify
  [ "$DIFFS" -eq 0 ] && echo "in sync" || { echo "$DIFFS file(s) differ"; exit 1; }
  exit 0
fi

if [ "$BACKUP_FIRST" -eq 1 ]; then
  BACKUP="${WIN_DIR%\\*}\\backups\\dsh-cost-meter-${OLD:-unknown}-$(date +%Y%m%d-%H%M%S)"
  echo "backup -> $BACKUP"
  "${SSH[@]}" "cmd /c xcopy $WIN_DIR $BACKUP\\ /E /I /Y /Q" >/dev/null
fi

echo "copy ($(wc -l < "$STAGE.list" | tr -d ' ') files)"
tar -cf - -C "$STAGE" . | "${SSH_STREAM[@]}" "tar -xf - -C $WIN_DIR"

echo "verify"
verify
if [ "$DIFFS" -ne 0 ]; then echo "$DIFFS file(s) do not match after the copy" >&2; exit 1; fi
echo "done: ${OLD:-unknown} -> $NEW. Restart DeepSeek Harness on the Windows machine to load it."
