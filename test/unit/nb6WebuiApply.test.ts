import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 49's `module:apply` and install job rows (wip-redesign/sheets/NB6.md decisions 31, 44 and 61, C16, D10, E8;
// rows 142 to 145, 217 and 222 to 225; part 26), 67's cell 438 and the web UI's own landing check of a publish
// (sharedModules.ts `checkLanded`, part 14's note). The publish is the real AppStoreManager's in the web UI process,
// on its short-lived sessions over helpers/sharedRows.ts's tables; the job is the real InstallQueue; the bot child is
// helpers/forkMock.ts's fake behind a real BotManager, answering `module:apply` as the bot's handler answers it.

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
import { AppStoreManager, type PublishedChange } from '../../src/bot/internalSetup/utils/appStoreManager';
import { STOPPED_SERVING_TEXT } from '../../src/bot/internalSetup/utils/servingGate';
import { useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { InstallQueue, type InstallJob } from '../../src/webui/utils/installQueue';
import { forks } from '../helpers/forkMock';
import { applyRig, moduleShaOfFiles } from '../helpers/nb6ApplyRig';
import { answering, exitChild, freshWriterLock, resetForks, startedWith, type Sent } from '../helpers/nb10Rig';
import { webuiSessions } from '../helpers/nb6WebuiSession';

const rig = applyRig();
const REPO = 'r1';
const STORE = dataPath('global', 'appstore');
const V1 = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
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

/** The web UI's sessions over the rig's tables, set after the BotManager's constructor set the real ones. */
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
  dm.setSharedWriteGate(inLocalOp);
  fs.mkdirSync(STORE, { recursive: true });
  // repos.json as a Postgres bot holds it: its row, and this machine's mirror of it.
  const reposBody = JSON.stringify({ repositories: [{ id: REPO, name: 'Repo', url: 'https://github.com/example/r', branch: 'main', enabled: true }] }, null, 2);
  fs.writeFileSync(path.join(STORE, 'repos.json'), reposBody);
  rig.state.rows.put('global/appstore/repos.json', reposBody, 'ALPHA/p-alpha');
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  manager = new BotManager();
  webuiSide();
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

/** A bot child at `guild` that answers `module:apply` with reply, recording each message it was sent. */
async function childAnswering(reply: (m: Sent) => unknown): Promise<{ child: any; applies: Sent[] }> {
  const { child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }], manager);
  const applies: Sent[] = [];
  answering(child, m => {
    if (m.type !== 'module:apply') return undefined;
    applies.push(m);
    return reply(m);
  });
  return { child, applies };
}

/** The install job of the real queue; resolves with the job once it completed or failed. */
function runJob(kind: 'install' | 'uninstall', credentials?: Record<string, string>): Promise<InstallJob> {
  const queue = new InstallQueue();
  queue.setBotManager(manager);
  return new Promise(resolve => {
    queue.on('completed', resolve);
    queue.on('failed', resolve);
    if (kind === 'install') queue.enqueueInstall('m', REPO, credentials);
    else queue.enqueueUninstall('m');
  });
}

/** The web UI's own install of m 1.0.0, as the job runs it: the publish landed, the staged folder handed on. */
async function published(): Promise<PublishedChange> {
  clone(V1);
  return await new AppStoreManager().installModule('m', REPO) as PublishedChange;
}

const T7_STOPPED = "m 1.0.0 was installed. This machine's bot is not running, so it applies the module when it next starts normally.";
const T7_MAINTENANCE = "m 1.0.0 was installed. This machine's bot is in maintenance, so it applies the module when maintenance ends.";

describe('row 142: the publish landed and a bot child runs', () => {
  it('the job sends module:apply with the staged folder; its loaded comes from the apply, and the folder goes after', async () => {
    clone(V1);
    let sawStaged: string[] | null = null;
    const { applies } = await childAnswering(() => {
      sawStaged = staged();
      return { outcome: 'applied', reason: null, error: null, loaded: true };
    });
    const job = await runJob('install');
    expect(job).toMatchObject({ status: 'completed', loaded: true });
    expect(job.message).toBeUndefined();
    expect(applies).toHaveLength(1);
    const data = applies[0].data;
    expect(data).toMatchObject({ module: 'm', to: moduleShaOfFiles(V1), tag: '1:ALPHA', version: '1.0.0', reason: 'install' });
    expect(path.basename(data.staged)).toMatch(/^\.incoming-m-\d+$/);
    expect(sawStaged).toEqual([path.basename(data.staged)]);
    expect(staged()).toEqual([]);
    expect(rig.live('m')).toBeNull();
    expect(rig.state.rows.modules.get('m')?.sha).toBe(moduleShaOfFiles(V1));
  });

  it('the uninstall sends module:apply with to absent and no staged folder; unloaded comes from the apply', async () => {
    clone(V1);
    const { applies } = await childAnswering(() => ({ outcome: 'applied', reason: null, error: null, loaded: false }));
    expect(await runJob('install')).toMatchObject({ status: 'completed', loaded: false });
    const job = await runJob('uninstall');
    expect(job).toMatchObject({ status: 'completed', unloaded: true });
    expect(applies[1].data).toMatchObject({ module: 'm', to: 'absent', staged: null, reason: 'uninstall' });
    expect(rig.state.rows.modules.has('m')).toBe(false);
  });
});

