import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => ({
  ...(await importOriginal<any>()),
  awaitGuildDataReady: async () => true,
}));

import { dropPendingForGuild, getPending, queuedFilePaths, setGuildViewCache } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { importBundle, namespaceHashOf, writeBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { DataBackendUnavailableError, initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore, tokenFor } from '../helpers/fakeStore';

// NB12 item 10 (wip-redesign/sheets/NB12.md, section 5): the cells of the state x exit table a unit can run.

let guilds = 9_600_000_000;
const freshGuild = () => String(++guilds);

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else out[child] = fs.readFileSync(path.join(dir, child), 'hex');
    }
  };
  if (fs.existsSync(dir)) walk('');
  return out;
}

/** A bundle file built by hand, as nb12Bundle.test.ts builds one. */
function bundleOf(guildId: string, records: Array<[string, Buffer]>): string {
  const parts: Buffer[] = [Buffer.from('DBEX1\n')];
  const files: { relPath: string; size: number; sha256: string }[] = [];
  for (const [relPath, bytes] of records) {
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const header = Buffer.from(JSON.stringify({ g: guildId, p: relPath, s: bytes.length, h: sha256 }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.length, 0);
    parts.push(len, header, bytes);
    files.push({ relPath, size: bytes.length, sha256 });
  }
  parts.push(Buffer.alloc(4), Buffer.from(JSON.stringify({ t: 'summary', ...namespaceHashOf(files) })));
  const file = path.join(DATA_ROOT, `nb12-state-${guildId}-${records.length}.dbex`);
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  setGuildViewCache(false);
  await dm.flushAll();
  vi.restoreAllMocks();
});

describe('P1: a facade write refused by a rule', () => {
  it('continue and resume: refused with the same reason each time, other content accepted', () => {
    setBackendKind('file');
    const guildId = freshGuild();
    const first = dm.saveDataTracked('cache.tmp/x.json', { guildId }, 1);
    const again = dm.saveDataTracked('cache.tmp/x.json', { guildId }, 1);
    expect(first).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
    expect(again).toEqual(first);
    expect(dm.saveDataTracked('cache/x.json', { guildId }, 1).outcome).toBe('saved');
  });

  it('restart: the file route reads the path again and refuses the same write', async () => {
    setBackendKind('file');
    setGuildViewCache(true);
    const guildId = freshGuild();
    expect(dm.saveDataTracked('m/a.json', { guildId }, 1).outcome).toBe('saved');
    await dm.flushAll();
    const before = dm.saveDataTracked('m/a.json/x', { guildId }, 2);
    setGuildViewCache(true);
    expect(dm.saveDataTracked('m/a.json/x', { guildId }, 2)).toEqual(before);
    expect(before).toMatchObject({ outcome: 'refused', cause: 'unstorable', reason: 'the folder m/a.json of it is a file' });
  });

  it('crash: the writes accepted before the refused one land, and nothing of it', async () => {
    setBackendKind('file');
    const guildId = freshGuild();
    expect(dm.saveDataTracked('m/a.json', { guildId }, 1).outcome).toBe('saved');
    expect(dm.saveDataTracked('m/a.json/x', { guildId }, 2).outcome).toBe('refused');
    await dm.flushAll();
    expect(fs.readFileSync(dataPath(guildId, 'm', 'a.json'), 'utf8')).toBe('1');
    expect(getPending(dataPath(guildId, 'm', 'a.json', 'x'))).toBeUndefined();
  });

  it('takeover: a new set hydrates the same keys and refuses the same write', async () => {
    setBackendKind('postgres');
    const store = new FakeStore();
    const guildId = freshGuild();
    let ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    expect(dm.saveDataTracked('m/a.json', { guildId }, 1).outcome).toBe('saved');
    expect(await ws.flushGuildNow(guildId, 1000)).toBe('ok');
    const refused = dm.saveDataTracked('m/A.json', { guildId }, 2);
    expect(refused).toEqual({ outcome: 'refused', cause: 'unstorable', reason: 'it differs only in letter case from m/a.json' });
    expect(dm.saveDataTracked('m/b.json', { guildId }, 3).outcome).toBe('saved');
    store.mode = 'deposed';
    expect(await ws.flushGuildNow(guildId, 1000)).toBe('deposed');
    expect(ws.stateOf(guildId)).toBe('fenced');
    store.mode = 'commit';
    ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    expect([...store.docs.keys()].filter(k => k.startsWith(`${guildId}|`))).toEqual([`${guildId}|m/a.json`]);
    expect(dm.saveDataTracked('m/A.json', { guildId }, 2)).toEqual(refused);
    expect(await ws.flushGuildNow(guildId, 1000)).toBe('ok');
    expect([...store.docs.entries()].filter(([k]) => k.startsWith(`${guildId}|`))).toEqual([[`${guildId}|m/a.json`, '1']]);
  });
});

