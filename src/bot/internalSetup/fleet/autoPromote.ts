// Auto-promotion watcher (PLAN_STANDBY 3.8): runs ONLY on the designated
// backup co-worker with FLEET_AUTO_PROMOTE=1 in postgres mode. Observes the
// term row over its own store connection and requests self-promotion when the
// row stops advancing AND the control connection to the master is down. Both
// signals must agree: a master that merely lost the store (stamp stale, WS
// healthy) is coasting on the C1 window and must never be shot, and a store
// this node cannot read is a store it could not CAS anyway. Freshness is
// observed across this node's own reads (row changed vs unchanged), never
// compared against any remote clock.

import { Client } from 'pg';
import { AUTO_PROMOTE_STALE_MS, TERM_STAMP_MS } from './constants';
import { loadCredentials, resolveDataBackend } from '../../../utils/envLoader';
import type { AutoPromoteStatusView } from './state';

export interface AutoPromoteHooks {
  /** True while the control WS to the master is registered. */
  masterConnected: () => boolean;
  /** Stage the promotion (role override) and ask the webui parent to restart the bot child. Called at most once. */
  requestPromotion: (info: { observedTerm: number; observedNodeId: string; staleForMs: number }) => void;
}

export class AutoPromoteWatcher {
  private timer: NodeJS.Timeout | null = null;
  private lastObserved: { term: number; nodeId: string; updatedAt: number } | null = null;
  private lastChangeAt: number | null = null;
  private lastReadOk: boolean | null = null;
  private fired = false;
  private ticking = false;
  private warnedNoUrl = false;

  constructor(private readonly hooks: AutoPromoteHooks) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TERM_STAMP_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): AutoPromoteStatusView {
    return {
      enabled: true,
      storeReadOk: this.lastReadOk,
      termStaleForMs: this.lastChangeAt === null ? null : Date.now() - this.lastChangeAt,
      fired: this.fired,
    };
  }

  private async tick(): Promise<void> {
    if (this.fired || this.ticking) return;
    this.ticking = true;
    try {
      await this.observe();
    } finally {
      this.ticking = false;
    }
  }

  private async observe(): Promise<void> {
    let backend: 'file' | 'postgres';
    try {
      backend = resolveDataBackend();
    } catch {
      return;
    }
    if (backend !== 'postgres') return;
    const creds = loadCredentials();
    const url = (creds.CONTROL_STORE_URL || '').trim() || (creds.DATA_BACKEND_URL || '').trim();
    if (!url) {
      if (!this.warnedNoUrl) {
        console.warn('[Fleet] Auto-promote watcher idle: no CONTROL_STORE_URL/DATA_BACKEND_URL known yet (delivered on the first register)');
        this.warnedNoUrl = true;
      }
      return;
    }
    // One short-lived client per tick: the connect doubles as the store
    // reachability probe and there is no reconnect state to get wrong. The
    // query timeout matters: a silently dead peer would otherwise hang the
    // SELECT for the OS TCP retransmission timeout with `ticking` latched,
    // blinding the watcher for many minutes.
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 5000, keepAlive: true });
    try {
      await client.connect();
      const res = await client.query(`SELECT term, node_id, updated_at FROM smdb_control.term WHERE id = 1`);
      this.lastReadOk = true;
      if (res.rows.length === 0) {
        // No master has ever acquired a term here; a BACKUP never bootstraps
        // a virgin fleet on its own.
        this.lastObserved = null;
        this.lastChangeAt = null;
        return;
      }
      const observed = {
        term: Number(res.rows[0].term),
        nodeId: String(res.rows[0].node_id),
        updatedAt: Number(res.rows[0].updated_at),
      };
      if (!this.lastObserved
          || observed.term !== this.lastObserved.term
          || observed.updatedAt !== this.lastObserved.updatedAt) {
        this.lastObserved = observed;
        this.lastChangeAt = Date.now();
        return;
      }
      const staleForMs = Date.now() - (this.lastChangeAt ?? Date.now());
      if (staleForMs < AUTO_PROMOTE_STALE_MS) return;
      if (this.hooks.masterConnected()) return;
      this.fired = true;
      console.warn(`[Fleet] AUTO-PROMOTION TRIGGERED: term ${observed.term} (node ${observed.nodeId.slice(0, 8)}) silent for ${Math.round(staleForMs / 1000)}s and the master WS is down; staging self-promotion`);
      this.hooks.requestPromotion({ observedTerm: observed.term, observedNodeId: observed.nodeId, staleForMs });
    } catch {
      // Unreachable or schema absent: no evidence either way, so DROP the
      // baseline (mirrors the boot guard's unreachable reset). The next
      // successful read starts a FRESH observation window; a read-blind
      // outage can never be counted as master silence, so the first read
      // after a heal cannot fire over a live master racing its next stamp.
      this.lastReadOk = false;
      this.lastObserved = null;
      this.lastChangeAt = null;
    } finally {
      await client.end().catch(() => { /* best effort */ });
    }
  }
}
