#!/bin/bash
# Sightline, launched from the icon rather than a terminal.
#
# Starts the local server, opens the page, and exits when the page goes away — so closing the tab
# is the off-switch, and there is never a process left running that nobody knows about.

PORT=5177
REPO="${SIGHTLINE_REPO:-$HOME/Projects/Sightline}"

# Node is not on PATH for a GUI-launched app; find it where it actually lives.
for p in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin"; do
  [ -x "$p/node" ] && export PATH="$p:$PATH" && break
done

if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "Sightline needs Node" message "Node.js was not found on this Mac. Sightline cannot start without it."' 
  exit 1
fi
if [ ! -d "$REPO" ]; then
  osascript -e "display alert \"Sightline is not where it expected\" message \"Could not find the project at:\n$REPO\""
  exit 1
fi

# Already running? Just bring the page back rather than starting a second one.
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/alive"; then
  open "http://127.0.0.1:$PORT/"
  exit 0
fi

cd "$REPO" || exit 1
node bin/sightline.js serve --port "$PORT" --exit-when-idle --no-open >/tmp/sightline-app.log 2>&1 &
SERVER=$!

for _ in $(seq 1 40); do
  curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/api/alive" && break
  sleep 0.25
done

if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/alive"; then
  osascript -e 'display alert "Sightline could not start" message "See /tmp/sightline-app.log for the reason."'
  exit 1
fi

open "http://127.0.0.1:$PORT/"
wait $SERVER