describe('P8: a file-route delete that lands', () => {
  it('removes the folders it emptied, up to the guild folder, which stays', async () => {
    setBackendKind('file');
    const guildId = freshGuild();
    expect(dm.saveDataTracked('m/a/b/x.json', { guildId }, 1).outcome).toBe('saved');
    await dm.flushAll();
    expect(dm.deleteDataTracked('m/a/b/x.json', { guildId }).outcome).toBe('deleted');
    await dm.flushAll();
    expect(fs.existsSync(dataPath(guildId, 'm'))).toBe(false);
    expect(fs.existsSync(dataPath(guildId))).toBe(true);
  });

  it('crash: an empty folder left behind takes a save of its name after a restart, also with a temp file of this pid in it', async () => {
    setBackendKind('file');
    const guildId = freshGuild();
    fs.mkdirSync(dataPath(guildId, 'm', 'a'), { recursive: true });
    fs.writeFileSync(path.join(dataPath(guildId, 'm', 'a'), `x.json.${process.pid}.${Date.now()}.0.tmp`), 'partial');
    setGuildViewCache(true);
    expect(dm.saveDataTracked('m/a', { guildId }, 1).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.statSync(dataPath(guildId, 'm', 'a')).isFile()).toBe(true);
  });

  it("a temp file of another process younger than an hour keeps the folder: the save answers 'io'", () => {
    setBackendKind('file');
    const guildId = freshGuild();
    fs.mkdirSync(dataPath(guildId, 'm', 'a'), { recursive: true });
    const old = path.join(dataPath(guildId, 'm', 'a'), `x.json.${process.pid + 1}.${Date.now()}.0.tmp`);
    fs.writeFileSync(old, 'partial');
    expect(dm.saveDataTracked('m/a', { guildId }, 1)).toEqual({ outcome: 'refused', cause: 'io', reason: 'the folder m/a holds no data but could not be removed' });
    const twoHours = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(old, twoHours, twoHours);
    expect(dm.saveDataTracked('m/a', { guildId }, 1).outcome).toBe('saved');
  });

  it('a failed write leaves no temp file in its folder', async () => {
    setBackendKind('file');
    const guildId = freshGuild();
    const target = dataPath(guildId, 'm', 'a', 'x.json');
    const rename = fs.promises.rename.bind(fs.promises);
    let failing = true;
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (failing && String(to) === target) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return rename(from, to);
    }) as any);
    expect(dm.saveDataTracked('m/a/x.json', { guildId }, 1).outcome).toBe('saved');
    await vi.waitFor(() => expect(fs.existsSync(path.dirname(target)) && fs.readdirSync(path.dirname(target)).length === 0).toBe(true), { timeout: 5000 });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(fs.readdirSync(path.dirname(target)).filter(n => n.endsWith('.tmp'))).toEqual([]);
    failing = false;
    await dm.flushAll();
    expect(fs.readFileSync(target, 'utf8')).toBe('1');
    expect(dm.deleteDataTracked('m/a/x.json', { guildId }).outcome).toBe('deleted');
    await dm.flushAll();
    expect(dm.saveDataTracked('m/a', { guildId }, 2).outcome).toBe('saved');
    await dm.flushAll();
    expect(fs.statSync(dataPath(guildId, 'm', 'a')).isFile()).toBe(true);
  });

  it("a save of a folder's name while its file's delete is queued answers 'io' and is saved after", async () => {
    setBackendKind('file');
    const guildId = freshGuild();
    expect(dm.saveDataTracked('m/a/x.json', { guildId }, 1).outcome).toBe('saved');
    await dm.flushAll();
    expect(dm.deleteDataTracked('m/a/x.json', { guildId }).outcome).toBe('deleted');
    expect(dm.saveDataTracked('m/a', { guildId }, 2)).toMatchObject({ outcome: 'refused', cause: 'io' });
    await dm.flushAll();
    expect(dm.saveDataTracked('m/a', { guildId }, 2).outcome).toBe('saved');
  });
});

