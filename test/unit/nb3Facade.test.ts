import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB3 decision 8: the data browser's `${module}/${id}` key reaches the module's own document, on a working set and
// on files.

const ws = vi.hoisted(() => {
  const docs = new Map<string, string>();
  const keyOf = (g: string, m: string, f: string) => `${g}|${m}|${f}`;
  return {
    active: false,
    docs,
    calls: [] as string[],
    fake: {
      read: (g: string, m: string, f: string) => {
        ws.calls.push(`read ${m} ${f}`);
        const doc = docs.get(keyOf(g, m, f));
        return { status: 'ready', value: doc === undefined ? undefined : JSON.parse(doc) };
      },
      save: (g: string, m: string, f: string, content: string) => {
        ws.calls.push(`save ${m} ${f}`);
        docs.set(keyOf(g, m, f), content);
        return 'accepted';
      },
      exists: (g: string, m: string, f: string) => docs.has(keyOf(g, m, f)),
      delete: (g: string, m: string, f: string) => (docs.delete(keyOf(g, m, f)) ? 'accepted' : 'absent'),
      readDocRaw: (g: string, m: string, f: string) => docs.get(keyOf(g, m, f)) ?? null,
      ticketFor: (g: string) => ({ kind: 'ws', manager: { confirm: async () => 'ok' }, set: { landedSeq: 1 }, guildId: g, seq: 1 }),
      unlandedDeleteTicket: () => undefined,
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/workingSet')>();
  return { ...real, getWorkingSet: () => (ws.active ? ws.fake : null) as any };
});
import { dataExists, loadData, readGuildDocRaw, saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { flushAll } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { setBackendKind } from '../helpers/backendKind';

const G = '123456789012345678';
const root = process.env.DATA_DIR as string;

beforeEach(() => {
  ws.docs.clear();
  ws.calls.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  ws.active = false;
  fs.rmSync(path.join(root, G), { recursive: true, force: true });
});

describe('the data browser key on a working set (postgres)', () => {
  beforeEach(() => {
    ws.active = true;
    setBackendKind('postgres');
  });

  it("reads the module's own document through ('', 'module/id')", () => {
    expect(saveData('id.json', { guildId: G, category: 'mod' }, { v: 1 })).toBe(true);
    expect(loadData('mod/id.json', { guildId: G }, null)).toEqual({ v: 1 });
    expect(ws.calls).toEqual(['save mod id.json', 'read mod id.json']);
    expect(dataExists('mod/id.json', { guildId: G })).toBe(true);
    expect(readGuildDocRaw(G, '', 'mod/id.json')).toContain('"v": 1');
  });

  it("saves the module's own document through ('', 'module/id')", () => {
    expect(saveData('mod/id.json', { guildId: G }, { v: 2 })).toBe(true);
    expect(ws.calls).toEqual(['save mod id.json']);
    expect(loadData('id.json', { guildId: G, category: 'mod' }, null)).toEqual({ v: 2 });
  });

  it('refuses a key that leaves the guild folder, and writes nothing', () => {
    expect(saveData('../other/id.json', { guildId: G }, { v: 3 })).toBe(false);
    expect(saveData('mod/', { guildId: G }, { v: 3 })).toBe(false);
    expect(ws.docs.size).toBe(0);
  });
});

describe('the data browser key on files', () => {
  beforeEach(() => setBackendKind('file'));

  it("reads and saves the module's own file through ('', 'module/id')", async () => {
    expect(saveData('mod/id.json', { guildId: G }, { v: 4 })).toBe(true);
    await flushAll();
    expect(JSON.parse(fs.readFileSync(path.join(root, G, 'mod', 'id.json'), 'utf-8'))).toEqual({ v: 4 });
    expect(loadData('id.json', { guildId: G, category: 'mod' }, null)).toEqual({ v: 4 });
  });

  it('refuses a key that leaves the guild folder, and writes nothing', async () => {
    expect(saveData('../../escape.json', { guildId: G, category: 'mod' }, { v: 5 })).toBe(false);
    await flushAll();
    expect(fs.existsSync(path.join(root, G, 'escape.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'escape.json'))).toBe(false);
  });
});
