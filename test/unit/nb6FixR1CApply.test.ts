import fs from 'fs';
import path from 'path';
import { syncBuiltinESMExports } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 code review round 1, lane C findings 3, 7 and 8 (out/NB6/review1-C.md; out/NB6/part-rulings.md). The publish is
// the real AppStoreManager's in the web UI process on its sessions over helpers/sharedRows.ts's tables; the job is the
// real InstallQueue; the bot child is helpers/forkMock.ts's fake behind a real BotManager, answering `module:apply` as
// the bot's handler answers it (moduleApply.ts removal's `unloadFailed` for a failed unload).

const h = vi.hoisted(() => ({ dirs: { source: '', build: '', dist: '', dev: '' } }));
const safety = vi.hoisted(() => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}) }));

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  const execSync = (cmd: string) => {
    if (cmd.startsWith('git rev-parse HEAD')) return Buffer.from('a'.repeat(40));
    if (cmd.startsWith('git remote set-url') || cmd.startsWith('git fetch')) return Buffer.from('');
    throw new Error(`unexpected command in test: ${cmd.split(' ').slice(0, 2).join(' ')}`);
  };
  return { ...real, fork, execSync, default: { ...real, fork, execSync } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    getSourceModulesDir: () => h.dirs.source,
    getBuildModulesDir: () => h.dirs.build,
    getModulesDir: () => h.dirs.dist,
    getModulesDevDir: () => h.dirs.dev,
  };
});
vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { createUpdateRouter } from '../../src/webui/routes/update';
import { InstallQueue, type InstallJob } from '../../src/webui/utils/installQueue';
import { forks } from '../helpers/forkMock';
import { applyRig } from '../helpers/nb6ApplyRig';
import { answering, exitChild, freshWriterLock, resetForks, startedWith, type Sent } from '../helpers/nb10Rig';
import { webuiSessions } from '../helpers/nb6WebuiSession';
import { lost } from '../helpers/sharedRows';

const rig = applyRig();
const REPO = 'r1';
const STORE = dataPath('global', 'appstore');
const A = 'postgres://bot@db:5432/bot';
const files = (name: string, version: string) => ({ 'module.json': `{"name":"${name}","version":"${version}"}`, 'index.js': `exports.v = '${version}';\n` });

let manager: BotManager;
let s: ReturnType<typeof webuiSessions>;
let lines: string[];

/** The repo's cache holding these modules at these versions. */
function clone(modules: Record<string, string>): void {
  const dir = path.join(STORE, 'cache', REPO);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const [name, version] of Object.entries(modules)) {
    for (const [rel, text] of Object.entries(files(name, version))) {
      const file = path.join(dir, 'Modules', name, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  }
}

const staged = () => (fs.existsSync(rig.state.source) ? fs.readdirSync(rig.state.source).filter(n => n.startsWith('.incoming-')) : []);

beforeEach(async () => {
  await rig.setup();
  h.dirs = { source: rig.state.source, build: rig.state.build, dist: rig.state.dist, dev: path.join(rig.state.root, 'modulesDev') };
  lines = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  freshWriterLock('webui');
  resetForks();
  dm.setSharedWriteGate(inLocalOp);
  fs.mkdirSync(STORE, { recursive: true });
  const reposBody = JSON.stringify({ repositories: [{ id: REPO, name: 'Repo', url: 'https://github.com/example/r', branch: 'main', enabled: true }] }, null, 2);
  fs.writeFileSync(path.join(STORE, 'repos.json'), reposBody);
  rig.state.rows.put('global/appstore/repos.json', reposBody, 'ALPHA/p-alpha');
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  manager = new BotManager();
  dm.setGuildDataBackend(null);
  s = webuiSessions(rig.state.rows);
  useWebuiSessions({
    target: async () => ({ entry: A, tag: '1:ALPHA', countAtStart: 0 }),
    commitCheck: () => null,
    select: async (text, values) => {
      const res = await rig.state.rows.answer(text, values, 0, 999);
      if (res instanceof Error) throw res;
      return (res ?? { rows: [] }) as { rows: any[] };
    },
    tag: () => '1:ALPHA',
    session: config => s.session(config as Record<string, unknown>),
  });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const child of forks.children) if (child.exitCode === null) exitChild(child, 0);
  dm.setSharedWriteGate(null);
  useWebuiSessions(null);
  await manager.shutdown(true).catch(() => undefined);
  freshWriterLock('webui');
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await rig.teardown();
});

async function childAnswering(reply: (m: Sent) => unknown): Promise<{ child: any; applies: Sent[] }> {
  const { child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }], manager);
  const applies: Sent[] = [];
  answering(child, m => {
    if (m.type === 'module:reload' || m.type === 'module:reload-all') return { success: true, reloaded: [], failed: [] };
    if (m.type !== 'module:apply') return undefined;
    applies.push(m);
    return reply(m);
  });
  return { child, applies };
}

