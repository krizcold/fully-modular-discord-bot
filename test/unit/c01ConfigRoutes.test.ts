import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import fc from 'fast-check';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// C01 (wip-fireproof/PLAN.md batch 3; lanes/C01/sheet.md): the Config tab's routes act on their own exact target,
// read the serving process queue first, and keep durable, parseable backups.

const reader = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/webui/utils/webuiDataReader', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/webui/utils/webuiDataReader')>();
  return { ...real, getWebuiDataReader: () => reader.current };
});

import { setBackendKind } from '../helpers/backendKind';
import { deleteRawAtomic, flushAll, writeRawAtomic } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataRead } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { discoverConfigFiles, discoverGlobalDataFiles } from '../../src/bot/internalSetup/utils/configDiscovery';
import { backupMatchesTarget, writeBackup } from '../../src/webui/utils/configBackups';
import { dataPath } from '../../src/utils/dataRoot';
import {
  BACKUPS, FakeChild, backupNames, call, failFlushes, later, put, readJson, resetData, startConfigApp, unreadable,
} from '../helpers/configRig';

const G1 = '111111111111111111';
const G2 = '222222222222222222';
const guildConfig = (g: string) => dataPath(g, '_guildConfig', 'config.json');
const examplesGlobal = () => dataPath('global', 'examples', 'examples-config.json');

const child = new FakeChild();
let base = '';
let close: () => Promise<void>;

beforeAll(async () => {
  ({ url: base, close } = await startConfigApp(child));
});
afterAll(async () => { await close(); });
beforeEach(async () => {
  child.reset();
  reader.current = null;
  setBackendKind(null);
  await resetData();
});

const save = (config: unknown, guildId?: string, file = 'config.json') => call(base, 'POST', '/api/config/update', { file, config, guildId });
// A save the operator makes once the one before it has landed.
const saveLanded = async (config: unknown, guildId?: string, file = 'config.json') => {
  const answer = await save(config, guildId, file);
  await flushAll();
  return answer;
};
const ofGuild = (g: string) => (name: string) => name.startsWith(`config@${g}_`);
const ofGlobal = (name: string) => /^config_(before_restore_)?\d{4}-/.test(name);

describe('backups, restores and prunes act on their own exact target (R1-J12, R8-J8, R33-J2)', () => {
  it('a guild restore writes the guild file, never the global one', async () => {
    put(ROOT_CONFIG_PATH, { who: 'global' });
    expect((await saveLanded({ who: 'g1-v1' }, G1)).status).toBe(200);
    expect((await saveLanded({ who: 'g1-v2' }, G1)).status).toBe(200);
    await flushAll();
    const backup = backupNames().find(ofGuild(G1));
    expect(backup).toBeDefined();
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'config.json', filename: backup, guildId: G1 });
    expect(restored.status).toBe(200);
    await flushAll();
    expect(readJson(guildConfig(G1))).toEqual({ who: 'g1-v1' });
    expect(readJson(ROOT_CONFIG_PATH)).toEqual({ who: 'global' });
  });

  it.each([
    ['the global file', undefined],
    ['another guild', G2],
  ])('a restore into %s refuses a backup of guild one', async (_label, guildId) => {
    put(ROOT_CONFIG_PATH, { who: 'global' });
    put(guildConfig(G2), { who: 'g2' });
    await saveLanded({ who: 'g1-v1' }, G1);
    await saveLanded({ who: 'g1-v2' }, G1);
    await flushAll();
    const backup = backupNames().find(ofGuild(G1));
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'config.json', filename: backup, guildId });
    expect(restored.status).toBe(400);
    await flushAll();
    expect(readJson(ROOT_CONFIG_PATH)).toEqual({ who: 'global' });
    expect(readJson(guildConfig(G2))).toEqual({ who: 'g2' });
  });

  it.each([
    ['global', undefined, ofGlobal],
    ['guild one', G1, ofGuild(G1)],
    ['guild two', G2, ofGuild(G2)],
  ])('/backups for %s lists only that target', async (_label, guildId, mine) => {
    for (const target of [undefined, G1, G2]) {
      await saveLanded({ v: 1 }, target);
      await saveLanded({ v: 2 }, target);
    }
    await flushAll();
    const listed = await call(base, 'GET', `/api/config/backups?file=config.json${guildId ? `&guildId=${guildId}` : ''}`);
    expect(listed.status).toBe(200);
    const names = listed.body.backups.map((b: any) => b.filename);
    expect(names.length).toBe(1);
    expect(names.every(mine)).toBe(true);
  });

  it('a save keeps the last ten backups of its own target and never removes another target\'s (property)', async () => {
    const targets = [undefined, G1, G2];
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 24 }), async order => {
      await resetData();
      const saves = [0, 0, 0];
      for (const [i, which] of order.entries()) {
        const before = backupNames();
        expect((await saveLanded({ i }, targets[which])).status).toBe(200);
        saves[which] += 1;
        const after = backupNames();
        const mine = which === 0 ? ofGlobal : ofGuild(targets[which]!);
        for (const name of before) if (!mine(name)) expect(after, `save ${i} removed ${name}`).toContain(name);
        expect(after.filter(mine).length).toBe(Math.min(saves[which] - 1, 10));
      }
    }), { numRuns: 6, examples: [[[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]]] });
  }, 180_000);

  it('keeps core-owned global stores out of the Config list and refuses to write them', async () => {
    put(dataPath('global', 'premium-tiers.json'), { tiers: { gold: {} } });
    put(dataPath('global', 'persistent-panels.json'), { panels: [] });
    const listed = await call(base, 'GET', '/api/config/list');
    const ids = listed.body.files.map((f: any) => f.id);
    expect(ids).not.toContain('premium-tiers.json');
    expect(ids).not.toContain('persistent-panels.json');
    const written = await save({ tiers: {} }, undefined, 'premium-tiers.json');
    expect(written.status).toBe(400);
    expect(written.body.error).toMatch(/Premium/);
    await flushAll();
    expect(readJson(dataPath('global', 'premium-tiers.json'))).toEqual({ tiers: { gold: {} } });
    expect((await call(base, 'GET', '/api/config/get?file=premium-tiers.json')).status).not.toBe(200);
  });

  it('answers 404 not a config file for a schema-less, moduleless id', async () => {
    put(dataPath('global', 'mod', 'orphan.json'), { a: 1 });
    const got = await call(base, 'GET', `/api/config/get?file=${encodeURIComponent('mod/orphan.json')}`);
    expect(got.status).toBe(404);
    expect(got.body.error).toMatch(/not a config file/);
  });
});

