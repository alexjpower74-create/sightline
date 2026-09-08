# Sightline.app

A native macOS window, because a browser tab is not an application. It sits among thirty other
tabs, advertises `127.0.0.1` in an address bar, and closing the wrong one kills it.

`./install.sh` compiles `src/main.swift` and builds the bundle into `~/Applications`.
Requires the Xcode command line tools (`swiftc`).

## What it is

A WKWebView in a real window with its own menu bar and Dock icon, wrapped around the local server.
The window owns the server's lifetime: launching starts it, quitting stops it. Nothing is left
running that nobody can see.

- **No title bar, but it drags.** The page states its own name and keeps clear of the traffic
  lights via a `native` class injected before first paint. A borderless window has nothing to grab,
  so there is a real `NSView` drag strip across the top 92pt whose `mouseDown` calls
  `performDrag`, plus `isMovableByWindowBackground`. Double-clicking it zooms or minimises,
  following the system setting, the way a title bar does.

  CSS `-webkit-app-region: drag` does **nothing** in WKWebView — it is an Electron feature. Writing
  it produced a window that could not be moved at all, and nobody noticed because a screenshot
  cannot tell you whether a window drags. Drag it before calling it done.
- **A real Edit menu.** Not decoration: a web view without one silently refuses Cmd-V, and
  dictation tools paste through the same path — so a text field that looks fine is unusable.
- **PDFs open in whatever you already use for PDFs.** A `target="_blank"` link has nowhere to go in
  a single-window app, and Preview is nicer than a second web view for something you will print.
- **View → Reports Folder** opens `~/Documents/Sightline`.
- Already running? Launching again just shows the window rather than starting a second server.

## Verified by driving it

Typed an address, clicked Audit it, watched a real audit come back at 73/100, opened the report
inside the window, quit the app, confirmed the server died with it. Dragged the window by its top
strip and watched it move. Hovered the traffic lights through the strip and watched them light up.
Typed into a field below it afterwards, in case the strip had stolen the focus.

Every one of those is a thing a screenshot would have told me was fine.
