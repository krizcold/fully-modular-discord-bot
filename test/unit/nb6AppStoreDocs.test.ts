import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 34 (wip-redesign/sheets/NB6.md decisions 28, 33, 36, 51 and 53, rows 89 to 91, 104, 168 and 171 to 173,
// ruling E1; part 13): App Store doc writes on a Postgres bot through the real AppStoreManager, the real facade and the
// real flush over scripted clients that answer as the shared tables do (helpers/sharedRows.ts). Rows 102 and 103 are
// part 26's. Two rows more for part 5's gap: the store record's entry and the move aside of a store key's mirror.

const h = vi.hoisted(() => ({ clone: null as null | ((dir: string) => void) }));

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const fsReal = await vi.importActual<any>('fs');
  const pathReal = await vi.importActual<any>('path');
  const execSync = (cmd: string, opts: any = {}) => {
    if (cmd.startsWith('git rev-parse HEAD')) return Buffer.from('a'.repeat(40));
    if (cmd.startsWith('git remote set-url') || cmd.startsWith('git fetch')) return Buffer.from('');
    if (cmd.startsWith('git clone')) {
      const target = cmd.match(/"([^"]+)"$/)![1];
      fsReal.mkdirSync(pathReal.join(target, '.git'), { recursive: true });
      h.clone?.(target);
      return Buffer.from('');
    }
    throw new Error(`unexpected command in test: ${cmd.split(' ').slice(0, 2).join(' ')}`);
  };
  return { ...real, execSync, default: { ...real, execSync } };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => undefined }));

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => {
  const real = await orig<any>();
  const root = process.env.DATA_DIR as string;
  return {
    ...real,
    getModulesDir: () => path.join(root, 'runtime-modules'),
    getSourceModulesDir: () => path.join(root, 'appstore-modules'),
    getBuildModulesDir: () => path.join(root, 'build-modules'),
    getModulesDevDir: () => path.join(root, 'modulesDev'),
  };
});

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { AppStoreManager, StoreWriteError, storeMutex } from '../../src/bot/internalSetup/utils/appStoreManager';
import { _resetRowQueue, rowQueue, rowTicketState, type RowOp } from '../../src/bot/internalSetup/utils/sharedStore';
import { readStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sha, sharedRows } from '../helpers/sharedRows';

const STORE = dataPath('global', 'appstore');
const REPOS = path.join(STORE, 'repos.json');
const CREDS = path.join(STORE, 'credentials', 'mod.json');
const CACHE = path.join(STORE, 'cache');
const SOURCE = dataPath('appstore-modules');
const REPOS_KEY = 'global/appstore/repos.json';
const CREDS_KEY = 'global/appstore/credentials/mod.json';
const AT = '2026-11-07T10:00:00.000Z';

const LOCK = /pg_advisory_xact_lock/;

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;
let warns: string[];
let errors: string[];

