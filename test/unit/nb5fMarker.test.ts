import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListEntry } from '../../src/utils/databaseAddress';
import type { NoticeRead, ProbeAnswer, StepHooks } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import type { LatchCause } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { setBackendKind } from '../helpers/backendKind';

// NB5F decisions 1 and 2: the marker read strictly by the chooser. The marker is written by the real writer
// (writeFileMarker) into this file's data root, then made unreadable as an operator could: the path replaced by a
// directory (EISDIR from readFileSync) or the file cut mid-edit (cannot be parsed). Probes answer in probePass's shape.

const h = vi.hoisted(() => ({ clients: 0 }));
vi.mock('pg', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  class Client {
    constructor() { h.clients += 1; }
    on() { return this; }
    connect() { return Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })); }
    query() { return Promise.reject(new Error('no session')); }
    end() { return Promise.resolve(); }
  }
  return { ...real, Client, default: { ...(real.default as object), Client } };
});

const A = 'postgresql://bot:pw-secret-9@a:5432/bot';
const B = 'postgresql://bot:pw-secret-9@b:5432/bot';
const SECOND = 1000;
const ENDED = "the database ended this process's sessions (SQLSTATE 57P01)";

type Mods = {
  main: typeof import('../../src/bot/internalSetup/utils/dataBackends/mainDatabase');
  pg: typeof import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend');
  guard: typeof import('../../src/bot/internalSetup/utils/dataBackends/recognitionGuard');
  address: typeof import('../../src/utils/databaseAddress');
};

async function load(): Promise<Mods> {
  vi.resetModules();
  return {
    main: await import('../../src/bot/internalSetup/utils/dataBackends/mainDatabase'),
    pg: await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend'),
    guard: await import('../../src/bot/internalSetup/utils/dataBackends/recognitionGuard'),
    address: await import('../../src/utils/databaseAddress'),
  };
}

// The marker as the real writer leaves it, and the two ways an operator's hand leaves it unreadable.
function writeMarker(m: Mods, storeId: string | null): void {
  fs.rmSync(m.guard.MARKER_FILE, { recursive: true, force: true });
  m.guard.writeFileMarker({ live: 'postgres', storeId, flippedAt: 1 });
  expect(fs.readFileSync(m.guard.MARKER_FILE, 'utf-8')).toContain('"live": "postgres"');
}
function markerAsDirectory(m: Mods): string {
  fs.rmSync(m.guard.MARKER_FILE, { recursive: true, force: true });
  fs.mkdirSync(m.guard.MARKER_FILE);
  let message = '';
  try { fs.readFileSync(m.guard.MARKER_FILE, 'utf-8'); } catch (error) { message = (error as Error).message; }
  expect(message).toMatch(/^EISDIR/);
  return `${m.guard.MARKER_FILE} cannot be read (${message})`;
}
function markerCut(m: Mods): string {
  fs.rmSync(m.guard.MARKER_FILE, { recursive: true, force: true });
  fs.writeFileSync(m.guard.MARKER_FILE, '{"live":');
  return `${m.guard.MARKER_FILE} cannot be parsed`;
}

const unknownStore = (why: string) => `${why}, so the bot can't confirm which store this machine records`;
const T1 = (why: string) => `${unknownStore(why)}; it chooses no database and reads that file again at every check`;
const T3 = (why: string) => `[Database] Not moving yet: ${unknownStore(why)}; this process keeps its unsaved changes and stays stopped`;
const T4a = (why: string, id: string, address: string) =>
  `[Database] ${unknownStore(why)}; until it can, the watch counts only the databases of store ${id}, the store at ${address}, and a hold does not end`;
const T4b = (why: string) => `[Database] ${unknownStore(why)}; until it can, the watch counts every database that answers, and a hold does not end`;
const T5 = (address: string, g: number, other: string, hg: number, why: string) =>
  `can't confirm that this bot process's database ${address} (generation ${g}) is still the main: ${other} accepts writes at generation ${hg}, and ${why}, so the bot can't tell whether that database holds this bot's store`;
