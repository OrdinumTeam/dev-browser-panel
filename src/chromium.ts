import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";

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

export function writePortFile(port: number): string {
  const dir = path.join(os.homedir(), ".dev-browser-panel");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const portFile = path.join(dir, "port");
  fs.writeFileSync(portFile, String(port), "utf8");
  return portFile;
}

export function removePortFile(): void {
  const portFile = path.join(os.homedir(), ".dev-browser-panel", "port");
  try { fs.unlinkSync(portFile); } catch { /* ignore */ }
}
