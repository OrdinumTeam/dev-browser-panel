import * as vscode from "vscode";
import * as path from "path";
import { Session } from "./session";

interface CookieData {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
}

interface StorageData {
  cookies: CookieData[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

export class StoragePanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media"))],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.onDidDispose(() => {
      this.view = null;
    });
  }

  async refresh(session: Session, sessionId: string): Promise<void> {
    const cdp = session.getCDP();
    if (!cdp || !this.view) return;

    let cookies: CookieData[] = [];
    let localStorageData: Record<string, string> = {};
    let sessionStorageData: Record<string, string> = {};

    try {
      const cookieResult = await cdp.send<{ cookies?: CookieData[] }>(
        "Network.getAllCookies",
        {},
      );
      cookies = cookieResult?.cookies ?? [];
    } catch { /* ignore */ }

    try {
      const lsResult = await cdp.send<{ result?: { value?: string } }>(
        "Runtime.evaluate",
        {
          expression: "JSON.stringify(Object.fromEntries(Object.entries(localStorage)))",
          returnByValue: true,
        },
        sessionId,
      );
      if (lsResult?.result?.value) {
        localStorageData = JSON.parse(lsResult.result.value) as Record<string, string>;
      }
    } catch { /* ignore */ }

    try {
      const ssResult = await cdp.send<{ result?: { value?: string } }>(
        "Runtime.evaluate",
        {
          expression: "JSON.stringify(Object.fromEntries(Object.entries(sessionStorage)))",
          returnByValue: true,
        },
        sessionId,
      );
      if (ssResult?.result?.value) {
        sessionStorageData = JSON.parse(ssResult.result.value) as Record<string, string>;
      }
    } catch { /* ignore */ }

    const data: StorageData = {
      cookies,
      localStorage: localStorageData,
      sessionStorage: sessionStorageData,
    };

    this.view.webview.postMessage({ type: "storage-data", data });
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
<link rel="stylesheet" href="${mediaUri}/storage.css">
<title>Storage</title>
</head>
<body>
<div id="tabs-nav">
  <button class="tab-btn active" data-tab="cookies">Cookies</button>
  <button class="tab-btn" data-tab="localStorage">LocalStorage</button>
  <button class="tab-btn" data-tab="sessionStorage">SessionStorage</button>
</div>
<div id="content"></div>
<script src="${mediaUri}/storage.js"></script>
</body>
</html>`;
  }
}
