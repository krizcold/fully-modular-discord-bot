import type { ClientConfig } from 'pg';
import type { SaveAck, SaveOrderRow } from '../../src/bot/internalSetup/fleet/claimStore';
import { MemClaimStore } from './fakeClaimStore';

// NX5's unit rigs (sheets/NX5.md section 6, items 1 to 6): the save order as the claims pool reads it, a claims store
// that answers the order read and records the answers, and a world of fake probe sessions that answer the boot pass
// and the maintenance boot's poll, the order read included, per host.

export const MESSAGE = 'Moving the main database tonight.';

/** One read of smdb_manager.save_order as decision 8 maps it: current is generation = the database's generation. */
export const order = (over: Partial<SaveOrderRow> = {}): SaveOrderRow => ({
  orderId: 'o-1', state: 'maintenance', message: MESSAGE, current: true, ...over,
});

export const pgError = (code: string, message = `failed with ${code}`) => Object.assign(new Error(message), { code });

/** The claims store with decision 8's order read and decision 9's answer write. */
export class OrderStore extends MemClaimStore {
  /** What the next order read answers: a row, no order (null), or an error it rejects with. */
  saveOrder: SaveOrderRow | null | Error = null;
  /** ms before the order read answers; 0 answers at once. */
  orderDelayMs = 0;
  orderReads = 0;
  acks: SaveAck[] = [];
  /** Whether the answer's WHERE EXISTS finds the order current at 'maintenance' (a void or earlier order writes nothing). */
  ackLands = true;

  async readSaveOrder(): Promise<SaveOrderRow | null> {
    this.orderReads += 1;
    if (this.orderDelayMs > 0) await new Promise<void>(resolve => { setTimeout(resolve, this.orderDelayMs); });
    if (this.saveOrder instanceof Error) throw this.saveOrder;
    return this.saveOrder;
  }

  async writeSaveAck(ack: SaveAck): Promise<boolean> {
    if (!this.ackLands) return false;
    this.acks.push(ack);
    return true;
  }
}

export const ME = { processId: 'p-a', nodeId: 'node-a', nodeName: 'Contabo' };

/** Lets the promise chains a call started run to their end, under fake timers too. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------------------------------------------
// The probe world: shortLivedClient is mocked to fakeSession, so the real probePass and askOne run over these hosts.
// ---------------------------------------------------------------------------------------------------------------

export interface HostSpec {
  /** The connect fails with 28000. */
  refuse?: boolean;
  /** ms before the connect answers (a host that does not answer waits PROBE_CONNECT_MS in the real client). */
  connectMs?: number;
  /** The connect never answers. */
  hang?: boolean;
  rec?: boolean;
  ro?: boolean;
  /** The generation row; 0 is no row. */
  generation?: number;
  /** The save_order row as SQL answers it, no row (null), an error, or a read that never answers ('hang'). */
  order?: { order_id: string; state: 'maintenance' | 'running'; message: string; current: boolean } | null | Error | 'hang';
}

export const world = new Map<string, HostSpec>();
export const sessionLog: Array<{ host: string; text: string }> = [];

export const orderRow = (over: Partial<{ order_id: string; state: 'maintenance' | 'running'; message: string; current: boolean }> = {}) => ({
  order_id: 'o-1', state: 'maintenance' as const, message: MESSAGE, current: true, ...over,
});

const later = <T>(ms: number, value: () => T): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      try { resolve(value()); } catch (error) { reject(error); }
    }, ms);
  });

export function fakeSession(config: ClientConfig) {
  const host = String(config.host);
  const spec = (): HostSpec => world.get(host) ?? { hang: true };
  return {
    on() { return this; },
    async connect() {
      const s = spec();
      if (s.hang) return new Promise(() => undefined);
      const answer = () => {
        if (s.refuse) throw pgError('28000', `password authentication failed for user "bot"`);
        return undefined;
      };
      return s.connectMs ? later(s.connectMs, answer) : answer();
    },
    async query(text: string) {
      const s = spec();
      sessionLog.push({ host, text });
      if (/smdb_manager\.save_order/.test(text)) {
        if (s.order === 'hang') return new Promise(() => undefined);
        if (s.order instanceof Error) throw s.order;
        return { rows: s.order ? [s.order] : [] };
      }
      if (/pg_is_in_recovery/.test(text)) return { rows: [{ rec: s.rec === true, ro: s.ro ? 'on' : 'off', started: `${host}-start`, sysid: host }] };
      if (/FROM smdb_manager\.generation/.test(text)) return { rows: s.generation ? [{ machine: host, generation: s.generation, since: '2026-11-16' }] : [] };
      if (/FROM smdb_data\.meta/.test(text)) return { rows: [] };
      return { rows: [] };
    },
    async end() { return undefined; },
  };
}

/** A DATA_BACKEND_URL entry for a host of the world. */
export const entry = (host: string) => `postgres://bot:pw@${host}:5432/bot`;
