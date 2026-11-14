import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MEMBER_NOTICES, _resetMemberLists, memberNoticeOf, memberServerList, type MemberListDeps } from '../../src/webui/utils/memberGuilds';
import { changeDeadlineMs } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import type { Outcome, RemoteHolder } from '../../src/webui/utils/guildRequests';

const onShard = (shard: number, n: number, k: number) => String(((BigInt(k) * BigInt(n) + BigInt(shard)) << 22n) + 1n);

function mapRow(shard: number, n: number, holder: { process: string; node: string | null; name: string } | null) {
  return holder
    ? { n, shard, holder_process: holder.process, holder_node: holder.node, holder_name: holder.name, claim: '1', released: false, reserved: false, ttl_ms: '30000', expires_up_ms: '90000', renewed_ago_ms: 10, up_ms: '1000', node_process_id: holder.process, node_takeover_seconds: 30, node_seen_ago_ms: 10 }
    : { n, shard, holder_process: null };
}

type Send = { holder: RemoteHolder; ids: string[]; deadline: number };
let sends: Send[];
let answer: (holder: RemoteHolder, ids: string[]) => Promise<Outcome>;

function deps(over: Partial<MemberListDeps> = {}, map: any[] = []): MemberListDeps {
  return {
    localGuilds: async () => null,
    holderMap: async () => ({ rows: map, url: 'postgres://main' }),
    currentUrl: () => 'postgres://main',
    nodeId: () => 'n-a',
    membership: (holder, ids, _m, deadline) => { sends.push({ holder, ids, deadline }); return answer(holder, ids); },
    ...over,
  };
}

const B = { process: 'p-b', node: 'n-b', name: 'BRAVO' };
const HERE = { process: 'p-a', node: 'n-a', name: 'ALPHA' };
const everything = (_h: RemoteHolder, ids: string[]): Promise<Outcome> => Promise.resolve({ k: 'reply', reply: { success: true, guilds: ids.map(id => ({ id })) } });
const never = (): Promise<Outcome> => new Promise(() => undefined);

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

beforeEach(() => {
  _resetMemberLists();
  sends = [];
  answer = everything;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('memberNoticeOf', () => {
  it('a reply outcome without a reply body gets the failed notice', () => {
    expect(memberNoticeOf({ k: 'reply' } as any)).toBe(MEMBER_NOTICES.failed);
    expect(memberNoticeOf({ k: 'reply', reply: null })).toBe(MEMBER_NOTICES.failed);
    expect(memberNoticeOf({ k: 'reply', reply: { code: 'not-held' } })).toBe(MEMBER_NOTICES.notHeld);
  });
});

describe('the kept answers', () => {
  it('_resetMemberLists drops a fan-out in flight, so the next call starts a new one', async () => {
    answer = never;
    const id = onShard(0, 1, 3);
    void memberServerList('m1', [id], deps({}, [mapRow(0, 1, B)]));
    await flush();
    expect(sends).toHaveLength(1);
    _resetMemberLists();
    void memberServerList('m1', [id], deps({}, [mapRow(0, 1, B)]));
    await flush();
    expect(sends).toHaveLength(2);
  });

  it('an answer without a notice is no longer kept at exactly 30 s', async () => {
    let t = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    const id = onShard(0, 1, 3);
    await memberServerList('m1', [id], deps({}, [mapRow(0, 1, B)]));
    t += 29_999;
    await memberServerList('m1', [id], deps({}, [mapRow(0, 1, B)]));
    expect(sends).toHaveLength(1);
    t += 1;
    await memberServerList('m1', [id], deps({}, [mapRow(0, 1, B)]));
    expect(sends).toHaveLength(2);
  });

  it('an answer with a notice is no longer kept at exactly 5 s', async () => {
    let t = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    answer = () => Promise.resolve({ k: 'no-answer', cause: 'timeout' } as Outcome);
    const id = onShard(0, 1, 3);
    await memberServerList('m1', [id], deps({}, [mapRow(0, 1, B)]));
    t += 5000;
    await memberServerList('m1', [id], deps({}, [mapRow(0, 1, B)]));
    expect(sends).toHaveLength(2);
  });

  it("the end timer of an older answer does not drop a newer kept answer", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const id = onShard(0, 1, 3);
    await memberServerList('m1', [id], deps({}, [mapRow(0, 1, B)]));
    await vi.advanceTimersByTimeAsync(10_000);
    _resetMemberLists();
    await memberServerList('m1', [id], deps({}, [mapRow(0, 1, B)]));
    expect(sends).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(21_000);
    const list = await memberServerList('m1', [id], deps({}, [mapRow(0, 1, B)]));
    expect(sends, 'the newer answer is still kept 21 s after it was made').toHaveLength(2);
    expect(list).toEqual({ ids: new Set([id]), notice: null });
  });

  it('a list is answered when the timer handle has no unref (a plain timer id)', async () => {
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...a: any[]) => {
      const handle: any = real(fn, ms, ...a);
      handle.unref?.();
      return Number(handle);
    }) as any);
    const id = onShard(0, 1, 3);
    const list = await memberServerList('m1', [id], deps({}, [mapRow(0, 1, B)]));
    vi.restoreAllMocks();
    expect(list).toEqual({ ids: new Set([id]), notice: null });
  });
});

