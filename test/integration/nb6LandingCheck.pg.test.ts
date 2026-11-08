import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dirs: { source: '', build: '', dist: '', dev: '' } }));

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const execSync = (cmd: string) => {
    if (cmd.startsWith('git rev-parse HEAD')) return Buffer.from('a'.repeat(40));
    throw new Error(`unexpected command in test: ${cmd.split(' ').slice(0, 2).join(' ')}`);
  };
  return { ...real, execSync, default: { ...real, execSync } };
});

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

import type { Client } from 'discord.js';
import { dataPath } from '../../src/utils/dataRoot';
import { AppStoreManager, type PublishedChange } from '../../src/bot/internalSetup/utils/appStoreManager';
import { _resetModuleApply, _setModuleDirs, setModuleApplyClient } from '../../src/bot/internalSetup/utils/moduleApply';
import { fakeLoader, moduleShaOfFiles } from '../helpers/nb6FakeLoader';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, rowCommitOwed, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import type { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { setBackendKind } from '../helpers/backendKind';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import { backendOn, commitProxy, pause, until, type CommitProxy } from '../helpers/nb6Pg';
import { sha } from '../helpers/sharedRows';

// NB6 test 39 [pg] (wip-redesign/sheets/NB6.md rows 84 and 165, cells 454 and 455, and row 60 (part 19); decisions 24,
// 35 and 52, D6): the landing check on real Postgres. A COMMIT's answer is lost through a proxy that cuts the connection
// right after it.

const CATEGORY = 'nb6check';
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const opts: dm.DataOptions = { scope: 'global', category: CATEGORY };
const text = (value: unknown) => JSON.stringify(value, null, 2);

let rig: ClaimRig;
let proxy: CommitProxy;
let backend: PostgresBackend;

beforeAll(async () => {
  rig = await startClaimRig();
  const c = rig.container;
  proxy = await commitProxy(c.getHost(), c.getPort(), c.getUsername(), c.getPassword(), c.getDatabase());
  backend = await backendOn(proxy.url);
}, 180_000);

afterAll(async () => {
  await backend?.stop();
  proxy?.close();
  await rig?.stop();
});

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetRowQueue();
  setBackendKind('postgres');
  dm.setGuildDataBackend(backend);
  proxy.queries.length = 0;
  // A lost COMMIT answer puts the backend in its hold, which fixedDatabase's chooser ends on a later timer turn: each
  // row starts on a backend that is not held.
  await until(() => backend.holdWords() === null);
});

afterEach(() => {
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  vi.restoreAllMocks();
});

const save = (name: string, value: unknown) => (dm.saveDataTracked(name, opts, value) as { ticket: unknown }).ticket as RowTicket;
const rowOf = async (key: string) => (await rig.direct.query('SELECT body, sha, rev::text AS rev FROM smdb_data.shared_docs WHERE key = $1', [key])).rows[0];

async function writeAs(key: string, body: string): Promise<void> {
  await rig.direct.query(
    `UPDATE smdb_data.shared_docs SET body = $2, sha = $3, rev = nextval('smdb_data.shared_rev_seq'), updated_at = now(), updated_by = 'BRAVO/p-bravo' WHERE key = $1`,
    [key, Buffer.from(body), sha(body)],
  );
}

async function settle(ticket: RowTicket): Promise<void> {
  const end = Date.now() + 60_000;
  while (rowTicketState(ticket) === 'open' && Date.now() < end) {
    await dm.flushAll();
    if (rowTicketState(ticket) === 'open') await pause(25);
  }
}

/** A first version landed, then an op whose COMMIT reached the server and whose answer was lost. */
async function lostOver(name: string): Promise<RowTicket> {
  const first = save(name, { v: 'base' });
  await dm.flushAll();
  expect(rowTicketState(first)).toBe('landed');
  proxy.next = 'cut-after';
  const ticket = save(name, { v: 'mine' });
  await dm.flushAll();
  expect(rowCommitOwed(ticket)).toBe(true);
  await until(() => backend.holdWords() === null);
  expect((await rowOf(keyOf(name))).body.toString('utf8')).toBe(text({ v: 'mine' }));
  return ticket;
}