beforeEach(() => {
  warns = [];
  errors = [];
  for (const dir of [STORE, SOURCE, dataPath('build-modules'), dataPath('runtime-modules'), dataPath('_superseded')]) fs.rmSync(dir, { recursive: true, force: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  h.clone = null;
  _resetRowQueue();
  setBackendKind('postgres');
  rows = sharedRows();
  rig = scriptedBackend(rows.answer);
  dm.setGuildDataBackend(rig.backend);
});

afterEach(async () => {
  vi.useRealTimers();
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  await rig.backend.stop();
  vi.restoreAllMocks();
});

/** A manager whose repos.json the real flush stored: the defaults its load queued, landed by the flush's own block. */
async function landedStore(): Promise<AppStoreManager> {
  const m = new AppStoreManager();
  await dm.flushAll();
  expect(rows.docs.get(REPOS_KEY)?.sha).toBe(sha(fs.readFileSync(REPOS)));
  rig.sent.length = 0;
  return m;
}

const reposOnDisk = () => JSON.parse(fs.readFileSync(REPOS, 'utf8')).repositories.map((r: { id: string }) => r.id) as string[];
const storeEntry = (key: string) => {
  const record = readStoreRecord();
  if (!record.ok) throw new Error(record.reason);
  return record.record.docs[key];
};

/** Holds the first attempt of the next op at its lock statement until release is called. */
function holdAtLock(): { release: () => void } {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  rows.fault = sql => {
    if (!LOCK.test(sql) || !first) return undefined;
    first = false;
    return held.then(() => undefined);
  };
  return { release };
}

async function until(test: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !test(); i++) await new Promise<void>(resolve => { setImmediate(resolve); });
  expect(test()).toBe(true);
}

describe('rows 89 and 171: the ticket lands within 40 s', () => {
  it('the mirror and the store record are written in one block in the section\'s hold, before it resumes', async () => {
    const m = await landedStore();
    const acquire = vi.spyOn(storeMutex, 'acquire');
    let seen: { ids: string[]; entry: unknown } | null = null;
    const repo = await m.addRepositoryAwaited('Extra', 'https://github.com/example/extra', 'main').then(r => {
      seen = { ids: reposOnDisk(), entry: storeEntry(REPOS_KEY) };
      return r;
    });
    const stored = rows.docs.get(REPOS_KEY)!;
    expect(JSON.parse(stored.body.toString('utf8')).repositories.map((r: { id: string }) => r.id)).toContain(repo.id);
    expect(seen!.ids).toContain(repo.id);
    expect(seen!.entry).toEqual({ sha: stored.sha, stamp: null, main: null });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(rowQueue.ops(REPOS_KEY)).toEqual([]);
    expect(m.getRepository(repo.id)?.name).toBe('Extra');
  });

  it('a credentials save answers true once the row, the mirror and the entry hold it', async () => {
    const m = await landedStore();
    await expect(m.saveCredentialsAwaited('mod', { token: 'x' })).resolves.toBe(true);
    const stored = rows.docs.get(CREDS_KEY)!;
    expect(fs.readFileSync(CREDS, 'utf8')).toBe(JSON.stringify({ token: 'x' }, null, 2));
    expect(storeEntry(CREDS_KEY)).toEqual({ sha: stored.sha, stamp: null, main: null });
  });
});

describe('row 90: refused \'changed-elsewhere\'', () => {
  it('answers 409 with the machine and time, and nothing local changes', async () => {
    const m = await landedStore();
    const before = fs.readFileSync(REPOS, 'utf8');
    const entryBefore = storeEntry(REPOS_KEY);
    rows.put(REPOS_KEY, JSON.stringify({ repositories: [] }, null, 2), 'BRAVO/p-bravo');
    const error = await m.addRepositoryAwaited('Extra', 'https://github.com/example/extra', 'main').catch(e => e);
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.status).toBe(409);
    expect(error.message).toBe(`repos.json was changed on BRAVO at ${AT} while this change was being made; nothing was saved. Reload the App Store tab to see the current values.`);
    expect(fs.readFileSync(REPOS, 'utf8')).toBe(before);
    expect(storeEntry(REPOS_KEY)).toEqual(entryBefore);
    expect(m.getRepositories().map(r => r.id)).toEqual(['official-modules']);
  });
});

describe('rows 91 and 172: no settle within 40 s', () => {
  it('answers 202 and the op goes on; the flush later takes the store mutex itself and runs the block (E1: no place held while it waits)', async () => {
    const m = await landedStore();
    const acquire = vi.spyOn(storeMutex, 'acquire');
    const lock = holdAtLock();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const answer = m.addRepositoryAwaited('Extra', 'https://github.com/example/extra', 'main').catch(e => e);
    await vi.advanceTimersByTimeAsync(40_000);
    const error = await answer;
    vi.useRealTimers();
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.status).toBe(202);
    expect(error.message).toBe("Can't confirm that the repository list change was saved: the database has not answered yet (no answer within 40 s). Reload the App Store tab in a minute to see whether it was.");
    const [op] = rowQueue.ops(REPOS_KEY) as RowOp[];
    expect(op.state).toBe('wire');

    // Row 172: the section released its hold; the test holds the mutex so the flush waits for it.
    const hold = (await storeMutex.acquire())!;
    lock.release();
    await until(() => op.state === 'store');
    expect(rig.backend.sharedPlacesInUse()).toEqual({ shared: 0, flush: 0 });
    expect(rowTicketState({ kind: 'row', key: REPOS_KEY, op, seq: 1 })).toBe('open');
    expect(reposOnDisk()).toEqual(['official-modules']);
    hold.release();
    await dm.flushAll();
    expect(op.state).toBe('landed');
    expect(reposOnDisk()).toHaveLength(2);
    expect(storeEntry(REPOS_KEY)).toEqual({ sha: rows.docs.get(REPOS_KEY)!.sha, stamp: null, main: null });
    expect(acquire).toHaveBeenCalledTimes(3);
  });
});

