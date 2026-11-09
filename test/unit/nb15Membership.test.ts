import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB15 test 8 (decision 14): a member's server list on a Postgres bot. The local child's answer plus each other
// machine's holder process, one 'guild:membership' row per process and 100 ids; the notices; the kept answers and the
// limit of 2 fan-outs.
import { MEMBER_NOTICES, _resetMemberLists, memberServerList, type MemberListDeps } from '../../src/webui/utils/memberGuilds';
import type { Outcome, RemoteHolder } from '../../src/webui/utils/guildRequests';

const shardIdOf = (id: string, n: number) => Number((BigInt(id) >> 22n) % BigInt(n));
/** A guild id on the given shard of n. */
const onShard = (shard: number, n: number, k: number) => String(((BigInt(k) * BigInt(n) + BigInt(shard)) << 22n) + 1n);

function mapRow(shard: number, n: number, holder: { process: string; node: string; name: string } | null) {
  return holder
    ? { n, shard, holder_process: holder.process, holder_node: holder.node, holder_name: holder.name, claim: '1', released: false, reserved: false, ttl_ms: '30000', expires_up_ms: '90000', renewed_ago_ms: 10, up_ms: '1000', node_process_id: holder.process, node_takeover_seconds: 30, node_seen_ago_ms: 10 }
    : { n, shard, holder_process: null };
}

let sends: Array<{ holder: RemoteHolder; ids: string[] }>;
let answer: (holder: RemoteHolder, ids: string[]) => Promise<Outcome>;

function deps(over: Partial<MemberListDeps> = {}, map: any[] = []): MemberListDeps {
  return {
    localGuilds: async () => null,
    holderMap: async () => ({ rows: map, url: 'postgres://main' }),
    currentUrl: () => 'postgres://main',
    nodeId: () => 'n-a',
    membership: (holder, ids) => { sends.push({ holder, ids }); return answer(holder, ids); },
    ...over,
  };
}

const B = { process: 'p-b', node: 'n-b', name: 'BRAVO' };
const C = { process: 'p-c', node: 'n-c', name: 'CHARLIE' };
const HERE = { process: 'p-a', node: 'n-a', name: 'ALPHA' };
const everything = (_h: RemoteHolder, ids: string[]): Promise<Outcome> => Promise.resolve({ k: 'reply', reply: { success: true, guilds: ids.map(id => ({ id })) } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  _resetMemberLists();
  sends = [];
  answer = everything;
});
afterEach(() => vi.useRealTimers());

