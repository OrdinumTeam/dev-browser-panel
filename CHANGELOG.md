# Changelog

## [0.5.0] - 2026-06-11

Hardening release: the embedded browser no longer freezes, loses its window, or
fights other VS Code windows — and the basics (Enter, copy/paste, back/forward,
reload) now behave like a real Chrome.

### Fixed — basic functionality
- **Enter now works inside pages**: form submit and textarea newlines were dead because `keyDown` was sent without `text: '\r'` (no `keypress` synthesized). Verified against real Chromium.
- **Cmd/Ctrl+A selects all** — plain key events do nothing in headless Chromium; now sent with `commands: ["selectAll"]`.
- **Copy covers `<input>`/`<textarea>` selections** (`window.getSelection()` misses them); added **Cut** (Cmd/Ctrl+X).
- **Screenshot toolbar button and context-menu "View Source"/"Inspect Element" were dead** — the webview's `command` message was never handled by the extension.
- **URL bar updates live** when you click links or the page uses pushState (`Page.frameNavigated` + `Page.navigatedWithinDocument`).
- **Back/Forward use real navigation history** (`Page.getNavigationHistory`/`navigateToHistoryEntry`) instead of `history.back()` injection; buttons enable/disable from actual history state.
- **Downloads actually register**: migrated to `Browser.setDownloadBehavior` + `Browser.download*` events (the `Page.*` variants were removed from modern Chromium).
- **Element inspector**: `DOM.enable` before `Overlay.enable` (it errored without it); clicking an element now opens its outer HTML beside the editor.
- **Mobile emulation survives panel resizes** (viewport messages no longer stomp the preset); frames are letterboxed aspect-correct instead of stretched, and mouse coordinates map through the page's real CSS size from screencast metadata.
- **New tab becomes the active tab** (Chrome behavior).
- **Double-click no longer sends a stray extra mousePressed**; `clickCount` comes from `e.detail` (double/triple-click selection works).
- **Drag text selection** works: `mousemove` now carries the `buttons` bitmask.

### Added — resilience ("blindado")
- **JS dialogs can no longer freeze a tab**: `alert`/`beforeunload` are auto-accepted; `confirm`/`prompt` surface as VS Code dialogs, with a 60 s fallback answer if ignored. Unanswered dialogs were permanently hanging the page.
- **Crash recovery**: `Inspector.targetCrashed` → in-panel overlay + "Reload Tab" (also as a toast).
- **Chromium death / CDP disconnect detected**: status bar goes OFF, the viewer shows a "Restart Browser" overlay, port/owner files are cleaned up. The panel rebinds to the new session in place — no need to close/reopen it.
- **Closing the last tab opens a fresh one** instead of leaving a dead browser.
- **Orphaned Chromium processes are reaped**: if a previous extension host died without cleanup, its Chromium is detected (profile-verified) and killed on next start.
- **Same workspace in two VS Code windows no longer collides**: profile claiming with owner files; the second window gets `chromium-profile-2` instead of dying on Chromium's ProcessSingleton lock.
- **Global `~/.dev-browser-panel/port` is now first-window-wins** (with stale-owner takeover): external agents/CLIs are no longer silently re-pointed at a different window mid-session. Per-workspace `.dev-browser-panel/port` remains the precise pointer.
- **CDP calls carry a 30 s timeout** (120 s for screenshot/PDF) — no permanently hung awaits.
- **Session restore**: tabs from the previous session reopen on start (`devBrowserPanel.restoreTabs`, default `true`).

### Added — Chrome-like UX
- **Keyboard shortcuts in the viewer**: Cmd/Ctrl+R and F5 reload (Shift = hard reload), Cmd/Ctrl+L focus address bar, Cmd/Ctrl+T new tab, Cmd/Ctrl+W close tab, Alt+←/→ and Cmd/Ctrl+[/] history, Cmd/Ctrl+C/X/V/A clipboard, Esc stops loading, Cmd/Ctrl+=/−/0 zoom (also Cmd/Ctrl+wheel).
- **Zoom** with Chrome's ladder (25%–300%) and a toolbar chip (click to reset).
- **Reload button turns into Stop (✕) while loading.**
- **Context menu**: Open Link in New Tab, Copy Link Address (via VS Code clipboard — the webview clipboard API is sandboxed), Cut, Select All.
- **Middle-click closes tabs**; blank tabs focus the address bar; Esc in the URL bar restores the current URL.
- Smarter URL detection: `localhost:3000`, bare IPs, `host:port`, any `.tld` path.
- New commands: `Dev Browser Panel: Go Back` / `Go Forward`.
- Status bar tooltip shows port, profile path and the CLI connect hint.
- View Source / inspected node open as untitled editors (no temp-file litter); screenshot/PDF dialogs default to a timestamped name in the workspace.

