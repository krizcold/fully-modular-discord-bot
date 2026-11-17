import { beforeEach, describe, expect, it } from 'vitest';

import { _resetMemberLists, memberNoticeOf, memberServerList, type MemberListDeps } from '../../src/webui/utils/memberGuilds';
import type { Outcome, RemoteHolder } from '../../src/webui/utils/guildRequests';

const onShard = (shard: number, n: number, k: number) => String(((BigInt(k) * BigInt(n) + BigInt(shard)) << 22n) + 1n);

function mapRow(shard: number, n: number, holder: { process: string; node: string; name: string }) {
  return { n, shard, holder_process: holder.process, holder_node: holder.node, holder_name: holder.name, claim: '1', released: false, reserved: false, ttl_ms: '30000', expires_up_ms: '90000', renewed_ago_ms: 10, up_ms: '1000', node_process_id: holder.process, node_takeover_seconds: 30, node_seen_ago_ms: 10 };
}

const B = { process: 'p-b', node: 'n-b', name: 'BRAVO' };
const HERE = { process: 'p-a', node: 'n-a', name: 'ALPHA' };

function deps(map: any[], membership: (h: RemoteHolder, ids: string[]) => Promise<Outcome>, over: Partial<MemberListDeps> = {}): MemberListDeps {
  return {
    localGuilds: async () => null,
    holderMap: async () => ({ rows: map, url: 'postgres://main' }),
    currentUrl: () => 'postgres://main',
    nodeId: () => 'n-a',
    membership,
    ...over,
  };
}

beforeEach(() => _resetMemberLists());

const cases: Array<[string, Outcome, string]> = [
  ['maintenance', { k: 'maintenance' }, 'Some servers could not be listed because the database is in maintenance; reload later.'],
  ['no-table', { k: 'no-table' }, 'Some servers could not be listed because the database has no table for requests between machines.'],
  ['insert-refused', { k: 'insert-refused', code: '42501', message: 'permission denied' }, 'Some servers could not be listed because the database refused the request.'],
  ['exiting', { k: 'exiting' }, 'Some servers could not be listed because this web panel is shutting down; reload once it is back.'],
  ['withdrawn-at-exit', { k: 'withdrawn-at-exit' }, 'Some servers could not be listed because this web panel is shutting down; reload once it is back.'],
  ['a not-held reply', { k: 'reply', reply: { success: false, code: 'not-held' } }, 'Some servers could not be listed because the bot that ran them stopped serving them; reload in a moment.'],
  ['not-taken', { k: 'not-taken' }, 'Some servers could not be listed because the bot that runs them did not take the request in time; reload in a moment.'],
  ['withdrawn', { k: 'withdrawn' }, 'Some servers could not be listed because the database did not confirm that the request was sent; reload to try again.'],
  ['no-answer unsettled', { k: 'no-answer', cause: 'unsettled' }, 'Some servers could not be listed because the database could not show whether the bot that runs them took the request; reload to try again.'],
  ['no-answer lost', { k: 'no-answer', cause: 'lost' }, 'Some servers could not be listed because the answer of the bot that runs them could not be read from the database; reload to try again.'],
  ['a failed reply', { k: 'reply', reply: { success: false, code: 'list-failed' } }, 'Some servers could not be listed because the bot that runs them could not list them; reload to try again.'],
];

describe('the notice text a member sees when a holder does not bring back a list', () => {
  it.each(cases)('memberNoticeOf %s gives its exact text', (_what, outcome, text) => {
    expect(memberNoticeOf(outcome)).toBe(text);
  });

  it.each(cases)('the server list after %s carries its exact text', async (_what, outcome, text) => {
    const list = await memberServerList('m1', [onShard(0, 1, 3)], deps([mapRow(0, 1, B)], () => Promise.resolve(outcome)));
    expect(list.ids.size).toBe(0);
    expect(list.notice).toBe(text);
  });

  it('a membership send that throws gives the can\'t confirm text', async () => {
    const list = await memberServerList('m1', [onShard(0, 1, 3)], deps([mapRow(0, 1, B)], () => Promise.reject(new Error('boom'))));
    expect(list.notice).toBe("Some servers could not be listed: this web panel can't confirm what happened to the request; reload to try again.");
  });

  it("shards of this machine while its child is not at its guild report give the starting text", async () => {
    const list = await memberServerList('m1', [onShard(0, 1, 3)], deps([mapRow(0, 1, HERE)], () => Promise.resolve({ k: 'not-taken' })));
    expect(list.notice).toBe("Some servers could not be listed because this machine's bot is starting or stopped; reload in a moment.");
  });

  it('a third member while 2 fan-outs run gets the local list with the busy text', async () => {
    const pending = deps([mapRow(0, 1, B)], () => new Promise<Outcome>(() => {}));
    const local = onShard(0, 1, 7);
    void memberServerList('m1', [onShard(0, 1, 3)], pending);
    void memberServerList('m2', [onShard(0, 1, 4)], pending);
    const list = await memberServerList('m3', [local, onShard(0, 1, 5)], deps([], () => Promise.resolve({ k: 'not-taken' }), {
      localGuilds: async () => ({ success: true, guilds: [{ id: local }] }),
    }));
    expect(list.ids).toEqual(new Set([local]));
    expect(list.notice).toBe('Some servers could not be listed right now because many members are loading this list; reload in a moment.');
  });
});
