import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { getPending, queuedFilePaths, setGuildViewCache } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';
import { tokenFor } from '../helpers/fakeStore';
import { ServerStore } from '../helpers/serverStore';
import { linuxNotDir } from '../helpers/linuxNotDir';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

// NB12 item 2 (wip-redesign/sheets/NB12.md): the facade refuses at the write what the stores cannot keep, with a
// reason, on the file route and on the working-set route alike.

let guilds = 9_100_000_000;
const freshGuild = () => String(++guilds);

// 'file' is the web UI process (a fresh path read per write), 'file-cached' the bot process (shardBoot turns the view cache on).
type RouteName = 'file' | 'file-cached' | 'working-set';
const ROUTES: RouteName[] = ['file', 'file-cached', 'working-set'];

interface Route {
  name: RouteName;
  guildId: string;
  store: ServerStore | null;
  ws: WorkingSetManager | null;
}

async function routeOf(name: RouteName, rows: Record<string, string> = {}): Promise<Route> {
  const guildId = freshGuild();
  if (name === 'working-set') {
    setBackendKind('postgres');
    const store = new ServerStore();
    for (const [key, doc] of Object.entries(rows)) {
      const cut = key.indexOf('/');
      store.docs.set(`${guildId}|${key.slice(0, cut)}/${key.slice(cut + 1)}`, doc);
    }
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    return { name, guildId, store, ws };
  }
  setBackendKind('file');
  setGuildViewCache(name === 'file-cached');
  for (const [key, doc] of Object.entries(rows)) {
    const file = dataPath(guildId, ...key.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, doc);
  }
  return { name, guildId, store: null, ws: null };
}

const opts = (r: Route, category?: string): dm.DataOptions => (category === undefined ? { guildId: r.guildId } : { guildId: r.guildId, category });
const guildDir = (r: Route) => dataPath(r.guildId);
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? [path.join(dir, e.name), ...walk(path.join(dir, e.name))] : [path.join(dir, e.name)]);
}

let errors: string[];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});
afterEach(async () => {
  await dm.flushAll();
  setGuildViewCache(false);
  vi.restoreAllMocks();
});

/** Nothing of the guild is queued: no file op under its folder, and on the set route no dirty key and no append buffer. */
function nothingQueued(r: Route): void {
  expect(queuedFilePaths().filter(p => p.startsWith(guildDir(r)))).toEqual([]);
  if (r.ws) {
    const set = (r.ws as any).sets.get(r.guildId);
    expect(set.dirtyKeys.size).toBe(0);
    expect([...set.appendBuf.values()].filter((b: { chunk: string }) => b.chunk.length > 0)).toEqual([]);
  }
}

