import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { Session, JsDialog } from "./session";
import { ViewerPanel } from "./viewer";
import { LogsPanel } from "./logs";
import { DownloadsPanel } from "./downloads";
import { StoragePanel } from "./storage";
import { DiagnosticsPanel } from "./diagnostics";
import { Autoreload } from "./autoreload";

let session: Session | null = null;
let autoreload: Autoreload | null = null;
let statusItem: vscode.StatusBarItem;
let logsProvider: LogsPanel;
let downloadsProvider: DownloadsPanel;
let storageProvider: StoragePanel;
let saveTabsTimer: ReturnType<typeof setTimeout> | null = null;

const SAVED_TABS_KEY = "devBrowserPanel.savedTabs";

function getWorkspaceDir(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0].uri.fsPath;
  return path.join(os.tmpdir(), `dev-browser-panel-${process.pid}`);
}

function isRestorableUrl(url: string): boolean {
  return /^(https?|file):/i.test(url);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusItem.command = "devBrowserPanel.open";
  statusItem.text = "$(globe) Browser OFF";
  statusItem.tooltip = "Open Dev Browser Panel";
  statusItem.show();
  context.subscriptions.push(statusItem);

  logsProvider = new LogsPanel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("devBrowserPanel.logsView", logsProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  downloadsProvider = new DownloadsPanel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("devBrowserPanel.downloadsView", downloadsProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  storageProvider = new StoragePanel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("devBrowserPanel.storageView", storageProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  function setStatusRunning(s: Session): void {
    statusItem.text = `$(globe) Browser :${s.allocatedPort}`;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Dev Browser Panel**\n\n`);
    md.appendMarkdown(`- CDP port: \`${s.allocatedPort}\`\n`);
    md.appendMarkdown(`- Profile: \`${s.profilePath}\`\n`);
    md.appendMarkdown(
      `- Global port file: ${s.ownsGlobalPortFile ? "owned by this window" : "owned by another window — use the workspace port file"}\n`,
    );
    md.appendMarkdown(`\nCLI: \`dev-browser --connect http://127.0.0.1:${s.allocatedPort}\``);
    statusItem.tooltip = md;
  }

  function setStatusStopped(): void {
    statusItem.text = "$(globe) Browser OFF";
    statusItem.tooltip = "Open Dev Browser Panel";
  }

  // --- JS dialogs: a page calling alert/confirm/prompt must never freeze a tab.
  let alertToastCount = 0;
  let alertToastWindowStart = 0;
  function onDialog(s: Session, dialog: JsDialog, alreadyAnswered: boolean): void {
    const shortMsg = dialog.message.length > 300 ? `${dialog.message.slice(0, 300)}…` : dialog.message;
    if (alreadyAnswered) {
      // alert/beforeunload — auto-accepted by the session; just inform (rate-limited).
      if (dialog.dialogType === "alert") {
        const now = Date.now();
        if (now - alertToastWindowStart > 10_000) {
          alertToastWindowStart = now;
          alertToastCount = 0;
        }
        if (++alertToastCount <= 3) {
          vscode.window.showInformationMessage(`Page alert: ${shortMsg}`);
        }
      }
      return;
    }
    if (dialog.dialogType === "confirm") {
      void vscode.window
        .showWarningMessage(`Page asks: ${shortMsg}`, { modal: true }, "OK")
        .then((sel) => s.answerDialog(dialog.sessionId, sel === "OK"));
    } else if (dialog.dialogType === "prompt") {
      void vscode.window
        .showInputBox({
          title: "Page prompt",
          prompt: shortMsg,
          value: dialog.defaultPrompt,
          ignoreFocusOut: true,
        })
        .then((value) =>
          s.answerDialog(dialog.sessionId, value !== undefined, value),
        );
    }
  }

  function scheduleSaveTabs(s: Session): void {
    if (saveTabsTimer) clearTimeout(saveTabsTimer);
    saveTabsTimer = setTimeout(() => {
      saveTabsTimer = null;
      if (!s.isRunning()) return;
      const urls = s.listTabUrls().filter(isRestorableUrl);
      void context.workspaceState.update(SAVED_TABS_KEY, urls);
    }, 1500);
  }

  async function restoreTabs(s: Session): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("devBrowserPanel");
    if (!cfg.get<boolean>("restoreTabs", true)) return;
    const saved = context.workspaceState.get<string[]>(SAVED_TABS_KEY, []).filter(isRestorableUrl);
    if (saved.length === 0) return;
    try {
      const firstTarget = s.activeTargetId;
      if (firstTarget) {
        // navigate() needs the CDP attach to have completed for this target.
        for (let i = 0; i < 30 && !s.targets.get(firstTarget)?.sessionId; i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
        await s.navigate(firstTarget, saved[0]);
      }
      for (const url of saved.slice(1)) {
        await s.createNewTab(url);
      }
      if (firstTarget) s.setActive(firstTarget);
    } catch { /* best effort */ }
  }

  async function ensureSession(): Promise<Session | null> {
    if (session) return session;
    const cfg = vscode.workspace.getConfiguration("devBrowserPanel");
    const startPort = cfg.get<number>("cdpPort", 9333);
    const newSession = new Session({
      port: startPort,
      startUrl: cfg.get<string>("startUrl", "about:blank"),
      viewport: cfg.get("viewport", { width: 1280, height: 800 }),
      chromiumPath: cfg.get<string>("chromiumPath") || undefined,
      workspaceDir: getWorkspaceDir(),
    });
    try {
      await newSession.start();
      session = newSession;
      setStatusRunning(newSession);

      newSession.once("stopped", (reason?: string) => {
        setStatusStopped();
        const wasCurrent = session === newSession;
        if (wasCurrent) {
          session = null;
          if (autoreload) {
            autoreload.stop();
            autoreload = null;
          }
        }
        if (reason && reason !== "stopped by user") {
          void vscode.window
            .showWarningMessage(`Dev Browser stopped: ${reason}`, "Restart")
            .then((sel) => {
              if (sel === "Restart") void vscode.commands.executeCommand("devBrowserPanel.open");
            });
        }
      });

      newSession.on("dialog", (dialog: JsDialog, alreadyAnswered: boolean) => {
        onDialog(newSession, dialog, alreadyAnswered);
      });

      newSession.on("target-crashed", (info: { targetId: string; url: string }) => {
        void vscode.window
          .showWarningMessage(`Browser tab crashed${info.url ? `: ${info.url}` : ""}`, "Reload Tab")
          .then((sel) => {
            if (sel === "Reload Tab") void newSession.recoverTarget(info.targetId);
          });
      });

      newSession.on("targets-changed", () => scheduleSaveTabs(newSession));

      logsProvider.attachSession(session);
      downloadsProvider.attachSession(session);
      await restoreTabs(newSession);
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
      const cfg = vscode.workspace.getConfiguration("devBrowserPanel");
      if (cfg.get<boolean>("autoOpenLogs", false)) {
        await vscode.commands.executeCommand("devBrowserPanel.logsView.focus");
      }
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

    vscode.commands.registerCommand("devBrowserPanel.goBack", async () => {
      if (!session?.activeTargetId) return;
      await session.goBack(session.activeTargetId);
    }),

    vscode.commands.registerCommand("devBrowserPanel.goForward", async () => {
      if (!session?.activeTargetId) return;
      await session.goForward(session.activeTargetId);
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

    vscode.commands.registerCommand("devBrowserPanel.showDownloads", async () => {
      await vscode.commands.executeCommand("devBrowserPanel.downloadsView.focus");
    }),

    vscode.commands.registerCommand("devBrowserPanel.takeScreenshot", async () => {
      const v = ViewerPanel.getInstance();
      if (!v) { vscode.window.showWarningMessage("Open Dev Browser Panel first."); return; }
      await v.takeScreenshot(false);
    }),

    vscode.commands.registerCommand("devBrowserPanel.takeFullPageScreenshot", async () => {
      const v = ViewerPanel.getInstance();
      if (!v) { vscode.window.showWarningMessage("Open Dev Browser Panel first."); return; }
      await v.takeScreenshot(true);
    }),

    vscode.commands.registerCommand("devBrowserPanel.printToPDF", async () => {
      const v = ViewerPanel.getInstance();
      if (!v) { vscode.window.showWarningMessage("Open Dev Browser Panel first."); return; }
      await v.printToPDF();
    }),

    vscode.commands.registerCommand("devBrowserPanel.viewSource", async () => {
      const v = ViewerPanel.getInstance();
      if (!v) { vscode.window.showWarningMessage("Open Dev Browser Panel first."); return; }
      await v.viewSource();
    }),

    vscode.commands.registerCommand("devBrowserPanel.toggleMobileEmulation", async () => {
      const v = ViewerPanel.getInstance();
      if (!v) { vscode.window.showWarningMessage("Open Dev Browser Panel first."); return; }
      await v.toggleMobileEmulation();
    }),

    vscode.commands.registerCommand("devBrowserPanel.find", () => {
      const v = ViewerPanel.getInstance();
      if (!v) { vscode.window.showWarningMessage("Open Dev Browser Panel first."); return; }
      v.triggerFind();
    }),

    vscode.commands.registerCommand("devBrowserPanel.inspectElement", async () => {
      const v = ViewerPanel.getInstance();
      if (!v) { vscode.window.showWarningMessage("Open Dev Browser Panel first."); return; }
      await v.toggleInspectMode();
    }),

    vscode.commands.registerCommand("devBrowserPanel.showStorage", async () => {
      const v = ViewerPanel.getInstance();
      if (!v) { vscode.window.showWarningMessage("Open Dev Browser Panel first."); return; }
      await v.refreshStorage(storageProvider);
    }),

    vscode.commands.registerCommand("devBrowserPanel.showRenderDiagnostics", () => {
      const v = ViewerPanel.getInstance();
      if (!v) { vscode.window.showWarningMessage("Open Dev Browser Panel first."); return; }
      DiagnosticsPanel.show(context, v.getDiagnosticsData());
    }),
  );
}

export async function deactivate(): Promise<void> {
  if (saveTabsTimer) clearTimeout(saveTabsTimer);
  if (autoreload) autoreload.stop();
  if (session) await session.stop();
}
