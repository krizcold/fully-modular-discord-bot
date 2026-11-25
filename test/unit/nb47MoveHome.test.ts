import { describe, expect, it } from 'vitest';

import { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings, planReturns, type ClaimRow, type Me, type NodeRow } from '../../src/bot/internalSetup/fleet/claimRules';

// NB47, owner ruling 2026-11-25: a machine's shards return to it after an outage even when they were passed on while
// it was down. A move sets the shard's home to the receiver only when the mover is that home; a move of a shard homed
// at another node keeps that home, so the return rule brings it back once the home is healthy for 5 minutes.

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
const D: Me = { processId: 'p-d', nodeId: 'n-d', nodeName: 'D' };

function dbClaim(shardId: number, home: string) {
  return {
    shard_count: 4, shard_id: shardId, claim: String(10 + shardId), holder_process: 'p-a', holder_node: 'n-a', holder_name: 'A',
    home_node: home, released: false, reserved: false, taken_at: 1, renewed_at: 2, ttl_ms: '30000',
    expires_up_ms: '50000', extended: false, renewed_ago_ms: 10,
  };
}

function dbNode(nodeId: string, extra: Record<string, unknown> = {}) {
  return {
    node_id: nodeId, node_name: nodeId.slice(2).toUpperCase(), process_id: `p-${nodeId.slice(2)}`, capacity: 2, takeover_seconds: 30,
    fit: true, restartable: true, returns: true, seen_ago_ms: 100, healthy_for_ms: 400_000, ...extra,
  };
}

const isRelease = (text: string) => /SET released = true, reserved = false/.test(text);

async function release(claims: any[], nodes: any[], handOvers: Array<{ shardId: number; receiver: string; move: boolean }>): Promise<Sent> {
  const { pool, sent } = fakePool(text => {
    if (isRelease(text)) return { rows: [] };
    if (/^\s*SELECT up_ms::text/.test(text)) return { rows: [{ up_ms: String(UP), u_prime: String(UP), now_ms: 5000 }] };
    if (/FROM smdb_data\.shard_claims/.test(text)) return { rows: claims };
    if (/FROM smdb_data\.shard_nodes/.test(text)) return { rows: nodes };
    return { rows: [] };
  });
  await storeWith(pool).release({ me: A, reserved: [], handOvers, ttlMs: 30_000 });
  const call = sent.find(s => isRelease(s.text));
  if (!call) throw new Error('the release statement was not sent');
  return call;
}

/**
 * The home_node the release statement writes for a row this process holds, read from the statement as sent: its
 * CASE expression evaluated with SQL's null rules over the row, the hand-over the statement joined to it, and the
 * bound parameters. Any syntax outside that small grammar fails the test instead of guessing.
 */
function homeWritten(call: Sent, shardId: number, homeBefore: string): string {
  const assignment = /\bhome_node = (CASE WHEN [\s\S]+? END),/.exec(call.text);
  if (!assignment) throw new Error('no CASE assignment of home_node in the release statement');
  const parts = /^CASE WHEN ([\s\S]+?) THEN (\S+) ELSE (\S+) END$/.exec(assignment[1].trim());
  if (!parts) throw new Error(`unparsed home_node expression: ${assignment[1]}`);
  const at = (call.values[7] as number[]).indexOf(shardId);
  const t = at < 0 ? { move: null, node_id: null } : { move: (call.values[9] as boolean[])[at], node_id: (call.values[8] as string[])[at] };
  const ref = (s: string): unknown => {
    if (s === 'c.home_node') return homeBefore;
    if (s === 't.node_id') return t.node_id;
    if (s === 't.move') return t.move;
    const param = /^\$(\d+)(::text)?$/.exec(s);
    if (param) return call.values[Number(param[1]) - 1];
    throw new Error(`unknown term ${s}`);
  };
  const holds = (atom: string): boolean => {
    const isTrue = /^(\S+) IS TRUE$/.exec(atom);
    if (isTrue) return ref(isTrue[1]) === true;
    const eq = /^(\S+) = (\S+)$/.exec(atom);
    if (eq) {
      const l = ref(eq[1]);
      const r = ref(eq[2]);
      return l !== null && r !== null && l === r;
    }
    throw new Error(`unknown condition ${atom}`);
  };
  const value = ref(parts[1].split(/\s+AND\s+/).every(holds) ? parts[2] : parts[3]);
  if (typeof value !== 'string') throw new Error(`home_node would be ${String(value)}`);
  return value;
}

