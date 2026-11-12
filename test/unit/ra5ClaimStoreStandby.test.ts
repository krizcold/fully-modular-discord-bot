import { describe, expect, it } from 'vitest';

import { ClaimFailure, ClaimStore, RENEWAL_SQL, STANDBY_RENEWAL_SQL, TAKE_INSERT_SQL } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings, type ClaimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

const T = claimTimings(30);
const ME = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };
const UP_MS = 10_000;
const ATTEMPT = '33333333-3333-4333-8333-333333333333';
const RESHARD_SQL = 'SELECT attempt::text AS attempt, state, reason, to_count FROM smdb_data.reshard WHERE id = 1';

interface Sent { text: string; values: unknown[] }

interface Fake {
  sent: Sent[];
  renewalRow?: Record<string, unknown>;
  reshard?: Record<string, unknown> | null;
  claimRows?: Record<string, unknown>[];
  hang?: (text: string) => boolean;
  delayMs?: (text: string) => number;
  fail?: (text: string) => Error | null;
}

function answer(f: Fake, text: string, v: unknown[]): { rows: any[] } {
  const wanted = Math.max(0, ...[...text.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  if (v.length < wanted) {
    const error = new Error(`bind message supplies ${v.length} parameters, but prepared statement "" requires ${wanted}`) as Error & { code: string };
    error.code = '08P01';
    throw error;
  }
  const t = text.trim();
  if (t === '') return { rows: [] };
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(t) || t.includes('pg_advisory_xact_lock')) return { rows: [] };
  if (text === RENEWAL_SQL || text === STANDBY_RENEWAL_SQL) return { rows: [f.renewalRow ?? { at: 5, rows: [] }] };
  if (t.startsWith('SELECT up_ms::text AS up_ms')) return { rows: [{ up_ms: String(UP_MS), u_prime: String(UP_MS), now_ms: 0 }] };
  if (text === RESHARD_SQL) return { rows: f.reshard ? [f.reshard] : [] };
  if (t.startsWith('SELECT') && t.includes('FROM smdb_data.shard_claims WHERE shard_count = $1')) return { rows: f.claimRows ?? [] };
  if (t.startsWith('SELECT') && t.includes('FROM smdb_data.shard_nodes')) return { rows: [] };
  if (t.startsWith('SELECT GREATEST(') && t.includes('max(claim)')) return { rows: [{ floor: '0' }] };
  if (t.startsWith("SELECT nextval('smdb_data.claim_seq')")) return { rows: Array.from({ length: Number(v[0]) }, (_, i) => ({ n: String(100 + i) })) };
  if (text === TAKE_INSERT_SQL) return { rows: (v[1] as number[]).map((id, i) => ({ shard_id: id, claim: String((v[2] as number[])[i]) })) };
  throw new Error(`unscripted statement: ${t.slice(0, 80)}`);
}

async function storeOver(f: Fake, timings: ClaimTimings = T): Promise<ClaimStore> {
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', timings);
  await (store as any).pool.end().catch(() => undefined);
  const client = {
    async query(config: any, values?: unknown[]) {
      const text = typeof config === 'string' ? config : config.text;
      const params = (typeof config === 'string' ? values : config.values) ?? [];
      f.sent.push({ text, values: params });
      if (f.hang?.(text)) return new Promise(() => undefined);
      const failure = f.fail?.(text);
      if (failure) throw failure;
      const delay = f.delayMs?.(text) ?? 0;
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      return answer(f, text, params);
    },
    release() { /* nothing held */ },
  };
  (store as any).pool = { async connect() { return client; }, async end() { /* nothing to close */ }, on() { return this; } };
  return store;
}

const heartbeat = { capacity: 4, takeoverSeconds: 30, fit: true, restartable: true, returns: false, startedAt: 1, countSetting: 4 };

describe('the renewal reports the target it wrote (NB9 31)', () => {
  const renewWith = async (row: Record<string, unknown>) => {
    const f: Fake = { sent: [], renewalRow: { at: 7, rows: [], prior_process: 'p-old', ...row } };
    const store = await storeOver(f);
    const got = await store.renew({ me: ME, pairs: [], ttlMs: T.ttlMs, heartbeat });
    await store.end();
    return got;
  };

  it('names no target when the statement wrote none', async () => {
    const got = await renewWith({ target_written: false, prior_setting: 2 });
    expect(got).toEqual({ at: 7, rows: [], priorProcess: 'p-old' });
    expect('targetWritten' in got).toBe(false);
  });

  it('names the target from the prior setting it found', async () => {
    const got = await renewWith({ target_written: true, prior_setting: '2' });
    expect(got.targetWritten).toEqual({ from: 2, to: 4 });
  });

  it('a prior setting of null reads as no setting, not 0', async () => {
    const got = await renewWith({ target_written: true, prior_setting: null });
    expect(got.targetWritten).toEqual({ from: null, to: 4 });
  });

  it('a row with no prior setting column reads as no setting, not NaN', async () => {
    const got = await renewWith({ target_written: true });
    expect(got.targetWritten).toEqual({ from: null, to: 4 });
  });
});

describe('the standby renewal (NB9 C14)', () => {
  it('sends each pair with its readiness and the TTL, in the statement\'s parameter order', async () => {
    const f: Fake = {
      sent: [],
      renewalRow: { at: 9, rows: JSON.stringify([{ shardCount: 4, shardId: 1, claim: '11', released: false, mine: true }]) },
    };
    const store = await storeOver(f);
    const got = await store.renewStandby({
      me: ME, ttlMs: 1234,
      pairs: [{ shardCount: 4, shardId: 1, claim: 11, ready: true }, { shardCount: 4, shardId: 3, claim: 13, ready: false }],
    });
    expect(got).toEqual({ at: 9, rows: [{ shardCount: 4, shardId: 1, claim: 11, released: false, mine: true }], priorProcess: null });
    const sent = f.sent.filter(s => s.text === STANDBY_RENEWAL_SQL);
    expect(sent).toHaveLength(1);
    expect(sent[0].values).toEqual([[4, 4], [1, 3], [11, 13], 'p-a', [true, false], 1234]);
    await store.end();
  });

  it('a renewal with no answer fails as a timeout that names the claim renewal', async () => {
    const f: Fake = { sent: [], hang: text => text === STANDBY_RENEWAL_SQL };
    const store = await storeOver(f, { ...T, renewMs: 30 });
    const error = await store.renewStandby({ me: ME, ttlMs: 1000, pairs: [] }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ClaimFailure);
    expect((error as ClaimFailure).failure).toEqual({ kind: 'timeout' });
    expect(((error as ClaimFailure).cause as Error).message).toBe('the claim renewal got no answer in time');
    await store.end();
  });
});

describe('the standby take (NB9 7 and 61)', () => {
  const request = (over: Record<string, unknown> = {}) => ({ me: ME, capacity: 4, ttlMs: 1000, attempt: ATTEMPT, shardCount: 2, ...over });
  const standby = { attempt: ATTEMPT, state: 'standby', reason: null, to_count: 2 };
  const liveElsewhere = (shardId: number) => ({
    shard_count: 2, shard_id: shardId, claim: String(50 + shardId), holder_process: 'p-b', holder_node: 'n-b', holder_name: 'B',
    home_node: 'n-b', released: false, reserved: false, taken_at: 0, renewed_at: 0, ttl_ms: '30000',
    expires_up_ms: String(UP_MS + 20_000), extended: false, renewed_ago_ms: 0,
  });
  const texts = (f: Fake) => f.sent.map(s => s.text);

  it('takes the free rows of W and commits them', async () => {
    const f: Fake = { sent: [], reshard: standby };
    const store = await storeOver(f);
    const got = await store.standbyTake(request());
    expect(got.kind).toBe('done');
    expect(got.kind === 'done' && got.taken).toEqual([{ shardCount: 2, shardId: 0, claim: 100 }, { shardCount: 2, shardId: 1, claim: 101 }]);
    expect(texts(f)[0]).toBe('BEGIN');
    expect(texts(f).at(-1)).toBe('COMMIT');
    expect(texts(f).filter(t => t === 'ROLLBACK')).toHaveLength(0);
    await store.end();
  });

  it('a take that found nothing to take rolls back', async () => {
    const f: Fake = { sent: [], reshard: standby, claimRows: [liveElsewhere(0), liveElsewhere(1)] };
    const store = await storeOver(f);
    const got = await store.standbyTake(request());
    expect(got.kind === 'done' && got.taken).toEqual([]);
    expect(texts(f)[0]).toBe('BEGIN');
    expect(texts(f).at(-1)).toBe('ROLLBACK');
    expect(texts(f)).not.toContain('COMMIT');
    await store.end();
  });

  it('a reshard row in another state takes nothing and rolls back', async () => {
    const f: Fake = { sent: [], reshard: { attempt: ATTEMPT, state: 'flipped', reason: 'r1', to_count: '2' } };
    const store = await storeOver(f);
    const got = await store.standbyTake(request());
    expect(got).toEqual({ kind: 'not-standby', attempt: ATTEMPT, state: 'flipped', reason: 'r1', toCount: 2 });
    expect(texts(f)).not.toContain(TAKE_INSERT_SQL);
    expect(texts(f).at(-1)).toBe('ROLLBACK');
    expect(texts(f)).not.toContain('COMMIT');
    await store.end();
  });

  it('a standby row of another attempt takes nothing', async () => {
    const other = '44444444-4444-4444-8444-444444444444';
    const f: Fake = { sent: [], reshard: { ...standby, attempt: other } };
    const store = await storeOver(f);
    const got = await store.standbyTake(request());
    expect(got).toEqual({ kind: 'not-standby', attempt: other, state: 'standby', reason: null, toCount: 2 });
    expect(texts(f)).not.toContain(TAKE_INSERT_SQL);
    expect(texts(f).at(-1)).toBe('ROLLBACK');
    await store.end();
  });

  it('no reshard row answers not-standby with nothing known', async () => {
    const f: Fake = { sent: [], reshard: null };
    const store = await storeOver(f);
    const got = await store.standbyTake(request());
    expect(got).toEqual({ kind: 'not-standby', attempt: null, state: null, reason: null, toCount: null });
    expect(texts(f).at(-1)).toBe('ROLLBACK');
    await store.end();
  });

  it('a failed statement inside the take rolls the transaction back', async () => {
    const serverError = Object.assign(new Error('boom'), { code: 'XX000' });
    const f: Fake = { sent: [], reshard: standby, fail: text => (text === RESHARD_SQL ? serverError : null) };
    const store = await storeOver(f);
    const error = await store.standbyTake(request()).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ClaimFailure);
    expect(texts(f).at(-1)).toBe('ROLLBACK');
    await store.end();
  });

  it('a take with no answer fails as a timeout that names the standby take', async () => {
    const f: Fake = { sent: [], reshard: standby, hang: text => text === RESHARD_SQL };
    const store = await storeOver(f, { ...T, renewMs: 20 });
    const error = await store.standbyTake(request()).then(() => null, (e: unknown) => e);
    expect((error as ClaimFailure).failure).toEqual({ kind: 'timeout' });
    expect(((error as ClaimFailure).cause as Error).message).toBe('the standby take got no answer in time');
    await store.end();
  });

  it('a take slower than one renewal period but inside two still answers', async () => {
    const f: Fake = { sent: [], reshard: standby, delayMs: text => (text === RESHARD_SQL ? 130 : 0) };
    const store = await storeOver(f, { ...T, renewMs: 100 });
    const got = await store.standbyTake(request());
    expect(got.kind === 'done' && got.taken).toHaveLength(2);
    await store.end();
  });
});