describe('row 143: the publish landed, no bot child or a maintenance boot', () => {
  it('no bot child: T7, nothing local, the staged folder deleted', async () => {
    const job = await (async () => { clone(V1); return runJob('install'); })();
    expect(job).toMatchObject({ status: 'completed', loaded: false, message: T7_STOPPED });
    expect(staged()).toEqual([]);
    expect(rig.live('m')).toBeNull();
    expect(rig.state.rows.modules.get('m')?.sha).toBe(moduleShaOfFiles(V1));
  });

  it("a maintenance boot refuses module:apply with the maintenance flag: T7's in-maintenance form", async () => {
    await childAnswering(() => ({ success: false, maintenance: true, error: 'The bot is in maintenance' }));
    const job = await (async () => { clone(V1); return runJob('install'); })();
    expect(job).toMatchObject({ status: 'completed', loaded: false, message: T7_MAINTENANCE });
    expect(staged()).toEqual([]);
  });

  it('the uninstall with no bot child: T7 for an uninstall', async () => {
    clone(V1);
    await runJob('install');
    const job = await runJob('uninstall');
    expect(job).toMatchObject({ status: 'completed', unloaded: false, message: "m was uninstalled. This machine's bot is not running, so it removes the module's files when it next starts normally." });
  });
});

describe('the answers of module:apply (rows 145, 217, 222, 223; cell 438)', () => {
  it('145: a version that failed to load and was rolled back answers T9, its error as loadError', async () => {
    await childAnswering(() => ({ outcome: 'failed', reason: null, error: 'boom at load', loaded: false, kept: 'previous' }));
    const job = await (async () => { clone(V1); return runJob('install'); })();
    expect(job).toMatchObject({
      status: 'completed', loaded: false, loadError: 'boom at load',
      message: 'm 1.0.0 was installed, but it failed to load on this machine (boom at load), so this machine keeps the previous version. The other machines try it when they apply it, and the App Store tab lists each machine where it fails.',
    });
  });

  it("217: the gate closed in a running bot refuses it with the maintenance flag: T7's in-maintenance form", async () => {
    await childAnswering(() => ({ success: false, maintenance: true, error: 'maintenance text' }));
    const answer = await manager.applyModule(await published());
    expect(answer).toEqual({ outcome: 'maintenance', loaded: false, error: null, text: T7_MAINTENANCE });
  });

  it("222: the bot's store mutex busy past 60 s: T18's busy form", async () => {
    await childAnswering(() => ({ outcome: 'busy', reason: 'busy', error: null, loaded: false }));
    const answer = await manager.applyModule(await published());
    expect(answer.text).toBe('m 1.0.0 was installed. This machine applies it at its next pass (another App Store change was still running on this machine).');
  });

  it("223: deferred for a reload of the module: T18's reload form", async () => {
    await childAnswering(() => ({ outcome: 'deferred', reason: 'reload', error: null, loaded: false }));
    const answer = await manager.applyModule(await published());
    expect(answer).toMatchObject({ outcome: 'deferred', loaded: false, text: 'm 1.0.0 was installed. This machine applies it at its next pass (a reload of m was still running).' });
  });

  it("438: a bot process that stopped serving refuses it with STOPPED_SERVING_TEXT: T37", async () => {
    await childAnswering(() => ({ success: false, error: STOPPED_SERVING_TEXT }));
    const answer = await manager.applyModule(await published());
    expect(answer).toEqual({
      outcome: 'stopped-serving', loaded: false, error: null,
      text: "m 1.0.0 was installed. This machine's bot process stopped serving its shards and restarts; it tries to load the module after that restart.",
    });
  });
});

