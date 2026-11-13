import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import type { FenceToken, FlushOutcome, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { FakeStore, tokenFor } from '../helpers/fakeStore';

afterEach(() => {
  vi.restoreAllMocks();
});

let guilds = 0;
const freshGuild = () => `rk10-${++guilds}`;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};

class EpochStore extends FakeStore {
  epochCalls = 0;
  callsAtAnswer: number | null = null;
  held: { resolve: (o: FlushOutcome) => void } | null = null;
  holdNext = false;

  databaseEpoch(): number {
    this.epochCalls += 1;
    return 7;
  }

  override flushGuild(guildId: string, batch: GuildFlushBatch, token: FenceToken): Promise<FlushOutcome> {
    if (this.holdNext) {
      this.holdNext = false;
      const d = deferred<FlushOutcome>();
      this.held = d;
      return d.promise;
    }
    return super.flushGuild(guildId, batch, token).then(outcome => {
      this.callsAtAnswer = this.epochCalls;
      return outcome;
    });
  }
}

async function readySet(store: EpochStore, ws: WorkingSetManager): Promise<string> {
  const g = freshGuild();
  expect(await ws.hydrate(g, tokenFor())).toBe('ready');
  return g;
}

describe('a landed flush of a set flagged before its epoch is known', () => {
  it('keeps the flag and reads the database epoch once more after the answer, for the loop check only', async () => {
    const store = new EpochStore();
    const ws = new WorkingSetManager(store);
    const g = await readySet(store, ws);
    ws.markForResave('db-old');
    expect(ws.save(g, 'm', 'a.json', '{"a":1}')).toBe('accepted');
    expect(await ws.flushGuildNow(g, 2000)).toBe('ok');
    expect(store.doc(g, 'a.json')).toBe('{"a":1}');
    expect(ws.resaveGuilds()).toEqual([g]);
    expect(store.callsAtAnswer).not.toBeNull();
    expect(store.epochCalls - store.callsAtAnswer!).toBe(1);
  });
});

describe('flushAllDirty with no flagged set', () => {
  it('answers before a flush on the wire that comes back unanswered one turn later', async () => {
    const store = new EpochStore();
    const ws = new WorkingSetManager(store);
    const g = await readySet(store, ws);
    expect(ws.save(g, 'm', 'a.json', '{"a":1}')).toBe('accepted');
    store.holdNext = true;
    const now = ws.flushGuildNow(g, 2000);
    await vi.waitFor(() => expect(store.held).not.toBeNull(), { timeout: 1000, interval: 1 });
    const all = ws.flushAllDirty();
    void Promise.resolve().then(() => store.held!.resolve({ ok: false, reason: 'unavailable', commitUnanswered: true }));
    expect(await all).toEqual([]);
    expect(await now).toBe('pending');
    expect(ws.dirtyGuildIds()).toEqual([g]);
  });

  it('settles within three microtask turns on a set that owes nothing', async () => {
    const store = new EpochStore();
    const ws = new WorkingSetManager(store);
    await readySet(store, ws);
    let settled = false;
    void ws.flushAllDirty().then(() => { settled = true; });
    let turns = 0;
    while (!settled && turns < 50) {
      await Promise.resolve();
      turns += 1;
    }
    expect(settled).toBe(true);
    expect(turns).toBeLessThanOrEqual(3);
  });
});
