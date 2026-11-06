import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/dataBackends/recognitionGuard', async importOriginal => ({
  ...(await importOriginal<object>()),
  verifyStoreIdentity: () => new Promise(() => {}),
}));

import { ANSWER_BOUND_MS, PostgresBackend, SCHEMA_VERSION, type DatabaseChooser } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { storeIdRefusal } from '../../src/bot/internalSetup/utils/dataBackends/storeShape';
import { MainChooser, WATCH_FAST_MS, type ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { _startPostgresRuntime } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { parseAddressList } from '../../src/utils/databaseAddress';
import { setBackendKind } from '../helpers/backendKind';
import { fixedChooser } from '../helpers/fixedDatabase';

// MB2, the merge of NB16 into NB5: NB16's store check runs on NB5's backend model. The fake pool answers the check of
// a store at this bot's version whose catalog matches the reference; a statement can be left without an answer, which
// the client ends at its query_timeout as pg does.

const A = 'postgres://bot@db1:5432/bot';
const LOCK = /^SELECT pg_try_advisory_xact_lock\(hashtext\('smdb_data_bootstrap'\)\) AS locked$/;
const STORE_ID = /^SELECT 1 FROM ONLY smdb_data\.meta WHERE key = 'store_id'$/;
const VERSION = /^SELECT value::text FROM ONLY smdb_data\.meta WHERE key = 'schema_version'/;
const META = { kind: 'r', key_text: true, value_text: true, value_not_null: true, rls: false, unique_key: true, select: true };
const rel = (name: string, kind: string) => ({
  name, kind, is_partition: false, select: kind === 'r' ? true : null, insert: kind === 'r' ? true : null,
  update: kind === 'r' ? true : null, delete: kind === 'r' ? true : null, usage: null, update_seq: null,
});
const FOUND = {
  role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: true, schema_usage: true, schema_create: true,
  relations: [rel('meta', 'r'), rel('meta_pkey', 'i')], meta: META,
};

type Sent = { sql: string; timeout?: number; client: number };
type Reply = unknown | 'hang';
interface Script {
  storeId?: boolean;
  reply?: (sql: string, client: number) => Reply;
}

function answer(sql: string, script: Script): unknown {
  if (LOCK.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
  if (sql === 'SHOW server_version_num') return { rows: [{ server_version_num: '160004' }], rowCount: 1 };
  if (sql === 'SHOW server_encoding') return { rows: [{ server_encoding: 'UTF8' }], rowCount: 1 };
  if (/has_database_privilege/.test(sql)) return { rows: [FOUND], rowCount: 1 };
  if (VERSION.test(sql)) return { rows: [{ value: JSON.stringify({ v: SCHEMA_VERSION }) }], rowCount: 1 };
  if (STORE_ID.test(sql)) return script.storeId === false ? { rows: [], rowCount: 0 } : { rows: [{ '?column?': 1 }], rowCount: 1 };
  if (sql === 'SELECT pg_is_in_recovery() AS in_recovery') return { rows: [{ in_recovery: false }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

function fakePool(script: Script) {
  const sent: Sent[] = [];
  const releases: Array<{ client: number; destroy: boolean | undefined }> = [];
  let ids = 0;
  const emitter = new EventEmitter();
  const makeClient = () => {
    const id = ++ids;
    return {
      query(config: string | { text: string; query_timeout?: number }) {
        const sql = (typeof config === 'string' ? config : config.text).trim();
        const timeout = typeof config === 'string' ? undefined : config.query_timeout;
        sent.push({ sql, timeout, client: id });
        const reply = script.reply?.(sql, id);
        return new Promise((resolve, reject) => {
          if (reply === 'hang') {
            if (timeout !== undefined) setTimeout(() => reject(new Error('Query read timeout')), timeout);
            return;
          }
          const r = reply === undefined ? answer(sql, script) : reply;
          if (r instanceof Error) reject(r);
          else resolve(r);
        });
      },
      release(destroy?: boolean) { releases.push({ client: id, destroy }); },
      end: () => Promise.resolve(),
      on: () => undefined,
    };
  };
  const pool = {
    connect: vi.fn(async () => makeClient()),
    query: vi.fn(async (config: string | { text: string }) => answer(typeof config === 'string' ? config : config.text, script)),
    end: vi.fn(async () => undefined),
    on: (event: string, fn: (...args: unknown[]) => void) => { emitter.on(event, fn); return pool; },
  };
  return { pool, sent, releases, onClient: (id: number) => sent.filter(s => s.client === id).map(s => s.sql) };
}

const backends: PostgresBackend[] = [];
beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.stop();
  setBackendKind(null);
  setGuildDataBackend(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function withPool(script: Script) {
  const fake = fakePool(script);
  vi.spyOn(PostgresBackend.prototype as unknown as { makePool(config: unknown): unknown }, 'makePool').mockReturnValue(fake.pool);
  return fake;
}

describe("MB2 (a): boot's runtime hands the backend the marker's store id", () => {
  const markerFile = () => path.join(process.env.DATA_DIR as string, '.backend.json');
  afterEach(() => fs.rmSync(markerFile(), { force: true }));

  it('a store with no store_id row is refused with NB16 text when the marker names a store, and no id is written', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    setBackendKind('postgres');
    vi.stubEnv('DATA_BACKEND_URL', A);
    fs.writeFileSync(markerFile(), JSON.stringify({ live: 'postgres', storeId: 'store-7', flippedAt: 1 }));
    const fake = withPool({ storeId: false });
    const probe: ProbeAnswer = {
      kind: 'answered', address: parseAddressList(A)[0].shown, entry: A, inRecovery: false, readOnly: false, generation: 1,
      machine: 'M', since: '2026-11-01', sysid: '1', started: A, storeId: null,
    };
    const chooser = new MainChooser({
      entries: () => parseAddressList(A),
      probe: async () => [probe],
      readNotice: async () => ({ kind: 'none' }),
      sendWaitDm: async () => ({ ok: true }),
      markerStoreId: () => 'store-7',
      noticeCheckOff: () => false,
      nodeName: () => 'node-a',
      onWait: () => undefined,
    });
    const backend = _startPostgresRuntime(chooser);
    backends.push(backend);
    const verdict = backend.provisionVerdict();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(backend.chosenEntry()).toBe(A);
    const refusal = storeIdRefusal('store-7');
    expect(await verdict).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(fake.sent.map(s => s.sql).filter(s => /^INSERT INTO smdb_data\.meta/.test(s))).toEqual([]);
    expect(backend.servesData()).toBe(false);
    chooser.stop();
  });
});

describe('MB2 (b): a check statement with no answer within the bound', () => {
  it('spoils the lease: nothing more is sent on it, the client is destroyed with its lock, and bootstrapLoop retries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let hung = false;
    const fake = withPool({
      reply: sql => {
        if (sql === 'SHOW server_encoding' && !hung) {
          hung = true;
          return 'hang';
        }
        return undefined;
      },
    });
    const backend = new PostgresBackend({ chooser: fixedChooser(A) });
    backends.push(backend);
    backend.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = fake.sent.find(s => s.sql === 'SHOW server_encoding')!;
    expect(first.timeout).toBe(ANSWER_BOUND_MS);
    expect(fake.sent.filter(s => s.client === first.client).every(s => s.timeout === ANSWER_BOUND_MS)).toBe(true);
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS - 1);
    expect(fake.releases).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.onClient(first.client).at(-1)).toBe('SHOW server_encoding');
    expect(fake.releases).toEqual([{ client: first.client, destroy: true }]);
    const verdict = backend.provisionVerdict();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.pool.connect).toHaveBeenCalledTimes(2);
    expect(fake.onClient(2)).toContain('COMMIT');
    expect(await verdict).toEqual({ state: 'provisioned' });
    expect(backend.connectionState().state).toBe('ready');
  });
});

describe('MB2 (c): a check that passes while the backend is held', () => {
  it('leaves the backend held until the chooser confirms (decision 13)', async () => {
    let backend!: PostgresBackend;
    let holdEpoch = -1;
    const chooser: DatabaseChooser = {
      chosen: () => A,
      awaitChoice: async () => A,
      lastPassLogin: () => 'unreachable',
      holdStarted: (_b, epoch) => { holdEpoch = epoch; },
      confirmNow: () => undefined,
      stop: () => undefined,
    };
    withPool({
      reply: sql => {
        if (sql === 'COMMIT') backend.noteLapse();
        return undefined;
      },
    });
    backend = new PostgresBackend({ chooser });
    backends.push(backend);
    backend.start();
    expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
    await new Promise(resolve => { setImmediate(resolve); });
    expect(backend.connectionState().state).toBe('outage');
    expect(backend.servesData()).toBe(false);
    expect(holdEpoch).toBe(backend.databaseEpoch());
    backend.noteEntryAnswered(holdEpoch);
    expect(backend.servesData()).toBe(false);
    backend.confirmHold(holdEpoch);
    expect(backend.connectionState().state).toBe('ready');
    expect(backend.servesData()).toBe(true);
  });
});

describe('MB2 R1-1: the watch of a backend refused by its store check', () => {
  const markerFile = () => path.join(process.env.DATA_DIR as string, '.backend.json');
  afterEach(() => fs.rmSync(markerFile(), { force: true }));

  async function refusedWatch(script: Script, marker: string | null) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    setBackendKind('postgres');
    vi.stubEnv('DATA_BACKEND_URL', A);
    fs.writeFileSync(markerFile(), JSON.stringify({ live: 'postgres', storeId: marker, flippedAt: 1 }));
    withPool(script);
    const probes: number[] = [];
    const probe: ProbeAnswer = {
      kind: 'answered', address: parseAddressList(A)[0].shown, entry: A, inRecovery: false, readOnly: false, generation: 1,
      machine: 'M', since: '2026-11-01', sysid: '1', started: A, storeId: marker,
    };
    const chooser = new MainChooser({
      entries: () => parseAddressList(A),
      probe: async () => { probes.push(Date.now()); return [probe]; },
      readNotice: async () => ({ kind: 'none' }),
      sendWaitDm: async () => ({ ok: true }),
      markerStoreId: () => marker,
      noticeCheckOff: () => false,
      nodeName: () => 'node-a',
      onWait: () => undefined,
    });
    const backend = _startPostgresRuntime(chooser);
    backends.push(backend);
    const verdict = backend.provisionVerdict();
    await vi.advanceTimersByTimeAsync(30_000);
    return { backend, chooser, probes, verdict: await verdict };
  }

  async function expectWatchCadence(run: Awaited<ReturnType<typeof refusedWatch>>) {
    const { backend, chooser, probes } = run;
    const state = backend.connectionState().state;
    const epoch = backend.databaseEpoch();
    const before = probes.length;
    for (let waited = 0; probes.length === before && waited < 120_000; waited += 100) await vi.advanceTimersByTimeAsync(100);
    expect(probes.length).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(WATCH_FAST_MS - 1);
    expect(probes.length).toBe(before + 1);
    expect(backend.connectionState().state).toBe(state);
    expect(backend.databaseEpoch()).toBe(epoch);
    expect(backend.servesData()).toBe(false);
    chooser.stop();
  }

  it('a schema version mismatch: no second probe before WATCH_FAST_MS and the state stays', async () => {
    const run = await refusedWatch({
      reply: sql => VERSION.test(sql) ? { rows: [{ value: JSON.stringify({ v: SCHEMA_VERSION + 1 }) }], rowCount: 1 } : undefined,
    }, null);
    expect(run.verdict.state).toBe('mismatch');
    await expectWatchCadence(run);
  });

  it('an NB16 shape refusal: no second probe before WATCH_FAST_MS and the state stays', async () => {
    const run = await refusedWatch({ storeId: false }, 'store-7');
    expect(run.verdict.state).toBe('shape');
    await expectWatchCadence(run);
  });
});

