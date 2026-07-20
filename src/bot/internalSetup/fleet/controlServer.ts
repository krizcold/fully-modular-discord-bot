// Master-only control channel: WS server on CONTROL_PORT. Co-workers dial
// OUT to this server; it never dials anyone. CONTROL_SECRET is checked
// timing-safe at the HTTP upgrade. Wire schema mirrors the fork IPC:
// requests {type, requestId, data}, responses {requestId, data}.

import * as http from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { CONTROL_ACK_TIMEOUT_MS, LEASE_RENEW_MS } from './constants';
import {
  ControlEnvelope,
  GuildNoticePayload,
  HeartbeatPayload,
  MSG,
  RegisterPayload,
  RegisterResult,
} from './protocol';

export interface ControlServerHooks {
  getTerm: () => number;
  /** Registry insert + VersionGate; returns the register reply. */
  onRegister: (payload: RegisterPayload, send: (message: object) => void) => RegisterResult;
  /** Fired after the register reply went out, so grants always follow acceptance. */
  afterRegister: (nodeId: string) => void;
  onHeartbeat: (nodeId: string, hb: HeartbeatPayload) => void;
  onGuildNotice: (nodeId: string, notice: GuildNoticePayload) => void;
  onDisconnect: (nodeId: string) => void;
}

interface ConnState {
  nodeId: string | null;
  alive: boolean;
}

export class ControlServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly conns = new Map<string, WebSocket>();
  private readonly states = new Map<WebSocket, ConnState>();
  private readonly pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly staleTermLogged = new Set<string>();

  constructor(private readonly hooks: ControlServerHooks) {}

  start(port: number, secret: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((_req, res) => {
        res.writeHead(426, { 'content-type': 'text/plain' });
        res.end('control channel: websocket upgrade required');
      });
      this.wss = new WebSocketServer({ noServer: true });

      this.httpServer.on('upgrade', (req, socket, head) => {
        if (!secretMatches(req.headers['x-control-secret'], secret)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wss!.handleUpgrade(req, socket, head, ws => {
          this.wss!.emit('connection', ws, req);
        });
      });

      this.wss.on('connection', (socket: WebSocket) => this.handleConnection(socket));

      this.httpServer.once('error', reject);
      this.httpServer.listen(port, () => {
        this.httpServer!.removeListener('error', reject);
        this.pingTimer = setInterval(() => this.pingAll(), LEASE_RENEW_MS);
        this.pingTimer.unref();
        resolve();
      });
    });
  }

  stop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const socket of this.conns.values()) socket.terminate();
    this.wss?.close();
    this.httpServer?.close();
  }

  isConnected(nodeId: string): boolean {
    return this.conns.get(nodeId)?.readyState === WebSocket.OPEN;
  }

  /** Request/response to one node (grant, revoke). Rejects on timeout or dead socket. */
  request(nodeId: string, type: string, data: any): Promise<any> {
    const socket = this.conns.get(nodeId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Node ${nodeId} is not connected`));
    }
    return new Promise((resolve, reject) => {
      const requestId = `${type}_${Date.now()}_${Math.random()}`;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Control request ${type} to ${nodeId} timed out`));
      }, CONTROL_ACK_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ type, requestId, data }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleConnection(socket: WebSocket): void {
    const state: ConnState = { nodeId: null, alive: true };
    this.states.set(socket, state);

    socket.on('pong', () => { state.alive = true; });
    socket.on('error', error => {
      console.warn('[ControlServer] Socket error:', error instanceof Error ? error.message : error);
    });
    socket.on('close', () => {
      this.states.delete(socket);
      if (state.nodeId && this.conns.get(state.nodeId) === socket) {
        this.conns.delete(state.nodeId);
        this.hooks.onDisconnect(state.nodeId);
      }
    });
    socket.on('message', raw => {
      let message: ControlEnvelope;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      this.handleMessage(socket, state, message);
    });
  }

  private handleMessage(socket: WebSocket, state: ConnState, message: ControlEnvelope): void {
    const { type, requestId, data } = message;

    // Ack frames for our own outstanding requests resolve by requestId.
    if (requestId && this.pending.has(requestId) && (type === undefined || type === MSG.LEASE_ACK)) {
      const entry = this.pending.get(requestId)!;
      this.pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.resolve(data);
      return;
    }
    if (typeof type !== 'string') return;

    if (type === MSG.REGISTER) {
      const payload = data as RegisterPayload;
      const send = (msg: object) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
      };
      const result = this.hooks.onRegister(payload, send);
      if (result.accepted) {
        // A crashed node re-registers with the same persisted nodeId; the old
        // socket (if any) is a corpse and must not shadow the live one.
        const previous = this.conns.get(payload.nodeId);
        if (previous && previous !== socket) previous.terminate();
        this.conns.set(payload.nodeId, socket);
        state.nodeId = payload.nodeId;
      }
      if (requestId) this.reply(socket, requestId, result);
      if (result.accepted) this.hooks.afterRegister(payload.nodeId);
      return;
    }

    if (!state.nodeId) {
      if (requestId) this.reply(socket, requestId, { ok: false, term: this.hooks.getTerm(), reason: 'not-registered' });
      return;
    }

    // Term fencing on every post-register message.
    const term = Number(data?.term);
    if (!Number.isFinite(term) || term < this.hooks.getTerm()) {
      if (requestId) {
        this.reply(socket, requestId, { ok: false, term: this.hooks.getTerm(), reason: 'stale-term' });
      } else if (!this.staleTermLogged.has(state.nodeId)) {
        this.staleTermLogged.add(state.nodeId);
        console.warn(`[ControlServer] Dropping stale-term ${type} from ${state.nodeId} (term ${term} < ${this.hooks.getTerm()})`);
      }
      return;
    }

    switch (type) {
      case MSG.HEARTBEAT:
        this.hooks.onHeartbeat(state.nodeId, data as HeartbeatPayload);
        break;
      case MSG.GUILD_NOTICE:
        this.hooks.onGuildNotice(state.nodeId, (data?.notice ?? data) as GuildNoticePayload);
        break;
      default:
        if (requestId) this.reply(socket, requestId, { ok: false, term: this.hooks.getTerm(), reason: `unknown-type:${type}` });
    }
  }

  private reply(socket: WebSocket, requestId: string, data: any): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ requestId, data }));
  }

  private pingAll(): void {
    for (const [socket, state] of this.states) {
      if (!state.alive) {
        socket.terminate();
        continue;
      }
      state.alive = false;
      try { socket.ping(); } catch { /* closing */ }
    }
  }
}

function secretMatches(provided: string | string[] | undefined, secret: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  try {
    const providedHash = createHash('sha256').update(provided).digest();
    const secretHash = createHash('sha256').update(secret).digest();
    return timingSafeEqual(providedHash, secretHash);
  } catch {
    return false;
  }
}
