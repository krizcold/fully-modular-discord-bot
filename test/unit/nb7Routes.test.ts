import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConfigRoutes } from '../../src/webui/routes/config';
import { createGraveyardRoutes } from '../../src/webui/routes/graveyard';
import { shaOfRaw } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { writeBackup } from '../../src/webui/utils/configBackups';
import { ROUTE_TEXT } from '../../src/webui/botManager';
import { dataPath } from '../../src/utils/dataRoot';
import { BACKUPS, FakeChild, backupNames, botFor, call, put, readJson, resetData, startApp } from '../helpers/configRig';
import { GUILD, heldRow, isInsert, nb7Rig, resetNb7, type Rig } from '../helpers/nb7Rig';

// The restore route reads the guild's newest graveyard entry through the reader before it sends (NB14 decision 13); the
// rig scripts the request database only, so the reader answers that this guild has no entry.
vi.mock('../../src/webui/utils/webuiDataReader', async orig => {
  const actual = await orig<typeof import('../../src/webui/utils/webuiDataReader')>();
  let reader: ReturnType<typeof actual.getWebuiDataReader> | null = null;
  return {
    ...actual,
    getWebuiDataReader: () => {
      reader ??= Object.assign(Object.create(actual.getWebuiDataReader()), { listGuildGraveyard: async () => [] });
      return reader!;
    },
  };
});

// NB7 test 10: the five config write routes and the graveyard restore plan a Postgres guild's change (decision 3)
// after their own checks, inside the target's lock for update, restore and data/update, read and back up what the
// database holds when another machine runs the guild, and send the change as one request row. A guild this machine
// runs with its bot stopped answers bot-down before any read.

const child = new FakeChild();
const route = { starting: false };
const lock = { running: null as null | { jobId: string; to: string } };
let base = '';
let close: () => Promise<void>;
let rig: Rig;

const STARTING = { ok: false, status: 503, code: 'starting', error: ROUTE_TEXT.starting };

beforeAll(async () => {
  const real = botFor(child) as any;
  const manager = {
    ...real,
    migrationRunning: () => lock.running,
    writerRoute: (kind: string, opts: any) => (route.starting ? STARTING : real.writerRoute(kind, opts)),
    readGuildData: async (req: any) => (route.starting ? { ok: false, code: 'starting', error: ROUTE_TEXT.starting } : real.readGuildData(req)),
  };
  ({ url: base, close } = await startApp(app => {
    app.use('/api/config', createConfigRoutes(manager));
    app.use('/api/data/graveyard', createGraveyardRoutes(manager));
  }));
});
afterAll(async () => { await close(); });

const CONFIG_DB = JSON.stringify({ fromDb: 1 }, null, 2);
const DATA_DB = JSON.stringify({ fromDb: 2 });

beforeEach(async () => {
  await resetData();
  child.reset();
  route.starting = false;
  lock.running = null;
  rig = nb7Rig();
  put(dataPath('.backend.json'), { live: 'postgres', storeId: null, flippedAt: 0 });
  rig.docs.set(`${GUILD}/_guildConfig/config.json`, CONFIG_DB);
  rig.docs.set(`${GUILD}/mod/x.json`, DATA_DB);
  rig.script['postgres://one'] = sql => (sql.includes('INSERT INTO smdb_data.guild_requests\n')
    ? { rows: [], rowCount: 1 }
    : { rows: [{ state: 'done', reply: '{"ok":true}', pickup_over: false, answer_over: false }] });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  resetNb7();
  vi.restoreAllMocks();
});

const inserts = () => rig.statements.filter(isInsert);
const insertBody = () => JSON.parse(String(inserts()[0].values[6]));
const backups = () => backupNames().map(name => readJson(path.join(BACKUPS(), name)));

type Case = { name: string; send: () => Promise<{ status: number; body: any }>; db: string; module: string; filename: string };
const READ_ROUTES: Case[] = [
  { name: 'update', send: () => call(base, 'POST', '/api/config/update', { file: 'config.json', config: { a: 1 }, guildId: GUILD }), db: CONFIG_DB, module: '_guildConfig', filename: 'config.json' },
  {
    name: 'restore',
    send: () => {
      const name = writeBackup(BACKUPS(), 'mod/x.json', GUILD, JSON.stringify({ old: 1 })).filename;
      return call(base, 'POST', '/api/config/restore', { file: 'mod/x.json', filename: name, guildId: GUILD, category: 'data' });
    },
    db: DATA_DB, module: 'mod', filename: 'x.json',
  },
  { name: 'data/update', send: () => call(base, 'POST', '/api/config/data/update', { file: 'mod/x.json', data: { v: 3 }, guildId: GUILD, loadedSha: shaOfRaw(DATA_DB) }), db: DATA_DB, module: 'mod', filename: 'x.json' },
];