const T6 = (address: string, other: string, hg: number) =>
  `can't confirm that ${address} is still the main (${other} accepts writes at generation ${hg}, and the store this machine records is unknown)`;
const T7 = (why: string) => `${unknownStore(why)}; checking again`;

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

/** The backend's side the chooser drives, with decision 13's hold and decision 11's latch as nb5StateExit's HoldStore has them. */
class HoldBackend {
  epoch = 1;
  phase: 'ready' | 'outage' | 'confirming' = 'ready';
  entryCause = '';
  confirmingCause = 'checking';
  latchWhy: string | null = null;
  confirmedAt: number | null = null;
  entry = A;
  moveAttempts = 0;
  chooser: { holdStarted(b: unknown): void } | null = null;
  constructor(private readonly m: Mods) {}

  enter(cause: string): void {
    if (this.phase !== 'ready' || this.latchWhy !== null) return;
    this.phase = 'outage';
    this.entryCause = cause;
    this.chooser?.holdStarted(this);
  }
  databaseEpoch(): number { return this.epoch; }
  chosenEntry(): string { return this.entry; }
  latchReason(): string | null { return this.latchWhy; }
  isMoving(): boolean { return false; }
  connectionState(): { state: string } { return { state: this.latchWhy !== null ? 'latched' : this.phase }; }
  holdWords(): string | null {
    const address = this.m.address.showEntry(this.entry);
    if (this.phase === 'outage') return `${this.entryCause}; this process checks that ${address} is still the main before writing to it`;
    if (this.phase === 'confirming') return `the database answers again, but this process can't confirm yet that ${address} is still the main (${this.confirmingCause})`;
    return null;
  }
  confirmingWords(): string | null { return this.phase === 'confirming' ? this.confirmingCause : null; }
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
  async useDatabase(): Promise<boolean> {
    this.moveAttempts += 1;
    return false;
  }
}

interface World {
  m: Mods;
  backend: HoldBackend;
  chooser: InstanceType<Mods['main']['MainChooser']>;
  hooks: { [K in keyof StepHooks]: ReturnType<typeof vi.fn> };
  answers: Map<string, ProbeAnswer>;
  list: string[];
}

/** A chooser that chose A under a readable marker naming S, watching HoldBackend. */
async function world(list: string[], answers: Array<[string, (m: Mods) => ProbeAnswer]>): Promise<World> {
  const m = await load();
  setBackendKind('postgres');
  writeMarker(m, 'S');
  const backend = new HoldBackend(m);
  const w = { m, backend, list, answers: new Map<string, ProbeAnswer>() } as World;
  for (const [entry, make] of answers) w.answers.set(entry, make(m));
  const chooser = new m.main.MainChooser({
    entries: () => m.address.parseAddressList(w.list.join(',')),
    probe: async (entries: ListEntry[]) => entries.map(e => w.answers.get(e.raw) ?? refusedConnect(m, e.raw)),
    readNotice: async (): Promise<NoticeRead> => ({ kind: 'none' }),
    sendWaitDm: async () => ({ ok: true }),
    markerStoreId: () => m.guard.readMarkerStoreId(),
    noticeCheckOff: () => false,
    nodeName: () => 'node-a',
    onWait: () => undefined,
  });
  expect(await chooser.awaitChoice()).toBe(A);
  backend.chooser = chooser;
  const hooks = { stopServing: vi.fn(), report: vi.fn(), markForResave: vi.fn(), startLeave: vi.fn() };
  chooser.attach(backend as never, hooks);
  return Object.assign(w, { chooser, hooks });
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const lines = (level: 'warn' | 'error' | 'log') => vi.mocked(console[level]).mock.calls.map(c => c.map(String).join(' '));

let current: Mods | null = null;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  h.clients = 0;
});
afterEach(() => {
  if (current) fs.rmSync(current.guard.MARKER_FILE, { recursive: true, force: true });
  current = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  setBackendKind(null);
});