describe('one backup helper: queue-first source, durable write, parse before restore (R10-J15, R46-J5, R50-J2)', () => {
  it('a save right after another backs up the first save\'s body, still queued', async () => {
    put(ROOT_CONFIG_PATH, { v: 'disk' });
    expect((await save({ v: 'first' })).status).toBe(200);
    expect((await save({ v: 'second' })).status).toBe(200);
    const bodies = backupNames().filter(ofGlobal).map(name => readJson(path.join(BACKUPS(), name)));
    expect(bodies).toContainEqual({ v: 'first' });
  });

  it('a save backs up the newest accepted body, which the serving child holds', async () => {
    put(ROOT_CONFIG_PATH, { v: 'disk-old' });
    child.global = req => (req.root === 'config' ? { ok: true, contentJson: JSON.stringify({ v: 'child-new' }), pending: false } : undefined);
    expect((await save({ v: 'next' })).status).toBe(200);
    const backup = backupNames().find(ofGlobal);
    expect(backup).toBeDefined();
    expect(readJson(path.join(BACKUPS(), backup!))).toEqual({ v: 'child-new' });
  });

  it('a restore\'s undo copy holds the newest accepted body of its own target', async () => {
    put(examplesGlobal(), { 'ping.customMessage': 'disk-old' });
    put(path.join(BACKUPS(), 'examples-config_2026-01-01T00-00-00-000Z.json'), { 'ping.customMessage': 'restored' });
    child.global = req => (req.rel === 'examples/examples-config.json'
      ? { ok: true, contentJson: JSON.stringify({ 'ping.customMessage': 'child-new' }), pending: false }
      : undefined);
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'examples-config.json', filename: 'examples-config_2026-01-01T00-00-00-000Z.json' });
    expect(restored.status).toBe(200);
    const undo = backupNames().find(name => name.startsWith('examples-config_before_restore_'));
    expect(undo).toBeDefined();
    expect(readJson(path.join(BACKUPS(), undo!))).toEqual({ 'ping.customMessage': 'child-new' });
  });

  it.each([
    ['a save', () => save({ v: 'mine' })],
    ['a restore', () => call(base, 'POST', '/api/config/restore', { file: 'config.json', filename: 'config_2026-01-01T00-00-00-000Z.json' })],
  ])('%s of a global file refuses while the child still holds a queued write of it', async (_label, act) => {
    put(ROOT_CONFIG_PATH, { v: 'disk' });
    put(path.join(BACKUPS(), 'config_2026-01-01T00-00-00-000Z.json'), { v: 'old' });
    child.global = req => (req.root === 'config' ? { ok: true, contentJson: JSON.stringify({ v: 'child-queued' }), pending: true } : undefined);
    const answer = await act();
    expect(answer.status).toBe(409);
    await flushAll();
    expect(readJson(ROOT_CONFIG_PATH)).toEqual({ v: 'disk' });
    expect(backupNames()).toEqual(['config_2026-01-01T00-00-00-000Z.json']);
  });

  it('writes a backup through a temp file that is fsynced, then renamed, before it answers', async () => {
    put(ROOT_CONFIG_PATH, { v: 1 });
    const opened = new Map<number, string>();
    const synced: string[] = [];
    const renamed: Array<[string, string]> = [];
    const realOpen = fs.openSync;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: any[]) => {
      const fd = (realOpen as any)(p, ...rest);
      opened.set(fd, String(p));
      return fd;
    }) as typeof fs.openSync);
    const realFsync = fs.fsyncSync;
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => { synced.push(opened.get(fd) ?? '?'); realFsync(fd); });
    const realRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from: fs.PathLike, to: fs.PathLike) => { renamed.push([String(from), String(to)]); realRename(from, to); });
    syncBuiltinESMExports();
    try {
      expect((await save({ v: 2 })).status).toBe(200);
    } finally {
      openSpy.mockRestore();
      fsyncSpy.mockRestore();
      renameSpy.mockRestore();
      syncBuiltinESMExports();
    }
    const backup = backupNames().find(ofGlobal)!;
    const into = renamed.find(([, to]) => to === path.join(BACKUPS(), backup));
    expect(into).toBeDefined();
    expect(synced).toContain(into![0]);
  });

  it('refuses to restore a backup that does not parse, and leaves the file as it was', async () => {
    put(ROOT_CONFIG_PATH, { v: 'kept' });
    put(path.join(BACKUPS(), 'config_2026-01-01T00-00-00-000Z.json'), '{"v": "torn');
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'config.json', filename: 'config_2026-01-01T00-00-00-000Z.json' });
    expect(restored.status).toBe(422);
    await flushAll();
    expect(readJson(ROOT_CONFIG_PATH)).toEqual({ v: 'kept' });
  });

  it('marks damaged backups, and neither counts nor removes them in the keep-ten prune', async () => {
    const damaged = ['config_2020-01-01T00-00-00-000Z.json', 'config_2020-01-02T00-00-00-000Z.json', 'config_2020-01-03T00-00-00-000Z.json'];
    for (const name of damaged) put(path.join(BACKUPS(), name), 'not json');
    put(ROOT_CONFIG_PATH, { i: -1 });
    for (let i = 0; i < 12; i++) expect((await saveLanded({ i })).status).toBe(200);
    const names = backupNames();
    for (const name of damaged) expect(names).toContain(name);
    expect(names.filter(name => ofGlobal(name) && !damaged.includes(name)).length).toBe(10);
    const listed = await call(base, 'GET', '/api/config/backups?file=config.json');
    const rows = listed.body.backups as any[];
    expect(rows.filter(r => r.damaged).map(r => r.filename).sort()).toEqual(damaged);
  });
});

