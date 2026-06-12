import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
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

/** Chrome's zoom ladder. */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

const ALLOWED_WEBVIEW_COMMANDS = new Set([
  "devBrowserPanel.takeScreenshot",
  "devBrowserPanel.takeFullPageScreenshot",
  "devBrowserPanel.printToPDF",
  "devBrowserPanel.viewSource",
  "devBrowserPanel.inspectElement",
  "devBrowserPanel.toggleMobileEmulation",
  "devBrowserPanel.showStorage",
  "devBrowserPanel.showLogs",
  "devBrowserPanel.showDownloads",
  "devBrowserPanel.open",
]);

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
  zoom: number;
}

export class ViewerPanel {
  private static instance: ViewerPanel | null = null;
  private panel: vscode.WebviewPanel;
  private session: Session;
  private currentTargetId: string | null = null;
  private currentSessionId: string | null = null;
  private disposables: vscode.Disposable[] = [];
  private sessionDisposables: vscode.Disposable[] = [];
  private lastViewportWidth: number = 0;
  private lastViewportHeight: number = 0;
  private lastDpr: number = 1;
  private lastScreencastKey: string = "";
  private lastScreencastMaxW: number = 0;
  private lastScreencastMaxH: number = 0;
  private currentScreencastFormat: "jpeg" | "png" = "jpeg";
  private pendingScreencastStart: string | null = null;
  private mobilePresetIndex: number = 0;
  private zoomIndex: number = ZOOM_STEPS.indexOf(1);
  private lastFrameW: number = 0;
  private lastFrameH: number = 0;
  private findActive: boolean = false;
  private inspectModeActive: boolean = false;
  private disposed: boolean = false;

  static getInstance(): ViewerPanel | null {
    return ViewerPanel.instance;
  }

