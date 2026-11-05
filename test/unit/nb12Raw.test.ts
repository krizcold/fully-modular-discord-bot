import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
const h = vi.hoisted(() => ({
  stub: null as null | { accepted: false; cause: string; reason?: string },
  save: null as null | { outcome: 'refused'; cause: string; reason?: string },
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    writeRawAtomicTracked: (abs: string, text: string) => h.stub ?? real.writeRawAtomicTracked(abs, text),
    saveDataTracked: (...args: unknown[]) => h.save ?? real.saveDataTracked(...args),
  };
});
vi.mock('../../src/bot/internalSetup/utils/configDiscovery', async orig => {
  const real = await orig<any>();
  const { dataPath } = await import('../../src/utils/dataRoot');
  return {
    ...real,
    getConfigFileMetadata: (id: string) => {
      if (id !== 'settings.json') return real.getConfigFileMetadata(id);
      return {
        id, path: dataPath('global', 'm', id), name: 'Settings', description: 'A module config of module m', category: 'config', exists: true,
        schema: { id, name: 'Settings', description: 'A module config of module m', properties: {} }, moduleName: 'm',
      };
    },
  };
});

import { setBackendKind } from '../helpers/backendKind';
import {
  deleteRawAtomic,
  flushAll,
  saveDataTracked,
  writeRawAtomic,
  writeRawAtomicTracked,
} from '../../src/bot/internalSetup/utils/dataManager';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { enqueueWrite, setGuildViewCache } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';
import { saveGuildConfigTracked } from '../../src/bot/internalSetup/utils/configManager';
import { BACKUPS, FakeChild, backupNames, call, put, resetData, startConfigApp } from '../helpers/configRig';
import { DISKS, caseSensitiveWhereAllowed, useDisk } from '../helpers/caseInsensitiveDisk';

// NB12 item 4 (wip-redesign/sheets/NB12.md, decision 15): a raw write answers why it was refused, with no state kept
// between calls, and the web UI's config routes answer each cause with its own text.

const G = '333333333333333333';
const realFolds = caseSensitiveWhereAllowed(dataPath());
const child = new FakeChild();
let base = '';
let close: () => Promise<void>;