describe('P3: a raw guild-path write refused', () => {
  it('continue and resume: the same answer each time, the queue unchanged, other content accepted', async () => {
    setBackendKind('file');
    const guildId = freshGuild();
    const file = dataPath(guildId, 'm', 'a.json');
    const queued = queuedFilePaths().length;
    const first = dm.writeRawAtomicTracked(file, '{"a":"\u0000"}');
    expect(first).toEqual({ accepted: false, cause: 'unstorable', reason: 'it holds U+0000 at character 6, which the database cannot store' });
    expect(dm.writeRawAtomicTracked(file, '{"a":"\u0000"}')).toEqual(first);
    expect(queuedFilePaths().length).toBe(queued);
    expect(dm.writeRawAtomicTracked(file, '{"a":1}')).toEqual({ accepted: true });
    await dm.flushAll();
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
  });
});

describe('P4: an operator write over IPC refused in the bot process', () => {
  it('continue, resume and takeover: invalid with the reason each time, and from a new set holding the same keys', async () => {
    setBackendKind('postgres');
    const store = new FakeStore();
    const guildId = freshGuild();
    store.docs.set(`${guildId}|m/a.json`, '{"a":1}');
    let ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    const write = () => applyOperatorDataWrite({ guildId, module: 'cache.tmp', filename: 'x.json', op: 'write', contentJson: '{}' });
    const refused = { ok: false, code: 'invalid', error: 'The data was not saved: the part "cache.tmp" ends in ".tmp", which marks an interrupted write' };
    expect(await write()).toEqual(refused);
    expect(await write()).toEqual(refused);
    ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    expect(await write()).toEqual(refused);
    expect(await ws.flushGuildNow(guildId, 1000)).toBe('ok');
    expect([...store.docs.keys()].filter(k => k.startsWith(`${guildId}|`))).toEqual([`${guildId}|m/a.json`]);
  });
});

describe('P5: a bundle import refused while it stages', () => {
  const stagingLeft = () => fs.readdirSync(DATA_ROOT).filter(name => name.startsWith('.bundle-import-'));

  it('continue and resume: refused at the same record each time, the live folder untouched, no staging folder left', async () => {
    setBackendKind('file');
    const guildId = freshGuild();
    fs.mkdirSync(dataPath(guildId, 'keep'), { recursive: true });
    fs.writeFileSync(dataPath(guildId, 'keep', 'v.json'), '{"v":1}');
    const before = snapshot(dataPath(guildId));
    const file = bundleOf(guildId, [['m/a.json', Buffer.from('{}')], ['cache.tmp/x.json', Buffer.from('{}')]]);
    for (let i = 0; i < 2; i++) {
      await expect(importBundle(file)).rejects.toThrow(`[DataInterchange] ${guildId}/cache.tmp/x.json: `);
      expect(snapshot(dataPath(guildId))).toEqual(before);
      expect(stagingLeft()).toEqual([]);
    }
  });

  it('crash: a writeFile that throws after two records leaves the live folder unchanged', async () => {
    setBackendKind('file');
    const guildId = freshGuild();
    fs.mkdirSync(dataPath(guildId, 'keep'), { recursive: true });
    fs.writeFileSync(dataPath(guildId, 'keep', 'v.json'), '{"v":1}');
    const before = snapshot(dataPath(guildId));
    const file = bundleOf(guildId, [['m/a.json', Buffer.from('{"a":1}')], ['m/b.json', Buffer.from('{"b":2}')], ['m/c.json', Buffer.from('{"c":3}')]]);
    const real = fs.promises.writeFile.bind(fs.promises);
    let records = 0;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation((async (...args: Parameters<typeof fs.promises.writeFile>) => {
      if (String(args[0]).includes('.bundle-import-') && ++records > 2) throw Object.assign(new Error('the process died (stub)'), { code: 'EIO' });
      return real(...args);
    }) as typeof fs.promises.writeFile);
    await expect(importBundle(file)).rejects.toThrow();
    expect(records).toBeGreaterThan(2);
    expect(snapshot(dataPath(guildId))).toEqual(before);
  });
});

