import { spawn, execFileSync, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import * as net from "net";

export function findChromiumBinary(override?: string): string | null {
  if (override && override.trim().length > 0) {
    return fs.existsSync(override) ? override : null;
  }

  const cacheDirs: string[] = [];
  const platform = os.platform();
  if (platform === "darwin") {
    cacheDirs.push(path.join(os.homedir(), "Library/Caches/ms-playwright"));
  } else if (platform === "linux") {
    cacheDirs.push(path.join(os.homedir(), ".cache/ms-playwright"));
  } else if (platform === "win32") {
    if (process.env.LOCALAPPDATA) {
      cacheDirs.push(path.join(process.env.LOCALAPPDATA, "ms-playwright"));
    }
  }

  for (const cacheDir of cacheDirs) {
    if (!fs.existsSync(cacheDir)) continue;
    let entries: string[];
    try {
      entries = fs
        .readdirSync(cacheDir)
        .filter((e) => e.startsWith("chromium_headless_shell-") || e.startsWith("chromium-"));
    } catch {
      continue;
    }
    // Prefer newest version (highest revision number)
    entries.sort((a, b) => {
      const va = parseInt(a.split("-").pop() ?? "0", 10);
      const vb = parseInt(b.split("-").pop() ?? "0", 10);
      return vb - va;
    });
    for (const entry of entries) {
      const candidates = [
        path.join(cacheDir, entry, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
        path.join(cacheDir, entry, "chrome-headless-shell-mac", "chrome-headless-shell"),
        path.join(cacheDir, entry, "chrome-headless-shell-linux", "chrome-headless-shell"),
        path.join(cacheDir, entry, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
        path.join(cacheDir, entry, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        path.join(cacheDir, entry, "chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"),
        path.join(cacheDir, entry, "chrome-linux", "chrome"),
        path.join(cacheDir, entry, "chrome-win", "chrome.exe"),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) return c;
      }
    }
  }
  return null;
}

export interface BrowserHandle {
  process: ChildProcess;
  wsEndpoint: string;
  port: number;
  userDataDir: string;
}

export interface LaunchOptions {
  binary: string;
  port: number;
  startUrl: string;
  userDataDir: string;
  viewport: { width: number; height: number };
}

export async function launchChromium(opts: LaunchOptions): Promise<BrowserHandle> {
  if (!fs.existsSync(opts.userDataDir)) {
    fs.mkdirSync(opts.userDataDir, { recursive: true });
  }

  const args = [
    `--remote-debugging-port=${opts.port}`,
    `--remote-debugging-address=127.0.0.1`,
    `--user-data-dir=${opts.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-component-extensions-with-background-pages",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-features=Translate,OptimizationHints,DialMediaRouteProvider,GlobalMediaControls,MediaRouter,PaintHolding",
    "--disable-hang-monitor",
    "--disable-ipc-flooding-protection",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--enable-features=CDPScreenshotNewSurface",
    "--force-color-profile=srgb",
    "--metrics-recording-only",
    "--no-sandbox",
    "--hide-scrollbars",
    "--mute-audio",
    "--headless=new",
    `--window-size=${opts.viewport.width},${opts.viewport.height}`,
    opts.startUrl,
  ];

  const proc = spawn(opts.binary, args, {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrBuf = "";
  proc.stderr?.on("data", (d) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
  });

  proc.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      // eslint-disable-next-line no-console
      console.error(`[dev-browser-panel] Chromium exited code=${code} signal=${signal}\n${stderrBuf}`);
    }
  });

  try {
    const wsEndpoint = await pollForCDP(opts.port, 20000);
    return {
      process: proc,
      wsEndpoint,
      port: opts.port,
      userDataDir: opts.userDataDir,
    };
  } catch (err) {
    try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    throw new Error(`Chromium failed to start: ${(err as Error).message}\nStderr: ${stderrBuf}`);
  }
}

async function pollForCDP(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const data = await httpGetJson(`http://127.0.0.1:${port}/json/version`);
      const ws = (data as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl;
      if (ws) {
        // CDP may return ws://localhost/... without port — rewrite to the real address.
        return ws.replace(/^ws:\/\/[^/:]+/, `ws://127.0.0.1:${port}`);
      }
    } catch (e) {
      lastErr = e as Error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for CDP on port ${port}${lastErr ? `: ${lastErr.message}` : ""}`);
}

function httpGetJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + (parsed.search || ""),
        method: "GET",
        headers: { Host: "localhost" }, // bypass CDP DNS rebinding protection
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(e as Error);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("HTTP timeout")));
    req.end();
  });
}

export function instanceDir(workspaceDir: string): string {
  return path.join(workspaceDir, ".dev-browser-panel");
}

export function profileDir(workspaceDir: string): string {
  return path.join(instanceDir(workspaceDir), "chromium-profile");
}

// --- Multi-window profile claiming -----------------------------------------
//
// Two VS Code windows on the same workspace must not share one Chromium
// profile: the second launch hits Chromium's ProcessSingleton lock and dies.
// Each profile dir carries a panel-owner.json ({ chromiumPid, ownerPid }).
// A profile is claimable when its Chromium is dead, or when the Chromium is
// alive but the extension host that launched it is gone (orphan → kill it).

interface ProfileOwner {
  chromiumPid: number;
  ownerPid: number;
}

/** Profiles claimed by sessions of THIS extension host (pid checks can't see ourselves). */
const claimedProfiles = new Set<string>();

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Best-effort check that `pid` is a Chromium we launched on this profile. */
function pidUsesProfile(pid: number, profile: string): boolean {
  if (os.platform() === "win32") return false; // no cheap check — stay conservative
  try {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 3000,
    });
    return cmd.includes(profile);
  } catch {
    return false;
  }
}

function ownerFilePath(profile: string): string {
  return path.join(profile, "panel-owner.json");
}

function readProfileOwner(profile: string): ProfileOwner | null {
  try {
    const raw = fs.readFileSync(ownerFilePath(profile), "utf8");
    const data = JSON.parse(raw) as Partial<ProfileOwner>;
    if (typeof data.chromiumPid === "number" && typeof data.ownerPid === "number") {
      return { chromiumPid: data.chromiumPid, ownerPid: data.ownerPid };
    }
  } catch { /* missing or corrupt → treat as unowned */ }
  return null;
}

export function writeProfileOwner(profile: string, chromiumPid: number): void {
  claimedProfiles.add(profile);
  try {
    if (!fs.existsSync(profile)) fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(
      ownerFilePath(profile),
      JSON.stringify({ chromiumPid, ownerPid: process.pid }),
      "utf8",
    );
  } catch { /* best effort */ }
}

export function removeProfileOwner(profile: string): void {
  claimedProfiles.delete(profile);
  try { fs.unlinkSync(ownerFilePath(profile)); } catch { /* ignore */ }
}

/**
 * Picks a usable profile dir for this window. Reaps orphaned Chromium
 * processes left behind by a crashed/killed extension host; falls back to
 * suffixed profiles when another live window owns the base one.
 */
export function claimProfileDir(workspaceDir: string): string {
  const base = profileDir(workspaceDir);
  for (let i = 0; i < 10; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    if (claimedProfiles.has(candidate)) continue; // in use by this very process

    const owner = readProfileOwner(candidate);
    if (!owner) {
      claimedProfiles.add(candidate);
      return candidate;
    }

    const chromiumAlive = isPidAlive(owner.chromiumPid) && pidUsesProfile(owner.chromiumPid, candidate);
    const ownerAlive = isPidAlive(owner.ownerPid);

    if (chromiumAlive && ownerAlive) continue; // another live window owns it
    if (chromiumAlive) {
      // Orphan: its extension host is gone. Kill and claim.
      try { process.kill(owner.chromiumPid, "SIGKILL"); } catch { /* ignore */ }
    }
    removeProfileOwner(candidate);
    claimedProfiles.add(candidate);
    return candidate;
  }
  // Everything owned by live windows — isolate with a throwaway profile.
  const fallback = path.join(os.tmpdir(), `dev-browser-panel-profile-${process.pid}`);
  claimedProfiles.add(fallback);
  return fallback;
}

export function writeInstancePortFile(workspaceDir: string, port: number): string {
  const dir = instanceDir(workspaceDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const portFile = path.join(dir, "port");
  fs.writeFileSync(portFile, String(port), "utf8");
  return portFile;
}

function globalDir(): string {
  return path.join(os.homedir(), ".dev-browser-panel");
}

interface GlobalOwner {
  pid: number;
  port: number;
  workspace: string;
}

function readGlobalOwner(): GlobalOwner | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(globalDir(), "owner.json"), "utf8")) as Partial<GlobalOwner>;
    if (typeof data.pid === "number" && typeof data.port === "number") {
      return { pid: data.pid, port: data.port, workspace: String(data.workspace ?? "") };
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Claims `~/.dev-browser-panel/port` for this window — but only if no other
 * live window already holds it. First window wins; later windows leave the
 * global pointer alone so external CDP clients (dev-browser CLI) don't get
 * silently re-pointed at a different VS Code window mid-session.
 * Per-workspace discovery should use `<workspace>/.dev-browser-panel/port`.
 */
export function claimGlobalPortFile(port: number, workspaceDir: string): boolean {
  const dir = globalDir();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const owner = readGlobalOwner();
    if (owner && owner.pid !== process.pid && isPidAlive(owner.pid)) {
      return false; // another live window owns the global pointer
    }
    fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: process.pid, port, workspace: workspaceDir }), "utf8");
    fs.writeFileSync(path.join(dir, "port"), String(port), "utf8");
    fs.writeFileSync(path.join(dir, "last-workspace"), workspaceDir, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function removeInstancePortFile(workspaceDir: string): void {
  const portFile = path.join(instanceDir(workspaceDir), "port");
  try { fs.unlinkSync(portFile); } catch { /* ignore */ }
}

export function releaseGlobalPortFile(port: number): void {
  const dir = globalDir();
  try {
    const owner = readGlobalOwner();
    if (owner && owner.pid === process.pid) {
      fs.unlinkSync(path.join(dir, "owner.json"));
    }
    const portFile = path.join(dir, "port");
    const current = fs.readFileSync(portFile, "utf8").trim();
    if (current === String(port)) fs.unlinkSync(portFile);
  } catch { /* ignore */ }
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

export async function findFreePort(start: number, maxAttempts: number = 50): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = start + i;
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error(
    `No free CDP port in range ${start}-${start + maxAttempts - 1}. Stop other panels or change devBrowserPanel.cdpPort.`,
  );
}