describe('the local part', () => {
  it('a busy list holds only the local servers the member administers', async () => {
    answer = never;
    const mine = onShard(0, 2, 1);
    const other = onShard(0, 2, 2);
    const remote = onShard(1, 2, 1);
    const map = [mapRow(0, 2, HERE), mapRow(1, 2, B)];
    const over = { localGuilds: async () => ({ success: true, guilds: [{ id: mine }, { id: other }] }) };
    void memberServerList('m1', [remote], deps({}, map));
    void memberServerList('m2', [remote], deps({}, map));
    await flush();
    expect(sends).toHaveLength(2);
    const busy = await memberServerList('m3', [mine, remote], deps(over, map));
    expect(busy).toEqual({ ids: new Set([mine]), notice: MEMBER_NOTICES.busy });
  });

  it('a fan-out lists only the local servers the member administers', async () => {
    const mine = onShard(0, 1, 1);
    const other = onShard(0, 1, 2);
    const over = { localGuilds: async () => ({ success: true, guilds: [{ id: mine }, { id: other }] }) };
    const list = await memberServerList('m1', [mine], deps(over, [mapRow(0, 1, HERE)]));
    expect(list).toEqual({ ids: new Set([mine]), notice: null });
    expect(sends).toHaveLength(0);
  });

  it("a server of this machine's shard that the running local child does not list gets no starting notice", async () => {
    const id = onShard(0, 1, 3);
    const over = { localGuilds: async () => ({ success: true, guilds: [] }) };
    const list = await memberServerList('m1', [id], deps(over, [mapRow(0, 1, HERE)]));
    expect(list).toEqual({ ids: new Set(), notice: null });
    expect(sends).toHaveLength(0);
  });
});

describe('the holder map', () => {
  it('a map without a url uses the current url', async () => {
    const id = onShard(0, 1, 3);
    const over = { holderMap: async () => ({ rows: [mapRow(0, 1, B)] }), currentUrl: () => 'postgres://current' };
    const list = await memberServerList('m1', [id], deps(over));
    expect(list).toEqual({ ids: new Set([id]), notice: null });
    expect(sends.map(s => s.holder.url)).toEqual(['postgres://current']);
  });

  it("a map with a url sends to the map's url", async () => {
    const id = onShard(0, 1, 3);
    const over = { holderMap: async () => ({ rows: [mapRow(0, 1, B)], url: 'postgres://map' }), currentUrl: () => 'postgres://current' };
    await memberServerList('m1', [id], deps(over));
    expect(sends.map(s => s.holder.url)).toEqual(['postgres://map']);
  });

  it('a map whose stored count is 0 gives the no-holder notice', async () => {
    const id = onShard(0, 1, 3);
    const list = await memberServerList('m1', [id], deps({}, [{ n: 0, shard: 0, holder_process: null }]));
    expect(list).toEqual({ ids: new Set(), notice: MEMBER_NOTICES.noHolder });
    expect(sends).toHaveLength(0);
  });

  it('a map whose rows carry no count gives the no-holder notice', async () => {
    const id = onShard(0, 1, 3);
    const list = await memberServerList('m1', [id], deps({}, [{ shard: 0, holder_process: null }]));
    expect(list).toEqual({ ids: new Set(), notice: MEMBER_NOTICES.noHolder });
    expect(sends).toHaveLength(0);
  });

  it('with no node id here, a holder row without a node is asked', async () => {
    const id = onShard(0, 1, 3);
    const list = await memberServerList('m1', [id], deps({ nodeId: () => null }, [mapRow(0, 1, { process: 'p-x', node: null, name: 'X' })]));
    expect(sends.map(s => s.ids)).toEqual([[id]]);
    expect(list).toEqual({ ids: new Set([id]), notice: null });
  });
});

describe('the sends', () => {
  it("the deadline is the membership change deadline after now", async () => {
    const t = 5000;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    await memberServerList('m1', [onShard(0, 1, 3)], deps({}, [mapRow(0, 1, B)]));
    expect(sends).toHaveLength(1);
    expect(sends[0].deadline).toBe(t + changeDeadlineMs('guild:membership'));
  });

  it('exactly 100 ids for one holder make one send and a full list', async () => {
    const ids = Array.from({ length: 100 }, (_, k) => onShard(0, 1, k + 1));
    const list = await memberServerList('m1', ids, deps({}, [mapRow(0, 1, B)]));
    expect(sends.map(s => s.ids.length)).toEqual([100]);
    expect(list).toEqual({ ids: new Set(ids), notice: null });
  });

  it('a holder whose member panel is off adds no notice; another code with no success gets the failed notice', async () => {
    const id = onShard(0, 1, 3);
    answer = () => Promise.resolve({ k: 'reply', reply: { success: false, code: 'member-panel-off' } });
    expect(await memberServerList('m1', [id], deps({}, [mapRow(0, 1, B)]))).toEqual({ ids: new Set(), notice: null });
    _resetMemberLists();
    answer = () => Promise.resolve({ k: 'reply', reply: { success: false, code: '' } });
    expect(await memberServerList('m2', [id], deps({}, [mapRow(0, 1, B)]))).toEqual({ ids: new Set(), notice: MEMBER_NOTICES.failed });
  });

  it('a reply outcome without a reply body gives the failed notice', async () => {
    const id = onShard(0, 1, 3);
    answer = () => Promise.resolve({ k: 'reply' } as any);
    expect(await memberServerList('m1', [id], deps({}, [mapRow(0, 1, B)]))).toEqual({ ids: new Set(), notice: MEMBER_NOTICES.failed });
  });

  it('a reply listing a server that was not asked about does not add it', async () => {
    const id = onShard(0, 1, 3);
    const stranger = onShard(0, 1, 9);
    answer = () => Promise.resolve({ k: 'reply', reply: { success: true, guilds: [{ id }, { id: stranger }] } });
    expect(await memberServerList('m1', [id], deps({}, [mapRow(0, 1, B)]))).toEqual({ ids: new Set([id]), notice: null });
  });
});
