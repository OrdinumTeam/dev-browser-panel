# Changelog

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
