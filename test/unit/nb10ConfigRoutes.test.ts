import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 4: the config routes in front of a real BotManager. With a child at `guild` every write reaches it as one
// message carrying the sha of the body the route read, and the web UI process writes nothing; with no child the write
// runs in the local chain under the writer lock; a child that has not reported answers starting.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, inLocalOp, ROUTE_TEXT } from '../../src/webui/botManager';
import { createConfigRoutes } from '../../src/webui/routes/config';
import { applyOperatorDataRead, applyOperatorGlobalRead, shaOfRaw } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { writeBackup } from '../../src/webui/utils/configBackups';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { dataPath } from '../../src/utils/dataRoot';
import { BACKUPS, call, put, readJson, resetData, startApp } from '../helpers/configRig';
import { answering, exitChild, freshWriterLock, quiet, resetForks, sentTo, startedWith } from '../helpers/nb10Rig';

const G = '123456789012345678';
const guildConfig = () => dataPath(G, '_guildConfig', 'config.json');

let base = '';
let close: () => Promise<void>;

let mounted = false;
async function mount(m: BotManager): Promise<void> {
  mounted = true;
  ({ url: base, close } = await startApp(app => app.use('/api/config', createConfigRoutes(m))));
}

/** A child at `guild` that serves reads from this process's disk and answers every write ok without applying it. */
function readsOnly(child: any): void {
  answering(child, m => {
    if (m.type === 'data:global-read') return applyOperatorGlobalRead(m.data);
    if (m.type === 'data:guild-read') return applyOperatorDataRead(m.data);
    if (m.type === 'shared:op' || m.type === 'data:guild-write') return { ok: true };
    return undefined;
  });
}

beforeEach(async () => {
  quiet();
  resetForks();
  freshWriterLock('webui');
  setSharedWriteGate(() => inLocalOp());
  await resetData();
});

afterEach(async () => {
  if (mounted) await close();
  mounted = false;
  setSharedWriteGate(null);
  for (const child of [...(await import('../helpers/forkMock')).forks.children]) if (child.exitCode === null) exitChild(child);
  vi.restoreAllMocks();
});

describe('config writes while a child runs at guild', () => {
  it('a global save sends one global.write with the sha of the body read, and the web UI writes nothing', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    const served = fs.readFileSync(ROOT_CONFIG_PATH, 'utf8');
    const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    readsOnly(child);
    await mount(manager);
    const reply = await call(base, 'POST', '/api/config/update', { file: 'config.json', config: { a: 2 } });
    expect(reply.status).toBe(200);
    const ops = sentTo(child, 'shared:op');
    expect(ops).toHaveLength(1);
    expect(ops[0].data).toMatchObject({ op: 'global.write', args: { root: 'config', expectSha: shaOfRaw(served) } });
    expect(JSON.parse(ops[0].data.args.contentJson)).toEqual({ a: 2 });
    expect(queuedFilePaths()).toEqual([]);
    expect(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8')).toBe(served);
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });

  it('a guild save, its restore and a data save each send one data:guild-write with expectSha', async () => {
    put(guildConfig(), { g: 1 });
    put(dataPath(G, 'mod', 'x.json'), { d: 1 });
    const guildServed = fs.readFileSync(guildConfig(), 'utf8');
    const backup = writeBackup(BACKUPS(), 'config.json', G, JSON.stringify({ g: 0 })).filename;
    const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    readsOnly(child);
    await mount(manager);
    expect((await call(base, 'POST', '/api/config/update', { file: 'config.json', config: { g: 2 }, guildId: G })).status).toBe(200);
    expect((await call(base, 'POST', '/api/config/restore', { file: 'config.json', filename: backup, guildId: G })).status).toBe(200);
    expect((await call(base, 'POST', '/api/config/data/update', { file: 'mod/x.json', data: { d: 2 }, guildId: G })).status).toBe(200);
    const writes = sentTo(child, 'data:guild-write').map(m => m.data);
    expect(writes).toHaveLength(3);
    expect(writes[0]).toMatchObject({ guildId: G, module: '_guildConfig', filename: 'config.json', op: 'write', expectSha: shaOfRaw(guildServed) });
    expect(writes[1]).toMatchObject({ guildId: G, op: 'write', expectSha: shaOfRaw(guildServed) });
    expect(writes[2]).toMatchObject({ guildId: G, module: 'mod', filename: 'x.json', expectSha: shaOfRaw(fs.readFileSync(dataPath(G, 'mod', 'x.json'), 'utf8')) });
    expect(sentTo(child, 'shared:op')).toEqual([]);
    expect(queuedFilePaths()).toEqual([]);
    expect(readJson(guildConfig())).toEqual({ g: 1 });
    expect(readJson(dataPath(G, 'mod', 'x.json'))).toEqual({ d: 1 });
  });

  it('a data save of a guild-root file is sent to the child with module empty', async () => {
    put(dataPath(G, 'foo.json'), { r: 1 });
    const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    readsOnly(child);
    await mount(manager);
    const reply = await call(base, 'POST', '/api/config/data/update', { file: 'foo.json', data: { r: 2 }, guildId: G });
    expect(reply.status).toBe(200);
    expect(sentTo(child, 'data:guild-write').map(m => m.data)).toEqual([expect.objectContaining({ guildId: G, module: '', filename: 'foo.json', op: 'write' })]);
    expect(readJson(dataPath(G, 'foo.json'))).toEqual({ r: 1 });
  });
});

describe('config writes with no child', () => {
  it('a global save runs locally: the lock names the web UI while it runs, is gone after, and the answer is 200', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    await mount(new BotManager());
    let seenHolder: any = null;
    const real = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === ROOT_CONFIG_PATH) seenHolder = JSON.parse(fs.readFileSync(writerLockPath(), 'utf8'));
      return real(from, to);
    }) as typeof fs.promises.rename);
    const reply = await call(base, 'POST', '/api/config/update', { file: 'config.json', config: { a: 2 } });
    expect(reply.status).toBe(200);
    expect(seenHolder).toMatchObject({ pid: process.pid, role: 'webui' });
    expect(readJson(ROOT_CONFIG_PATH)).toEqual({ a: 2 });
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });
});

describe('config writes with a child that has not reported', () => {
  it('answer 503 with the starting text and write nothing', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    put(guildConfig(), { g: 1 });
    const { manager, child } = await startedWith([]);
    readsOnly(child);
    await mount(manager);
    const global = await call(base, 'POST', '/api/config/update', { file: 'config.json', config: { a: 2 } });
    const guild = await call(base, 'POST', '/api/config/update', { file: 'config.json', config: { g: 2 }, guildId: G });
    expect(global).toMatchObject({ status: 503, body: { success: false, error: ROUTE_TEXT.starting } });
    expect(guild).toMatchObject({ status: 503, body: { success: false, error: ROUTE_TEXT.starting } });
    expect(sentTo(child)).toEqual([]);
    expect(readJson(ROOT_CONFIG_PATH)).toEqual({ a: 1 });
    expect(readJson(guildConfig())).toEqual({ g: 1 });
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });
});

