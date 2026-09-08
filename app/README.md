# Sightline.app

A double-clickable launcher, because the person this was built for does not use a terminal and a
tool you cannot start is not a tool.

`./install.sh` builds the bundle into `~/Applications`.

## How it behaves

Double-click and it starts the local server, waits for it to answer, and opens the page in the
default browser. **Closing the tab stops it.** The page holds the server open with a heartbeat and
the server exits about 25 seconds after the last one — so the off-switch is the one a person
already knows, and there is never a process left running that nobody can see.

Launch it again while it is already running and it brings the page back rather than starting a
second copy.

It is a background app (`LSUIElement`), so it does not bounce in the Dock or add a menu bar. The
browser tab is the whole interface.

`SIGHTLINE_REPO` overrides where it looks for the code, if the repo is not at
`~/Projects/Sightline`.

## If it does not start

It shows an alert naming the reason — no Node on the machine, or the repo not where it expected.
Anything else lands in `/tmp/sightline-app.log`.