describe('config and data reads come from the serving process, queue first (R34-J1, R49-J3, R52-J1, R53-J1)', () => {
  it('reads a postgres-routed guild\'s config from the child, never an empty merge', async () => {
    setBackendKind('postgres');
    child.guild = req => (req.module === '_guildConfig' && req.filename === 'config.json' ? { ok: true, contentJson: JSON.stringify({ who: 'child' }) } : undefined);
    const got = await call(base, 'GET', `/api/config/get?file=config.json&guildId=${G1}`);
    expect(got.status).toBe(200);
    expect(got.body.config.who).toBe('child');
    expect(got.body.initialized).toBe(true);
  });

  it('reads a file-routed guild\'s config from the child\'s queue, not this process\'s disk', async () => {
    put(guildConfig(G1), { who: 'disk' });
    child.guild = req => (req.module === '_guildConfig' ? { ok: true, contentJson: JSON.stringify({ who: 'child' }) } : undefined);
    const got = await call(base, 'GET', `/api/config/get?file=config.json&guildId=${G1}`);
    expect(got.body.config.who).toBe('child');
  });

  it('reads a global config from the child while the bot runs', async () => {
    put(ROOT_CONFIG_PATH, { who: 'disk' });
    child.global = req => (req.root === 'config' ? { ok: true, contentJson: JSON.stringify({ who: 'child' }), pending: true } : undefined);
    const got = await call(base, 'GET', '/api/config/get?file=config.json');
    expect(got.body.config.who).toBe('child');
  });

  it('labels a read made while the bot is not running', async () => {
    put(ROOT_CONFIG_PATH, { who: 'disk' });
    child.running = false;
    const got = await call(base, 'GET', '/api/config/get?file=config.json');
    expect(got.status).toBe(200);
    expect(got.body.config.who).toBe('disk');
    expect(got.body.notice).toMatch(/not running/);
  });

  it('answers 503 when the serving process refuses the read, never an empty editor', async () => {
    setBackendKind('postgres');
    child.guild = () => ({ ok: false, code: 'backend-unavailable', error: 'guild data is not ready' });
    const got = await call(base, 'GET', `/api/config/get?file=config.json&guildId=${G1}`);
    expect(got.status).toBe(503);
  });

  it('reads a postgres-routed guild\'s data file through the child, not the database reader', async () => {
    setBackendKind('postgres');
    reader.current = { exists: async () => true, readDoc: async () => JSON.stringify({ v: 'database-old' }) };
    child.guild = req => (req.module === 'mod' && req.filename === 'x.json' ? { ok: true, contentJson: JSON.stringify({ v: 'child-new' }) } : undefined);
    const got = await call(base, 'GET', `/api/config/data/get?file=${encodeURIComponent('mod/x.json')}&guildId=${G1}`);
    expect(got.status).toBe(200);
    expect(got.body.data).toEqual({ v: 'child-new' });
    expect(got.body.exists).toBe(true);
  });

  it('falls back to the database reader only while the bot is down, and says so', async () => {
    setBackendKind('postgres');
    child.running = false;
    reader.current = { exists: async () => true, readDoc: async () => JSON.stringify({ v: 'database' }) };
    const got = await call(base, 'GET', `/api/config/data/get?file=${encodeURIComponent('mod/x.json')}&guildId=${G1}`);
    expect(got.status).toBe(200);
    expect(got.body.data).toEqual({ v: 'database' });
    expect(got.body.notice).toMatch(/not running/);
  });

  it('reads a global data file from the child while the bot runs', async () => {
    put(dataPath('global', 'mod', 'x.json'), { v: 'disk' });
    child.global = req => (req.rel === 'mod/x.json' ? { ok: true, contentJson: JSON.stringify({ v: 'child' }), pending: true } : undefined);
    const got = await call(base, 'GET', `/api/config/data/get?file=${encodeURIComponent('mod/x.json')}`);
    expect(got.body.data).toEqual({ v: 'child' });
  });

  it('refuses an ambiguous bare global data id and serves the module-qualified one; a bare guild key is the root doc (C01-R4-3)', async () => {
    put(dataPath('global', 'a', 'x.json'), { from: 'a' });
    put(dataPath('global', 'b', 'x.json'), { from: 'b' });
    expect((await call(base, 'GET', '/api/config/data/get?file=x.json')).status).toBe(400);
    expect((await call(base, 'GET', `/api/config/data/get?file=${encodeURIComponent('b/x.json')}`)).body.data).toEqual({ from: 'b' });
    put(dataPath(G1, 'a', 'x.json'), { from: 'a' });
    put(dataPath(G1, 'b', 'x.json'), { from: 'b' });
    put(dataPath(G1, 'x.json'), { from: 'root' });
    expect((await call(base, 'GET', `/api/config/data/get?file=x.json&guildId=${G1}`)).body.data).toEqual({ from: 'root' });
    const got = await call(base, 'GET', `/api/config/data/get?file=${encodeURIComponent('b/x.json')}&guildId=${G1}`);
    expect(got.body.data).toEqual({ from: 'b' });
  });

  it('leaves underscore (internal) modules out of a postgres-routed guild\'s listing', async () => {
    setBackendKind('postgres');
    reader.current = {
      exists: async () => false,
      listModules: async () => ['_hardLimits', 'mod'],
      listFiles: async (_g: string, module?: string) => (module === '_hardLimits' ? ['caps.json'] : module === 'mod' ? ['y.json'] : []),
    };
    const listed = await call(base, 'GET', `/api/config/list?guildId=${G1}`);
    expect(listed.status).toBe(200);
    const modules = listed.body.files.map((f: any) => f.moduleName);
    expect(modules).toContain('mod');
    expect(modules).not.toContain('_hardLimits');
  });

  it('computes the global exists flags queue first', () => {
    writeRawAtomic(examplesGlobal(), '{}');
    expect(discoverConfigFiles().find(f => f.id === 'examples-config.json')!.exists).toBe(true);
  });

  it('does not count a global data file whose delete is queued', async () => {
    put(dataPath('global', 'mod', 'gone.json'), { v: 1 });
    deleteRawAtomic(dataPath('global', 'mod', 'gone.json'));
    expect(discoverGlobalDataFiles().some(f => f.moduleName === 'mod' && f.id === 'gone.json')).toBe(false);
    await flushAll();
  });
});

describe("the child's queue-first global read (data:global-read)", () => {
  it('answers the queued body with its pending flag, and refuses paths outside the config surfaces', async () => {
    const { applyOperatorGlobalRead } = await import('../../src/bot/internalSetup/utils/ipcDataHandler');
    put(dataPath('global', 'mod', 'q.json'), { v: 'disk' });
    writeRawAtomic(dataPath('global', 'mod', 'q.json'), JSON.stringify({ v: 'queued' }));
    expect(applyOperatorGlobalRead({ rel: 'mod/q.json' })).toEqual({ ok: true, contentJson: JSON.stringify({ v: 'queued' }), pending: true, failing: false });
    await flushAll();
    expect(applyOperatorGlobalRead({ rel: 'mod/q.json' })).toEqual({ ok: true, contentJson: JSON.stringify({ v: 'queued' }), pending: false, failing: false });
    expect(applyOperatorGlobalRead({ rel: 'mod/none.json' })).toEqual({ ok: true, pending: false, failing: false });
    for (const rel of ['../secret.json', 'appstore/installed.json', 'payment-providers/x.json', 'premium-tiers.json', 'mod/q.txt', '/abs.json']) {
      expect(applyOperatorGlobalRead({ rel }).ok, rel).toBe(false);
    }
  });
});

