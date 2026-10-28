import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ noManager: false }));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => {
  const real = await orig<any>();
  return { ...real, getWorkingSet: () => (h.noManager ? null : real.getWorkingSet()) };
});

import { dataPath } from '../../src/utils/dataRoot';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { pendingFor, saveMark, stampOf } from '../../src/bot/internalSetup/utils/dataBackends/scopeRecord';
import { getMetricsCollector } from '../../src/bot/internalSetup/utils/metrics/metricsCollector';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore, tokenFor } from '../helpers/fakeStore';
import { freshGuild } from '../helpers/gateRig';

afterEach(() => {
  h.noManager = false;
  vi.restoreAllMocks();
});

let categories = 0;

async function wsGuild(rows: Record<string, string> = {}) {
  setBackendKind('postgres');
  const guildId = freshGuild();
  const store = new FakeStore();
  for (const [doc, text] of Object.entries(rows)) store.docs.set(`${guildId}|${doc}`, text);
  const ws = initWorkingSet(store);
  expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
  return { guildId, store, ws };
}

function fileGuild(text?: string) {
  setBackendKind('file');
  const guildId = freshGuild();
  const category = `nb1l5d${++categories}`;
  const file = dataPath(guildId, category, 'doc.json');
  if (text !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return { guildId, category, file, options: { guildId, category } as dm.DataOptions };
}

const messages = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(c => String(c[0]));

describe('what an update tells the operator and the caller', () => {
  it('a write inside fn and the update itself each throw a TypeError that says nothing was saved', () => {
    const r = fileGuild(JSON.stringify({ n: 1 }));
    let inner: unknown;
    let outer: unknown;
    try {
      dm.updateData('doc.json', r.options, {}, d => {
        try { dm.saveData('other.json', r.options, { x: 1 }); } catch (error) { inner = error; }
        return d;
      });
    } catch (error) { outer = error; }
    expect((inner as Error).message).toMatch(/inside an update function.*was saved/);
    expect((outer as Error).message).toMatch(/made a data write of its own.*not saved/);
  });

  it('fn returning a promise throws a TypeError that says to return the value without awaiting', () => {
    const r = fileGuild(JSON.stringify({ n: 1 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => dm.updateData('doc.json', r.options, {}, d => Promise.resolve(d) as any)).toThrow(/returned a promise.*without awaiting/);
  });

  it('a working-set guild outside the bot process is warned about by guild id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await wsGuild();
    h.noManager = true;
    expect(dm.updateData('doc.json', { guildId: r.guildId, category: 'm' }, {}, d => d)).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(messages(warn).some(m => m.includes(r.guildId) && m.includes('outside the bot process'))).toBe(true);
  });

  it('a working-set document written by appends is refused with an error naming the file', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await wsGuild();
    expect(dm.appendData('doc.json', { guildId: r.guildId, category: 'm' }, '{"a":1}\n')).toBe(true);
    expect(dm.updateData('doc.json', { guildId: r.guildId, category: 'm' }, {}, d => d)).toEqual({ outcome: 'refused', cause: 'io' });
    expect(messages(error).some(m => m.includes('doc.json') && m.includes('written by appends'))).toBe(true);
  });

  it('a file with appends still queued is refused with an error naming the file', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = fileGuild();
    expect(dm.appendData('doc.json', r.options, '{"a":1}\n')).toBe(true);
    expect(dm.updateData('doc.json', r.options, {}, d => d)).toEqual({ outcome: 'refused', cause: 'io' });
    expect(messages(error).some(m => m.includes('doc.json') && m.includes('appended lines are still queued'))).toBe(true);
  });

  it('a document that does not parse is refused with an error naming the file', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = fileGuild('{"n":');
    expect(dm.updateData('doc.json', r.options, {}, d => d)).toEqual({ outcome: 'refused', cause: 'io' });
    expect(messages(error).some(m => m.includes('doc.json') && m.includes('could not be read whole'))).toBe(true);
  });
});

describe('what an update reads and records', () => {
  it('a working-set guild document with no category is read from the empty category', async () => {
    const r = await wsGuild({ '/doc.json': JSON.stringify({ n: 4 }) });
    const seen: unknown[] = [];
    const result = dm.updateData('doc.json', { guildId: r.guildId }, { n: 0 }, d => { seen.push(d); return { n: d.n + 1 }; });
    expect(result.outcome).toBe('saved');
    expect(seen).toEqual([{ n: 4 }]);
  });

  it('the read is counted under the guild for a guild file and under no guild for a global one', () => {
    setBackendKind('file');
    const io = vi.spyOn(getMetricsCollector(), 'recordIO');
    const g = freshGuild();
    const category = `nb1l5d${++categories}`;
    expect(dm.updateData('doc.json', { guildId: g, category }, { n: 0 }, d => d).outcome).toBe('saved');
    expect(dm.updateData('doc.json', { scope: 'global', guildId: g, category }, { n: 0 }, d => d).outcome).toBe('saved');
    const reads = io.mock.calls.filter(c => c[0] === 'read');
    expect(reads).toEqual([['read', g, category], ['read', null, category]]);
  });

  it('a saved update marks an earlier refusal of the same document as rewritten', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = fileGuild('{"n":');
    const mark = saveMark();
    expect(dm.updateData('doc.json', r.options, { n: 0 }, d => d).outcome).toBe('refused');
    fs.writeFileSync(r.file, JSON.stringify({ n: 1 }));
    expect(dm.updateData('doc.json', r.options, { n: 0 }, d => ({ n: d.n + 1 })).outcome).toBe('saved');
    const refused = pendingFor(r.guildId, stampOf(mark)!).refused;
    expect(refused).toHaveLength(1);
    expect(refused[0].rewritten).toBe(true);
  });

  it('a value whose then is not a function is looked at once and saved', () => {
    const r = fileGuild(JSON.stringify({ n: 1 }));
    let looks = 0;
    const next = { n: 2 };
    Object.defineProperty(next, 'then', { enumerable: false, get: () => { looks += 1; return 5; } });
    expect(dm.updateData('doc.json', r.options, { n: 0 }, () => next).outcome).toBe('saved');
    expect(looks).toBe(1);
  });
});

// Closes guild writes for the rest of this file's process, so it runs last.
describe('a closed data layer', () => {
  it('a refused guild update is warned about as an update', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = fileGuild(JSON.stringify({ n: 1 }));
    dm.closeGuildWrites();
    expect(dm.updateData('doc.json', r.options, {}, d => d)).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(messages(warn).some(m => m.startsWith(`[Data] Update for guild ${r.guildId}`))).toBe(true);
  });
});
