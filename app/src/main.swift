// Sightline — a native macOS window around the local app.
//
// A browser tab is not an application. It sits among thirty other tabs, it has an address bar
// advertising 127.0.0.1, and closing the wrong one kills it. This owns its own window, its own
// menu bar, and the lifetime of the server behind it: quit the app and the server goes with it.

import AppKit
import WebKit

let PORT = 5177

// MARK: - The server this window is a face for

final class Server {
    private var process: Process?

    /// Where the code lives. Overridable, but it should just work on the machine it was built for.
    static func repoPath() -> String {
        if let env = ProcessInfo.processInfo.environment["SIGHTLINE_REPO"] { return env }
        return NSHomeDirectory() + "/Projects/Sightline"
    }

    /// A GUI-launched app inherits almost no PATH, so node has to be found where it actually is.
    static func nodePath() -> String? {
        let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", NSHomeDirectory() + "/.local/bin/node"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    func alreadyRunning(completion: @escaping (Bool) -> Void) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(PORT)/api/alive")!)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { data, _, _ in
            completion(data != nil)
        }.resume()
    }

    func start() throws {
        guard let node = Server.nodePath() else { throw Failure.noNode }
        let repo = Server.repoPath()
        guard FileManager.default.fileExists(atPath: repo + "/bin/sightline.js") else { throw Failure.noRepo(repo) }

        let p = Process()
        // `exec` so this process IS node, rather than a shell holding node as a child that
        // outlives a SIGTERM sent to the shell.
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-lc", "exec '\(node)' bin/sightline.js serve --port \(PORT) --no-open"]
        p.currentDirectoryURL = URL(fileURLWithPath: repo)
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        process = p
    }

    func stop() {
        guard let p = process, p.isRunning else { return }
        p.terminate()
        // Give it a moment to close its listener, then make sure.
        let deadline = Date().addingTimeInterval(2)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    }

    /// Poll until the server answers. Connection-refused returns instantly, so this must be paced
    /// by elapsed time rather than by a count of attempts — thirty tries can finish in 50ms and
    /// prove nothing.
    func waitUntilReady(timeout: TimeInterval, completion: @escaping (Bool) -> Void) {
        let deadline = Date().addingTimeInterval(timeout)
        func poll() {
            var req = URLRequest(url: URL(string: "http://127.0.0.1:\(PORT)/api/alive")!)
            req.timeoutInterval = 1
            URLSession.shared.dataTask(with: req) { data, _, _ in
                if data != nil { DispatchQueue.main.async { completion(true) }; return }
                if Date() > deadline { DispatchQueue.main.async { completion(false) }; return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { poll() }
            }.resume()
        }
        poll()
    }

    enum Failure: LocalizedError {
        case noNode, noRepo(String)
        var errorDescription: String? {
            switch self {
            case .noNode: return "Node.js was not found on this Mac. Sightline cannot start without it."
            case .noRepo(let p): return "Could not find Sightline's code at:\n\(p)"
            }
        }
    }
}

// MARK: - Drag strip

/// A borderless window has no title bar to grab, so the drag region has to be built.
///
/// CSS `-webkit-app-region: drag` is an Electron feature and does nothing in WKWebView — writing
/// it produced a window that could not be moved at all, which nobody noticed because looking at a
/// screenshot cannot tell you whether a window drags.
///
/// This sits over the page's own header, which has nothing clickable in it. The traffic lights
/// live in the window's title bar layer, above the content view, so they keep working.
final class DragStrip: NSView {
    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
    // Double-click a title bar and macOS zooms or minimises, depending on the system setting.
    override func mouseUp(with event: NSEvent) {
        guard event.clickCount == 2 else { return super.mouseUp(with: event) }
        switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
        case "Minimize": window?.miniaturize(nil)
        case "None":     break
        default:         window?.zoom(nil)
        }
    }
}

// MARK: - Window

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    let server = Server()
    var window: NSWindow!
    var web: WKWebView!
    var status: NSTextField!

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        buildWindow()

        server.alreadyRunning { [weak self] running in
            DispatchQueue.main.async {
                guard let self else { return }
                if running { self.load(); return }
                do { try self.server.start() } catch { self.fail(error.localizedDescription); return }
                self.server.waitUntilReady(timeout: 20) { ok in
                    ok ? self.load() : self.fail("Sightline's server did not start.")
                }
            }
        }
    }

    func applicationWillTerminate(_ note: Notification) { server.stop() }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = ""   // the page states its own name; two would just collide
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 720, height: 560)
        window.setFrameAutosaveName("SightlineMain")
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(red: 0.055, green: 0.067, blue: 0.086, alpha: 1) // matches the page

        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        // The window has no title bar of its own, so the page needs to know to keep clear of the
        // traffic lights. One class, applied before the first paint.
        let markNative = WKUserScript(
            source: "document.documentElement.classList.add('native')",
            injectionTime: .atDocumentStart, forMainFrameOnly: true)
        config.userContentController.addUserScript(markNative)
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        web.autoresizingMask = [.width, .height]
        web.allowsBackForwardNavigationGestures = false

        status = NSTextField(labelWithString: "Starting Sightline…")
        status.font = .systemFont(ofSize: 13)
        status.textColor = NSColor(white: 0.55, alpha: 1)
        status.alignment = .center

        let content = NSView(frame: window.contentLayoutRect)
        content.autoresizingMask = [.width, .height]
        web.frame = content.bounds
        content.addSubview(web)

        // Across the top, over the page header. 92pt is the header's height in the page's own CSS
        // (44 top padding for the traffic lights + 26 + the line itself).
        let drag = DragStrip(frame: NSRect(x: 0, y: content.bounds.height - 92,
                                           width: content.bounds.width, height: 92))
        drag.autoresizingMask = [.width, .minYMargin]
        content.addSubview(drag)

        content.addSubview(status)
        status.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            status.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            status.centerYAnchor.constraint(equalTo: content.centerYAnchor)
        ])
        web.isHidden = true

        window.contentView = content
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func load() {
        status.stringValue = ""
        web.isHidden = false
        web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(PORT)/")!))
    }

    private func fail(_ message: String) {
        status.stringValue = message
        let alert = NSAlert()
        alert.messageText = "Sightline could not start"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.runModal()
        NSApp.terminate(nil)
    }

    // A report opened with target="_blank" has nowhere to go in a single-window app. PDFs go to
    // whatever the person already uses for PDFs, which is nicer than a second web view anyway.
    func webView(_ webView: WKWebView, createWebViewWith config: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        status.stringValue = "Could not load Sightline: \(error.localizedDescription)"
        web.isHidden = true
    }

    // MARK: Menu
    //
    // A web view with no Edit menu silently refuses Cmd-V, and dictation tools paste through the
    // same path — so a text field that looks fine is simply unusable. This is not decoration.
    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Sightline", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Sightline", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Sightline", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Reports Folder", action: #selector(openReports), keyEquivalent: "")
        viewItem.submenu = view
        main.addItem(viewItem)

        NSApp.mainMenu = main
    }

    @objc private func reload() { web.reload() }
    @objc private func openReports() {
        NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory() + "/Documents/Sightline"))
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
