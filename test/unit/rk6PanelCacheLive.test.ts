import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A, chunk 6: cacheIncomplete's shard and guild checks, 'panel:list' from a request row with a manager that
// has no getPanel, and 'panel:live' field checks and the version the asking web UI already has.
const pm = vi.hoisted(() => ({ manager: null as any }));

vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  return { ...real, getPanelManager: () => pm.manager };
});

import { Status } from 'discord.js';
import { _resetPanelHandler, answerPanelMessage, cacheIncomplete } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { _resetPanelLive, _setNotifyDb, noteLiveChange } from '../../src/bot/internalSetup/fleet/panelLive';
import { setBackendKind } from '../helpers/backendKind';

const G = String(1n << 22n);
const MISSING = { success: false, error: 'Missing required fields: guildId and panelId' };

function readyShards(...ids: number[]): Map<number, { status: unknown }> {
  return new Map(ids.map(id => [id, { status: Status.Ready }]));
}

function clientWith(guilds: unknown, over: Record<string, unknown> = {}) {
  return { ws: { shards: readyShards(0) }, guilds, ...over };
}

beforeEach(() => {
  setBackendKind('file');
  _resetPanelLive();
  _setNotifyDb(null, () => false);
  pm.manager = {
    getClient: () => null,
    getWebUIPanelList: () => [{ id: 'p' }],
  };
});

afterEach(() => {
  _resetPanelHandler();
  _resetPanelLive();
  setBackendKind(null);
});

describe('cacheIncomplete', () => {
  it('a missing client answers incomplete, with no shard to read', () => {
    expect(cacheIncomplete(undefined)).toBe(true);
    expect(cacheIncomplete(null)).toBe(true);
  });

  it('an empty shard list answers incomplete', () => {
    expect(cacheIncomplete(clientWith({ cache: new Map() }), [])).toBe(true);
    expect(cacheIncomplete({ ws: { shards: new Map() }, guilds: { cache: new Map() } })).toBe(true);
  });

  it('ready shards with no guild cache, no values function or no guilds answer complete', () => {
    expect(cacheIncomplete(clientWith({}))).toBe(false);
    expect(cacheIncomplete(clientWith({ cache: {} }))).toBe(false);
    expect(cacheIncomplete({ ws: { shards: readyShards(0) } })).toBe(false);
  });

  it('an empty slot in the guild cache is skipped', () => {
    expect(cacheIncomplete(clientWith({ cache: new Map([['x', undefined]]) }))).toBe(false);
  });

  it('an unavailable guild with no shard id and no shard count answers incomplete', () => {
    const guilds = { cache: new Map([[G, { id: G, available: false }]]) };
    expect(cacheIncomplete(clientWith(guilds))).toBe(true);
    expect(cacheIncomplete(clientWith(guilds), [0])).toBe(true);
  });

  it("an unavailable guild on a shard outside the list answers complete; on a listed one, incomplete", () => {
    const outside = { cache: new Map([[G, { id: G, available: false, shardId: 1 }]]) };
    expect(cacheIncomplete(clientWith(outside), [0])).toBe(false);
    const inside = { cache: new Map([[G, { id: G, available: false, shardId: 0 }]]) };
    expect(cacheIncomplete(clientWith(inside), [0])).toBe(true);
  });

  it("an unavailable guild with no shard id is placed by the client's shard count", () => {
    const guilds = { cache: new Map([[G, { id: G, available: false }]]) };
    expect(cacheIncomplete(clientWith(guilds, { options: { shardCount: 2 } }))).toBe(false);
    const on0 = String(2n << 22n);
    const there = { cache: new Map([[on0, { id: on0, available: false }]]) };
    expect(cacheIncomplete(clientWith(there, { options: { shardCount: 2 } }))).toBe(true);
  });

  it('a guild with its own shard id is not placed by the shard count', () => {
    const guilds = { cache: new Map([[G, { id: G, available: false, shardId: 0 }]]) };
    expect(cacheIncomplete(clientWith(guilds, { options: { shardCount: 2 } }))).toBe(true);
  });
});

describe("'panel:list' from a request row", () => {
  it('a manager without getPanel lists no panel and answers success', async () => {
    expect(await answerPanelMessage('panel:list', {}, 'request')).toEqual({ success: true, panels: [] });
    expect(await answerPanelMessage('panel:list', {}, 'ipc')).toEqual({ success: true, panels: [{ id: 'p' }] });
  });
});

describe("'panel:live'", () => {
  it.each([
    ['no guildId', { panelId: 'p' }],
    ['no panelId', { guildId: G }],
    ['a panelId that is not text', { guildId: G, panelId: 7 }],
  ] as const)('%s answers the missing-fields error', async (_name, data) => {
    expect(await answerPanelMessage('panel:live', data, 'ipc')).toEqual(MISSING);
  });

  it('no data answers the missing-fields error', async () => {
    expect(await answerPanelMessage('panel:live', null, 'ipc')).toEqual(MISSING);
  });

  it('the kept state is sent only while its version is above the version the asker has under the same since', async () => {
    const first = await answerPanelMessage('panel:live', { guildId: G, panelId: 'p' }, 'ipc');
    expect(first).toMatchObject({ success: true, data: null, version: 0 });
    const since = first.since as number;
    expect(typeof since).toBe('number');
    noteLiveChange(G, 'p', { content: 'v1' });

    const fresh = await answerPanelMessage('panel:live', { guildId: G, panelId: 'p' }, 'ipc');
    expect(fresh).toMatchObject({ success: true, data: { content: 'v1' }, since, version: 1 });

    const had = await answerPanelMessage('panel:live', { guildId: G, panelId: 'p', haveVersion: 1, haveSince: since }, 'ipc');
    expect(had).toMatchObject({ success: true, data: null, since, version: 1 });

    const fraction = await answerPanelMessage('panel:live', { guildId: G, panelId: 'p', haveVersion: 1.5, haveSince: since }, 'ipc');
    expect(fraction).toMatchObject({ success: true, data: { content: 'v1' }, version: 1 });

    const otherSince = await answerPanelMessage('panel:live', { guildId: G, panelId: 'p', haveVersion: 1, haveSince: since + 1 }, 'ipc');
    expect(otherSince).toMatchObject({ success: true, data: { content: 'v1' }, version: 1 });
  });
});
