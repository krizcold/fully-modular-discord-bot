import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken, FlushOutcome, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import type { ListEntry } from '../../src/utils/databaseAddress';
import type { NoticeRead, ProbeAnswer, StepHooks } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import type { LatchCause } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { FakeStore, tokenFor } from '../helpers/fakeStore';
import { setBackendKind } from '../helpers/backendKind';

// NB5 section 8 test 14: section 5's cells that a unit rig drives, through the real chooser (MainChooser: the boot
// wait, the watch, the confirmation, the step and the move), the real working set and dataManager's real exit drain
// and maintenance save. The backend is HoldStore below: FakeStore with decision 13's hold and latch as nb5Latch pins
// them on the real PostgresBackend (the entry, 'confirming' with its cause, the confirmation, the latch's epoch), so
// these rows test what the chooser, the drain and the working set do with them. The exit drain runs once per process,
// so every row loads the modules afresh.

const A = 'postgresql://bot:pw-secret-9@a:5432/bot';
const W = 'postgresql://bot:pw-secret-9@w:5432/bot';
const SECOND = 1000;
const ENDED = "the database ended this process's sessions (SQLSTATE 57P01)";
const MISSING = 'HTTP 403 (Missing Access)';

type Mods = {
  main: typeof import('../../src/bot/internalSetup/utils/dataBackends/mainDatabase');
  ws: typeof import('../../src/bot/internalSetup/utils/dataBackends/workingSet');
  dm: typeof import('../../src/bot/internalSetup/utils/dataManager');
  pg: typeof import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend');
  address: typeof import('../../src/utils/databaseAddress');
};

async function load(): Promise<Mods> {
  vi.resetModules();
  return {
    main: await import('../../src/bot/internalSetup/utils/dataBackends/mainDatabase'),
    ws: await import('../../src/bot/internalSetup/utils/dataBackends/workingSet'),
    dm: await import('../../src/bot/internalSetup/utils/dataManager'),
    pg: await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend'),
    address: await import('../../src/utils/databaseAddress'),
  };
}

/** FakeStore with decision 13's hold and latch, wired to the real chooser as PostgresBackend is. */
class HoldStore extends FakeStore {
  epoch = 1;
  phase: 'ready' | 'outage' | 'confirming' = 'ready';
  entryCause = '';
  confirmingCause = 'checking';
  latchWhy: string | null = null;
  confirmedAt: number | null = null;
  entry = A;
  chooser: { confirmNow(): void; holdStarted(b: unknown): void } | null = null;
  /** Flushes refused while held or latched: nothing reaches the database. */
  refusedOwnState = 0;
  /** Flushes after the confirmation that a login FATAL 53300 refuses: the guild's first ('once'), or every one. */
  login53300: 'off' | 'once' | 'always' = 'off';
  private readonly refusedOnce = new Set<string>();
  constructor(private readonly m: Mods) { super(); }

  enter(cause: string): void {
    if (this.phase !== 'ready' || this.latchWhy !== null) return;
    this.phase = 'outage';
    this.entryCause = cause;
    this.chooser?.holdStarted(this);
  }

  // The chooser's side (decisions 10, 11 and 13).
  databaseEpoch(): number { return this.epoch; }
  chosenEntry(): string { return this.entry; }
  latchReason(): string | null { return this.latchWhy; }
  isMoving(): boolean { return false; }
  override connectionState(): any { return { state: this.latchWhy !== null ? 'latched' : this.phase }; }
  holdWords(): string | null {
    const address = this.m.address.showEntry(this.entry);
    if (this.phase === 'outage') return `${this.entryCause}; this process checks that ${address} is still the main before writing to it`;
    if (this.phase === 'confirming') return `the database answers again, but this process can't confirm yet that ${address} is still the main (${this.confirmingCause})`;
    return null;
  }
  noteObservation(error: unknown, epoch: number): void {
    if (epoch === this.epoch && this.m.pg.isSilence(error)) this.enter('the database did not answer');
  }
  noteEntryAnswered(epoch: number): void {
    if (epoch === this.epoch && this.phase === 'outage') { this.phase = 'confirming'; this.confirmingCause = 'checking'; }
  }
  noteConfirmingCause(cause: string, epoch: number): void {
    if (epoch === this.epoch && this.phase === 'confirming') this.confirmingCause = cause;
  }
  confirmHold(epoch: number): void {
    if (epoch !== this.epoch || this.phase === 'ready') return;
    this.phase = 'ready';
    this.confirmedAt = Date.now();
  }
  latch(cause: LatchCause): void {
    this.epoch += 1;
    this.latchWhy = this.m.pg.latchWords(cause, this.m.address.showEntry(this.entry));
    this.phase = 'ready';
  }
  /** Attempts whose (d) answer is lost: the attempt ends with the latch and every flag kept (D2). */
  movesLost = 0;
  moveAttempts = 0;
  async useDatabase(entry: string): Promise<boolean> {
    this.moveAttempts += 1;
    if (this.movesLost > 0) {
      this.movesLost -= 1;
      this.epoch += 1;
      return false;
    }
    this.epoch += 1;
    this.entry = entry;
    this.latchWhy = null;
    this.m.ws.getWorkingSet()?.flagEpoch(this.epoch);
    return true;
  }
  async retireReached(): Promise<boolean> { return false; }

