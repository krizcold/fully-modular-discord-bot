import { EventEmitter } from 'events';
import path from 'path';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import type { DatabaseChooser } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

const A = 'postgres://bot@db1:5432/bot';
const W = 'postgres://bot@db2:5432/bot';
const BAD = 'mysql://bot@db3:5432/bot';
const NOT_POSTGRES = "the address db3:5432/bot can't be used (it does not start with postgresql:// or postgres://)";
const MISSING_CA = path.resolve(__dirname, '../fixtures/nb31-no-such-ca.crt').replace(/\\/g, '/');
const BAD_CERT = `postgresql://bot@10.0.0.5:5432/bot?sslmode=verify-full&sslrootcert=${MISSING_CA}`;
const CAUSE = { kind: 'replaced', machine: 'node-b', generation: 4 } as const;

const backends: PostgresBackend[] = [];
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  process.off('unhandledRejection', onUnhandled);
  for (const b of backends.splice(0)) await b.stop().catch(() => undefined);
  vi.restoreAllMocks();
});

function chooserOf(chosen: string | null, awaited: string | null = chosen): DatabaseChooser {
  return {
    chosen: () => chosen,
    awaitChoice: async () => awaited,
    lastPassLogin: () => 'unreachable',
    holdStarted() {},
    confirmNow() {},
    stop() {},
  };
}

function fakePool() {
  const emitter = new EventEmitter();
  const pool = {
    connect: vi.fn(async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {}, end: async () => undefined })),
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    end: vi.fn(async () => undefined),
    on: (event: string, fn: (...args: unknown[]) => void) => { emitter.on(event, fn); return pool; },
  };
  return pool;
}

