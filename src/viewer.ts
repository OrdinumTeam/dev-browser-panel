import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { Session } from "./session";
import { CDPEvent } from "./cdp";
import { StoragePanel } from "./storage";

interface InboundMessage {
  type: string;
  [k: string]: unknown;
}

interface MobilePreset {
  name: string;
  width: number;
  height: number;
  dpr: number;
  userAgent: string;
  mobile: boolean;
  touch: boolean;
}

const MOBILE_PRESETS: MobilePreset[] = [
  {
    name: "Desktop",
    width: 1280,
    height: 800,
    dpr: 1,
    userAgent: "",
    mobile: false,
    touch: false,
  },
  {
    name: "iPhone 15 Pro",
    width: 393,
    height: 852,
    dpr: 3,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    mobile: true,
    touch: true,
  },
  {
    name: "iPad Pro",
    width: 1024,
    height: 1366,
    dpr: 2,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    mobile: true,
    touch: true,
  },
  {
    name: "Galaxy S24",
    width: 412,
    height: 915,
    dpr: 2.625,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    mobile: true,
    touch: true,
  },
];

export interface DiagnosticsData {
  dpr: number;
  canvasW: number;
  canvasH: number;
  lastFrameW: number;
  lastFrameH: number;
  deviceScaleFactor: number;
  format: string;
  quality: number;
  mobilePreset: string;
}

export class ViewerPanel {
  private static instance: ViewerPanel | null = null;
  private panel: vscode.WebviewPanel;
  private currentTargetId: string | null = null;
  private currentSessionId: string | null = null;
  private disposables: vscode.Disposable[] = [];
  private lastViewportWidth: number = 0;
  private lastViewportHeight: number = 0;
  private lastDpr: number = 1;
  private lastScreencastMaxW: number = 0;
  private lastScreencastMaxH: number = 0;
  private currentScreencastFormat: "jpeg" | "png" = "jpeg";
  private pendingScreencastStart: string | null = null;
  private mobilePresetIndex: number = 0;
  private lastFrameW: number = 0;
  private lastFrameH: number = 0;
  private findActive: boolean = false;
  private inspectModeActive: boolean = false;

  static getInstance(): ViewerPanel | null {
    return ViewerPanel.instance;
  }

