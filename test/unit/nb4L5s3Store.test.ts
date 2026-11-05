import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLAIMS_APPLICATION_NAME,
  ClaimFailure,
  ClaimStore,
  classifyFailure,
  describeClass,
  toClaimRow,
  toNodeRow,
} from '../../src/bot/internalSetup/fleet/claimStore';
import { CLOCK_GAP_CAP_MS, claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

// NB4 decisions 4 and 5: the claims pool's name, the clock's tick, the renewal of this process's own rows, the read
// columns the page shows, the failure classes and their texts, and the idle connection error log.

const T = claimTimings(30);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Answer = { rows?: any[] } | 'hang';

function fakePool(script: (text: string) => Answer) {
  const texts: string[] = [];
  const pool = {
    async connect() {
      return {
        query(config: any) {
          const text = typeof config === 'string' ? config : config.text;
          texts.push(text);
          const answer = script(text);
          if (answer === 'hang') return new Promise(() => undefined);
          return Promise.resolve({ rows: answer.rows ?? [], rowCount: (answer.rows ?? []).length });
        },
        release() { /* nothing to free */ },
      };
    },
    async end() { /* nothing open */ },
    on() { return pool; },
  };
  return { pool, texts };
}

function storeWith(pool: object): ClaimStore {
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T);
  void (store as any).pool.end().catch(() => undefined);
  (store as any).pool = pool;
  return store;
}

const me = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };
const hb = { capacity: 4, takeoverSeconds: 30, fit: true, restartable: true, returns: true, startedAt: 0 };

function pageScript(text: string): Answer {
  if (/FROM smdb_data\.claim_clock/.test(text)) return { rows: [{ up_ms: '0', u_prime: '0', now_ms: 0 }] };
  if (/FROM smdb_data\.meta/.test(text)) return { rows: [{ value: '{"count":1}' }] };
  return { rows: [] };
}

const GAP = '(extract(epoch FROM (now() - ticked_at)) * 1000)::bigint';
const U_PRIME = `up_ms + LEAST(GREATEST(${GAP}, 0), ${CLOCK_GAP_CAP_MS})`;

function selectList(text: string, table: string): string[] {
  const m = new RegExp(`SELECT([\\s\\S]*?)FROM smdb_data\\.${table}`).exec(text);
  expect(m).not.toBeNull();
  return m![1].split(/,(?![^(]*\))/).map(c => c.trim()).filter(c => c.length > 0)
    .map(c => (/\bAS\s+(\w+)$/.exec(c)?.[1] ?? c));
}

describe('the claims pool', () => {
  it('connects as application_name smdb-claims, so its sessions are told apart in pg_stat_activity', async () => {
    expect(CLAIMS_APPLICATION_NAME).toBe('smdb-claims');
    const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T);
    expect((store as any).pool.options.application_name).toBe('smdb-claims');
    await store.end();
  });

  it('an idle claims connection error is logged with its message', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T);
    (store as any).pool.emit('error', new Error('socket reset'));
    expect(error).toHaveBeenCalledWith('[Shards] Idle claims connection error:', 'socket reset');
    await store.end();
  });
});

describe('the renewal statement', () => {
  async function renewalText(): Promise<string> {
    const { pool, texts } = fakePool(() => ({ rows: [{ at: 1000, prior_process: null, rows: [] }] }));
    await storeWith(pool).renew({ me, pairs: [{ shardCount: 1, shardId: 0, claim: 5 }], ttlMs: T.ttlMs, heartbeat: hb });
    expect(texts).toHaveLength(1);
    return texts[0];
  }

  it('ticks the clock by the database time since the last tick, capped', async () => {
    const text = await renewalText();
    expect(text).toContain('UPDATE smdb_data.claim_clock');
    expect(text).toContain(`SET last_gap_ms = GREATEST(${GAP}, 0)`);
    expect(text).toContain(`up_ms = ${U_PRIME},`);
  });

  it('renews the rows this process holds under the claim numbers it sent, and only those', async () => {
    const text = await renewalText();
    const mine = '(c.holder_process = $4 AND (c.shard_count, c.shard_id, c.claim) IN (SELECT shard_count, shard_id, claim FROM pairs))';
    expect(text).toContain(`SET expires_up_ms = CASE WHEN ${mine} THEN t.up_ms + $13::bigint`);
    expect(text).toContain(`WHERE ${mine} OR (t.last_gap_ms > ${CLOCK_GAP_CAP_MS}`);
    expect(text).toContain(`${mine} AS mine`);
  });
});

