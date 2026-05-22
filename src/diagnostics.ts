import * as vscode from "vscode";
import * as path from "path";
import { DiagnosticsData } from "./viewer";

export class DiagnosticsPanel {
  private static currentPanel: DiagnosticsPanel | null = null;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, data: DiagnosticsData): DiagnosticsPanel {
    if (DiagnosticsPanel.currentPanel) {
      DiagnosticsPanel.currentPanel.update(data);
      DiagnosticsPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      return DiagnosticsPanel.currentPanel;
    }
    const panel = vscode.window.createWebviewPanel(
      "devBrowserDiagnostics",
      "Browser Diagnostics",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "media"))],
      },
    );
    const dp = new DiagnosticsPanel(context, panel, data);
    DiagnosticsPanel.currentPanel = dp;
    return dp;
  }

  private constructor(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    data: DiagnosticsData,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(context, data);

    this.panel.webview.onDidReceiveMessage(
      (msg: { type?: string }) => {
        if (msg?.type === "copy") {
          void vscode.env.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => {
            vscode.window.showInformationMessage("Diagnostics copied to clipboard.");
          });
        }
      },
      null,
      this.disposables,
    );

    this.panel.onDidDispose(
      () => {
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
        DiagnosticsPanel.currentPanel = null;
      },
      null,
      this.disposables,
    );
  }

  update(data: DiagnosticsData): void {
    this.panel.webview.postMessage({ type: "update", data });
  }

  private getHtml(context: vscode.ExtensionContext, data: DiagnosticsData): string {
    const mediaUri = vscode.Uri.file(path.join(context.extensionPath, "media"));
    const base = this.panel.webview.asWebviewUri(mediaUri);
    const csp = this.panel.webview.cspSource;
    const rows = Object.entries(data)
      .map(([k, v]) => `<tr><td>${k}</td><td>${String(v)}</td></tr>`)
      .join("\n");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp}; img-src ${csp} data:;">
<link rel="stylesheet" href="${base}/diagnostics.css">
<title>Browser Diagnostics</title>
</head>
<body>
<h2>Render Diagnostics</h2>
<div id="toolbar">
  <button id="btn-copy">Copy to Clipboard</button>
</div>
<table id="diag-table">
<thead><tr><th>Property</th><th>Value</th></tr></thead>
<tbody id="diag-body">
${rows}
</tbody>
</table>
<script src="${base}/diagnostics.js"></script>
</body>
</html>`;
  }
}
