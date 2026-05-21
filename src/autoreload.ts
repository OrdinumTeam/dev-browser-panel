import * as vscode from "vscode";
import { Session } from "./session";

export class Autoreload {
  private watcher: vscode.FileSystemWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled: boolean;
  private statusItem: vscode.StatusBarItem;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: Session,
  ) {
    this.enabled = context.workspaceState.get<boolean>("devBrowserPanel.autoreload", false);
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
    this.statusItem.command = "devBrowserPanel.toggleAutoreload";
    this.statusItem.tooltip = "Toggle Dev Browser autoreload";
    this.updateStatusItem();
    this.statusItem.show();
    context.subscriptions.push(this.statusItem);
  }

  start(): void {
    const cfg = vscode.workspace.getConfiguration("devBrowserPanel");
    const glob = cfg.get<string>(
      "autoreloadGlob",
      "**/*.{html,htm,css,scss,sass,less,js,mjs,cjs,jsx,ts,tsx,vue,svelte}",
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(glob);
    const trigger = (): void => this.scheduleReload();
    this.watcher.onDidChange(trigger);
    this.watcher.onDidCreate(trigger);
    this.watcher.onDidDelete(trigger);
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
    this.statusItem.hide();
  }

  toggle(): void {
    this.enabled = !this.enabled;
    void this.context.workspaceState.update("devBrowserPanel.autoreload", this.enabled);
    this.updateStatusItem();
    vscode.window.setStatusBarMessage(
      `Dev Browser autoreload: ${this.enabled ? "ON" : "OFF"}`,
      2000,
    );
  }

  private scheduleReload(): void {
    if (!this.enabled) return;
    const cfg = vscode.workspace.getConfiguration("devBrowserPanel");
    const debounceMs = cfg.get<number>("autoreloadDebounceMs", 350);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.session.activeTargetId) {
        this.session.reload(this.session.activeTargetId).catch(() => undefined);
      }
    }, debounceMs);
  }

  private updateStatusItem(): void {
    this.statusItem.text = this.enabled ? "$(sync~spin) Autoreload" : "$(sync) Autoreload";
  }
}
