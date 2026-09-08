# Sightline.app

A native macOS window, because a browser tab is not an application. It sits among thirty other
tabs, advertises `127.0.0.1` in an address bar, and closing the wrong one kills it.

`./install.sh` compiles `src/main.swift` and builds the bundle into `~/Applications`.
Requires the Xcode command line tools (`swiftc`).

## What it is

A WKWebView in a real window with its own menu bar and Dock icon, wrapped around the local server.
The window owns the server's lifetime: launching starts it, quitting stops it. Nothing is left
running that nobody can see.

- **No title bar** — the page states its own name, and the header keeps clear of the traffic
  lights via a `native` class the app injects before first paint.
- **A real Edit menu.** Not decoration: a web view without one silently refuses Cmd-V, and
  dictation tools paste through the same path — so a text field that looks fine is unusable.
- **PDFs open in whatever you already use for PDFs.** A `target="_blank"` link has nowhere to go in
  a single-window app, and Preview is nicer than a second web view for something you will print.
- **View → Reports Folder** opens `~/Documents/Sightline`.
- Already running? Launching again just shows the window rather than starting a second server.

## Verified by driving it

Typed an address, clicked Audit it, watched a real audit come back at 73/100, opened the report
inside the window, quit the app, confirmed the server died with it. The typing check is the one
that mattered — WebKit text fields fail in ways Chrome never shows you.
