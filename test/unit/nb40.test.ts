import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_ROOT } from '../../src/utils/dataRoot';
import { cancelQueued, dropGuildView, guildKeyStored, queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, mirrorPathOf, ROOT_CONFIG_KEY, rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';

// NB40: every global-scope data entry refuses a category or file name whose resolved path is not inside the global
// data folder, before anything is read, queued or written, and names what it got.

const GUILD = '9400000000000001';
const GLOBAL = path.join(DATA_ROOT, 'global');
const GUILD_FILE = path.join(DATA_ROOT, GUILD, '_guildConfig', 'config.json');
const GUILD_OPTIONS: dm.DataOptions = { guildId: GUILD, category: '_guildConfig' };
const INTO_GUILD = `../${GUILD}/_guildConfig`;
// Where '../..' with nb40.json or nb40.jsonl lands when it is not refused: beside the data root. Only these rows use the names.
const ABOVE = ['nb40.json', 'nb40.jsonl'].map(name => path.resolve(DATA_ROOT, '..', name));

interface Bad {
  label: string;
  category?: string;
  file: string;
  named: string;
  categoryStays?: boolean;
}

const BAD: Bad[] = [
  { label: 'a category into a guild folder', category: INTO_GUILD, file: 'config.json', named: INTO_GUILD },
  { label: 'a category above the data root', category: '../..', file: 'nb40.json', named: '../..' },
  { label: 'a category with .. after a folder', category: `nb40/../../${GUILD}/_guildConfig`, file: 'config.json', named: `nb40/../../${GUILD}/_guildConfig` },
  { label: 'an absolute category', category: path.join(DATA_ROOT, GUILD, '_guildConfig'), file: 'config.json', named: path.join(DATA_ROOT, GUILD, '_guildConfig') },
  { label: 'a category beside the global folder', category: '../global-other', file: 'nb40.json', named: '../global-other' },
  { label: 'a file name that climbs out', file: '../x.json', named: '../x.json' },
  { label: 'a file name into a guild folder', file: `../${GUILD}/_guildConfig/config.json`, named: `../${GUILD}/_guildConfig/config.json` },
  { label: 'an absolute file name', file: GUILD_FILE, named: GUILD_FILE },
  { label: 'a category that is the global folder with a file name that climbs out', category: 'nb40/..', file: '../x.json', named: '../x.json', categoryStays: true },
  ...(path.sep === '\\'
    ? [{ label: 'a backslash category', category: `..\\${GUILD}\\_guildConfig`, file: 'config.json', named: `..\\${GUILD}\\_guildConfig` }]
    : []),
];

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

let errors: string[];
let rowStart: { tree: Map<string, string>; queued: string[] };

async function plantGuildFile(): Promise<void> {
  expect(dm.saveData('config.json', GUILD_OPTIONS, { kept: true })).toBe(true);
  await dm.flushAll();
  expect(JSON.parse(fs.readFileSync(GUILD_FILE, 'utf8'))).toEqual({ kept: true });
}

const guildFileKept = (): unknown => JSON.parse(fs.readFileSync(GUILD_FILE, 'utf8'));
const logged = (named: string): boolean => errors.some(e => e.includes(JSON.stringify(named)));
const REFUSED = { outcome: 'refused', cause: 'unstorable' };

beforeEach(() => {
  errors = [];
  setBackendKind('file');
  fs.mkdirSync(GLOBAL, { recursive: true });
  rowStart = { tree: tree(DATA_ROOT), queued: queuedFilePaths() };
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
});

// A row that fails midway leaves nothing for the next one: its queue entries are dropped and the data root is put
// back as the row found it.
afterEach(async () => {
  _resetRowQueue();
  setBackendKind('file');
  const left = queuedFilePaths().filter(p => !rowStart.queued.includes(p));
  if (left.length > 0) await cancelQueued(left);
  await dm.flushAll();
  const now = tree(DATA_ROOT);
  for (const p of [...now.keys()].reverse()) {
    if (!rowStart.tree.has(p)) fs.rmSync(p, { recursive: true, force: true });
  }
  for (const [p, text] of rowStart.tree) {
    if (p.endsWith(path.sep)) fs.mkdirSync(p, { recursive: true });
    else if (now.get(p) !== text) fs.writeFileSync(p, text);
  }
  for (const file of ABOVE) fs.rmSync(file, { force: true });
  dropGuildView(GUILD);
  dm.forgetSharedFileKnowledge();
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('NB40: a global-scope category or file name that leaves the global data folder', () => {
  const cases = (['file', 'postgres'] as const).flatMap(backend => BAD.map(bad => ({ ...bad, backend })));

  // Soft expectations, reads first: on a tree that refuses nothing, each entry's own expectation is still reached.
  it.each(cases)('$label on a $backend bot: every entry refuses before a read, queue or write', async ({ category, file, named, backend, categoryStays }) => {
    await plantGuildFile();
    setBackendKind(backend);
    const before = tree(DATA_ROOT);
    const queuedBefore = queuedFilePaths();
    const rowsBefore = dm.unsavedRowPaths();
    const o: dm.DataOptions = { scope: 'global', ...(category === undefined ? {} : { category }) };
    const lines = file.replace(/\.json$/, '.jsonl');
    // The append names its .jsonl file, so the name is matched without its closing quote.
    const needle = JSON.stringify(named).slice(0, -1);
    const reasonOf = (answer: object): string => (answer as { reason?: string }).reason ?? '';

    errors = [];
    expect.soft(dm.loadData(file, o, { fallback: true }), 'loadData').toEqual({ fallback: true });
    expect.soft(logged(named), 'loadData names it').toBe(true);
    errors = [];
    expect.soft(dm.loadGlobalData(file, { fallback: true }, category), 'loadGlobalData').toEqual({ fallback: true });
    expect.soft(logged(named), 'loadGlobalData names it').toBe(true);
    errors = [];
    expect.soft(dm.dataExists(file, o), 'dataExists').toBe(false);
    expect.soft(logged(named), 'dataExists names it').toBe(true);

    if (category !== undefined && !categoryStays) {
      errors = [];
      expect.soft(dm.listGlobalDataFiles(category), 'listGlobalDataFiles').toEqual([]);
      expect.soft(logged(named), 'listGlobalDataFiles names it').toBe(true);
      errors = [];
      expect.soft(dm.listGlobalModuleDataFiles(category), 'listGlobalModuleDataFiles').toEqual([]);
      expect.soft(logged(named), 'listGlobalModuleDataFiles names it').toBe(true);
      expect.soft(await dm.confirmSaved('global', { since: dm.saveMark(), category, deadlineMs: 0 }), 'confirmSaved').toBe('refused');
    }

    let ran = false;
    const updated = dm.updateData<{ v?: number }>(file, o, {}, () => {
      ran = true;
      return { v: 2 };
    });
    expect.soft(updated, 'updateData').toMatchObject(REFUSED);
    expect.soft(reasonOf(updated), 'updateData names it').toContain(needle);
    expect.soft(ran, 'the update function ran').toBe(false);
    expect.soft(dm.updateGlobalData<{ v?: number }>(file, {}, () => ({ v: 3 }), category), 'updateGlobalData').toMatchObject(REFUSED);

    const appended = dm.appendDataTracked(lines, o, 'x\n');
    expect.soft(appended, 'appendDataTracked').toMatchObject(REFUSED);
    expect.soft(reasonOf(appended), 'appendDataTracked names it').toContain(needle);
    expect.soft(dm.appendData(lines, o, 'x\n'), 'appendData').toBe(false);

    const saved = dm.saveDataTracked(file, o, { v: 1 });
    expect.soft(saved, 'saveDataTracked').toMatchObject(REFUSED);
    expect.soft(reasonOf(saved), 'saveDataTracked names it').toContain(needle);
    expect.soft(dm.saveData(file, o, { v: 1 }), 'saveData').toBe(false);
    expect.soft(dm.saveDataOutcome(file, o, { v: 1 }), 'saveDataOutcome').toBe('refused');
    expect.soft(dm.saveGlobalData(file, { v: 1 }, category), 'saveGlobalData').toBe(false);

    const deleted = dm.deleteDataTracked(file, o);
    expect.soft(deleted, 'deleteDataTracked').toMatchObject(REFUSED);
    expect.soft(reasonOf(deleted), 'deleteDataTracked names it').toContain(needle);
    expect.soft(dm.deleteData(file, o), 'deleteData').toBe(false);
    expect.soft(dm.deleteDataOutcome(file, o), 'deleteDataOutcome').toBe('refused');

    expect.soft(queuedFilePaths(), 'the file queue').toEqual(queuedBefore);
    expect.soft(dm.unsavedRowPaths(), 'the row queue').toEqual(rowsBefore);
    await dm.flushAll();
    expect.soft(tree(DATA_ROOT), 'the data root').toEqual(before);
    expect.soft(fs.existsSync(GUILD_FILE) && guildFileKept(), 'the guild file').toEqual({ kept: true });

    setBackendKind('file');
    expect.soft(guildKeyStored(GUILD, '_guildConfig/config.json'), 'the guild key record').toBe(true);
    expect.soft(dm.deleteDataOutcome('config.json', GUILD_OPTIONS), 'a guild-scope delete afterwards').toBe('deleted');
    await dm.flushAll();
  });

  it('the one-line module wrappers refuse a module name that leaves the global folder', async () => {
    await plantGuildFile();
    const before = tree(DATA_ROOT);
    expect.soft(dm.loadGlobalModuleData('config.json', INTO_GUILD, { fallback: true }), 'loadGlobalModuleData').toEqual({ fallback: true });
    expect.soft(logged(INTO_GUILD), 'loadGlobalModuleData names it').toBe(true);
    errors = [];
    expect.soft(dm.globalModuleDataExists('config.json', INTO_GUILD), 'globalModuleDataExists').toBe(false);
    expect.soft(logged(INTO_GUILD), 'globalModuleDataExists names it').toBe(true);
    const updated = dm.updateGlobalModuleData<{ v?: number }>('config.json', INTO_GUILD, {}, () => ({ v: 2 }));
    expect.soft(updated, 'updateGlobalModuleData').toMatchObject(REFUSED);
    expect.soft(dm.saveGlobalModuleData('config.json', INTO_GUILD, { v: 1 }), 'saveGlobalModuleData').toBe(false);
    expect.soft(dm.deleteGlobalModuleData('config.json', INTO_GUILD), 'deleteGlobalModuleData').toBe(false);
    expect.soft(queuedFilePaths(), 'the file queue').toEqual(rowStart.queued);
    await dm.flushAll();
    expect.soft(tree(DATA_ROOT), 'the data root').toEqual(before);
  });

  it('on a postgres bot, a category that reaches the root config file makes no row op on its key', () => {
    const category = path.relative(GLOBAL, path.dirname(mirrorPathOf(ROOT_CONFIG_KEY)));
    setBackendKind('postgres');
    const rowsBefore = dm.unsavedRowPaths();
    const o: dm.DataOptions = { scope: 'global', category };
    const saved = dm.saveDataTracked('config.json', o, { v: 1 });
    expect.soft(saved, 'saveDataTracked').toMatchObject(REFUSED);
    expect.soft((saved as { reason?: string }).reason ?? '', 'saveDataTracked names it').toContain(JSON.stringify(category));
    expect.soft(dm.updateData<{ v?: number }>('config.json', o, {}, () => ({ v: 2 })), 'updateData').toMatchObject(REFUSED);
    expect.soft(rowQueue.ops(ROOT_CONFIG_KEY), 'row ops on the root config key').toEqual([]);
    expect.soft(dm.unsavedRowPaths(), 'the row queue').toEqual(rowsBefore);
  });

  it('confirmSaved answers refused after a save whose file name climbs out, with no category given', async () => {
    const mark = dm.saveMark();
    expect.soft(dm.saveDataTracked('../x.json', { scope: 'global' }, { v: 1 }), 'saveDataTracked').toMatchObject(REFUSED);
    expect.soft(await dm.confirmSaved('global', { since: mark }), 'confirmSaved').toBe('refused');
  });

  it.each([
    ['an empty file name', undefined, ''],
    ['a file name "."', undefined, '.'],
    ['a file name ".." under one folder', 'nb40', '..'],
  ])('%s names the global data folder itself and is refused', async (_label, category, file) => {
    const o: dm.DataOptions = { scope: 'global', ...(category === undefined ? {} : { category }) };
    const wanted = `the file name ${JSON.stringify(file)} names the global data folder itself`;
    const before = tree(DATA_ROOT);
    errors = [];
    expect.soft(dm.loadData(file, o, { fallback: true }), 'loadData').toEqual({ fallback: true });
    expect.soft(errors.some(e => e.includes(wanted)), 'loadData gives the reason').toBe(true);
    errors = [];
    expect.soft(dm.dataExists(file, o), 'dataExists').toBe(false);
    expect.soft(errors.some(e => e.includes(wanted)), 'dataExists gives the reason').toBe(true);
    expect.soft(dm.saveDataTracked(file, o, { v: 1 }), 'saveDataTracked').toEqual({ ...REFUSED, reason: wanted });
    expect.soft(dm.deleteDataTracked(file, o), 'deleteDataTracked').toEqual({ ...REFUSED, reason: wanted });
    expect.soft(queuedFilePaths(), 'the file queue').toEqual(rowStart.queued);
    await dm.flushAll();
    expect.soft(tree(DATA_ROOT), 'the data root').toEqual(before);
  });

  it('lists nothing from a guild folder or from above the data root', async () => {
    await plantGuildFile();
    expect.soft(dm.listGlobalDataFiles(INTO_GUILD)).toEqual([]);
    expect.soft(dm.listGlobalDataFiles(`..${path.sep}${GUILD}`)).toEqual([]);
    expect.soft(dm.listGlobalDataFiles('..')).toEqual([]);
    expect.soft(dm.listGlobalDataFiles('../..')).toEqual([]);
    expect.soft(dm.listGlobalDataFiles(path.join(DATA_ROOT, GUILD, '_guildConfig'))).toEqual([]);
    expect.soft(errors.filter(e => e.includes('global data folder') || e.includes('absolute path'))).toHaveLength(5);
  });

  const INSIDE: Array<[string, string, string, string]> = [
    ['one folder', 'nb40', 'nb40-ok', 'global/nb40/nb40-ok'],
    ['inner folders', 'nb40/sub', 'nb40-ok', 'global/nb40/sub/nb40-ok'],
    ['a folder in the file name', 'nb40', 'inner/nb40-ok', 'global/nb40/inner/nb40-ok'],
    ['a category that climbs and stays inside', 'nb40/../nb40b', 'nb40-ok', 'global/nb40b/nb40-ok'],
  ];

  it.each(INSIDE)('a category that stays inside (%s) behaves as before', async (_label, category, name) => {
    const o: dm.DataOptions = { scope: 'global', category };
    const mark = dm.saveMark();
    expect(dm.saveData(`${name}.json`, o, { v: 1 })).toBe(true);
    expect(dm.loadData(`${name}.json`, o, null)).toEqual({ v: 1 });
    expect(dm.dataExists(`${name}.json`, o)).toBe(true);
    expect(dm.updateData<{ v: number }>(`${name}.json`, o, { v: 0 }, c => ({ v: c.v + 1 })).outcome).toBe('saved');
    expect(dm.appendData(`${name}.jsonl`, o, 'x\n')).toBe(true);
    expect(await dm.confirmSaved('global', { since: mark, category })).toBe('ok');
    await dm.flushAll();
    expect(dm.loadData(`${name}.json`, o, null)).toEqual({ v: 2 });
    const folder = path.dirname(path.join(category, `${name}.json`)).split(path.sep).join('/');
    expect(dm.listGlobalDataFiles(folder)).toEqual([`${path.basename(name)}.json`]);
    expect(dm.deleteDataOutcome(`${name}.json`, o)).toBe('deleted');
    expect(dm.deleteData(`${name}.jsonl`, o)).toBe(true);
    await dm.flushAll();
    expect(dm.dataExists(`${name}.json`, o)).toBe(false);
    expect(errors).toEqual([]);
  });

  it.each(INSIDE)('on a postgres bot, a category that stays inside (%s) queues the same key as before', (_label, category, name, key) => {
    setBackendKind('postgres');
    const o: dm.DataOptions = { scope: 'global', category };
    const before = tree(DATA_ROOT);
    const saved = dm.saveDataTracked(`${name}.json`, o, { v: 1 });
    expect(saved.outcome).toBe('saved');
    expect((saved as { ticket: { kind: string; key?: string } }).ticket).toMatchObject({ kind: 'row', key: `${key}.json` });
    expect(dm.loadData(`${name}.json`, o, null)).toEqual({ v: 1 });
    expect(dm.dataExists(`${name}.json`, o)).toBe(true);
    expect(dm.updateData<{ v: number }>(`${name}.json`, o, { v: 0 }, c => ({ v: c.v + 1 })).outcome).toBe('saved');
    expect(dm.loadData(`${name}.json`, o, null)).toEqual({ v: 2 });
    const appended = dm.appendDataTracked(`${name}.jsonl`, o, 'x\n');
    expect(appended.outcome).toBe('appended');
    expect((appended as { ticket: { kind: string; key?: string } }).ticket).toMatchObject({ kind: 'row', key: `${key}.jsonl` });
    expect(dm.deleteDataOutcome(`${name}.json`, o)).toBe('deleted');
    expect(dm.dataExists(`${name}.json`, o)).toBe(false);
    expect(rowQueue.keys().sort()).toEqual([`${key}.json`, `${key}.jsonl`]);
    expect(queuedFilePaths()).toEqual(rowStart.queued);
    expect(tree(DATA_ROOT)).toEqual(before);
    expect(errors).toEqual([]);
  });

  it('lists the global folder itself when no category is given', async () => {
    expect(dm.saveData('nb40-root.json', { scope: 'global' }, { v: 1 })).toBe(true);
    await dm.flushAll();
    expect(dm.listGlobalDataFiles()).toContain('nb40-root.json');
    expect(dm.deleteData('nb40-root.json', { scope: 'global' })).toBe(true);
    await dm.flushAll();
    expect(errors).toEqual([]);
  });
});
