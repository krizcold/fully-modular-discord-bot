import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 49's rows for webui/routes/update.ts (wip-redesign/sheets/NB6.md decisions 44, 61 and 91, T7, T9, T18, T30,
// T37; row 146's update routes; part 26b, E4): on a Postgres bot the web UI's update publishes, then the bot child
// applies it through `module:apply`; the routes send no reload and answer from the apply. The update is the real
// AppStoreManager's in the web UI process on its sessions over helpers/sharedRows.ts's tables; the bot child is
// helpers/forkMock.ts's fake behind a real BotManager, answering as the bot's handler answers.

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
import { getAppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';
import { STOPPED_SERVING_TEXT } from '../../src/bot/internalSetup/utils/servingGate';
import { useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { createUpdateRouter } from '../../src/webui/routes/update';
import { forks } from '../helpers/forkMock';
import { applyRig, moduleShaOfFiles } from '../helpers/nb6ApplyRig';
import { answering, exitChild, freshWriterLock, resetForks, sentTo, startedWith, type Sent } from '../helpers/nb10Rig';
import { webuiSessions } from '../helpers/nb6WebuiSession';
import { lost } from '../helpers/sharedRows';

const rig = applyRig();
const REPO = 'r1';
const STORE = dataPath('global', 'appstore');
const V1 = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const V2 = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };
const A = 'postgres://bot@db:5432/bot';

let manager: BotManager;
let s: ReturnType<typeof webuiSessions>;

function clone(files: Record<string, string>): void {
  const dir = path.join(STORE, 'cache', REPO);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, 'Modules', 'm', ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

const staged = () => (fs.existsSync(rig.state.source) ? fs.readdirSync(rig.state.source).filter(n => n.startsWith('.incoming-')) : []);

function webuiSide(): void {
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
}

beforeEach(async () => {
  await rig.setup();
  h.dirs = { source: rig.state.source, build: rig.state.build, dist: rig.state.dist, dev: path.join(rig.state.root, 'modulesDev') };
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  freshWriterLock('webui');
  resetForks();
  dm.setSharedWriteGate(() => inLocalOp());
  fs.mkdirSync(STORE, { recursive: true });
  const reposBody = JSON.stringify({ repositories: [{ id: REPO, name: 'Repo', url: 'https://github.com/example/r', branch: 'main', enabled: true }] }, null, 2);
  fs.writeFileSync(path.join(STORE, 'repos.json'), reposBody);
  rig.state.rows.put('global/appstore/repos.json', reposBody, 'ALPHA/p-alpha');
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  manager = new BotManager();
  webuiSide();
  await installedV1();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const child of forks.children) if (child.exitCode === null) exitChild(child, 0);
  dm.setSharedWriteGate(null);
  useWebuiSessions(null);
  await manager.shutdown(true).catch(() => undefined);
  freshWriterLock('webui');
  await rig.teardown();
});

/**
 * m 1.0.0 installed by the web UI with no bot child (the publish landed, the staged folder deleted, T7), then placed
 * in the source folder as the bot's apply places it at its next boot.
 */
async function installedV1(): Promise<void> {
  clone(V1);
  const change = await getAppStoreManager().installModule('m', REPO);
  if (typeof change !== 'object') throw new Error('expected a published install');
  expect((await manager.applyModule(change)).outcome).toBe('not-running');
  const live = path.join(rig.state.source, 'm');
  fs.mkdirSync(live, { recursive: true });
  for (const [rel, text] of Object.entries(V1)) fs.writeFileSync(path.join(live, rel), text);
  clone(V2);
}

/** A bot child at `guild` that answers `module:apply` with reply, recording each one. */
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

/** The route's handler, called as express calls it; resolves with the JSON body. */
async function post(route: string, params: Record<string, string> = {}): Promise<any> {
  const router: any = createUpdateRouter(manager);
  const layer = router.stack.find((l: any) => l.route?.path === route && l.route.methods.post);
  const stack = layer.route.stack;
  let body: any;
  const res: any = { status: () => res, json: (b: any) => { body = b; return res; } };
  await stack[stack.length - 1].handle({ body: {}, params }, res);
  return body;
}

const reloads = (child: any) => sentTo(child).filter(m => m.type === 'module:reload' || m.type === 'module:reload-all');
const APPLIED = { outcome: 'applied', reason: null, error: null, loaded: true };
const T9 = 'm 2.0.0 was updated, but it failed to load on this machine (boom at load), so this machine keeps the previous version. The other machines try it when they apply it, and the App Store tab lists each machine where it fails.';
const T7_STOPPED = "m was updated to 2.0.0. This machine's bot is not running, so it applies the module when it next starts normally.";
const T7_MAINTENANCE = "m was updated to 2.0.0. This machine's bot is in maintenance, so it applies the module when maintenance ends.";
const T18_BUSY = 'm 2.0.0 was updated. This machine applies it at its next pass (another App Store change was still running on this machine).';
const T37 = "m 2.0.0 was updated. This machine's bot process stopped serving its shards and restarts; it tries to load the module after that restart.";

describe('row 146: POST /module-and-reload/:name on a Postgres bot', () => {
  it('applied: module:apply with the staged folder, no reload, the answer from the apply', async () => {
    const { child, applies } = await childAnswering(() => APPLIED);
    const body = await post('/module-and-reload/:name', { name: 'm' });
    expect(body).toMatchObject({ success: true, message: 'Updated and reloaded m', apply: { outcome: 'applied', loaded: true, text: null } });
    expect(body.download).toMatchObject({ success: true, moduleName: 'm', oldVersion: '1.0.0', newVersion: '2.0.0' });
    expect(body.download.published).toBeUndefined();
    expect(applies).toHaveLength(1);
    expect(applies[0].data).toMatchObject({ module: 'm', to: moduleShaOfFiles(V2), tag: '1:ALPHA', version: '2.0.0', reason: 'update' });
    expect(path.basename(applies[0].data.staged)).toMatch(/^\.incoming-m-\d+$/);
    expect(reloads(child)).toEqual([]);
    expect(staged()).toEqual([]);
    expect(rig.state.rows.modules.get('m')?.sha).toBe(moduleShaOfFiles(V2));
  });

  it('T9: the version failed to load on this machine; the route answers it as its error', async () => {
    const { child } = await childAnswering(() => ({ outcome: 'failed', reason: null, error: 'boom at load', loaded: false, kept: 'previous' }));
    const body = await post('/module-and-reload/:name', { name: 'm' });
    expect(body).toMatchObject({ success: false, error: T9, message: T9, apply: { outcome: 'failed', error: 'boom at load' } });
    expect(reloads(child)).toEqual([]);
  });

  it('T7: no bot child; the staged folder deleted, nothing local', async () => {
    const body = await post('/module-and-reload/:name', { name: 'm' });
    expect(body).toMatchObject({ success: false, message: T7_STOPPED, apply: { outcome: 'not-running' } });
    expect(staged()).toEqual([]);
    expect(fs.readFileSync(path.join(rig.state.source, 'm', 'index.js'), 'utf8')).toBe(V1['index.js']);
    expect(rig.state.rows.modules.get('m')?.sha).toBe(moduleShaOfFiles(V2));
  });

  it("T7's in-maintenance form: module:apply refused with the maintenance flag", async () => {
    const { child } = await childAnswering(() => ({ success: false, maintenance: true, error: 'The bot is in maintenance' }));
    const body = await post('/module-and-reload/:name', { name: 'm' });
    expect(body).toMatchObject({ success: false, message: T7_MAINTENANCE });
    expect(reloads(child)).toEqual([]);
  });

  it("T18: the bot's store mutex busy past 60 s", async () => {
    await childAnswering(() => ({ outcome: 'busy', reason: 'busy', error: null, loaded: false }));
    expect(await post('/module-and-reload/:name', { name: 'm' })).toMatchObject({ success: false, message: T18_BUSY });
  });

  it('T30: loaded, its start-up code still running', async () => {
    const { child } = await childAnswering(() => ({ outcome: 'loaded', reason: null, error: null, loaded: true }));
    const body = await post('/module-and-reload/:name', { name: 'm' });
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/^m 2\.0\.0 was updated and loaded on this machine, and its start-up code is still running\. The App Store tab lists this machine if that code fails within 10 minutes; this machine then keeps /);
    expect(body.apply).toMatchObject({ outcome: 'loaded', loaded: true });
    expect(reloads(child)).toEqual([]);
  });

  it('T37: the bot process stopped serving its shards', async () => {
    await childAnswering(() => ({ success: false, error: STOPPED_SERVING_TEXT }));
    expect(await post('/module-and-reload/:name', { name: 'm' })).toMatchObject({ success: false, message: T37, apply: { outcome: 'stopped-serving' } });
  });
});

