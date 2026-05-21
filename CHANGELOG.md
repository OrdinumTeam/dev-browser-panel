# Changelog

## [0.2.0] - 2026-05-21

### Added
- **Per-instance isolation**: each VS Code window now gets its own Chromium with its own profile (cookies/localStorage isolated). Profile dir is `<workspace>/.dev-browser-panel/chromium-profile/`.
- **Automatic port allocation**: panel tries `cdpPort` (default 9333) first; if busy, scans the next 50 ports. Opening the panel in multiple VS Code windows just works — no more `EADDRINUSE`.
- **Workspace-local port file**: each project gets its own `.dev-browser-panel/port`, so terminals in that project auto-discover the right browser via `cat .dev-browser-panel/port`. The global `~/.dev-browser-panel/port` still exists as a "most-recently-opened" pointer (plus `last-workspace`).
- **Browser Logs panel — Network tab**:
  - Tab toggle (All / Console / Network).
  - Network entries with method badge, color-coded status, MIME type, duration, size.
  - **Copy HAR** button: exports captured network as HAR 1.2 (headers + response bodies) to clipboard. Memory-capped (256KB per body, 30MB total budget in webview).

### Changed
- Status bar now shows the **actual allocated port**, which may differ from `devBrowserPanel.cdpPort` if it was busy.

### Notes
- Add `.dev-browser-panel/` to your project's `.gitignore` to keep the browser profile and port file out of commits.

## [0.1.0] - 2026-05-21

### Added
- Embedded Chromium via Chrome DevTools Protocol (CDP) screencast into a VS Code WebviewPanel.
- Viewer panel with toolbar (back, forward, reload, URL bar, new tab), tab strip, and canvas rendering.
- Logs panel (browser console output) in the panel area with filter, clear, and pause/resume.
- Multi-tab support: create, switch, and close tabs via CDP `Target.*` domain.
- Autoreload: `FileSystemWatcher` with debounce triggers `Page.reload` on active tab when workspace files change.
- Port file at `~/.dev-browser-panel/port` for auto-discovery by `dev-browser` CLI and other CDP clients.
- Status bar item showing browser port and on/off state.
- Six commands: `Open`, `New Tab`, `Reload Current Tab`, `Toggle Autoreload`, `Show Logs`, `Stop Chromium`.
- Auto-detects Playwright's `chrome-headless-shell` binary (cross-platform).
- Configuration via `devBrowserPanel.*` settings.