type Input = { name: string; entry: 'save' | 'saveModule' | 'update' | 'append'; key: string; value: unknown; reason: RegExp; category?: string };
// m/, five 200-byte parts and an 18-byte last part: 1025 bytes joined.
const KEY_1025 = ['m', ...Array.from({ length: 5 }, (_, i) => String(i).repeat(200)), `${'z'.repeat(13)}.json`].join('/');
const INPUTS: Input[] = [
  { name: 'no JSON form', entry: 'save', key: 'm/a.json', value: undefined, reason: /no JSON form/ },
  { name: 'a function', entry: 'saveModule', key: 'a.json', value: () => 1, reason: /no JSON form/ },
  { name: 'stringify throws', entry: 'save', key: 'm/a.json', value: { n: 1n }, reason: /cannot be written as JSON/ },
  { name: 'update fn returns a function', entry: 'update', key: 'm/a.json', value: () => 1, reason: /no JSON form/ },
  { name: 'a line with U+0000', entry: 'append', key: 'm/log.jsonl', value: 'a\u0000b\n', reason: /U\+0000 at character 1/ },
  { name: 'a lone surrogate', entry: 'append', key: 'm/log.jsonl', value: 'a\uD83D\n', reason: /unpaired surrogate \(U\+D83D\)/ },
  { name: 'a non-string line', entry: 'append', key: 'm/log.jsonl', value: { a: 1 }, reason: /the line is not a string/ },
  { name: 'a .tmp folder', entry: 'save', key: 'cache.tmp/x.json', value: 1, reason: /\.tmp/ },
  { name: 'a .tmp file on update', entry: 'update', key: 'm/x.tmp', value: 1, reason: /\.tmp/ },
  { name: 'a reserved character', entry: 'save', key: 'm/a:b.json', value: 1, reason: /":"/ },
  { name: 'a device name', entry: 'save', key: 'm/con.json', value: 1, reason: /device name CON/ },
  { name: 'a 201-byte part', entry: 'save', key: `m/${'a'.repeat(201)}`, value: 1, reason: /201 bytes/ },
  { name: 'the retire note', entry: 'save', key: '.Graveyard.json', value: 1, reason: /\.Graveyard\.json/ },
  { name: 'U+0000 in a key', entry: 'save', key: 'm/a\u0000.json', value: 1, reason: /U\+0000/ },
  { name: 'a key that leaves the folder', entry: 'save', key: '../x.json', value: 1, reason: /leaves the guild folder/ },
  { name: 'a 1025-byte key', entry: 'save', key: KEY_1025, value: 1, reason: /the key is 1025 bytes; a key holds at most 1024/ },
  { name: 'a part ending in "."', entry: 'save', key: 'm/a.', value: 1, reason: /ends in "\."/ },
  { name: 'a part ending in a space', entry: 'save', key: 'm/a ', value: 1, reason: /ends in a space/ },
  { name: 'U+0001 in a key', entry: 'save', key: 'm/a\u0001.json', value: 1, reason: /control character U\+0001/ },
  { name: 'U+001F in a key', entry: 'append', key: 'm/a\u001F.jsonl', value: 'x\n', reason: /control character U\+001F/ },
  { name: 'a lone surrogate in a key', entry: 'save', key: 'm/a\uD800.json', value: 1, reason: /unpaired surrogate/ },
  { name: 'U+0000 in the module', entry: 'saveModule', category: 'm\u0000', key: 'a.json', value: 1, reason: /control character U\+0000/ },
  { name: 'a .tmp file at the root', entry: 'save', key: 'x.tmp', value: 1, reason: /ends in "\.tmp"/ },
];

function write(r: Route, input: Input, fnCalls: { n: number }): dm.SaveTracked | dm.AppendTracked {
  const cut = input.key.lastIndexOf('/');
  switch (input.entry) {
    case 'save':
      return dm.saveDataTracked(input.key, opts(r), input.value);
    case 'saveModule':
      return dm.saveDataTracked(input.key, opts(r, input.category ?? 'm'), input.value);
    case 'update':
      return dm.updateData(input.key, opts(r), {}, () => { fnCalls.n += 1; return input.value as never; });
    case 'append':
      return dm.appendDataTracked(cut < 0 ? input.key : input.key, opts(r), input.value as string);
  }
}