describe('NB47: the home a move writes', () => {
  it('a move of a shard homed at another node keeps that home', async () => {
    const call = await release([dbClaim(2, 'n-k')], [dbNode('n-a'), dbNode('n-d')], [{ shardId: 2, receiver: 'n-d', move: true }]);
    expect(call.values[1]).toBe('n-a');
    expect(call.values[8]).toEqual(['n-d']);
    expect(homeWritten(call, 2, 'n-k')).toBe('n-k');
  });

  it('a move of a shard homed at the mover makes the receiver its home', async () => {
    const call = await release([dbClaim(1, 'n-a')], [dbNode('n-a'), dbNode('n-d')], [{ shardId: 1, receiver: 'n-d', move: true }]);
    expect(homeWritten(call, 1, 'n-a')).toBe('n-d');
  });

  it('a return and a row kept for this node keep their home', async () => {
    const call = await release([dbClaim(0, 'n-a'), dbClaim(3, 'n-d')], [dbNode('n-a'), dbNode('n-d')], [{ shardId: 3, receiver: 'n-d', move: false }]);
    expect(homeWritten(call, 3, 'n-d')).toBe('n-d');
    expect(homeWritten(call, 0, 'n-a')).toBe('n-a');
  });
});

describe('NB47: shards passed on during an outage return to their home', () => {
  const pair = (shardId: number) => ({ shardCount: 4, shardId, claim: 10 + shardId });
  const ruleNode = (nodeId: string, over: Partial<NodeRow> = {}): NodeRow => ({
    nodeId, nodeName: nodeId.slice(2).toUpperCase(), processId: `p-${nodeId.slice(2)}`, capacity: 2, takeoverSeconds: 30,
    fit: true, restartable: true, returns: true, seenAgoMs: 100, healthyForMs: 400_000, ...over,
  });
  const ruleRow = (shardId: number, holder: Me, home: string): ClaimRow => ({
    shardCount: 4, shardId, claim: 10 + shardId, holderProcess: holder.processId, holderNode: holder.nodeId, holderName: holder.nodeName,
    homeNode: home, released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: UP + 30_000, extended: false,
  });

  it('K1 down, A holds its own 0 and 1 and K1\'s 2 and 3 at target 2: A moves 2 and 3 to D, and once K1 has been healthy for 5 minutes D returns both to K1', async () => {
    const kDown = ruleNode('n-k', { seenAgoMs: 600_000, healthyForMs: null });
    const before = [ruleRow(0, A, 'n-a'), ruleRow(1, A, 'n-a'), ruleRow(2, A, 'n-k'), ruleRow(3, A, 'n-k')];
    const moves = planReturns({ me: A, capacity: 2, held: [0, 1, 2, 3].map(pair), rows: before, nodes: [ruleNode('n-a'), ruleNode('n-d'), kDown], upMs: UP });
    expect(moves).toEqual([{ shardId: 3, receiver: 'n-d', move: true }, { shardId: 2, receiver: 'n-d', move: true }]);

    const call = await release(
      [dbClaim(0, 'n-a'), dbClaim(1, 'n-a'), dbClaim(2, 'n-k'), dbClaim(3, 'n-k')],
      [dbNode('n-a'), dbNode('n-d'), dbNode('n-k', { seen_ago_ms: 600_000, healthy_for_ms: null })],
      moves,
    );
    expect(call.values[7]).toEqual([3, 2]);
    const after = [
      ruleRow(0, A, homeWritten(call, 0, 'n-a')),
      ruleRow(1, A, homeWritten(call, 1, 'n-a')),
      ruleRow(2, D, homeWritten(call, 2, 'n-k')),
      ruleRow(3, D, homeWritten(call, 3, 'n-k')),
    ];
    const dHolds = { me: D, capacity: 2, held: [pair(2), pair(3)], rows: after, upMs: UP };

    expect(planReturns({ ...dHolds, nodes: [ruleNode('n-a'), ruleNode('n-d'), ruleNode('n-k', { healthyForMs: 299_000 })] })).toEqual([]);
    expect(planReturns({ ...dHolds, nodes: [ruleNode('n-a'), ruleNode('n-d'), ruleNode('n-k', { healthyForMs: 300_000 })] }))
      .toEqual([{ shardId: 2, receiver: 'n-k', move: false }, { shardId: 3, receiver: 'n-k', move: false }]);
  });

  it('a shard A moved from its own home stays with D when A comes back healthy', async () => {
    const call = await release([dbClaim(1, 'n-a')], [dbNode('n-a'), dbNode('n-d')], [{ shardId: 1, receiver: 'n-d', move: true }]);
    const after = [ruleRow(1, D, homeWritten(call, 1, 'n-a'))];
    expect(planReturns({ me: D, capacity: 2, held: [pair(1)], rows: after, nodes: [ruleNode('n-a', { capacity: 3 }), ruleNode('n-d')], upMs: UP })).toEqual([]);
  });
});
