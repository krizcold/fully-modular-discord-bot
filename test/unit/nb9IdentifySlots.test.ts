import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaimFailure, ClaimPausedError, ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { SlotThrottler, parentSlotAsker, slotThrottlerBuilder, type SlotThrottlerDeps } from '../../src/bot/internalSetup/fleet/identifySlots';
import { parseGatewayInfo } from '../../src/bot/internalSetup/fleet/placement';
import { IngestService } from '../../src/bot/internalSetup/ingest/ingestService';

// NB9 test 6, the row of part 2 (C10): NB5's move rebuilds the claims pool, and the identify lane's statement on the
// old pool's wire is destroyed with it, as the renewal's and the work's are. The pool is a fake that answers as node-pg.

const T = claimTimings(30);

function hangingPool() {
  const released: Array<boolean | undefined> = [];
  const sent: string[] = [];
  const pool = {
    async connect() {
      const pending: Array<(e: Error) => void> = [];
      return {
        query(config: any) {
          sent.push(typeof config === 'string' ? config : config.text);
          return new Promise((_, reject) => { pending.push(reject); });
        },
        release(destroy?: boolean) {
          released.push(destroy);
          if (destroy === true) for (const reject of pending.splice(0)) reject(new Error('Connection terminated'));
        },
      };
    },
    async end() { /* nothing to close */ },
    on() { return pool; },
  };
  return { pool, released, sent };
}

describe('test 6: the identify lane and the move (C10)', () => {
  it("retarget destroys the identify lane's client, and the slot statement on it ends with ClaimPausedError", async () => {
    const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T);
    await (store as any).pool.end().catch(() => undefined);
    const f = hangingPool();
    (store as any).pool = f.pool;
    const slot = store.reserveIdentifySlot(0, 'p-a');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(f.sent).toHaveLength(1);
    store.retarget('postgres://nobody@127.0.0.1:1/other');
    await expect(slot).rejects.toBeInstanceOf(ClaimPausedError);
    expect(f.released[0]).toBe(true);
    await store.end();
  });
});

// Part 3: SlotThrottler (16) under fake timers. 'database' runs over a slot table that answers as decision 16's two
// statements do on the database's clock (here the faked Date): a grant when the bucket's last grant is 5.5 s old or
// older, else the time left.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function slotTable() {
  const last = new Map<number, number>();
  const sent: number[] = [];
  return {
    sent,
    reserve: async (bucket: number) => {
      sent.push(bucket);
      const now = Date.now();
      const at = last.get(bucket);
      if (at === undefined || at <= now - 5500) {
        last.set(bucket, now);
        return { granted: true as const };
      }
      return { granted: false as const, waitMs: Math.max(at + 5500 - now, 0) };
    },
  };
}

