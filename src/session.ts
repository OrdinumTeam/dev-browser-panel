import { EventEmitter } from "events";
import { CDPClient, CDPEvent } from "./cdp";
import {
  BrowserHandle,
  launchChromium,
  findChromiumBinary,
  findFreePort,
  claimProfileDir,
  writeProfileOwner,
  removeProfileOwner,
  writeInstancePortFile,
  claimGlobalPortFile,
  removeInstancePortFile,
  releaseGlobalPortFile,
} from "./chromium";

export interface TargetInfo {
  targetId: string;
  sessionId?: string;
  url: string;
  title: string;
  type: string;
}

export interface JsDialog {
  targetId: string | null;
  sessionId: string;
  dialogType: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt: string;
  url: string;
}

export interface SessionOptions {
  port: number;
  startUrl: string;
  viewport: { width: number; height: number };
  chromiumPath?: string;
  workspaceDir: string;
}

/** Dialogs the user never answers get a default response so the page unfreezes. */
const DIALOG_FALLBACK_MS = 60_000;

/**
 * Owns the Chromium process and its CDP browser-level connection. Tracks all
 * page targets (tabs) and dispatches events as they're created/destroyed.
 * Survives the unexpected: process exit and CDP disconnect both surface as a
 * single `stopped` event, JS dialogs are always answered (never a frozen tab),
 * and crashed targets are reported for recovery.
 */
