import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pools = vi.hoisted(() => [] as any[]);

vi.mock('pg', async orig => {
  const real = await orig<any>();
  class Pool {
    handlers = new Map<string, Array<(arg: any) => void>>();
    connects = 0;
    hung: Array<() => void> = [];
    constructor(public options: any) { pools.push(this); }
    on(event: string, fn: (arg: any) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
      return this;
    }
    emit(event: string, arg: any) { for (const fn of this.handlers.get(event) ?? []) fn(arg); }
    async connect() {
      this.connects += 1;
      const pool = this;
      return {
        query: () => new Promise(resolve => pool.hung.push(() => resolve({ rows: [], rowCount: 0 }))),
        release: () => undefined,
        on: () => undefined,
      };
    }
    async end() { return undefined; }
  }
  return { ...real, Pool, default: { ...(real.default ?? real), Pool } };
});

import { _resetGuildRequestPool, _sweepDbForTests, reservedSweepDb, type SweepDb } from '../../src/bot/internalSetup/fleet/guildRequests';
import { ANSWER_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';

let errors: string[];
let warns: string[];

const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

function useFakeBackend(): void {
  setGuildDataBackend(Object.assign(Object.create(PostgresBackend.prototype), {
    chosenEntry: () => 'postgres://bot@db2.example:5432/bot',
    onDatabaseChanged: () => undefined,
    databaseEpoch: () => 1,
    refusalDetail: () => null,
  }));
}

beforeEach(() => {
  errors = [];
  warns = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const pool of pools) for (const go of pool.hung.splice(0)) go();
  _resetGuildRequestPool();
  setGuildDataBackend(null);
  pools.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the sweep's own pool", () => {
  it('logs an idle connection error and a client error with their sources', async () => {
    useFakeBackend();
    const first = _sweepDbForTests().query(ANSWER_SQL, [], 2000);
    await flush();
    expect(pools).toHaveLength(1);
    pools[0].emit('error', new Error('idle client gone'));
    expect(errors).toEqual(['[GuildRequests] Idle connection error: idle client gone']);
    const clientHandlers: Array<(error: Error) => void> = [];
    pools[0].emit('connect', { on: (event: string, fn: (error: Error) => void) => { if (event === 'error') clientHandlers.push(fn); } });
    for (const fn of clientHandlers) fn(new Error('connection reset'));
    expect(warns).toContain('[Postgres] Connection error on the guild-requests sweep pool: connection reset');
    for (const go of pools[0].hung.splice(0)) go();
    await first;
  });

  it('runs at most two answers or read-backs at once, so a pass statement always finds a free connection', async () => {
    useFakeBackend();
    const db = _sweepDbForTests();
    const runs = [db.query(ANSWER_SQL, [], 2000), db.query(ANSWER_SQL, [], 2000), db.query(ANSWER_SQL, [], 2000)];
    await flush();
    expect(pools[0].connects).toBe(2);
    for (const go of pools[0].hung.splice(0)) go();
    await flush();
    expect(pools[0].connects).toBe(3);
    for (const go of pools[0].hung.splice(0)) go();
    await Promise.all(runs);
  });
});

describe('reservedSweepDb', () => {
  it('a statement that gave up waiting leaves its place free for the next one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const reached: number[] = [];
    let finishFirst: (() => void) | null = null;
    let n = 0;
    const inner: SweepDb = {
      query: () => {
        const id = ++n;
        reached.push(id);
        if (id === 1) return new Promise(resolve => { finishFirst = () => resolve({ rows: [] }); });
        return Promise.resolve({ rows: [{ id }] });
      },
    };
    const db = reservedSweepDb(inner, 1, 100);
    const first = db.query(ANSWER_SQL, [], 2000);
    const second = db.query(ANSWER_SQL, [], 2000).catch(error => error);
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    const gaveUp = await second;
    expect(gaveUp).toBeInstanceOf(Error);
    expect(gaveUp.notSent).toBe(true);
    finishFirst!();
    await first;
    const third = db.query(ANSWER_SQL, [], 2000);
    await flush();
    expect(reached).toEqual([1, 2]);
    await expect(third).resolves.toEqual({ rows: [{ id: 2 }] });
  });
});
