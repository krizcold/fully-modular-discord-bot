import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB15 test 14, the holder's notify pool (decision 15, ruling 12): a notify statement on a socket that stops answering
// ends at the client's 3 s bound and destroys the client; no statement is sent while backendGate refuses; a failure
// sets notifying false and the next statement that works sets it true again.
const pg = vi.hoisted(() => ({
  pools: [] as any[],
  hang: false,
  unprotected: false,
  changed: [] as Array<() => void>,
  clients: [] as Array<{ release: ReturnType<typeof import('vitest').vi.fn>; queries: any[] }>,
}));
const gate = vi.hoisted(() => ({ refusal: null as string | null }));

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
        release: vi.fn(),
        on: () => client,
        query: (config: any) => {
          client.queries.push(config);
          if (!pg.hang) return Promise.resolve({ rows: [] });
          return new Promise((_, reject) => { setTimeout(() => reject(new Error('Query read timeout')), config.query_timeout); });
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
  pgBackendOf: () => ({ chosenEntry: () => 'postgres://bot@localhost:5432/bot', onDatabaseChanged: (fn: () => void) => { pg.changed.push(fn); } }),
  backendGate: { refusal: () => gate.refusal, epoch: () => null, stopWhy: () => null },
}));

import { NOTIFY_SQL, PANEL_NOTIFY_APPLICATION_NAME, _resetPanelLive, _setNotifyDb, isNotifying, liveAnswer, noteLiveChange, notifyTick, registerInterest } from '../../src/bot/internalSetup/fleet/panelLive';

const G = '4194304';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  _resetPanelLive();
  _setNotifyDb(null, () => false);
  pg.pools.length = 0;
  pg.clients.length = 0;
  pg.hang = false;
  pg.unprotected = false;
  gate.refusal = null;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  _resetPanelLive();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the notify pool', () => {
  it('sends one pg_notify statement with the payloads, on its own pool of one client', async () => {
    const since = registerInterest(G, 'p');
    noteLiveChange(G, 'p', { v: 1 });
    await notifyTick();
    expect(pg.pools).toHaveLength(1);
    expect(pg.pools[0].options).toMatchObject({ max: 1, application_name: PANEL_NOTIFY_APPLICATION_NAME, statement_timeout: 2000, keepAlive: true, keepAliveInitialDelayMillis: 30_000 });
    expect(pg.clients[0].queries).toEqual([{ text: NOTIFY_SQL, values: [[JSON.stringify({ g: G, p: 'p' })]], query_timeout: 3000 }]);
    expect(pg.clients[0].release).toHaveBeenCalledWith(undefined);
    expect(liveAnswer(G, 'p', since)).toMatchObject({ notifying: true, data: { v: 1 } });
  });

  it('a socket that stops answering: the statement ends at 3 s, the client is destroyed, notifying turns false and the pair stays marked', async () => {
    registerInterest(G, 'p');
    noteLiveChange(G, 'p', { v: 1 });
    pg.hang = true;
    let ended = false;
    void notifyTick().then(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(ended).toBe(true);
    expect(pg.clients[0].release).toHaveBeenCalledWith(true);
    expect(isNotifying()).toBe(false);
    pg.hang = false;
    await notifyTick();
    expect(pg.clients).toHaveLength(2);
    expect(pg.clients[1].queries[0].values).toEqual([[JSON.stringify({ g: G, p: 'p' })]]);
    expect(isNotifying()).toBe(true);
  });

  it("T13: closes an 'unprotected' client unused: no statement, released destroyed, notifying false", async () => {
    registerInterest(G, 'p');
    noteLiveChange(G, 'p', { v: 1 });
    pg.unprotected = true;
    await notifyTick();
    expect(pg.clients).toHaveLength(1);
    expect(pg.clients[0].queries).toEqual([]);
    expect(pg.clients[0].release).toHaveBeenCalledWith(true);
    expect(isNotifying()).toBe(false);
  });

  it('T13: a rebuild after onDatabaseChanged builds a new pool whose clients are classed at connect', async () => {
    const { transportClassOf } = await import('../../src/utils/databaseAddress');
    registerInterest(G, 'p');
    noteLiveChange(G, 'p', { v: 1 });
    await notifyTick();
    expect(pg.pools).toHaveLength(1);
    for (const fn of pg.changed) fn();
    noteLiveChange(G, 'p', { v: 2 });
    await notifyTick();
    expect(pg.pools).toHaveLength(2);
    expect(pg.pools[1].handlers.connect?.length ?? 0).toBeGreaterThan(0);
    const fresh: any = { connection: { stream: { remoteAddress: '203.0.113.9' } } };
    fresh.on = () => fresh;
    for (const fn of pg.pools[1].handlers.connect) fn(fresh);
    expect(transportClassOf(fresh)).toBe('local');
  });

  it('ruling 12: while backendGate refuses, no statement is sent and notifying is false', async () => {
    registerInterest(G, 'p');
    noteLiveChange(G, 'p', { v: 1 });
    gate.refusal = 'this process stopped writing to its database (the main changed)';
    await notifyTick();
    expect(pg.pools).toHaveLength(0);
    expect(pg.clients).toHaveLength(0);
    expect(isNotifying()).toBe(false);
    gate.refusal = null;
    await notifyTick();
    expect(pg.clients).toHaveLength(1);
    expect(isNotifying()).toBe(true);
  });
});
