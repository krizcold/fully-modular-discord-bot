import { EventEmitter } from 'events';

import { claimTimings, type ClaimRow, type Me } from '../../src/bot/internalSetup/fleet/claimRules';
import { MemClaimStore } from './fakeClaimStore';

// NB9 part 4b: the pieces a standby process's rows share. The store starts as decision 6's start leaves it (an attempt
// open in 'standby' from N to W) beside the old process's rows of N, written as NB4's take writes them; the channel
// records what the standby sends its web UI and delivers what the web UI sends.

export const AT = 'a1b2c3d4-0000-4000-8000-0000000000b4';
export const T = claimTimings(30);
export const ENTRY = 'postgres://claims@db.example/bot';
export const OLD: Me = { processId: 'p-a-old', nodeId: 'n-a', nodeName: 'A' };

export class FakeChannel extends EventEmitter {
  sent: any[] = [];
  readonly send = (message: unknown): boolean => {
    this.sent.push(message);
    return true;
  };

  of(type: string): any[] {
    return this.sent.filter(m => m?.type === type);
  }

  answers(requestId: string): any[] {
    return this.sent.filter(m => m?.requestId === requestId);
  }

  deliver(message: object): void {
    this.emit('message', message);
  }
}

export function claimRow(shardCount: number, shardId: number, holder: Me, over: Partial<ClaimRow> = {}): ClaimRow {
  return {
    shardCount, shardId, claim: 100 + shardCount * 10 + shardId, holderProcess: holder.processId, holderNode: holder.nodeId,
    holderName: holder.nodeName, homeNode: holder.nodeId, released: false, reserved: false, takenAt: 0, renewedAt: 0,
    ttlMs: T.ttlMs, expiresUpMs: 10_000_000, extended: false, ...over,
  };
}

/** The store after decision 6's start: meta N, the old rows of N live, the attempt open in 'standby' toward W. */
export function standbyStore(n = 4, w = 8): MemClaimStore {
  const store = new MemClaimStore(() => Date.now());
  store.count = n;
  for (let s = 0; s < n; s++) store.rows.set(`${n}:${s}`, claimRow(n, s, OLD));
  store.nodes.set(OLD.nodeId, {
    nodeId: OLD.nodeId, nodeName: OLD.nodeName, processId: OLD.processId, capacity: 8, takeoverSeconds: 30, fit: true,
    restartable: true, returns: false, seenAgoMs: 0, healthyForMs: null, seenAt: Date.now(), healthySince: Date.now(),
  });
  store.startAttempt(AT, n, w);
  return store;
}

/** Decision 8's flip and 10's close as committed: meta W and the attempt 'done'. */
export function markDone(store: MemClaimStore, w = 8): void {
  store.count = w;
  store.reshard = { ...store.reshard, state: 'done' };
}

export function standbyEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    SMDB_RESHARD_STANDBY: AT, SMDB_RESHARD_COUNT: '8', SMDB_RESHARD_INTENTS: String(1 | 512), SMDB_RESHARD_MC: '1',
    SMDB_RESHARD_DB: ENTRY, DISCORD_TOKEN: 'token-standby', ...over,
  };
}

/** /gateway/bot as Discord answers it, parsed. */
export function gatewayAnswer(remaining: number, resetAfterMs = 3_600_000) {
  return { info: { recommendedShards: 8, sessionStartLimit: { total: 1000, remaining, resetAfterMs, maxConcurrency: 1 } }, error: null };
}

export function lineLog() {
  const lines: string[] = [];
  const put = (...a: unknown[]) => { lines.push(a.map(x => (x instanceof Error ? x.message : String(x))).join(' ')); };
  return { lines, log: { log: put, warn: put, error: put } };
}