describe('MB2 item 6: a hold or latch rising between two check statements before COMMIT', () => {
  function heldChooser() {
    const held: number[] = [];
    const chooser: DatabaseChooser = {
      chosen: () => A,
      awaitChoice: async () => A,
      lastPassLogin: () => 'unreachable',
      holdStarted: (_b, epoch) => { held.push(epoch); },
      confirmNow: () => undefined,
      stop: () => undefined,
    };
    return { chooser, held };
  }

  async function riseAtEncoding(rise: (backend: PostgresBackend) => void) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let backend!: PostgresBackend;
    let risen = false;
    const fake = withPool({
      reply: sql => {
        if (sql === 'SHOW server_encoding' && !risen) {
          risen = true;
          rise(backend);
        }
        return undefined;
      },
    });
    const { chooser, held } = heldChooser();
    backend = new PostgresBackend({ chooser });
    backends.push(backend);
    backend.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = fake.sent.find(s => s.sql === 'SHOW server_encoding')!;
    const onFirst = fake.onClient(first.client);
    expect(onFirst.at(-1)).toBe('SHOW server_encoding');
    expect(onFirst).not.toContain('ROLLBACK');
    expect(onFirst).not.toContain('COMMIT');
    expect(fake.releases).toEqual([{ client: first.client, destroy: true }]);
    return { backend, fake, held };
  }

  it('a hold: the next statement is not sent, no ROLLBACK, the client is destroyed, and the retry waits for the confirmation', async () => {
    const { backend, fake, held } = await riseAtEncoding(b => b.noteLapse());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.pool.connect).toHaveBeenCalledTimes(1);
    expect(held.at(-1)).toBe(backend.databaseEpoch());
    backend.confirmHold(backend.databaseEpoch());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.pool.connect).toHaveBeenCalledTimes(2);
    expect(fake.onClient(2)).toContain('COMMIT');
    expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
  });

  it('a latch: the next statement is not sent, no ROLLBACK, the client is destroyed, and nothing provisions while latched', async () => {
    const { backend, fake } = await riseAtEncoding(b => b.latch({ kind: 'tie', generation: 2 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.pool.connect).toHaveBeenCalledTimes(1);
    expect(fake.sent.some(s => s.sql === 'COMMIT')).toBe(false);
    expect(backend.servesData()).toBe(false);
  });
});
