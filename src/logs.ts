import * as vscode from "vscode";
import * as path from "path";
import { Session } from "./session";
import { CDPClient, CDPEvent } from "./cdp";

interface ConsoleEntry {
  kind: "console";
  timestamp: number;
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  source?: string;
  url?: string;
  lineNumber?: number;
}

interface HarTiming {
  dns?: number;
  connect?: number;
  ssl?: number;
  send?: number;
  wait?: number;
  receive?: number;
}

interface NetworkEntry {
  kind: "network";
  timestamp: number;
  level: "log" | "info" | "warn" | "error";
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  resourceType?: string;
  mimeType?: string;
  durationMs?: number;
  size?: number;
  failed?: boolean;
  errorText?: string;
  httpVersion?: string;
  requestHeaders?: Record<string, string>;
  requestPostData?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBodyBase64?: boolean;
  responseBodyTruncated?: number;
  serverIPAddress?: string;
  timing?: HarTiming;
}

type LogEntry = ConsoleEntry | NetworkEntry;

interface PendingNetRequest {
  startWallMs: number;
  startTsMono: number;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  httpVersion?: string;
  requestHeaders?: Record<string, string>;
  requestPostData?: string;
  responseHeaders?: Record<string, string>;
  serverIPAddress?: string;
  timing?: HarTiming;
}

const BINARY_RESOURCE_TYPES = new Set(["Image", "Media", "Font"]);
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_BODY_KEPT_BYTES = 256 * 1024;

type AttachedInfo = { targetId: string; sessionId: string };

const MAX_PENDING_NET = 5000;