  static create(context: vscode.ExtensionContext, session: Session): ViewerPanel {
    if (ViewerPanel.instance) {
      ViewerPanel.instance.panel.reveal(vscode.ViewColumn.Two);
      return ViewerPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      "devBrowserPanelViewer",
      "Browser",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "media"))],
      },
    );
    const viewer = new ViewerPanel(context, panel, session);
    ViewerPanel.instance = viewer;
    return viewer;
  }

  private constructor(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    private session: Session,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(context);

    this.panel.onDidDispose(
      () => {
        this.dispose();
        ViewerPanel.instance = null;
      },
      null,
      this.disposables,
    );

    this.panel.webview.onDidReceiveMessage(
      (msg: InboundMessage) => { void this.onMessage(msg); },
      null,
      this.disposables,
    );

    const onActive = (): void => { void this.switchTarget(); };
    const onTabs = (): void => this.refreshTabs();
    const onAttached = (): void => { void this.switchTarget(); };
    session.on("active-changed", onActive);
    session.on("targets-changed", onTabs);
    session.on("attached", onAttached);
    this.disposables.push({
      dispose: () => {
        session.off("active-changed", onActive);
        session.off("targets-changed", onTabs);
        session.off("attached", onAttached);
      },
    });

    const cdp = session.getCDP();
    if (cdp) {
      const onFrame = (ev: CDPEvent): void => {
        if (ev.sessionId !== this.currentSessionId) return;
        const params = ev.params as { data: string; metadata?: { deviceWidth?: number; deviceHeight?: number }; sessionId?: number };
        if (params.metadata?.deviceWidth) this.lastFrameW = params.metadata.deviceWidth;
        if (params.metadata?.deviceHeight) this.lastFrameH = params.metadata.deviceHeight;
        this.panel.webview.postMessage({
          type: "frame",
          data: params.data,
          format: this.currentScreencastFormat,
        });
        if (cdp.isConnected() && this.currentSessionId && typeof params.sessionId === "number") {
          cdp
            .send("Page.screencastFrameAck", { sessionId: params.sessionId }, this.currentSessionId)
            .catch(() => undefined);
        }
      };

      const onFrameStarted = (ev: CDPEvent): void => {
        if (ev.sessionId !== this.currentSessionId) return;
        this.panel.webview.postMessage({ type: "loading-start" });
      };

      const onFrameStopped = (ev: CDPEvent): void => {
        if (ev.sessionId !== this.currentSessionId) return;
        this.panel.webview.postMessage({ type: "loading-stop" });
      };

      cdp.on("Page.screencastFrame", onFrame);
      cdp.on("Page.frameStartedLoading", onFrameStarted);
      cdp.on("Page.frameStoppedLoading", onFrameStopped);
      this.disposables.push({
        dispose: () => {
          cdp.off("Page.screencastFrame", onFrame);
          cdp.off("Page.frameStartedLoading", onFrameStarted);
          cdp.off("Page.frameStoppedLoading", onFrameStopped);
        },
      });
    }

    void this.switchTarget();
    this.refreshTabs();
  }

  private async switchTarget(): Promise<void> {
    const active = this.session.activeTargetId;
    if (!active) return;
    const target = this.session.targets.get(active);
    if (!target || !target.sessionId) return;

    const cdp = this.session.getCDP();
    if (!cdp) return;

    if (this.currentSessionId && this.currentSessionId !== target.sessionId) {
      try {
        await cdp.send("Page.stopScreencast", {}, this.currentSessionId);
      } catch { /* ignore */ }
    }

    this.currentTargetId = active;
    this.currentSessionId = target.sessionId;

    try {
      await cdp.send("Page.enable", {}, target.sessionId);
    } catch { /* ignore */ }

    this.panel.webview.postMessage({
      type: "active-target",
      targetId: active,
      url: target.url,
      title: target.title,
    });

    // Phase 3: Only start screencast if viewport is already known
    if (this.lastViewportWidth === 0) {
      // Defer screencast start until we receive the viewport message
      this.pendingScreencastStart = active;
    } else {
      await this.startScreencast(target.sessionId);
    }
  }

  private async startScreencast(sessionId: string): Promise<void> {
    const cdp = this.session.getCDP();
    if (!cdp) return;
    const dpr = this.lastDpr || 1;
    const w = this.lastViewportWidth || 1280;
    const h = this.lastViewportHeight || 800;
    const cfg = vscode.workspace.getConfiguration("devBrowserPanel");
    const format: "jpeg" | "png" = cfg.get<string>("screencastFormat", "jpeg") === "png" ? "png" : "jpeg";
    this.currentScreencastFormat = format;
    const quality = Math.max(1, Math.min(100, cfg.get<number>("screencastQuality", 95)));
    const params: Record<string, unknown> = {
      format,
      everyNthFrame: 1,
      maxWidth: Math.round(w * dpr),
      maxHeight: Math.round(h * dpr),
    };
    if (format === "jpeg") params.quality = quality;
    try {
      await cdp.send("Page.startScreencast", params, sessionId);
    } catch { /* ignore */ }
  }

  private refreshTabs(): void {
    const tabs = Array.from(this.session.targets.values()).filter((t) => t.type === "page");
    this.panel.webview.postMessage({
      type: "tabs",
      tabs: tabs.map((t) => ({ targetId: t.targetId, title: t.title, url: t.url })),
      activeTargetId: this.session.activeTargetId,
    });
  }

  private async onMessage(msg: InboundMessage): Promise<void> {
    const cdp = this.session.getCDP();
    if (!cdp) return;
    const sid = this.currentSessionId;

    try {
      switch (msg.type) {
        case "mouse": {
          if (!sid) return;
          await cdp.send("Input.dispatchMouseEvent", msg.event as Record<string, unknown>, sid);
          break;
        }
        case "key": {
          if (!sid) return;
          await cdp.send("Input.dispatchKeyEvent", msg.event as Record<string, unknown>, sid);
          break;
        }
        case "navigate": {
          if (this.currentTargetId) await this.session.navigate(this.currentTargetId, msg.url as string);
          break;
        }
        case "reload": {
          if (this.currentTargetId) await this.session.reload(this.currentTargetId);
          break;
        }
        case "switch-tab": {
          this.session.setActive(msg.targetId as string);
          break;
        }
        case "new-tab": {
          await this.session.createNewTab((msg.url as string) || "about:blank");
          break;
        }
        case "close-tab": {
          await this.session.closeTab(msg.targetId as string);
          break;
        }
        case "viewport": {
          if (!sid) return;
          const w = msg.width as number;
          const h = msg.height as number;
          const dpr = Math.max(1, Math.min(3, (msg.dpr as number) || 1));
          this.lastViewportWidth = w;
          this.lastViewportHeight = h;
          this.lastDpr = dpr;
          await cdp.send(
            "Emulation.setDeviceMetricsOverride",
            { width: w, height: h, deviceScaleFactor: dpr, mobile: false },
            sid,
          );

          // Phase 3: If a screencast start was deferred, start it now
          if (this.pendingScreencastStart !== null && this.pendingScreencastStart === this.currentTargetId) {
            const targetToStart = this.session.targets.get(this.pendingScreencastStart);
            this.pendingScreencastStart = null;
            if (targetToStart?.sessionId) {
              await this.startScreencast(targetToStart.sessionId);
            }
          }

          // Restart screencast with proper maxWidth/Height so we get
          // full-resolution DPR-aware frames. Threshold avoids restarting
          // 60x/sec during a drag-resize.
          const newMaxW = Math.round(w * dpr);
          const newMaxH = Math.round(h * dpr);
          if (
            Math.abs(newMaxW - this.lastScreencastMaxW) > 50 ||
            Math.abs(newMaxH - this.lastScreencastMaxH) > 50
          ) {
            this.lastScreencastMaxW = newMaxW;
            this.lastScreencastMaxH = newMaxH;
            const cfg = vscode.workspace.getConfiguration("devBrowserPanel");
            const format: "jpeg" | "png" = cfg.get<string>("screencastFormat", "jpeg") === "png" ? "png" : "jpeg";
            this.currentScreencastFormat = format;
            const quality = Math.max(1, Math.min(100, cfg.get<number>("screencastQuality", 95)));
            const params: Record<string, unknown> = {
              format,
              everyNthFrame: 1,
              maxWidth: newMaxW,
              maxHeight: newMaxH,
            };
            if (format === "jpeg") params.quality = quality;
            try {
              await cdp.send("Page.stopScreencast", {}, sid);
              await cdp.send("Page.startScreencast", params, sid);
            } catch { /* ignore */ }
          }
          break;
        }
        case "back": {
          if (!sid) return;
          await cdp.send("Runtime.evaluate", { expression: "history.back()" }, sid);
          break;
        }
        case "forward": {
          if (!sid) return;
          await cdp.send("Runtime.evaluate", { expression: "history.forward()" }, sid);
          break;
        }
        case "copy-request": {
          if (!sid) return;
          const copyResult = await cdp.send<{ result?: { value?: string } }>(
            "Runtime.evaluate",
            { expression: "window.getSelection().toString()", returnByValue: true },
            sid,
          );
          const text = copyResult?.result?.value ?? "";
          await vscode.env.clipboard.writeText(text);
          vscode.window.showInformationMessage(`Copied ${text.length} chars`);
          break;
        }
        case "paste-request": {
          if (!sid) return;
          const pasteText = await vscode.env.clipboard.readText();
          if (pasteText) {
            await cdp.send("Input.insertText", { text: pasteText }, sid);
          }
          break;
        }
        case "context-hit-test": {
          if (!sid) return;
          const x = msg.x as number;
          const y = msg.y as number;
          const expr = `(function(){
            var el = document.elementFromPoint(${x}, ${y});
            if (!el) return JSON.stringify({});
            var a = el.closest('a');
            var img = el.tagName === 'IMG' ? el : el.querySelector('img');
            return JSON.stringify({
              link: a ? a.href : undefined,
              imgSrc: img ? img.src : undefined
            });
          })()`;
          const hitResult = await cdp.send<{ result?: { value?: string } }>(
            "Runtime.evaluate",
            { expression: expr, returnByValue: true },
            sid,
          );
          let hitData: { link?: string; imgSrc?: string } = {};
          try {
            if (hitResult?.result?.value) {
              hitData = JSON.parse(hitResult.result.value) as { link?: string; imgSrc?: string };
            }
          } catch { /* ignore */ }
          this.panel.webview.postMessage({
            type: "context-hit-result",
            link: hitData.link,
            imgSrc: hitData.imgSrc,
          });
          break;
        }
        case "find": {
          if (!sid) return;
          const query = msg.query as string;
          if (!query) break;
          const findExpr = `window.find(decodeURIComponent(${JSON.stringify(encodeURIComponent(query))}))`;
          await cdp.send("Runtime.evaluate", { expression: findExpr }, sid);
          break;
        }
        case "find-next": {
          if (!sid) return;
          const findQuery = msg.query as string;
          if (!findQuery) break;
          const findNextExpr = `window.find(decodeURIComponent(${JSON.stringify(encodeURIComponent(findQuery))}), false, ${msg.backward ? "true" : "false"})`;
          await cdp.send("Runtime.evaluate", { expression: findNextExpr }, sid);
          break;
        }
        case "find-close": {
          if (!sid) return;
          this.findActive = false;
          await cdp.send("Runtime.evaluate", { expression: "window.getSelection().removeAllRanges()" }, sid);
          break;
        }
      }
    } catch {
      // swallow — webview shouldn't crash the extension
    }
  }

  // --- Public methods for commands ---

  async takeScreenshot(fullPage: boolean): Promise<void> {
    const cdp = this.session.getCDP();
    const sid = this.currentSessionId;
    if (!cdp || !sid) {
      vscode.window.showWarningMessage("No active browser tab.");
      return;
    }
    try {
      const result = await cdp.send<{ data: string }>(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: fullPage },
        sid,
      );
      const uri = await vscode.window.showSaveDialog({
        filters: { "PNG Image": ["png"] },
        saveLabel: "Save Screenshot",
      });
      if (!uri) return;
      const buf = Buffer.from(result.data, "base64");
      fs.writeFileSync(uri.fsPath, buf);
      vscode.window.showInformationMessage(`Screenshot saved: ${path.basename(uri.fsPath)}`);
    } catch (e) {
      vscode.window.showErrorMessage(`Screenshot failed: ${(e as Error).message}`);
    }
  }

  async printToPDF(): Promise<void> {
    const cdp = this.session.getCDP();
    const sid = this.currentSessionId;
    if (!cdp || !sid) {
      vscode.window.showWarningMessage("No active browser tab.");
      return;
    }
    try {
      const result = await cdp.send<{ data: string }>(
        "Page.printToPDF",
        { printBackground: true },
        sid,
      );
      const uri = await vscode.window.showSaveDialog({
        filters: { "PDF Document": ["pdf"] },
        saveLabel: "Save PDF",
      });
      if (!uri) return;
      const buf = Buffer.from(result.data, "base64");
      fs.writeFileSync(uri.fsPath, buf);
      vscode.window.showInformationMessage(`PDF saved: ${path.basename(uri.fsPath)}`);
    } catch (e) {
      vscode.window.showErrorMessage(`PDF export failed: ${(e as Error).message}`);
    }
  }

  async viewSource(): Promise<void> {
    const cdp = this.session.getCDP();
    const sid = this.currentSessionId;
    if (!cdp || !sid) {
      vscode.window.showWarningMessage("No active browser tab.");
      return;
    }
    try {
      const result = await cdp.send<{ result?: { value?: string } }>(
        "Runtime.evaluate",
        { expression: "document.documentElement.outerHTML", returnByValue: true },
        sid,
      );
      const html = result?.result?.value ?? "";
      const tmpFile = path.join(os.tmpdir(), `dev-browser-source-${Date.now()}.html`);
      fs.writeFileSync(tmpFile, html, "utf8");
      const doc = await vscode.workspace.openTextDocument(tmpFile);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
    } catch (e) {
      vscode.window.showErrorMessage(`View source failed: ${(e as Error).message}`);
    }
  }

  async toggleMobileEmulation(): Promise<void> {
    const cdp = this.session.getCDP();
    const sid = this.currentSessionId;
    if (!cdp || !sid) {
      vscode.window.showWarningMessage("No active browser tab.");
      return;
    }
    this.mobilePresetIndex = (this.mobilePresetIndex + 1) % MOBILE_PRESETS.length;
    const preset = MOBILE_PRESETS[this.mobilePresetIndex];
    try {
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        {
          width: preset.width,
          height: preset.height,
          deviceScaleFactor: preset.dpr,
          mobile: preset.mobile,
        },
        sid,
      );
      if (preset.userAgent) {
        await cdp.send("Emulation.setUserAgentOverride", { userAgent: preset.userAgent }, sid);
      } else {
        await cdp.send("Emulation.setUserAgentOverride", { userAgent: "" }, sid);
      }
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: preset.touch }, sid);
      this.panel.webview.postMessage({ type: "mobile-preset", name: preset.name });
    } catch (e) {
      vscode.window.showErrorMessage(`Mobile emulation failed: ${(e as Error).message}`);
    }
  }

  triggerFind(): void {
    this.findActive = !this.findActive;
    this.panel.webview.postMessage({ type: "show-find", active: this.findActive });
  }

  async toggleInspectMode(): Promise<void> {
    const cdp = this.session.getCDP();
    const sid = this.currentSessionId;
    if (!cdp || !sid) {
      vscode.window.showWarningMessage("No active browser tab.");
      return;
    }
    this.inspectModeActive = !this.inspectModeActive;
    try {
      if (this.inspectModeActive) {
        await cdp.send("Overlay.enable", {}, sid);
        await cdp.send(
          "Overlay.setInspectMode",
          {
            mode: "searchForNode",
            highlightConfig: {
              showInfo: true,
              showStyles: true,
              contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
              paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
              borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
              marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
            },
          },
          sid,
        );
        vscode.window.showInformationMessage("Inspect mode ON — click an element in the browser");
      } else {
        await cdp.send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} }, sid);
        await cdp.send("Overlay.disable", {}, sid);
        vscode.window.showInformationMessage("Inspect mode OFF");
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Inspect mode failed: ${(e as Error).message}`);
    }
  }

  async refreshStorage(storageProvider: StoragePanel): Promise<void> {
    const cdp = this.session.getCDP();
    const sid = this.currentSessionId;
    if (!cdp || !sid) {
      vscode.window.showWarningMessage("No active browser tab.");
      return;
    }
    await storageProvider.refresh(this.session, sid);
    await vscode.commands.executeCommand("devBrowserPanel.storageView.focus");
  }

  getDiagnosticsData(): DiagnosticsData {
    const cfg = vscode.workspace.getConfiguration("devBrowserPanel");
    const quality = Math.max(1, Math.min(100, cfg.get<number>("screencastQuality", 95)));
    const preset = MOBILE_PRESETS[this.mobilePresetIndex];
    return {
      dpr: this.lastDpr,
      canvasW: this.lastViewportWidth,
      canvasH: this.lastViewportHeight,
      lastFrameW: this.lastFrameW,
      lastFrameH: this.lastFrameH,
      deviceScaleFactor: this.lastDpr,
      format: this.currentScreencastFormat,
      quality,
      mobilePreset: preset.name,
    };
  }

  private getHtml(context: vscode.ExtensionContext): string {
    const mediaUri = vscode.Uri.file(path.join(context.extensionPath, "media"));
    const base = this.panel.webview.asWebviewUri(mediaUri);
    const csp = this.panel.webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp}; img-src ${csp} data:; font-src ${csp};">
<link rel="stylesheet" href="${base}/viewer.css">
<title>Browser</title>
</head>
<body>
<div id="toolbar">
  <button id="btn-back" title="Back">&#8592;</button>
  <button id="btn-forward" title="Forward">&#8594;</button>
  <button id="btn-reload" title="Reload">&#8987;</button>
  <input id="urlbar" type="text" placeholder="Search or type URL">
  <span id="mobile-indicator" title="Mobile emulation active" style="display:none;font-size:16px;line-height:1;padding:0 4px;" aria-label="Mobile emulation"></span>
  <button id="btn-screenshot" title="Take Screenshot">&#128247;</button>
  <button id="btn-newtab" title="New Tab">+</button>
</div>
<div id="loading-bar"></div>
<div id="tabs"></div>
<div id="viewport">
  <canvas id="screen" tabindex="0"></canvas>
  <div id="find-bar">
    <input id="find-input" type="text" placeholder="Find in page...">
    <span id="find-count"></span>
    <button id="find-prev" title="Previous">&#8593;</button>
    <button id="find-next-btn" title="Next">&#8595;</button>
    <button id="find-close" title="Close">&#10005;</button>
  </div>
  <div id="context-menu"></div>
</div>
<script src="${base}/viewer.js"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
