import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import type { FenceToken, FlushOutcome } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { FakeStore } from '../helpers/fakeStore';

// NB4 decision 16's drop lines (one per shard, shards and guilds in order) and decision 17's leave: a set whose
// shard comes back while its flush runs serves again, and one deposed meanwhile is never revived.

const managers: Array<[WorkingSetManager, string[]]> = [];

afterEach(() => {
  for (const [ws, guilds] of managers.splice(0)) for (const g of guilds) ws.evict(g);
  vi.restoreAllMocks();
});

const tokenOn = (shardId: number): FenceToken => ({ nodeId: 'node-a', claim: 3, processId: 'process-a', shardId, shardCount: 4 });

/** A manager whose store answers each flush with `answer` (null: the store commits). */
function rig() {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const store = new FakeStore();
  const ws = new WorkingSetManager(store);
  const guilds: string[] = [];
  managers.push([ws, guilds]);
  const real = store.flushGuild.bind(store);
  const ctl: { answer: FlushOutcome | null } = { answer: null };
  store.flushGuild = (async (...args: Parameters<typeof real>) => {
    const done = await real(...args);
    return ctl.answer ?? done;
  }) as typeof store.flushGuild;
  const add = async (guildId: string, shardId: number) => {
    expect(await ws.hydrate(guildId, tokenOn(shardId))).toBe('ready');
    guilds.push(guildId);
  };
  return { store, ws, ctl, add };
}

const UNANSWERED: FlushOutcome = { ok: false, reason: 'unavailable', commitUnanswered: true };
const DEPOSED: FlushOutcome = { ok: false, reason: 'deposed' };

describe("decision 16's drop lines", () => {
  it('list the shards in order, and each shard\'s guilds and unanswered guilds sorted and comma-separated', async () => {
    const { ws, ctl, add } = rig();
    await add('200', 1);
    await add('100', 1);
    await add('300', 0);
    for (const g of ['200', '100', '300']) expect(ws.save(g, 'm', 'a.json', '1')).toBe('accepted');
    ctl.answer = UNANSWERED;
    expect(await ws.flushGuildNow('200', 50)).toBe('held');
    expect(await ws.flushGuildNow('100', 50)).toBe('held');
    ctl.answer = DEPOSED;
    for (const g of ['200', '100', '300']) expect(await ws.flushGuildNow(g, 50)).toBe('deposed');
    expect(ws.takeDropLines()).toEqual([
      '[Shards] 1 unsaved change(s) of 1 guild(s) of shard 0 were dropped: 300',
      '[Shards] 2 unsaved change(s) of 2 guild(s) of shard 1 were dropped: 100, 200; guild(s) 100, 200 had a save whose answer never came, so some of these changes may have landed',
    ]);
  });

  it('a save that landed after an unanswered one clears the may-have-landed clause', async () => {
    const { ws, ctl, add } = rig();
    await add('400', 2);
    expect(ws.save('400', 'm', 'a.json', '1')).toBe('accepted');
    ctl.answer = UNANSWERED;
    expect(await ws.flushGuildNow('400', 50)).toBe('held');
    ctl.answer = null;
    expect(await ws.flushGuildNow('400', 50)).toBe('ok');
    expect(ws.save('400', 'm', 'a.json', '2')).toBe('accepted');
    ctl.answer = DEPOSED;
    expect(await ws.flushGuildNow('400', 50)).toBe('deposed');
    expect(ws.takeDropLines()).toEqual(['[Shards] 1 unsaved change(s) of 1 guild(s) of shard 2 were dropped: 400']);
  });
});

describe('a set unloaded as its shard leaves', () => {
  it('serves again when the shard is back by the time its flush lands', async () => {
    const { store, ws, add } = rig();
    await add('500', 0);
    expect(ws.save('500', 'm', 'a.json', '1')).toBe('accepted');
    await ws.unloadToFrozenRetained('500', () => false);
    expect(store.doc('500', 'a.json')).toBe('1');
    expect(ws.stateOf('500')).toBe('ready');
    expect(ws.save('500', 'm', 'a.json', '2')).toBe('accepted');
  });

  it('stays frozen when the shard is still gone', async () => {
    const { ws, add } = rig();
    await add('510', 0);
    expect(ws.save('510', 'm', 'a.json', '1')).toBe('accepted');
    await ws.unloadToFrozenRetained('510', () => true);
    expect(ws.stateOf('510')).toBe('frozen-retained');
  });

  it('is never revived when its flush was answered deposed, even with the shard back', async () => {
    const { ws, ctl, add } = rig();
    await add('520', 0);
    expect(ws.save('520', 'm', 'a.json', '1')).toBe('accepted');
    ctl.answer = DEPOSED;
    await ws.unloadToFrozenRetained('520', () => false);
    expect(ws.stateOf('520')).toBe('fenced');
    expect(ws.save('520', 'm', 'a.json', '2')).toBe('fenced');
  });
});