export class LogsPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private session: Session | null = null;
  private enabledSessionIds = new Set<string>();
  private listenersRegistered = false;
  private pendingNet = new Map<string, PendingNetRequest>();

  private onAttachedRef: ((info: AttachedInfo) => void) | null = null;
  private onConsoleRef: ((ev: CDPEvent) => void) | null = null;
  private onExceptionRef: ((ev: CDPEvent) => void) | null = null;
  private onLogEntryRef: ((ev: CDPEvent) => void) | null = null;
  private onNetReqRef: ((ev: CDPEvent) => void) | null = null;
  private onNetRespRef: ((ev: CDPEvent) => void) | null = null;
  private onNetDoneRef: ((ev: CDPEvent) => void) | null = null;
  private onNetFailRef: ((ev: CDPEvent) => void) | null = null;
  private cdpRef: CDPClient | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media"))],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: { type?: string; har?: string; count?: number }) => {
      if (msg?.type === "copy-har" && typeof msg.har === "string") {
        void vscode.env.clipboard.writeText(msg.har).then(() => {
          const count = typeof msg.count === "number" ? msg.count : 0;
          const kb = Math.round(msg.har!.length / 1024);
          vscode.window.showInformationMessage(`HAR copied (${count} entries, ${kb} KB).`);
        });
      }
    });

    if (this.session && !this.listenersRegistered) {
      this.setupSessionListeners();
      void this.enableAllTargets();
    }

    webviewView.onDidDispose(() => {
      this.view = null;
    });
  }

  private async fetchBodyAndEmit(
    requestId: string,
    sessionId: string,
    emit: (body?: string, base64?: boolean, truncated?: number) => void,
  ): Promise<void> {
    try {
      const resp = (await this.cdpRef!.send(
        "Network.getResponseBody",
        { requestId },
        sessionId,
      )) as { body?: string; base64Encoded?: boolean };
      let body = resp?.body;
      const base64 = !!resp?.base64Encoded;
      let truncated: number | undefined;
      if (body && !base64 && body.length > MAX_BODY_KEPT_BYTES) {
        truncated = body.length;
        body = body.slice(0, MAX_BODY_KEPT_BYTES);
      }
      emit(body, base64, truncated);
    } catch {
      emit();
    }
  }

  attachSession(session: Session): void {
    this.teardownListeners();
    this.session = session;
    this.enabledSessionIds.clear();
    this.pendingNet.clear();
    this.setupSessionListeners();
    void this.enableAllTargets();

    session.once("stopped", () => {
      this.teardownListeners();
      this.session = null;
      this.enabledSessionIds.clear();
      this.pendingNet.clear();
    });
  }

  private setupSessionListeners(): void {
    if (this.listenersRegistered || !this.session) return;
    const cdp = this.session.getCDP();
    if (!cdp) return;

    this.cdpRef = cdp;
    this.listenersRegistered = true;

    const onAttached = (info: AttachedInfo): void => {
      void this.enableLoggingForSession(info.sessionId);
    };

    const onConsole = (ev: CDPEvent): void => {
      const p = ev.params as {
        type?: string;
        args?: Array<{ type: string; value?: unknown; description?: string }>;
        stackTrace?: { callFrames: Array<{ url?: string; lineNumber?: number }> };
        timestamp?: number;
      };
      const level = this.normalizeLevel(p.type ?? "log");
      const text = (p.args ?? [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description ?? ""))
        .join(" ");
      const frame = p.stackTrace?.callFrames?.[0];
      this.postLog({
        kind: "console",
        timestamp: p.timestamp ? Math.floor(p.timestamp) : Date.now(),
        level,
        text,
        source: "console",
        url: frame?.url,
        lineNumber: frame?.lineNumber,
      });
    };

    const onException = (ev: CDPEvent): void => {
      const p = ev.params as {
        timestamp?: number;
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string };
          url?: string;
          lineNumber?: number;
        };
      };
      const det = p.exceptionDetails ?? {};
      const text = det.exception?.description ?? det.text ?? "Unknown exception";
      this.postLog({
        kind: "console",
        timestamp: p.timestamp ? Math.floor(p.timestamp) : Date.now(),
        level: "error",
        text,
        source: "exception",
        url: det.url,
        lineNumber: det.lineNumber,
      });
    };

    const onLogEntry = (ev: CDPEvent): void => {
      const p = ev.params as {
        entry?: {
          timestamp?: number;
          level?: string;
          text?: string;
          url?: string;
          lineNumber?: number;
        };
      };
      const e = p.entry ?? {};
      this.postLog({
        kind: "console",
        timestamp: e.timestamp ? Math.floor(e.timestamp) : Date.now(),
        level: this.normalizeLevel(e.level ?? "log"),
        text: e.text ?? "",
        source: "browser",
        url: e.url,
        lineNumber: e.lineNumber,
      });
    };

    const onNetReq = (ev: CDPEvent): void => {
      const p = ev.params as {
        requestId?: string;
        request?: {
          method?: string;
          url?: string;
          headers?: Record<string, string>;
          postData?: string;
        };
        wallTime?: number;
        timestamp?: number;
        type?: string;
      };
      if (!p.requestId || !p.request) return;
      this.pendingNet.set(p.requestId, {
        startWallMs: p.wallTime ? p.wallTime * 1000 : Date.now(),
        startTsMono: p.timestamp ?? 0,
        method: p.request.method ?? "GET",
        url: p.request.url ?? "",
        resourceType: p.type,
        requestHeaders: p.request.headers,
        requestPostData: p.request.postData,
      });
      if (this.pendingNet.size > MAX_PENDING_NET) {
        const firstKey = this.pendingNet.keys().next().value;
        if (firstKey) this.pendingNet.delete(firstKey);
      }
    };

    const onNetResp = (ev: CDPEvent): void => {
      const p = ev.params as {
        requestId?: string;
        response?: {
          status?: number;
          statusText?: string;
          mimeType?: string;
          headers?: Record<string, string>;
          protocol?: string;
          remoteIPAddress?: string;
          timing?: {
            requestTime?: number;
            dnsStart?: number;
            dnsEnd?: number;
            connectStart?: number;
            connectEnd?: number;
            sslStart?: number;
            sslEnd?: number;
            sendStart?: number;
            sendEnd?: number;
            receiveHeadersEnd?: number;
          };
        };
        type?: string;
      };
      if (!p.requestId) return;
      const rec = this.pendingNet.get(p.requestId);
      if (!rec) return;
      const r = p.response ?? {};
      rec.status = r.status;
      rec.statusText = r.statusText;
      rec.mimeType = r.mimeType;
      rec.responseHeaders = r.headers;
      rec.httpVersion = r.protocol;
      rec.serverIPAddress = r.remoteIPAddress;
      if (p.type) rec.resourceType = p.type;
      const t = r.timing;
      if (t) {
        const span = (start?: number, end?: number): number | undefined =>
          start != null && end != null && end >= start ? end - start : undefined;
        rec.timing = {
          dns: span(t.dnsStart, t.dnsEnd),
          connect: span(t.connectStart, t.connectEnd),
          ssl: span(t.sslStart, t.sslEnd),
          send: span(t.sendStart, t.sendEnd),
          wait: span(t.sendEnd, t.receiveHeadersEnd),
        };
      }
    };

    const onNetDone = (ev: CDPEvent): void => {
      const p = ev.params as {
        requestId?: string;
        timestamp?: number;
        encodedDataLength?: number;
      };
      if (!p.requestId) return;
      const rec = this.pendingNet.get(p.requestId);
      if (!rec) return;
      this.pendingNet.delete(p.requestId);
      const status = rec.status ?? 0;
      const level: NetworkEntry["level"] =
        status >= 500 || status === 0
          ? "error"
          : status >= 400
            ? "warn"
            : status >= 300
              ? "info"
              : "log";
      const durationMs =
        p.timestamp && rec.startTsMono
          ? Math.max(0, Math.round((p.timestamp - rec.startTsMono) * 1000))
          : undefined;
      if (rec.timing && durationMs != null) {
        const accountedFor =
          (rec.timing.dns ?? 0) +
          (rec.timing.connect ?? 0) +
          (rec.timing.send ?? 0) +
          (rec.timing.wait ?? 0);
        rec.timing.receive = Math.max(0, durationMs - accountedFor);
      }
      const size = p.encodedDataLength;
      const shouldFetchBody =
        !BINARY_RESOURCE_TYPES.has(rec.resourceType ?? "") &&
        (size == null || size <= MAX_BODY_BYTES);
      const emit = (body?: string, base64?: boolean, truncated?: number): void => {
        this.postLog({
          kind: "network",
          timestamp: rec.startWallMs,
          level,
          method: rec.method,
          url: rec.url,
          status: rec.status,
          statusText: rec.statusText,
          resourceType: rec.resourceType,
          mimeType: rec.mimeType,
          durationMs,
          size,
          httpVersion: rec.httpVersion,
          requestHeaders: rec.requestHeaders,
          requestPostData: rec.requestPostData,
          responseHeaders: rec.responseHeaders,
          responseBody: body,
          responseBodyBase64: base64,
          responseBodyTruncated: truncated,
          serverIPAddress: rec.serverIPAddress,
          timing: rec.timing,
        });
      };
      if (shouldFetchBody && this.cdpRef && ev.sessionId) {
        void this.fetchBodyAndEmit(p.requestId, ev.sessionId, emit);
      } else {
        emit();
      }
    };

    const onNetFail = (ev: CDPEvent): void => {
      const p = ev.params as {
        requestId?: string;
        timestamp?: number;
        errorText?: string;
        canceled?: boolean;
        type?: string;
      };
      if (!p.requestId) return;
      const rec = this.pendingNet.get(p.requestId);
      if (!rec) return;
      this.pendingNet.delete(p.requestId);
      if (p.canceled) return;
      const durationMs =
        p.timestamp && rec.startTsMono
          ? Math.max(0, Math.round((p.timestamp - rec.startTsMono) * 1000))
          : undefined;
      this.postLog({
        kind: "network",
        timestamp: rec.startWallMs,
        level: "error",
        method: rec.method,
        url: rec.url,
        failed: true,
        errorText: p.errorText,
        resourceType: p.type ?? rec.resourceType,
        durationMs,
        httpVersion: rec.httpVersion,
        requestHeaders: rec.requestHeaders,
        requestPostData: rec.requestPostData,
        responseHeaders: rec.responseHeaders,
        serverIPAddress: rec.serverIPAddress,
        timing: rec.timing,
      });
    };

    this.onAttachedRef = onAttached;
    this.onConsoleRef = onConsole;
    this.onExceptionRef = onException;
    this.onLogEntryRef = onLogEntry;
    this.onNetReqRef = onNetReq;
    this.onNetRespRef = onNetResp;
    this.onNetDoneRef = onNetDone;
    this.onNetFailRef = onNetFail;

    cdp.on("Runtime.consoleAPICalled", onConsole);
    cdp.on("Runtime.exceptionThrown", onException);
    cdp.on("Log.entryAdded", onLogEntry);
    cdp.on("Network.requestWillBeSent", onNetReq);
    cdp.on("Network.responseReceived", onNetResp);
    cdp.on("Network.loadingFinished", onNetDone);
    cdp.on("Network.loadingFailed", onNetFail);
    this.session.on("attached", onAttached as (...args: unknown[]) => void);
  }

  private teardownListeners(): void {
    if (!this.listenersRegistered) return;
    this.listenersRegistered = false;
    if (this.cdpRef) {
      if (this.onConsoleRef) this.cdpRef.off("Runtime.consoleAPICalled", this.onConsoleRef);
      if (this.onExceptionRef) this.cdpRef.off("Runtime.exceptionThrown", this.onExceptionRef);
      if (this.onLogEntryRef) this.cdpRef.off("Log.entryAdded", this.onLogEntryRef);
      if (this.onNetReqRef) this.cdpRef.off("Network.requestWillBeSent", this.onNetReqRef);
      if (this.onNetRespRef) this.cdpRef.off("Network.responseReceived", this.onNetRespRef);
      if (this.onNetDoneRef) this.cdpRef.off("Network.loadingFinished", this.onNetDoneRef);
      if (this.onNetFailRef) this.cdpRef.off("Network.loadingFailed", this.onNetFailRef);
    }
    if (this.session && this.onAttachedRef) {
      this.session.off("attached", this.onAttachedRef as (...args: unknown[]) => void);
    }
    this.onAttachedRef = null;
    this.onConsoleRef = null;
    this.onExceptionRef = null;
    this.onLogEntryRef = null;
    this.onNetReqRef = null;
    this.onNetRespRef = null;
    this.onNetDoneRef = null;
    this.onNetFailRef = null;
    this.cdpRef = null;
  }

  private async enableAllTargets(): Promise<void> {
    if (!this.session) return;
    for (const target of this.session.targets.values()) {
      if (target.sessionId) {
        await this.enableLoggingForSession(target.sessionId);
      }
    }
  }

  private async enableLoggingForSession(sessionId: string): Promise<void> {
    if (this.enabledSessionIds.has(sessionId)) return;
    const cdp = this.session?.getCDP();
    if (!cdp) return;
    try {
      await cdp.send("Runtime.enable", {}, sessionId);
      await cdp.send("Log.enable", {}, sessionId);
      await cdp.send("Network.enable", {}, sessionId);
      this.enabledSessionIds.add(sessionId);
    } catch {
      // ignore
    }
  }

  private normalizeLevel(type: string): ConsoleEntry["level"] {
    const map: Record<string, ConsoleEntry["level"]> = {
      log: "log",
      info: "info",
      warning: "warn",
      warn: "warn",
      error: "error",
      debug: "debug",
      verbose: "debug",
      assert: "error",
      dir: "log",
      dirxml: "log",
      table: "log",
      trace: "log",
      group: "log",
      groupCollapsed: "log",
      groupEnd: "log",
      clear: "log",
      count: "log",
      countReset: "log",
      timeLog: "log",
      timeEnd: "log",
    };
    return map[type] ?? "log";
  }

  private postLog(entry: LogEntry): void {
    this.view?.webview.postMessage({ type: "log", entry });
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
<link rel="stylesheet" href="${mediaUri}/logs.css">
<title>Browser Logs</title>
</head>
<body>
<div id="toolbar">
  <div id="tabs">
    <button class="tab tab-active" data-tab="all">All</button>
    <button class="tab" data-tab="console">Console</button>
    <button class="tab" data-tab="network">Network</button>
  </div>
  <input id="filter" type="text" placeholder="Filter...">
  <button id="btn-copy-har" title="Copy network entries as HAR JSON to clipboard">Copy HAR</button>
  <button id="btn-clear">Clear</button>
  <button id="btn-pause">Pause</button>
</div>
<div id="logs-list"></div>
<script src="${mediaUri}/logs.js"></script>
</body>
</html>`;
  }
}