describe('the reads', () => {
  it('the page read takes the clock and its u prime from the database', async () => {
    const { pool, texts } = fakePool(pageScript);
    await storeWith(pool).readPage(1);
    const clock = texts.find(t => /FROM smdb_data\.claim_clock/.test(t));
    expect(clock).toContain(`SELECT up_ms::text AS up_ms, (${U_PRIME})::text AS u_prime`);
  });

  it('the release keeps rows with an expiry from u prime', async () => {
    const { pool, texts } = fakePool(pageScript);
    await storeWith(pool).release({ me, reserved: [], handOvers: [], ttlMs: T.ttlMs });
    const release = texts.find(t => /UPDATE smdb_data\.shard_claims c/.test(t));
    expect(release).toContain(`SELECT ${U_PRIME} AS u FROM smdb_data.claim_clock`);
  });

  it('the page read selects every claim and node field the page shows', async () => {
    const { pool, texts } = fakePool(pageScript);
    await storeWith(pool).readPage(1);
    const claims = texts.find(t => /FROM smdb_data\.shard_claims WHERE shard_count = \$1 ORDER BY shard_id/.test(t))!;
    expect(selectList(claims, 'shard_claims')).toEqual([
      'shard_count', 'shard_id', 'claim', 'holder_process', 'holder_node', 'holder_name', 'home_node', 'released',
      'reserved', 'taken_at', 'renewed_at', 'ttl_ms', 'expires_up_ms', 'extended', 'renewed_ago_ms',
    ]);
    const nodes = texts.find(t => /FROM smdb_data\.shard_nodes ORDER BY node_name/.test(t))!;
    expect(selectList(nodes, 'shard_nodes')).toEqual([
      'node_id', 'node_name', 'process_id', 'capacity', 'takeover_seconds', 'fit', 'restartable', 'returns',
      'seen_ago_ms', 'healthy_for_ms',
    ]);
    expect(nodes).toContain('CASE WHEN healthy_since IS NULL THEN NULL ELSE');
  });
});

describe('the failure classes and texts', () => {
  it('a hung renewal fails as a ClaimFailure "timeout" caused by "the claim renewal got no answer in time"', async () => {
    vi.useFakeTimers();
    const { pool } = fakePool(() => 'hang');
    const result = storeWith(pool).renew({ me, pairs: [], ttlMs: T.ttlMs, heartbeat: hb }).catch(e => e);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    const error = await result;
    expect(error).toBeInstanceOf(ClaimFailure);
    expect(String(error)).toBe('ClaimFailure: timeout');
    expect(String(error.cause)).toBe('ClaimTimeoutError: the claim renewal got no answer in time');
  });

  it('describes each class in the words the logs carry', () => {
    expect(describeClass({ kind: 'refused' })).toBe('refused');
    expect(describeClass({ kind: 'timeout' })).toBe('timeout');
    expect(describeClass({ kind: 'unreachable', detail: 'connect ECONNREFUSED' })).toBe('unreachable: connect ECONNREFUSED');
    expect(describeClass({ kind: 'error', code: '40001', message: 'could not serialize' })).toBe('error: SQLSTATE 40001 could not serialize');
    expect(new ClaimFailure({ kind: 'refused' }).message).toBe('refused');
  });

  it('a thrown null, undefined or function with a code is unreachable, never a server error', () => {
    expect(classifyFailure(null)).toEqual({ kind: 'unreachable', detail: 'null' });
    expect(classifyFailure(undefined)).toEqual({ kind: 'unreachable', detail: 'undefined' });
    const fn = Object.assign(() => undefined, { code: '40001' });
    expect(classifyFailure(fn)).toEqual({ kind: 'unreachable', detail: String(fn) });
  });
});

describe('the rows as read', () => {
  const claimRow = (flags: boolean) => ({
    shard_count: 2, shard_id: 1, claim: '7', holder_process: 'p', holder_node: 'n', holder_name: 'N', home_node: 'n',
    released: flags, reserved: flags, taken_at: 1, renewed_at: 2, ttl_ms: '30000', expires_up_ms: '9', extended: flags,
    renewed_ago_ms: 3,
  });
  const nodeRow = (flags: boolean, healthy: unknown, drop = false) => {
    const r: any = {
      node_id: 'n', node_name: 'N', process_id: 'p', capacity: 4, takeover_seconds: 30, fit: flags, restartable: flags,
      returns: flags, seen_ago_ms: 1, healthy_for_ms: healthy,
    };
    if (drop) delete r.healthy_for_ms;
    return r;
  };

  it.each([true, false])('claim flags read %s stay %s', flags => {
    const row = toClaimRow(claimRow(flags));
    expect([row.released, row.reserved, row.extended]).toEqual([flags, flags, flags]);
  });

  it.each([true, false])('node flags read %s stay %s', flags => {
    const row = toNodeRow(nodeRow(flags, 5));
    expect([row.fit, row.restartable, row.returns]).toEqual([flags, flags, flags]);
  });

  it('healthy-for is the number read, and null when the column is NULL or absent', () => {
    expect(toNodeRow(nodeRow(true, 5)).healthyForMs).toBe(5);
    expect(toNodeRow(nodeRow(true, 0)).healthyForMs).toBe(0);
    expect(toNodeRow(nodeRow(true, null)).healthyForMs).toBeNull();
    expect(toNodeRow(nodeRow(true, undefined, true)).healthyForMs).toBeNull();
  });
});
