import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { queuedFilePaths, setGuildViewCache } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { GuildKeyError } from '../../src/bot/internalSetup/utils/dataKeys';
import { exportNamespace, importNamespace, writeBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { getMetricsCollector } from '../../src/bot/internalSetup/utils/metrics/metricsCollector';
import { getModuleDataPath } from '../../src/bot/internalSetup/utils/pathHelpers';
import { discoverGuildConfigFiles, discoverGuildDataFiles } from '../../src/bot/internalSetup/utils/configDiscovery';
import { setBackendKind } from '../helpers/backendKind';
import { tokenFor } from '../helpers/fakeStore';
import { ServerStore } from '../helpers/serverStore';

// NB33: a guild id that is not a Discord id (all digits) is refused by every entry that turns it into a data path,
// before anything is read, queued or written; a valid id works as before.

const BAD = ['global', '..', '../x', 'abc', ''];
const VALID = '9330000000000001';

/** Every file and folder under the data root, with each file's bytes. */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        out.set(full + path.sep, '');
        visit(full);
      } else {
        out.set(full, fs.readFileSync(full, 'utf8'));
      }
    }
  };
  visit(dir);
  return out;
}

/** The paths a bad id would reach under category m: inside the data root for most ids, beside it for '..' and '../x'. */
const reached = (id: string, file: string) => [path.join(DATA_ROOT, id, 'm', file), path.join(DATA_ROOT, id, file)];