  static create(context: vscode.ExtensionContext, session: Session): ViewerPanel {
    if (ViewerPanel.instance) {
      ViewerPanel.instance.attachSession(session);
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
    session: Session,
  ) {
    this.panel = panel;
    this.session = session;
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

    this.attachSession(session);
  }

  /**
   * Binds (or re-binds) a Session to this panel. Lets the same panel survive
   * a browser restart: old listeners are detached, the new session takes over
   * and the screencast resumes in place.
   */
  attachSession(session: Session): void {
    for (const d of this.sessionDisposables) d.dispose();
    this.sessionDisposables = [];
    this.session = session;
    this.currentTargetId = null;
    this.currentSessionId = null;
    this.lastScreencastKey = "";

    const onActive = (): void => { void this.switchTarget(); };
    const onTabs = (): void => this.refreshTabs();
    const onAttached = (): void => { void this.switchTarget(); };
    const onStopped = (reason?: string): void => {
      this.postMessage({
        type: "overlay",
        kind: "stopped",
        text: reason ? `Browser stopped: ${reason}` : "Browser stopped",
      });
    };
    const onCrashed = (info: { targetId: string }): void => {
      if (info.targetId === this.session.activeTargetId) {
        this.postMessage({ type: "overlay", kind: "crashed", text: "This tab crashed" });
      }
    };
    session.on("active-changed", onActive);
    session.on("targets-changed", onTabs);
    session.on("attached", onAttached);
    session.on("stopped", onStopped);
    session.on("target-crashed", onCrashed);
    this.sessionDisposables.push({
      dispose: () => {
        session.off("active-changed", onActive);
        session.off("targets-changed", onTabs);
        session.off("attached", onAttached);
        session.off("stopped", onStopped);
        session.off("target-crashed", onCrashed);
      },
    });

    const cdp = session.getCDP();
    if (cdp) {
      const onFrame = (ev: CDPEvent): void => {
        if (ev.sessionId !== this.currentSessionId) return;
        const params = ev.params as {
          data: string;
          metadata?: { deviceWidth?: number; deviceHeight?: number };
          sessionId?: number;
        };
        if (params.metadata?.deviceWidth) this.lastFrameW = params.metadata.deviceWidth;
        if (params.metadata?.deviceHeight) this.lastFrameH = params.metadata.deviceHeight;
        this.postMessage({
          type: "frame",
          data: params.data,
          format: this.currentScreencastFormat,
          // Page CSS pixels — the coordinate space Input.dispatchMouseEvent expects.
          pageW: params.metadata?.deviceWidth ?? 0,
          pageH: params.metadata?.deviceHeight ?? 0,
        });
        if (cdp.isConnected() && this.currentSessionId && typeof params.sessionId === "number") {
          cdp
            .send("Page.screencastFrameAck", { sessionId: params.sessionId }, this.currentSessionId)
            .catch(() => undefined);
        }
      };

      const onFrameStarted = (ev: CDPEvent): void => {
        if (ev.sessionId !== this.currentSessionId) return;
        this.postMessage({ type: "loading-start" });
      };

      const onFrameStopped = (ev: CDPEvent): void => {
        if (ev.sessionId !== this.currentSessionId) return;
        this.postMessage({ type: "loading-stop" });
        void this.pushNavState();
      };

      // Keeps the URL bar live: fires on real navigations of the main frame…
      const onFrameNavigated = (ev: CDPEvent): void => {
        if (ev.sessionId !== this.currentSessionId) return;
        const frame = (ev.params as { frame?: { parentId?: string; url?: string } }).frame;
        if (!frame || frame.parentId) return;
        this.postMessage({ type: "url-changed", url: frame.url ?? "" });
        void this.pushNavState();
      };

      // …and on SPA pushState/replaceState navigations.
      const onNavigatedInDoc = (ev: CDPEvent): void => {
        if (ev.sessionId !== this.currentSessionId) return;
        const url = (ev.params as { url?: string }).url;
        this.postMessage({ type: "url-changed", url: url ?? "" });
        void this.pushNavState();
      };

      const onInspectNode = (ev: CDPEvent): void => {
        if (ev.sessionId !== this.currentSessionId) return;
        const backendNodeId = (ev.params as { backendNodeId?: number }).backendNodeId;
        if (backendNodeId) void this.onInspectedNode(backendNodeId);
      };

      cdp.on("Page.screencastFrame", onFrame);
      cdp.on("Page.frameStartedLoading", onFrameStarted);
      cdp.on("Page.frameStoppedLoading", onFrameStopped);
      cdp.on("Page.frameNavigated", onFrameNavigated);
      cdp.on("Page.navigatedWithinDocument", onNavigatedInDoc);
      cdp.on("Overlay.inspectNodeRequested", onInspectNode);
      this.sessionDisposables.push({
        dispose: () => {
          cdp.off("Page.screencastFrame", onFrame);
          cdp.off("Page.frameStartedLoading", onFrameStarted);
          cdp.off("Page.frameStoppedLoading", onFrameStopped);
          cdp.off("Page.frameNavigated", onFrameNavigated);
          cdp.off("Page.navigatedWithinDocument", onNavigatedInDoc);
          cdp.off("Overlay.inspectNodeRequested", onInspectNode);
        },
      });
    }

    this.postMessage({ type: "overlay", kind: "none" });
    this.pushSearchEngine();
    void this.switchTarget();
    this.refreshTabs();
  }

  private postMessage(msg: Record<string, unknown>): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(msg);
  }

  private async switchTarget(): Promise<void> {
    const active = this.session.activeTargetId;
    if (!active) return;
    const target = this.session.targets.get(active);
    if (!target || !target.sessionId) return;

    const cdp = this.session.getCDP();
    if (!cdp) return;

    if (this.currentSessionId === target.sessionId && this.currentTargetId === active) return;

    if (this.currentSessionId && this.currentSessionId !== target.sessionId) {
      try {
        await cdp.send("Page.stopScreencast", {}, this.currentSessionId);
      } catch { /* ignore */ }
    }

    this.currentTargetId = active;
    this.currentSessionId = target.sessionId;
    this.lastScreencastKey = "";

    try {
      await cdp.send("Page.enable", {}, target.sessionId);
    } catch { /* ignore */ }

    this.postMessage({
      type: "active-target",
      targetId: active,
      url: target.url,
      title: target.title,
    });
    void this.pushNavState();

    if (this.lastViewportWidth === 0) {
      // Defer metrics+screencast until the webview reports its viewport size.
      this.pendingScreencastStart = active;
    } else {
      await this.applyMetricsAndScreencast();
    }
  }

  private currentPreset(): MobilePreset {
    return MOBILE_PRESETS[this.mobilePresetIndex];
  }

  private currentZoom(): number {
    return this.mobilePresetIndex === 0 ? ZOOM_STEPS[this.zoomIndex] : 1;
  }