describe('the fan-out', () => {
  it("groups the member's servers per holder process of another machine, splits by 100, names the first id and its shard", async () => {
    const n = 16;
    const map = Array.from({ length: n }, (_, s) => mapRow(s, n, s < 8 ? B : C));
    const ids = Array.from({ length: 150 }, (_, k) => onShard(k % 8, n, k));
    const list = await memberServerList('m1', ids, deps({}, map));
    expect(sends).toHaveLength(2);
    expect(sends.every(s => s.holder.processId === 'p-b')).toBe(true);
    expect(sends.map(s => s.ids.length)).toEqual([100, 50]);
    for (const s of sends) expect(s.holder.shardId).toBe(shardIdOf(s.ids[0], n));
    expect(list).toEqual({ ids: new Set(ids), notice: null });
  });

  it('the local answer plus the holders; shards held by this node are skipped', async () => {
    const map = [mapRow(0, 2, HERE), mapRow(1, 2, B)];
    const local = onShard(0, 2, 1);
    const remote = onShard(1, 2, 1);
    const list = await memberServerList('m1', [local, remote], deps({ localGuilds: async () => ({ success: true, guilds: [{ id: local }] }) }, map));
    expect(sends.map(s => s.ids)).toEqual([[remote]]);
    expect(list).toEqual({ ids: new Set([local, remote]), notice: null });
  });

  it.each([
    ['a holder that does not answer', [mapRow(0, 1, B)], () => Promise.resolve({ k: 'no-answer', cause: 'timeout' } as Outcome), MEMBER_NOTICES.noAnswer],
    ['a shard with no held row', [mapRow(0, 1, null)], everything, MEMBER_NOTICES.noHolder],
    ['a holder the database cannot reach', [mapRow(0, 1, B)], () => Promise.resolve({ k: 'unreachable', cause: 'connect ECONNREFUSED' } as Outcome), MEMBER_NOTICES.noDatabase],
    ['a holder answer with incomplete', [mapRow(0, 1, B)], (_h: RemoteHolder, ids: string[]) => Promise.resolve({ k: 'reply', reply: { success: true, guilds: ids.map(id => ({ id })), incomplete: true } } as Outcome), MEMBER_NOTICES.connecting],
    ["shards of this machine while its child is not at guild", [mapRow(0, 1, HERE)], everything, MEMBER_NOTICES.starting],
  ] as const)('%s sets its notice', async (_what, map, how, notice) => {
    answer = how as any;
    const list = await memberServerList('m1', [onShard(0, 1, 3)], deps({}, map as any));
    expect(list.notice).toBe(notice);
  });

  it('a local answer with incomplete sets the connecting notice and is kept 5 s', async () => {
    const local = onShard(0, 2, 1);
    let localCalls = 0;
    const over = { localGuilds: async () => { localCalls += 1; return { success: true, guilds: [{ id: local }], incomplete: true }; } };
    const map = [mapRow(0, 2, HERE)];
    const first = await memberServerList('m1', [local], deps(over, map));
    expect(first).toEqual({ ids: new Set([local]), notice: MEMBER_NOTICES.connecting });
    await vi.advanceTimersByTimeAsync(4000);
    await memberServerList('m1', [local], deps(over, map));
    expect(localCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    await memberServerList('m1', [local], deps(over, map));
    expect(localCalls).toBe(2);
  });

  it('a failed map sets the first notice; no local child with remote answers lists them, never "Bot is not running"', async () => {
    const failed = await memberServerList('m1', [onShard(0, 1, 3)], deps({ holderMap: async () => { throw new Error('no'); } }));
    expect(failed).toEqual({ ids: new Set(), notice: MEMBER_NOTICES.noDatabase });
    _resetMemberLists();
    const id = onShard(0, 1, 3);
    expect(await memberServerList('m2', [id], deps({}, [mapRow(0, 1, B)]))).toEqual({ ids: new Set([id]), notice: null });
  });
});

describe('the bounds', () => {
  it('50 concurrent calls by one member make one fan-out; a call 10 s later gets the kept answer, 5 s with a notice', async () => {
    let release: () => void = () => undefined;
    answer = (_h, ids) => new Promise(resolve => { release = () => resolve({ k: 'reply', reply: { success: true, guilds: ids.map(id => ({ id })) } }); });
    const id = onShard(0, 1, 3);
    const calls = Array.from({ length: 50 }, () => memberServerList('m1', [id], deps({}, [mapRow(0, 1, B)])));
    await vi.advanceTimersByTimeAsync(0);
    release();
    await Promise.all(calls);
    expect(sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await memberServerList('m1', [id], deps({}, [mapRow(0, 1, B)]));
    expect(sends).toHaveLength(1);
    answer = () => Promise.resolve({ k: 'no-answer', cause: 'timeout' });
    _resetMemberLists();
    await memberServerList('m3', [id], deps({}, [mapRow(0, 1, B)]));
    expect(sends).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect((await memberServerList('m3', [id], deps({}, [mapRow(0, 1, B)]))).notice).toBe(MEMBER_NOTICES.noAnswer);
    expect(sends, 'an answer with a notice is kept 5 s').toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    await memberServerList('m3', [id], deps({}, [mapRow(0, 1, B)]));
    expect(sends).toHaveLength(3);
  });

  it('an answer without a notice is kept 30 s, not longer', async () => {
    const id = onShard(0, 1, 3);
    await memberServerList('m4', [id], deps({}, [mapRow(0, 1, B)]));
    await vi.advanceTimersByTimeAsync(29_000);
    await memberServerList('m4', [id], deps({}, [mapRow(0, 1, B)]));
    expect(sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    await memberServerList('m4', [id], deps({}, [mapRow(0, 1, B)]));
    expect(sends).toHaveLength(2);
  });

  it('calls by 50 members run at most 2 fan-outs at once; the others get the local part with the busy notice', async () => {
    answer = () => new Promise(() => undefined);
    const id = onShard(0, 1, 3);
    const results: any[] = [];
    for (let m = 0; m < 50; m++) void memberServerList(`m${m}`, [id], deps({}, [mapRow(0, 1, B)])).then(r => results.push(r));
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toHaveLength(2);
    expect(results).toHaveLength(48);
    expect(results.every(r => r.notice === MEMBER_NOTICES.busy)).toBe(true);
  });
});
