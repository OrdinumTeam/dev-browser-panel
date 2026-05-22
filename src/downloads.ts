import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { Session } from "./session";
import { CDPClient, CDPEvent } from "./cdp";

interface DownloadItem {
  guid: string;
  url: string;
  filename: string;
  state: "downloading" | "complete" | "failed";
  receivedBytes: number;
  totalBytes: number;
  timestamp: number;
}

function getDownloadPath(workspaceDir: string): string {
  const cfg = vscode.workspace.getConfiguration("devBrowserPanel");
  const custom = cfg.get<string>("downloadPath", "").trim();
  if (custom) return custom;
  return path.join(workspaceDir, ".dev-browser-panel", "downloads");
}

export class DownloadsPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private cdpRef: CDPClient | null = null;
  private onWillBeginRef: ((ev: CDPEvent) => void) | null = null;
  private onProgressRef: ((ev: CDPEvent) => void) | null = null;
  private downloads = new Map<string, DownloadItem>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media"))],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: { type?: string; guid?: string }) => {
      if (msg?.type === "clear") {
        this.downloads.clear();
        this.pushAll();
      } else if (msg?.type === "open-folder" && msg.guid) {
        const item = this.downloads.get(msg.guid);
        if (item) {
          const cfg = vscode.workspace.getConfiguration("devBrowserPanel");
          const custom = cfg.get<string>("downloadPath", "").trim();
          const folder = custom || path.join(
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
              path.join(os.tmpdir()),
            ".dev-browser-panel",
            "downloads",
          );
          void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(folder));
        }
      }
    });

    // Push current state to newly opened view
    this.pushAll();

    webviewView.onDidDispose(() => {
      this.view = null;
    });
  }

  attachSession(session: Session): void {
    this.teardown();
    const cdp = session.getCDP();
    if (!cdp) return;
    this.cdpRef = cdp;

    const workspaceDir =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      path.join(os.tmpdir(), "dev-browser-panel");
    const dlPath = getDownloadPath(workspaceDir);

    // Set download behavior (best-effort; some Chromium builds may not support this)
    cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dlPath }).catch(() => undefined);

    const onWillBegin = (ev: CDPEvent): void => {
      const p = ev.params as {
        guid?: string;
        url?: string;
        suggestedFilename?: string;
      };
      if (!p.guid) return;
      const item: DownloadItem = {
        guid: p.guid,
        url: p.url ?? "",
        filename: p.suggestedFilename ?? path.basename(p.url ?? "download"),
        state: "downloading",
        receivedBytes: 0,
        totalBytes: 0,
        timestamp: Date.now(),
      };
      this.downloads.set(p.guid, item);
      this.pushItem(item);
    };

    const onProgress = (ev: CDPEvent): void => {
      const p = ev.params as {
        guid?: string;
        receivedBytes?: number;
        totalBytes?: number;
        state?: string;
      };
      if (!p.guid) return;
      const item = this.downloads.get(p.guid);
      if (!item) return;
      item.receivedBytes = p.receivedBytes ?? item.receivedBytes;
      item.totalBytes = p.totalBytes ?? item.totalBytes;
      if (p.state === "completed") {
        item.state = "complete";
        const sizeKb = Math.round(item.totalBytes / 1024);
        vscode.window
          .showInformationMessage(`Downloaded ${item.filename} (${sizeKb} KB)`, "Open Folder")
          .then((sel) => {
            if (sel === "Open Folder") {
              const folder = getDownloadPath(
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
                  path.join(os.tmpdir()),
              );
              void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(folder));
            }
          }, () => undefined);
      } else if (p.state === "canceled") {
        item.state = "failed";
      }
      this.pushItem(item);
    };

    this.onWillBeginRef = onWillBegin;
    this.onProgressRef = onProgress;
    cdp.on("Page.downloadWillBegin", onWillBegin);
    cdp.on("Page.downloadProgress", onProgress);

    session.once("stopped", () => this.teardown());
  }

  private teardown(): void {
    if (this.cdpRef) {
      if (this.onWillBeginRef) this.cdpRef.off("Page.downloadWillBegin", this.onWillBeginRef);
      if (this.onProgressRef) this.cdpRef.off("Page.downloadProgress", this.onProgressRef);
    }
    this.cdpRef = null;
    this.onWillBeginRef = null;
    this.onProgressRef = null;
  }

  private pushItem(item: DownloadItem): void {
    this.view?.webview.postMessage({ type: "download-item", item });
  }

  private pushAll(): void {
    for (const item of this.downloads.values()) {
      this.pushItem(item);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "media")),
    );
    const csp = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp}; img-src ${csp} data:;">
<link rel="stylesheet" href="${mediaUri}/downloads.css">
<title>Downloads</title>
</head>
<body>
<div id="toolbar">
  <span>Downloads</span>
  <button id="btn-clear">Clear</button>
</div>
<div id="downloads-list"></div>
<script src="${mediaUri}/downloads.js"></script>
</body>
</html>`;
  }
}
