import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => ({
  pools: [] as any[],
  clients: [] as any[],
  changed: [] as Array<() => void>,
  unprotected: false,
  queryError: undefined as unknown,
  queryFails: false,
  entry: 'postgres://bot@localhost:5432/bot' as string | null,
  refusal: null as string | null,
  backend: 'postgres' as string,
}));

vi.mock('pg', async importOriginal => {
  const real = await importOriginal<typeof import('pg')>();
  class Pool {
    readonly options: any;
    handlers: Record<string, Array<(...a: any[]) => void>> = {};
    constructor(options: any) { this.options = options; pg.pools.push(this); }
    on(event: string, fn: (...a: any[]) => void) { (this.handlers[event] ??= []).push(fn); return this; }
    async connect() {
      const client: any = {
        queries: [] as any[],
        handlers: {} as Record<string, Array<(...a: any[]) => void>>,
        release: vi.fn(),
        on: (event: string, fn: (...a: any[]) => void) => { (client.handlers[event] ??= []).push(fn); return client; },
        query: (config: any) => {
          client.queries.push(config);
          if (pg.queryFails) return Promise.reject(pg.queryError);
          return Promise.resolve({ rows: [] });
        },
      };
      pg.clients.push(client);
      for (const fn of this.handlers.connect ?? []) fn(client);
      if (pg.unprotected) (await import('../../src/utils/databaseAddress')).keepTransportClass(client, 'unprotected');
      return client;
    }
    async end() { return undefined; }
  }
  return { ...real, Pool, default: { ...(real as any).default, Pool } };
});
vi.mock('../../src/bot/internalSetup/fleet/guildRequests', () => ({
  pgBackendOf: () => ({ chosenEntry: () => pg.entry, onDatabaseChanged: (fn: () => void) => { pg.changed.push(fn); } }),
  backendGate: { refusal: () => pg.refusal, epoch: () => null, stopWhy: () => null },
}));
vi.mock('../../src/utils/envLoader', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/utils/envLoader')>();
  return { ...real, resolveDataBackend: () => pg.backend };
});

import { _resetPanelLive, _setNotifyDb, isNotifying, noteLiveChange, notifyTick, registerInterest } from '../../src/bot/internalSetup/fleet/panelLive';

const G = '4194304';
const FAIL_TEXT = "Could not tell other machines' web panels";
const WORKS_TEXT = 'works again';
const CERT_TEXT = "this machine's database address does not check the database's certificate";
let errors: { mock: { calls: unknown[][] } };
let logs: { mock: { calls: unknown[][] } };
let warns: { mock: { calls: unknown[][] } };

const errorLines = () => errors.mock.calls.map(c => String(c[0]));
const failLines = () => errorLines().filter(l => l.includes(FAIL_TEXT));
const worksLines = () => logs.mock.calls.map(c => String(c[0])).filter(l => l.includes(WORKS_TEXT));

function scripted() {
  const calls: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const db = {
    notify: () => new Promise<void>((resolve, reject) => { calls.push({ resolve, reject }); }),
  };
  return { db, calls };
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await Promise.resolve();
  expect(cond()).toBe(true);
}