// Review round 1 on C01 (lanes/C01/sheet.md, findings C01-R1-1 to C01-R1-8).
describe('review round 1', () => {
  const STAMP_NAME = (stem: string) => `${stem}_2026-01-01T00-00-00-000Z.json`;
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  type Answer = Awaited<ReturnType<typeof call>>;

  it.each([
    ['running', true],
    ['down', false],
  ])('C01-R1-1: a save of a file that exists but cannot be read is refused, never taken for absent (bot %s)', async (_label, running) => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    child.running = running;
    const undo = unreadable(ROOT_CONFIG_PATH);
    let answer: Answer;
    try {
      answer = await save({ b: 2 });
    } finally {
      undo();
    }
    await flushAll();
    expect(answer.status).toBe(500);
    expect(answer.body.error).toMatch(/could not be read/);
    expect(readJson(ROOT_CONFIG_PATH)).toEqual({ a: 1 });
    expect(backupNames()).toEqual([]);
  });

  it.each([
    ['a guild config save', () => save({ b: 2 }, G1), () => guildConfig(G1)],
    ['a global data save', () => call(base, 'POST', '/api/config/data/update', { file: 'mod/x.json', data: { b: 2 } }), () => dataPath('global', 'mod', 'x.json')],
  ])('C01-R1-1: %s of a file that cannot be read is refused', async (_label, act, target) => {
    put(target(), { a: 1 });
    const undo = unreadable(target());
    let answer: Answer;
    try {
      answer = await act();
    } finally {
      undo();
    }
    await flushAll();
    expect(answer.status).toBe(500);
    expect(readJson(target())).toEqual({ a: 1 });
    expect(backupNames()).toEqual([]);
  });

  it('C01-R1-1: the editor answers an error, never an empty merge, for a file that cannot be read', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    const undo = unreadable(ROOT_CONFIG_PATH);
    let got: Answer;
    try {
      got = await call(base, 'GET', '/api/config/get?file=config.json');
    } finally {
      undo();
    }
    expect(got.status).toBe(500);
    expect(got.body.error).toMatch(/could not be read/);
  });

  it('C01-R1-2: two saves of one file made together each back up the body before them', async () => {
    put(ROOT_CONFIG_PATH, { v: 'disk' });
    // A child in its own process: it sees the disk, never this process's queue, and answers late.
    child.global = req => (req.root === 'config'
      ? later(30, () => ({ ok: true, contentJson: fs.readFileSync(ROOT_CONFIG_PATH, 'utf-8'), pending: false }))
      : undefined);
    const [first, second] = await Promise.all([save({ v: 'Y' }), save({ v: 'Z' })]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await flushAll();
    const bodies = backupNames().map(name => readJson(path.join(BACKUPS(), name)));
    const landed = readJson(ROOT_CONFIG_PATH);
    // The save that landed last backed up the one before it.
    expect(bodies).toContainEqual(landed.v === 'Z' ? { v: 'Y' } : { v: 'Z' });
  });

  it('C01-R1-4: a file-routed guild read shows this process\'s own queued write, and a save backs it up', async () => {
    put(guildConfig(G1), { who: 'disk' });
    const undo = failFlushes(guildConfig(G1));
    try {
      writeRawAtomic(guildConfig(G1), JSON.stringify({ who: 'queued' }));
      await settle();
      // The child is another process: it reads the disk, and holds no write of this file.
      child.guild = req => (req.module === '_guildConfig'
        ? { ok: true, contentJson: fs.readFileSync(guildConfig(G1), 'utf-8'), pending: false }
        : undefined);
      const got = await call(base, 'GET', `/api/config/get?file=config.json&guildId=${G1}`);
      expect(got.status).toBe(200);
      expect(got.body.config.who).toBe('queued');
      expect((await save({ who: 'next' }, G1)).status).toBe(200);
      const bodies = backupNames().map(name => readJson(path.join(BACKUPS(), name)));
      expect(bodies).toContainEqual({ who: 'queued' });
    } finally {
      undo();
      await flushAll();
    }
  });

  it('C01-R1-4: a file-routed guild save refuses while both processes hold a queued write of it', async () => {
    put(guildConfig(G1), { who: 'disk' });
    const undo = failFlushes(guildConfig(G1));
    try {
      writeRawAtomic(guildConfig(G1), JSON.stringify({ who: 'queued-here' }));
      await settle();
      child.guild = req => (req.module === '_guildConfig'
        ? { ok: true, contentJson: JSON.stringify({ who: 'queued-in-child' }), pending: true }
        : undefined);
      expect((await save({ who: 'next' }, G1)).status).toBe(409);
    } finally {
      undo();
      await flushAll();
    }
  });

  it('C01-R1-5: lists and restores a module data file\'s backups named before backups carried the module', async () => {
    put(dataPath(G1, 'mod', 'x.json'), { v: 'now' });
    const legacy = STAMP_NAME(`x_${G1}`);
    put(path.join(BACKUPS(), legacy), { v: 'legacy' });
    const listed = await call(base, 'GET', `/api/config/backups?file=${encodeURIComponent('mod/x.json')}&guildId=${G1}&category=data`);
    expect(listed.status).toBe(200);
    const row = listed.body.backups.find((b: any) => b.filename === legacy);
    expect(row).toBeDefined();
    expect(row.legacy).toBe(true);
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'mod/x.json', filename: legacy, guildId: G1, category: 'data' });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    await flushAll();
    expect(readJson(dataPath(G1, 'mod', 'x.json'))).toEqual({ v: 'legacy' });
  });

  it('C01-R1-5: lists an older backup two modules could own, and refuses to restore it', async () => {
    put(dataPath(G1, 'a', 'x.json'), { from: 'a' });
    put(dataPath(G1, 'b', 'x.json'), { from: 'b' });
    const legacy = STAMP_NAME(`x_${G1}`);
    put(path.join(BACKUPS(), legacy), { from: 'legacy' });
    const listed = await call(base, 'GET', `/api/config/backups?file=${encodeURIComponent('a/x.json')}&guildId=${G1}&category=data`);
    const row = listed.body.backups.find((b: any) => b.filename === legacy);
    expect(row).toBeDefined();
    expect(row.shared).toBe(true);
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'a/x.json', filename: legacy, guildId: G1, category: 'data' });
    expect(restored.status).toBe(409);
    await flushAll();
    expect(readJson(dataPath(G1, 'a', 'x.json'))).toEqual({ from: 'a' });
  });

  it('C01-R1-5: a save never prunes the backups named before backups carried the module', async () => {
    put(dataPath(G1, 'mod', 'x.json'), { v: -1 });
    const legacy = STAMP_NAME(`x_${G1}`);
    put(path.join(BACKUPS(), legacy), { v: 'legacy' });
    for (let i = 0; i < 12; i++) {
      expect((await call(base, 'POST', '/api/config/data/update', { file: 'mod/x.json', data: { v: i }, guildId: G1 })).status).toBe(200);
      await flushAll();
    }
    expect(backupNames()).toContain(legacy);
  });

  it.each([
    ['a global key that extends a guild key', ['mod/cache.json', '123456789'], ['mod/cache_123456789.json', null]],
    ['a guild key against the global key that names it', ['a_123456789.json', null], ['a.json', '123456789']],
  ])('C01-R1-6: one target\'s prune never deletes another\'s backups (%s)', (_label, kept, pruning) => {
    const dir = BACKUPS();
    const mine = [0, 1, 2].map(() => writeBackup(dir, kept[0] as string, kept[1] as string | null, '{}').filename);
    for (let i = 0; i < 11; i++) writeBackup(dir, pruning[0] as string, pruning[1] as string | null, '{}');
    for (const name of mine) expect(backupNames()).toContain(name);
  });

  it('C01-R1-6: a backup name matches only the target that wrote it (every pair of a key pool)', () => {
    const keys = ['a.json', 'a_123456.json', 'a_1234567.json', 'mod/a.json', 'mod/a_123456.json', 'mod+a.json', 'a@123456.json', 'a@1234567.json'];
    const guilds = [null, '123456', '1234567'];
    const owners = keys.flatMap(key => guilds.map(guildId => ({ key, guildId })));
    const written = owners.map(owner => ({ owner, name: writeBackup(BACKUPS(), owner.key, owner.guildId, '{}').filename }));
    for (const { owner, name } of written) {
      for (const other of owners) {
        const same = other.key === owner.key && other.guildId === owner.guildId;
        expect(backupMatchesTarget(name, other.key, other.guildId), `${name} against ${other.key} ${other.guildId}`).toBe(same);
      }
    }
  });

  it('C01-R1-8: a save refused because the bot keeps failing to write the file says so, without a promise of a moment', async () => {
    put(ROOT_CONFIG_PATH, { v: 'disk' });
    child.global = req => (req.root === 'config' ? { ok: true, contentJson: JSON.stringify({ v: 'stuck' }), pending: true, failing: true } : undefined);
    const answer = await save({ v: 'mine' });
    expect(answer.status).toBe(409);
    expect(answer.body.error).not.toMatch(/in a moment/);
    expect(answer.body.error).toMatch(/not been able to write/);
  });
});