describe.each(ROUTES)('a write the stores cannot keep, %s route', routeName => {
  it('the 1025-byte key is 1025 bytes and each of its parts at most 200', () => {
    expect(Buffer.byteLength(KEY_1025, 'utf8')).toBe(1025);
    expect(Math.max(...KEY_1025.split('/').map(p => Buffer.byteLength(p, 'utf8')))).toBe(200);
  });

  it('a save of .jsonl and an append to .json throw a TypeError (NB13 decision 12) and queue nothing', async () => {
    const r = await routeOf(routeName);
    expect(() => dm.saveDataTracked('m/log.jsonl', opts(r), 1)).toThrow(new TypeError('[Data] m/log.jsonl is an append-only file; write it with appendData. The value was not saved'));
    expect(() => dm.appendDataTracked('m/log.json', opts(r), 'x\n')).toThrow(new TypeError('[Data] m/log.json does not end in .jsonl; appendData writes only .jsonl files. The line was not saved'));
    nothingQueued(r);
    await new Promise(resolve => setImmediate(resolve));
    expect(fs.existsSync(guildDir(r))).toBe(false);
    if (r.ws) {
      expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
      expect([...r.store!.docs.keys(), ...r.store!.streams.keys()].filter(k => k.startsWith(`${r.guildId}|`))).toEqual([]);
    }
  });

  it.each(INPUTS)('$name: refused unstorable with the reason, nothing queued, the ledger holds it', async input => {
    const r = await routeOf(routeName);
    const ledger = openLedger('console');
    const calls = { n: 0 };
    const answer = runInLedger(ledger, 'mod', () => write(r, input, calls));
    expect(answer.outcome).toBe('refused');
    expect(answer.outcome === 'refused' && answer.cause).toBe('unstorable');
    expect(answer.outcome === 'refused' && answer.reason).toMatch(input.reason);
    nothingQueued(r);
    await new Promise(resolve => setImmediate(resolve));
    expect(fs.existsSync(guildDir(r))).toBe(false);
    if (r.ws) {
      expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
      expect([...r.store!.docs.keys(), ...r.store!.streams.keys()].filter(k => k.startsWith(`${r.guildId}|`))).toEqual([]);
      expect(r.ws.heldGuilds()).toEqual([]);
    }
    expect(ledger.refusals()).toEqual([{ cause: 'unstorable', modules: ['mod'] }]);
    expect(ledger.refusedDocs()).toHaveLength(1);
    expect(ledger.refusedDocs()[0]).toMatchObject({ cause: 'unstorable' });
    expect(ledger.refusedDocs()[0].reason).toMatch(input.reason);
    const refusal = errors.filter(e => e.startsWith('[Data] Refused a write of'));
    expect(refusal).toHaveLength(1);
    const category = input.entry === 'saveModule' ? input.category ?? 'm' : '';
    expect(refusal[0]).toBe(`[Data] Refused a write of guild:${r.guildId}:${category}/${input.key}: ${answer.outcome === 'refused' ? answer.reason : ''}; nothing was saved`);
    if (input.entry === 'update' && input.name.includes('.tmp')) expect(calls.n).toBe(0);
    if (input.entry === 'update' && input.name.includes('function')) expect(calls.n).toBe(1);
  });
});