beforeAll(async () => {
  ({ url: base, close } = await startConfigApp(child));
});
afterAll(async () => { await close(); });
beforeEach(async () => {
  child.reset();
  setBackendKind('file');
  await resetData();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  h.stub = null;
  h.save = null;
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe('writeRawAtomicTracked', () => {
  it('refuses text holding U+0000 on a guild path with the reason; the boolean form answers false', () => {
    const file = dataPath(G, 'm', 'a.json');
    expect(writeRawAtomicTracked(file, '{"a":"\u0000"}')).toEqual({
      accepted: false, cause: 'unstorable', reason: 'it holds U+0000 at character 6, which the database cannot store',
    });
    expect(writeRawAtomic(file, '\u0000')).toBe(false);
    expect(fs.existsSync(dataPath(G))).toBe(false);
  });

  it('refuses a non-string on any path, and the queue keeps working', async () => {
    const other = dataPath('global', 'nb12raw', 'b.json');
    expect(writeRawAtomicTracked(dataPath('global', 'nb12raw', 'a.json'), { a: 1 } as never)).toEqual({ accepted: false, cause: 'unstorable', reason: 'the text is not a string' });
    expect(writeRawAtomicTracked(other, '{}')).toEqual({ accepted: true });
    await flushAll();
    expect(fs.readFileSync(other, 'utf8')).toBe('{}');
  });

  it('a refusal leaves nothing behind: a storage-failing refusal after it answers storage-failing, a delete records nothing', () => {
    const ledger = openLedger('console');
    runInLedger(ledger, 'mod', () => {
      expect(writeRawAtomicTracked(dataPath(G, 'm', 'a.json'), '\u0000').accepted).toBe(false);
      expect(deleteRawAtomic(dataPath('global', 'nb12raw', 'absent.json'))).toBe(false);
    });
    expect(ledger.refusals()).toEqual([{ cause: 'unstorable', modules: ['mod'] }]);
    const big = 'x'.repeat(4 * 1024 * 1024);
    const paths: string[] = [];
    for (let i = 0; i < 8; i++) {
      const p = dataPath('global', 'nb12raw', `held${i}.json`);
      paths.push(p);
      enqueueWrite(p, big);
    }
    expect(writeRawAtomicTracked(dataPath('global', 'nb12raw', 'more.json'), '{}')).toEqual({ accepted: false, cause: 'storage-failing' });
  });

  it("the web UI process reads the folder afresh at each write (a key the bot replaced is seen)", async () => {
    put(dataPath(G, 'notes', 'Todo.json'), { v: 1 });
    expect(writeRawAtomicTracked(dataPath(G, 'notes', 'Todo.json'), '{"v":2}')).toEqual({ accepted: true });
    await flushAll();
    fs.rmSync(dataPath(G, 'notes', 'Todo.json'));
    put(dataPath(G, 'notes', 'todo.json'), { v: 3 });
    const answer = writeRawAtomicTracked(dataPath(G, 'notes', 'Todo.json'), '{"v":4}');
    expect(answer).toEqual({ accepted: false, cause: 'unstorable', reason: 'it differs only in letter case from notes/todo.json' });
    expect(JSON.parse(fs.readFileSync(dataPath(G, 'notes', 'todo.json'), 'utf8'))).toEqual({ v: 3 });
  });

  it('its own queued write is part of what it reads', () => {
    expect(writeRawAtomicTracked(dataPath(G, 'm', 'Foo.json'), '{}')).toEqual({ accepted: true });
    expect(writeRawAtomicTracked(dataPath(G, 'm', 'foo.json'), '{}')).toMatchObject({ accepted: false, cause: 'unstorable', reason: 'it differs only in letter case from m/Foo.json' });
    expect(saveDataTracked('foo.json', { guildId: G, category: 'm' }, 1)).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
  });

  it('a file that became a folder on disk takes a write below it', async () => {
    put(dataPath(G, 'tickets', 'archive'), { v: 1 });
    expect(writeRawAtomicTracked(dataPath(G, 'tickets', 'archive'), '{}')).toEqual({ accepted: true });
    await flushAll();
    fs.rmSync(dataPath(G, 'tickets', 'archive'));
    put(dataPath(G, 'tickets', 'archive', '1.json'), { v: 1 });
    expect(writeRawAtomicTracked(dataPath(G, 'tickets', 'archive', '1.json'), '{}')).toEqual({ accepted: true });
  });
});

describe('the config routes on a JSON bot', () => {
  const update = () => call(base, 'POST', '/api/config/data/update', { file: 'm/foo.json', data: { b: 2 }, guildId: G });

  it('/data/update answers each cause of a write the bot process refused with its own text', async () => {
    put(dataPath(G, 'm', 'foo.json'), { v: 0 });
    h.save = { outcome: 'refused', cause: 'unstorable', reason: 'it differs only in letter case from m/Foo.json' };
    expect(await update()).toEqual({ status: 400, body: { success: false, error: 'The data was not saved: it differs only in letter case from m/Foo.json' } });
    h.save = { outcome: 'refused', cause: 'io', reason: 'the folder m/foo.json holds no data but could not be removed' };
    expect(await update()).toEqual({ status: 503, body: { success: false, error: 'The data was not saved: the folder m/foo.json holds no data but could not be removed. Please try again.' } });
    h.save = { outcome: 'refused', cause: 'io' };
    expect(await update()).toEqual({ status: 503, body: { success: false, error: truthText('io', false) } });
    h.save = { outcome: 'refused', cause: 'writer-lost' };
    expect(await update()).toEqual({ status: 503, body: { success: false, error: truthText('writer-lost', false) } });
    expect(JSON.parse(fs.readFileSync(dataPath(G, 'm', 'foo.json'), 'utf8'))).toEqual({ v: 0 });
  });

  it('/data/update saves a JSON value whose string holds U+0000 (a guard: JSON text keeps it as an escape)', async () => {
    put(dataPath(G, 'm', 'foo.json'), { v: 0 });
    const answer = await call(base, 'POST', '/api/config/data/update', { file: 'm/foo.json', data: { b: '\u0000' }, guildId: G });
    expect(answer.status).toBe(200);
    await flushAll();
    expect(JSON.parse(fs.readFileSync(dataPath(G, 'm', 'foo.json'), 'utf8'))).toEqual({ b: '\u0000' });
  });
});

describe('the real refusal through the config routes (no stub)', () => {
  const eperm = () => { throw Object.assign(new Error('EPERM: operation not permitted (stub)'), { code: 'EPERM' }); };
  const guildConfig = () => dataPath(G, '_guildConfig', 'config.json');
  const saveConfig = (config: unknown) => call(base, 'POST', '/api/config/update', { file: 'config.json', config, guildId: G });
  const folderText = (rel: string) => `The data was not saved: the folder ${rel} holds no data but could not be removed. Please try again.`;

  it("/data/update over an empty folder 'm/foo.json' that rmdirSync cannot remove answers 503 naming it, and saves once lifted", async () => {
    fs.mkdirSync(dataPath(G, 'm', 'foo.json'), { recursive: true });
    fs.writeFileSync(dataPath(G, 'm', 'keep.json'), '{"k":1}');
    const stub = vi.spyOn(fs, 'rmdirSync').mockImplementation(eperm);
    const update = () => call(base, 'POST', '/api/config/data/update', { file: 'm/foo.json', data: { b: 2 }, guildId: G });
    expect(await update()).toEqual({ status: 503, body: { success: false, error: folderText('m/foo.json') } });
    stub.mockRestore();
    expect((await update()).status).toBe(200);
    await flushAll();
    expect(JSON.parse(fs.readFileSync(dataPath(G, 'm', 'foo.json'), 'utf8'))).toEqual({ b: 2 });
    expect(fs.readFileSync(dataPath(G, 'm', 'keep.json'), 'utf8')).toBe('{"k":1}');
  });

  it("/api/config/update over an empty folder in the guild config's place that rmdirSync cannot remove answers 503 naming it", async () => {
    fs.mkdirSync(guildConfig(), { recursive: true });
    const stub = vi.spyOn(fs, 'rmdirSync').mockImplementation(eperm);
    expect(await saveConfig({ a: 1 })).toEqual({ status: 503, body: { success: false, error: folderText('_guildConfig/config.json') } });
    stub.mockRestore();
    expect((await saveConfig({ a: 1 })).status).toBe(200);
    await flushAll();
    expect(JSON.parse(fs.readFileSync(guildConfig(), 'utf8'))).toEqual({ a: 1 });
  });

  it("/api/config/update with '_guildConfig/Config.json' stored on the case-insensitive helper answers 422 naming it, its bytes unchanged", async () => {
    useDisk('case-insensitive', dataPath());
    fs.mkdirSync(dataPath(G, '_guildConfig'), { recursive: true });
    fs.writeFileSync(dataPath(G, '_guildConfig', 'Config.json'), '{"old":1}');
    expect(await saveConfig({ a: 1 })).toEqual({ status: 422, body: { success: false, error: 'The data was not saved: it differs only in letter case from _guildConfig/Config.json' } });
    await flushAll();
    expect(fs.readdirSync(dataPath(G, '_guildConfig'))).toEqual(['Config.json']);
    expect(fs.readFileSync(dataPath(G, '_guildConfig', 'Config.json'), 'utf8')).toBe('{"old":1}');
  });

  it('/api/config/restore over the same empty folder answers the same 503', async () => {
    put(guildConfig(), { v: 1 });
    expect((await saveConfig({ v: 2 })).status).toBe(200);
    await flushAll();
    const backup = fs.readdirSync(BACKUPS()).find(name => name.startsWith(`config@${G}_`));
    expect(backup).toBeDefined();
    fs.rmSync(guildConfig());
    fs.mkdirSync(guildConfig());
    const stub = vi.spyOn(fs, 'rmdirSync').mockImplementation(eperm);
    const restore = () => call(base, 'POST', '/api/config/restore', { file: 'config.json', filename: backup, guildId: G });
    expect(await restore()).toEqual({ status: 503, body: { success: false, error: folderText('_guildConfig/config.json') } });
    stub.mockRestore();
    expect((await restore()).status).toBe(200);
    await flushAll();
    expect(JSON.parse(fs.readFileSync(guildConfig(), 'utf8'))).toEqual({ v: 1 });
  });

  it('the web UI process writes keys that collide with the old tree after the folder was moved away and re-created', async () => {
    put(dataPath(G, 'notes', 'Todo.json'), { v: 1 });
    put(dataPath(G, 'tickets', 'archive'), { a: 1 });
    expect(writeRawAtomicTracked(dataPath(G, 'notes', 'Todo.json'), '{"v":2}')).toEqual({ accepted: true });
    expect(writeRawAtomicTracked(dataPath(G, 'tickets', 'archive'), '{"a":2}')).toEqual({ accepted: true });
    await flushAll();
    fs.renameSync(dataPath(G), `${dataPath(G)}-moved`);
    put(dataPath(G, 'tickets', 'archive', '1.json'), { t: 1 });
    put(dataPath(G, 'notes', 'todo.json'), { v: 3 });
    expect(writeRawAtomicTracked(dataPath(G, 'tickets', 'archive', '2.json'), '{"t":2}')).toEqual({ accepted: true });
    expect(writeRawAtomicTracked(dataPath(G, 'notes', 'todo.json'), '{"v":4}')).toEqual({ accepted: true });
    await flushAll();
    expect(fs.readdirSync(dataPath(G, 'tickets', 'archive')).sort()).toEqual(['1.json', '2.json']);
    expect(fs.readFileSync(dataPath(G, 'tickets', 'archive', '1.json'), 'utf8')).toBe(JSON.stringify({ t: 1 }, null, 2));
    expect(fs.readFileSync(dataPath(G, 'tickets', 'archive', '2.json'), 'utf8')).toBe('{"t":2}');
    expect(fs.readdirSync(dataPath(G, 'notes'))).toEqual(['todo.json']);
    expect(fs.readFileSync(dataPath(G, 'notes', 'todo.json'), 'utf8')).toBe('{"v":4}');
    expect(fs.readFileSync(`${dataPath(G)}-moved/notes/Todo.json`, 'utf8')).toBe('{"v":2}');
    fs.rmSync(`${dataPath(G)}-moved`, { recursive: true, force: true });
  });
});

describe('the guild config write through saveGuildConfigTracked (saveGuildConfig\'s path)', () => {
  const eperm = () => { throw Object.assign(new Error('EPERM: operation not permitted (stub)'), { code: 'EPERM' }); };

  it('an empty folder in its place that rmdirSync cannot remove answers io with the reason, and saves once lifted', async () => {
    fs.mkdirSync(dataPath(G, '_guildConfig', 'config.json'), { recursive: true });
    const stub = vi.spyOn(fs, 'rmdirSync').mockImplementation(eperm);
    expect(saveGuildConfigTracked('config.json', G, { a: 1 })).toEqual({
      outcome: 'refused', cause: 'io', reason: 'the folder _guildConfig/config.json holds no data but could not be removed',
    });
    stub.mockRestore();
    expect(saveGuildConfigTracked('config.json', G, { a: 1 }).outcome).toBe('saved');
    await flushAll();
    expect(JSON.parse(fs.readFileSync(dataPath(G, '_guildConfig', 'config.json'), 'utf8'))).toEqual({ a: 1 });
  });

  it.each(DISKS)("the web UI process (cache off), %s disk: a guild config the bot replaced with 'Config.json' is seen, the save refused and its bytes kept", async disk => {
    setGuildViewCache(false);
    if (disk === 'case-insensitive') useDisk(disk, dataPath());
    put(dataPath(G, '_guildConfig', 'config.json'), { v: 1 });
    expect(saveGuildConfigTracked('config.json', G, { v: 2 }).outcome).toBe('saved');
    await flushAll();
    fs.rmSync(dataPath(G, '_guildConfig', 'config.json'));
    put(dataPath(G, '_guildConfig', 'Config.json'), { v: 3 });
    expect(saveGuildConfigTracked('config.json', G, { v: 4 })).toEqual({
      outcome: 'refused', cause: 'unstorable', reason: 'it differs only in letter case from _guildConfig/Config.json',
    });
    await flushAll();
    expect(fs.readdirSync(dataPath(G, '_guildConfig'))).toEqual(['Config.json']);
    expect(fs.readFileSync(dataPath(G, '_guildConfig', 'Config.json'), 'utf8')).toBe(JSON.stringify({ v: 3 }, null, 2));
  });

  it.skipIf(realFolds)("/api/config/update and /restore with '_guildConfig' gone and an empty case alias '_GuildConfig' that rmdirSync cannot remove answer 503 naming it", async () => {
    put(dataPath(G, '_guildConfig', 'config.json'), { v: 1 });
    const save = (config: unknown) => call(base, 'POST', '/api/config/update', { file: 'config.json', config, guildId: G });
    expect((await save({ v: 2 })).status).toBe(200);
    await flushAll();
    const backup = fs.readdirSync(BACKUPS()).find(name => name.startsWith(`config@${G}_`));
    fs.rmSync(dataPath(G, '_guildConfig'), { recursive: true });
    fs.mkdirSync(dataPath(G, '_GuildConfig', 'empty'), { recursive: true });
    const stub = vi.spyOn(fs, 'rmdirSync').mockImplementation(eperm);
    const text = 'The data was not saved: the folder _GuildConfig holds no data but could not be removed. Please try again.';
    expect(await save({ v: 3 })).toEqual({ status: 503, body: { success: false, error: text } });
    expect(await call(base, 'POST', '/api/config/restore', { file: 'config.json', filename: backup, guildId: G })).toEqual({ status: 503, body: { success: false, error: text } });
    stub.mockRestore();
    await flushAll();
    expect(fs.readdirSync(dataPath(G))).toEqual(['_GuildConfig']);
    expect((await save({ v: 3 })).status).toBe(200);
    await flushAll();
    expect(fs.readdirSync(dataPath(G))).toEqual(['_guildConfig']);
    expect(JSON.parse(fs.readFileSync(dataPath(G, '_guildConfig', 'config.json'), 'utf8'))).toEqual({ v: 3 });
  });

  it.skipIf(realFolds)("with '_guildConfig/config.json' stored, an empty '_GuildConfig' that rmdirSync cannot remove is no alias: /update is saved and lands", async () => {
    put(dataPath(G, '_guildConfig', 'config.json'), { v: 1 });
    fs.mkdirSync(dataPath(G, '_GuildConfig', 'empty'), { recursive: true });
    vi.spyOn(fs, 'rmdirSync').mockImplementation(eperm);
    const save = (config: unknown) => call(base, 'POST', '/api/config/update', { file: 'config.json', config, guildId: G });
    expect(await save({ v: 2 })).toMatchObject({ status: 200, body: { success: true } });
    await flushAll();
    expect(fs.readdirSync(dataPath(G)).sort()).toEqual(['_GuildConfig', '_guildConfig']);
    expect(fs.readdirSync(dataPath(G, '_GuildConfig'))).toEqual(['empty']);
    expect(JSON.parse(fs.readFileSync(dataPath(G, '_guildConfig', 'config.json'), 'utf8'))).toEqual({ v: 2 });
  });
});

describe("a module config of a guild, 'settings.json' of module m (NB12-4.3)", () => {
  const eperm = () => { throw Object.assign(new Error('EPERM: operation not permitted (stub)'), { code: 'EPERM' }); };
  const settings = () => dataPath(G, 'm', 'settings.json');
  const save = (config: unknown) => call(base, 'POST', '/api/config/update', { file: 'settings.json', config, guildId: G });
  const folderText = (rel: string) => `The data was not saved: the folder ${rel} holds no data but could not be removed. Please try again.`;

  it("/api/config/update over an empty folder 'm/settings.json' that rmdirSync cannot remove answers 503 naming it, writes no backup, and saves once lifted", async () => {
    fs.mkdirSync(settings(), { recursive: true });
    const stub = vi.spyOn(fs, 'rmdirSync').mockImplementation(eperm);
    expect(await save({ a: 1 })).toEqual({ status: 503, body: { success: false, error: folderText('m/settings.json') } });
    expect(backupNames()).toEqual([]);
    expect(fs.statSync(settings()).isDirectory()).toBe(true);
    stub.mockRestore();
    expect((await save({ a: 1 })).status).toBe(200);
    await flushAll();
    expect(fs.readFileSync(settings(), 'utf8')).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it("/api/config/update with 'm/Settings.json' stored on the case-insensitive helper answers 422 naming it, its bytes unchanged and no backup written", async () => {
    useDisk('case-insensitive', dataPath());
    fs.mkdirSync(dataPath(G, 'm'), { recursive: true });
    fs.writeFileSync(dataPath(G, 'm', 'Settings.json'), '{"old":1}');
    expect(await save({ a: 1 })).toEqual({ status: 422, body: { success: false, error: 'The data was not saved: it differs only in letter case from m/Settings.json' } });
    await flushAll();
    expect(fs.readdirSync(dataPath(G, 'm'))).toEqual(['Settings.json']);
    expect(fs.readFileSync(dataPath(G, 'm', 'Settings.json'), 'utf8')).toBe('{"old":1}');
    expect(backupNames()).toEqual([]);
  });

  it('/api/config/restore over the same empty folder answers the same 503 with no backup written, and restores once lifted', async () => {
    put(settings(), { v: 1 });
    expect((await save({ v: 2 })).status).toBe(200);
    await flushAll();
    const before = backupNames();
    const backup = before.find(name => name.startsWith(`settings@${G}_`));
    expect(backup).toBeDefined();
    fs.rmSync(settings());
    fs.mkdirSync(settings());
    const stub = vi.spyOn(fs, 'rmdirSync').mockImplementation(eperm);
    const restore = () => call(base, 'POST', '/api/config/restore', { file: 'settings.json', filename: backup, guildId: G });
    expect(await restore()).toEqual({ status: 503, body: { success: false, error: folderText('m/settings.json') } });
    expect(backupNames()).toEqual(before);
    stub.mockRestore();
    expect((await restore()).status).toBe(200);
    await flushAll();
    expect(fs.readFileSync(settings(), 'utf8')).toBe(JSON.stringify({ v: 1 }, null, 2));
  });
});

describe('a refused operator write costs no backup (NB12-DL-R4-1)', () => {
  const snapshot = () => new Map(backupNames().map(name => [name, fs.readFileSync(`${BACKUPS()}/${name}`, 'utf8')]));

  it("11 refused /api/config/update calls on the 'Config.json' alias keep every earlier backup, by name and bytes", async () => {
    useDisk('case-insensitive', dataPath());
    const save = (config: unknown) => call(base, 'POST', '/api/config/update', { file: 'config.json', config, guildId: G });
    for (let v = 1; v <= 11; v++) {
      expect((await save({ v })).status).toBe(200);
      await flushAll();
    }
    const kept = snapshot();
    expect(kept.size).toBe(10);
    expect(new Set(kept.values()).size).toBe(10);
    fs.rmSync(dataPath(G, '_guildConfig', 'config.json'));
    fs.writeFileSync(dataPath(G, '_guildConfig', 'Config.json'), '{"v":11}');
    for (let i = 0; i < 11; i++) {
      expect(await save({ v: 100 + i })).toEqual({ status: 422, body: { success: false, error: 'The data was not saved: it differs only in letter case from _guildConfig/Config.json' } });
    }
    expect(snapshot()).toEqual(kept);
    expect(fs.readFileSync(dataPath(G, '_guildConfig', 'Config.json'), 'utf8')).toBe('{"v":11}');
  });

  it('a /api/config/data/update of a stored key with a 201-byte part is refused 422 with the reason and writes no backup', async () => {
    const name = `${'a'.repeat(196)}.json`;
    put(dataPath(G, 'm', name), '{"old":1}');
    for (let i = 0; i < 3; i++) {
      const answer = await call(base, 'POST', '/api/config/data/update', { file: `m/${name}`, data: { b: i }, guildId: G });
      expect(answer).toEqual({ status: 422, body: { success: false, error: `The data was not saved: the part "${'a'.repeat(40)}..." is 201 bytes; one part of a key holds at most 200` } });
    }
    expect(backupNames()).toEqual([]);
    await flushAll();
    expect(fs.readFileSync(dataPath(G, 'm', name), 'utf8')).toBe('{"old":1}');
  });

  it('a /api/config/restore of a backup over 4 MiB is refused 422 with the size reason and writes no before-restore copy', async () => {
    const save = (config: unknown) => call(base, 'POST', '/api/config/update', { file: 'config.json', config, guildId: G });
    put(dataPath(G, '_guildConfig', 'config.json'), { v: 1 });
    expect((await save({ v: 2 })).status).toBe(200);
    await flushAll();
    const backup = backupNames().find(name => name.startsWith(`config@${G}_`))!;
    fs.writeFileSync(`${BACKUPS()}/${backup}`, JSON.stringify({ s: 'x'.repeat(4 * 1024 * 1024) }));
    const kept = snapshot();
    const answer = await call(base, 'POST', '/api/config/restore', { file: 'config.json', filename: backup, guildId: G });
    expect(answer.status).toBe(422);
    expect(answer.body.success).toBe(false);
    expect(answer.body.error).toMatch(/^The data was not saved: it is [0-9.]+ MiB; one write holds at most 4 MiB$/);
    expect(snapshot()).toEqual(kept);
    await flushAll();
    expect(fs.readFileSync(dataPath(G, '_guildConfig', 'config.json'), 'utf8')).toBe(JSON.stringify({ v: 2 }, null, 2));
  });
});
