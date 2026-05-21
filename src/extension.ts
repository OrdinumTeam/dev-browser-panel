import * as vscode from "vscode";
import { Session } from "./session";
import { ViewerPanel } from "./viewer";
import { LogsPanel } from "./logs";
import { Autoreload } from "./autoreload";

let session: Session | null = null;
let autoreload: Autoreload | null = null;
let statusItem: vscode.StatusBarItem;
let logsProvider: LogsPanel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusItem.command = "devBrowserPanel.open";
  statusItem.text = "$(globe) Browser OFF";
  statusItem.show();
  context.subscriptions.push(statusItem);

  logsProvider = new LogsPanel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("devBrowserPanel.logsView", logsProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  async function ensureSession(): Promise<Session | null> {
    if (session) return session;
    const cfg = vscode.workspace.getConfiguration("devBrowserPanel");
    const port = cfg.get<number>("cdpPort", 9333);
    const newSession = new Session({
      port,
      startUrl: cfg.get<string>("startUrl", "about:blank"),
      viewport: cfg.get("viewport", { width: 1280, height: 800 }),
      chromiumPath: cfg.get<string>("chromiumPath") || undefined,
    });
    try {
      await newSession.start();
      session = newSession;
      statusItem.text = `$(globe) Browser :${port}`;
      session.once("stopped", () => {
        statusItem.text = "$(globe) Browser OFF";
        session = null;
        autoreload = null;
      });
      logsProvider.attachSession(session);
      return session;
    } catch (e) {
      vscode.window.showErrorMessage(`Dev Browser Panel: ${(e as Error).message}`);
      return null;
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("devBrowserPanel.open", async () => {
      const s = await ensureSession();
      if (!s) return;
      ViewerPanel.create(context, s);
      await vscode.commands.executeCommand("devBrowserPanel.logsView.focus");
      if (!autoreload) {
        autoreload = new Autoreload(context, s);
        autoreload.start();
      }
    }),

    vscode.commands.registerCommand("devBrowserPanel.newTab", async () => {
      const s = await ensureSession();
      if (!s) return;
      const url = await vscode.window.showInputBox({
        prompt: "URL for new tab",
        value: "about:blank",
        placeHolder: "https://example.com",
      });
      if (url !== undefined) await s.createNewTab(url || "about:blank");
    }),

    vscode.commands.registerCommand("devBrowserPanel.reload", async () => {
      if (!session?.activeTargetId) {
        vscode.window.showWarningMessage("No active browser tab.");
        return;
      }
      await session.reload(session.activeTargetId);
    }),

    vscode.commands.registerCommand("devBrowserPanel.toggleAutoreload", () => {
      if (!autoreload) {
        vscode.window.showWarningMessage("Open Dev Browser Panel first.");
        return;
      }
      autoreload.toggle();
    }),

    vscode.commands.registerCommand("devBrowserPanel.showLogs", async () => {
      await vscode.commands.executeCommand("devBrowserPanel.logsView.focus");
    }),

    vscode.commands.registerCommand("devBrowserPanel.stopChromium", async () => {
      if (!session) {
        vscode.window.showInformationMessage("Browser is already stopped.");
        return;
      }
      if (autoreload) {
        autoreload.stop();
        autoreload = null;
      }
      await session.stop();
    }),
  );
}

export async function deactivate(): Promise<void> {
  if (autoreload) autoreload.stop();
  if (session) await session.stop();
}
