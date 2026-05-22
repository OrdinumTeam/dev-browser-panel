# Changelog

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