// Review round 2 on C01 (lanes/C01/sheet.md, findings C01-R2-1, R2-3, R2-5, R2-6 and the refuter's notes M-R2-B, M-R2-C).
describe('review round 2', () => {
  const nested = () => dataPath(G1, 'mod', 'sub', 'x.json');
  const KEY = encodeURIComponent('mod/x.json');

  it('C01-R2-1: the editor reads a file-routed guild data file in a subfolder from that file', async () => {
    put(nested(), { a: 1 });
    const got = await call(base, 'GET', `/api/config/data/get?file=${KEY}&guildId=${G1}`);
    expect(got.status).toBe(200);
    expect(got.body.exists).toBe(true);
    expect(got.body.data).toEqual({ a: 1 });
  });

  it('C01-R2-1: a save of a guild data file in a subfolder backs up the body it replaces', async () => {
    put(nested(), { a: 1 });
    const saved = await call(base, 'POST', '/api/config/data/update', { file: 'mod/x.json', data: { b: 2 }, guildId: G1 });
    expect(saved.status).toBe(200);
    await flushAll();
    expect(readJson(nested())).toEqual({ b: 2 });
    const listed = await call(base, 'GET', `/api/config/backups?file=${KEY}&guildId=${G1}&category=data`);
    const bodies = listed.body.backups.map((b: any) => readJson(path.join(BACKUPS(), b.filename)));
    expect(bodies).toEqual([{ a: 1 }]);
  });

  it('C01-R2-1: a restore of a guild data file in a subfolder keeps an undo copy of the body it replaces', async () => {
    put(nested(), { a: 1 });
    expect((await call(base, 'POST', '/api/config/data/update', { file: 'mod/x.json', data: { b: 2 }, guildId: G1 })).status).toBe(200);
    await flushAll();
    const listed = await call(base, 'GET', `/api/config/backups?file=${KEY}&guildId=${G1}&category=data`);
    expect(listed.body.backups.length).toBe(1);
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'mod/x.json', filename: listed.body.backups[0].filename, guildId: G1, category: 'data' });
    expect(restored.status).toBe(200);
    await flushAll();
    expect(readJson(nested())).toEqual({ a: 1 });
    const undo = backupNames().filter(name => name.includes('before_restore'));
    expect(undo.map(name => readJson(path.join(BACKUPS(), name)))).toEqual([{ b: 2 }]);
  });

  it('M-R2-C: a delete of a guild data file in a subfolder names that file to the child', async () => {
    put(nested(), { a: 1 });
    const deleted = await call(base, 'POST', '/api/config/data/delete', { file: 'mod/x.json', guildId: G1 });
    expect(deleted.status).toBe(200);
    expect(child.writes.map(w => [w.module, w.filename, w.op])).toEqual([['mod', 'sub/x.json', 'delete']]);
  });

  // The real BotManager read, over a child that never answers (a short timeout in place of its 15 s).
  async function silentChildRead(method: 'readGlobalData' | 'readGuildData', req: any) {
    const { BotManager } = await import('../../src/webui/botManager');
    const proto = BotManager.prototype as any;
    const silent: any = {
      isRunning: () => true,
      botProcess: { on: () => undefined, removeListener: () => undefined, send: () => undefined },
      pendingIpcRejects: new Set(),
    };
    silent.sendIPCMessage = (type: string, data: any) => proto.sendIPCMessage.call(silent, type, data, 20);
    return proto[method].call(silent, req);
  }

  it.each([
    ['a global config save', () => save({ v: 'mine' }), () => ROOT_CONFIG_PATH],
    ['a guild data save', () => call(base, 'POST', '/api/config/data/update', { file: 'mod/x.json', data: { v: 'mine' }, guildId: G1 }), () => dataPath(G1, 'mod', 'x.json')],
  ])('C01-R2-3: %s whose serving read gets no answer says nothing was changed, never that it may still complete', async (_label, act, target) => {
    put(target(), { v: 'disk' });
    child.global = req => silentChildRead('readGlobalData', req);
    child.guild = req => silentChildRead('readGuildData', req);
    const answer = await act();
    await flushAll();
    expect(answer.body.error).not.toMatch(/may still complete/);
    expect(answer.body.error).toMatch(/did not answer/);
    expect(answer.body.error).toMatch(/nothing was changed/);
    expect(answer.status).toBe(503);
    expect(readJson(target())).toEqual({ v: 'disk' });
    expect(backupNames()).toEqual([]);
  });

  const OLDER = 'examples-config_2026-01-01T00-00-00-000Z.json';

  it('C01-R2-5: an older backup a config file and a data file of the same name could own is shared, for the data file', async () => {
    put(dataPath('global', 'b', 'examples-config.json'), { from: 'data' });
    put(path.join(BACKUPS(), OLDER), { from: 'older' });
    const listed = await call(base, 'GET', `/api/config/backups?file=${encodeURIComponent('b/examples-config.json')}&category=data`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const row = listed.body.backups.find((b: any) => b.filename === OLDER);
    expect(row).toBeDefined();
    expect(row.shared).toBe(true);
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'b/examples-config.json', filename: OLDER, category: 'data' });
    expect(restored.status).toBe(409);
    await flushAll();
    expect(readJson(dataPath('global', 'b', 'examples-config.json'))).toEqual({ from: 'data' });
  });

  it('C01-R2-5: an older backup a config file and a data file of the same name could own is shared, for the config file', async () => {
    put(examplesGlobal(), { 'ping.customMessage': 'now' });
    put(dataPath('global', 'b', 'examples-config.json'), { from: 'data' });
    put(path.join(BACKUPS(), OLDER), { from: 'older' });
    const listed = await call(base, 'GET', '/api/config/backups?file=examples-config.json');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const row = listed.body.backups.find((b: any) => b.filename === OLDER);
    expect(row).toBeDefined();
    expect(row.shared).toBe(true);
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'examples-config.json', filename: OLDER });
    expect(restored.status).toBe(409);
    await flushAll();
    expect(readJson(examplesGlobal())).toEqual({ 'ping.customMessage': 'now' });
  });

  it('C01-R2-6: a backup that cannot be read just now is not called damaged', async () => {
    put(ROOT_CONFIG_PATH, { v: 1 });
    expect((await saveLanded({ v: 2 })).status).toBe(200);
    const name = backupNames().find(ofGlobal)!;
    const undo = unreadable(path.join(BACKUPS(), name));
    let listed: Answer;
    try {
      listed = await call(base, 'GET', '/api/config/backups?file=config.json');
    } finally {
      undo();
    }
    const row = listed.body.backups.find((b: any) => b.filename === name);
    expect(row.damaged).toBe(false);
    expect(row.unreadable).toBe(true);
  });

  it('M-R2-B: a backup name matches only the target that wrote it (stems ending in the restore marker, characters past Latin-1)', () => {
    const wide = `a${String.fromCharCode(0x202d)}.json`;
    const keys = ['x.json', 'x_before_restore.json', 'mod/x.json', 'mod/x_before_restore.json', 'a 2D.json', wide, 'a%202D.json'];
    const guilds = [null, '123456'];
    const owners = keys.flatMap(key => guilds.map(guildId => ({ key, guildId })));
    const written = owners.flatMap(owner => [false, true].map(beforeRestore => ({ owner, name: writeBackup(BACKUPS(), owner.key, owner.guildId, '{}', beforeRestore).filename })));
    for (const { owner, name } of written) {
      for (const other of owners) {
        const same = other.key === owner.key && other.guildId === owner.guildId;
        expect(backupMatchesTarget(name, other.key, other.guildId), `${name} against ${other.key} ${other.guildId}`).toBe(same);
      }
    }
  });
});