describe('row 168: a refresh while addRepository\'s op waits after a 202', () => {
  it('the refresh writes lastRefreshed as its own op on the old bytes, refused with T15 when the first lands', async () => {
    const m = await landedStore();
    const oldSha = sha(fs.readFileSync(REPOS));
    fs.mkdirSync(path.join(CACHE, 'official-modules', '.git'), { recursive: true });
    const lock = holdAtLock();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const answer = m.addRepositoryAwaited('Extra', 'https://github.com/example/extra', 'main').catch(e => e);
    await vi.advanceTimersByTimeAsync(40_000);
    expect((await answer).status).toBe(202);
    vi.useRealTimers();

    await m.refreshRepository('official-modules');
    const ops = [...rowQueue.ops(REPOS_KEY)] as RowOp[];
    expect(ops).toHaveLength(2);
    expect(ops[1].base).toBe(oldSha);
    expect(ops[1].callerBase).toBe(true);

    lock.release();
    await until(() => rowQueue.ops(REPOS_KEY).length === 0);
    await dm.flushAll();
    expect(ops[0].state).toBe('landed');
    expect(ops[1].state).toBe('refused');
    await until(() => errors.some(e => e.startsWith('[AppStoreManager]')));
    expect(errors).toContain(`[AppStoreManager] repos.json was not saved: it changed after this write read it (saved by this machine at ${AT})`);
    expect(reposOnDisk()).toHaveLength(2);
  });
});

describe('row 173: the refresh right after addRepository landed', () => {
  it('reads the new repos.json', async () => {
    const m = await landedStore();
    const repo = await m.addRepositoryAwaited('Extra', 'https://github.com/example/extra', 'main');
    h.clone = dir => {
      fs.mkdirSync(path.join(dir, 'Modules', 'alpha'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Modules', 'alpha', 'module.json'), JSON.stringify({ name: 'alpha', version: '1.0.0' }));
    };
    const modules = await m.refreshRepository(repo.id);
    expect(modules.map(x => x.manifest.name)).toEqual(['alpha']);
  });
});

describe('row 104: reconcileInstalledModules', () => {
  it('a Postgres bot leaves a module folder installed.json does not list', () => {
    fs.mkdirSync(path.join(SOURCE, 'orphan'), { recursive: true });
    fs.mkdirSync(STORE, { recursive: true });
    fs.writeFileSync(path.join(STORE, 'installed.json'), JSON.stringify({ modules: {} }));
    new AppStoreManager();
    expect(fs.existsSync(path.join(SOURCE, 'orphan'))).toBe(true);
  });

  it('a JSON bot removes it as before', () => {
    setBackendKind('file');
    fs.mkdirSync(path.join(SOURCE, 'orphan'), { recursive: true });
    fs.mkdirSync(STORE, { recursive: true });
    fs.writeFileSync(path.join(STORE, 'installed.json'), JSON.stringify({ modules: {} }));
    new AppStoreManager();
    expect(fs.existsSync(path.join(SOURCE, 'orphan'))).toBe(false);
  });
});

describe('part 5\'s gap: the store record and the move aside for store keys', () => {
  it('a delete of a store key removes the mirror and drops its entry from the store record', async () => {
    const m = await landedStore();
    await m.saveCredentialsAwaited('mod', { token: 'x' });
    expect(storeEntry(CREDS_KEY)).toBeDefined();
    await expect(m.deleteCredentialsAwaited('mod')).resolves.toBe(true);
    expect(rows.docs.has(CREDS_KEY)).toBe(false);
    expect(fs.existsSync(CREDS)).toBe(false);
    expect(storeEntry(CREDS_KEY)).toBeUndefined();
  });

  it('a mirror changed outside the bot after the read is moved aside before the stored version is written', async () => {
    const m = await landedStore();
    const repo = m.addRepository('Extra', 'https://github.com/example/extra', 'main');
    const outside = '{ "repositories": [] }';
    fs.writeFileSync(REPOS, outside);
    await dm.flushAll();
    expect(reposOnDisk()).toContain(repo.id);
    const aside = fs.readdirSync(dataPath('_superseded'));
    expect(aside).toHaveLength(1);
    const moved = path.join(dataPath('_superseded'), aside[0], 'global', 'appstore', 'repos.json');
    expect(fs.readFileSync(moved, 'utf8')).toBe(outside);
    expect(warns).toContain(`[Shared] Moved ${REPOS} to ${moved}: it differed from the version this machine last took from the database (changed outside the bot, or left by a crash); the database's version is back in its place`);
    expect(storeEntry(REPOS_KEY)).toEqual({ sha: rows.docs.get(REPOS_KEY)!.sha, stamp: null, main: null });
  });
});