function rig(over: Partial<SlotThrottlerDeps> & { maxConcurrency?: number } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  const lines: string[] = [];
  const log = { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
  const table = slotTable();
  const throttler = new SlotThrottler(over.maxConcurrency ?? 1, { mode: 'database', reserve: table.reserve, renewMs: T.renewMs, log, random: () => 0, ...over });
  const start = Date.now();
  const granted: Array<{ shard: number; at: number }> = [];
  const wait = (shard: number, signal = new AbortController().signal) =>
    throttler.waitForIdentify(shard, signal).then(() => { granted.push({ shard, at: Date.now() - start }); });
  return { throttler, lines, table, granted, wait };
}

describe('test 6: SlotThrottler (16)', () => {
  it("'database': two shards of one bucket identify 5.5 s apart; two buckets do not wait on each other", async () => {
    const r = rig({ maxConcurrency: 2 });
    const all = Promise.all([r.wait(0), r.wait(2), r.wait(1)]);
    await vi.advanceTimersByTimeAsync(6000);
    await all;
    expect(r.granted).toEqual([{ shard: 0, at: 0 }, { shard: 1, at: 0 }, { shard: 2, at: 5500 }]);
  });

  it("'database': a 0-row answer waits the database's time plus the jitter (up to 500 ms), then asks again", async () => {
    const r = rig({ random: () => 1 });
    await r.table.reserve(0);
    const one = r.wait(0);
    await vi.advanceTimersByTimeAsync(5999);
    expect(r.granted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await one;
    expect(r.granted).toEqual([{ shard: 0, at: 6000 }]);
    expect(r.table.sent).toEqual([0, 0, 0]);
  });

  it("'database': a failed statement logs L23 at the first failure and again after 30 s, retrying every R", async () => {
    let fails = 9;
    const table = slotTable();
    const r = rig({
      reserve: async bucket => {
        if (fails > 0) {
          fails -= 1;
          throw new ClaimFailure({ kind: 'error', code: '57P01', message: 'terminating connection' });
        }
        return table.reserve(bucket);
      },
    });
    const one = r.wait(3);
    await vi.advanceTimersByTimeAsync(9 * T.renewMs);
    await one;
    const l23 = `[Shards] Cannot reserve a gateway login slot in the database (error: SQLSTATE 57P01 terminating connection); shard 3 waits and tries again every ${T.renewMs / 1000} s`;
    expect(r.lines).toEqual([l23, l23]);
    expect(r.granted).toEqual([{ shard: 3, at: 9 * T.renewMs }]);
  });

  it("'database': a slot statement during a pause gets ClaimPausedError and is retried after R with no L23 (C10)", async () => {
    let paused = true;
    const table = slotTable();
    const r = rig({ reserve: async bucket => { if (paused) { paused = false; throw new ClaimPausedError(); } return table.reserve(bucket); } });
    const one = r.wait(0);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    await one;
    expect(r.lines).toEqual([]);
    expect(r.granted).toEqual([{ shard: 0, at: T.renewMs }]);
  });

  it("'database': a 28000 switches the process to local spacing (L24)", async () => {
    let calls = 0;
    const r = rig({ reserve: async () => { calls += 1; throw new ClaimFailure({ kind: 'refused' }); } });
    const both = Promise.all([r.wait(0), r.wait(1)]);
    await vi.advanceTimersByTimeAsync(5500);
    await both;
    expect(calls).toBe(1);
    expect(r.throttler.mode()).toBe('local');
    expect(r.lines).toEqual(['[Shards] The database refused the login while shard 0 waited for a gateway login slot; this process spaces its own logins from now on']);
    expect(r.granted).toEqual([{ shard: 0, at: 0 }, { shard: 1, at: 5500 }]);
  });

  it('an aborted signal rejects and sends nothing; the next shard of the bucket is not held by it', async () => {
    const r = rig();
    const controller = new AbortController();
    controller.abort();
    await expect(r.throttler.waitForIdentify(0, controller.signal)).rejects.toThrow();
    expect(r.table.sent).toEqual([]);
    await r.wait(1);
    expect(r.granted).toEqual([{ shard: 1, at: 0 }]);
  });

  it('an abort while the shard waits for its turn rejects without a statement', async () => {
    const r = rig();
    const controller = new AbortController();
    const first = r.wait(0);
    const second = r.throttler.waitForIdentify(1, controller.signal);
    const outcome = second.then(() => 'granted', () => 'rejected');
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    expect(await outcome).toBe('rejected');
    expect(r.table.sent).toEqual([0, 0]);
  });

  it("'parent': the web UI's waitMs is waited, 0 grants; no answer within 5 s logs L25 and spaces locally", async () => {
    const answers = [2000, 0];
    const asks: number[] = [];
    const r = rig({ mode: 'parent', reserve: undefined, askParent: async bucket => { asks.push(bucket); return answers.shift() ?? null; } });
    const one = r.wait(0);
    await vi.advanceTimersByTimeAsync(2000);
    await one;
    expect(asks).toEqual([0, 0]);
    expect(r.granted).toEqual([{ shard: 0, at: 2000 }]);
    const two = r.wait(1);
    await vi.advanceTimersByTimeAsync(10);
    await two;
    expect(r.lines).toEqual(["[Shards] The web UI did not answer a gateway login slot request within 5 s; shard 1 uses this process's own spacing"]);
  });

  it("parentSlotAsker sends 'identify:slot' and resolves the answer of its nonce; null after 5 s", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sent: any[] = [];
    const listeners = new Set<(m: any) => void>();
    const channel = {
      send: (m: any) => { sent.push(m); return true; },
      on: (_: 'message', fn: (m: any) => void) => { listeners.add(fn); },
      off: (_: 'message', fn: (m: any) => void) => { listeners.delete(fn); },
    };
    const ask = parentSlotAsker(channel);
    const answered = ask(3);
    expect(sent).toEqual([{ type: 'identify:slot', data: { nonce: sent[0].data.nonce, bucket: 3 } }]);
    for (const fn of [...listeners]) fn({ type: 'identify:slot', data: { nonce: 'other', waitMs: 9 } });
    for (const fn of [...listeners]) fn({ type: 'identify:slot', data: { nonce: sent[0].data.nonce, waitMs: 0 } });
    expect(await answered).toBe(0);
    const silent = ask(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await silent).toBeNull();
    expect(listeners.size).toBe(0);
  });

  it("'local': 5.5 s per bucket inside the process", async () => {
    const r = rig({ mode: 'local', reserve: undefined });
    const all = Promise.all([r.wait(0), r.wait(0), r.wait(0)]);
    await vi.advanceTimersByTimeAsync(11_000);
    await all;
    expect(r.granted.map(g => g.at)).toEqual([0, 5500, 11000]);
  });

  it("the builder reads max_concurrency from the manager's gateway information, as @discordjs/ws's default does", async () => {
    const build = slotThrottlerBuilder({ mode: 'local', renewMs: T.renewMs });
    const throttler = await build({ fetchGatewayInformation: async () => ({ session_start_limit: { max_concurrency: 16 } }) });
    expect(throttler).toBeInstanceOf(SlotThrottler);
    expect(throttler.maxConcurrency).toBe(16);
  });
});

describe('17: max_concurrency from /gateway/bot', () => {
  it('reads it, and 1 when Discord sends none', () => {
    expect(parseGatewayInfo({ shards: 3, session_start_limit: { total: 1000, remaining: 990, reset_after: 5, max_concurrency: 16 } }).sessionStartLimit?.maxConcurrency).toBe(16);
    expect(parseGatewayInfo({ shards: 3, session_start_limit: { total: 1000, remaining: 990, reset_after: 5 } }).sessionStartLimit?.maxConcurrency).toBe(1);
  });
});

describe('16: the Client gets the identify throttler', () => {
  it("buildClient passes the ingest's throttler builder as ws.buildIdentifyThrottler", () => {
    const ingest = new IngestService();
    const build = async () => new SlotThrottler(1, { mode: 'local', renewMs: T.renewMs });
    ingest.setIdentifyThrottler(build);
    const client = ingest.buildClient({ intents: [] });
    expect((client.options.ws as any).buildIdentifyThrottler).toBe(build);
  });
});
