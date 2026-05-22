import * as vscode from "vscode";
import * as path from "path";
import { Session } from "./session";
import { CDPEvent } from "./cdp";

interface InboundMessage {
  type: string;
  [k: string]: unknown;
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
        const params = ev.params as { data: string; sessionId?: number };
        this.panel.webview.postMessage({ type: "frame", data: params.data });
        if (cdp.isConnected() && this.currentSessionId && typeof params.sessionId === "number") {
          cdp
            .send("Page.screencastFrameAck", { sessionId: params.sessionId }, this.currentSessionId)
            .catch(() => undefined);
        }
      };
      cdp.on("Page.screencastFrame", onFrame);
      this.disposables.push({ dispose: () => cdp.off("Page.screencastFrame", onFrame) });
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
      const dpr = this.lastDpr || 1;
      const w = this.lastViewportWidth || 1280;
      const h = this.lastViewportHeight || 800;
      await cdp.send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: 90,
          everyNthFrame: 1,
          maxWidth: Math.round(w * dpr),
          maxHeight: Math.round(h * dpr),
        },
        target.sessionId,
      );
    } catch { /* ignore */ }

    this.panel.webview.postMessage({
      type: "active-target",
      targetId: active,
      url: target.url,
      title: target.title,
    });
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
            try {
              await cdp.send("Page.stopScreencast", {}, sid);
              await cdp.send(
                "Page.startScreencast",
                {
                  format: "jpeg",
                  quality: 90,
                  everyNthFrame: 1,
                  maxWidth: newMaxW,
                  maxHeight: newMaxH,
                },
                sid,
              );
            } catch { /* ignore */ }
          }
          break;
        }
        case "back": {
          if (!sid) return;
          // Page.navigateToHistoryEntry — would need full history; simpler: use JS history.back via Runtime.evaluate
          await cdp.send("Runtime.evaluate", { expression: "history.back()" }, sid);
          break;
        }
        case "forward": {
          if (!sid) return;
          await cdp.send("Runtime.evaluate", { expression: "history.forward()" }, sid);
          break;
        }
      }
    } catch {
      // swallow — webview shouldn't crash the extension
    }
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
  <button id="btn-back" title="Voltar">←</button>
  <button id="btn-forward" title="Avançar">→</button>
  <button id="btn-reload" title="Recarregar">⟳</button>
  <input id="urlbar" type="text" placeholder="Digite uma URL e pressione Enter">
  <button id="btn-newtab" title="Nova aba">+</button>
</div>
<div id="tabs"></div>
<div id="viewport"><canvas id="screen" tabindex="0"></canvas></div>
<script src="${base}/viewer.js"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
