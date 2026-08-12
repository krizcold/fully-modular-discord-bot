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
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  RECONNECT_BACKOFF_MS,
} from './constants';
import {
  BudgetInfo,
  ControlEnvelope,
  GuildNoticePayload,
  HeartbeatPayload,
  LeaseGrantPayload,
  LeaseRenewedPayload,
  LeaseRevokePayload,
  MSG,
  NodeDrainPayload,
  RegisterPayload,
  RegisterResult,
  SyncReportPayload,
  SyncStatePayload,
} from './protocol';
import type { LeaseRuntime } from './leaseRuntime';

export interface ControlClientOptions {
  masterUrl: string;
  secret: string;
  buildRegister: () => RegisterPayload;
  runtime: LeaseRuntime;
  /** Pushed manifest handler (sync engine); the ack is a receipt, sent before this runs. */
  onSyncState?: (payload: SyncStatePayload) => void;
  /** Stamps sync fields onto every outgoing heartbeat. */
  decorateHeartbeat?: (hb: HeartbeatPayload) => HeartbeatPayload;
  /** Migration control (prepare/drain/commit/abort/inventory) -> executor; returns the ack payload. */
  onXferControl?: (type: string, data: any) => Promise<any>;
  /** Master-delivered data backend from the register reply (re-delivered on every reconnect). */
  onDataBackend?: (info: RegisterResult['dataBackend']) => void;
  /** Webui data hop from the master (DATA_WRITE/DATA_READ); returns the reply payload. */
  onDataOp?: (type: string, data: any) => Promise<any>;
  /** Backend transformation control (TRANSFORM_GUILD/BACKEND_FLIP) -> executor; returns the ack payload. */
  onTransformControl?: (type: string, data: any) => Promise<any>;
  /** Grant-carried routing map (active transformation); applied BEFORE the grant so hydration sees correct routes. */
  onDataRoutes?: (transformationId: string, routes: { guildId: string; backend: 'file' | 'postgres' }[], url?: string) => void;
}

