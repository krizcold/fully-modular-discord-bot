import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { setGuildViewCache } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore, tokenFor } from '../helpers/fakeStore';

// NB12 item 8 (wip-redesign/sheets/NB12.md, decisions 14 and 21): data stored before a rule existed reads and deletes
// as stored, one line per guild names it at the hydrate (on files: per folder at the first write that reads it), and
// a write to it gets the rule's answer.

let guilds = 9_500_000_000;
let errors: string[];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});

async function storeOf(rows: Record<string, string>) {
  setBackendKind('postgres');
  const guildId = String(++guilds);
  const store = new FakeStore();
  for (const [key, doc] of Object.entries(rows)) {
    const cut = key.indexOf('/');
    store.docs.set(`${guildId}|${cut < 0 ? '' : key.slice(0, cut)}/${cut < 0 ? key : key.slice(cut + 1)}`, doc);
  }
  const ws = initWorkingSet(store);
  expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
  return { guildId, store, ws, options: { guildId } };
}

const guildLines = (guildId: string) => errors.filter(e => e.startsWith(`[Data] Guild ${guildId} holds`));

describe('the hydrate of stored data a rule refuses', () => {
  it('logs one line with the counts, serves the values and refuses writes the rules refuse', async () => {
    const big = JSON.stringify('x'.repeat(5 * 1024 * 1024));
    const { guildId, ws, options } = await storeOf({ 'cache.tmp/x.json': '{"a":1}', 'a:b.json': '{"b":2}', 'm/big.json': big });
    const lines = guildLines(guildId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^\\[Data\\] Guild ${guildId} holds 2 key\\(s\\) a write is refused for, 0 key\\(s\\) whose name collides with another stored key and 1 document\\(s\\) over 4 MiB \\(first: `));
    expect(lines[0]).toContain('cache.tmp/x.json: the part "cache.tmp" ends in ".tmp"');
    expect(lines[0]).toContain('a:b.json: the part "a:b.json" holds ":"');
    expect(lines[0]).toContain('m/big.json: it is over 4 MiB)');
    expect(lines[0]).toMatch(/tell the module's author$/);
    expect(dm.loadData('cache.tmp/x.json', options, null)).toEqual({ a: 1 });
    expect(dm.loadData('a:b.json', options, null)).toEqual({ b: 2 });
    expect(dm.saveDataTracked('cache.tmp/x.json', options, 1)).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
    expect(dm.saveDataTracked('m/big.json', options, 'x'.repeat(1024 * 1024)).outcome).toBe('saved');
    expect(dm.saveDataTracked('m/big.json', options, 'x'.repeat(5 * 1024 * 1024))).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
    expect(ws.listAllKeys(guildId)).toHaveLength(3);
  });

  it('a store of 5,000 keys a rule refuses logs one line', async () => {
    const rows: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) rows[`m/k${i}.tmp`] = '1';
    const { guildId } = await storeOf(rows);
    expect(guildLines(guildId)).toHaveLength(1);
    expect(guildLines(guildId)[0]).toContain('holds 5000 key(s) a write is refused for');
  });

  it('a stored pair differing in letter case: counted once, each takes writes under its own spelling', async () => {
    const { guildId, options, store, ws } = await storeOf({ 'users/Bob.json': '1', 'users/bob.json': '2' });
    expect(guildLines(guildId)[0]).toContain('0 key(s) a write is refused for, 1 key(s) whose name collides');
    expect(dm.saveDataTracked('users/Bob.json', options, 3).outcome).toBe('saved');
    expect(dm.saveDataTracked('users/bob.json', options, 4).outcome).toBe('saved');
    expect(await ws.flushGuildNow(guildId, 1000)).toBe('ok');
    expect(store.docs.get(`${guildId}|users/Bob.json`)).toBe('3');
    expect(store.docs.get(`${guildId}|users/bob.json`)).toBe('4');
    expect(dm.deleteDataTracked('users/bob.json', options).outcome).toBe('deleted');
    expect(dm.saveDataTracked('users/Bob.json', options, 5).outcome).toBe('saved');
    expect(await ws.flushGuildNow(guildId, 1000)).toBe('ok');
    expect(store.docs.get(`${guildId}|users/Bob.json`)).toBe('5');
    expect(store.docs.has(`${guildId}|users/bob.json`)).toBe(false);
    expect(dm.saveDataTracked('users/bob.json/x', options, 6)).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
  });
});

describe('the file route reads a folder it writes through', () => {
  it('logs one line for the folder, with no size clause, and none at the next write there', () => {
    setBackendKind('file');
    setGuildViewCache(true);
    try {
      const guildId = String(++guilds);
      fs.mkdirSync(dataPath(guildId, 'm'), { recursive: true });
      fs.writeFileSync(dataPath(guildId, 'm', 'big.json'), JSON.stringify('x'.repeat(6 * 1024 * 1024)));
      fs.writeFileSync(path.join(dataPath(guildId, 'm'), `${'a'.repeat(197)}.json`), '{}');
      expect(dm.saveDataTracked('new.json', { guildId, category: 'm' }, 1).outcome).toBe('saved');
      const lines = guildLines(guildId);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(new RegExp(`^\\[Data\\] Guild ${guildId} holds, in m, 1 key\\(s\\) a write is refused for and 0 key\\(s\\) whose name collides`));
      expect(lines[0]).not.toContain('over 4 MiB');
      expect(dm.saveDataTracked('new2.json', { guildId, category: 'm' }, 1).outcome).toBe('saved');
      expect(guildLines(guildId)).toHaveLength(1);
    } finally {
      setGuildViewCache(false);
    }
  });
});