function runJob(kind: 'install' | 'uninstall', name = 'm'): Promise<InstallJob> {
  const queue = new InstallQueue();
  queue.setBotManager(manager);
  return new Promise(resolve => {
    queue.on('completed', resolve);
    queue.on('failed', resolve);
    if (kind === 'install') queue.enqueueInstall(name, REPO);
    else queue.enqueueUninstall(name);
  });
}

/** fs.rmSync of a staged folder throws EBUSY; every other call is the real one. */
function stagedDeleteFails(): void {
  const real = fs.rmSync;
  vi.spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, options?: fs.RmOptions) => {
    if (path.basename(String(p)).startsWith('.incoming-')) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${String(p)}'`), { code: 'EBUSY' });
    }
    return real(p, options);
  }) as typeof fs.rmSync);
  syncBuiltinESMExports();
}

async function post(route: string): Promise<any> {
  const router: any = createUpdateRouter(manager);
  const layer = router.stack.find((l: any) => l.route?.path === route && l.route.methods.post);
  const stack = layer.route.stack;
  let body: any;
  const res: any = { status: () => res, json: (b: any) => { body = b; return res; } };
  await stack[stack.length - 1].handle({ body: {}, params: {} }, res);
  return body;
}

const APPLIED = { outcome: 'applied', reason: null, error: null, loaded: true };

describe('lane C finding 7: the staged folder cannot be deleted after module:apply answered', () => {
  it('the install job ends with the apply\'s answer, and the delete is logged', async () => {
    clone({ m: '1.0.0' });
    await childAnswering(() => APPLIED);
    stagedDeleteFails();
    const job = await runJob('install');
    expect(job).toMatchObject({ status: 'completed', loaded: true });
    expect(job.error).toBeUndefined();
    expect(staged()).toHaveLength(1);
    expect(lines.filter(l => l.includes('EBUSY'))).toHaveLength(1);
  });

  it('with no bot child: T7, and the delete is logged', async () => {
    clone({ m: '1.0.0' });
    stagedDeleteFails();
    const job = await runJob('install');
    expect(job).toMatchObject({ status: 'completed', loaded: false, message: "m 1.0.0 was installed. This machine's bot is not running, so it applies the module when it next starts normally." });
    expect(lines.filter(l => l.includes('EBUSY'))).toHaveLength(1);
  });
});

describe('lane C finding 8: an uninstall whose unload failed', () => {
  it('the job answers unloaded false', async () => {
    clone({ m: '1.0.0' });
    await childAnswering(m => (m.data.reason === 'uninstall'
      ? { outcome: 'applied', reason: null, error: null, loaded: false, unloadFailed: 'a listener would not detach' }
      : APPLIED));
    expect(await runJob('install')).toMatchObject({ status: 'completed', loaded: true });
    const job = await runJob('uninstall');
    expect(job).toMatchObject({ status: 'completed', unloaded: false });
  });

  it('an unload that succeeded answers unloaded true (guard)', async () => {
    clone({ m: '1.0.0' });
    await childAnswering(m => (m.data.reason === 'uninstall' ? { outcome: 'applied', reason: null, error: null, loaded: false } : APPLIED));
    await runJob('install');
    expect(await runJob('uninstall')).toMatchObject({ status: 'completed', unloaded: true });
  });
});

describe("lane C finding 3: /modules-and-reload with one update applied and one the database did not answer", () => {
  it('the reload clause comes before the can\'t confirm sentence', async () => {
    clone({ m: '1.0.0', n: '1.0.0' });
    await childAnswering(() => APPLIED);
    for (const name of ['m', 'n']) expect((await runJob('install', name)).status).toBe('completed');
    clone({ m: '2.0.0', n: '2.0.0' });
    for (const name of ['m', 'n']) {
      const live = path.join(rig.state.source, name);
      fs.mkdirSync(live, { recursive: true });
      for (const [rel, text] of Object.entries(files(name, '1.0.0'))) fs.writeFileSync(path.join(live, rel), text);
    }
    // n's publish: its COMMIT's answer is lost and no landing check is answered.
    let ofN: number | null = null;
    let committing: number | null = null;
    rig.state.rows.fault = (sql, params, at) => {
      if (committing === null && /shared_modules/.test(sql) && Array.isArray(params) && params[0] === 'n') ofN = at;
      if (sql === 'COMMIT' && at === ofN && committing === null) {
        committing = at;
        return 'lose';
      }
      if (committing !== null && at !== committing && sql.startsWith('SELECT id')) return lost();
      return undefined;
    };
    const body = await post('/modules-and-reload');
    expect(body.message).toMatch(/^Updated 1 module\(s\); reloaded the updated module\(s\)\. Can't confirm whether n was updated: the database did not answer the save \(.+\)\. The App Store tab shows the result once it does\.$/);
  });
});