describe.each(ROUTES)('placement, %s route', routeName => {
  it.each([
    ['m/a/x.json', 'm/a'],
    ['m/a', 'm/a/x.json'],
    ['m/a.json', 'm/A.json'],
    ['m/a.json', 'M/b.json'],
    ['words/kir.json', 'words/k\u0131r.json'],
  ])('a save of %j, then of %j: the second is refused unstorable', async (first, second) => {
    const r = await routeOf(routeName);
    expect(dm.saveDataTracked(first, opts(r), { v: 1 }).outcome).toBe('saved');
    const answer = dm.saveDataTracked(second, opts(r), { v: 2 });
    expect(answer).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
    expect(getPending(dataPath(r.guildId, ...second.split('/')))).toBeUndefined();
    if (r.ws) expect([...(r.ws as any).sets.get(r.guildId).dirtyKeys].filter((k: string) => k === second || k === `/${second}`)).toEqual([]);
    await dm.flushAll();
    expect(dm.loadData(first, opts(r), null)).toEqual({ v: 1 });
    if (r.ws) {
      expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
      expect([...r.store!.docs.keys()].filter(k => k.startsWith(`${r.guildId}|`))).toEqual([`${r.guildId}|${first}`]);
    } else {
      expect(fs.existsSync(dataPath(r.guildId, ...first.split('/')))).toBe(true);
    }
  });

  it.each([
    ['m/a.jsonl/x.jsonl', 'm/a.jsonl'],
    ['m/a.jsonl', 'm/a.jsonl/x.jsonl'],
  ])('an append to %j, then to %j: the second is refused unstorable and queues nothing', async (first, second) => {
    const r = await routeOf(routeName);
    expect(dm.appendDataTracked(first, opts(r), 'one\n').outcome).toBe('appended');
    expect(dm.appendDataTracked(second, opts(r), 'two\n')).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
    expect(getPending(dataPath(r.guildId, ...second.split('/')))).toBeUndefined();
    await dm.flushAll();
    if (r.ws) {
      expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
      expect([...r.store!.streams.entries()].filter(([k]) => k.startsWith(`${r.guildId}|`))).toEqual([[`${r.guildId}|${first}`, 'one\n']]);
    } else {
      expect(fs.readFileSync(dataPath(r.guildId, ...first.split('/')), 'utf8')).toBe('one\n');
    }
  });

  it('the same with the first write landed', async () => {
    const r = await routeOf(routeName);
    expect(dm.saveDataTracked('m/a/x.json', opts(r), 1).outcome).toBe('saved');
    await dm.flushAll();
    if (r.ws) expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
    expect(dm.saveDataTracked('m/a', opts(r), 2)).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
    expect(dm.appendDataTracked('m/a/x.json/l.jsonl', opts(r), 'x\n')).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
    nothingQueued(r);
    const now = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(now + 31_000);
    expect(dm.saveDataTracked('m/b.json', opts(r), 3).outcome).toBe('saved');
    await dm.flushAll();
    if (r.ws) {
      expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
      expect(r.store!.docs.get(`${r.guildId}|m/b.json`)).toBe('3');
    } else {
      expect(fs.readFileSync(dataPath(r.guildId, 'm', 'b.json'), 'utf8')).toBe('3');
    }
  });

  it.each([
    ['save', 'm/a', 'm/a/x.json'],
    ['append', 'm/a.jsonl', 'm/a.jsonl/x.jsonl'],
  ] as const)('with the first %s landed, %j then %j: the second is refused and the first keeps its bytes', async (entry, first, second) => {
    const r = await routeOf(routeName);
    const put = (key: string, value: string) => (entry === 'save' ? dm.saveDataTracked(key, opts(r), value) : dm.appendDataTracked(key, opts(r), value));
    expect(put(first, 'one\n').outcome).toBe(entry === 'save' ? 'saved' : 'appended');
    await dm.flushAll();
    if (r.ws) expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
    expect(put(second, 'two\n')).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
    expect(getPending(dataPath(r.guildId, ...second.split('/')))).toBeUndefined();
    nothingQueued(r);
    await dm.flushAll();
    const firstText = entry === 'save' ? JSON.stringify('one\n', null, 2) : 'one\n';
    if (r.ws) {
      expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
      const rows = entry === 'save' ? r.store!.docs : r.store!.streams;
      expect([...rows.entries()].filter(([k]) => k.startsWith(`${r.guildId}|`))).toEqual([[`${r.guildId}|${first}`, firstText]]);
    } else {
      expect(fs.statSync(dataPath(r.guildId, ...first.split('/'))).isFile()).toBe(true);
      expect(fs.readFileSync(dataPath(r.guildId, ...first.split('/')), 'utf8')).toBe(firstText);
    }
  });

  it('a folder whose last key was deleted takes a file of its name', async () => {
    const r = await routeOf(routeName);
    expect(dm.saveDataTracked('m/a/x.json', opts(r), 1).outcome).toBe('saved');
    await dm.flushAll();
    expect(dm.deleteDataTracked('m/a/x.json', opts(r)).outcome).toBe('deleted');
    await dm.flushAll();
    if (r.ws) await r.ws.flushGuildNow(r.guildId, 1000);
    expect(dm.saveDataTracked('m/a', opts(r), 2).outcome).toBe('saved');
    await dm.flushAll();
    if (r.ws) {
      expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
      expect([...r.store!.docs.entries()].filter(([k]) => k.startsWith(`${r.guildId}|`))).toEqual([[`${r.guildId}|m/a`, '2']]);
    } else {
      expect(fs.statSync(dataPath(r.guildId, 'm', 'a')).isFile()).toBe(true);
      expect(fs.readFileSync(dataPath(r.guildId, 'm', 'a'), 'utf8')).toBe('2');
    }
  });

  it('a folder spelling whose last key was deleted no longer blocks another spelling: Tags/x.json, then tags/y.json', async () => {
    const r = await routeOf(routeName);
    expect(dm.saveDataTracked('Tags/x.json', opts(r), 1).outcome).toBe('saved');
    await dm.flushAll();
    if (r.ws) expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
    expect(dm.deleteDataTracked('Tags/x.json', opts(r)).outcome).toBe('deleted');
    await dm.flushAll();
    if (r.ws) expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
    expect(dm.saveDataTracked('tags/y.json', opts(r), 2).outcome).toBe('saved');
    await dm.flushAll();
    if (r.ws) {
      expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
      expect([...r.store!.docs.entries()].filter(([k]) => k.startsWith(`${r.guildId}|`))).toEqual([[`${r.guildId}|tags/y.json`, '2']]);
    } else {
      expect(fs.readdirSync(guildDir(r))).toEqual(['tags']);
      expect(fs.readdirSync(dataPath(r.guildId, 'tags'))).toEqual(['y.json']);
      expect(fs.readFileSync(dataPath(r.guildId, 'tags', 'y.json'), 'utf8')).toBe('2');
    }
  });

  it('a delete of a folder name answers absent and queues nothing', async () => {
    const r = await routeOf(routeName, { 'm/a/x.json': '1' });
    expect(dm.deleteDataTracked('m/a', opts(r)).outcome).toBe('absent');
    nothingQueued(r);
    expect(dm.loadData('m/a/x.json', opts(r), null)).toBe(1);
    await dm.flushAll();
    if (r.ws) {
      expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
      expect([...r.store!.docs.entries()].filter(([k]) => k.startsWith(`${r.guildId}|`))).toEqual([[`${r.guildId}|m/a/x.json`, '1']]);
    } else {
      expect(fs.readFileSync(dataPath(r.guildId, 'm', 'a', 'x.json'), 'utf8')).toBe('1');
    }
  });

  it('a stored key a rule refuses is deleted as stored', async () => {
    const r = await routeOf(routeName, { 'cache.tmp/x.json': '1' });
    expect(dm.loadData('cache.tmp/x.json', opts(r), null)).toBe(1);
    if (r.ws) expect(r.store!.docs.get(`${r.guildId}|cache.tmp/x.json`)).toBe('1');
    expect(dm.deleteDataTracked('cache.tmp/x.json', opts(r)).outcome).toBe('deleted');
    await dm.flushAll();
    if (r.ws) {
      expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
      expect(r.store!.docs.has(`${r.guildId}|cache.tmp/x.json`)).toBe(false);
      expect(r.ws.heldGuilds()).toEqual([]);
    } else {
      expect(fs.existsSync(dataPath(r.guildId, 'cache.tmp', 'x.json'))).toBe(false);
    }
  });

  it('JSON strings holding U+0000 and lone surrogates are saved and read back equal (a guard)', async () => {
    const r = await routeOf(routeName);
    const value = { a: '\u0000', b: '\uD800x', c: 'z\uDC00' };
    expect(dm.saveDataTracked('m/s.json', opts(r), value).outcome).toBe('saved');
    await dm.flushAll();
    if (r.ws) {
      expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
      const again = initWorkingSet(r.store!);
      expect(await again.hydrate(r.guildId, tokenFor())).toBe('ready');
    }
    expect(dm.loadData('m/s.json', opts(r), null)).toEqual(value);
  });

  it('a 4 MiB document is saved, one byte more is refused', async () => {
    const r = await routeOf(routeName);
    const cap = 4 * 1024 * 1024;
    const exact = 'a'.repeat(cap - 2);
    expect(JSON.stringify(exact, null, 2).length).toBe(cap);
    expect(dm.saveDataTracked('m/big.json', opts(r), exact).outcome).toBe('saved');
    expect(dm.saveDataTracked('m/big2.json', opts(r), `${exact}a`)).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
    const other = await routeOf(routeName);
    expect(dm.saveDataTracked('m/x.json', opts(other), 1).outcome).toBe('saved');
    expect(dm.saveData('nb12cap.json', { scope: 'global', category: 'nb12' }, 1)).toBe(true);
    const global: dm.DataOptions = { scope: 'global', category: 'nb12' };
    const globalFile = dataPath('global', 'nb12', `cap-${routeName}.json`);
    expect(dm.saveDataTracked(`cap-${routeName}.json`, global, exact).outcome).toBe('saved');
    const over = dm.saveDataTracked(`cap-${routeName}.json`, global, `${exact}a`);
    expect(over).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
    expect(over.outcome === 'refused' && over.reason).toMatch(/one write holds at most 4 MiB/);
    await dm.flushAll();
    expect(fs.statSync(globalFile).size).toBe(cap);
    expect(fs.readFileSync(globalFile, 'utf8')).toBe(JSON.stringify(exact, null, 2));
  });
});

