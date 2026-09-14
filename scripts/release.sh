#!/usr/bin/env bash
# Release Snipcode in one command: preflight -> tag -> wait for CI -> poll the
# VS Code Marketplace until the new version is really live.
#
# `vsce publish` succeeding is NOT the release being done: the Marketplace
# verifies and indexes the upload 5-8 minutes later. This script is the whole
# reason nobody has to remember that -- it exits 0 only once the version is
# actually queryable and the VSIX actually downloads.
#
# Prints exactly ONE line to stdout:
#
#     OK v0.3.48 live: https://marketplace.visualstudio.com/items?itemName=...
#     FAIL: <reason>
#
# Everything else goes to stderr. CI runs npm test + e2e before publishing, so
# a red run means the tests failed and nothing shipped.
set -euo pipefail

cd "$(dirname "$0")/.."
V="${1:-}"
EXT="audichuang.clipcode-vscode"
say() { printf '%s\n' "$*" >&2; }
die() { printf 'FAIL: %s\n' "$*"; exit 1; }

[ -n "$V" ] || die "usage: scripts/release.sh <version>, e.g. 0.3.48"

# Version the Marketplace currently serves, or empty if it cannot be read.
live_version() {
    curl -s --max-time 20 -X POST 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery' \
        -H 'Accept: application/json;api-version=7.2-preview.1' \
        -H 'Content-Type: application/json' \
        -d "{\"filters\":[{\"criteria\":[{\"filterType\":7,\"value\":\"$EXT\"}],\"pageSize\":1,\"pageNumber\":1}],\"flags\":950}" \
        2>/dev/null \
    | python3 -c 'import sys,json
try:
    e = json.load(sys.stdin)["results"][0]["extensions"]
    print(e[0]["versions"][0]["version"] if e else "")
except Exception:
    print("")' 2>/dev/null || true
}

# --- preflight: refuse rather than ship something half-prepared --------------
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "not on main"
git diff-index --quiet HEAD -- || die "working tree is dirty -- commit or stash first"
git fetch --quiet origin main --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main and origin/main differ -- push or pull first"

[ "$(node -p 'require("./package.json").version')" = "$V" ] || die "package.json version is not $V"
# npm ci does not check the version field, so a stale lockfile ships silently.
[ "$(node -p 'const l=require("./package-lock.json"); l.packages[""].version || l.version')" = "$V" ] \
    || die "package-lock.json version is not $V -- run 'npm install --package-lock-only' after bumping"

if git rev-parse -q --verify "refs/tags/v$V" >/dev/null; then die "tag v$V already exists locally"; fi
if git ls-remote --exit-code --tags origin "refs/tags/v$V" >/dev/null 2>&1; then die "tag v$V already exists on origin"; fi
[ "$(live_version)" != "$V" ] || die "the Marketplace already serves $V"

# --- ship --------------------------------------------------------------------
say "# tagging v$V and pushing"
git tag "v$V"
git push --quiet origin "v$V"

say "# waiting for the Publish Extension workflow"
run=""
for _ in $(seq 12); do
    run=$(gh run list --workflow "Publish Extension" --branch "v$V" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
    if [ -n "$run" ]; then break; fi
    sleep 5
done
[ -n "$run" ] || die "no workflow run appeared for v$V within 60s -- check GitHub Actions"
gh run watch "$run" --exit-status >&2 || die "Publish workflow failed -- gh run view $run --log-failed"

# --- the only thing that counts: is it actually on the Marketplace? ----------
say "# polling the Marketplace (indexing usually takes 5-8 min, giving up at 12)"
for _ in $(seq 24); do
    if [ "$(live_version)" = "$V" ]; then break; fi
    sleep 30
done
[ "$(live_version)" = "$V" ] || die "CI published but the Marketplace still does not serve $V after 12 min"

code=$(curl -sL -o /dev/null -w '%{http_code}' --max-time 60 \
    "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${EXT%%.*}/vsextensions/${EXT#*.}/$V/vspackage")
[ "$code" = "200" ] || die "Marketplace lists $V but the VSIX download returned HTTP $code"

printf 'OK v%s live: https://marketplace.visualstudio.com/items?itemName=%s\n' "$V" "$EXT"