  // dataManager's side.
  confirmNow(): void { if (this.phase !== 'ready') this.chooser?.confirmNow(); }
  heldUntil(): number | null { return this.phase !== 'ready' ? Date.now() : this.confirmedAt; }

  override async flushGuild(guildId: string, batch: GuildFlushBatch, token: FenceToken): Promise<FlushOutcome> {
    const own = this.latchWhy !== null ? `${this.latchWhy}; this process does not write to it` : this.holdWords();
    if (own !== null) {
      this.refusedOwnState += 1;
      return { ok: false, reason: 'unavailable', detail: own };
    }
    if (this.login53300 === 'always' || (this.login53300 === 'once' && !this.refusedOnce.has(guildId))) {
      this.refusedOnce.add(guildId);
      return { ok: false, reason: 'unavailable', detail: 'SQLSTATE 53300: sorry, too many clients already', code: '53300' };
    }
    return super.flushGuild(guildId, batch, token);
  }
}

interface World {
  m: Mods;
  store: HoldStore;
  chooser: InstanceType<Mods['main']['MainChooser']>;
  hooks: { [K in keyof StepHooks]: ReturnType<typeof vi.fn> };
  answers: Map<string, ProbeAnswer>;
  probes: number[];
  reads: number[];
  setNotice(read: () => NoticeRead | Promise<NoticeRead>): void;
  list: string[];
  guilds: string[];
  warn: { mock: { calls: unknown[][] } };
}

const shownOf = (m: Mods, entry: string) => m.address.parseAddressList(entry)[0].shown;
function answered(m: Mods, entry: string, over: Record<string, unknown> = {}): ProbeAnswer {
  return {
    kind: 'answered', address: shownOf(m, entry), entry, inRecovery: false, readOnly: false, generation: 1, machine: 'node-a',
    since: '2026-11-01T10:00:00.000Z', sysid: `sys-${entry}`, started: `start-${entry}`, storeId: 'S', ...over,
  } as ProbeAnswer;
}
const refusedConnect = (m: Mods, entry: string): ProbeAnswer => ({
  kind: 'failed', address: shownOf(m, entry), entry, cause: 'unreachable (ECONNREFUSED)',
  error: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
} as ProbeAnswer);

