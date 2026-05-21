import { EventEmitter } from "events";
import { CDPClient, CDPEvent } from "./cdp";
import {
  BrowserHandle,
  launchChromium,
  findChromiumBinary,
  findFreePort,
  profileDir,
  writeInstancePortFile,
  writeGlobalPortFile,
  removeInstancePortFile,
  removeGlobalPortFileIfMatches,
} from "./chromium";

export interface TargetInfo {
  targetId: string;
  sessionId?: string;
  url: string;
  title: string;
  type: string;
}

export interface SessionOptions {
  port: number;
  startUrl: string;
  viewport: { width: number; height: number };
  chromiumPath?: string;
  workspaceDir: string;
}

/**
 * Owns the Chromium process and its CDP browser-level connection. Tracks all
 * page targets (tabs) and dispatches events as they're created/destroyed.
 */
export class Session extends EventEmitter {
  private chromium: BrowserHandle | null = null;
  private cdp: CDPClient | null = null;
  public targets = new Map<string, TargetInfo>();
  public activeTargetId: string | null = null;
  public allocatedPort: number = 0;

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
    const userDataDir = profileDir(this.opts.workspaceDir);
    this.chromium = await launchChromium({
      binary,
      port,
      startUrl: this.opts.startUrl,
      userDataDir,
      viewport: this.opts.viewport,
    });

    writeInstancePortFile(this.opts.workspaceDir, port);
    writeGlobalPortFile(port, this.opts.workspaceDir);

    this.cdp = new CDPClient();
    await this.cdp.connect(this.chromium.wsEndpoint);

    this.cdp.on("Target.targetCreated", (ev: CDPEvent) => this.onTargetCreated(ev));
    this.cdp.on("Target.targetDestroyed", (ev: CDPEvent) => this.onTargetDestroyed(ev));
    this.cdp.on("Target.targetInfoChanged", (ev: CDPEvent) => this.onTargetInfoChanged(ev));
    this.cdp.on("Target.attachedToTarget", (ev: CDPEvent) => this.onAttachedToTarget(ev));

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
    this.emit("attached", { targetId: targetInfo.targetId, sessionId });
    this.emit("targets-changed");
  }

  getCDP(): CDPClient | null {
    return this.cdp;
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
    return targetId;
  }

  async closeTab(targetId: string): Promise<void> {
    if (!this.cdp) return;
    await this.cdp.send("Target.closeTarget", { targetId });
  }

  async navigate(targetId: string, url: string): Promise<void> {
    const t = this.targets.get(targetId);
    if (!t || !t.sessionId || !this.cdp) return;
    await this.cdp.send("Page.navigate", { url }, t.sessionId);
  }

  async reload(targetId: string): Promise<void> {
    const t = this.targets.get(targetId);
    if (!t || !t.sessionId || !this.cdp) return;
    await this.cdp.send("Page.reload", { ignoreCache: false }, t.sessionId);
  }

  async stop(): Promise<void> {
    removeInstancePortFile(this.opts.workspaceDir);
    if (this.allocatedPort) removeGlobalPortFileIfMatches(this.allocatedPort);
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
    this.emit("stopped");
  }
}
