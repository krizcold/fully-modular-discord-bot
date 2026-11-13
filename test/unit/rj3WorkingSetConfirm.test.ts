import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FenceToken, FlushFate, FlushOutcome, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { FakeStore, tokenFor } from '../helpers/fakeStore';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const guild = () => `rj3-${randomUUID()}`;

class SentStore extends FakeStore {
  readonly sentFor: string[] = [];
  landedOn: string | null = null;
  holdChecks = false;
  private readonly checks: Array<() => void> = [];

  async flushGuild(guildId: string, batch: GuildFlushBatch, token: FenceToken): Promise<FlushOutcome> {
    this.sentFor.push(guildId);
    if (this.landedOn !== null) {
      return { ok: false, reason: 'unavailable', detail: 'Connection terminated unexpectedly', commitUnanswered: true, landedOn: this.landedOn };
    }
    return super.flushGuild(guildId, batch, token);
  }

  async resolveFlush(guildId: string, flushId: string, sentClaim: number, token: FenceToken): Promise<FlushFate> {
    if (this.holdChecks) await new Promise<void>(resolve => { this.checks.push(resolve); });
    return super.resolveFlush(guildId, flushId, sentClaim, token);
  }

  releaseChecks(): void {
    for (const resume of this.checks.splice(0)) resume();
  }
}

async function ready(store: FakeStore, g: string): Promise<WorkingSetManager> {
  const ws = new WorkingSetManager(store);
  expect(await ws.hydrate(g, tokenFor())).toBe('ready');
  return ws;
}

const refTimers = () => process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length;
const drain = () => new Promise<void>(resolve => { setImmediate(resolve); });

describe('rj3: deposed log line', () => {
  it('a flush refused deposed logs the drop without claiming an unanswered save may have landed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new FakeStore();
    const g = guild();
    const ws = await ready(store, g);
    ws.save(g, 'm', 'doc.json', '{"a":1}');
    store.mode = 'deposed';
    expect(await ws.flushGuildNow(g, 2000)).toBe('deposed');
    const lines = error.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('[Data] Deposed writer'));
    expect(lines).toEqual([`[Data] Deposed writer: guild ${g} fenced by newer-owner (claim 9); dropping the guild's working set without flushing`]);
  });
});

describe('rj3: confirm', () => {
  it('a ticket its set holds nothing for answers unavailable at once', async () => {
    const store = new FakeStore();
    const g = guild();
    const ws = await ready(store, g);
    ws.save(g, 'm', 'doc.json', '{}');
    expect(await ws.flushGuildNow(g, 2000)).toBe('ok');
    const ticket = { ...ws.ticketFor(g), seq: ws.ticketFor(g).seq + 1 };
    const started = performance.now();
    expect(await ws.confirm(ticket, 300)).toBe('unavailable');
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('a write after an unanswered batch whose check fails is held, the unanswered one pending', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new FakeStore();
    const g = guild();
    const ws = await ready(store, g);
    ws.save(g, 'm', 'a.json', '{"a":1}');
    const first = ws.ticketFor(g);
    store.mode = 'lost-unanswered';
    expect(await ws.flushGuildNow(g, 2000)).toBe('pending');
    store.mode = 'commit';
    store.checkMode = 'unknown';
    ws.save(g, 'm', 'b.json', '{"b":2}');
    const second = ws.ticketFor(g);
    expect(await ws.confirm(second, 2000)).toBe('held');
    expect(await ws.confirm(first, 2000)).toBe('pending');
    expect(store.doc(g, 'b.json')).toBeUndefined();
    ws.evict(g);
  });

  it('a confirm whose deadline passes after its set was fenced and evicted answers unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new FakeStore();
    const g = guild();
    const ws = await ready(store, g);
    ws.save(g, 'm', 'doc.json', '{}');
    const ticket = ws.ticketFor(g);
    store.holding = true;
    const answer = ws.confirm(ticket, 60);
    ws.depose(g);
    ws.evict(g);
    expect(await answer).toBe('unavailable');
    store.release();
  });

  it('a confirm waiting on a flush on the wire sends no second batch', async () => {
    const store = new FakeStore();
    const g = guild();
    const ws = await ready(store, g);
    ws.save(g, 'm', 'doc.json', '{"v":1}');
    const ticket = ws.ticketFor(g);
    store.holding = true;
    const now = ws.flushGuildNow(g, 2000);
    const confirmed = ws.confirm(ticket, 2000);
    await drain();
    store.holding = false;
    store.release();
    expect(await now).toBe('ok');
    expect(await confirmed).toBe('ok');
    expect(store.flushesSent).toBe(1);
    expect(store.doc(g, 'doc.json')).toBe('{"v":1}');
  });

  it('a confirm racing a flush on the wire holds no referenced timer of its own', async () => {
    const store = new FakeStore();
    const g = guild();
    const ws = await ready(store, g);
    const before = refTimers();
    ws.save(g, 'm', 'doc.json', '{}');
    const ticket = ws.ticketFor(g);
    store.holding = true;
    const answer = ws.confirm(ticket, 2000);
    const during = refTimers();
    store.holding = false;
    store.release();
    expect(await answer).toBe('ok');
    expect(during).toBe(before);
  });

  it('a confirm that landed leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const store = new FakeStore();
    const g = guild();
    const ws = await ready(store, g);
    ws.save(g, 'm', 'doc.json', '{}');
    expect(vi.getTimerCount()).toBe(1);
    expect(await ws.confirm(ws.ticketFor(g), 2000)).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a check that ends with the set evicted waits one poll before answering unavailable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new SentStore();
    const g = guild();
    const ws = await ready(store, g);
    ws.save(g, 'm', 'doc.json', '{}');
    store.mode = 'lost-unanswered';
    expect(await ws.flushGuildNow(g, 5000)).toBe('pending');
    store.mode = 'commit';
    store.holdChecks = true;
    let settled: string | null = null;
    const answer = ws.flushGuildNow(g, 5000).then(outcome => { settled = outcome; return outcome; });
    ws.evict(g);
    store.releaseChecks();
    await drain();
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(25);
    expect(await answer).toBe('unavailable');
  });
});

