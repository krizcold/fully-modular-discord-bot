import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkingSetManager, initWorkingSet, type FlushNowOutcome, type WsTicket } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import {
  appendData,
  confirmSaved,
  deleteGuildNamespace,
  saveData,
  saveHeldWrites,
  setGuildDataBackend,
  setOwnerInfoProvider,
} from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore, tokenFor, type FlushMode } from '../helpers/fakeStore';

// NB13 decisions 5 and 6: a batch whose COMMIT got no answer is held until a check finds whether it landed, and every
// caller is told only what is true of it.

let guilds = 5_100_000;
const freshGuild = () => String(++guilds);
const managers: Array<[WorkingSetManager, string[]]> = [];

afterEach(() => {
  for (const [ws, gs] of managers.splice(0)) for (const g of gs) ws.evict(g);
  setGuildDataBackend(null);
  setBackendKind(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function quiet() {
  return {
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  };
}

/** A manager on a scripted store with one hydrated guild. */
async function rig(facade = false) {
  const logs = quiet();
  const store = new FakeStore();
  const ws = facade ? initWorkingSet(store) : new WorkingSetManager(store);
  if (facade) {
    setBackendKind('postgres');
    setGuildDataBackend(store);
    setOwnerInfoProvider(() => ({ nodeId: 'node-a', processId: 'process-a', shardCount: 1, claimOf: () => 1 }));
  }
  const g = freshGuild();
  const token = tokenFor();
  expect(await ws.hydrate(g, token)).toBe('ready');
  managers.push([ws, [g]]);
  return { store, ws, g, token, logs, options: { guildId: g, category: 'm' } };
}

const streamOf = (store: FakeStore, g: string, name = 'l.jsonl') => store.streams.get(`${g}|m/${name}`);
const appendsSent = (store: FakeStore, text: string) =>
  store.commits.filter(c => c.batch.appends.some(a => a.chunk.includes(text))).length;
const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(c => c.map(String).join(' '));

/** Leaves the set in P3: its one batch sent under the mode, its COMMIT unanswered. */
async function unanswered(ws: WorkingSetManager, store: FakeStore, g: string, mode: FlushMode = 'landed-unanswered') {
  store.mode = mode;
  expect(await ws.flushGuildNow(g, 50)).toBe('pending');
  store.mode = 'commit';
}

async function runTimers(until: () => boolean, stepMs = 10, maxSteps = 400) {
  for (let i = 0; i < maxSteps && !until(); i++) await vi.advanceTimersByTimeAsync(stepMs);
}

describe('1.1 to 1.9: the held batch', () => {
  it('1.1 a batch that landed unanswered is stored once', async () => {
    const { store, ws, g } = await rig();
    ws.append(g, 'm', 'l.jsonl', 'a\n');
    const t = ws.ticketFor(g);
    await unanswered(ws, store, g);
    expect(await ws.confirm(t, 2000)).toBe('ok');
    expect(streamOf(store, g)).toBe('a\n');
    expect(appendsSent(store, 'a')).toBe(1);
  });

  it('1.2 a batch lost unanswered is resent after a check', async () => {
    const { store, ws, g } = await rig();
    ws.append(g, 'm', 'l.jsonl', 'a\n');
    const t = ws.ticketFor(g);
    await unanswered(ws, store, g, 'lost-unanswered');
    expect(await ws.confirm(t, 2000)).toBe('ok');
    expect(streamOf(store, g)).toBe('a\n');
    expect(store.checksSent).toBeGreaterThan(0);
  });

  it("1.3 a check answering unknown leaves the batch's ticket and the guild pending", async () => {
    const { store, ws, g } = await rig();
    ws.append(g, 'm', 'l.jsonl', 'a\n');
    const t = ws.ticketFor(g);
    await unanswered(ws, store, g);
    store.checkMode = 'unknown';
    expect(await ws.confirm(t, 2000)).toBe('pending');
    expect(await ws.flushGuildNow(g, 2000)).toBe('pending');
  });

  it("1.4 a check answering deposed with landed true: the batch's ticket ok, a later write deposed, the retire refused", async () => {
    vi.useFakeTimers();
    const { store, ws, g, logs, options } = await rig(true);
    store.retireMode = 'move';
    appendData('l.jsonl', options, 'a\n');
    const t1 = ws.ticketFor(g);
    await unanswered(ws, store, g);
    store.takeOver(g, false);
    saveData('b.json', options, { v: 2 });
    const t2 = ws.ticketFor(g);
    await runTimers(() => ws.stateOf(g) === 'fenced');
    expect(await ws.confirm(t1, 100)).toBe('ok');
    expect(await ws.confirm(t2, 100)).toBe('deposed');
    const before = [...store.streams];
    expect(await deleteGuildNamespace(g, 'test')).toBe(false);
    expect(lines(logs.error)).toContain(`[DataManager] Cannot retire guild ${g}: another bot process holds its data now; nothing was removed`);
    expect(store.graveyard.size).toBe(0);
    expect([...store.streams]).toEqual(before);
  });

  it("1.5 a check answering deposed with landed null: the batch's ticket unavailable, the retire can't confirm", async () => {
    vi.useFakeTimers();
    const { store, ws, g, logs, options } = await rig(true);
    store.retireMode = 'move';
    appendData('l.jsonl', options, 'a\n');
    const t1 = ws.ticketFor(g);
    await unanswered(ws, store, g);
    store.takeOver(g, true);
    await runTimers(() => store.checksSent > 0 && ws.stateOf(g) === 'fenced', 100);
    expect(await ws.confirm(t1, 100)).toBe('unavailable');
    expect(await confirmSaved(g, { deadlineMs: 100 })).toBe('unavailable');
    expect(lines(logs.error).some(l => l.startsWith('[Data] Deposed writer') && l.includes('a save whose COMMIT got no answer may have landed'))).toBe(true);
    expect(await deleteGuildNamespace(g, 'test')).toBe(false);
    expect(lines(logs.error)).toContain(`[DataManager] Cannot retire guild ${g}: can't confirm that its writes reached the store (unavailable); nothing was removed`);
    expect(store.graveyard.size).toBe(0);
  });

  it('1.6 a save made while the batch is unanswered is flushed in the same call once it landed', async () => {
    const { store, ws, g } = await rig();
    ws.save(g, 'm', 'a.json', '1');
    ws.append(g, 'm', 'l.jsonl', 'a\n');
    await unanswered(ws, store, g);
    ws.save(g, 'm', 'a.json', '2');
    ws.append(g, 'm', 'l.jsonl', 'b\n');
    expect(await ws.flushGuildNow(g, 2000)).toBe('ok');
    expect(store.doc(g, 'a.json')).toBe('2');
    expect(streamOf(store, g)).toBe('a\nb\n');
    expect(store.commits.at(-1)!.batch.appends).toEqual([{ key: { module: 'm', filename: 'l.jsonl' }, chunk: 'b\n' }]);
  });

  it('1.7 a delete of an appended key while unanswered leaves no row and sends no old line again', async () => {
    const { store, ws, g } = await rig();
    ws.append(g, 'm', 'l.jsonl', 'a\n');
    await unanswered(ws, store, g);
    expect(ws.delete(g, 'm', 'l.jsonl')).toBe('accepted');
    expect(await ws.flushGuildNow(g, 2000)).toBe('ok');
    expect(streamOf(store, g)).toBeUndefined();
    expect(appendsSent(store, 'a')).toBe(1);
  });

  it('1.8 a retire after an unanswered batch moves the line once', async () => {
    const { store, ws, g, options } = await rig(true);
    store.retireMode = 'move';
    appendData('l.jsonl', options, 'a\n');
    await unanswered(ws, store, g);
    expect(await deleteGuildNamespace(g, 'test')).toBe(true);
    expect(store.graveyard.get(`${g}|m/l.jsonl`)).toBe('a\n');
  });

  it('1.9 a frozen-retained set holding an unanswered batch reclaims nothing until the check answered', async () => {
    const { store, ws, g } = await rig();
    ws.save(g, 'm', 'a.json', '1');
    await unanswered(ws, store, g);
    ws.freeze(g);
    const reclaim = vi.spyOn(store, 'reclaimGuild');
    expect(await ws.hydrate(g, tokenFor())).toBe('unavailable');
    expect(reclaim).not.toHaveBeenCalled();
    expect(await ws.flushGuildNow(g, 2000)).toBe('ok');
    expect(await ws.hydrate(g, tokenFor())).toBe('ready');
    expect(reclaim).toHaveBeenCalled();
  });
});

describe('1.12 to 1.19: what callers are told', () => {
  it('1.12 confirm starts the check itself; flushGuildNow the same, and the retire then runs', async () => {
    const { store, ws, g, options } = await rig(true);
    store.retireMode = 'move';
    appendData('l.jsonl', options, 'a\n');
    const t = ws.ticketFor(g);
    await unanswered(ws, store, g);
    expect(await ws.confirm(t, 2000)).toBe('ok');
    const second = await rig(true);
    second.store.retireMode = 'move';
    appendData('l.jsonl', second.options, 'b\n');
    await unanswered(second.ws, second.store, second.g);
    expect(await second.ws.flushGuildNow(second.g, 2000)).toBe('ok');
    expect(await deleteGuildNamespace(second.g, 'test')).toBe(true);
    expect(second.store.graveyard.get(`${second.g}|m/l.jsonl`)).toBe('b\n');
  });

  /** P3 with a later write; the check answers landed, and the later write's send is refused before COMMIT. */
  async function landedThenRefused() {
    const r = await rig(true);
    appendData('l.jsonl', r.options, 'a\n');
    const t1 = r.ws.ticketFor(r.g);
    await unanswered(r.ws, r.store, r.g);
    saveData('b.json', r.options, { v: 2 });
    const t2 = r.ws.ticketFor(r.g);
    r.store.mode = 'unavailable';
    return { ...r, t1, t2 };
  }

  it("1.13 confirm: the landed batch's ticket ok, the later refused write held", async () => {
    const { ws, t1, t2 } = await landedThenRefused();
    expect(await ws.confirm(t1, 2000)).toBe('ok');
    expect(await ws.confirm(t2, 2000)).toBe('held');
  });

  it("1.14 flushGuildNow answers held there, and the retire keeps the later write with today's line", async () => {
    const { ws, g, logs, store } = await landedThenRefused();
    store.retireMode = 'move';
    expect(await ws.flushGuildNow(g, 2000)).toBe('held');
    expect(await deleteGuildNamespace(g, 'test')).toBe(false);
    expect(lines(logs.error)).toContain(`[DataManager] Cannot retire guild ${g}: its unflushed writes did not reach the store (held); nothing was removed`);
    expect(ws.readDocRaw(g, 'm', 'b.json')).toBe('{\n  "v": 2\n}');
    expect(store.graveyard.size).toBe(0);
  });

  it("1.15 confirm starting a check that answers deposed with landed true answers ok for the batch's ticket", async () => {
    const { store, ws, g } = await rig();
    ws.append(g, 'm', 'l.jsonl', 'a\n');
    const t = ws.ticketFor(g);
    await unanswered(ws, store, g);
    store.takeOver(g, false);
    expect(await ws.confirm(t, 2000)).toBe('ok');
  });

  it("1.16 a check answering unknown names the COMMIT and the check's failure, with no code", async () => {
    const { store, ws, g } = await rig();
    ws.save(g, 'm', 'a.json', '1');
    await unanswered(ws, store, g);
    store.checkMode = 'unknown';
    store.checkDetail = 'SQLSTATE 57014: canceling statement due to statement timeout';
    store.checkCode = '57014';
    expect(await ws.flushGuildNow(g, 2000)).toBe('pending');
    expect(ws.heldGuilds()).toEqual([{
      guildId: g,
      reason: "the database did not answer this save's COMMIT; whether it landed is checked before anything is sent again; the last check failed: SQLSTATE 57014: canceling statement due to statement timeout",
      code: null,
    }]);
    expect(ws.getBackendHealth().lastError).toBe("a save's COMMIT got no answer; checking whether it landed");
  });

  it('1.17 a flight whose COMMIT was sent counts as unanswered; a write made meanwhile moves it out of only', async () => {
    const { store, ws, g } = await rig();
    ws.save(g, 'm', 'a.json', '1');
    store.mode = 'commit-hang';
    const flushing = ws.flushGuildNow(g, 5000);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(ws.unansweredGuilds()).toEqual({ all: [g], only: [g] });
    ws.save(g, 'm', 'a.json', '2');
    expect(ws.unansweredGuilds()).toEqual({ all: [g], only: [] });
    store.mode = 'commit';
    store.release();
    expect(await flushing).toBe('ok');
    expect(ws.unansweredGuilds()).toEqual({ all: [], only: [] });
  });

  it('1.18 confirm polls every 20 ms while a check is on the wire, then answers ok', async () => {
    vi.useFakeTimers();
    const { store, ws, g } = await rig();
    ws.append(g, 'm', 'l.jsonl', 'a\n');
    const t = ws.ticketFor(g);
    await unanswered(ws, store, g);
    store.checkDelayMs = 2000;
    await runTimers(() => store.checksSent > 0, 100);
    expect(store.checksSent).toBe(1);
    const flush = vi.spyOn(ws as unknown as { flush: (s: unknown) => Promise<unknown> }, 'flush');
    let answer: FlushNowOutcome | undefined;
    void ws.confirm(t, 8000).then(a => { answer = a; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(answer).toBeUndefined();
    expect(flush.mock.calls.length).toBeLessThanOrEqual(1000 / 20 + 1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(answer).toBe('ok');
  });

  it("1.19 the drop line keys on NB13's state, and a check that deposes notes it", async () => {
    const tokenOn = { nodeId: 'node-a', claim: 3, processId: 'process-a', shardId: 0, shardCount: 4 };
    const run = async (own: boolean, writeDuringP3: boolean) => {
      quiet();
      const store = new FakeStore();
      const ws = new WorkingSetManager(store);
      const g = freshGuild();
      expect(await ws.hydrate(g, tokenOn)).toBe('ready');
      managers.push([ws, [g]]);
      ws.save(g, 'm', 'a.json', '1');
      await unanswered(ws, store, g);
      if (writeDuringP3) ws.save(g, 'm', 'b.json', '1');
      store.takeOver(g, own);
      const answer = await ws.flushGuildNow(g, 2000);
      return { g, answer, lines: ws.takeDropLines() };
    };
    const taken = await run(true, false);
    expect(taken.answer).toBe('unavailable');
    expect(taken.lines).toEqual([`[Shards] 1 unsaved change(s) of 1 guild(s) of shard 0 were dropped: ${taken.g}; guild(s) ${taken.g} had a save whose answer never came, so some of these changes may have landed`]);
    const kept = await run(false, true);
    expect(kept.lines).toEqual([`[Shards] 1 unsaved change(s) of 1 guild(s) of shard 0 were dropped: ${kept.g}`]);
    const none = await run(false, false);
    expect(none.lines).toEqual([]);
  });

  it("1.20 a ledger holding an unanswered save and a later one, deposed with landed null, is not saved in full", async () => {
    const { store, ws, g, options } = await rig(true);
    const ledger = openLedger('interaction');
    runInLedger(ledger, 'm', () => saveData('a.json', options, { v: 1 }));
    await unanswered(ws, store, g);
    runInLedger(ledger, 'm', () => saveData('b.json', options, { v: 1 }));
    store.takeOver(g, true);
    expect(await ws.flushGuildNow(g, 2000)).toBe('unavailable');
    expect(await verdictOf([ledger])).toEqual({ ok: false, answer: 'deposed', partial: true });
  });

  it("1.21 a confirm whose own send got no answer answers pending; the next confirm runs the check and answers ok", async () => {
    const { store, ws, g } = await rig();
    ws.append(g, 'm', 'l.jsonl', 'a\n');
    const t = ws.ticketFor(g);
    store.mode = 'landed-unanswered';
    expect(await ws.confirm(t, 2000)).toBe('pending');
    store.mode = 'commit';
    const checks = store.checksSent;
    expect(await ws.confirm(t, 2000)).toBe('ok');
    expect(store.checksSent).toBeGreaterThan(checks);
    expect(streamOf(store, g)).toBe('a\n');
    expect(appendsSent(store, 'a')).toBe(1);
  });

  it("1.22 the verdict's second read of a held ticket answers pending once its set holds an unanswered COMMIT", async () => {
    const { store, ws, g, options } = await rig(true);
    const h = freshGuild();
    expect(await ws.hydrate(h, tokenFor())).toBe('ready');
    managers.push([ws, [h]]);
    store.checkMode = 'unknown';
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const prior = store.flushGuild.bind(store);
    store.flushGuild = (async (guildId, batch, token) => {
      if (guildId === h) await gate;
      return prior(guildId, batch, token);
    }) as typeof store.flushGuild;
    store.mode = 'unavailable';
    const ledger = openLedger('interaction');
    runInLedger(ledger, 'm', () => saveData('a.json', options, { v: 1 }));
    runInLedger(ledger, 'm', () => saveData('b.json', { guildId: h, category: 'm' }, { v: 1 }));
    try {
      const verdict = verdictOf([ledger]);
      await vi.waitFor(() => expect(typeof ws.heldGuilds().find(x => x.guildId === g)?.reason).toBe('string'), { timeout: 2000 });
      store.mode = 'landed-unanswered';
      await vi.waitFor(() => expect(ws.unansweredGuilds().all).toEqual([g]), { timeout: 5000 });
      store.mode = 'commit';
      open();
      expect(await verdict).toEqual({ ok: false, answer: 'pending', partial: true });
    } finally {
      open();
    }
  });
});

describe('1.10 property: each accepted line is stored once, and no answer is false', () => {
  type Cmd =
    | { k: 'save'; key: number }
    | { k: 'append'; key: number }
    | { k: 'delete'; key: number }
    | { k: 'flush'; mode: Exclude<FlushMode, 'commit-hang'> }
    | { k: 'check'; mode: 'answer' | 'unknown' }
    | { k: 'takeover'; own: boolean }
    | { k: 'confirm'; pick: number }
    | { k: 'now' };
  const cmd: fc.Arbitrary<Cmd> = fc.oneof(
    fc.record({ k: fc.constant('save' as const), key: fc.integer({ min: 0, max: 1 }) }),
    fc.record({ k: fc.constant('append' as const), key: fc.integer({ min: 0, max: 1 }) }),
    fc.record({ k: fc.constant('delete' as const), key: fc.integer({ min: 0, max: 1 }) }),
    fc.record({ k: fc.constant('flush' as const), mode: fc.constantFrom('commit', 'unavailable', 'deposed', 'landed-unanswered', 'lost-unanswered') as fc.Arbitrary<Exclude<FlushMode, 'commit-hang'>> }),
    fc.record({ k: fc.constant('check' as const), mode: fc.constantFrom('answer', 'unknown') as fc.Arbitrary<'answer' | 'unknown'> }),
    fc.record({ k: fc.constant('takeover' as const), own: fc.boolean() }),
    fc.record({ k: fc.constant('confirm' as const), pick: fc.nat() }),
    fc.record({ k: fc.constant('now' as const) }),
  );

  it('holds over 500 runs', async () => {
    vi.useFakeTimers();
    quiet();
    let counter = 0;
    await fc.assert(fc.asyncProperty(fc.array(cmd, { maxLength: 18 }), async cmds => {
      const store = new FakeStore();
      const ws = new WorkingSetManager(store);
      const g = freshGuild();
      expect(await ws.hydrate(g, tokenFor())).toBe('ready');
      const docName = (key: number) => `d${key}.json`;
      const streamName = (key: number) => `s${key}.jsonl`;
      const model = { docs: new Map<string, string>(), streams: new Map<string, string>() };
      const accepted = new Set<string>();
      const everDocs = new Set<string>();
      const everLines = new Set<string>();
      // A ticket is superseded once a later write of its document was accepted: that write landing answers for it.
      const tickets: Array<{ ticket: WsTicket; name: string; doc?: string; line?: string; superseded?: boolean }> = [];
      const supersede = (name: string) => { for (const t of tickets) if (t.name === name) t.superseded = true; };
      let takenOver = false;
      const settle = async <T>(p: Promise<T>): Promise<T> => {
        let out: { v: T } | undefined;
        void p.then(v => { out = { v }; });
        for (let i = 0; i < 400 && !out; i++) await vi.advanceTimersByTimeAsync(20);
        return out!.v;
      };
      const observe = () => {
        for (const [row, text] of store.streams) {
          const ls = text.split('\n').filter(Boolean);
          expect(new Set(ls).size, `${row} holds a line twice: ${text}`).toBe(ls.length);
          for (const l of ls) {
            expect(accepted.has(l), `stored but never accepted: ${l}`).toBe(true);
            everLines.add(l);
          }
        }
        for (const [row, doc] of store.docs) everDocs.add(`${row}=${doc}`);
      };
      const stored = (t: { doc?: string; line?: string }) =>
        t.line !== undefined ? everLines.has(t.line) : everDocs.has(t.doc!);
      try {
        for (const c of cmds) {
          if (c.k === 'save') {
            const v = String(++counter);
            if (ws.save(g, 'm', docName(c.key), v) === 'accepted') {
              model.docs.set(docName(c.key), v);
              supersede(docName(c.key));
              tickets.push({ ticket: ws.ticketFor(g), name: docName(c.key), doc: `${g}|m/${docName(c.key)}=${v}` });
            }
          } else if (c.k === 'append') {
            const line = `L${++counter}`;
            if (ws.append(g, 'm', streamName(c.key), `${line}\n`) === 'accepted') {
              accepted.add(line);
              model.streams.set(streamName(c.key), (model.streams.get(streamName(c.key)) ?? '') + `${line}\n`);
              tickets.push({ ticket: ws.ticketFor(g), name: streamName(c.key), line });
            }
          } else if (c.k === 'delete') {
            for (const name of [docName(c.key), streamName(c.key)]) {
              if (ws.delete(g, 'm', name) === 'accepted') { model.docs.delete(name); model.streams.delete(name); supersede(name); }
            }
          } else if (c.k === 'flush' || c.k === 'check' || c.k === 'now') {
            if (c.k === 'flush') store.mode = c.mode;
            if (c.k === 'check') store.checkMode = c.mode;
            const answer = await settle(ws.flushGuildNow(g, 200));
            store.mode = 'commit';
            store.checkMode = 'answer';
            observe();
            if (answer === 'ok' && !takenOver && ws.stateOf(g) !== 'fenced') {
              for (const [name, v] of model.docs) expect(store.doc(g, name)).toBe(v);
              for (const [name, text] of model.streams) expect(streamOf(store, g, name)).toBe(text);
            }
          } else if (c.k === 'takeover') {
            store.takeOver(g, c.own);
            takenOver = true;
          } else if (tickets.length > 0) {
            const t = tickets[c.pick % tickets.length];
            const answer = await settle(ws.confirm(t.ticket, 200));
            observe();
            if (answer === 'ok' && !t.superseded) expect(stored(t), 'ok before it was stored').toBe(true);
            if (answer === 'held' || answer === 'deposed') expect(stored(t), `${answer} for a stored write`).toBe(false);
          }
          observe();
        }
        if (!takenOver && ws.stateOf(g) === 'ready') {
          store.mode = 'commit';
          expect(await settle(ws.flushGuildNow(g, 2000))).toBe('ok');
          observe();
          for (const [name, v] of model.docs) expect(store.doc(g, name)).toBe(v);
          for (const [name, text] of model.streams) expect(streamOf(store, g, name)).toBe(text);
        }
      } finally {
        ws.evict(g);
      }
    }), { numRuns: 500 });
  }, 120_000);
});

describe('1.11 the state x exit table', () => {
  type Phase = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7';
  type Exit = 'continue' | 'cancel' | 'resume' | 'restart' | 'stop' | 'takeover' | 'evict';

  type Rig = Awaited<ReturnType<typeof rig>>;

  /**
   * A facade rig on module instances of its own: the exit drain closes writes for the process it runs in, so each stop
   * cell loads the data layer afresh.
   */
  async function exitRig(): Promise<Rig & { drainForExit: (boundMs: number) => Promise<void> }> {
    vi.resetModules();
    const kind = await import('../helpers/backendKind');
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const wsm = await import('../../src/bot/internalSetup/utils/dataBackends/workingSet');
    const logs = quiet();
    const store = new FakeStore();
    kind.setBackendKind('postgres');
    dm.setGuildDataBackend(store);
    dm.setOwnerInfoProvider(() => ({ nodeId: 'node-a', processId: 'process-a', shardCount: 1, claimOf: () => 1 }));
    const ws = wsm.initWorkingSet(store);
    const g = freshGuild();
    const token = tokenFor();
    expect(await ws.hydrate(g, token)).toBe('ready');
    managers.push([ws, [g]]);
    return { store, ws, g, token, logs, options: { guildId: g, category: 'm' }, drainForExit: dm.drainForExit };
  }

  /** Brings a fresh set with one appended line to the phase; the store answers 'commit' from then on unless held. */
  async function at(phase: Phase, made?: Rig) {
    const r = made ?? await rig();
    const { store, ws, g } = r;
    ws.append(g, 'm', 'l.jsonl', 'a\n');
    const ticket = ws.ticketFor(g);
    let wire: Promise<FlushNowOutcome> | null = null;
    if (phase === 'P1') {
      store.holding = true;
      wire = ws.flushGuildNow(g, 60_000);
    } else if (phase === 'P2') {
      store.mode = 'commit-hang';
      wire = ws.flushGuildNow(g, 60_000);
    } else {
      if (phase !== 'P6') await unanswered(ws, store, g);
      if (phase === 'P4') {
        store.checkDelayMs = 300;
        wire = ws.flushGuildNow(g, 60_000);
      } else if (phase === 'P5') {
        expect(await ws.flushGuildNow(g, 2000)).toBe('ok');
      } else if (phase === 'P6') {
        await unanswered(ws, store, g, 'lost-unanswered');
        store.holding = true;
        wire = ws.flushGuildNow(g, 60_000);
      } else if (phase === 'P7') {
        store.takeOver(g, false);
        expect(await ws.flushGuildNow(g, 2000)).toBe('deposed');
      }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    const release = async () => {
      store.holding = false;
      store.checkDelayMs = 0;
      store.mode = 'commit';
      store.release();
      if (wire) await wire;
    };
    return { ...r, ticket, release };
  }

  const phases: Phase[] = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
  const exits: Exit[] = ['continue', 'cancel', 'resume', 'restart', 'stop', 'takeover', 'evict'];
  const cells = phases.flatMap(p => exits.map(e => [p, e] as const));

  it.each(cells)('%s x %s', async (phase, exit) => {
    const exitDrain = exit === 'stop' ? await exitRig() : null;
    const { store, ws, g, ticket, release, logs } = await at(phase, exitDrain ?? (exit === 'restart' ? await rig(true) : undefined));
    // Restart and stop: with the database down, P2 to P4 are named apart, P1 and P6 hold a flight that sent no COMMIT.
    const apart = phase === 'P2' || phase === 'P3' || phase === 'P4';
    const flight = phase === 'P1' || phase === 'P6';
    const once = () => (streamOf(store, g) ?? '').split('\n').filter(l => l === 'a').length;
    if (exit === 'continue' || exit === 'resume') {
      await release();
      expect(await ws.confirm(ticket, 2000)).toBe('ok');
      expect(once()).toBe(1);
    } else if (exit === 'cancel') {
      store.checkDelayMs = 300;
      store.holding = true;
      const answer = await ws.confirm(ticket, 5);
      expect(answer).toBe(phase === 'P5' || phase === 'P7' ? 'ok' : 'pending');
      await release();
      await new Promise(resolve => setTimeout(resolve, 350));
    } else if (exit === 'restart') {
      store.mode = 'unavailable';
      store.checkMode = 'unknown';
      expect(await saveHeldWrites(300)).toMatchObject({ unsavedGuilds: flight ? 1 : 0, unsavedFiles: 0, unansweredGuilds: apart ? 1 : 0 });
      expect(ws.unansweredGuilds()).toEqual(apart ? { all: [g], only: [g] } : { all: [], only: [] });
      expect(ws.dirtyGuildIds()).toEqual(phase === 'P5' || phase === 'P7' ? [] : [g]);
      store.checkMode = 'answer';
      await release();
    } else if (exit === 'stop') {
      expect(ws.writesSettled()).toBe(phase === 'P5' || phase === 'P7');
      store.mode = 'unavailable';
      store.checkMode = 'unknown';
      const listening = process.listeners('uncaughtException');
      await exitDrain!.drainForExit(1000);
      for (const l of process.listeners('uncaughtException')) if (!listening.includes(l)) process.removeListener('uncaughtException', l);
      expect(lines(logs.warn).filter(l => l.startsWith('[Data] Shutdown drain'))).toEqual([
        ...(flight ? [`[Data] Shutdown drain left 1 guild(s) with unflushed writes: ${g}`] : []),
        ...(apart ? [`[Data] Shutdown drain left guild(s) ${g} holding a save whose COMMIT got no answer, which may have landed`] : []),
      ]);
      store.checkMode = 'answer';
      await release();
      expect(await ws.flushGuildNow(g, 2000)).toBe(phase === 'P7' ? 'deposed' : 'ok');
      expect(once()).toBe(1);
    } else if (exit === 'takeover') {
      store.takeOver(g, false);
      await release();
      expect(await ws.confirm(ticket, 2000)).toBe(phase === 'P1' || phase === 'P6' ? 'deposed' : 'ok');
      expect(once()).toBe(phase === 'P1' || phase === 'P6' ? 0 : 1);
    } else {
      ws.evict(g);
      await release();
      expect(await ws.confirm(ticket, 100)).toBe(phase === 'P5' || phase === 'P7' ? 'ok' : 'unavailable');
      expect(once()).toBeLessThanOrEqual(1);
    }
  });
});

describe('the drain and maintenance answers keep an unanswered guild apart', () => {
  it('saveHeldWrites counts an unanswered-only guild apart from the unsaved ones', async () => {
    const { store, ws, g } = await rig(true);
    ws.save(g, 'm', 'a.json', '1');
    await unanswered(ws, store, g);
    store.checkMode = 'unknown';
    expect(await saveHeldWrites(200)).toMatchObject({ unsavedGuilds: 0, unansweredGuilds: 1 });
  });
});
