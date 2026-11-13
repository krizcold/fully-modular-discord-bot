import { afterEach, describe, expect, it, vi } from 'vitest';
import { commitAnswerOwed, WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import type { FenceToken, FlushFate, FlushOutcome, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { FakeStore, tokenFor } from '../helpers/fakeStore';

afterEach(() => {
  vi.restoreAllMocks();
});

let guilds = 0;
const freshGuild = () => `rj1-${++guilds}`;

class ScriptedStore extends FakeStore {
  readonly failures: FlushOutcome[] = [];
  readonly sent: GuildFlushBatch[] = [];
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  override async flushGuild(guildId: string, batch: GuildFlushBatch, token: FenceToken): Promise<FlushOutcome> {
    this.sent.push(structuredClone(batch));
    const failure = this.failures.shift();
    if (failure) {
      this.flushesSent += 1;
      return failure;
    }
    return super.flushGuild(guildId, batch, token);
  }

  holdChecks(): void {
    this.gate = new Promise<void>(resolve => { this.openGate = resolve; });
  }

  releaseChecks(): void {
    this.openGate?.();
    this.gate = null;
  }

  override async resolveFlush(guildId: string, flushId: string, sentClaim: number, token: FenceToken): Promise<FlushFate> {
    if (this.gate) await this.gate;
    return super.resolveFlush(guildId, flushId, sentClaim, token);
  }
}

async function readySet(seed: (store: ScriptedStore, g: string) => void = () => {}, token: FenceToken = tokenFor()) {
  const store = new ScriptedStore();
  const ws = new WorkingSetManager(store);
  const g = freshGuild();
  seed(store, g);
  expect(await ws.hydrate(g, token)).toBe('ready');
  return { store, ws, g };
}

const names = (keys: Array<{ module: string; filename: string }>) => keys.map(k => `${k.module}/${k.filename}`).sort();

function flagged(ws: WorkingSetManager, from = 'db-old'): void {
  ws.markForResave(from);
  ws.flagEpoch(0);
}

describe('a re-save the database refuses for a document\'s content', () => {
  for (const code of ['22P02', '23505', '54000']) {
    it(`is sent again without the dirty document for SQLSTATE ${code}, and that landing clears the flag`, async () => {
      const { store, ws, g } = await readySet((s, guild) => {
        s.docs.set(`${guild}|m/clean.json`, '{"c":1}');
        s.streams.set(`${guild}|m/log.txt`, 'line\n');
      });
      flagged(ws);
      expect(ws.save(g, 'm', 'bad.json', '{"bad":1}')).toBe('accepted');
      store.failures.push({ ok: false, reason: 'unavailable', code, detail: 'refused' });
      expect(await ws.flushGuildNow(g, 2000)).toBe('held');
      expect(store.sent.length).toBe(2);
      const resend = store.sent[1];
      expect(resend.upserts.map(u => `${u.key.module}/${u.key.filename}`)).toEqual(['m/clean.json']);
      expect(names(resend.replace!.docKeys)).toEqual(['m/bad.json', 'm/clean.json']);
      expect(names(resend.replace!.appendKeys)).toEqual(['m/bad.json', 'm/log.txt']);
      expect(ws.resaveGuilds()).not.toContain(g);
      expect(store.doc(g, 'bad.json')).toBeUndefined();
      expect(store.doc(g, 'clean.json')).toBe('{"c":1}');
    });
  }

  it('is not sent again for a failure that carries no SQLSTATE', async () => {
    const { store, ws, g } = await readySet(s => void s);
    flagged(ws);
    expect(ws.save(g, 'm', 'bad.json', '{"bad":1}')).toBe('accepted');
    store.failures.push({ ok: false, reason: 'unavailable', detail: 'connection refused' });
    expect(await ws.flushGuildNow(g, 2000)).toBe('held');
    expect(store.sent.length).toBe(1);
    expect(ws.resaveGuilds()).toContain(g);
  });
});

describe('a re-save batch', () => {
  it('keeps the held documents and streams, sends each upsert once, and leaves a deleted document out of the kept keys', async () => {
    const { store, ws, g } = await readySet((s, guild) => {
      s.docs.set(`${guild}|m/clean.json`, '{"c":1}');
      s.docs.set(`${guild}|m/gone.json`, '{"g":1}');
      s.docs.set(`${guild}|m/edited.json`, '{"e":1}');
      s.streams.set(`${guild}|m/log.txt`, 'line\n');
    });
    flagged(ws);
    expect(ws.save(g, 'm', 'edited.json', '{"e":2}')).toBe('accepted');
    expect(ws.delete(g, 'm', 'gone.json')).toBe('accepted');
    expect(await ws.flushGuildNow(g, 2000)).toBe('ok');
    expect(store.sent.length).toBe(1);
    const batch = store.sent[0];
    expect(names(batch.replace!.docKeys)).toEqual(['m/clean.json', 'm/edited.json']);
    expect(names(batch.replace!.appendKeys)).toEqual(['m/log.txt']);
    expect(names(batch.upserts.map(u => u.key))).toEqual(['m/clean.json', 'm/edited.json']);
    expect(names(batch.deletes)).toEqual(['m/gone.json']);
    expect(store.doc(g, 'edited.json')).toBe('{"e":2}');
    expect(store.doc(g, 'gone.json')).toBeUndefined();
    expect(ws.resaveGuilds()).not.toContain(g);
  });
});

describe('commitAnswerOwed', () => {
  it('is owed for a write at or before an unanswered batch, not for one after it', async () => {
    const { store, ws, g } = await readySet();
    store.mode = 'lost-unanswered';
    expect(ws.save(g, 'm', 'a.json', '{"a":1}')).toBe('accepted');
    const first = ws.ticketFor(g);
    expect(await ws.flushGuildNow(g, 2000)).toBe('pending');
    expect(ws.save(g, 'm', 'b.json', '{"b":1}')).toBe('accepted');
    const second = ws.ticketFor(g);
    expect(commitAnswerOwed(first)).toBe(true);
    expect(commitAnswerOwed(second)).toBe(false);
    store.mode = 'commit';
  });

  it('is owed while a flight\'s COMMIT is awaiting its answer, and not once it is answered', async () => {
    const { store, ws, g } = await readySet();
    expect(ws.save(g, 'm', 'a.json', '{"a":1}')).toBe('accepted');
    const ticket = ws.ticketFor(g);
    expect(commitAnswerOwed(ticket)).toBe(false);
    store.mode = 'commit-hang';
    const done = ws.flushGuildNow(g, 2000);
    expect(store.flushesSent).toBe(1);
    expect(commitAnswerOwed(ticket)).toBe(true);
    store.release();
    expect(await done).toBe('ok');
    expect(commitAnswerOwed(ticket)).toBe(false);
  });
});

describe('the latch and a graveyard restore', () => {
  it('a restore whose set was re-saved during it does not flag the set again when it reopens', async () => {
    const { store, ws, g } = await readySet((s, guild) => { s.docs.set(`${guild}|m/a.json`, '{"a":1}'); });
    expect(ws.beginRestore(g)).toBe(true);
    flagged(ws);
    expect(ws.resaveGuilds()).toEqual([g]);
    expect(await ws.flushGuildNow(g, 2000)).toBe('ok');
    expect(store.sent.length).toBe(1);
    expect(ws.resaveGuilds()).toEqual([]);
    ws.endRestore(g, 'reopen');
    expect(ws.stateOf(g)).toBe('ready');
    expect(ws.resaveGuilds()).toEqual([]);
    expect(await ws.flushGuildNow(g, 2000)).toBe('ok');
    expect(store.sent.length).toBe(1);
  });

  it('a set a restore ended by evict kept for its re-save is flagged again by a later latch', async () => {
    const { ws, g } = await readySet();
    expect(ws.beginRestore(g)).toBe(true);
    ws.markForResave('db-a');
    ws.endRestore(g, 'evict');
    expect(ws.has(g)).toBe(true);
    expect(ws.stateOf(g)).toBe('restoring');
    ws.markForResave('db-b');
    expect(ws.resaveGuilds()).toEqual([g]);
  });

  it('asks whether a shard is held only for the sets the latch may flag', async () => {
    const store = new ScriptedStore();
    const ws = new WorkingSetManager(store);
    const ready = freshGuild();
    const fenced = freshGuild();
    const hydrating = freshGuild();
    expect(await ws.hydrate(ready, { ...tokenFor(), shardId: 0, shardCount: 3 })).toBe('ready');
    expect(await ws.hydrate(fenced, { ...tokenFor(), shardId: 1, shardCount: 3 })).toBe('ready');
    expect(ws.beginRestore(fenced)).toBe(true);
    ws.noteRestoreSent(fenced);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ws.depose(fenced);
    expect(ws.stateOf(fenced)).toBe('fenced');
    store.hydrateMode = 'held';
    const pending = ws.hydrate(hydrating, { ...tokenFor(), shardId: 2, shardCount: 3 });
    expect(ws.stateOf(hydrating)).toBe('hydrating');
    const asked: number[] = [];
    ws.markForResave('db-a', shardId => { asked.push(shardId); return true; });
    expect(asked).toEqual([0]);
    expect(ws.resaveGuilds()).toEqual([ready]);
    store.releaseHydrations('ok');
    expect(await pending).toBe('ready');
  });
});

describe('shards', () => {
  it('a move\'s new claim reaches the shard\'s held sets and not a fenced one', async () => {
    const store = new ScriptedStore();
    const ws = new WorkingSetManager(store);
    const held = freshGuild();
    const fenced = freshGuild();
    const heldToken = { ...tokenFor(), shardId: 4 };
    const fencedToken = { ...tokenFor(), shardId: 4 };
    expect(await ws.hydrate(held, heldToken)).toBe('ready');
    expect(await ws.hydrate(fenced, fencedToken)).toBe('ready');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ws.depose(fenced);
    ws.replaceShardClaim(4, 777);
    expect(ws.fenceOf(held)?.claim).toBe(777);
    expect(ws.fenceOf(fenced)?.claim).toBe(fencedToken.claim);
  });

  it('guildsOfShard names the guilds held in that shard only', async () => {
    const store = new ScriptedStore();
    const ws = new WorkingSetManager(store);
    const a = freshGuild();
    const b = freshGuild();
    const c = freshGuild();
    expect(await ws.hydrate(a, { ...tokenFor(), shardId: 0, shardCount: 2 })).toBe('ready');
    expect(await ws.hydrate(b, { ...tokenFor(), shardId: 1, shardCount: 2 })).toBe('ready');
    expect(await ws.hydrate(c, { ...tokenFor(), shardId: 0, shardCount: 2 })).toBe('ready');
    expect(ws.guildsOfShard(0).sort()).toEqual([a, c].sort());
    expect(ws.guildsOfShard(1)).toEqual([b]);
    expect(ws.guildsOfShard(5)).toEqual([]);
  });
});

describe('evicting a set pending re-save', () => {
  it('evict keeps a flagged set and its flag', async () => {
    const { ws, g } = await readySet();
    flagged(ws);
    ws.evict(g);
    expect(ws.has(g)).toBe(true);
    expect(ws.resaveGuilds()).toEqual([g]);
  });

  it('evict drops a set with no flag', async () => {
    const { ws, g } = await readySet();
    ws.evict(g);
    expect(ws.has(g)).toBe(false);
  });

  it('dropRetired drops a flagged set, so the next hydrate reads the store again', async () => {
    const { store, ws, g } = await readySet();
    flagged(ws);
    const reads = store.hydrationsSent;
    ws.dropRetired(g);
    expect(ws.has(g)).toBe(false);
    expect(ws.resaveGuilds()).toEqual([]);
    expect(await ws.hydrate(g, tokenFor())).toBe('ready');
    expect(store.hydrationsSent).toBe(reads + 1);
  });
});

describe('a flush asked for while one is on the wire', () => {
  it('sends no second batch beside it; the write made meanwhile lands after it', async () => {
    const { store, ws, g } = await readySet();
    expect(ws.save(g, 'm', 'a.json', '{"a":1}')).toBe('accepted');
    store.holding = true;
    const first = ws.flushGuildNow(g, 3000);
    expect(store.flushesSent).toBe(1);
    expect(ws.save(g, 'm', 'b.json', '{"b":1}')).toBe('accepted');
    const all = ws.flushAllDirty();
    expect(store.flushesSent).toBe(1);
    store.holding = false;
    store.release();
    expect(await first).toBe('ok');
    expect(await all).toEqual([g]);
    expect(store.doc(g, 'a.json')).toBe('{"a":1}');
    expect(store.doc(g, 'b.json')).toBe('{"b":1}');
    expect(store.commits.length).toBe(2);
    expect(store.commits[1].batch.upserts.map(u => u.key.filename)).toEqual(['b.json']);
  });

  it('runs once more after that flight lands, even with nothing written meanwhile', async () => {
    const { store, ws, g } = await readySet((s, guild) => { s.docs.set(`${guild}|m/a.json`, '{"a":1}'); });
    flagged(ws);
    store.holding = true;
    const first = ws.flushGuildNow(g, 3000);
    expect(store.flushesSent).toBe(1);
    const all = ws.flushAllDirty();
    expect(store.flushesSent).toBe(1);
    expect(await all).toEqual([]);
    store.holding = false;
    store.release();
    expect(await first).toBe('ok');
    expect(store.flushesSent).toBe(2);
  });
});

describe('a check of an unanswered batch that ends after the set was deposed', () => {
  it('sends nothing from the deposed set and answers deposed', async () => {
    const { store, ws, g } = await readySet();
    store.mode = 'lost-unanswered';
    expect(ws.save(g, 'm', 'a.json', '{"a":1}')).toBe('accepted');
    const ticket = ws.ticketFor(g);
    expect(await ws.flushGuildNow(g, 2000)).toBe('pending');
    expect(store.flushesSent).toBe(1);
    store.mode = 'commit';
    store.holdChecks();
    const checking = ws.flushGuildNow(g, 2000);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ws.depose(g);
    store.releaseChecks();
    expect(await checking).toBe('deposed');
    expect(store.flushesSent).toBe(1);
    expect(store.doc(g, 'a.json')).toBeUndefined();
    expect(await ws.confirm(ticket, 500)).toBe('deposed');
    expect(ws.landedFlushes()).toBe(0);
  });
});