describe('rj3: flushAllDirty and writesSettled', () => {
  it('a drain while a flush is on the wire sends no extra batch for it', async () => {
    const store = new FakeStore();
    const g = guild();
    const ws = await ready(store, g);
    ws.save(g, 'm', 'doc.json', '{"v":1}');
    store.holding = true;
    const now = ws.flushGuildNow(g, 2000);
    expect(await ws.flushAllDirty()).toEqual([]);
    store.holding = false;
    store.release();
    expect(await now).toBe('ok');
    expect(store.flushesSent).toBe(1);
    expect(store.commits.length).toBe(1);
  });

  it('a drain checks a set holding only an unanswered batch and sends it again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new FakeStore();
    const g = guild();
    const ws = await ready(store, g);
    ws.save(g, 'm', 'doc.json', '{"v":2}');
    store.mode = 'lost-unanswered';
    expect(await ws.flushGuildNow(g, 2000)).toBe('pending');
    store.mode = 'commit';
    expect(await ws.flushAllDirty()).toEqual([]);
    expect(store.checksSent).toBe(1);
    expect(store.doc(g, 'doc.json')).toBe('{"v":2}');
    expect(ws.writesSettled()).toBe(true);
  });

  it('a drain names no clean set and no set whose flush landed', async () => {
    const store = new FakeStore();
    const clean = guild();
    const dirty = guild();
    const ws = new WorkingSetManager(store);
    expect(await ws.hydrate(clean, tokenFor())).toBe('ready');
    expect(await ws.hydrate(dirty, tokenFor())).toBe('ready');
    ws.save(dirty, 'm', 'doc.json', '{}');
    expect(await ws.flushAllDirty()).toEqual([]);
    expect(store.doc(dirty, 'doc.json')).toBe('{}');
  });

  it('a drain names a set whose unanswered batch stays unchecked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new FakeStore();
    const g = guild();
    const ws = await ready(store, g);
    ws.save(g, 'm', 'doc.json', '{}');
    store.mode = 'lost-unanswered';
    expect(await ws.flushGuildNow(g, 2000)).toBe('pending');
    store.checkMode = 'unknown';
    expect(await ws.flushAllDirty()).toEqual([g]);
    ws.evict(g);
  });

  it('a set whose unanswered batch landed on the old database is not named by a drain and is not settled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new SentStore();
    const g = guild();
    const ws = await ready(store, g);
    ws.save(g, 'm', 'doc.json', '{}');
    store.landedOn = 'old-database';
    expect(await ws.flushGuildNow(g, 2000)).toBe('pending');
    store.checkMode = 'unknown';
    expect(await ws.flushAllDirty()).toEqual([]);
    expect(ws.writesSettled()).toBe(false);
    expect(ws.getBackendHealth().lastError).not.toBeNull();
    ws.evict(g);
  });
});

describe('rj3: the retry timer', () => {
  it('a retry flushes the held set only, never a clean set flagged for re-save', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new SentStore();
    const flagged = guild();
    const held = guild();
    const ws = new WorkingSetManager(store);
    expect(await ws.hydrate(flagged, tokenFor())).toBe('ready');
    ws.markForResave('old-database');
    ws.flagEpoch(0);
    expect(await ws.hydrate(held, tokenFor())).toBe('ready');
    ws.save(held, 'm', 'doc.json', '{"h":1}');
    store.mode = 'unavailable';
    expect(await ws.flushGuildNow(held, 2000)).toBe('held');
    store.mode = 'commit';
    store.sentFor.length = 0;
    await vi.advanceTimersByTimeAsync(1100);
    expect(store.sentFor).toEqual([held]);
    expect(store.doc(held, 'doc.json')).toBe('{"h":1}');
    expect(ws.resaveGuilds()).toEqual([flagged]);
  });

  it('a retry never sends the writes of a set deposed while its flush was on the wire', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new SentStore();
    const g = guild();
    const ws = await ready(store, g);
    ws.save(g, 'm', 'doc.json', '{"d":1}');
    store.mode = 'unavailable';
    store.holding = true;
    const now = ws.flushGuildNow(g, 5000);
    ws.depose(g);
    store.holding = false;
    store.release();
    expect(await now).toBe('deposed');
    store.mode = 'commit';
    await vi.advanceTimersByTimeAsync(1100);
    expect(store.flushesSent).toBe(1);
    expect(store.doc(g, 'doc.json')).toBeUndefined();
  });
});