// Review round 3 on C01 (lanes/C01/sheet.md, findings C01-R3-1 to R3-4 and the refuter's notes M-R3-A, M-R3-B).
describe('review round 3', () => {
  const KEY = encodeURIComponent('mod/x.json');
  const OLDER = (stem: string) => `${stem}_2026-01-01T00-00-00-000Z.json`;

  // A postgres-routed guild whose database holds both a top-level and a nested doc, and whose disk holds only a
  // leftover in a subfolder: the panel lists the top-level doc, so every route names that doc to the child.
  function postgresWithNestedLeftover() {
    setBackendKind('postgres');
    put(dataPath('.backend.json'), { live: 'postgres', storeId: null, flippedAt: 0 });
    put(dataPath(G1, 'mod', 'sub', 'x.json'), { disk: 1 });
    const docs: Record<string, unknown> = { 'mod|x.json': { db: 'top' }, 'mod|sub/x.json': { db: 'nested' } };
    child.guild = req => {
      const doc = docs[`${req.module}|${req.filename}`];
      return doc === undefined ? { ok: true } : { ok: true, contentJson: JSON.stringify(doc) };
    };
  }
  const hops = () => child.writes.map(w => [w.module, w.filename, w.op]);

  it('C01-R3-1: the editor reads a postgres doc the panel listed, not a nested doc a disk leftover names', async () => {
    postgresWithNestedLeftover();
    const got = await call(base, 'GET', `/api/config/data/get?file=${KEY}&guildId=${G1}`);
    expect(got.status).toBe(200);
    expect(got.body.data).toEqual({ db: 'top' });
  });

  it('C01-R3-1: a save of a postgres doc writes and backs up that doc', async () => {
    postgresWithNestedLeftover();
    const saved = await call(base, 'POST', '/api/config/data/update', { file: 'mod/x.json', data: { v: 2 }, guildId: G1 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(hops()).toEqual([['mod', 'x.json', 'write']]);
    expect(backupNames().map(name => readJson(path.join(BACKUPS(), name)))).toEqual([{ db: 'top' }]);
  });

  it('M-R3-A: a restore of a postgres doc keeps an undo copy of that doc and writes it', async () => {
    postgresWithNestedLeftover();
    const name = writeBackup(BACKUPS(), 'mod/x.json', G1, JSON.stringify({ old: 1 })).filename;
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'mod/x.json', filename: name, guildId: G1, category: 'data' });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(hops()).toEqual([['mod', 'x.json', 'write']]);
    const undo = backupNames().filter(n => n.includes('before_restore'));
    expect(undo.map(n => readJson(path.join(BACKUPS(), n)))).toEqual([{ db: 'top' }]);
  });

  it('C01-R3-1: a delete of a postgres doc names that doc to the child', async () => {
    postgresWithNestedLeftover();
    const deleted = await call(base, 'POST', '/api/config/data/delete', { file: 'mod/x.json', guildId: G1 });
    expect(deleted.status).toBe(200);
    expect(hops()).toEqual([['mod', 'x.json', 'delete']]);
  });

  it.each([
    ['a file-routed guild', G1],
    ['the global scope', null],
  ])('C01-R3-2: the backups of a file in a subfolder stay its own when a same-named file takes the key (%s)', async (_label, guildId) => {
    const at = (...parts: string[]) => (guildId ? dataPath(guildId, 'mod', ...parts) : dataPath('global', 'mod', ...parts));
    const q = guildId ? `&guildId=${guildId}` : '';
    put(at('z', 'x.json'), { n: 1 });
    const first = await call(base, 'POST', '/api/config/data/update', { file: 'mod/x.json', data: { n: 2 }, guildId });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await flushAll();
    const nestedBackups = backupNames();
    expect(nestedBackups.length).toBe(1);
    put(at('x.json'), { t: 1 });
    const got = await call(base, 'GET', `/api/config/data/get?file=${KEY}${q}`);
    expect(got.body.data, 'the key now names the top-level file').toEqual({ t: 1 });
    const listed = await call(base, 'GET', `/api/config/backups?file=${KEY}${q}&category=data`);
    expect(listed.body.backups.map((b: any) => b.filename)).not.toContain(nestedBackups[0]);
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'mod/x.json', filename: nestedBackups[0], guildId, category: 'data' });
    expect(restored.status).toBe(400);
    await flushAll();
    expect(readJson(at('x.json'))).toEqual({ t: 1 });
    for (let i = 0; i < 11; i++) {
      expect((await call(base, 'POST', '/api/config/data/update', { file: 'mod/x.json', data: { t: i + 2 }, guildId })).status).toBe(200);
      await flushAll();
    }
    expect(backupNames()).toContain(nestedBackups[0]);
  });

  it.each([
    ['file', () => undefined],
    ['postgres', () => setBackendKind('postgres')],
  ])('C01-R3-3: an older backup of a data file no discovery lists is not said to share its name with another file (%s route)', async (_label, route) => {
    route();
    const older = OLDER(`x_${G1}`);
    put(path.join(BACKUPS(), older), { v: 'older' });
    const listed = await call(base, 'GET', `/api/config/backups?file=${KEY}&guildId=${G1}&category=data`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const row = listed.body.backups.find((b: any) => b.filename === older);
    expect(row).toBeDefined();
    expect(row.unchecked).toBe(true);
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'mod/x.json', filename: older, guildId: G1, category: 'data' });
    expect(restored.status).toBe(409);
    expect(restored.body.error).not.toMatch(/another file also has/);
    expect(restored.body.error).toMatch(/cannot be checked/);
  });

  it('C01-R3-3: an older backup another module\'s file could own still says so', async () => {
    put(dataPath(G1, 'a', 'x.json'), { from: 'a' });
    put(dataPath(G1, 'b', 'x.json'), { from: 'b' });
    const older = OLDER(`x_${G1}`);
    put(path.join(BACKUPS(), older), { v: 'older' });
    const listed = await call(base, 'GET', `/api/config/backups?file=${encodeURIComponent('a/x.json')}&guildId=${G1}&category=data`);
    const row = listed.body.backups.find((b: any) => b.filename === older);
    expect(row.shared).toBe(true);
    expect(row.unchecked).toBe(false);
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'a/x.json', filename: older, guildId: G1, category: 'data' });
    expect(restored.body.error).toMatch(/another file also has/);
  });

  // The real BotManager read over a child that never answers, or that exits before it answers.
  async function childRead(method: 'readGlobalData' | 'readGuildData', req: any, exits: boolean) {
    const { BotManager } = await import('../../src/webui/botManager');
    const proto = BotManager.prototype as any;
    const silent: any = {
      isRunning: () => true,
      botProcess: { on: () => undefined, removeListener: () => undefined, send: () => undefined },
      pendingIpcRejects: new Set(),
    };
    silent.sendIPCMessage = (type: string, data: any) => proto.sendIPCMessage.call(silent, type, data, exits ? 5000 : 20);
    const answer = proto[method].call(silent, req);
    if (exits) setTimeout(() => proto.failPendingIpc.call(silent, 'bot process exited before replying'), 20);
    return answer;
  }

  it.each([
    ['times out', false, /in time/, /once it is running/],
    ['exits before it answers', true, /stopped before answering/, /in time/],
  ])('C01-R3-4: a read the running bot %s names that cause', async (_label, exits, says, never) => {
    put(dataPath(G1, 'mod', 'x.json'), { v: 'disk' });
    child.guild = req => childRead('readGuildData', req, exits as boolean);
    const answer = await call(base, 'POST', '/api/config/data/update', { file: 'mod/x.json', data: { v: 'mine' }, guildId: G1 });
    await flushAll();
    expect(answer.status).toBe(503);
    expect(answer.body.error).toMatch(says as RegExp);
    expect(answer.body.error).not.toMatch(never as RegExp);
    expect(answer.body.error).toMatch(/nothing was changed/);
    expect(readJson(dataPath(G1, 'mod', 'x.json'))).toEqual({ v: 'disk' });
  });
});

