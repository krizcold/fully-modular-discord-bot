import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ noManager: false }));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => {
  const real = await orig<any>();
  return { ...real, getWorkingSet: () => (h.noManager ? null : real.getWorkingSet()) };
});

import { dataPath } from '../../src/utils/dataRoot';
import { getPending } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { DataBackendUnavailableError, initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { pendingFor, saveMark, stampOf } from '../../src/bot/internalSetup/utils/dataBackends/scopeRecord';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore, tokenFor } from '../helpers/fakeStore';
import { freezeGuildWrites } from '../helpers/freezeGuild';
import { freshGuild } from '../helpers/gateRig';

// NB1's update(fn) (wip-redesign/sheets/NB1.md, "Tests to write first", item 1): a read, a change and a save of one
// document in one synchronous run, refused without running fn when the document cannot be read whole.

afterEach(() => {
  h.noManager = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type RouteName = 'file global' | 'file guild' | 'working-set guild';
const ROUTES: RouteName[] = ['file global', 'file guild', 'working-set guild'];
const GUILD_ROUTES: RouteName[] = ['file guild', 'working-set guild'];
const FILE_ROUTES: RouteName[] = ['file global', 'file guild'];

interface Route {
  name: RouteName;
  options: dm.DataOptions;
  scope: string;
  guildId: string;
  store: FakeStore | null;
  ws: WorkingSetManager | null;
  /** The file path of a file route. */
  file: string;
  /** What the store or the disk holds now, as text; undefined when absent. */
  stored(): string | undefined;
}

let categories = 0;

/** A route with doc.json stored as text (unless undefined) and nothing queued. */
async function routeOf(name: RouteName, text?: string): Promise<Route> {
  const guildId = freshGuild();
  if (name === 'working-set guild') {
    setBackendKind('postgres');
    const store = new FakeStore();
    if (text !== undefined) store.docs.set(`${guildId}|m/doc.json`, text);
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    return {
      name, options: { guildId, category: 'm' }, scope: guildId, guildId, store, ws, file: '',
      stored: () => store.docs.get(`${guildId}|m/doc.json`),
    };
  }
  setBackendKind('file');
  const category = `nb1u${++categories}`;
  const options: dm.DataOptions = name === 'file global' ? { scope: 'global', category } : { guildId, category };
  const file = name === 'file global' ? dataPath('global', category, 'doc.json') : dataPath(guildId, category, 'doc.json');
  if (text !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return {
    name, options, scope: name === 'file global' ? 'global' : guildId, guildId, store: null, ws: null, file,
    stored: () => (fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : undefined),
  };
}

/** Nothing of doc.json is queued or dirty on the route. */
function nothingQueued(r: Route): void {
  if (r.ws) expect(r.ws.dirtyGuildIds()).not.toContain(r.guildId);
  else expect(getPending(r.file)).toBeUndefined();
}

function spyFn<T>(change: (d: T) => T = d => d) {
  const seen: T[] = [];
  const fn = vi.fn((d: T) => { seen.push(d); return change(d); });
  return { fn, seen };
}

const update = (r: Route, fn: (d: any) => any, defaultValue: any = { n: 0 }) => dm.updateData('doc.json', r.options, defaultValue, fn);

async function landed(r: Route, result: dm.SaveTracked): Promise<void> {
  expect(result.outcome).toBe('saved');
  if (result.outcome === 'saved') expect(await dm.confirmWrite(result.ticket, 5000)).toBe('ok');
}

describe('update(fn) on each route and state', () => {
  it.each(ROUTES)('%s, absent: fn gets a copy of the default, and a module-level default is never changed', async name => {
    const DEFAULT = { n: 0, list: [] as number[] };
    const r = await routeOf(name);
    const { fn, seen } = spyFn<typeof DEFAULT>(d => { d.list.push(1); d.n += 1; return d; });
    await landed(r, update(r, fn, DEFAULT));
    const other = dm.updateData('other.json', r.options, DEFAULT, fn);
    expect(other.outcome).toBe('saved');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(seen[0]).not.toBe(DEFAULT);
    expect(DEFAULT).toEqual({ n: 0, list: [] });
    expect(JSON.parse(r.stored()!)).toEqual({ n: 1, list: [1] });
  });

  it.each(ROUTES)('%s, present: fn gets the stored value and its answer is stored', async name => {
    const r = await routeOf(name, JSON.stringify({ n: 1 }));
    const { fn, seen } = spyFn<{ n: number }>(d => ({ n: d.n + 1 }));
    await landed(r, update(r, fn));
    expect(seen).toEqual([{ n: 1 }]);
    expect(JSON.parse(r.stored()!)).toEqual({ n: 2 });
  });

  it.each(ROUTES)('%s, a write still queued: fn gets that write', async name => {
    const r = await routeOf(name, JSON.stringify({ n: 1 }));
    expect(dm.saveData('doc.json', r.options, { n: 5 })).toBe(true);
    const { fn, seen } = spyFn<{ n: number }>(d => ({ n: d.n + 1 }));
    await landed(r, update(r, fn));
    expect(seen).toEqual([{ n: 5 }]);
    expect(JSON.parse(r.stored()!)).toEqual({ n: 6 });
  });

  it.each(ROUTES)('%s, a delete still queued: fn gets a copy of the default', async name => {
    const r = await routeOf(name, JSON.stringify({ n: 1 }));
    expect(dm.deleteData('doc.json', r.options)).toBe(true);
    const { fn, seen } = spyFn<{ n: number }>(d => ({ n: d.n + 7 }));
    await landed(r, update(r, fn));
    expect(seen).toEqual([{ n: 0 }]);
    expect(JSON.parse(r.stored()!)).toEqual({ n: 7 });
  });

  it.each(ROUTES)('%s, an append still queued: refused io and fn never runs', async name => {
    const r = await routeOf(name);
    expect(dm.appendData('doc.json', r.options, '{"line":1}\n')).toBe(true);
    const { fn } = spyFn();
    expect(update(r, fn)).toEqual({ outcome: 'refused', cause: 'io' });
    expect(fn).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s, a stored document that does not parse: refused io, fn never runs, the bytes stay', async name => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await routeOf(name, '{"n":');
    const { fn } = spyFn();
    expect(update(r, fn)).toEqual({ outcome: 'refused', cause: 'io' });
    expect(fn).not.toHaveBeenCalled();
    expect(r.stored()).toBe('{"n":');
    nothingQueued(r);
  });

  it.each(FILE_ROUTES)('%s, a file that cannot be read: refused io and fn never runs', async name => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await routeOf(name);
    fs.mkdirSync(r.file, { recursive: true });
    const { fn } = spyFn();
    expect(update(r, fn)).toEqual({ outcome: 'refused', cause: 'io' });
    expect(fn).not.toHaveBeenCalled();
    expect(fs.statSync(r.file).isDirectory()).toBe(true);
    nothingQueued(r);
  });

  it('working-set guild, a set not ready: refused not-ready and fn never runs', async () => {
    const r = await routeOf('working-set guild');
    r.store!.hydrateMode = 'held';
    const other = freshGuild();
    void r.ws!.hydrate(other, tokenFor());
    const { fn } = spyFn();
    expect(dm.updateData('doc.json', { guildId: other, category: 'm' }, {}, fn)).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(dm.updateData('doc.json', { guildId: freshGuild(), category: 'm' }, {}, fn)).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(fn).not.toHaveBeenCalled();
    r.store!.releaseHydrations();
  });

  it('working-set guild, no working set in this process: refused not-ready and fn never runs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await routeOf('working-set guild');
    h.noManager = true;
    const { fn } = spyFn();
    expect(update(r, fn)).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('working-set guild, a frozen set: frozen, nothing written', async () => {
    const r = await routeOf('working-set guild', JSON.stringify({ n: 1 }));
    freezeGuildWrites(r.guildId, r.ws);
    expect(update(r, d => ({ n: d.n + 1 }))).toEqual({ outcome: 'frozen' });
    nothingQueued(r);
  });

  it('working-set guild, a fenced set: throws guild-fenced', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await routeOf('working-set guild', JSON.stringify({ n: 1 }));
    r.store!.mode = 'deposed';
    expect(dm.saveData('doc.json', r.options, { n: 2 })).toBe(true);
    expect(await r.ws!.flushGuildNow(r.guildId, 2000)).toBe('deposed');
    let thrown: unknown;
    try { update(r, d => ({ n: d.n + 1 })); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(DataBackendUnavailableError);
    expect((thrown as DataBackendUnavailableError).causeKey).toBe('guild-fenced');
  });

  it('working-set guild, acceptance closed: throws database-backlog', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await routeOf('working-set guild', JSON.stringify({ n: 1 }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    r.store!.mode = 'unavailable';
    expect(dm.saveData('doc.json', r.options, { n: 2 })).toBe(true);
    await vi.advanceTimersByTimeAsync(301_000);
    // The write that crosses the window is accepted and closes acceptance, unless a failed retry closed it first.
    try { dm.saveData('crossing.json', r.options, { n: 3 }); } catch { /* closed already */ }
    expect(r.ws!.getBackendHealth().state).toBe('refusing');
    let thrown: unknown;
    try { update(r, d => ({ n: d.n + 1 })); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(DataBackendUnavailableError);
    expect((thrown as DataBackendUnavailableError).causeKey).toBe('database-backlog');
  });
});

describe('what fn may do', () => {
  it.each(ROUTES.flatMap(name => [
    [name, 'an Error'] as const,
    [name, 'a DataBackendUnavailableError'] as const,
  ]))('%s: %s thrown by fn reaches the caller as it is, and nothing is queued or recorded', async (name, kind) => {
    const r = await routeOf(name, JSON.stringify({ n: 1 }));
    const boom = kind === 'an Error' ? new Error('boom') : new DataBackendUnavailableError('guild-fenced');
    const mark = saveMark();
    const ledger = openLedger('console');
    let thrown: unknown;
    runInLedger(ledger, 'm', () => {
      try { update(r, () => { throw boom; }); } catch (error) { thrown = error; }
    });
    expect(thrown).toBe(boom);
    nothingQueued(r);
    expect(ledger.tickets()).toEqual([]);
    expect(ledger.refusals()).toEqual([]);
    const owed = pendingFor(r.scope, stampOf(mark)!);
    expect(owed.tickets).toEqual([]);
    expect(owed.refused).toEqual([]);
  });

  it.each(ROUTES.flatMap(name => [
    [name, 'a promise', (d: any) => Promise.resolve(d)] as const,
    [name, 'an async function', async (d: any) => d] as const,
    [name, 'an object with a then function', () => ({ then: () => {} })] as const,
    [name, 'undefined', () => undefined] as const,
  ]))('%s: fn returning %s throws a TypeError and writes nothing', async (name, _kind, fn) => {
    const r = await routeOf(name, JSON.stringify({ n: 1 }));
    expect(() => update(r, fn as any)).toThrow(TypeError);
    nothingQueued(r);
    expect(r.stored()).toBe(JSON.stringify({ n: 1 }));
  });

  it.each(ROUTES.flatMap(name => [
    [name, 'rejects after an await', async () => { await null; throw new Error('boom'); }] as const,
    [name, 'writes data before its first await', async (d: any) => { dm.saveGlobalData('nb1-async-inner.json', { x: 1 }); return d; }] as const,
  ]))('%s: an async fn that %s throws a TypeError, leaves no unhandled rejection, and logs the rejection', async (name, _kind, fn) => {
    const r = await routeOf(name, JSON.stringify({ n: 1 }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(() => update(r, fn as any)).toThrow(TypeError);
      await new Promise(resolve => { setTimeout(resolve, 20); });
      expect(unhandled).not.toHaveBeenCalled();
      expect(error.mock.calls.filter(c => String(c[0]).startsWith('[Data] An async update function'))).toHaveLength(1);
      nothingQueued(r);
      expect(r.stored()).toBe(JSON.stringify({ n: 1 }));
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it.each(ROUTES)('%s: a .jsonl document is never updated whole: a TypeError, and fn never runs', async name => {
    const r = await routeOf(name);
    const options = r.options;
    if (!r.ws) {
      const file = path.join(path.dirname(r.file), 'log.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{"line":1}\n');
    }
    const { fn } = spyFn();
    expect(() => dm.updateData('log.jsonl', options, {}, fn)).toThrow(TypeError);
    expect(fn).not.toHaveBeenCalled();
    if (r.ws) expect(r.ws.dirtyGuildIds()).not.toContain(r.guildId);
    else expect(fs.readFileSync(path.join(path.dirname(r.file), 'log.jsonl'), 'utf8')).toBe('{"line":1}\n');
  });

  const inner = {
    save: (r: Route) => dm.saveData('other.json', r.options, { x: 1 }),
    append: (r: Route) => dm.appendData('other.json', r.options, 'x\n'),
    delete: (r: Route) => dm.deleteData('doc.json', r.options),
    update: (r: Route) => dm.updateData('other.json', r.options, {}, d => d),
  };
  it.each(ROUTES.flatMap(name => (Object.keys(inner) as (keyof typeof inner)[]).map(verb => [name, verb] as const)))(
    '%s: a %s from inside fn throws a TypeError, and neither write happens, even when fn catches it',
    async (name, verb) => {
      const r = await routeOf(name, JSON.stringify({ n: 1 }));
      const otherFile = r.ws ? '' : path.join(path.dirname(r.file), 'other.json');
      expect(() => update(r, d => { inner[verb](r); return d; })).toThrow(TypeError);
      let innerError: unknown;
      expect(() => update(r, d => {
        try { inner[verb](r); } catch (error) { innerError = error; }
        return { n: d.n + 1 };
      })).toThrow(TypeError);
      expect(innerError).toBeInstanceOf(TypeError);
      nothingQueued(r);
      if (!r.ws) expect(getPending(otherFile)).toBeUndefined();
      expect(r.stored()).toBe(JSON.stringify({ n: 1 }));
    },
  );
});

describe('the answer of an update', () => {
  it.each(ROUTES)('%s: its ticket is confirmed once stored, and confirmSaved counts it', async name => {
    const r = await routeOf(name, JSON.stringify({ n: 1 }));
    const mark = saveMark();
    if (r.store) r.store.holding = true;
    const result = update(r, d => ({ n: d.n + 1 }));
    expect(result.outcome).toBe('saved');
    if (result.outcome !== 'saved') return;
    if (r.store) {
      expect(await dm.confirmSaved(r.scope, { since: mark, deadlineMs: 50 })).toBe('pending');
      r.store.holding = false;
      r.store.release();
    }
    expect(await dm.confirmWrite(result.ticket, 5000)).toBe('ok');
    expect(await dm.confirmSaved(r.scope, { since: mark })).toBe('ok');
  });

  it('each wrapper names the document its load and save pair name', async () => {
    setBackendKind('file');
    const g = freshGuild();
    const pairs: [() => dm.SaveTracked, () => unknown][] = [
      [() => dm.updateGuildData('w.json', g, { n: 0 }, d => ({ n: d.n + 1 }), 'wrapcat'), () => dm.loadGuildData('w.json', g, null, 'wrapcat')],
      [() => dm.updateGlobalData('w.json', { n: 0 }, d => ({ n: d.n + 2 }), 'wrapcat'), () => dm.loadGlobalData('w.json', null, 'wrapcat')],
      [() => dm.updateModuleData('w2.json', g, 'wrapmod', { n: 0 }, d => ({ n: d.n + 3 })), () => dm.loadModuleData('w2.json', g, 'wrapmod', null)],
      [() => dm.updateGlobalModuleData('w2.json', 'wrapmod', { n: 0 }, d => ({ n: d.n + 4 })), () => dm.loadGlobalModuleData('w2.json', 'wrapmod', null)],
    ];
    const answers = pairs.map(([write, read]) => [write().outcome, read()]);
    expect(answers).toEqual([['saved', { n: 1 }], ['saved', { n: 2 }], ['saved', { n: 3 }], ['saved', { n: 4 }]]);
  });
});

describe('handlers that interleave', () => {
  const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });
  const schedule = fc.array(fc.tuple(fc.nat(3), fc.nat(3)), { minLength: 2, maxLength: 6 });
  let files = 0;

  async function guildOn(name: 'file guild' | 'working-set guild'): Promise<string> {
    if (name === 'working-set guild') return (await routeOf(name)).guildId;
    setBackendKind('file');
    return freshGuild();
  }

  it.each(['file guild', 'working-set guild'] as const)('%s: the stored count equals the saved answers', async name => {
    await fc.assert(fc.asyncProperty(schedule, async steps => {
      const g = await guildOn(name);
      const f = `count${++files}.json`;
      const answers = await Promise.all(steps.map(async ([before, between]) => {
        await sleep(before);
        await sleep(between);
        return dm.updateModuleData(f, g, 'm', { n: 0 }, d => ({ n: d.n + 1 })).outcome;
      }));
      expect(dm.loadModuleData(f, g, 'm', { n: 0 }).n).toBe(answers.filter(a => a === 'saved').length);
    }), { numRuns: 20 });
  });

  it.each(['file guild', 'working-set guild'] as const)('%s: a load, an await and a save on the same schedule lose an increment', async name => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(fc.assert(fc.asyncProperty(schedule, async steps => {
      const g = await guildOn(name);
      const f = `lost${++files}.json`;
      const answers = await Promise.all(steps.map(async ([before, between]) => {
        await sleep(before);
        const d = dm.loadModuleData(f, g, 'm', { n: 0 });
        await sleep(between);
        return dm.saveModuleData(f, g, 'm', { n: d.n + 1 });
      }));
      expect(dm.loadModuleData(f, g, 'm', { n: 0 }).n).toBe(answers.filter(Boolean).length);
    }), { numRuns: 20 })).rejects.toThrow();
  });
});

// Both close the facade for the rest of this file's process, so they run last, in this order.
describe('a closed data layer', () => {
  it.each(ROUTES)('%s, the data layer refused: guild documents are refused not-ready and global ones saved', async name => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await routeOf(name, JSON.stringify({ n: 1 }));
    dm.closeGuildWrites();
    const { fn } = spyFn<{ n: number }>(d => ({ n: d.n + 1 }));
    const result = update(r, fn);
    if (name === 'file global') {
      await landed(r, result);
      expect(JSON.parse(r.stored()!)).toEqual({ n: 2 });
    } else {
      expect(result).toEqual({ outcome: 'refused', cause: 'not-ready' });
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it.each(ROUTES)('%s, past the exit drain: throws node-stopping before fn runs', async name => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await routeOf(name, JSON.stringify({ n: 1 }));
    await dm.drainForExit(500);
    const { fn } = spyFn();
    let thrown: unknown;
    try { update(r, fn); } catch (error) { thrown = error; }
    expect((thrown as DataBackendUnavailableError).causeKey).toBe('node-stopping');
    expect(fn).not.toHaveBeenCalled();
  });
});
