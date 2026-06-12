# Dev Browser Panel

VS Code extension that embeds a Chromium browser inside the editor, controllable via the Chrome DevTools Protocol (CDP). Built so AI agents (Claude Code, OpenAI Codex, Aider, the [`dev-browser`](https://github.com/SawyerHood/dev-browser) CLI, Playwright, Puppeteer, etc.) can drive a browser the **user sees inside VS Code** — no separate window, no flaky third-party extensions.

```
┌────────────────────────────────────────────┐
│ VS Code Window                             │
│ ┌──────────────┬────────────────────────┐  │
│ │  Logs panel  │  Chromium viewer       │  │
│ │  (console +  │  (CDP screencast)      │  │
│ │   network)   │                        │  │
│ ├──────────────┴────────────────────────┤  │
│ │ Terminal (agente rodando)             │  │
│ │ > dev-browser --connect localhost:9333│  │
│ └────────────────────────────────────────┘ │
└────────────────────────────────────────────┘
```

## What's new in v0.5.0 — hardened

This release makes the embedded browser behave like a real Chrome and survive the real world:

**Basics that now just work**
- **Enter** submits forms and inserts newlines (was silently dead inside pages)
- **Copy / Cut / Paste / Select All** (Cmd/Ctrl+C/X/V/A) — including selections inside `<input>`/`<textarea>`
- **Back / Forward** use real navigation history; buttons enable/disable correctly; URL bar updates live on link clicks and SPA navigations
- **Reload** (Cmd/Ctrl+R, F5, Shift = hard reload) and **Stop** (button turns ✕ while loading, Esc)
- **Zoom** 25%–300% (Cmd/Ctrl + / − / 0, or Cmd/Ctrl+wheel)
- Screenshot button, context-menu View Source / Inspect — previously dead — now wired

**Bulletproofing**
- `alert()` / `confirm()` / `prompt()` / `beforeunload` **never freeze a tab again** — auto-answered or surfaced as VS Code dialogs (60 s fallback)
- Chromium crash or CDP disconnect → overlay with **Restart Browser**; the panel rebinds in place
- Tab renderer crash → **Reload Tab** overlay
- Orphaned Chromium processes from killed windows are **detected and reaped**
- Closing the last tab opens a fresh one (no dead browser)
- Session restore: your tabs come back on restart (`devBrowserPanel.restoreTabs`)

**Multi-window isolation (no more cross-window interference)**
- Same workspace open in two VS Code windows: each gets its own profile (`chromium-profile`, `chromium-profile-2`, …) — no more ProcessSingleton startup failures
- `~/.dev-browser-panel/port` is now **first-window-wins** (taken over only when the owner dies), so CLIs/agents aren't silently re-pointed at another window mid-session; `<workspace>/.dev-browser-panel/port` is always the precise pointer

Full details in [CHANGELOG.md](./CHANGELOG.md).

## Keyboard shortcuts (viewer focused)

| Shortcut | Action |
|---|---|
| Cmd/Ctrl+R · F5 | Reload (Shift+ = hard reload, ignore cache) |
| Esc | Stop loading / close find & menus |
| Alt+← / Alt+→ · Cmd/Ctrl+[ / ] | Back / Forward |
| Cmd/Ctrl+L | Focus address bar |
| Cmd/Ctrl+T / Cmd/Ctrl+W | New tab / Close tab (middle-click a tab also closes) |
| Cmd/Ctrl+C / X / V / A | Copy / Cut / Paste / Select All (system clipboard) |
| Cmd/Ctrl+F | Find in page |
| Cmd/Ctrl+= / − / 0 · Cmd/Ctrl+wheel | Zoom in / out / reset |

---

## Features

- **Embedded Chromium viewer** — CDP screencast streamed into a webview canvas
- **Input forwarding** — clicks, scroll, keyboard typed in the webview are dispatched to Chromium via CDP
- **Logs panel with tabs**:
  - **Console** — `Runtime.consoleAPICalled` + `Runtime.exceptionThrown` + `Log.entryAdded`
  - **Network** — request/response with method badge, status color, MIME type, duration, size
  - **All** — unified timeline
- **Copy HAR** — one click exports captured network traffic as HAR 1.2 (headers + response bodies, importable to Chrome DevTools, Postman, har-analyzer, etc.). Memory-capped at ~35MB to keep the webview light.
- **Multi-tab** — open multiple Chromium targets, switch with tab strip
- **Autoreload** — file watcher on workspace, debounced `Page.reload` on the active tab
- **Per-instance isolation** — each VS Code window gets its own Chromium with its own profile (cookies/localStorage isolated), automatically allocated to a free port starting at `cdpPort` (default `9333`, scans next 50 if busy). Same workspace in two windows → suffixed profiles (`chromium-profile-2`, …); orphaned Chromiums from crashed windows are reaped at startup.
- **Workspace-local port file** for auto-discovery — `<workspace>/.dev-browser-panel/port` so terminals in that project pick up the right browser. A global pointer at `~/.dev-browser-panel/port` is owned by the **first** window and only taken over when that window dies — external clients are never re-pointed mid-session.
- **Resilient by design** — JS dialogs auto-handled (no frozen tabs), crash/disconnect detection with one-click restart, tab restore, CDP call timeouts.

## Quick Start

```bash
npm install
npm run compile
npm run package    # produces dev-browser-panel-0.5.0.vsix
code --install-extension dev-browser-panel-0.5.0.vsix
```

Then in VS Code: `Cmd+Shift+P` → `Dev Browser Panel: Open`.

## Commands

All available via `Cmd+Shift+P` (macOS) / `Ctrl+Shift+P` (Linux/Windows):

| Command | What it does |
|---|---|
| `Dev Browser Panel: Open` | Start Chromium, open the viewer panel |
| `Dev Browser Panel: New Tab` | Prompt for URL, open it in a new Chromium target |
| `Dev Browser Panel: Reload Current Tab` | `Page.reload` on the active target |
| `Dev Browser Panel: Go Back` / `Go Forward` | Navigate the active tab's real history |
| `Dev Browser Panel: Toggle Autoreload` | Toggle file-watcher-driven reload on/off |
| `Dev Browser Panel: Show Logs` | Reveal the Browser Logs panel |
| `Dev Browser Panel: Stop Chromium` | Kill the embedded Chromium and delete the port file |
| `Dev Browser Panel: Find in Page` | Open find-in-page overlay (Cmd+F / Ctrl+F) |
| `Dev Browser Panel: Toggle Mobile Emulation` | Cycle through Desktop / iPhone 15 Pro / iPad Pro / Galaxy S24 |
| `Dev Browser Panel: View Source` | Open active tab's HTML source in VS Code editor |
| `Dev Browser Panel: Take Screenshot` | Capture viewport as PNG (save dialog) |
| `Dev Browser Panel: Take Full Page Screenshot` | Capture full page as PNG including below fold |
| `Dev Browser Panel: Save as PDF` | Export active tab to PDF (save dialog) |
| `Dev Browser Panel: Inspect Element` | Toggle CDP Overlay element inspector |
| `Dev Browser Panel: Show Downloads` | Open downloads panel |
| `Dev Browser Panel: Show Storage` | Open storage editor (Cookies / LocalStorage / SessionStorage) |
| `Dev Browser Panel: Show Render Diagnostics` | Open render diagnostics table |

The status bar (bottom-left) shows `$(globe) Browser :<port>` when running and `$(sync~spin) Autoreload` when active.

## Using with AI agents

The extension is **agent-agnostic** — it only exposes standard CDP on a fixed port. Any tool that can run a shell command can drive the visible Chromium.

### Auto-discovery snippet (works for any agent)

Each project has its own browser, discovered via `<project>/.dev-browser-panel/port`. Most agents run with the project root as cwd, so just:

```bash
dev-browser --connect "http://localhost:$(cat .dev-browser-panel/port 2>/dev/null || cat ~/.dev-browser-panel/port)" <<'EOF'
const tabs = await browser.listPages();
const page = await browser.getPage(tabs[0].id);
await page.goto("https://example.com");
console.log(await page.title());
EOF
```

The fallback to `~/.dev-browser-panel/port` works because the first window claims a global pointer there (kept stable until that window closes). If you're not in a project root, you still hit *some* browser — but with multiple VS Code windows open, always prefer the workspace-local file.

> Add `.dev-browser-panel/` to your project's `.gitignore` — it contains the Chromium profile and shouldn't be committed.

### Teach the agent once via `dev-browser.md`

This repo ships a ready-made guide at [`dev-browser.md`](./dev-browser.md) — drop it into your project's `CLAUDE.md` (or `AGENTS.md` for Codex) so the agent knows how to use the panel without you re-explaining each session.

```bash
SRC="/path/to/dev-browser-panel/dev-browser.md"

# Append to the project's CLAUDE.md (Claude Code) — creates the file if it doesn't exist:
cat "$SRC" >> /path/to/your/project/CLAUDE.md

# Or for Codex CLI:
cat "$SRC" >> /path/to/your/project/AGENTS.md
```

> The file is named `dev-browser.md` (not `CLAUDE.md`) on purpose: Claude Code only auto-reads `CLAUDE.md`, but you may already have one with project-specific instructions. Appending keeps both. If you don't have a `CLAUDE.md` yet, `cat >> CLAUDE.md` creates one.

The content of `dev-browser.md` covers: discovering the port, driving via `dev-browser` CLI / Playwright / Puppeteer, common operations (DOM read, form fill, network capture, new tab), when to use vs. when not to, and how to prompt the operator if the panel is closed.

### Claude Code

Uses its `Bash` tool — paste the snippet above. Or for a one-liner:

```bash
dev-browser --connect http://localhost:9333 <<< 'await (await browser.getPage((await browser.listPages())[0].id)).goto("https://github.com")'
```

### OpenAI Codex CLI

Same snippet through Codex's shell tool. Codex prompts for command approval per-call by default; approve `dev-browser` once and the rest of the session is fast.

### Aider

`/run` followed by the auto-discovery snippet. Aider streams the output back into the chat.

### Playwright (any language)

```ts
import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://localhost:9333");
const [context] = browser.contexts();
const page = context.pages()[0];
await page.goto("https://example.com");
```

### Puppeteer

```ts
import puppeteer from "puppeteer";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9333" });
const [page] = await browser.pages();
await page.goto("https://example.com");
```

### Raw CDP

```bash
curl -s -H 'Host: localhost' http://127.0.0.1:9333/json/version
curl -s -H 'Host: localhost' http://127.0.0.1:9333/json/list
```

The `Host: localhost` header is required (CDP rejects `Host: 127.0.0.1` for DNS-rebinding protection).

## Configuration

| Setting | Default | Description |
|---|---|---|
| `devBrowserPanel.cdpPort` | `9333` | CDP port the embedded Chromium exposes |
| `devBrowserPanel.startUrl` | `about:blank` | URL opened in the first tab |
| `devBrowserPanel.autoreloadGlob` | `**/*.{html,css,js,ts,...}` | Files that trigger autoreload |
| `devBrowserPanel.autoreloadDebounceMs` | `350` | Debounce window for autoreload |
| `devBrowserPanel.chromiumPath` | _(auto)_ | Override path to Chromium binary |
| `devBrowserPanel.viewport` | `{width: 1280, height: 800}` | Initial viewport |
| `devBrowserPanel.screencastFormat` | `"jpeg"` | Image format. `"jpeg"` = high FPS, slight compression. `"png"` = lossless, lower FPS (5-15 fps on heavy pages). |
| `devBrowserPanel.screencastQuality` | `95` | JPEG quality 1-100 (ignored when format=`"png"`). `90` balanced, `95` near-lossless, `100` max. |
| `devBrowserPanel.autoOpenLogs` | `false` | If `true`, automatically reveals the Logs panel when `Open` is called (old behaviour). |
| `devBrowserPanel.searchEngine` | `"google"` | Search engine used by the smart address bar: `"google"` / `"duckduckgo"` / `"bing"`. |
| `devBrowserPanel.downloadPath` | _(auto)_ | Directory for downloads. Blank = `<workspace>/.dev-browser-panel/downloads/`. |
| `devBrowserPanel.restoreTabs` | `true` | Reopen the previous session's tabs when the browser starts. |

## How it finds Chromium

1. If `devBrowserPanel.chromiumPath` is set, uses it.
2. Otherwise probes Playwright's cache (`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux, `%LOCALAPPDATA%/ms-playwright` on Windows) for the latest `chromium_headless_shell-*` and uses that binary.
3. If nothing found, shows an error pointing to `npx playwright install chromium`.

If you already use the `dev-browser` CLI, the Chromium is already installed (it ships with Playwright).

## Troubleshooting

### Port already in use

From v0.2.0 this is handled automatically — the panel scans the next 50 ports from `cdpPort` and uses the first free one. The status bar shows the actual port (e.g. `Browser :9334`).

If you need a deterministic port for a specific workspace, override in that project's `.vscode/settings.json`:

```json
{ "devBrowserPanel.cdpPort": 9444 }
```

Each project's actual port is in `<project>/.dev-browser-panel/port`. The global `~/.dev-browser-panel/port` belongs to the **first window that claimed it** and is only taken over when that window's process dies — prefer the workspace-local file when more than one VS Code window is open.

### Chromium not found

```
Error: Chromium binary not found. Install via `npx playwright install chromium`...
```

The extension looks for Playwright's `chrome-headless-shell`. Install it once:

```bash
npx playwright install chromium
```

Or point to any Chromium/Chrome binary manually:

```json
{ "devBrowserPanel.chromiumPath": "/path/to/chromium" }
```

### macOS Gatekeeper blocks the binary

On first launch macOS may quarantine the Playwright binary:

```bash
xattr -d com.apple.quarantine \
  ~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell
```

### CDP connection refused (`curl http://127.0.0.1:9333/json/version` fails)

The extension uses `Host: localhost` header (required to bypass CDP's DNS-rebinding protection). Ensure no firewall or local proxy intercepts `127.0.0.1:9333`.

### dev-browser CLI says "no pages"

Make sure you're connecting to the right port. Prefer the project-local file:

```bash
dev-browser --connect "http://localhost:$(cat .dev-browser-panel/port 2>/dev/null || cat ~/.dev-browser-panel/port)"
```

### Network tab fica vazio

Bodies de Image/Media/Font não são capturados (são binários e bloated). Tudo o resto sim. Se mesmo assim ficar vazio, faça `Stop Chromium` + `Open` — reconfigura `Network.enable` em todos os targets.

### Screencast looks blurry / degraded quality

The viewer renders Chromium's screencast frames onto a DPR-aware canvas. Here's what to try:

**Choose the right format:**
- **JPEG 95** (default) — near-lossless, high FPS. Good for 95% of cases.
- **JPEG 100** — no perceptible artifact, ~5-10% lower FPS. Good for screenshot review or fine inspection.
- **PNG** — lossless, FPS can drop to 10-15 on heavy pages. Use only when pixel-perfect fidelity matters.

**If still blurry even with PNG:**
Open `Dev Browser Panel: Show Render Diagnostics` and check whether `frame naturalWidth` matches `canvas backing-store width`. A mismatch (e.g. frame `2560×1600` vs canvas `1280×800`) means the screencast was started with wrong `maxWidth`/`maxHeight` — usually because the viewport message hadn't arrived yet. This is fixed in v0.4.0 (deferred screencast start), but if it happens reload the panel.

A mismatch warning is also logged to the browser console (open DevTools on the webview: `Help → Toggle Developer Tools`):
```
[dev-browser-panel] frame 1280x800 ≠ canvas 2560x1600 — degraded quality
```

**Retina / high-DPI:** The extension detects `window.devicePixelRatio` and passes it to `Emulation.setDeviceMetricsOverride`. If your DPR is fractional (e.g. 1.5), the `image-rendering: -webkit-optimize-contrast` style on the canvas helps maintain sharpness.

### "Copied N entries" mas o HAR parece pequeno

Bodies acima de 5MB não são buscados, e bodies de texto acima de 256KB ficam truncados com nota em `content.comment`. A webview também limita o total acumulado em 30MB; quando estoura, body de entries antigas é descartado (metadata preservada, com nota `body evicted by webview budget`).

## Acknowledgments

This extension was inspired by — and is designed to work hand-in-hand with — **[`dev-browser`](https://github.com/SawyerHood/dev-browser)** by [Sawyer Hood](https://github.com/SawyerHood). That CLI is what lets a JavaScript REPL drive a Chromium via CDP from any terminal, and it pairs naturally with this extension's "browser-the-user-can-see-inside-VS-Code" model. Most examples in this README use `dev-browser` directly.

Other prior art consulted:

- [`auchenberg.vscode-browser-preview`](https://github.com/auchenberg/vscode-browser-preview) — the original CDP-in-webview proof of concept (abandoned 2019, but pioneered the screencast-into-webview pattern).
- [Playwright](https://playwright.dev) — for the `chromium_headless_shell` binary cache and the `connectOverCDP` interface this extension mimics.

## License

MIT — see `LICENSE`.