type Answer = Awaited<ReturnType<typeof call>>;

describe('review round 4', () => {
  const OLDER = (stem: string) => `${stem}_2026-01-01T00-00-00-000Z.json`;
  const hops = () => child.writes.map(w => [w.module, w.filename, w.op]);
  const rowOf = async (file: string, guildId: string | null, category: string, name: string) => {
    const q = guildId ? `&guildId=${guildId}` : '';
    const listed = await call(base, 'GET', `/api/config/backups?file=${encodeURIComponent(file)}${q}&category=${category}`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    return listed.body.backups.find((b: any) => b.filename === name);
  };

  it.each([
    ['a module doc whose bare id a disk leftover names', 'mod/x.json', 'data', 'x', () => put(dataPath(G1, 'mod', 'x.json'), { disk: 1 })],
    ['a guild-root doc (M-R4-A)', 'x.json', 'data', 'x', () => undefined],
    ['a module config file', 'examples-config.json', 'config', 'examples-config', () => undefined],
  ])('C01-R4-1: an older backup of a postgres guild\'s %s cannot be checked against the database, so it is not restored', async (_label, file, category, stem, disk) => {
    setBackendKind('postgres');
    disk();
    child.guild = () => ({ ok: true, contentJson: JSON.stringify({ current: 1 }) });
    const older = OLDER(`${stem}_${G1}`);
    put(path.join(BACKUPS(), older), { from: 'another module' });
    const row = await rowOf(file, G1, category, older);
    expect(row).toBeDefined();
    expect(row.shared).toBe(true);
    expect(row.unchecked).toBe(true);
    const restored = await call(base, 'POST', '/api/config/restore', { file, filename: older, guildId: G1, category });
    expect(restored.status).toBe(409);
    expect(restored.body.error).toMatch(/cannot be checked/);
    expect(child.writes).toEqual([]);
  });

  it('C01-R4-1: an older backup of a file-routed guild whose files are not on this node cannot be checked', async () => {
    const older = OLDER(`x_${G1}`);
    put(path.join(BACKUPS(), older), { from: 'another module' });
    const row = await rowOf('x.json', G1, 'data', older);
    expect(row?.unchecked).toBe(true);
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'x.json', filename: older, guildId: G1, category: 'data' });
    expect(restored.status).toBe(409);
    expect(child.writes).toEqual([]);
  });

  it.each([
    ['a file-routed guild', G1],
    ['the global scope', null],
  ])('C01-R4-2: an older backup a same-named file in a subfolder could own is shared (%s)', async (_label, guildId) => {
    const at = (...parts: string[]) => (guildId ? dataPath(guildId, 'mod', ...parts) : dataPath('global', 'mod', ...parts));
    put(at('z', 'x.json'), { n: 1 });
    put(at('x.json'), { t: 1 });
    const older = OLDER(guildId ? `x_${guildId}` : 'x');
    put(path.join(BACKUPS(), older), { n: 0 });
    const row = await rowOf('mod/x.json', guildId, 'data', older);
    expect(row).toBeDefined();
    expect(row.shared).toBe(true);
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'mod/x.json', filename: older, guildId, category: 'data' });
    expect(restored.status).toBe(409);
    await flushAll();
    expect(readJson(at('x.json'))).toEqual({ t: 1 });
  });

  it('C01-R4-2: an older backup of a module file with no same-named file elsewhere stays restorable', async () => {
    put(dataPath(G1, 'mod', 'x.json'), { t: 1 });
    const older = OLDER(`x_${G1}`);
    put(path.join(BACKUPS(), older), { t: 0 });
    const row = await rowOf('mod/x.json', G1, 'data', older);
    expect(row.shared).toBe(false);
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'mod/x.json', filename: older, guildId: G1, category: 'data' });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    await flushAll();
    expect(readJson(dataPath(G1, 'mod', 'x.json'))).toEqual({ t: 0 });
  });

  // A postgres guild whose database holds a guild-root doc and a module doc of one name, and whose disk keeps a
  // leftover of the module doc: a key without '/' names the root doc.
  function postgresRootAndModuleDoc() {
    setBackendKind('postgres');
    put(dataPath('.backend.json'), { live: 'postgres', storeId: null, flippedAt: 0 });
    put(dataPath(G1, 'm', 'x.json'), { leftover: 1 });
    const docs: Record<string, unknown> = { '|x.json': { root: 1 }, 'm|x.json': { mod: 1 } };
    child.guild = req => {
      const doc = docs[`${req.module}|${req.filename}`];
      return doc === undefined ? { ok: true } : { ok: true, contentJson: JSON.stringify(doc) };
    };
  }

  it('C01-R4-3: the editor reads the guild-root doc a bare key names, not a module doc of that name', async () => {
    postgresRootAndModuleDoc();
    const got = await call(base, 'GET', `/api/config/data/get?file=x.json&guildId=${G1}`);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body.data).toEqual({ root: 1 });
  });

  it('C01-R4-3: a save of a guild-root doc writes and backs up that doc', async () => {
    postgresRootAndModuleDoc();
    const saved = await call(base, 'POST', '/api/config/data/update', { file: 'x.json', data: { v: 2 }, guildId: G1 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(hops()).toEqual([['', 'x.json', 'write']]);
    expect(backupNames().map(name => readJson(path.join(BACKUPS(), name)))).toEqual([{ root: 1 }]);
  });

  it('C01-R4-3: a restore of a guild-root doc keeps an undo copy of that doc and writes it', async () => {
    postgresRootAndModuleDoc();
    const name = writeBackup(BACKUPS(), 'x.json', G1, JSON.stringify({ old: 1 })).filename;
    const restored = await call(base, 'POST', '/api/config/restore', { file: 'x.json', filename: name, guildId: G1, category: 'data' });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(hops()).toEqual([['', 'x.json', 'write']]);
    const undo = backupNames().filter(n => n.includes('before_restore'));
    expect(undo.map(n => readJson(path.join(BACKUPS(), n)))).toEqual([{ root: 1 }]);
  });

  it.each([
    ['postgres', () => postgresRootAndModuleDoc()],
    ['file', () => { put(dataPath(G1, 'x.json'), { root: 1 }); put(dataPath(G1, 'm', 'x.json'), { mod: 1 }); }],
  ])('C01-R4-3: a delete of a guild-root doc names that doc to the child (%s route)', async (_label, setup) => {
    setup();
    const deleted = await call(base, 'POST', '/api/config/data/delete', { file: 'x.json', guildId: G1 });
    expect(deleted.status).toBe(200);
    expect(hops()).toEqual([['', 'x.json', 'delete']]);
  });
});

