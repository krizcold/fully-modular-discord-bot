import { describe, expect, it } from 'vitest';

import { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings, planReturns, type ClaimRow, type HandOver, type Me, type NodeRow } from '../../src/bot/internalSetup/fleet/claimRules';

// NB52: after a call-off the attempt is closed while the standby's rows of the new count are still live. The plan
// reads one count's page, so the release counts the rows of the count its held rows carry.

const T = claimTimings(30);
const UP = 1000;

interface Sent { text: string; values: unknown[] }

function fakePool(script: (text: string) => { rows: any[] }) {
  const sent: Sent[] = [];
  const pool = {
    async connect() {
      return {
        query(config: any, values?: unknown[]) {
          const text = typeof config === 'string' ? config : config.text;
          const bound = (typeof config === 'string' ? values : config.values) ?? [];
          sent.push({ text, values: bound });
          const answer = script(text);
          return Promise.resolve({ rows: answer.rows, rowCount: answer.rows.length });
        },
        release() { return undefined; },
      };
    },
    async end() { return undefined; },
    on() { return pool; },
  };
  return { pool, sent };
}

function storeWith(pool: object): ClaimStore {
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T);
  void (store as any).pool.end().catch(() => undefined);
  (store as any).pool = pool;
  return store;
}

const A: Me = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };
const K: Me = { processId: 'p-k', nodeId: 'n-k', nodeName: 'K' };
const KS: Me = { processId: 'p-ks', nodeId: 'n-k', nodeName: 'K' };

function dbClaim(count: number, shardId: number, holder: Me, home: string, released = false) {
  return {
    shard_count: count, shard_id: shardId, claim: String(10 * count + shardId), holder_process: holder.processId, holder_node: holder.nodeId,
    holder_name: holder.nodeName, home_node: home, released, reserved: false, taken_at: 1, renewed_at: 2, ttl_ms: '30000',
    expires_up_ms: '50000', extended: false, renewed_ago_ms: 10,
  };
}

function dbNode(nodeId: string) {
  return {
    node_id: nodeId, node_name: nodeId.slice(2).toUpperCase(), process_id: `p-${nodeId.slice(2)}`, capacity: 2, takeover_seconds: 30,
    fit: true, restartable: true, returns: true, seen_ago_ms: 100, healthy_for_ms: 400_000,
  };
}

const isRelease = (text: string) => /SET released = true, reserved = false/.test(text);

async function keptBy(me: Me, claims: any[], handOvers: HandOver[]): Promise<number[]> {
  const { pool, sent } = fakePool(text => {
    if (isRelease(text)) return { rows: [] };
    if (/^\s*SELECT up_ms::text/.test(text)) return { rows: [{ up_ms: String(UP), u_prime: String(UP), now_ms: 5000 }] };
    if (/FROM smdb_data\.shard_claims/.test(text)) return { rows: claims };
    if (/FROM smdb_data\.shard_nodes/.test(text)) return { rows: [dbNode('n-a'), dbNode('n-k')] };
    return { rows: [] };
  });
  await storeWith(pool).release({ me, reserved: [], handOvers, ttlMs: 30_000 });
  const call = sent.find(s => isRelease(s.text));
  if (!call) throw new Error('the release statement was not sent');
  return call.values[7] as number[];
}

const ruleNode = (nodeId: string): NodeRow => ({
  nodeId, nodeName: nodeId.slice(2).toUpperCase(), processId: `p-${nodeId.slice(2)}`, capacity: 2, takeoverSeconds: 30,
  fit: true, restartable: true, returns: true, seenAgoMs: 100, healthyForMs: 400_000,
});
const ruleRow = (shardId: number, holder: Me, home: string): ClaimRow => ({
  shardCount: 4, shardId, claim: 40 + shardId, holderProcess: holder.processId, holderNode: holder.nodeId, holderName: holder.nodeName,
  homeNode: home, released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: UP + 30_000, extended: false,
});

describe('NB52: the release counts the rows of the count the plan used', () => {
  const page = [ruleRow(0, A, 'n-a'), ruleRow(1, A, 'n-k'), ruleRow(2, A, 'n-k'), ruleRow(3, K, 'n-a')];
  const returns: HandOver[] = [{ shardId: 1, receiver: 'n-k', move: false }, { shardId: 2, receiver: 'n-k', move: false }];

  it('the plan on count 4\'s page returns 1 and 2 to K', () => {
    const held = [0, 1, 2].map(shardId => ({ shardCount: 4, shardId, claim: 40 + shardId }));
    expect(planReturns({ me: A, capacity: 2, held, rows: page, nodes: [ruleNode('n-a'), ruleNode('n-k')], upMs: UP })).toEqual(returns);
  });

  it('K\'s standby rows of count 8 left after a call-off do not drop those returns', async () => {
    const claims = [
      dbClaim(4, 0, A, 'n-a'), dbClaim(4, 1, A, 'n-k'), dbClaim(4, 2, A, 'n-k'), dbClaim(4, 3, K, 'n-a'),
      dbClaim(8, 5, KS, 'n-k'), dbClaim(8, 6, KS, 'n-k', true),
    ];
    expect(await keptBy(A, claims, returns)).toEqual([1, 2]);
  });

  it('rows of count 4 still fill K\'s return room', async () => {
    const claims = [
      dbClaim(4, 0, A, 'n-a'), dbClaim(4, 1, A, 'n-k'), dbClaim(4, 2, A, 'n-k'), dbClaim(4, 3, K, 'n-k'),
      dbClaim(8, 5, KS, 'n-k'),
    ];
    expect(await keptBy(A, claims, returns)).toEqual([1]);
  });
});
