import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 34's rows 102 and 103 (wip-redesign/sheets/NB6.md decision 31; part 26): in the web UI process of a Postgres
// bot with no bot child, an App Store route or an install job first runs the store docs' pass under the store mutex,
// its rows read on the reader pool; a pass that gets no answer fails the route with 31's 503 and reads or writes
// nothing. The rows are another machine's, written by helpers/sharedRows.ts as the flush stores them; the mirrors and
// the store record are the real pass's. Also: the web UI's passes never apply a module (decisions 31 and 44).

const safety = vi.hoisted(() => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...real, fork, default: { ...real, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, rowQueue, useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, refreshShared, setSharedModulePassStep } from '../../src/bot/internalSetup/utils/sharedMirror';
import { readStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { InstallQueue, type InstallJob } from '../../src/webui/utils/installQueue';
import { forks } from '../helpers/forkMock';
import { setBackendKind } from '../helpers/backendKind';
import { setView } from '../helpers/nb6Mirror';
import { exitChild, freshWriterLock, resetForks, startedWith } from '../helpers/nb10Rig';
import { webuiSessions } from '../helpers/nb6WebuiSession';

const STORE = dataPath('global', 'appstore');
const REPOS_KEY = 'global/appstore/repos.json';
const REPOS_FILE = path.join(STORE, 'repos.json');
const INSTALLED_KEY = 'global/appstore/installed.json';
const A = 'postgres://bot@db:5432/bot';
const repos = (...ids: string[]) => JSON.stringify({ repositories: ids.map(id => ({ id, name: id, url: `https://github.com/example/${id}`, branch: 'main', enabled: true })) }, null, 2);

let manager: BotManager;
let s: ReturnType<typeof webuiSessions>;
let lines: string[];
let selects: string[];

beforeEach(() => {
  lines = [];
  selects = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  freshWriterLock('webui');
  resetForks();
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.rmSync(dataPath('_superseded'), { recursive: true, force: true });
  fs.mkdirSync(STORE, { recursive: true });
  setBackendKind('postgres');
  setView(1, 'ALPHA');
  dm.setGuildDataBackend(null);
  dm.setSharedWriteGate(inLocalOp);
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  manager = new BotManager();
  s = webuiSessions();
  useWebuiSessions({
    target: async () => ({ entry: A, tag: '1:ALPHA', countAtStart: 0 }),
    commitCheck: () => null,
    select: async (text, values) => {
      selects.push(text);
      const res = await s.rows.answer(text, values, 0, 999);
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
  _resetRowQueue();
  _resetSharedMirror();
  setBackendKind(null);
  freshWriterLock('webui');
  vi.restoreAllMocks();
});

/** One route of the App Store router, called as express calls it; resolves with the status and body it answered. */
async function route(method: 'get' | 'post' | 'put' | 'delete', at: string, req: { params?: object; body?: object } = {}): Promise<{ status: number; body: any }> {
  const router = createAppStoreRoutes(manager) as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } }[] };
  const layer = router.stack.find(l => l.route?.path === at && l.route.methods[method]);
  let status = 200;
  let body: any;
  const res = { status(code: number) { status = code; return res; }, json(b: unknown) { body = b; return res; } };
  await layer!.route!.stack[0].handle({ params: {}, body: {}, query: {}, ...req }, res);
  return { status, body };
}

const storeEntry = (key: string) => {
  const read = readStoreRecord();
  if (!read.ok) throw new Error(read.reason);
  return read.record.docs[key];
};

function runJob(): Promise<InstallJob> {
  const queue = new InstallQueue();
  queue.setBotManager(manager);
  return new Promise(resolve => {
    queue.on('completed', resolve);
    queue.on('failed', resolve);
    queue.enqueueInstall('m', 'r1');
  });
}

describe('row 102: no bot child; the store docs pass first', () => {
  it("a route reads the version another machine stored: the pass brings the mirror and its entry to the row", async () => {
    s.rows.put(REPOS_KEY, repos('r1'));
    const first = await route('get', '/repos');
    expect(first.body.repositories.map((r: any) => r.id)).toEqual(['r1']);
    expect(fs.readFileSync(REPOS_FILE).equals(s.rows.docs.get(REPOS_KEY)!.body)).toBe(true);
    expect(storeEntry(REPOS_KEY)).toEqual({ sha: s.rows.docs.get(REPOS_KEY)!.sha, stamp: null, main: '1:ALPHA' });

    s.rows.put(REPOS_KEY, repos('r1', 'r2'));
    const second = await route('get', '/repos');
    expect(second.status).toBe(200);
    expect(second.body.repositories.map((r: any) => r.id)).toEqual(['r1', 'r2']);
    expect(storeEntry(REPOS_KEY)!.sha).toBe(s.rows.docs.get(REPOS_KEY)!.sha);
    expect(fs.existsSync(dataPath('_superseded'))).toBe(false);
  });

  it('a mirror changed outside the bot is moved aside before the row is put in its place', async () => {
    s.rows.put(REPOS_KEY, repos('r1'));
    await route('get', '/repos');
    fs.writeFileSync(REPOS_FILE, repos('edited'));
    const answer = await route('get', '/repos');
    expect(answer.body.repositories.map((r: any) => r.id)).toEqual(['r1']);
    const moved = lines.find(l => l.startsWith(`[Shared] Moved ${REPOS_FILE} to `));
    expect(moved).toMatch(/: it differed from the version this machine last took from the database \(changed outside the bot, or left by a crash\); the database's version is back in its place$/);
  });

  it('a store doc the database no longer holds is removed with its entry', async () => {
    s.rows.put(INSTALLED_KEY, '{"modules":{}}');
    await route('get', '/installed');
    expect(fs.existsSync(path.join(STORE, 'installed.json'))).toBe(true);
    s.rows.docs.delete(INSTALLED_KEY);
    await route('get', '/installed');
    expect(fs.existsSync(path.join(STORE, 'installed.json'))).toBe(false);
    expect(storeEntry(INSTALLED_KEY)).toBeUndefined();
  });

  it("an install job: the pass first, so a module another machine installed is seen as installed", async () => {
    s.rows.put(INSTALLED_KEY, JSON.stringify({ modules: { m: { name: 'm', version: '1.0.0', installedFrom: 'r1', installedAt: '2026-11-08T00:00:00.000Z' } } }));
    const job = await runJob();
    expect(job).toMatchObject({ status: 'completed', skipped: true });
  });

  it('with a bot child running the route runs no pass (guard)', async () => {
    await startedWith([{ stage: 'shared' }, { stage: 'guild' }], manager);
    s.rows.put(REPOS_KEY, repos('r9'));
    fs.writeFileSync(REPOS_FILE, repos('r1'));
    const answer = await route('get', '/repos');
    expect(answer.body.repositories.map((r: any) => r.id)).toEqual(['r1']);
    expect(selects).toEqual([]);
    expect(storeEntry(REPOS_KEY)).toBeUndefined();
  });
});

describe('row 103: the pass gets no answer', () => {
  const DOWN = "Can't reach the database to read the App Store's files (connect ECONNREFUSED 10.0.0.1:5432); nothing was changed. Try again in a moment.";
  beforeEach(() => {
    fs.writeFileSync(REPOS_FILE, repos('r1'));
    s.rows.fault = sql => (sql === 'SELECT key, sha FROM smdb_data.shared_docs' ? new Error('connect ECONNREFUSED 10.0.0.1:5432') : undefined);
  });

  it('a read route answers 503 and reads nothing', async () => {
    expect(await route('get', '/repos')).toEqual({ status: 503, body: { success: false, error: DOWN } });
    expect(selects).toEqual(['SELECT key, sha FROM smdb_data.shared_docs']);
    expect(fs.readFileSync(REPOS_FILE, 'utf8')).toBe(repos('r1'));
  });

  it('a write route answers 503 and queues nothing', async () => {
    const answer = await route('delete', '/credentials/:name', { params: { name: 'm' } });
    expect(answer).toEqual({ status: 503, body: { success: false, error: DOWN } });
    expect(rowQueue.keys()).toEqual([]);
    expect(s.sessions()).toBe(0);
  });

  it('an install job fails with the same text', async () => {
    expect(await runJob()).toMatchObject({ status: 'failed', error: DOWN });
  });
});

describe("R4-B2: this machine's store record write fails", () => {
  it('a read route answers the local form with the cause, and the mirror stays as it is', async () => {
    s.rows.put(REPOS_KEY, repos('r1'));
    // The mirror holds the row and the store record has no entry for it (a crash between the mirror write and the record's).
    fs.writeFileSync(REPOS_FILE, repos('r1'));
    const record = dataPath('global', 'appstore', 'cache', '.shared-mirror.json');
    const real = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).startsWith(`${record}.`)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.openSync);
    expect(await route('get', '/repos')).toEqual({
      status: 500,
      body: { success: false, error: "This machine could not write its copy of the App Store's files (ENOSPC: no space left on device), so nothing was changed. Check this machine's disk, then try again." },
    });
    expect(fs.readFileSync(REPOS_FILE, 'utf8')).toBe(repos('r1'));
    expect(lines).toContain(`[Shared] Could not write ${record} (ENOSPC); retrying`);
  });
});

describe("the web UI's pass applies no module (decisions 31 and 44)", () => {
  it("refreshShared(null), the chain's reconcile, runs the docs and never the module step", async () => {
    const steps: unknown[] = [];
    setSharedModulePassStep(async pass => { steps.push(pass); return true; });
    s.rows.put('global/nb6storepass/x.json', '{"a":1}');
    expect(await refreshShared(null)).toEqual({ ok: true });
    expect(fs.readFileSync(dataPath('global', 'nb6storepass', 'x.json'), 'utf8')).toBe('{"a":1}');
    expect(steps).toEqual([]);
  });
});