describe('rows 84 and 165', () => {
  it('row 84: another session writes the base\'s body again; the next attempt finds the id, lands and writes nothing', async () => {
    const ticket = await lostOver('r84.json');
    await writeAs(keyOf('r84.json'), text({ v: 'base' }));
    const rev = (await rowOf(keyOf('r84.json'))).rev;
    await settle(ticket);
    expect(rowTicketState(ticket)).toBe('landed');
    const stored = await rowOf(keyOf('r84.json'));
    expect(stored.rev).toBe(rev);
    expect(stored.body.toString('utf8')).toBe(text({ v: 'base' }));
  }, 120_000);

  it('row 165: another session writes after it; the mirror and the record take that session\'s body', async () => {
    const ticket = await lostOver('r165.json');
    await writeAs(keyOf('r165.json'), text({ v: 'bravo' }));
    await settle(ticket);
    expect(rowTicketState(ticket)).toBe('landed');
    expect(fs.readFileSync(dataPath('global', CATEGORY, 'r165.json'), 'utf8')).toBe(text({ v: 'bravo' }));
  }, 120_000);
});

describe('cells 454 and 455', () => {
  it('cell 454: the check is BEGIN with the 30 s bound, the lock and the SELECT of the ids, then the statements\' bound', async () => {
    const ticket = await lostOver('c454.json');
    proxy.queries.length = 0;
    await settle(ticket);
    expect(proxy.queries[0]).toBe('BEGIN; SET LOCAL statement_timeout = 30000');
    expect(proxy.queries).toContain('ROLLBACK');
  }, 120_000);

  it('cell 455: the key\'s lock held past 30 s: a 57014, no answer; the op stays open on the backoff, then lands', async () => {
    const ticket = await lostOver('c455.json');
    const other = await rig.direct.connect();
    try {
      await other.query('BEGIN');
      await other.query("SELECT pg_advisory_xact_lock(hashtext('smdb_shared'), hashtext($1))", [keyOf('c455.json')]);
      await dm.flushAll();
      expect(rowTicketState(ticket)).toBe('open');
      expect(rowCommitOwed(ticket)).toBe(true);
      await other.query('ROLLBACK');
    } finally {
      other.release();
    }
    await pause(100);
    await settle(ticket);
    expect(rowTicketState(ticket)).toBe('landed');
  }, 180_000);
});

describe('row 60: an install whose publish lost its COMMIT answer', () => {
  const V1 = { 'module.json': '{"name":"m60","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
  const store = dataPath('global', 'appstore');
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb6row60-'));
    h.dirs = { source: path.join(root, 'appstore-modules'), build: path.join(root, 'build'), dist: path.join(root, 'dist'), dev: path.join(root, 'modulesDev') };
    for (const dir of [h.dirs.source, h.dirs.build, h.dirs.dist]) fs.mkdirSync(dir, { recursive: true });
    _setModuleDirs({ ...h.dirs, backups: path.join(store, 'cache', 'backups'), buildFile: path.join(root, '.build-complete') });
    fakeLoader.reset(h.dirs.source);
    setModuleApplyClient({} as Client);
    fs.rmSync(store, { recursive: true, force: true });
    fs.mkdirSync(path.join(store, 'cache', 'r60', '.git'), { recursive: true });
    fs.writeFileSync(path.join(store, 'repos.json'), JSON.stringify({ repositories: [{ id: 'r60', name: 'Repo', url: 'https://github.com/example/r', branch: 'main', enabled: true }] }, null, 2));
    for (const [rel, text] of Object.entries(V1)) {
      const file = path.join(store, 'cache', 'r60', 'Modules', 'm60', rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  });

  afterEach(() => {
    _setModuleDirs(null);
    _resetModuleApply();
    setModuleApplyClient(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('the landing check finds the op: the install answers stored and the staged copy is applied', async () => {
    const m = new AppStoreManager();
    proxy.next = 'cut-after';
    const answer = await m.installModule('m60', 'r60') as PublishedChange;
    await until(() => backend.holdWords() === null);
    const to = moduleShaOfFiles(V1);
    expect(proxy.next).toBeNull();
    expect(answer).toMatchObject({ module: 'm60', operation: 'install', to, applied: { outcome: 'applied', text: null } });
    const row = (await rig.direct.query('SELECT sha FROM smdb_data.shared_modules WHERE module = $1', ['m60'])).rows[0];
    expect(row.sha).toBe(to);
    const installed = (await rig.direct.query('SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1', ['global/appstore/installed.json'])).rows[0];
    expect(JSON.parse(Buffer.from(installed.body).toString('utf8')).modules.m60.version).toBe('1.0.0');
    expect(sha(fs.readFileSync(path.join(store, 'installed.json')))).toBe(installed.sha);
    expect(fs.readFileSync(path.join(h.dirs.source, 'm60', 'index.js'), 'utf8')).toBe(V1['index.js']);
    expect(fs.readdirSync(h.dirs.source).filter(n => n.startsWith('.incoming-'))).toEqual([]);
  }, 120_000);
});