describe('row 146: POST /modules/:name on a Postgres bot', () => {
  it("applied: today's success answer, after module:apply", async () => {
    const { child, applies } = await childAnswering(() => APPLIED);
    const body = await post('/modules/:name', { name: 'm' });
    expect(body).toMatchObject({ success: true, moduleName: 'm', oldVersion: '1.0.0', newVersion: '2.0.0', message: 'Module m updated successfully from 1.0.0 to 2.0.0' });
    expect(applies).toHaveLength(1);
    expect(reloads(child)).toEqual([]);
  });

  it('T9 is the error; T7 the message of a stored update', async () => {
    const { child } = await childAnswering(() => ({ outcome: 'failed', reason: null, error: 'boom at load', loaded: false, kept: 'previous' }));
    expect(await post('/modules/:name', { name: 'm' })).toMatchObject({ success: false, moduleName: 'm', error: T9 });
    exitChild(child, 0);
    await new Promise(resolve => setTimeout(resolve, 5));
    clone({ ...V2, 'module.json': '{"name":"m","version":"3.0.0"}' });
    expect(await post('/modules/:name', { name: 'm' })).toMatchObject({
      success: true, newVersion: '3.0.0',
      message: "m was updated to 3.0.0. This machine's bot is not running, so it applies the module when it next starts normally.",
    });
  });

  it("35's can't confirm text alone when the database did not answer the save", async () => {
    await childAnswering(() => APPLIED);
    loseNextCommit();
    const body = await post('/modules/:name', { name: 'm' });
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/^Can't confirm whether m was updated: the database did not answer the save \(.+\)\. The App Store tab shows the result once it does\.$/);
  });
});

