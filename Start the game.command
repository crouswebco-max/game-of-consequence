#!/bin/bash
# Double-click this to run the game. Nothing to install beyond Node.
cd "$(dirname "$0")" || exit 1

# Node can live in a few places depending on how it was installed, and a
# double-clicked script does not get the PATH a Terminal window would.
for p in /opt/homebrew/bin /usr/local/bin /usr/bin "$HOME/.homebrew/bin" "$HOME/.npm-global/bin"; do
  [ -x "$p/node" ] && export PATH="$p:$PATH" && break
done

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node is not installed, and the game needs it."
  echo ""
  echo "  Install it from https://nodejs.org (the green LTS button),"
  echo "  then double-click this file again."
  echo ""
  read -r -p "  Press return to close. "
  exit 1
fi

PORT=7373
# If an older copy of the game is still running, stop it so this one can start.
OLD=$(lsof -ti tcp:$PORT 2>/dev/null)
if [ -n "$OLD" ]; then
  echo "  Closing a game that was already running..."
  kill $OLD 2>/dev/null; sleep 1
  OLD=$(lsof -ti tcp:$PORT 2>/dev/null); [ -n "$OLD" ] && kill -9 $OLD 2>/dev/null
fi
# Files downloaded from a browser get flagged by macOS; clear it for this folder.
xattr -dr com.apple.quarantine . 2>/dev/null
echo ""
echo "  Starting up. The projector window will open by itself."
echo "  Leave this window alone while you play — closing it ends the game."
echo ""

# Give the server a moment to bind before opening the page.
( sleep 1.5; open "http://localhost:$PORT/" ) &

node server.js "$PORT"
