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
- **Per-instance isolation** — each VS Code window gets its own Chromium with its own profile (cookies/localStorage isolated), automatically allocated to a free port starting at `cdpPort` (default `9333`, scans next 50 if busy)
- **Workspace-local port file** for auto-discovery — `<workspace>/.dev-browser-panel/port` so terminals in that project pick up the right browser. A global pointer at `~/.dev-browser-panel/port` (most recently opened) is also maintained.

## Quick Start

```bash
npm install
npm run compile
npm run package    # produces dev-browser-panel-0.1.0.vsix
code --install-extension dev-browser-panel-0.1.0.vsix
```

Then in VS Code: `Cmd+Shift+P` → `Dev Browser Panel: Open`.

## Commands

All available via `Cmd+Shift+P` (macOS) / `Ctrl+Shift+P` (Linux/Windows):

| Command | What it does |
|---|---|
| `Dev Browser Panel: Open` | Start Chromium, open the viewer + logs panels |
| `Dev Browser Panel: New Tab` | Prompt for URL, open it in a new Chromium target |
| `Dev Browser Panel: Reload Current Tab` | `Page.reload` on the active target |
| `Dev Browser Panel: Toggle Autoreload` | Toggle file-watcher-driven reload on/off |
| `Dev Browser Panel: Show Logs` | Reveal the Browser Logs panel (auto-opens with `Open`) |
| `Dev Browser Panel: Stop Chromium` | Kill the embedded Chromium and delete the port file |

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

The fallback to `~/.dev-browser-panel/port` works because the extension writes a "most-recently-opened" global pointer there too. If you're not in a project root, you still hit *some* browser.

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

Each project's actual port is in `<project>/.dev-browser-panel/port`. The global `~/.dev-browser-panel/port` points to the most-recently-opened session.

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

### "Copied N entries" mas o HAR parece pequeno

Bodies acima de 5MB não são buscados, e bodies de texto acima de 256KB ficam truncados com nota em `content.comment`. A webview também limita o total acumulado em 30MB; quando estoura, body de entries antigas é descartado (metadata preservada, com nota `body evicted by webview budget`).

## Acknowledgments

This extension was inspired by — and is designed to work hand-in-hand with — **[`dev-browser`](https://github.com/SawyerHood/dev-browser)** by [Sawyer Hood](https://github.com/SawyerHood). That CLI is what lets a JavaScript REPL drive a Chromium via CDP from any terminal, and it pairs naturally with this extension's "browser-the-user-can-see-inside-VS-Code" model. Most examples in this README use `dev-browser` directly.

Other prior art consulted:

- [`auchenberg.vscode-browser-preview`](https://github.com/auchenberg/vscode-browser-preview) — the original CDP-in-webview proof of concept (abandoned 2019, but pioneered the screencast-into-webview pattern).
- [Playwright](https://playwright.dev) — for the `chromium_headless_shell` binary cache and the `connectOverCDP` interface this extension mimics.

## License

MIT — see `LICENSE`.