async function world(opts: { dirty?: number; notice?: NoticeRead } = {}): Promise<World> {
  const m = await load();
  setBackendKind('postgres');
  const store = new HoldStore(m);
  const answers = new Map<string, ProbeAnswer>([[A, answered(m, A)]]);
  const probes: number[] = [];
  const reads: number[] = [];
  let notice: () => NoticeRead | Promise<NoticeRead> = () => opts.notice ?? { kind: 'none' };
  const w = { list: [A] } as World;
  const chooser = new m.main.MainChooser({
    entries: () => m.address.parseAddressList(w.list.join(',')),
    probe: async (entries: ListEntry[]) => {
      probes.push(Date.now());
      return entries.map(e => answers.get(e.raw) ?? refusedConnect(m, e.raw));
    },
    readNotice: async () => { reads.push(Date.now()); return notice(); },
    sendWaitDm: async () => ({ ok: true }),
    markerStoreId: () => 'S',
    noticeCheckOff: () => false,
    nodeName: () => 'node-a',
    onWait: () => undefined,
  });
  expect(await chooser.awaitChoice()).toBe(A);
  store.chooser = chooser;
  const ws = m.ws.initWorkingSet(store);
  const guilds: string[] = [];
  const hooks = {
    // NB4's stop-serving step: the lease empties, so every set is frozen (it takes no write from now on).
    stopServing: vi.fn(() => { for (const g of guilds) ws.freeze(g); }),
    report: vi.fn(),
    markForResave: vi.fn(() => ws.markForResave(shownOf(m, A))),
    startLeave: vi.fn(),
  };
  chooser.attach(store as never, hooks);
  m.main.setMainChooser(chooser);
  m.dm.setGuildDataBackend(store as never);
  for (let i = 0; i < (opts.dirty ?? 0); i++) {
    const g = String(870000000000000000n + BigInt(i + 1));
    expect(await ws.hydrate(g, tokenFor())).toBe('ready');
    expect(ws.save(g, 'm', 'a.json', `"held-${i}"`)).toBe('accepted');
    guilds.push(g);
  }
  probes.length = 0;
  reads.length = 0;
  const warn = vi.spyOn(console, 'warn');
  return Object.assign(w, { m, store, chooser, hooks, answers, probes, reads, setNotice: (n: () => NoticeRead | Promise<NoticeRead>) => { notice = n; }, guilds, warn });
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const warned = (w: World): string[] => w.warn.mock.calls.map((c: unknown[]) => c.map(String).join(' '));
const landed = (w: World) => w.guilds.filter((g, i) => w.store.doc(g, 'a.json') === `"held-${i}"`);
/** No two of the times closer than ms (a cadence check). */
function spacedBy(times: number[], ms: number): boolean {
  return times.every((t, i) => i === 0 || t - times[i - 1] >= ms);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setBackendKind(null);
});

async function stopWorld(w: World): Promise<void> {
  w.m.main.stopMainWatch();
  w.m.main.setMainChooser(null);
  w.m.dm.setGuildDataBackend(null);
}