export class ControlClient {
  private ws: WebSocket | null = null;
  private registered = false;
  private term = 0;
  private attempt = 0;
  private stopped = false;
  private lastContactAt: number | null = null;
  private draining = false;
  private lastBudget: BudgetInfo | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private ttlTimer: NodeJS.Timeout | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly opts: ControlClientOptions) {}

  start(): void {
    this.connect();
    // These timers are deliberately ref'd: a lease-less co-worker stays alive
    // to keep dialing instead of falling off the event loop.
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_MS);
    this.ttlTimer = setInterval(() => this.checkTtl(), HEARTBEAT_MS);
    this.renewTimer = setInterval(() => void this.renewLease(), LEASE_RENEW_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.ttlTimer) clearInterval(this.ttlTimer);
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.ws?.terminate();
  }

  masterKnown(): boolean {
    return this.registered;
  }

  getTerm(): number {
    return this.term;
  }

  isDraining(): boolean {
    return this.draining;
  }

  /** Last budget snapshot carried on a register or renewed reply; kept across master loss for the UI. */
  getLastBudget(): BudgetInfo | null {
    return this.lastBudget;
  }

  getLastContactAgoMs(): number | null {
    return this.lastContactAt === null ? null : performance.now() - this.lastContactAt;
  }

  sendGuildNotice(notice: GuildNoticePayload): void {
    this.send(MSG.GUILD_NOTICE, { term: this.term, ...notice });
  }

  /** Sync pull request (files listing / module begin / chunk read). */
  syncRequest(type: string, data: any): Promise<any> {
    return this.request(type, data);
  }

  sendSyncReport(report: SyncReportPayload): void {
    this.send(MSG.SYNC_REPORT, report);
  }

  /** Fire-and-forget frame to the master (migration progress/verify). */
  sendToMaster(type: string, data: any): void {
    this.send(type, data);
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
        // A refusal is definitive (unlike a transient disconnect): expire the
        // cached lease now, or the refusal-redial loop would renew the lease
        // clock forever (backoff caps below the TTL) and keep unrecorded
        // sessions alive past the master's recovery hold-down.
        await this.opts.runtime.expire(`registration refused: ${result?.reason ?? 'unknown'}`);
        this.ws?.close();
        return;
      }
      this.term = result.term;
      this.registered = true;
      this.attempt = 0;
      this.draining = false;
      if (result.budget) this.lastBudget = result.budget;
      this.opts.onDataBackend?.(result.dataBackend);
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
        if (grant.transformationId && Array.isArray(grant.dataRoutes)) {
          try { this.opts.onDataRoutes?.(grant.transformationId, grant.dataRoutes, grant.dataBackendUrl); } catch { /* grant must still apply */ }
        }
        const ack = await this.opts.runtime.applyGrant(grant);
        if (ack.ok) {
          this.term = Math.max(this.term, grant.term);
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
      case MSG.NODE_DRAIN: {
        const drain = data as NodeDrainPayload;
        this.draining = true;
        console.warn(`[Fleet] Drain requested by master (${drain?.reason || 'unspecified'}); revokes follow`);
        this.replyAck(requestId, { ok: true, term: this.term });
        break;
      }
      case MSG.SYNC_STATE: {
        // Ack first (receipt, not completion) so the master's push never
        // waits on the reconcile; register/lease traffic is untouched.
        this.replyAck(requestId, { ok: true, term: this.term });
        this.opts.onSyncState?.(data as SyncStatePayload);
        break;
      }
      case MSG.DATA_WRITE:
      case MSG.DATA_READ: {
        const handler = this.opts.onDataOp;
        if (!handler) { this.replyAck(requestId, { ok: false, code: 'owner-unreachable', error: 'data ops unavailable on this node' }); break; }
        handler(type, data)
          .then(result => this.replyAck(requestId, result))
          .catch(error => this.replyAck(requestId, { ok: false, code: 'io-error', error: error instanceof Error ? error.message : String(error) }));
        break;
      }
      case MSG.TRANSFORM_GUILD:
      case MSG.BACKEND_FLIP: {
        const handler = this.opts.onTransformControl;
        if (!handler) { this.replyAck(requestId, { ok: false, reason: 'transformation-unavailable' }); break; }
        handler(type, data)
          .then(result => this.replyAck(requestId, result))
          .catch(error => this.replyAck(requestId, { ok: false, reason: error instanceof Error ? error.message : String(error) }));
        break;
      }
      case MSG.XFER_PREPARE:
      case MSG.XFER_DRAIN:
      case MSG.XFER_COMMIT:
      case MSG.XFER_ABORT:
      case MSG.XFER_INVENTORY: {
        // Migration control from the master -> local executor; reply via the ack path.
        const handler = this.opts.onXferControl;
        if (!handler) { this.replyAck(requestId, { ok: false, reason: 'migration-unavailable' }); break; }
        handler(type, data)
          .then(result => this.replyAck(requestId, result))
          .catch(error => this.replyAck(requestId, { ok: false, reason: error instanceof Error ? error.message : String(error) }));
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
    const hb = this.opts.runtime.buildHeartbeat(this.term);
    this.send(MSG.HEARTBEAT, this.opts.decorateHeartbeat ? this.opts.decorateHeartbeat(hb) : hb);
  }

  // Renew is observability, not liveness (any master frame renews the lease
  // clock): it carries the budget snapshot back and makes lease drift visible;
  // a lease-mismatch reply is fixed master-side (needsGrant), never locally.
  private async renewLease(): Promise<void> {
    if (!this.registered || !this.opts.runtime.hasCurrentLease()) return;
    const current = this.opts.runtime.getCurrent();
    if (!current) return;
    try {
      const reply = (await this.request(MSG.LEASE_RENEW, {
        term: this.term,
        leaseIds: current.leases.map(l => l.leaseId),
      })) as LeaseRenewedPayload;
      if (reply?.budget) this.lastBudget = reply.budget;
      if (reply && reply.ok === false) {
        console.warn(`[Fleet] Lease renew refused (${reply.reason ?? 'unknown'}); master reconciles next tick`);
      }
    } catch { /* disconnected or timed out; reconnect and TTL paths handle it */ }
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