function plant(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await dm.flushAll();
  setGuildViewCache(false);
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('NB33 file route: a guild id that is not a Discord id', () => {
  it.each(BAD)('%j: save, update, append, delete, load, exists and the raw reads are refused with nothing changed', async bad => {
    setBackendKind('file');
    // Planted where the id would reach inside the data root ('global' is the global folder, 'abc' another folder).
    const inside = bad !== '..' && bad !== '../x';
    const planted = path.join(DATA_ROOT, bad, 'm', 'nb33-held.json');
    if (inside) plant(planted, '{"kept":true}');
    const before = tree(DATA_ROOT);
    const o = { guildId: bad, category: 'm' };

    const saved = dm.saveDataTracked('nb33-new.json', o, { v: 1 });
    expect(saved.outcome).toBe('refused');
    expect(dm.saveData('nb33-new.json', o, { v: 1 })).toBe(false);
    const updated = dm.updateData<{ v?: number }>('nb33-new.json', o, {}, () => ({ v: 2 }));
    expect(updated.outcome).toBe('refused');
    expect(dm.appendDataTracked('nb33.jsonl', o, 'x\n').outcome).toBe('refused');
    const deleted = dm.deleteDataTracked('nb33-held.json', o);
    expect(deleted.outcome).toBe('refused');
    for (const answer of [saved, updated, deleted]) {
      expect(answer).toMatchObject({ cause: 'unstorable' });
      expect((answer as { reason: string }).reason).toContain(JSON.stringify(bad));
    }
    expect(dm.deleteData('nb33-held.json', o)).toBe(false);
    expect(dm.loadData('nb33-held.json', o, { fallback: true })).toEqual({ fallback: true });
    expect(dm.dataExists('nb33-held.json', o)).toBe(false);
    expect(() => dm.readGuildDocRaw(bad, 'm', 'nb33-held.json')).toThrow(GuildKeyError);
    expect(() => dm.readGuildDocRaw(bad, 'm', 'nb33-held.json')).toThrow(JSON.stringify(bad));
    expect(() => dm.guildDocFileQueue(bad, 'm', 'nb33-held.json')).toThrow(GuildKeyError);
    expect(() => dm.listGuildDataFiles(bad, 'm')).toThrow(GuildKeyError);
    expect(() => dm.listGuildDataKeys(bad)).toThrow(GuildKeyError);
    expect(() => dm.guildWritePlacement(bad, 'm', 'nb33-new.json')).toThrow(GuildKeyError);
    await expect(dm.flushGuild(bad)).rejects.toThrow(GuildKeyError);

    expect(queuedFilePaths().filter(p => !p.startsWith(DATA_ROOT + path.sep) || !/^\d+$/.test(path.relative(DATA_ROOT, p).split(path.sep)[0]))).toEqual([]);
    await dm.flushAll();
    expect(tree(DATA_ROOT)).toEqual(before);
    for (const file of [...reached(bad, 'nb33-new.json'), ...reached(bad, 'nb33.jsonl')]) expect(fs.existsSync(file)).toBe(false);
    if (inside) expect(fs.readFileSync(planted, 'utf8')).toBe('{"kept":true}');
  });

  it.each(BAD)('%j: the namespace delete and the graveyard restore are refused before anything moves', async bad => {
    setBackendKind('file');
    if (bad !== '..' && bad !== '../x') plant(path.join(DATA_ROOT, bad, 'm', 'nb33-ns.json'), '{"kept":true}');
    const before = tree(DATA_ROOT);
    const deleted = await dm.deleteGuildNamespace(bad, 'nb33');
    expect(deleted).toMatchObject({ ok: false, code: 'invalid' });
    expect((deleted as { error: string }).error).toContain(JSON.stringify(bad));
    const restored = await dm.restoreGuildFromGraveyard(bad);
    expect(restored).toMatchObject({ ok: false, code: 'invalid' });
    expect((restored as { error: string }).error).toContain(JSON.stringify(bad));
    expect(tree(DATA_ROOT)).toEqual(before);
    expect(fs.existsSync(DATA_ROOT)).toBe(true);
  });

  it.each(BAD)('%j: the bundle export and the config discovery refuse it, and the module data path does unless it is empty', async bad => {
    setBackendKind('file');
    const target = dataPath('nb33-out', `bundle-${bad.replace(/[^a-z]/g, '_')}.dbex`);
    await expect(writeBundle(bad, target)).rejects.toThrow(GuildKeyError);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.partial`)).toBe(false);
    if (bad === '') expect(getModuleDataPath('m', bad)).toBe(dataPath('global', 'm'));
    else expect(() => getModuleDataPath('m', bad)).toThrow(GuildKeyError);
    expect(() => discoverGuildConfigFiles(bad)).toThrow(GuildKeyError);
    expect(() => discoverGuildDataFiles(bad)).toThrow(GuildKeyError);
  });

  it('the namespace import and export refuse ".." before any folder is made or read', async () => {
    setBackendKind('file');
    const dest = dataPath('nb33-stage', 'in');
    await expect(importNamespace('..', [], dest)).rejects.toThrow(GuildKeyError);
    expect(fs.existsSync(dataPath('nb33-stage'))).toBe(false);
    await expect(exportNamespace('..').next()).rejects.toThrow(GuildKeyError);
  });

  it('a refused guild write named "global" leaves confirmSaved("global") answering for the global writes', async () => {
    setBackendKind('file');
    const since = dm.saveMark();
    expect(dm.saveModuleData('nb33-x.json', 'global', 'nb33mod', { v: 1 })).toBe(false);
    expect(dm.saveGlobalData('nb33-g.json', { v: 1 }, 'nb33mod')).toBe(true);
    await dm.flushAll();
    expect(JSON.parse(fs.readFileSync(dataPath('global', 'nb33mod', 'nb33-g.json'), 'utf8'))).toEqual({ v: 1 });
    expect(fs.existsSync(dataPath('global', 'nb33mod', 'nb33-x.json'))).toBe(false);
    expect(await dm.confirmSaved('global', { since })).toBe('ok');
    expect(await dm.confirmSaved('global', { since, category: 'nb33mod' })).toBe('ok');
  });

  it.each(BAD.filter(id => id !== 'global'))('confirmSaved(%j) answers refused, with or without a category, after a refused write there', async bad => {
    setBackendKind('file');
    const since = dm.saveMark();
    expect(dm.saveDataTracked('nb33-c.json', { guildId: bad, category: 'm' }, { v: 1 }).outcome).toBe('refused');
    await expect(dm.confirmSaved(bad, { since })).resolves.toBe('refused');
    await expect(dm.confirmSaved(bad, { since, category: 'm' })).resolves.toBe('refused');
    await expect(dm.confirmSaved(bad, { category: 'm' })).resolves.toBe('refused');
  });

  it('a Discord id still saves, loads, updates, appends and deletes under its own folder', async () => {
    setBackendKind('file');
    const o = { guildId: VALID, category: 'm' };
    expect(dm.saveDataTracked('nb33-ok.json', o, { v: 1 }).outcome).toBe('saved');
    expect(dm.updateData('nb33-ok.json', o, {}, cur => ({ ...cur, w: 2 })).outcome).toBe('saved');
    expect(dm.appendDataTracked('nb33-ok.jsonl', o, 'line\n').outcome).toBe('appended');
    await dm.flushAll();
    expect(JSON.parse(fs.readFileSync(dataPath(VALID, 'm', 'nb33-ok.json'), 'utf8'))).toEqual({ v: 1, w: 2 });
    expect(fs.readFileSync(dataPath(VALID, 'm', 'nb33-ok.jsonl'), 'utf8')).toBe('line\n');
    expect(dm.loadData('nb33-ok.json', o, null)).toEqual({ v: 1, w: 2 });
    expect(dm.readGuildDocRaw(VALID, 'm', 'nb33-ok.json')).not.toBeNull();
    expect(dm.dataExists('nb33-ok.json', o)).toBe(true);
    expect(dm.listGuildDataFiles(VALID, 'm')).toContain('nb33-ok.json');
    expect(getModuleDataPath('m', VALID)).toBe(dataPath(VALID, 'm'));
    expect(dm.deleteDataTracked('nb33-ok.json', o).outcome).toBe('deleted');
    await dm.flushAll();
    expect(fs.existsSync(dataPath(VALID, 'm', 'nb33-ok.json'))).toBe(false);
  });
});

describe('NB33 working-set route: a guild id that is not a Discord id never reaches the set', () => {
  let ws: WorkingSetManager;
  const METHODS = ['read', 'readForUpdate', 'exists', 'placementOf', 'save', 'append', 'delete', 'listFiles', 'readDocRaw', 'listAllKeys'] as const;

  it.each(BAD)('%j', async bad => {
    setBackendKind('postgres');
    ws = initWorkingSet(new ServerStore());
    expect(await ws.hydrate(VALID, tokenFor())).toBe('ready');
    const calls: string[] = [];
    for (const name of METHODS) {
      const real = (ws as any)[name].bind(ws);
      vi.spyOn(ws as any, name).mockImplementation((...args: unknown[]) => {
        calls.push(`${name}(${String(args[0])})`);
        return real(...args);
      });
    }
    const io = vi.spyOn(getMetricsCollector(), 'recordIO');
    const before = tree(DATA_ROOT);
    const o = { guildId: bad, category: 'm' };
    expect(dm.saveDataTracked('nb33-pg.json', o, { v: 1 }).outcome).toBe('refused');
    expect(dm.updateData<{ v?: number }>('nb33-pg.json', o, {}, () => ({ v: 2 })).outcome).toBe('refused');
    expect(dm.appendDataTracked('nb33-pg.jsonl', o, 'x\n').outcome).toBe('refused');
    expect(dm.deleteDataTracked('nb33-pg.json', o).outcome).toBe('refused');
    expect(dm.loadData('nb33-pg.json', o, 'fallback')).toBe('fallback');
    expect(dm.dataExists('nb33-pg.json', o)).toBe(false);
    expect(() => dm.readGuildDocRaw(bad, 'm', 'nb33-pg.json')).toThrow(GuildKeyError);
    expect(() => dm.listGuildDataFiles(bad, 'm')).toThrow(GuildKeyError);
    expect(() => dm.listGuildDataKeys(bad)).toThrow(GuildKeyError);
    expect(() => dm.guildWritePlacement(bad, 'm', 'nb33-pg.json')).toThrow(GuildKeyError);
    expect(calls).toEqual([]);
    expect(io.mock.calls.filter(([, guild]) => guild === bad)).toEqual([]);

    expect(dm.saveDataTracked('nb33-pg.json', { guildId: VALID, category: 'm' }, { v: 1 }).outcome).toBe('saved');
    expect(calls).toContain(`save(${VALID})`);
    await dm.flushAll();
    expect(tree(DATA_ROOT)).toEqual(before);
  });
});