export class Session extends EventEmitter {
  private chromium: BrowserHandle | null = null;
  private cdp: CDPClient | null = null;
  public targets = new Map<string, TargetInfo>();
  public activeTargetId: string | null = null;
  public allocatedPort: number = 0;
  public profilePath: string = "";
  public ownsGlobalPortFile: boolean = false;
  private stopped = false;
  private dialogTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private opts: SessionOptions) {
    super();
  }

  async start(): Promise<void> {
    const binary = findChromiumBinary(this.opts.chromiumPath);
    if (!binary) {
      throw new Error(
        "Chromium binary not found. Install via `npx playwright install chromium` or set `devBrowserPanel.chromiumPath`.",
      );
    }
    const port = await findFreePort(this.opts.port);
    this.allocatedPort = port;
    const userDataDir = claimProfileDir(this.opts.workspaceDir);
    this.profilePath = userDataDir;
    this.chromium = await launchChromium({
      binary,
      port,
      startUrl: this.opts.startUrl,
      userDataDir,
      viewport: this.opts.viewport,
    });
    writeProfileOwner(userDataDir, this.chromium.process.pid ?? 0);

    this.chromium.process.on("exit", () => {
      this.handleUnexpectedStop("Chromium process exited");
    });

    writeInstancePortFile(this.opts.workspaceDir, port);
    this.ownsGlobalPortFile = claimGlobalPortFile(port, this.opts.workspaceDir);

    this.cdp = new CDPClient();
    await this.cdp.connect(this.chromium.wsEndpoint);

    this.cdp.on("disconnected", () => {
      this.handleUnexpectedStop("CDP connection lost");
    });

    this.cdp.on("Target.targetCreated", (ev: CDPEvent) => this.onTargetCreated(ev));
    this.cdp.on("Target.targetDestroyed", (ev: CDPEvent) => this.onTargetDestroyed(ev));
    this.cdp.on("Target.targetInfoChanged", (ev: CDPEvent) => this.onTargetInfoChanged(ev));
    this.cdp.on("Target.attachedToTarget", (ev: CDPEvent) => this.onAttachedToTarget(ev));
    this.cdp.on("Page.javascriptDialogOpening", (ev: CDPEvent) => this.onDialogOpening(ev));
    this.cdp.on("Page.javascriptDialogClosed", (ev: CDPEvent) => this.onDialogClosed(ev));
    this.cdp.on("Inspector.targetCrashed", (ev: CDPEvent) => this.onTargetCrashed(ev));

    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    await this.cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });

    // Wait briefly then enumerate existing targets, attaching to any we missed.
    await new Promise((r) => setTimeout(r, 300));
    const { targetInfos } = await this.cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    for (const t of targetInfos) {
      if (t.type !== "page") continue;
      if (!this.targets.has(t.targetId)) {
        this.targets.set(t.targetId, t);
        try {
          await this.cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
        } catch { /* may already be attached */ }
      }
    }

    if (!this.activeTargetId) {
      const firstPage = Array.from(this.targets.values()).find((t) => t.type === "page");
      if (firstPage) this.activeTargetId = firstPage.targetId;
    }
    this.emit("targets-changed");
  }

  private onTargetCreated(ev: CDPEvent): void {
    const t = ev.params.targetInfo as TargetInfo;
    if (t.type !== "page") return;
    this.targets.set(t.targetId, t);
    if (!this.activeTargetId) this.activeTargetId = t.targetId;
    this.emit("targets-changed");
  }

  private onTargetDestroyed(ev: CDPEvent): void {
    const id = ev.params.targetId as string;
    if (!this.targets.has(id)) return;
    this.targets.delete(id);
    if (this.activeTargetId === id) {
      const next = this.targets.keys().next().value;
      this.activeTargetId = next ?? null;
      this.emit("active-changed", this.activeTargetId);
    }
    this.emit("targets-changed");
  }

  private onTargetInfoChanged(ev: CDPEvent): void {
    const t = ev.params.targetInfo as TargetInfo;
    const prev = this.targets.get(t.targetId);
    if (!prev) return;
    this.targets.set(t.targetId, { ...prev, url: t.url, title: t.title });
    this.emit("targets-changed");
  }

  private onAttachedToTarget(ev: CDPEvent): void {
    const sessionId = ev.params.sessionId as string;
    const targetInfo = ev.params.targetInfo as TargetInfo;
    if (targetInfo.type !== "page") return;
    const merged: TargetInfo = { ...targetInfo, sessionId };
    this.targets.set(targetInfo.targetId, merged);
    // Page domain on every tab: loading events for the viewer and — critically —
    // javascriptDialogOpening. An unanswered dialog freezes its tab forever.
    if (this.cdp) {
      this.cdp.send("Page.enable", {}, sessionId).catch(() => undefined);
    }
    this.emit("attached", { targetId: targetInfo.targetId, sessionId });
    this.emit("targets-changed");
  }

  private targetIdForSession(sessionId: string | undefined): string | null {
    if (!sessionId) return null;
    for (const t of this.targets.values()) {
      if (t.sessionId === sessionId) return t.targetId;
    }
    return null;
  }

  private onDialogOpening(ev: CDPEvent): void {
    const sessionId = ev.sessionId;
    if (!sessionId) return;
    const p = ev.params as { url?: string; message?: string; type?: string; defaultPrompt?: string };
    const dialog: JsDialog = {
      targetId: this.targetIdForSession(sessionId),
      sessionId,
      dialogType: (p.type as JsDialog["dialogType"]) ?? "alert",
      message: p.message ?? "",
      defaultPrompt: p.defaultPrompt ?? "",
      url: p.url ?? "",
    };

    if (dialog.dialogType === "alert" || dialog.dialogType === "beforeunload") {
      // Nothing to decide — answer immediately so the page never blocks.
      void this.answerDialog(sessionId, true);
      this.emit("dialog", dialog, /* alreadyAnswered */ true);
      return;
    }

    // confirm/prompt: let the UI ask the user, but never hang forever.
    const timer = setTimeout(() => {
      void this.answerDialog(sessionId, false);
    }, DIALOG_FALLBACK_MS);
    this.dialogTimers.set(sessionId, timer);
    this.emit("dialog", dialog, false);
  }

  private onDialogClosed(ev: CDPEvent): void {
    if (ev.sessionId) this.clearDialogTimer(ev.sessionId);
  }

  private clearDialogTimer(sessionId: string): void {
    const timer = this.dialogTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.dialogTimers.delete(sessionId);
    }
  }

  async answerDialog(sessionId: string, accept: boolean, promptText?: string): Promise<void> {
    this.clearDialogTimer(sessionId);
    if (!this.cdp) return;
    const params: Record<string, unknown> = { accept };
    if (promptText !== undefined) params.promptText = promptText;
    try {
      await this.cdp.send("Page.handleJavaScriptDialog", params, sessionId);
    } catch { /* dialog may already be gone */ }
  }

  private onTargetCrashed(ev: CDPEvent): void {
    const targetId = this.targetIdForSession(ev.sessionId);
    if (!targetId) return;
    const target = this.targets.get(targetId);
    this.emit("target-crashed", { targetId, url: target?.url ?? "" });
  }

  /** Reload a crashed tab: Page.reload usually revives a dead renderer; fall back to re-navigating. */
  async recoverTarget(targetId: string): Promise<void> {
    const t = this.targets.get(targetId);
    if (!t || !t.sessionId || !this.cdp) return;
    try {
      await this.cdp.send("Page.reload", { ignoreCache: false }, t.sessionId);
    } catch {
      if (t.url) {
        await this.cdp.send("Page.navigate", { url: t.url }, t.sessionId).catch(() => undefined);
      }
    }
  }

  getCDP(): CDPClient | null {
    return this.cdp;
  }

  isRunning(): boolean {
    return !this.stopped && !!this.cdp?.isConnected();
  }

  setActive(targetId: string): void {
    if (this.targets.has(targetId)) {
      this.activeTargetId = targetId;
      this.emit("active-changed", targetId);
    }
  }

  async createNewTab(url: string = "about:blank"): Promise<string> {
    if (!this.cdp) throw new Error("Not connected");
    const { targetId } = await this.cdp.send<{ targetId: string }>("Target.createTarget", { url });
    if (!this.targets.has(targetId)) {
      this.targets.set(targetId, { targetId, url, title: "", type: "page" });
    }
    // Chrome-like: a freshly created tab becomes the active one.
    this.activeTargetId = targetId;
    this.emit("active-changed", targetId);
    this.emit("targets-changed");
    return targetId;
  }

  async closeTab(targetId: string): Promise<void> {
    if (!this.cdp) return;
    // Closing the last tab would leave a running browser with nothing to show.
    // Chrome opens a fresh tab; we do the same.
    const pages = Array.from(this.targets.values()).filter((t) => t.type === "page");
    if (pages.length <= 1) {
      await this.createNewTab("about:blank");
    }
    await this.cdp.send("Target.closeTarget", { targetId });
  }

  async navigate(targetId: string, url: string): Promise<void> {
    const t = this.targets.get(targetId);
    if (!t || !t.sessionId || !this.cdp) return;
    await this.cdp.send("Page.navigate", { url }, t.sessionId);
  }

  async reload(targetId: string, ignoreCache: boolean = false): Promise<void> {
    const t = this.targets.get(targetId);
    if (!t || !t.sessionId || !this.cdp) return;
    await this.cdp.send("Page.reload", { ignoreCache }, t.sessionId);
  }

  async stopLoading(targetId: string): Promise<void> {
    const t = this.targets.get(targetId);
    if (!t || !t.sessionId || !this.cdp) return;
    await this.cdp.send("Page.stopLoading", {}, t.sessionId);
  }

  private async getNavHistory(
    sessionId: string,
  ): Promise<{ currentIndex: number; entries: Array<{ id: number; url: string }> } | null> {
    if (!this.cdp) return null;
    try {
      return await this.cdp.send("Page.getNavigationHistory", {}, sessionId);
    } catch {
      return null;
    }
  }

  /** Real history navigation (works cross-origin, unlike history.back() evaluate hacks). */
  async goBack(targetId: string): Promise<void> {
    const t = this.targets.get(targetId);
    if (!t?.sessionId || !this.cdp) return;
    const hist = await this.getNavHistory(t.sessionId);
    if (!hist || hist.currentIndex <= 0) return;
    const entry = hist.entries[hist.currentIndex - 1];
    await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, t.sessionId);
  }

  async goForward(targetId: string): Promise<void> {
    const t = this.targets.get(targetId);
    if (!t?.sessionId || !this.cdp) return;
    const hist = await this.getNavHistory(t.sessionId);
    if (!hist || hist.currentIndex >= hist.entries.length - 1) return;
    const entry = hist.entries[hist.currentIndex + 1];
    await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, t.sessionId);
  }

  async getNavState(targetId: string): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
    const t = this.targets.get(targetId);
    if (!t?.sessionId) return { canGoBack: false, canGoForward: false };
    const hist = await this.getNavHistory(t.sessionId);
    if (!hist) return { canGoBack: false, canGoForward: false };
    return {
      canGoBack: hist.currentIndex > 0,
      canGoForward: hist.currentIndex < hist.entries.length - 1,
    };
  }

  /** URLs of open tabs, for session restore. */
  listTabUrls(): string[] {
    return Array.from(this.targets.values())
      .filter((t) => t.type === "page")
      .map((t) => t.url);
  }

  private cleanupFiles(): void {
    removeInstancePortFile(this.opts.workspaceDir);
    if (this.allocatedPort && this.ownsGlobalPortFile) releaseGlobalPortFile(this.allocatedPort);
    if (this.profilePath) removeProfileOwner(this.profilePath);
  }

  /** Chromium died or CDP dropped without us asking — surface it exactly once. */
  private handleUnexpectedStop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cleanupFiles();
    for (const timer of this.dialogTimers.values()) clearTimeout(timer);
    this.dialogTimers.clear();
    if (this.cdp) {
      this.cdp.close();
      this.cdp = null;
    }
    if (this.chromium) {
      try { this.chromium.process.kill("SIGKILL"); } catch { /* ignore */ }
      this.chromium = null;
    }
    this.targets.clear();
    this.activeTargetId = null;
    this.emit("stopped", reason);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cleanupFiles();
    for (const timer of this.dialogTimers.values()) clearTimeout(timer);
    this.dialogTimers.clear();
    if (this.cdp) {
      this.cdp.close();
      this.cdp = null;
    }
    if (this.chromium) {
      try {
        this.chromium.process.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
        if (this.chromium.process.exitCode === null && !this.chromium.process.killed) {
          this.chromium.process.kill("SIGKILL");
        }
      } catch { /* ignore */ }
      this.chromium = null;
    }
    this.targets.clear();
    this.activeTargetId = null;
    this.emit("stopped", "stopped by user");
  }
}