describe('section 5, the chooser and the watch cells', () => {
  it('B2 continue: no main answers, a pass every 10 s and no choice; B2 resume: a pass that chooses ends the wait (B3)', async () => {
    const m = await load();
    const probes: number[] = [];
    let answer: ProbeAnswer | null = null;
    const chooser = new m.main.MainChooser({
      entries: () => m.address.parseAddressList(A),
      probe: async entries => { probes.push(Date.now()); return entries.map(e => answer ?? refusedConnect(m, e.raw)); },
      readNotice: async () => ({ kind: 'none' }),
      sendWaitDm: async () => ({ ok: true }),
      markerStoreId: () => 'S',
      noticeCheckOff: () => false,
      nodeName: () => 'node-a',
      onWait: () => undefined,
    });
    let chosen: string | null | undefined;
    void chooser.awaitChoice().then(e => { chosen = e; });
    await tick(35 * SECOND);
    expect(chosen).toBeUndefined();
    expect(probes.length).toBe(4);
    expect(spacedBy(probes, 10 * SECOND)).toBe(true);
    answer = answered(m, A);
    await tick(10 * SECOND);
    expect(chosen).toBe(A);
    chooser.stop();
  });

  it('B2 operator stop: the stop ends the wait with no choice; nothing was opened', async () => {
    const m = await load();
    const chooser = new m.main.MainChooser({
      entries: () => m.address.parseAddressList(A),
      probe: async entries => entries.map(e => refusedConnect(m, e.raw)),
      readNotice: async () => ({ kind: 'none' }),
      sendWaitDm: async () => ({ ok: true }),
      markerStoreId: () => 'S',
      noticeCheckOff: () => false,
      nodeName: () => 'node-a',
      onWait: () => undefined,
    });
    const choice = chooser.awaitChoice();
    await tick(SECOND);
    chooser.stop();
    expect(await choice).toBeNull();
  });

  it('R1 continue: a pass every 30 s while the chosen database answers, nothing held', async () => {
    const w = await world();
    await tick(95 * SECOND);
    expect(w.probes.length).toBe(3);
    expect(spacedBy(w.probes, 30 * SECOND)).toBe(true);
    expect(w.store.holdWords()).toBeNull();
    await stopWorld(w);
  });

  it('R1 cancel to R2: a pass that finds the chosen entry silent enters the hold; the watch then passes every 5 s', async () => {
    const w = await world();
    w.answers.set(A, refusedConnect(w.m, A));
    await tick(30 * SECOND);
    expect(w.store.connectionState().state).toBe('outage');
    w.probes.length = 0;
    await tick(20 * SECOND);
    expect(w.probes.length).toBe(4);
    await stopWorld(w);
  });

  it('R2 resume: the entry answers again, a pass at once after it and a notice read after that confirm (R1)', async () => {
    const w = await world({ dirty: 2 });
    w.store.enter(ENDED);
    await tick(5 * SECOND);
    expect(w.store.connectionState().state).toBe('ready');
    expect(w.store.confirmedAt).not.toBeNull();
    await w.m.ws.getWorkingSet()!.flushAllDirty();
    expect(landed(w)).toEqual(w.guilds);
    await stopWorld(w);
  });

  it('R2 switch: a notice above while held latches (R3); no held write reaches the chosen database when it answers', async () => {
    const w = await world({ dirty: 2 });
    w.answers.set(A, refusedConnect(w.m, A));
    w.store.enter('the database did not answer');
    await tick(6 * SECOND);
    w.setNotice(() => ({ kind: 'notice', generation: 2, machine: 'node-b', date: '2026-11-02T10:00:00.000Z' }));
    w.answers.set(A, answered(w.m, A));
    await tick(70 * SECOND);
    expect(w.store.latchReason()).toBe("can't confirm that a:5432/bot is still the main (generation 2 was announced for node-b)");
    await w.m.ws.getWorkingSet()!.flushAllDirty();
    expect(landed(w)).toEqual([]);
    expect(w.hooks.stopServing).toHaveBeenCalledTimes(1);
    expect(w.hooks.startLeave).toHaveBeenCalledTimes(1);
    expect(w.m.ws.getWorkingSet()!.resaveGuilds().sort()).toEqual([...w.guilds].sort());
    await stopWorld(w);
  });

  it('R1 switch to R3, then R4 and R5: a higher generation elsewhere latches; the next pass moves to it and the flags re-save there', async () => {
    const w = await world({ dirty: 1 });
    w.list = [A, W];
    w.answers.set(W, answered(w.m, W, { generation: 2, machine: 'node-b', sysid: 'sys-w' }));
    await tick(30 * SECOND - 1);
    expect(w.m.ws.getWorkingSet()!.save(w.guilds[0], 'm', 'b.json', '"after"')).toBe('accepted');
    await tick(1);
    expect(w.store.latchReason()).toBe('a:5432/bot was replaced by node-b (generation 2)');
    expect(w.m.ws.getWorkingSet()!.resaveGuilds()).toEqual(w.guilds);
    expect(w.m.ws.getWorkingSet()!.save(w.guilds[0], 'm', 'c.json', '"late"')).toBe('frozen-window');
    await w.m.ws.getWorkingSet()!.flushAllDirty();
    expect(w.store.doc(w.guilds[0], 'b.json')).toBeUndefined();
    w.setNotice(() => ({ kind: 'notice', generation: 2, machine: 'node-b', date: '2026-11-02T10:00:00.000Z' }));
    await tick(70 * SECOND);
    expect(w.store.chosenEntry()).toBe(W);
    expect(w.store.latchReason()).toBeNull();
    await w.m.ws.getWorkingSet()!.flushAllDirty();
    expect(w.store.doc(w.guilds[0], 'b.json')).toBe('"after"');
    expect(landed(w)).toEqual(w.guilds);
    expect(w.m.ws.getWorkingSet()!.resaveGuilds()).toEqual([]);
    await stopWorld(w);
  });

  it("R4 cancel (D2): an attempt whose (d) answer is lost keeps the latch and every flag, drops nothing, and the next pass completes the move", async () => {
    const w = await world({ dirty: 2 });
    w.list = [A, W];
    w.answers.set(W, answered(w.m, W, { generation: 2, machine: 'node-b', sysid: 'sys-w' }));
    w.store.movesLost = 1;
    await tick(30 * SECOND);
    expect(w.store.latchReason()).not.toBeNull();
    w.setNotice(() => ({ kind: 'notice', generation: 2, machine: 'node-b', date: '2026-11-02T10:00:00.000Z' }));
    await tick(6 * SECOND);
    expect(w.store.moveAttempts).toBe(1);
    expect(w.store.latchReason()).not.toBeNull();
    expect(w.m.ws.getWorkingSet()!.resaveGuilds().sort()).toEqual([...w.guilds].sort());
    expect(warned(w).filter(l => /dropped|could not be saved/.test(l))).toEqual([]);
    await tick(6 * SECOND);
    expect(w.store.moveAttempts).toBe(2);
    expect(w.store.chosenEntry()).toBe(W);
    await w.m.ws.getWorkingSet()!.flushAllDirty();
    expect(w.m.ws.getWorkingSet()!.resaveGuilds()).toEqual([]);
    await stopWorld(w);
  });

  it('R3 operator stop: the drain ends at the latch and logs each guild it could not save and could not re-save', async () => {
    const w = await world({ dirty: 2 });
    w.list = [A, W];
    w.answers.set(W, answered(w.m, W, { generation: 2, machine: 'node-b', sysid: 'sys-w' }));
    await tick(30 * SECOND - 1);
    for (const g of w.guilds) expect(w.m.ws.getWorkingSet()!.save(g, 'm', 'b.json', '"after"')).toBe('accepted');
    await tick(1);
    expect(w.store.latchReason()).not.toBeNull();
    for (const g of w.guilds) expect(w.m.ws.getWorkingSet()!.save(g, 'm', 'c.json', '"late"')).toBe('frozen-window');
    const drain = w.m.dm.drainForExit(30 * SECOND);
    await tick(31 * SECOND);
    await drain;
    expect(w.guilds.map(g => w.store.doc(g, 'b.json'))).toEqual([undefined, undefined]);
    const lines = warned(w);
    expect(lines).toContain(`[Data] Shutdown drain left 2 guild(s) with unflushed writes: ${w.m.ws.getWorkingSet()!.dirtyGuildIds().join(', ')}`);
    expect(lines.some(l => l.startsWith('[Data] Shutdown drain left 2 guild(s) not re-saved on '))).toBe(true);
    await stopWorld(w);
  });
});