describe('review round 5', () => {
  it('C01-R5-2: a file-routed guild-root data file the panel lists saves, with a backup of its body', async () => {
    put(dataPath(G1, 'x.json'), { root: 1 });
    put(dataPath(G1, 'm', 'x.json'), { mod: 1 });
    const listed = await call(base, 'GET', `/api/config/list?guildId=${G1}`);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain('"x.json"');
    const saved = await call(base, 'POST', '/api/config/data/update', { file: 'x.json', guildId: G1, data: { root: 2 } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await flushAll();
    expect(readJson(dataPath(G1, 'x.json'))).toEqual({ root: 2 });
    expect(readJson(dataPath(G1, 'm', 'x.json'))).toEqual({ mod: 1 });
    expect(backupNames().map(name => readJson(path.join(BACKUPS(), name)))).toEqual([{ root: 1 }]);
  });

  it('C01-R5-2: a bare key with no guild-root file on this disk is still not found, and nothing is written', async () => {
    put(dataPath(G1, 'm', 'x.json'), { mod: 1 });
    const saved = await call(base, 'POST', '/api/config/data/update', { file: 'x.json', guildId: G1, data: { root: 2 } });
    expect(saved.status).toBe(404);
    await flushAll();
    expect(fs.existsSync(dataPath(G1, 'x.json'))).toBe(false);
    expect(readJson(dataPath(G1, 'm', 'x.json'))).toEqual({ mod: 1 });
    expect(backupNames()).toEqual([]);
  });

  it('C01-R5-2: a bare key on a file-routed guild whose files are not on this disk writes nothing here', async () => {
    const saved = await call(base, 'POST', '/api/config/data/update', { file: 'x.json', guildId: G1, data: { root: 2 } });
    expect(saved.status).not.toBe(200);
    await flushAll();
    expect(fs.existsSync(dataPath(G1, 'x.json'))).toBe(false);
  });
});