function watchAndChange(panel = 'p'): void {
  registerInterest(G, panel);
  noteLiveChange(G, panel, { v: 1 });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  _resetPanelLive();
  pg.pools.length = 0;
  pg.clients.length = 0;
  pg.changed.length = 0;
  pg.unprotected = false;
  pg.queryFails = false;
  pg.queryError = undefined;
  pg.entry = 'postgres://bot@localhost:5432/bot';
  pg.refusal = null;
  pg.backend = 'postgres';
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  _resetPanelLive();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('failure and recovery log lines', () => {
  it('a failure first seen after every watched pair expired logs no failure line, and the recovery logs no works-again line', async () => {
    const { db, calls } = scripted();
    _setNotifyDb(db, () => false);
    watchAndChange();
    const tick = notifyTick();
    await waitFor(() => calls.length === 1);
    vi.advanceTimersByTime(90_001);
    calls[0].reject(new Error('connection refused'));
    await tick;
    expect(isNotifying()).toBe(false);
    expect(failLines()).toEqual([]);

    watchAndChange();
    const second = notifyTick();
    await waitFor(() => calls.length === 2);
    calls[1].resolve();
    await second;
    expect(isNotifying()).toBe(true);
    expect(worksLines()).toEqual([]);
  });

  it('after a logged failure and a recovery, an unlogged failure and its recovery log no works-again line', async () => {
    const { db, calls } = scripted();
    _setNotifyDb(db, () => false);
    watchAndChange();
    let tick = notifyTick();
    await waitFor(() => calls.length === 1);
    calls[0].reject(new Error('connection refused'));
    await tick;
    expect(failLines()).toHaveLength(1);
    tick = notifyTick();
    await waitFor(() => calls.length === 2);
    calls[1].resolve();
    await tick;
    expect(worksLines()).toHaveLength(1);

    noteLiveChange(G, 'p', { v: 2 });
    tick = notifyTick();
    await waitFor(() => calls.length === 3);
    vi.advanceTimersByTime(90_001);
    calls[2].reject(new Error('connection refused'));
    await tick;
    expect(failLines()).toHaveLength(1);

    watchAndChange();
    tick = notifyTick();
    await waitFor(() => calls.length === 4);
    calls[3].resolve();
    await tick;
    expect(isNotifying()).toBe(true);
    expect(worksLines()).toHaveLength(1);
  });

  it('a second failure inside a minute of the logged one logs nothing, one a minute later logs again', async () => {
    const fails = { n: 0 };
    _setNotifyDb({ notify: async () => { fails.n += 1; throw new Error(`refused ${fails.n}`); } }, () => false);
    vi.advanceTimersByTime(100_000);
    watchAndChange();
    await notifyTick();
    expect(failLines()).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    await notifyTick();
    expect(failLines()).toHaveLength(1);
    vi.advanceTimersByTime(59_000);
    await notifyTick();
    expect(failLines()).toHaveLength(2);
    expect(failLines()[1]).toContain('refused 3');
  });
});

describe('the notify pool', () => {
  it('builds one pool and watches database moves once across many statements', async () => {
    watchAndChange();
    await notifyTick();
    noteLiveChange(G, 'p', { v: 2 });
    await notifyTick();
    noteLiveChange(G, 'p', { v: 3 });
    await notifyTick();
    expect(isNotifying()).toBe(true);
    expect(pg.clients).toHaveLength(3);
    expect(pg.pools).toHaveLength(1);
    expect(pg.changed).toHaveLength(1);
  });

  it("names the panel notify pool when one of its clients has a connection error", async () => {
    watchAndChange();
    await notifyTick();
    for (const fn of pg.clients[0].handlers.error ?? []) fn(new Error('socket hang up'));
    expect(warns).toHaveBeenCalledWith('[Postgres] Connection error on the panel notify pool:', 'socket hang up');
  });

  it('logs that the database is not chosen yet when the backend has no entry', async () => {
    pg.entry = null;
    watchAndChange();
    await notifyTick();
    expect(isNotifying()).toBe(false);
    expect(pg.pools).toHaveLength(0);
    expect(failLines()).toHaveLength(1);
    expect(failLines()[0]).toContain('(the bot process has not chosen its database yet)');
  });

  it('an unprotected client logs the certificate cause', async () => {
    pg.unprotected = true;
    watchAndChange();
    await notifyTick();
    expect(failLines()).toHaveLength(1);
    expect(failLines()[0]).toContain(`(${CERT_TEXT})`);
  });

  it('after an unprotected client, no client is taken for a minute, and one is taken at the minute', async () => {
    pg.unprotected = true;
    watchAndChange();
    await notifyTick();
    expect(pg.clients).toHaveLength(1);
    pg.unprotected = false;
    vi.advanceTimersByTime(59_999);
    await notifyTick();
    expect(pg.clients).toHaveLength(1);
    expect(isNotifying()).toBe(false);
    vi.advanceTimersByTime(1);
    await notifyTick();
    expect(pg.clients).toHaveLength(2);
    expect(isNotifying()).toBe(true);
  });

  it('a refusal inside the minute after an unprotected client logs the certificate cause', async () => {
    pg.refusal = 'stopped';
    watchAndChange();
    await notifyTick();
    expect(failLines()).toHaveLength(1);
    pg.refusal = null;
    vi.advanceTimersByTime(30_000);
    pg.unprotected = true;
    await notifyTick();
    expect(pg.clients).toHaveLength(1);
    expect(failLines()).toHaveLength(1);
    pg.unprotected = false;
    vi.advanceTimersByTime(30_000);
    await notifyTick();
    expect(pg.clients).toHaveLength(1);
    expect(failLines()).toHaveLength(2);
    expect(failLines()[1]).toContain(`(${CERT_TEXT})`);
  });

  it('a Postgres error with a code keeps the client; an error value without one destroys it', async () => {
    pg.queryFails = true;
    pg.queryError = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    watchAndChange();
    await notifyTick();
    expect(pg.clients[0].release).toHaveBeenCalledTimes(1);
    expect(pg.clients[0].release).toHaveBeenCalledWith(undefined);
    expect(isNotifying()).toBe(false);

    pg.queryError = undefined;
    await notifyTick();
    expect(pg.clients[1].release).toHaveBeenCalledTimes(1);
    expect(pg.clients[1].release).toHaveBeenCalledWith(true);
    vi.advanceTimersByTime(60_000);
    await notifyTick();
    expect(failLines()[1]).toContain('(undefined)');
  });
});

describe('whether the notifier runs by itself', () => {
  it('runs on the Postgres backend and not on the file backend', async () => {
    let sent = 0;
    _setNotifyDb({ notify: async () => { sent += 1; } });
    watchAndChange();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toBe(1);

    _resetPanelLive();
    pg.backend = 'file';
    sent = 0;
    _setNotifyDb({ notify: async () => { sent += 1; } });
    watchAndChange();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent).toBe(0);
  });
});