  /**
   * Single source of truth for page emulation + screencast. Desktop mode
   * follows the panel size (with zoom); mobile presets pin the page to the
   * device's dimensions regardless of panel size (the webview letterboxes).
   */
  private async applyMetricsAndScreencast(): Promise<void> {
    const cdp = this.session.getCDP();
    const sid = this.currentSessionId;
    if (!cdp || !sid) return;

    const preset = this.currentPreset();
    const dpr = this.lastDpr || 1;
    const zoom = this.currentZoom();
    const canvasW = this.lastViewportWidth || 1280;
    const canvasH = this.lastViewportHeight || 800;

    let metrics: Record<string, unknown>;
    let maxW: number;
    let maxH: number;
    if (this.mobilePresetIndex === 0) {
      metrics = {
        width: Math.max(1, Math.round(canvasW / zoom)),
        height: Math.max(1, Math.round(canvasH / zoom)),
        deviceScaleFactor: dpr * zoom,
        mobile: false,
      };
      maxW = Math.round(canvasW * dpr);
      maxH = Math.round(canvasH * dpr);
    } else {
      metrics = {
        width: preset.width,
        height: preset.height,
        deviceScaleFactor: preset.dpr,
        mobile: true,
      };
      maxW = 4096;
      maxH = 4096;
    }

    try {
      await cdp.send("Emulation.setDeviceMetricsOverride", metrics, sid);
      await cdp.send("Emulation.setUserAgentOverride", { userAgent: preset.userAgent }, sid);
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: preset.touch }, sid);
      await cdp.send(
        "Emulation.setEmitTouchEventsForMouse",
        { enabled: preset.touch, configuration: preset.touch ? "mobile" : "desktop" },
        sid,
      );
    } catch { /* target may be navigating */ }

    const cfg = vscode.workspace.getConfiguration("devBrowserPanel");
    const format: "jpeg" | "png" = cfg.get<string>("screencastFormat", "jpeg") === "png" ? "png" : "jpeg";
    const quality = Math.max(1, Math.min(100, cfg.get<number>("screencastQuality", 95)));
    this.currentScreencastFormat = format;

    // Restart the screencast only when something meaningful changed. The 50px
    // size threshold avoids restarting 60×/sec during a drag-resize.
    const key = `${sid}|${format}|${quality}|${this.mobilePresetIndex}`;
    const sizeChanged =
      Math.abs(maxW - this.lastScreencastMaxW) > 50 ||
      Math.abs(maxH - this.lastScreencastMaxH) > 50;
    if (key === this.lastScreencastKey && !sizeChanged) return;
    this.lastScreencastKey = key;
    this.lastScreencastMaxW = maxW;
    this.lastScreencastMaxH = maxH;

    const params: Record<string, unknown> = {
      format,
      everyNthFrame: 1,
      maxWidth: maxW,
      maxHeight: maxH,
    };
    if (format === "jpeg") params.quality = quality;
    try {
      await cdp.send("Page.stopScreencast", {}, sid);
    } catch { /* may not be running */ }
    try {
      await cdp.send("Page.startScreencast", params, sid);
    } catch { /* ignore */ }
  }

  private async pushNavState(): Promise<void> {
    if (!this.currentTargetId) return;
    const state = await this.session.getNavState(this.currentTargetId);
    this.postMessage({ type: "nav-state", ...state });
  }

  private pushSearchEngine(): void {
    const cfg = vscode.workspace.getConfiguration("devBrowserPanel");
    this.postMessage({ type: "search-engine", engine: cfg.get<string>("searchEngine", "google") });
  }

  private refreshTabs(): void {
    const tabs = Array.from(this.session.targets.values()).filter((t) => t.type === "page");
    this.postMessage({
      type: "tabs",
      tabs: tabs.map((t) => ({ targetId: t.targetId, title: t.title, url: t.url })),
      activeTargetId: this.session.activeTargetId,
    });
    // Keep the URL bar in sync with the active tab (e.g. after link clicks).
    const active = this.session.activeTargetId
      ? this.session.targets.get(this.session.activeTargetId)
      : null;
    if (active && active.targetId === this.currentTargetId) {
      this.postMessage({ type: "url-changed", url: active.url, title: active.title });
    }
  }

  private async onMessage(msg: InboundMessage): Promise<void> {
    // Messages that work even with a dead session.
    if (msg.type === "restart-session") {
      await vscode.commands.executeCommand("devBrowserPanel.open");
      return;
    }
    if (msg.type === "command") {
      const command = String(msg.command ?? "");
      if (ALLOWED_WEBVIEW_COMMANDS.has(command)) {
        await vscode.commands.executeCommand(command);
      }
      return;
    }
    if (msg.type === "copy-text") {
      const text = String(msg.text ?? "");
      if (text) {
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage("$(clippy) Copied", 2000);
      }
      return;
    }

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
          if (this.currentTargetId) await this.session.reload(this.currentTargetId, !!msg.hard);
          break;
        }
        case "stop-loading": {
          if (this.currentTargetId) await this.session.stopLoading(this.currentTargetId);
          break;
        }
        case "back": {
          if (this.currentTargetId) await this.session.goBack(this.currentTargetId);
          break;
        }
        case "forward": {
          if (this.currentTargetId) await this.session.goForward(this.currentTargetId);
          break;
        }
        case "reload-crashed": {
          if (this.currentTargetId) {
            await this.session.recoverTarget(this.currentTargetId);
            this.postMessage({ type: "overlay", kind: "none" });
          }
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
          const w = msg.width as number;
          const h = msg.height as number;
          const dpr = Math.max(1, Math.min(3, (msg.dpr as number) || 1));
          this.lastViewportWidth = w;
          this.lastViewportHeight = h;
          this.lastDpr = dpr;

          if (this.pendingScreencastStart !== null && this.pendingScreencastStart === this.currentTargetId) {
            this.pendingScreencastStart = null;
          }
          await this.applyMetricsAndScreencast();
          break;
        }
        case "zoom": {
          const direction = String(msg.direction ?? "reset");
          if (this.mobilePresetIndex !== 0) break; // zoom only in desktop mode
          if (direction === "in") this.zoomIndex = Math.min(ZOOM_STEPS.length - 1, this.zoomIndex + 1);
          else if (direction === "out") this.zoomIndex = Math.max(0, this.zoomIndex - 1);
          else this.zoomIndex = ZOOM_STEPS.indexOf(1);
          await this.applyMetricsAndScreencast();
          this.postMessage({ type: "zoom-level", zoom: this.currentZoom() });
          break;
        }
        case "copy-request": {
          if (!sid) return;
          const text = await this.getSelectedText(sid);
          if (text) {
            await vscode.env.clipboard.writeText(text);
            vscode.window.setStatusBarMessage(`$(clippy) Copied ${text.length} chars`, 2000);
          }
          break;
        }
        case "cut-request": {
          if (!sid) return;
          const text = await this.getSelectedText(sid);
          if (text) {
            await vscode.env.clipboard.writeText(text);
            // Delete removes the selection in inputs and contenteditable alike.
            await cdp.send(
              "Input.dispatchKeyEvent",
              { type: "keyDown", key: "Delete", code: "Delete", keyCode: 46, windowsVirtualKeyCode: 46 },
              sid,
            );
            await cdp.send(
              "Input.dispatchKeyEvent",
              { type: "keyUp", key: "Delete", code: "Delete", keyCode: 46, windowsVirtualKeyCode: 46 },
              sid,
            );
            vscode.window.setStatusBarMessage(`$(clippy) Cut ${text.length} chars`, 2000);
          }
          break;
        }
        case "select-all": {
          if (!sid) return;
          // Editing command — plain Cmd/Ctrl+A key events do nothing in headless.
          try {
            await cdp.send(
              "Input.dispatchKeyEvent",
              {
                type: "keyDown",
                key: "a",
                code: "KeyA",
                keyCode: 65,
                windowsVirtualKeyCode: 65,
                commands: ["selectAll"],
              },
              sid,
            );
            await cdp.send(
              "Input.dispatchKeyEvent",
              { type: "keyUp", key: "a", code: "KeyA", keyCode: 65, windowsVirtualKeyCode: 65 },
              sid,
            );
          } catch {
            await cdp.send(
              "Runtime.evaluate",
              { expression: "document.execCommand('selectAll')", userGesture: true },
              sid,
            );
          }
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
            var el = document.elementFromPoint(${Number(x)}, ${Number(y)});
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
          this.postMessage({
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

  /** Selection text that also covers <input>/<textarea>, which window.getSelection() misses. */
  private async getSelectedText(sid: string): Promise<string> {
    const cdp = this.session.getCDP();
    if (!cdp) return "";
    const expr = `(function(){
      var el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') &&
          el.selectionStart != null && el.selectionEnd > el.selectionStart) {
        return el.value.substring(el.selectionStart, el.selectionEnd);
      }
      var s = window.getSelection();
      return s ? s.toString() : '';
    })()`;
    try {
      const result = await cdp.send<{ result?: { value?: string } }>(
        "Runtime.evaluate",
        { expression: expr, returnByValue: true },
        sid,
      );
      return result?.result?.value ?? "";
    } catch {
      return "";
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
        120_000,
      );
      const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const uri = await vscode.window.showSaveDialog({
        filters: { "PNG Image": ["png"] },
        saveLabel: "Save Screenshot",
        defaultUri: wsFolder
          ? vscode.Uri.joinPath(wsFolder, `screenshot-${stamp}.png`)
          : undefined,
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
        120_000,
      );
      const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const uri = await vscode.window.showSaveDialog({
        filters: { "PDF Document": ["pdf"] },
        saveLabel: "Save PDF",
        defaultUri: wsFolder ? vscode.Uri.joinPath(wsFolder, `page-${stamp}.pdf`) : undefined,
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
      const doc = await vscode.workspace.openTextDocument({ content: html, language: "html" });
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
    const preset = this.currentPreset();
    try {
      await this.applyMetricsAndScreencast();
      this.postMessage({ type: "mobile-preset", name: preset.name });
      this.postMessage({ type: "zoom-level", zoom: this.currentZoom() });
    } catch (e) {
      vscode.window.showErrorMessage(`Mobile emulation failed: ${(e as Error).message}`);
    }
  }

  triggerFind(): void {
    this.findActive = !this.findActive;
    this.postMessage({ type: "show-find", active: this.findActive });
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
        await cdp.send("DOM.enable", {}, sid); // Overlay requires the DOM agent
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
        vscode.window.setStatusBarMessage("$(inspect) Inspect mode ON — click an element", 4000);
      } else {
        await this.exitInspectMode(sid);
      }
    } catch (e) {
      this.inspectModeActive = false;
      vscode.window.showErrorMessage(`Inspect mode failed: ${(e as Error).message}`);
    }
  }

  private async exitInspectMode(sid: string): Promise<void> {
    const cdp = this.session.getCDP();
    if (!cdp) return;
    this.inspectModeActive = false;
    try {
      await cdp.send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} }, sid);
      await cdp.send("Overlay.disable", {}, sid);
      await cdp.send("DOM.disable", {}, sid);
    } catch { /* ignore */ }
  }

  /** User clicked an element in inspect mode → show its HTML. */
  private async onInspectedNode(backendNodeId: number): Promise<void> {
    const cdp = this.session.getCDP();
    const sid = this.currentSessionId;
    if (!cdp || !sid) return;
    try {
      const { outerHTML } = await cdp.send<{ outerHTML: string }>(
        "DOM.getOuterHTML",
        { backendNodeId },
        sid,
      );
      await this.exitInspectMode(sid);
      const doc = await vscode.workspace.openTextDocument({ content: outerHTML, language: "html" });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    } catch (e) {
      vscode.window.showErrorMessage(`Inspect failed: ${(e as Error).message}`);
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
    const preset = this.currentPreset();
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
      zoom: this.currentZoom(),
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
  <button id="btn-back" title="Back (Alt+←)" disabled>&#8592;</button>
  <button id="btn-forward" title="Forward (Alt+→)" disabled>&#8594;</button>
  <button id="btn-reload" title="Reload (Cmd/Ctrl+R) — Shift for hard reload">&#8635;</button>
  <input id="urlbar" type="text" placeholder="Search or type URL" spellcheck="false">
  <span id="zoom-chip" title="Zoom (Cmd/Ctrl + / - / 0). Click to reset." style="display:none;"></span>
  <span id="mobile-indicator" title="Mobile emulation active" style="display:none;font-size:16px;line-height:1;padding:0 4px;" aria-label="Mobile emulation"></span>
  <button id="btn-screenshot" title="Take Screenshot">&#128247;</button>
  <button id="btn-newtab" title="New Tab (Cmd/Ctrl+T)">+</button>
</div>
<div id="loading-bar"></div>
<div id="tabs"></div>
<div id="viewport">
  <canvas id="screen" tabindex="0"></canvas>
  <div id="overlay">
    <div id="overlay-msg"></div>
    <button id="overlay-btn"></button>
  </div>
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
    this.disposed = true;
    for (const d of this.sessionDisposables) d.dispose();
    this.sessionDisposables = [];
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    // Stop streaming frames nobody is watching.
    const cdp = this.session.getCDP();
    if (cdp && this.currentSessionId) {
      cdp.send("Page.stopScreencast", {}, this.currentSessionId).catch(() => undefined);
    }
  }
}
