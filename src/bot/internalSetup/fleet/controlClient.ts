// Co-worker dial-out control channel: connects to MASTER_URL, registers,
// receives leases, heartbeats, reconnects with backoff, idles without a
// master. Also holds the worker's lease clock: any inbound master frame
// renews it; silence past LEASE_TTL_MS expires the lease (local-monotonic,
// no absolute timestamps on the wire).

import { performance } from 'perf_hooks';
import { WebSocket } from 'ws';
import {
  CONTROL_ACK_TIMEOUT_MS,
  HEARTBEAT_MS,
  LEASE_TTL_MS,
  RECONNECT_BACKOFF_MS,
} from './constants';
import {
  ControlEnvelope,
  GuildNoticePayload,
  LeaseGrantPayload,
  LeaseRevokePayload,
  MSG,
  RegisterPayload,
  RegisterResult,
} from './protocol';
import type { LeaseRuntime } from './leaseRuntime';

export interface ControlClientOptions {
  masterUrl: string;
  secret: string;
  buildRegister: () => RegisterPayload;
  runtime: LeaseRuntime;
}

export class ControlClient {
  private ws: WebSocket | null = null;
  private registered = false;
  private term = 0;
  private attempt = 0;
  private stopped = false;
  private lastContactAt: number | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private ttlTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private firstLeaseResolve: (() => void) | null = null;
  private readonly firstLease: Promise<void>;

  constructor(private readonly opts: ControlClientOptions) {
    this.firstLease = new Promise<void>(resolve => { this.firstLeaseResolve = resolve; });
  }

  start(): void {
    this.connect();
    // These timers are deliberately ref'd: a lease-less co-worker stays alive
    // to keep dialing instead of falling off the event loop.
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_MS);
    this.ttlTimer = setInterval(() => this.checkTtl(), HEARTBEAT_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.ttlTimer) clearInterval(this.ttlTimer);
    this.ws?.terminate();
  }

  masterKnown(): boolean {
    return this.registered;
  }

  getTerm(): number {
    return this.term;
  }

  /** Resolves when the first lease grant has been accepted; never rejects (idle-until-master). */
  waitForFirstLease(): Promise<void> {
    return this.firstLease;
  }

  sendGuildNotice(notice: GuildNoticePayload): void {
    this.send(MSG.GUILD_NOTICE, { term: this.term, ...notice });
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.masterUrl, {
      headers: { 'x-control-secret': this.opts.secret },
      handshakeTimeout: CONTROL_ACK_TIMEOUT_MS,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.touch();
      void this.register();
    });
    ws.on('message', raw => void this.onMessage(raw));
    ws.on('ping', () => this.touch());
    ws.on('error', error => {
      if (this.attempt <= 1) {
        console.warn(`[Fleet] Control connection error: ${error instanceof Error ? error.message : error}`);
      }
    });
    ws.on('close', () => {
      const wasRegistered = this.registered;
      this.registered = false;
      this.failPending(new Error('control connection closed'));
      if (wasRegistered) console.warn('[Fleet] Lost control connection to master; reconnecting');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.attempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.attempt++;
    if (this.attempt <= 3 || this.attempt % 10 === 0) {
      console.log(`[Fleet] Master unreachable; retrying in ${delay}ms (attempt ${this.attempt})`);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async register(): Promise<void> {
    try {
      const result = (await this.request(MSG.REGISTER, this.opts.buildRegister())) as RegisterResult;
      if (!result?.accepted) {
        console.error(`[Fleet] Master refused registration: ${result?.reason ?? 'unknown'}; retrying with backoff`);
        this.ws?.close();
        return;
      }
      this.term = result.term;
      this.registered = true;
      this.attempt = 0;
      this.touch();
      console.log(`[Fleet] Registered with master (term ${this.term})`);
    } catch (error) {
      console.warn(`[Fleet] Registration failed: ${error instanceof Error ? error.message : error}`);
      this.ws?.close();
    }
  }

  private async onMessage(raw: unknown): Promise<void> {
    let message: ControlEnvelope;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    this.touch();
    const { type, requestId, data } = message;

    if (requestId && this.pending.has(requestId) && type === undefined) {
      const entry = this.pending.get(requestId)!;
      this.pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.resolve(data);
      return;
    }
    if (typeof type !== 'string') return;

    switch (type) {
      case MSG.LEASE_GRANT: {
        const grant = data as LeaseGrantPayload;
        const ack = await this.opts.runtime.applyGrant(grant);
        if (ack.ok) {
          this.term = Math.max(this.term, grant.term);
          if (this.firstLeaseResolve) {
            this.firstLeaseResolve();
            this.firstLeaseResolve = null;
          }
          console.log(`[Fleet] Lease granted: shards [${grant.leases.map(l => l.shardId).join(', ')}] of ${grant.shardCount} (term ${grant.term}, epoch ${grant.epoch})`);
        }
        this.replyAck(requestId, ack);
        break;
      }
      case MSG.LEASE_REVOKE: {
        const revoke = data as LeaseRevokePayload;
        const ack = await this.opts.runtime.revoke(revoke.term, revoke.leaseIds, revoke.reason);
        if (ack.ok) this.term = Math.max(this.term, revoke.term);
        this.replyAck(requestId, ack);
        break;
      }
      default:
        break;
    }
  }

  private replyAck(requestId: string | undefined, data: any): void {
    if (!requestId || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: MSG.LEASE_ACK, requestId, data }));
  }

  private request(type: string, data: any): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('control connection not open'));
    }
    return new Promise((resolve, reject) => {
      const requestId = `${type}_${Date.now()}_${Math.random()}`;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`control request ${type} timed out`));
      }, CONTROL_ACK_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ type, requestId, data }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private send(type: string, data: any): void {
    if (!this.registered || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ type, data }));
    } catch { /* socket is closing; reconnect handles it */ }
  }

  private sendHeartbeat(): void {
    if (!this.registered) return;
    this.send(MSG.HEARTBEAT, this.opts.runtime.buildHeartbeat(this.term));
  }

  private checkTtl(): void {
    if (!this.opts.runtime.hasCurrentLease()) return;
    if (this.lastContactAt === null) return;
    if (performance.now() - this.lastContactAt <= LEASE_TTL_MS) return;
    this.registered = false;
    void this.opts.runtime.expire('no master contact past LEASE_TTL');
    this.ws?.terminate();
  }

  private touch(): void {
    this.lastContactAt = performance.now();
  }

  private failPending(error: Error): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(requestId);
    }
  }
}