describe('the module-root key in path form, working-set route', () => {
  it("a save of ('', 'm') then ('m', 'x.json') is refused", async () => {
    const r = await routeOf('working-set');
    expect(dm.saveDataTracked('m', opts(r), 1).outcome).toBe('saved');
    expect(dm.saveDataTracked('x.json', opts(r, 'm'), 2)).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
  });
});

describe('a value with no JSON form leaves the stores working', () => {
  it('file route: the next guild save lands', async () => {
    const a = await routeOf('file');
    const b = await routeOf('file');
    dm.saveData('m/a.json', opts(a), undefined);
    expect(dm.saveDataTracked('m/b.json', opts(b), {}).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.existsSync(dataPath(b.guildId, 'm', 'b.json'))).toBe(true);
  });

  it('working-set route: the next save lands and nothing rejects unhandled', async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => { rejections.push(e); };
    process.on('unhandledRejection', onRejection);
    try {
      const r = await routeOf('working-set');
      const other = String(++guilds);
      expect(await r.ws!.hydrate(other, tokenFor())).toBe('ready');
      dm.saveData('m/a.json', opts(r), undefined);
      expect(dm.saveDataTracked('m/b.json', { guildId: other }, {}).outcome).toBe('saved');
      await new Promise(resolve => setTimeout(resolve, 700));
      expect(await r.ws!.flushGuildNow(other, 1000)).toBe('ok');
      expect(await r.ws!.flushGuildNow(r.guildId, 1000)).toBe('ok');
      expect(r.ws!.heldGuilds().map(h => h.guildId)).not.toContain(r.guildId);
      expect(r.store!.docs.get(`${other}|m/b.json`)).toBe('{}');
      expect([...r.store!.docs.keys()].filter(k => k.startsWith(`${r.guildId}|`))).toEqual([]);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('appends on the working-set route', () => {
  it('a line holding U+0000 leaves the guild writable', async () => {
    const r = await routeOf('working-set');
    expect(dm.appendDataTracked('m/log.jsonl', opts(r), 'a\u0000\n').outcome).toBe('refused');
    expect(dm.appendDataTracked('m/log.jsonl', opts(r), 'ok\n').outcome).toBe('appended');
    expect(dm.saveDataTracked('m/s.json', opts(r), 1).outcome).toBe('saved');
    expect(await r.ws!.flushGuildNow(r.guildId, 1000)).toBe('ok');
    expect(r.ws!.heldGuilds()).toEqual([]);
  });

  it('a non-string line behind an earlier line leaves the earlier line alone in the chunk', async () => {
    const r = await routeOf('working-set');
    expect(dm.appendDataTracked('m/log.jsonl', opts(r), 'first\n').outcome).toBe('appended');
    expect(dm.appendDataTracked('m/log.jsonl', opts(r), { a: 1 } as never).outcome).toBe('refused');
    expect(await r.ws!.flushGuildNow(r.guildId, 1000)).toBe('ok');
    expect(r.store!.streams.get(`${r.guildId}|m/log.jsonl`)).toBe('first\n');
  });
});

describe('queued deletes on the file route', () => {
  it('a save of a folder name while its file delete is queued answers io, then saves', async () => {
    const r = await routeOf('file', { 'm/a/x.json': '1' });
    expect(dm.deleteDataTracked('m/a/x.json', opts(r)).outcome).toBe('deleted');
    const answer = dm.saveDataTracked('m/a', opts(r), 2);
    expect(answer).toMatchObject({ outcome: 'refused', cause: 'io' });
    expect(answer.outcome === 'refused' && answer.reason).toBe('a delete of m/a/x.json is still being written');
    expect(getPending(dataPath(r.guildId, 'm', 'a'))).toBeUndefined();
    await dm.flushAll();
    expect(fs.existsSync(dataPath(r.guildId, 'm', 'a'))).toBe(false);
    expect(dm.saveDataTracked('m/a', opts(r), 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.statSync(dataPath(r.guildId, 'm', 'a')).isFile()).toBe(true);
  });

  it('a delete of a sibling or of the same path is no obstacle', async () => {
    const r = await routeOf('file', { 'm/a.json': '1', 'm/b.json': '2' });
    expect(dm.deleteDataTracked('m/a.json', opts(r)).outcome).toBe('deleted');
    expect(dm.saveDataTracked('m/c.json', opts(r), 3).outcome).toBe('saved');
    expect(dm.deleteDataTracked('m/b.json', opts(r)).outcome).toBe('deleted');
    expect(dm.saveDataTracked('m/b.json', opts(r), 4).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.readFileSync(dataPath(r.guildId, 'm', 'b.json'), 'utf8')).toBe('4');
  });

  it('an empty folder left on disk is removed by the next write of its name', async () => {
    const r = await routeOf('file');
    fs.mkdirSync(dataPath(r.guildId, 'm', 'a'), { recursive: true });
    expect(dm.saveDataTracked('m/a', opts(r), 1).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.statSync(dataPath(r.guildId, 'm', 'a')).isFile()).toBe(true);
  });
});

describe.each(ROUTES)('updateData of a key a folder holds, %s route (NB12-INV3-R4-2)', routeName => {
  it("with 'm/a/x.json' stored, updateData of 'm/a' answers unstorable with the reason and m/a/x.json keeps its bytes", async () => {
    const r = await routeOf(routeName, { 'm/a/x.json': '{"x":1}' });
    const answer = dm.updateData('m/a', opts(r), {}, current => ({ ...current, v: 2 }));
    expect(answer).toEqual({ outcome: 'refused', cause: 'unstorable', reason: 'm/a names a folder that holds other keys' });
    nothingQueued(r);
    await dm.flushAll();
    if (r.ws) {
      expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
      expect([...r.store!.docs.entries()].filter(([k]) => k.startsWith(`${r.guildId}|`))).toEqual([[`${r.guildId}|m/a/x.json`, '{"x":1}']]);
    } else {
      expect(fs.readdirSync(dataPath(r.guildId, 'm', 'a'))).toEqual(['x.json']);
      expect(fs.readFileSync(dataPath(r.guildId, 'm', 'a', 'x.json'), 'utf8')).toBe('{"x":1}');
    }
  });

  it("with an empty folder 'm/a' (its last key deleted on the set route), updateData of 'm/a' answers saved and lands as a file", async () => {
    const r = await routeOf(routeName);
    if (r.ws) {
      expect(dm.saveDataTracked('m/a/x.json', opts(r), 1).outcome).toBe('saved');
      expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
      expect(dm.deleteDataTracked('m/a/x.json', opts(r)).outcome).toBe('deleted');
      expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
    } else {
      fs.mkdirSync(dataPath(r.guildId, 'm', 'a'), { recursive: true });
    }
    const seen: unknown[] = [];
    const answer = dm.updateData('m/a', opts(r), { d: 0 }, current => { seen.push(current); return { ...current, v: 2 }; });
    expect(answer.outcome).toBe('saved');
    expect(seen).toEqual([{ d: 0 }]);
    await dm.flushAll();
    const text = JSON.stringify({ d: 0, v: 2 }, null, 2);
    if (r.ws) {
      expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
      expect([...r.store!.docs.entries()].filter(([k]) => k.startsWith(`${r.guildId}|`))).toEqual([[`${r.guildId}|m/a`, text]]);
    } else {
      expect(fs.statSync(dataPath(r.guildId, 'm', 'a')).isFile()).toBe(true);
      expect(fs.readFileSync(dataPath(r.guildId, 'm', 'a'), 'utf8')).toBe(text);
    }
  });
});

describe('the Linux ENOTDIR helper', () => {
  it('answers a read through a file ENOTDIR, a read of a missing file ENOENT, and lifts with restoreAllMocks', async () => {
    const r = await routeOf('file', { 'm/a': '1' });
    linuxNotDir(dataPath());
    expect(() => fs.readFileSync(dataPath(r.guildId, 'm', 'a', 'x.json'))).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
    expect(() => fs.readFileSync(dataPath(r.guildId, 'm', 'b.json'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(fs.readFileSync(dataPath(r.guildId, 'm', 'a'), 'utf8')).toBe('1');
    vi.restoreAllMocks();
    expect(() => fs.readFileSync(dataPath(r.guildId, 'm', 'a', 'x.json'))).toThrow(expect.objectContaining({ code: process.platform === 'win32' ? 'ENOENT' : 'ENOTDIR' }));
  });
});

const NOT_DIR_CASES: Array<[RouteName, boolean]> = [['file', false], ['file', true], ['file-cached', false], ['file-cached', true], ['working-set', false]];

describe.each(NOT_DIR_CASES)('updateData through a key that is a file, %s route, Linux ENOTDIR %s (NB12-INV3-R5-2)', (routeName, linux) => {
  it.each([
    ['m/a', 'a/x.json', 'the folder m/a of it is a file'],
    ['m', 'a', 'the folder m of it is a file'],
  ])("with %j stored, updateData of %j in module m answers unstorable with the reason, fn runs once, and the key keeps its bytes", async (stored, filename, reason) => {
    const r = await routeOf(routeName, { [stored]: '{"keep":1}' });
    if (linux && !r.ws) linuxNotDir(dataPath());
    const calls = { n: 0 };
    const answer = dm.updateData(filename, opts(r, 'm'), {}, current => { calls.n += 1; return { ...current, v: 2 }; });
    expect(answer).toEqual({ outcome: 'refused', cause: 'unstorable', reason });
    expect(calls.n).toBe(1);
    nothingQueued(r);
    expect(errors.filter(e => e.startsWith('[DataManager] Error'))).toEqual([]);
    await dm.flushAll();
    if (r.ws) {
      expect(await r.ws.flushGuildNow(r.guildId, 1000)).toBe('ok');
      const row = stored.includes('/') ? stored : `/${stored}`;
      expect([...r.store!.docs.entries()].filter(([k]) => k.startsWith(`${r.guildId}|`))).toEqual([[`${r.guildId}|${row}`, '{"keep":1}']]);
    } else {
      expect(fs.statSync(dataPath(r.guildId, ...stored.split('/'))).isFile()).toBe(true);
      expect(fs.readFileSync(dataPath(r.guildId, ...stored.split('/')), 'utf8')).toBe('{"keep":1}');
      expect(walk(guildDir(r))).toEqual([dataPath(r.guildId, 'm'), ...(stored === 'm' ? [] : [dataPath(r.guildId, 'm', 'a')])]);
    }
  });

  it("a save of the same key answers the same refusal", async () => {
    const r = await routeOf(routeName, { 'm/a': '{"keep":1}' });
    if (linux && !r.ws) linuxNotDir(dataPath());
    expect(dm.saveDataTracked('a/x.json', opts(r, 'm'), { v: 2 })).toEqual({ outcome: 'refused', cause: 'unstorable', reason: 'the folder m/a of it is a file' });
  });
});