describe('rows 144, 224 and 225: module:apply unanswered', () => {
  it('no answer within 600 s: T8 (a), and the staged folder is left for the apply that may still run', async () => {
    const { applies } = await childAnswering(() => undefined);
    const change = await published();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = manager.applyModule(change);
    await vi.advanceTimersByTimeAsync(599_000);
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({
      outcome: 'no-answer', loaded: false, error: null,
      text: "m 1.0.0 was installed, but can't confirm whether it loaded on this machine: the bot did not answer within 10 minutes. The App Store tab lists this machine if the module fails to load here.",
    });
    expect(applies).toHaveLength(1);
    expect(staged()).toEqual([path.basename(change.staged!)]);
  });

  it('the uninstall unanswered within 600 s: T8 (b)', async () => {
    clone(V1);
    await runJob('install');
    await childAnswering(() => undefined);
    const change = await new AppStoreManager().uninstallModule('m') as PublishedChange;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = manager.applyModule(change);
    await vi.advanceTimersByTimeAsync(600_000);
    expect((await pending).text).toBe("m was uninstalled, but can't confirm whether this machine removed its files: the bot did not answer within 10 minutes. If it did not, its next pass removes them.");
  });

  it('the bot child exits during the wait: T8 (c) for an install, (d) for an uninstall', async () => {
    const { child } = await childAnswering(() => undefined);
    const change = await published();
    const pending = manager.applyModule(change);
    await new Promise(resolve => setTimeout(resolve, 5));
    exitChild(child, 1);
    expect(await pending).toMatchObject({
      outcome: 'stopped',
      text: "m 1.0.0 was installed, but can't confirm whether this machine applied it: the bot stopped before it answered. If it did not, it tries the version again when it next starts normally.",
    });
    const uninstall = await manager.applyModule({ ...change, operation: 'uninstall', to: 'absent', staged: null, version: null });
    expect(uninstall.outcome).toBe('not-running');
  });

  it('the bot child exits before it took requests: T8 (c)', async () => {
    const { child } = await startedWith([{ stage: 'shared' }], manager);
    const pending = manager.applyModule({ ...(await published()), operation: 'uninstall', to: 'absent', staged: null, version: null });
    await new Promise(resolve => setTimeout(resolve, 5));
    exitChild(child, 1);
    expect((await pending).text).toBe("m was uninstalled, but can't confirm whether this machine removed its files: the bot stopped before it answered. If it did not, it removes them when it next starts normally.");
  });
});

describe("the web UI's landing check of a publish whose COMMIT answer was lost (checkLanded)", () => {
  function loseCommit(found: boolean): void {
    let lostOnce = false;
    rig.state.rows.fault = sql => {
      if (sql !== 'COMMIT' || lostOnce) return undefined;
      lostOnce = true;
      return found ? 'lose' : new Error('Connection terminated unexpectedly');
    };
  }

  it('the check on a new session finds the op: the job goes on to module:apply', async () => {
    const { applies } = await childAnswering(() => ({ outcome: 'applied', reason: null, error: null, loaded: true }));
    loseCommit(true);
    const job = await (async () => { clone(V1); return runJob('install'); })();
    expect(job).toMatchObject({ status: 'completed', loaded: true });
    expect(applies).toHaveLength(1);
    const checks = s.sent.filter(q => q.sql.startsWith('SELECT id FROM smdb_data.shared_ops'));
    expect(checks).toHaveLength(1);
    expect(checks[0].session).toBeGreaterThan(s.sent.find(q => q.sql === 'COMMIT')!.session);
    expect(rig.state.rows.modules.get('m')?.sha).toBe(moduleShaOfFiles(V1));
  });

  it('the check finds no op: the job fails with the publish refusal, nothing applied, the staged folder deleted', async () => {
    const { applies } = await childAnswering(() => ({ outcome: 'applied', reason: null, error: null, loaded: true }));
    loseCommit(false);
    const job = await (async () => { clone(V1); return runJob('install'); })();
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/^m was not installed: /);
    expect(applies).toEqual([]);
    expect(staged()).toEqual([]);
    expect(rig.state.rows.modules.has('m')).toBe(false);
  });
});

describe('the job saves the credentials and awaits their op before the install (decision 28)', () => {
  it('stored: the credentials row holds them, then the install', async () => {
    await childAnswering(() => ({ outcome: 'applied', reason: null, error: null, loaded: true }));
    const job = await (async () => { clone(V1); return runJob('install', { API_KEY: 'made-up' }); })();
    expect(job).toMatchObject({ status: 'completed', loaded: true });
    expect(JSON.parse(rig.state.rows.docs.get('global/appstore/credentials/m.json')!.body.toString('utf8'))).toEqual({ API_KEY: 'made-up' });
  });

  it("refused because another machine changed them: the job fails with 28's 409 text and nothing is installed", async () => {
    // A bot child runs, so no store docs' pass brings this machine's mirror up to the row first.
    await childAnswering(() => ({ outcome: 'applied', reason: null, error: null, loaded: true }));
    rig.state.rows.put('global/appstore/credentials/m.json', '{"API_KEY":"other"}');
    const job = await (async () => { clone(V1); return runJob('install', { API_KEY: 'made-up' }); })();
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/^credentials\/m\.json was changed on BRAVO at .+ while this change was being made; nothing was saved\. Reload the App Store tab to see the current values\.$/);
    expect(rig.state.rows.modules.has('m')).toBe(false);
  });
});