describe.each([
  ['stopped', () => { child.running = false; }],
  ['starting', () => { route.starting = true; }],
])('this machine\'s bot %s, the guild held by another machine', (_state, setUp) => {
  it.each(READ_ROUTES)('$name reads the database, backs up that body and sends one request built on it', async c => {
    setUp();
    const res = await c.send();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ success: true, servedBy: 'BRAVO' });
    expect(rig.holderCalls).toHaveLength(1);
    expect(rig.readDocCalls).toEqual([expect.objectContaining({ guildId: GUILD, module: c.module, filename: c.filename })]);
    expect(backups()).toContainEqual(JSON.parse(c.db));
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].values[4]).toBe('p-b');
    expect(insertBody()).toMatchObject({ module: c.module, filename: c.filename, expectSha: shaOfRaw(c.db) });
    expect(child.writes).toHaveLength(0);
  });
});

describe('this machine\'s bot stopped, the guild held by this machine', () => {
  beforeEach(() => {
    child.running = false;
    rig.holder = () => ({ rows: [heldRow({ holder_node: 'n-a', holder_name: 'ALPHA' })] });
  });

  it.each(READ_ROUTES)('$name answers bot-down before the read: no read, no backup, nothing sent', async c => {
    const before = backupNames().length;
    const res = await c.send();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, error: 'the bot process is not running' });
    expect(rig.readDocCalls).toHaveLength(0);
    expect(backupNames().length - before).toBe(c.name === 'restore' ? 1 : 0);
    expect(inserts()).toHaveLength(0);
  });

  it.each([
    ['data/delete', () => call(base, 'POST', '/api/config/data/delete', { file: 'mod/x.json', guildId: GUILD })],
    ['data/delete-guild', () => call(base, 'POST', '/api/config/data/delete-guild', { guildId: GUILD })],
  ])('%s answers bot-down with nothing sent', async (_name, send) => {
    const res = await send();
    expect(res.status).toBe(503);
    expect(inserts()).toHaveLength(0);
  });
});

describe('the delete routes and the graveyard restore: the plan, then the send, with no read', () => {
  beforeEach(() => { child.running = false; });

  it.each([
    ['data/delete', () => call(base, 'POST', '/api/config/data/delete', { file: 'mod/x.json', guildId: GUILD }), 'delete', { module: 'mod', filename: 'x.json' }],
    ['data/delete-guild', () => call(base, 'POST', '/api/config/data/delete-guild', { guildId: GUILD }), 'delete-namespace', { module: '', filename: '' }],
    ['graveyard restore', () => call(base, 'POST', '/api/data/graveyard/restore', { guildId: GUILD }), 'restore-graveyard', { module: '', filename: '' }],
  ] as const)('%s', async (_name, send, op, key) => {
    const res = await send();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ success: true, servedBy: 'BRAVO' });
    expect(rig.holderCalls).toHaveLength(1);
    expect(rig.readDocCalls).toHaveLength(0);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].values[5]).toBe(op);
    expect(insertBody()).toMatchObject(key);
  });
});

describe('the order of checks', () => {
  beforeEach(() => { child.running = false; });

  it('a running migration refuses every write before the plan', async () => {
    lock.running = { jobId: 'job-1', to: 'postgres' };
    for (const c of READ_ROUTES) expect((await c.send()).status, c.name).toBe(503);
    expect((await call(base, 'POST', '/api/config/data/delete', { file: 'mod/x.json', guildId: GUILD })).status).toBe(503);
    expect(rig.holderCalls).toHaveLength(0);
    expect(inserts()).toHaveLength(0);
  });

  it('invalid input is refused before the plan', async () => {
    const res = await call(base, 'POST', '/api/config/update', { file: 'config.json', config: 'nope', guildId: GUILD });
    expect(res.status).toBe(400);
    expect(rig.holderCalls).toHaveLength(0);
  });

  it('a store the data does not live in is refused before the plan', async () => {
    put(dataPath('.backend.json'), { live: 'file', storeId: null, flippedAt: 0 });
    put(dataPath(GUILD, 'mod', 'x.json'), { disk: 1 });
    const res = await call(base, 'POST', '/api/config/update', { file: 'config.json', config: { a: 1 }, guildId: GUILD });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/^Nothing was saved: /);
    expect(rig.holderCalls).toHaveLength(0);
  });

  it('the plan runs inside the target\'s lock: a second save of the same file waits for the first', async () => {
    let release!: () => void;
    let first = true;
    rig.holder = () => {
      if (!first) return { rows: [heldRow()] };
      first = false;
      return new Promise(resolve => { release = () => resolve({ rows: [heldRow()] }); });
    };
    const one = call(base, 'POST', '/api/config/update', { file: 'config.json', config: { a: 1 }, guildId: GUILD });
    for (let i = 0; i < 50 && rig.holderCalls.length === 0; i++) await new Promise(r => setTimeout(r, 10));
    const two = call(base, 'POST', '/api/config/update', { file: 'config.json', config: { a: 2 }, guildId: GUILD });
    await new Promise(r => setTimeout(r, 100));
    expect(rig.holderCalls).toHaveLength(1);
    release();
    expect((await one).status).toBe(200);
    expect((await two).status).toBe(200);
    expect(rig.holderCalls).toHaveLength(2);
    expect(inserts()).toHaveLength(2);
  });
});