describe('D1: readMarkerStoreId reads strictly', () => {
  it('M1: a marker that cannot be read or parsed, or names no backend, throws MarkerUnreadable with its why and the message it has today; an absent one answers null', async () => {
    const m = current = await load();
    const message = (why: string) => `this machine's marker ${why}, so the store id it records is unknown; no store id was written and nothing was refused`;
    const cases: Array<() => string> = [
      () => markerAsDirectory(m),
      () => markerCut(m),
      () => {
        fs.rmSync(m.guard.MARKER_FILE, { recursive: true, force: true });
        fs.writeFileSync(m.guard.MARKER_FILE, JSON.stringify({ live: 'redis', storeId: 'S' }));
        return `${m.guard.MARKER_FILE} does not name file or postgres`;
      },
    ];
    for (const make of cases) {
      const why = make();
      let thrown: unknown;
      try { m.guard.readMarkerStoreId(); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(m.guard.MarkerUnreadable);
      expect((thrown as { why: string }).why).toBe(why);
      expect((thrown as Error).message).toBe(message(why));
    }
    fs.rmSync(m.guard.MARKER_FILE, { recursive: true, force: true });
    expect(m.guard.readMarkerStoreId()).toBeNull();
    writeMarker(m, null);
    expect(m.guard.readMarkerStoreId()).toBeNull();
    writeMarker(m, 'S');
    expect(m.guard.readMarkerStoreId()).toBe('S');
  });

  it("M2: boot's chooser reads the marker strictly: mainChooserDeps().markerStoreId() throws on a marker that is a directory", async () => {
    const m = current = await load();
    const boot = await import('../../src/bot/internalSetup/utils/dataBackends/boot');
    markerAsDirectory(m);
    expect(() => boot.mainChooserDeps().markerStoreId()).toThrow();
  });
});

describe('D2: the boot wait', () => {
  it('M3: with the marker a directory and A and B of two stores writable at generation 0, three passes choose nothing and wait with T1; the marker rewritten with S, A is chosen', async () => {
    const m = current = await load();
    const why = markerAsDirectory(m);
    const waits: Array<string | null> = [];
    const sendWaitDm = vi.fn(async () => ({ ok: true }));
    const probes: number[] = [];
    const chooser = new m.main.MainChooser({
      entries: () => m.address.parseAddressList(`${A},${B}`),
      probe: async () => {
        probes.push(Date.now());
        return [answered(m, A, { generation: 0, machine: null, storeId: 'S' }), answered(m, B, { generation: 0, machine: null, storeId: 'T' })];
      },
      readNotice: async () => ({ kind: 'none' }),
      sendWaitDm,
      markerStoreId: () => m.guard.readMarkerStoreId(),
      noticeCheckOff: () => false,
      nodeName: () => 'node-a',
      onWait: reason => { waits.push(reason); },
    });
    let chosen: string | null | undefined;
    void chooser.awaitChoice().then(e => { chosen = e; });
    await tick(25 * SECOND);
    expect(probes).toHaveLength(3);
    expect(chosen).toBeUndefined();
    expect(waits).toEqual([T1(why), T1(why), T1(why)]);
    expect(chooser.view()).toMatchObject({ state: 'unknown-store', reason: T1(why), chosen: null });
    expect([...lines('warn'), ...lines('error')].filter(l => l.includes('records no store id'))).toEqual([]);
    expect(lines('warn')).toContain(`[Database] ${T1(why)}; waiting`);
    expect(sendWaitDm).not.toHaveBeenCalled();
    writeMarker(m, 'S');
    await tick(10 * SECOND);
    expect(chosen).toBe(A);
    chooser.stop();
  });
});

describe('D2: the watch and the latched pass', () => {
  it('M4: latched with the marker a directory, a pass that finds W moves to nothing, and T3 is logged once over three passes', async () => {
    const w = await world([A], [[A, m => answered(m, A)]]);
    current = w.m;
    w.backend.latch({ kind: 'tie', generation: 1 });
    w.list = [A, B];
    w.answers.set(B, answered(w.m, B, { generation: 2, machine: 'node-b', sysid: 'sys-b' }));
    const why = markerAsDirectory(w.m);
    await tick(30 * SECOND);
    await tick(5 * SECOND);
    await tick(5 * SECOND);
    expect(w.backend.moveAttempts).toBe(0);
    expect(lines('warn').filter(l => l === T3(why))).toHaveLength(1);
    expect(lines('error').filter(l => l.startsWith('[Database]'))).toEqual([]);
    w.chooser.stop();
  });

  it("M5: serving with the marker a directory, B of store T at generation 2 starts no step and T4a is logged once; B answering S at 2 runs today's 'replaced' step", async () => {
    const w = await world([A, B], [
      [A, m => answered(m, A)],
      [B, m => answered(m, B, { generation: 2, machine: 'node-b', sysid: 'sys-b', storeId: 'T' })],
    ]);
    current = w.m;
    const why = markerAsDirectory(w.m);
    await tick(30 * SECOND);
    await tick(30 * SECOND);
    expect(w.backend.latchReason()).toBeNull();
    expect(w.hooks.stopServing).not.toHaveBeenCalled();
    expect(lines('warn').filter(l => l === T4a(why, 'S', 'a:5432/bot'))).toHaveLength(1);
    w.answers.set(B, answered(w.m, B, { generation: 2, machine: 'node-b', sysid: 'sys-b', storeId: 'S' }));
    await tick(30 * SECOND);
    expect(w.backend.latchReason()).toBe('a:5432/bot was replaced by node-b (generation 2)');
    expect(w.hooks.stopServing).toHaveBeenCalledWith("This bot process's database a:5432/bot (generation 1) was replaced by node-b on 2026-11-01T10:00:00.000Z (generation 2)");
    w.chooser.stop();
  });

  it("M6: the chosen entry silent and the marker a directory, B of store T accepting writes at generation 2 runs the step with 'unknown-store' (T5 and T6)", async () => {
    const w = await world([A, B], [
      [A, m => answered(m, A)],
      [B, m => answered(m, B, { generation: 2, machine: 'node-b', sysid: 'sys-b', storeId: 'T' })],
    ]);
    current = w.m;
    const why = markerAsDirectory(w.m);
    w.answers.set(A, refusedConnect(w.m, A));
    await tick(30 * SECOND);
    expect(w.backend.latchReason()).toBe(T6('a:5432/bot', 'b:5432/bot', 2));
    expect(w.hooks.stopServing).toHaveBeenCalledWith(T5('a:5432/bot', 1, 'b:5432/bot', 2, why));
    expect(w.hooks.startLeave).toHaveBeenCalledWith(T5('a:5432/bot', 1, 'b:5432/bot', 2, why));
    expect(lines('warn').filter(l => l === T4b(why))).toHaveLength(1);
    w.chooser.stop();
  });

  it.each([
    ['a live copy', { inRecovery: true }, 'is a live copy'],
    ['read-only', { readOnly: true }, 'is read-only'],
    ['accepting writes', {}, 'accepts writes'],
  ] as const)("M9: A answering with no store_id row and the marker a directory, R of store T at generation 2 and %s runs the step with 'unknown-store' in that form", async (_name, over, form) => {
    const w = await world([A], [[A, m => answered(m, A)]]);
    current = w.m;
    const why = markerAsDirectory(w.m);
    w.answers.set(A, answered(w.m, A, { storeId: null }));
    w.list = [A, B];
    w.answers.set(B, answered(w.m, B, { generation: 2, machine: 'node-b', sysid: 'sys-b', storeId: 'T', ...over }));
    await tick(30 * SECOND);
    const t5 = `can't confirm that this bot process's database a:5432/bot (generation 1) is still the main: b:5432/bot ${form} at generation 2, and ${why}, so the bot can't tell whether that database holds this bot's store`;
    expect(w.backend.latchReason()).toBe(`can't confirm that a:5432/bot is still the main (b:5432/bot ${form} at generation 2, and the store this machine records is unknown)`);
    expect(w.hooks.stopServing).toHaveBeenCalledWith(t5);
    expect(w.hooks.startLeave).toHaveBeenCalledWith(t5);
    if (form === 'accepts writes') {
      expect(w.backend.latchReason()).toBe(T6('a:5432/bot', 'b:5432/bot', 2));
      expect(t5).toBe(T5('a:5432/bot', 1, 'b:5432/bot', 2, why));
    }
    w.chooser.stop();
  });

  it("M10: A answering with no store_id row and the marker a directory, B accepting writes at A's generation for two passes runs the step with 'unknown-store' (T5 with <h> equal to <g>)", async () => {
    const w = await world([A], [[A, m => answered(m, A)]]);
    current = w.m;
    const why = markerAsDirectory(w.m);
    w.answers.set(A, answered(w.m, A, { storeId: null }));
    w.list = [A, B];
    w.answers.set(B, answered(w.m, B, { machine: 'node-b', sysid: 'sys-b', storeId: 'T' }));
    await tick(30 * SECOND);
    await tick(30 * SECOND);
    expect(w.backend.latchReason()).toBe(T6('a:5432/bot', 'b:5432/bot', 1));
    expect(w.hooks.stopServing).toHaveBeenCalledWith(T5('a:5432/bot', 1, 'b:5432/bot', 1, why));
    expect(w.hooks.startLeave).toHaveBeenCalledWith(T5('a:5432/bot', 1, 'b:5432/bot', 1, why));
    w.chooser.stop();
  });

  it("M7: held in 'confirming' with the marker a directory, A answering S does not end the hold and the cause is T7; the marker rewritten, the hold ends", async () => {
    const w = await world([A], [[A, m => answered(m, A)]]);
    current = w.m;
    const why = markerCut(w.m);
    w.backend.enter(ENDED);
    await tick(5 * SECOND);
    expect(w.backend.phase).toBe('confirming');
    expect(w.backend.confirmedAt).toBeNull();
    expect(w.backend.confirmingWords()).toBe(T7(why));
    writeMarker(w.m, 'S');
    await tick(5 * SECOND);
    expect(w.backend.phase).toBe('ready');
    expect(w.backend.confirmedAt).not.toBeNull();
    w.chooser.stop();
  });
});

describe("D4: boot.ts's move check reads the marker strictly", () => {
  it("M8: with the marker a directory, checkTarget answers T8 and constructs no pg Client; exitBegan follows the chooser's exit drain", async () => {
    const m = current = await load();
    const boot = await import('../../src/bot/internalSetup/utils/dataBackends/boot');
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    setBackendKind('postgres');
    const setSteps = vi.spyOn(m.pg.PostgresBackend.prototype, 'setMoveSteps');
    const chooser = new m.main.MainChooser({
      entries: () => m.address.parseAddressList(A),
      probe: async entries => entries.map(e => refusedConnect(m, e.raw)),
      readNotice: async () => ({ kind: 'none' }),
      sendWaitDm: async () => ({ ok: true }),
      markerStoreId: () => null,
      noticeCheckOff: () => false,
      nodeName: () => 'node-a',
      onWait: () => undefined,
    });
    const backend = boot._startPostgresRuntime(chooser);
    try {
      const why = markerAsDirectory(m);
      const steps = setSteps.mock.calls[0][0];
      h.clients = 0;
      expect(await steps.checkTarget(B)).toBe(unknownStore(why));
      expect(h.clients).toBe(0);
      expect(steps.exitBegan?.()).toBe(false);
      chooser.noteExitDrain();
      expect(steps.exitBegan?.()).toBe(true);
    } finally {
      chooser.stop();
      await backend.stop();
      dm.setGuildDataBackend(null);
      m.main.setMainChooser(null);
    }
  });
});