const lines = (fn: typeof console.error) => vi.mocked(fn).mock.calls.map(c => c.map(String).join(' '));
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const internals = (b: PostgresBackend) => b as unknown as { pool: unknown; moving: number | null; makePool(config: unknown): unknown };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('NB31: a switch to an entry pgConfig refuses changes nothing', () => {
  it('(a) during a running move, a second move to a bad address is refused with its cause; the epoch, entry, pool and running attempt stay, and the move completes', async () => {
    const backend = new PostgresBackend({ chooser: chooserOf(A) });
    backends.push(backend);
    internals(backend).pool = fakePool();
    const target = fakePool();
    const built: unknown[] = [];
    internals(backend).makePool = config => { built.push(config); return target; };
    backend.latch(CAUSE);
    const claims = deferred<boolean>();
    const moved = vi.fn();
    const stepsA = { checkTarget: async () => null, claims: () => claims.promise, settleRetires: async () => true, moved };
    const moveA = backend.useDatabase(W, stepsA);
    await tick();
    const epochA = backend.databaseEpoch();
    expect(backend.isMoving()).toBe(true);
    expect(backend.chosenEntry()).toBe(W);

    const stepsB = { checkTarget: async () => null, claims: vi.fn(async () => true), settleRetires: vi.fn(async () => true), moved: vi.fn() };
    const changed: string[] = [];
    backend.onDatabaseChanged(entry => changed.push(entry));
    expect(await backend.useDatabase(BAD, stepsB)).toBe(false);
    expect(backend.databaseEpoch()).toBe(epochA);
    expect(backend.chosenEntry()).toBe(W);
    expect(backend.getPool()).toBe(target);
    expect(internals(backend).moving).toBe(epochA);
    expect(backend.isMoving()).toBe(true);
    expect(built).toHaveLength(1);
    expect(changed).toEqual([]);
    expect(stepsB.claims).not.toHaveBeenCalled();
    expect(target.end).not.toHaveBeenCalled();
    const line = "[Database] Not moving to db3:5432/bot: its address can't be used (it does not start with postgresql:// or postgres://); this process keeps its unsaved changes and stays stopped";
    expect(lines(console.error).filter(l => l === line)).toHaveLength(1);

    claims.resolve(true);
    expect(await moveA).toBe(true);
    expect(moved).toHaveBeenCalledWith(W);
    expect(backend.latchReason()).toBeNull();
    expect(backend.connectionState().state).toBe('ready');
    expect(unhandled).toEqual([]);
  });

  it('(b) at boot with a bad address the backend refuses with the address cause, raises no epoch and leaves no unhandled rejection', async () => {
    const backend = new PostgresBackend({ chooser: chooserOf(null, BAD) });
    backends.push(backend);
    backend.start();
    await tick();
    expect(unhandled).toEqual([]);
    expect(backend.databaseEpoch()).toBe(0);
    expect(backend.chosenEntry()).toBeNull();
    expect(() => backend.getPool()).toThrow(NOT_POSTGRES);
    await expect(backend.sweepGraveyard(1000)).rejects.toThrow(NOT_POSTGRES);
    expect(backend.connectionState().state).toBe('connecting');
    expect(backend.latchReason()).toBeNull();
    expect(backend.servesData()).toBe(false);
    expect(lines(console.warn).some(l => l === `[PostgresBackend] Bootstrap attempt 1 failed (retrying): ${NOT_POSTGRES}`)).toBe(true);
    expect([...lines(console.warn), ...lines(console.error)].some(l => l.includes('stopped writing'))).toBe(false);
  });

  it('(c) the constructor with a bad chosen entry does not throw, builds no pool, raises no epoch and refuses with the certificate cause', async () => {
    let backend: PostgresBackend | undefined;
    expect(() => { backend = new PostgresBackend({ chooser: chooserOf(BAD_CERT) }); }).not.toThrow();
    backends.push(backend!);
    const cause = `the address 10.0.0.5:5432/bot can't be used (its certificate file ${MISSING_CA} cannot be read (ENOENT))`;
    expect(backend!.databaseEpoch()).toBe(0);
    expect(backend!.chosenEntry()).toBeNull();
    expect(() => backend!.getPool()).toThrow(cause);
    backend!.start();
    await tick();
    expect(unhandled).toEqual([]);
    expect(backend!.databaseEpoch()).toBe(0);
    await expect(backend!.sweepGraveyard(1000)).rejects.toThrow(cause);
    expect(lines(console.warn).some(l => l === `[PostgresBackend] Bootstrap attempt 1 failed (retrying): ${cause}`)).toBe(true);
  });

  it('(d) a good entry is used as before: the constructor and a move each raise the epoch once and build the pool for it', async () => {
    const backend = new PostgresBackend({ chooser: chooserOf(A) });
    backends.push(backend);
    expect(backend.databaseEpoch()).toBe(1);
    expect(backend.chosenEntry()).toBe(A);
    expect(backend.getPool()).toBeInstanceOf(Pool);
    internals(backend).pool = fakePool();
    const target = fakePool();
    internals(backend).makePool = () => target;
    backend.latch(CAUSE);
    const latchedEpoch = backend.databaseEpoch();
    const steps = { checkTarget: async () => null, claims: async () => true, settleRetires: async () => true, moved: vi.fn() };
    expect(await backend.useDatabase(W, steps)).toBe(true);
    expect(backend.databaseEpoch()).toBe(latchedEpoch + 1);
    expect(backend.chosenEntry()).toBe(W);
    expect(backend.getPool()).toBe(target);

    const booted = new PostgresBackend({ chooser: chooserOf(null, A) });
    backends.push(booted);
    expect(booted.databaseEpoch()).toBe(0);
    expect(() => booted.getPool()).toThrow('no database is chosen yet');
    const boot = booted as unknown as { bootstrapLoop(): Promise<void>; started: boolean };
    boot.started = true;
    const loop = vi.spyOn(booted as unknown as { poolQuery(): Promise<unknown> }, 'poolQuery').mockImplementation(() => new Promise(() => undefined));
    void boot.bootstrapLoop();
    await tick();
    expect(loop).toHaveBeenCalled();
    expect(booted.databaseEpoch()).toBe(1);
    expect(booted.chosenEntry()).toBe(A);
    expect(booted.getPool()).toBeInstanceOf(Pool);
    expect(unhandled).toEqual([]);
  });
});