### Internal
- `scripts/smoke-session.js`: integration smoke test against real headless Chromium (29 checks: lifecycle, history, dialogs, last-tab guard, multi-instance isolation, orphan reaping, crash detection, clean stop).

## [0.4.0] - 2026-05-22

### Added
- Find in page (Cmd+F / Ctrl+F) with match counter and navigation
- Smart address bar: auto-detects URLs vs search queries, configurable search engine (`google`/`duckduckgo`/`bing`)
- Loading progress bar (3 px) and smooth animation
- Right-click context menu with Back/Forward/Reload/Copy/Paste/View source/Inspect
- Download manager (`devBrowserPanel.showDownloads`) with notifications and downloads panel
- Mobile emulation (`devBrowserPanel.toggleMobileEmulation`): Desktop / iPhone 15 Pro / iPad Pro / Galaxy S24 cycle with mobile indicator in toolbar
- View source (`devBrowserPanel.viewSource`) — opens document HTML in VS Code editor tab
- Take Screenshot (`devBrowserPanel.takeScreenshot`) — PNG, save dialog
- Take Full Page Screenshot (`devBrowserPanel.takeFullPageScreenshot`) — captureBeyondViewport
- Save as PDF (`devBrowserPanel.printToPDF`) — Page.printToPDF with background
- Element inspector mode (`devBrowserPanel.inspectElement`) — Overlay.setInspectMode highlight
- Storage editor (`devBrowserPanel.showStorage`) — Cookies, LocalStorage, SessionStorage tabs
- System clipboard integration: Cmd+C copy, Cmd+V paste via CDP
- Render diagnostics panel (`devBrowserPanel.showRenderDiagnostics`) — DPR, canvas size, frame size, format, mobile preset
- `devBrowserPanel.autoOpenLogs` setting (default `false`) — opt-in logs auto-focus
- `devBrowserPanel.searchEngine` setting — enum `google`/`duckduckgo`/`bing`
- `devBrowserPanel.downloadPath` setting — custom download directory
- `image-rendering: -webkit-optimize-contrast` on canvas for fractional-DPR sharpness
- Frame size mismatch warning in browser console (deduplicated)
- `Page.frameStartedLoading` / `Page.frameStoppedLoading` drive the loading bar in the webview

### Fixed
- `devBrowserPanel.open` no longer force-opens the Logs panel (requires `autoOpenLogs: true`)
- Screencast now deferred until viewport dimensions are known (avoids initial wrong-resolution frame)

## [0.3.0] - 2026-05-21

### Added
- **`devBrowserPanel.screencastFormat`** setting — `"jpeg"` (default, fast) or `"png"` (lossless, slower). PNG gives pixel-perfect rendering at the cost of FPS (5-15 fps on heavy pages versus 30-60 fps with JPEG).
- **`devBrowserPanel.screencastQuality`** setting — JPEG quality 1-100, default raised to `95` (was hard-coded `90`). Set to `100` for max-quality JPEG, or use `"png"` for true lossless.

### Changed
- Default JPEG quality bumped from `90` to `95` — near-lossless to the eye, marginal FPS impact.
- Frame payload now carries the format mime so the webview decodes correctly regardless of jpeg/png choice.

## [0.2.2] - 2026-05-21

### Fixed
- **Blurry viewer rendering** on Retina/HiDPI displays. Three changes combined:
  1. JPEG quality bumped from 70 → 90 (less compression artifacts on text).
  2. Canvas backing store now matches `devicePixelRatio` instead of CSS pixels — on Retina (DPR=2), a 1280×800 canvas now has a 2560×1600 backing store, displayed 1:1 with no upscale.
  3. `Emulation.setDeviceMetricsOverride` now passes the real DPR (was hard-coded to 1), so Chromium renders the page at the same resolution the canvas can display. Screencast restarts with matching `maxWidth`/`maxHeight` when the viewport changes by more than 50px.

## [0.2.1] - 2026-05-21

### Fixed
- **Double-typing bug** in the browser viewer: characters typed into focused
  inputs (URL bar, forms, etc.) were duplicated (`aa` instead of `a`). Caused
  by `Input.dispatchKeyEvent` sending both a `keyDown` with non-empty `text`
  AND a follow-up `char` event — Chromium synthesizes the char internally
  from `keyDown` with text, so the explicit `char` event was a redundant
  insert. Now uses the canonical Puppeteer/Playwright pattern: `rawKeyDown`
  (no text) + `char` for printable keys, `keyDown` only for non-printable.

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