describe("section 5's R2 operator stop: the exit drain in the hold (rounds 4 to 7)", () => {
  it('R4: the hold on 57P01 with 30 guilds dirty, the database back, SIGTERM 1 s later: every held write lands, no drain-left line', async () => {
    const w = await world({ dirty: 30 });
    // The confirmation's notice read takes 5 s: the drain starts inside the hold, and a 3 s give-up from SIGTERM would
    // end it before the confirmation.
    w.setNotice(() => new Promise<NoticeRead>(resolve => { setTimeout(() => resolve({ kind: 'none' }), 5 * SECOND); }));
    w.answers.set(A, refusedConnect(w.m, A));
    w.store.enter(ENDED);
    w.answers.set(A, answered(w.m, A));
    await tick(SECOND);
    expect(['outage', 'confirming']).toContain(w.store.connectionState().state);
    expect(landed(w)).toEqual([]);
    const drain = w.m.dm.drainForExit(30 * SECOND);
    let done = false;
    void drain.then(() => { done = true; });
    await tick(4 * SECOND);
    await tick(26 * SECOND);
    await drain;
    expect(done).toBe(true);
    expect(landed(w)).toEqual(w.guilds);
    expect(warned(w).filter(l => l.includes('Shutdown drain left'))).toEqual([]);
    await stopWorld(w);
  });

  it('R4 and R5: every notice read 403: nothing sent; at the bound each guild with the confirming text, never the silence texts', async () => {
    const w = await world({ dirty: 30 });
    w.setNotice(() => ({ kind: 'failed', cause: MISSING, status: 403 }));
    w.store.enter(ENDED);
    await tick(SECOND);
    const sentBefore = w.store.flushesSent;
    const drain = w.m.dm.drainForExit(30 * SECOND);
    await tick(31 * SECOND);
    await drain;
    expect(w.store.flushesSent).toBe(sentBefore);
    const confirming = `the database answers again, but this process can't confirm yet that a:5432/bot is still the main (${MISSING})`;
    const left = warned(w).filter(l => l.includes('Shutdown drain left'));
    expect(left).toEqual([`[Data] Shutdown drain left 30 guild(s) with unflushed writes (${confirming}): ${w.m.ws.getWorkingSet()!.dirtyGuildIds().join(', ')}`]);
    expect(warned(w).some(l => l.includes('the database did not answer') || l.includes('57P01'))).toBe(false);
    expect(new Set(w.m.ws.getWorkingSet()!.heldGuilds().map(h => h.reason))).toEqual(new Set([confirming]));
    await stopWorld(w);
  });

  it('R4: the confirming pass finds a writable server at a higher generation: the step latches and the drain logs as R3', async () => {
    const w = await world({ dirty: 3 });
    w.list = [A, W];
    w.store.enter(ENDED);
    w.answers.set(W, answered(w.m, W, { generation: 2, machine: 'node-b', sysid: 'sys-w' }));
    await tick(SECOND);
    const drain = w.m.dm.drainForExit(30 * SECOND);
    await tick(31 * SECOND);
    await drain;
    expect(w.store.latchReason()).toBe('a:5432/bot was replaced by node-b (generation 2)');
    expect(landed(w)).toEqual([]);
    expect(warned(w).some(l => l.startsWith('[Data] Shutdown drain left 3 guild(s) with unflushed writes: '))).toBe(true);
    expect(warned(w).some(l => l.startsWith('[Data] Shutdown drain left 3 guild(s) not re-saved on '))).toBe(true);
    await stopWorld(w);
  });

  it("R4: saveHeldWrites from the maintenance hook while confirming lands the held writes once the read succeeds, inside its bound", async () => {
    const w = await world({ dirty: 5 });
    let ok = false;
    w.setNotice(() => (ok ? { kind: 'none' } : { kind: 'failed', cause: MISSING, status: 403 }));
    w.store.enter(ENDED);
    await tick(SECOND);
    expect(w.store.connectionState().state).toBe('confirming');
    const save = w.m.dm.saveHeldWrites(20 * SECOND);
    await tick(3 * SECOND);
    ok = true;
    await tick(10 * SECOND);
    const counts = await save;
    expect(counts).toMatchObject({ unsavedGuilds: 0, unansweredGuilds: 0 });
    expect(landed(w)).toEqual(w.guilds);
    await stopWorld(w);
  });

  it('R6: the database refusing connections until t = 12 s: no give-up at 3 s, passes 5 s apart, every write lands, no drain-left line', async () => {
    const w = await world({ dirty: 30 });
    w.answers.set(A, refusedConnect(w.m, A));
    w.store.enter(ENDED);
    await tick(SECOND);
    w.probes.length = 0;
    const drain = w.m.dm.drainForExit(30 * SECOND);
    let done = false;
    void drain.then(() => { done = true; });
    await tick(4 * SECOND);
    expect(done).toBe(false);
    await tick(7 * SECOND);
    w.answers.set(A, answered(w.m, A));
    await tick(20 * SECOND);
    await drain;
    expect(spacedBy(w.probes.slice(0, 3), 5 * SECOND)).toBe(true);
    expect(landed(w)).toEqual(w.guilds);
    expect(warned(w).filter(l => l.includes('Shutdown drain left'))).toEqual([]);
    await stopWorld(w);
  });

  it('R6: 403 for the whole 30 s while the drain asks every 100 ms: at most one read and one pass per 5 s, the drain logs at its bound', async () => {
    const w = await world({ dirty: 4 });
    w.setNotice(() => ({ kind: 'failed', cause: MISSING, status: 403 }));
    w.store.enter(ENDED);
    await tick(SECOND);
    w.probes.length = 0;
    w.reads.length = 0;
    const drain = w.m.dm.drainForExit(30 * SECOND);
    await tick(31 * SECOND);
    await drain;
    expect(w.reads.length).toBeGreaterThan(0);
    expect(w.reads.length).toBeLessThanOrEqual(7);
    expect(spacedBy(w.reads, 5 * SECOND)).toBe(true);
    expect(w.probes.length).toBeLessThanOrEqual(7);
    expect(spacedBy(w.probes, 5 * SECOND)).toBe(true);
    expect(warned(w).some(l => l.startsWith('[Data] Shutdown drain left 4 guild(s) with unflushed writes ('))).toBe(true);
    await stopWorld(w);
  });

  it("R6: a 429 with retry_after 8 s delays the next read to 8 s", async () => {
    const w = await world({ dirty: 1 });
    let first = true;
    w.setNotice(() => {
      if (first) { first = false; return { kind: 'failed', cause: 'HTTP 429 (rate limited, retry after 8 s)', status: 429, retryAfterMs: 8 * SECOND }; }
      return { kind: 'failed', cause: MISSING, status: 403 };
    });
    w.store.enter(ENDED);
    await tick(20 * SECOND);
    expect(w.reads.length).toBeGreaterThanOrEqual(2);
    expect(w.reads[1] - w.reads[0]).toBeGreaterThanOrEqual(8 * SECOND);
    await stopWorld(w);
  });

  it("R6: the leave's saveHeldWrites in 'confirming' for 10 minutes reads no more than the watch alone", async () => {
    const w = await world({ dirty: 1 });
    w.setNotice(() => ({ kind: 'failed', cause: MISSING, status: 403 }));
    w.store.enter(ENDED);
    await tick(SECOND);
    w.reads.length = 0;
    const save = w.m.dm.saveHeldWrites(600 * SECOND);
    await tick(601 * SECOND);
    await save;
    expect(w.reads.length).toBeLessThanOrEqual(121);
    expect(spacedBy(w.reads, 5 * SECOND)).toBe(true);
    await stopWorld(w);
  });

  it('R7: the confirmation at t = 17 s and each first flush after it refused with FATAL 53300: no end at the first iteration, every write lands', async () => {
    const w = await world({ dirty: 10 });
    w.answers.set(A, refusedConnect(w.m, A));
    w.store.enter(ENDED);
    await tick(SECOND);
    const drain = w.m.dm.drainForExit(30 * SECOND);
    await tick(15 * SECOND);
    w.store.login53300 = 'once';
    w.answers.set(A, answered(w.m, A));
    await tick(15 * SECOND);
    await drain;
    expect(w.store.confirmedAt).not.toBeNull();
    expect(landed(w)).toEqual(w.guilds);
    expect(warned(w).filter(l => l.includes('Shutdown drain left'))).toEqual([]);
    await stopWorld(w);
  });

  it("R7: the confirmation resolving while the iteration's refused flushes wait on the pacing timer: the next iteration flushes and they land", async () => {
    const w = await world({ dirty: 10 });
    w.answers.set(A, refusedConnect(w.m, A));
    w.store.enter(ENDED);
    await tick(SECOND);
    const drain = w.m.dm.drainForExit(30 * SECOND);
    await tick(2 * SECOND);
    expect(landed(w)).toEqual([]);
    w.answers.set(A, answered(w.m, A));
    for (let i = 0; i < 100 && w.store.confirmedAt === null; i++) await tick(100);
    expect(w.store.confirmedAt).not.toBeNull();
    await tick(500);
    expect(landed(w)).toEqual(w.guilds);
    await tick(30 * SECOND);
    await drain;
    expect(warned(w).filter(l => l.includes('Shutdown drain left'))).toEqual([]);
    await stopWorld(w);
  });

  it('R7: every flush after the confirmation refused with 53300: the drain ends 3 s after the confirmation and logs each guild', async () => {
    const w = await world({ dirty: 3 });
    w.answers.set(A, refusedConnect(w.m, A));
    w.store.enter(ENDED);
    await tick(SECOND);
    const drain = w.m.dm.drainForExit(30 * SECOND);
    let doneAt: number | null = null;
    void drain.then(() => { doneAt = Date.now(); });
    await tick(15 * SECOND);
    w.store.login53300 = 'always';
    w.answers.set(A, answered(w.m, A));
    await tick(15 * SECOND);
    await drain;
    const confirmedAt = w.store.confirmedAt!;
    expect(confirmedAt).not.toBeNull();
    expect(doneAt! - confirmedAt).toBeGreaterThanOrEqual(3 * SECOND);
    expect(doneAt! - confirmedAt).toBeLessThan(4 * SECOND);
    expect(warned(w).some(l => l.startsWith('[Data] Shutdown drain left 3 guild(s) with unflushed writes: '))).toBe(true);
    await stopWorld(w);
  });
});
