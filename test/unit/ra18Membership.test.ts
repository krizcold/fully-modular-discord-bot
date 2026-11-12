import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  lease: null as { shardCount: number; shardIds: number[] } | null,
  client: null as any,
  invoked: 0,
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async orig => ({
  ...(await orig<any>()),
  getDataReadiness: () => ({ leasedShards: () => world.lease }),
}));
vi.mock('../../src/bot/internalSetup/utils/panelManager', async orig => ({
  ...(await orig<any>()),
  getPanelManager: () => ({ getClient: () => world.client, getPanel: () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/ipcCommandHandler', async orig => ({
  ...(await orig<any>()),
  findLocalCommand: (name: string) => (name === 'devtool' ? { name, devOnly: true } : undefined),
  answerInvokeMessage: async () => { world.invoked += 1; return { success: true, ran: true }; },
}));

import { Status } from 'discord.js';
import { GuildRequestSweep, membershipOf } from '../../src/bot/internalSetup/fleet/guildRequests';
import { ANSWER_SQL, REQUEST_CLAIM_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';

const GUILD = String(1n << 22n);

function readyClient(ids: string[], shards: number[]) {
  return {
    guilds: { cache: new Map(ids.map(id => [id, { id, name: `n${id}`, icon: null, memberCount: 3, available: true, shardId: 1 }])) },
    ws: { shards: new Map(shards.map(s => [s, { status: Status.Ready }])) },
  };
}

beforeEach(() => {
  world.lease = null;
  world.client = null;
  world.invoked = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('membershipOf', () => {
  it('a lease of another shard count answers no guild', () => {
    world.lease = { shardCount: 2, shardIds: [1] };
    world.client = readyClient([GUILD], [1]);
    expect(membershipOf([GUILD], 2)).toEqual({ success: true, guilds: [{ id: GUILD, name: `n${GUILD}`, icon: null, memberCount: 3 }] });
    expect(membershipOf([GUILD], 4)).toEqual({ success: true, guilds: [] });
  });

  it('with no leased shard asked, the answer is not marked incomplete', () => {
    world.lease = { shardCount: 2, shardIds: [0] };
    world.client = readyClient([GUILD], [0]);
    expect(membershipOf([GUILD], 2)).toEqual({ success: true, guilds: [] });
  });

  it('answers incomplete with no guild while there is no client yet', () => {
    world.lease = { shardCount: 2, shardIds: [1] };
    world.client = null;
    expect(membershipOf([GUILD], 2)).toEqual({ success: true, guilds: [], incomplete: true });
  });

  it('answers incomplete with no guild while the client has no guild manager yet', () => {
    world.lease = { shardCount: 2, shardIds: [1] };
    world.client = {};
    expect(membershipOf([GUILD], 2)).toEqual({ success: true, guilds: [], incomplete: true });
  });

  it('answers incomplete with no guild while the guild manager has no cache yet', () => {
    world.lease = { shardCount: 2, shardIds: [1] };
    world.client = { guilds: {} };
    expect(membershipOf([GUILD], 2)).toEqual({ success: true, guilds: [], incomplete: true });
  });
});

describe('the real start hooks of a command invoke', () => {
  it('a developer command sent from another machine is refused and never run', async () => {
    const answers = new Map<string, any>();
    let given = false;
    const sweep = new GuildRequestSweep({
      db: {
        query: async (text, values) => {
          if (text === REQUEST_CLAIM_SQL) {
            if (given) return { rows: [] };
            given = true;
            return {
              rows: [{
                id: 'c1', guild_id: GUILD, shard_count: 2, shard_id: 1, op: 'command:invoke', requested_by: 'ALPHA', left_ms: 30_000,
                body: JSON.stringify({ command: 'devtool', channelId: '123456789012345678', actor: { via: 'owner', userId: 'web-ui-owner' } }),
              }],
            };
          }
          if (text === ANSWER_SQL) answers.set(String(values[0]), JSON.parse(String(values[2])));
          return { rows: [], rowCount: 1 };
        },
      },
      processId: () => 'p-a',
      pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
      stoppedServing: () => false,
      isStopping: () => false,
      apply: async () => ({ ok: true }),
    });
    await sweep.pass();
    for (let i = 0; i < 200 && !answers.has('c1'); i++) await new Promise(resolve => setImmediate(resolve));
    expect(answers.get('c1')).toEqual({
      success: false, ran: false, code: 'not-allowed', command: 'devtool',
      error: '/devtool is a developer command and runs only from the console of its own machine; nothing was run.',
    });
    expect(world.invoked).toBe(0);
  });
});
