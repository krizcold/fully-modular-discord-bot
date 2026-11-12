import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  backend: null as any,
  ws: null as any,
  readiness: null as any,
  identity: (() => new Promise(() => {})) as () => Promise<any>,
  guard: null as any,
  settleDeps: null as any,
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/postgresBackend', async orig => {
  class FakeBackend {
    holdCb: ((words: string | null) => void) | null = null;
    steps: any = null;
    entry: string | null = null;
    provision: Promise<any> = new Promise(() => {});
    constructor() { h.backend = this; }
    onHoldChanged(cb: (words: string | null) => void) { this.holdCb = cb; }
    setMoveSteps(steps: any) { this.steps = steps; }
    start() { /* the fake runs no pass */ }
    chosenEntry() { return this.entry; }
    provisionVerdict() { return this.provision; }
    async stop() { /* nothing open */ }
  }
  return { ...(await orig<any>()), PostgresBackend: FakeBackend };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => ({
  ...(await orig<any>()),
  initWorkingSet: () => h.ws,
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async orig => ({
  ...(await orig<any>()),
  initDataReadiness: () => ({ release: () => undefined }),
  getDataReadiness: () => h.readiness,
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/recognitionGuard', async orig => {
  const actual = await orig<any>();
  return {
    ...actual,
    evaluateRecognitionGuard: () => h.guard ?? actual.evaluateRecognitionGuard(),
    verifyStoreIdentity: () => h.identity(),
  };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/mainDatabase', async orig => ({
  ...(await orig<any>()),
  settleRetires: async (_backend: unknown, _epoch: number, _entry: string, deps: unknown) => { h.settleDeps = deps; return true; },
}));

import {
  _startPostgresRuntime, admitGuildAction, getDataBootStatus, initDataBackendLayer, mainChooserDeps,
} from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { moveTargetGeneration, stepLayers, stopMainWatch, type MainChooser } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { showEntry } from '../../src/utils/databaseAddress';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

const A = 'postgres://bot:pw@a.example:5432/bot';

interface Fake {
  chooser: MainChooser;
  hooks: any;
  view: { generation: number | null; machine: string | null };
  choose: (entry: string | null) => void;
  stop: ReturnType<typeof vi.fn>;
}

let nextGeneration = 9000;

function fakeChooser(): Fake {
  let choose!: (entry: string | null) => void;
  const choice = new Promise<string | null>(resolve => { choose = resolve; });
  const fake: Fake = {
    chooser: null as unknown as MainChooser,
    hooks: null,
    view: { generation: null, machine: null },
    choose,
    stop: vi.fn(),
  };
  fake.chooser = {
    view: () => ({ ...fake.view }),
    attach: (_backend: unknown, hooks: unknown) => { fake.hooks = hooks; },
    awaitChoice: () => choice,
    exitDrainBegan: () => undefined,
    moveGeneration: nextGeneration++,
    moveMachine: 'M',
    stop: fake.stop,
  } as unknown as MainChooser;
  return fake;
}

let sent: any[];
let hadSend: typeof process.send;
const stores = () => sent.filter(m => m?.type === 'data:store').map(m => m.data);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

beforeEach(() => {
  sent = [];
  hadSend = process.send;
  process.send = ((message: any, callback?: () => void) => { sent.push(message); callback?.(); return true; }) as typeof process.send;
  setBackendKind('postgres');
  h.ws = {
    markForResave: vi.fn(),
    dropRetired: vi.fn(),
    flagEpoch: vi.fn(),
  };
  h.readiness = null;
  h.identity = () => new Promise(() => {});
  h.guard = null;
  h.settleDeps = null;
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  process.send = hadSend;
  setBackendKind(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('admitGuildAction on a set lease', () => {
  it('answers not-served at once when the lease is set, and holds to the deadline while it is not', async () => {
    _startPostgresRuntime(fakeChooser().chooser);
    const causeOf = vi.fn(() => 'not-served');
    h.readiness = { causeOf, leaseSet: () => true };
    expect(await admitGuildAction('111', performance.now() + 2000)).toEqual({ cause: 'not-served', mark: null });
    expect(causeOf).toHaveBeenCalledTimes(1);

    const unset = vi.fn(() => 'not-served');
    h.readiness = { causeOf: unset, leaseSet: () => false };
    expect(await admitGuildAction('111', performance.now() + 120)).toEqual({ cause: 'not-served', mark: null });
    expect(unset.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('the boot status a reader gets', () => {
  it("a wait reason shows while starting", () => {
    _startPostgresRuntime(fakeChooser().chooser);
    mainChooserDeps().onWait('no database answered as the main');
    expect(getDataBootStatus()).toMatchObject({ state: 'starting', waitReason: 'no database answered as the main', refusalReason: null });
  });

  it('a refusal while waiting drops the wait reason and shows the refusal', async () => {
    const f = fakeChooser();
    _startPostgresRuntime(f.chooser);
    mainChooserDeps().onWait('W1');
    h.backend.entry = A;
    h.identity = async () => ({ ok: false, reason: 'the store differs' });
    f.choose(A);
    await vi.waitFor(() => expect(getDataBootStatus().state).toBe('refused'), { timeout: 2000, interval: 5 });
    expect(getDataBootStatus()).toEqual({ mode: 'postgres', state: 'refused', refusalReason: 'the store differs', waitReason: null });
  });

  it('a runtime started after a refusal shows no refusal reason', async () => {
    const f = fakeChooser();
    _startPostgresRuntime(f.chooser);
    h.backend.entry = A;
    h.identity = async () => ({ ok: false, reason: 'the old refusal' });
    f.choose(A);
    await vi.waitFor(() => expect(getDataBootStatus().state).toBe('refused'), { timeout: 2000, interval: 5 });
    h.identity = () => new Promise(() => {});
    _startPostgresRuntime(fakeChooser().chooser);
    expect(getDataBootStatus()).toEqual({ mode: 'postgres', state: 'starting', refusalReason: null, waitReason: null });
  });

  it('a shape verdict after the identity refusal keeps the first refusal', async () => {
    const f = fakeChooser();
    _startPostgresRuntime(f.chooser);
    let verdict!: (v: unknown) => void;
    h.backend.provision = new Promise(resolve => { verdict = resolve; });
    h.backend.entry = A;
    h.identity = async () => ({ ok: false, reason: 'identity first' });
    f.choose(A);
    await vi.waitFor(() => expect(getDataBootStatus().state).toBe('refused'), { timeout: 2000, interval: 5 });
    verdict({ state: 'shape', reason: 'shape second', fix: 'shape fix' });
    await flush();
    await flush();
    expect(getDataBootStatus().refusalReason).toBe('identity first');
    const errors = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0]));
    expect(errors).not.toContain('[Data] REFUSING to serve: shape second');
    expect(errors).not.toContain('[Data] shape fix');
  });
});

describe('the notice check setting', () => {
  it.each([
    ['off', true],
    [' OFF ', true],
    ['on', false],
    ['', false],
  ])('DATA_NOTICE_CHECK=%j reads as off: %s', (value, off) => {
    vi.stubEnv('DATA_NOTICE_CHECK', value);
    expect(mainChooserDeps().noticeCheckOff()).toBe(off);
  });

  it('an unset DATA_NOTICE_CHECK keeps the check on', () => {
    vi.stubEnv('DATA_NOTICE_CHECK', undefined as unknown as string);
    delete process.env.DATA_NOTICE_CHECK;
    expect(mainChooserDeps().noticeCheckOff()).toBe(false);
  });
});

describe('the store reports to the parent', () => {
  it('the started chooser is the one the main watch stops and the move reads', () => {
    const f = fakeChooser();
    _startPostgresRuntime(f.chooser);
    expect(moveTargetGeneration()).toBe((f.chooser as any).moveGeneration);
    stopMainWatch();
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it('a choice that ends with no main sends no url report', async () => {
    const f = fakeChooser();
    _startPostgresRuntime(f.chooser);
    f.choose(null);
    await flush();
    await flush();
    expect(stores()).toEqual([{ url: null, choosing: true }]);
  });

  it('a chosen url reports with the tag; a main change of the same tag or no tag sends nothing more; a new tag reports again', async () => {
    const f = fakeChooser();
    _startPostgresRuntime(f.chooser);
    f.view = { generation: 5, machine: 'M' };
    f.choose(A);
    await vi.waitFor(() => expect(stores()).toHaveLength(2), { timeout: 2000, interval: 5 });
    expect(stores()[1]).toEqual({ url: A, tag: '5:M' });
    f.hooks.mainChanged();
    expect(stores()).toHaveLength(2);
    f.view = { generation: null, machine: null };
    f.hooks.mainChanged();
    expect(stores()).toHaveLength(2);
    f.view = { generation: 6, machine: 'N' };
    f.hooks.mainChanged();
    expect(stores()).toEqual([{ url: null, choosing: true }, { url: A, tag: '5:M' }, { url: A, tag: '6:N' }]);
  });

  it("a report naming no url carries no tag, and a main change after it sends nothing", () => {
    const f = fakeChooser();
    _startPostgresRuntime(f.chooser);
    f.view = { generation: 5, machine: 'M' };
    f.hooks.report({ url: null, choosing: true, reason: 'R' });
    expect(stores().at(-1)).toEqual({ url: null, choosing: true, reason: 'R' });
    expect(stores().at(-1).tag).toBeUndefined();
    const count = stores().length;
    f.hooks.mainChanged();
    expect(stores()).toHaveLength(count);
  });

  it("the hold's changes report the chosen url, held with its words or plain", () => {
    const f = fakeChooser();
    _startPostgresRuntime(f.chooser);
    f.view = { generation: 5, machine: 'M' };
    h.backend.entry = A;
    h.backend.holdCb('the database is held');
    expect(stores().at(-1)).toEqual({ url: A, held: true, reason: 'the database is held', tag: '5:M' });
    h.backend.holdCb(null);
    expect(stores().at(-1)).toEqual({ url: A, tag: '5:M' });
  });
});

describe("the step hooks reach the layers that own them", () => {
  it('stop serving, start leave and attempt ended go to the step layers', async () => {
    const stop = vi.spyOn(stepLayers, 'stopServing');
    const leave = vi.spyOn(stepLayers, 'startLeave');
    const ended = vi.spyOn(stepLayers, 'attemptEnded');
    const f = fakeChooser();
    _startPostgresRuntime(f.chooser);
    f.hooks.stopServing('lost the main');
    f.hooks.startLeave('the move left');
    h.backend.steps.attemptEnded();
    expect(stop).toHaveBeenCalledWith('lost the main');
    expect(leave).toHaveBeenCalledWith('the move left');
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('mark for resave names the chosen entry as shown', () => {
    const f = fakeChooser();
    _startPostgresRuntime(f.chooser);
    h.backend.entry = A;
    f.hooks.markForResave();
    expect(h.ws.markForResave).toHaveBeenCalledTimes(1);
    expect(h.ws.markForResave.mock.calls[0][0]).toBe(showEntry(A));
    expect(h.ws.markForResave.mock.calls[0][0]).not.toContain('pw');
  });

  it("settling the retires drops each reached guild and flags the epoch on the working set", async () => {
    const f = fakeChooser();
    _startPostgresRuntime(f.chooser);
    await h.backend.steps.settleRetires(3, A);
    h.settleDeps.reached('222');
    h.settleDeps.flagEpoch(['333']);
    expect(h.ws.dropRetired).toHaveBeenCalledWith('222');
    expect(h.ws.flagEpoch).toHaveBeenCalledWith(['333']);
  });
});

describe('a file-mode boot', () => {
  it('ends a restore folder a stopped process left', () => {
    const graveyard = dataPath('_graveyard');
    fs.mkdirSync(dataPath('_graveyard', '.copy-444-1-2'), { recursive: true });
    h.guard = { state: 'boot', live: 'file' };
    setBackendKind('file');
    initDataBackendLayer();
    expect(getDataBootStatus().state).toBe('file');
    expect(fs.readdirSync(graveyard)).toEqual(['.sweep-restore-444-1-2']);
  });
});