/** The publish's COMMIT answer is lost and its landing check gets no answer: 35's can't confirm text. */
function loseNextCommit(): void {
  let committing: number | null = null;
  rig.state.rows.fault = (sql, _p, client) => {
    if (sql === 'COMMIT' && committing === null) {
      committing = client;
      return 'lose';
    }
    if (committing !== null && client !== committing && sql.startsWith('SELECT id')) return lost();
    return undefined;
  };
}

describe('row 146: the bulk routes on a Postgres bot', () => {
  it('/modules-and-reload, applied: no reload-all; the reload summary names the applied module', async () => {
    const { child, applies } = await childAnswering(() => APPLIED);
    const body = await post('/modules-and-reload');
    expect(body).toMatchObject({ success: true, reload: { success: true, reloaded: ['m'], failed: [] }, message: 'Updated 1 module(s); reloaded the updated module(s)' });
    expect(body.download.updated).toEqual([{ moduleName: 'm', oldVersion: '1.0.0', newVersion: '2.0.0' }]);
    expect(applies).toHaveLength(1);
    expect(reloads(child)).toEqual([]);
  });

  it('/modules-and-reload, T9: not a success; the message carries the text', async () => {
    const { child } = await childAnswering(() => ({ outcome: 'failed', reason: null, error: 'boom at load', loaded: false, kept: 'previous' }));
    const body = await post('/modules-and-reload');
    expect(body).toMatchObject({ success: false, reload: { success: false, reloaded: [], failed: [{ moduleName: 'm', error: T9 }] }, message: `Updated 1 module(s). ${T9}` });
    expect(reloads(child)).toEqual([]);
  });

  it('/modules, T18: the update stored, the text in the message', async () => {
    await childAnswering(() => ({ outcome: 'busy', reason: 'busy', error: null, loaded: false }));
    const body = await post('/modules');
    expect(body).toMatchObject({ success: true, totalUpdated: 1, message: `Updated 1 module(s). ${T18_BUSY}`, apply: [{ moduleName: 'm', outcome: 'busy', text: T18_BUSY }] });
    expect(body.updated).toEqual([{ moduleName: 'm', oldVersion: '1.0.0', newVersion: '2.0.0' }]);
  });

  it("an update the database did not answer is answered as can't confirm, not under failed", async () => {
    await childAnswering(() => APPLIED);
    loseNextCommit();
    const body = await post('/modules');
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/^Updated 0 module\(s\)\. Can't confirm whether m was updated: the database did not answer the save \(.+\)\. The App Store tab shows the result once it does\.$/);
    expect(body.message).not.toContain('failed:');
    expect(body.failed).toEqual([expect.objectContaining({ moduleName: 'm', unconfirmed: true })]);
  });
});