describe('P9: a bundle export refused while it writes', () => {
  it('continue and resume: the same refusal each time, no bundle and no .partial file, the guild folder only read', async () => {
    setBackendKind('file');
    const guildId = freshGuild();
    fs.mkdirSync(dataPath(guildId, 'cache.tmp'), { recursive: true });
    fs.writeFileSync(dataPath(guildId, 'cache.tmp', 'x.json'), '{}');
    fs.mkdirSync(dataPath(guildId, 'notes'), { recursive: true });
    fs.writeFileSync(dataPath(guildId, 'notes', 'a.json'), '{"n":1}');
    const before = snapshot(dataPath(guildId));
    const target = path.join(DATA_ROOT, `nb12-p9-${guildId}.dbex`);
    const messages: string[] = [];
    for (let i = 0; i < 2; i++) {
      const error = await writeBundle(guildId, target).then(() => null, e => e as Error);
      expect(error).toBeInstanceOf(Error);
      messages.push(error!.message);
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.existsSync(`${target}.partial`)).toBe(false);
      expect(snapshot(dataPath(guildId))).toEqual(before);
    }
    expect(messages[0]).toContain('cache.tmp/x.json');
    expect(messages[1]).toBe(messages[0]);
  });
});

describe('P8: a write into a folder racing its removal', () => {
  it("rmdir run between the write's mkdir and its open: the write lands on its retry", async () => {
    setBackendKind('file');
    const guildId = freshGuild();
    const folder = dataPath(guildId, 'm', 'a');
    const real = fs.promises.open.bind(fs.promises);
    let raced = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (...args: Parameters<typeof fs.promises.open>) => {
      if (raced === 0 && String(args[0]).startsWith(folder + path.sep) && String(args[0]).endsWith('.tmp')) {
        raced += 1;
        fs.rmdirSync(folder);
      }
      return real(...args);
    }) as typeof fs.promises.open);
    expect(dm.saveDataTracked('m/a/x.json', { guildId }, 1).outcome).toBe('saved');
    await dm.flushAll();
    expect(raced).toBe(1);
    expect(fs.readFileSync(path.join(folder, 'x.json'), 'utf8')).toBe('1');
    expect(fs.readdirSync(folder)).toEqual(['x.json']);
  });
});

describe('P1 x operator stop', () => {
  it('after the exit drain closed, a write throws node-stopping, not unstorable', async () => {
    setBackendKind('file');
    const guildId = freshGuild();
    await dm.flushAll();
    const before = queuedFilePaths();
    await dm.drainForExit(1000);
    expect(queuedFilePaths()).toEqual(before);
    let thrown: unknown;
    try {
      dm.saveDataTracked('cache.tmp/x.json', { guildId }, 1);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DataBackendUnavailableError);
    expect((thrown as DataBackendUnavailableError).causeKey).toBe('node-stopping');
    expect(queuedFilePaths()).toEqual(before);
    expect(fs.existsSync(dataPath(guildId))).toBe(false);
    dropPendingForGuild(guildId);
  });
});
