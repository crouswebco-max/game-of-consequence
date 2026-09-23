#!/bin/bash
# Double-click to host a game your friends can join from anywhere — their own
# mobile data, a different house, anywhere. Opens a secure public link (a
# "tunnel") to this Mac, and the QR code on the projector points at it.
cd "$(dirname "$0")" || exit 1

for p in /opt/homebrew/bin /usr/local/bin /usr/bin "$HOME/.homebrew/bin" "$HOME/.npm-global/bin"; do
  [ -d "$p" ] && export PATH="$p:$PATH"
done

if ! command -v node >/dev/null 2>&1; then
  echo ""; echo "  Node is not installed. Get it from https://nodejs.org, then try again."; echo ""
  read -r -p "  Press return to close. "; exit 1
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
LOG="$(mktemp -t consequence-tunnel)"
URL=""
TUNNEL_PID=""
cleanup() { [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null; rm -f "$LOG"; }
trap cleanup EXIT INT TERM

echo ""
echo "  Opening a public link for your friends..."

if command -v cloudflared >/dev/null 2>&1; then
  # Cloudflare's free quick tunnel: no account, no warning page for guests.
  cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$LOG" 2>&1 &
  TUNNEL_PID=$!
  for i in $(seq 1 40); do
    URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" | head -1)
    [ -n "$URL" ] && break; sleep 0.5
  done
elif command -v ngrok >/dev/null 2>&1; then
  ngrok http "$PORT" --log=stdout >"$LOG" 2>&1 &
  TUNNEL_PID=$!
  for i in $(seq 1 40); do
    URL=$(curl -s http://127.0.0.1:4040/api/tunnels | grep -o '"public_url":"https://[^"]*"' | head -1 | cut -d'"' -f4)
    [ -n "$URL" ] && break; sleep 0.5
  done
else
  echo ""
  echo "  To play online you need a free tunnel tool. The easiest:"
  echo ""
  echo "      brew install cloudflared"
  echo ""
  echo "  Paste that into Terminal, then double-click this file again."
  echo "  (Or use 'Start the game' to play on your own Wi-Fi.)"
  echo ""
  read -r -p "  Press return to close. "; exit 1
fi

if [ -z "$URL" ]; then
  echo ""; echo "  The public link did not come up. Details:"; echo ""; tail -n 15 "$LOG"; echo ""
  read -r -p "  Press return to close. "; exit 1
fi

echo ""
echo "  Friends join at:  $URL/join"
echo "  (The QR code on the projector points there too.)"
echo ""
echo "  Leave this window open while you play — closing it ends the game."
echo ""

( sleep 1.5; open "http://localhost:$PORT/" ) &
CONSEQUENCE_PUBLIC_URL="$URL" node server.js "$PORT"
