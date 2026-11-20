#!/usr/bin/env bash
# Installs or updates browzat (Browser MCP) on Linux. Safe to run again after every change or git pull.
#   ./install.sh [--dir <folder>] [--pair] [--no-claude]
# It copies the files to the install folder, installs the one dependency, builds the extension, registers the
# MCP server in Claude Code, restarts the relay and tells already-loaded extensions to reload themselves.
# Loading the extension into a browser profile for the first time stays a manual step (the script prints it).
#
# The default folder is not hidden on purpose: Snap and Flatpak browsers cannot read hidden folders in $HOME.
set -euo pipefail

DIR="$HOME/browser-mcp"
PAIR=0
CLAUDE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --pair) PAIR=1; shift ;;
    --no-claude) CLAUDE=0; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { echo "[browser-mcp] $*"; }
fail() { echo "[browser-mcp] ERROR: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js 20 or newer is required (https://nodejs.org). Install it and run this again."
MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$MAJOR" -ge 20 ] || fail "Node.js 20 or newer is required; found $(node --version)."
command -v npm >/dev/null 2>&1 || fail "npm is required (it comes with Node.js)."

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"

if [ "$SRC" != "$DIR" ]; then
  for d in server extension test; do
    rm -rf "${DIR:?}/$d"
    cp -R "$SRC/$d" "$DIR/$d"
  done
  for f in package.json package-lock.json README.md; do
    if [ -f "$SRC/$f" ]; then cp "$SRC/$f" "$DIR/$f"; fi
  done
  say "files copied to $DIR"
else
  say "installing in place: $DIR"
fi

cd "$DIR"
npm install --omit=dev --no-audit --no-fund || fail "npm install failed."
node extension/build.js || fail "building the extension failed."

if [ "$CLAUDE" -eq 1 ]; then
  if command -v claude >/dev/null 2>&1; then
    claude mcp remove browser-mcp -s user >/dev/null 2>&1 || true
    claude mcp add --scope user browser-mcp -- node "$DIR/server/mcp.js" || fail "registering the MCP server in Claude Code failed."
    say 'registered in Claude Code as "browser-mcp" (restart Claude Code to see the tools)'
  else
    say "Claude Code CLI not found; register it in your MCP client yourself:"
    say "  command: node   args: $DIR/server/mcp.js"
  fi
fi

# Restart the relay on the new code, then let already-loaded extensions pick up the new build.
node server/cli.js stop >/dev/null 2>&1 || true
node server/cli.js start || fail "the relay did not start."
sleep 8
node server/cli.js reload all || true
sleep 5
node server/cli.js status || true

echo
say "Done. For each browser profile that does not have the extension yet:"
say "  Chrome / Edge: chrome://extensions or edge://extensions -> Developer mode on -> Load unpacked -> $DIR/dist/chromium"
say "  Firefox:       about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> $DIR/dist/firefox/manifest.json"
say "Then pair them:  node \"$DIR/server/cli.js\" pair --open firefox,edge,chrome"

if [ "$PAIR" -eq 1 ]; then
  node server/cli.js pair --open firefox,edge,chrome
fi
