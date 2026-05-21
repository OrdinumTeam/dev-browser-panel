import WebSocket from "ws";
import { EventEmitter } from "events";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export interface CDPEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/**
 * Minimal CDP client over WebSocket with flatten-session support.
 * One connection, multiplexed via sessionId for multiple targets (tabs).
 */
export class CDPClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private connected = false;
  private closedExplicitly = false;

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        perMessageDeflate: false,
        maxPayload: 256 * 1024 * 1024,
        headers: { Host: "localhost" },
      });
      this.ws = ws;

      const onOpen = (): void => {
        this.connected = true;
        ws.removeListener("error", onErr);
        resolve();
      };
      const onErr = (err: Error): void => {
        if (!this.connected) reject(err);
        this.emit("error", err);
      };

      ws.once("open", onOpen);
      ws.once("error", onErr);

      ws.on("close", () => {
        this.connected = false;
        for (const p of this.pending.values()) {
          p.reject(new Error("CDP connection closed"));
        }
        this.pending.clear();
        if (!this.closedExplicitly) this.emit("disconnected");
      });

      ws.on("message", (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            id?: number;
            method?: string;
            params?: Record<string, unknown>;
            result?: unknown;
            error?: { code: number; message: string };
            sessionId?: string;
          };
          if (typeof msg.id === "number") {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              if (msg.error) p.reject(new Error(`CDP error: ${msg.error.message}`));
              else p.resolve(msg.result);
            }
          } else if (msg.method) {
            const ev: CDPEvent = {
              method: msg.method,
              params: msg.params ?? {},
              sessionId: msg.sessionId,
            };
            this.emit("event", ev);
            this.emit(msg.method, ev);
          }
        } catch (e) {
          this.emit("error", e as Error);
        }
      });
    });
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (!this.ws || !this.connected) throw new Error("CDP not connected");
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify(msg), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  close(): void {
    this.closedExplicitly = true;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}
