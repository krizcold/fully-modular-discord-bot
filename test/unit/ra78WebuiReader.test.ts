import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WebuiDataReader,
  _resetWebuiChoice,
  _setWebuiChoiceDeps,
  CHOOSING_REFUSAL,
  chooseNow,
  connectWithin,
  noteWebuiChild,
  ownChoiceLast,
  resolveWebuiDatabase,
  setWebuiDataStoreUrl,
  unreachableReason,
  webuiFirstCheck,
} from '../../src/webui/utils/webuiDataReader';

type FakeClient = { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };

const pg = vi.hoisted(() => ({
  connect: (() => new Promise(() => {})) as () => Promise<unknown>,
  totalCount: 0,
  idleCount: 0,
}));

vi.mock('pg', async orig => {
  const real = await orig<any>();
  class Pool {
    constructor(_config: unknown) {}
    get totalCount() { return pg.totalCount; }
    get idleCount() { return pg.idleCount; }
    on() { return this; }
    connect() { return pg.connect(); }
    async query() { return { rows: [] }; }
    async end() {}
  }
  return { ...real, Pool, default: { ...(real.default ?? real), Pool } };
});

const URL = 'postgres://reader:pw@db.example:5432/smdb';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve));
};

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('took too long')), ms); });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function fakeClient(answer: (cfg: any) => Promise<unknown> = async () => ({ rows: [{ value: 1 }] })): FakeClient {
  return { query: vi.fn(answer), release: vi.fn() };
}

function useClient(client: FakeClient, delayMs = 0): void {
  pg.connect = () => (delayMs > 0
    ? new Promise(resolve => setTimeout(() => resolve(client), delayMs))
    : Promise.resolve(client));
}

beforeEach(() => {
  pg.connect = () => new Promise(() => {});
  pg.totalCount = 0;
  pg.idleCount = 0;
});

afterEach(() => {
  vi.useRealTimers();
  _setWebuiChoiceDeps(null);
  setWebuiDataStoreUrl(null);
});

describe('the own choice of the web UI', () => {
  function probeDeps() {
    const probes: Array<ReturnType<typeof deferred<any>>> = [];
    _setWebuiChoiceDeps({
      entries: () => [],
      probe: () => { const d = deferred<any>(); probes.push(d); return d.promise; },
      markerStoreId: () => null,
      noticeCheckOff: () => true,
    });
    return probes;
  }

  it('starts a new choice once the last one ended and its interval passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    setWebuiDataStoreUrl(null);
    const probes = probeDeps();
    resolveWebuiDatabase();
    expect(probes).toHaveLength(1);
    probes[0].reject(new Error('probe one failed'));
    await flush();
    expect(resolveWebuiDatabase()).toEqual({ refusal: 'probe one failed' });
    vi.setSystemTime(1_000_000 + 10_000);
    resolveWebuiDatabase();
    expect(probes).toHaveLength(2);
  });

  it('keeps a running choice when an older one from before a case change ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(2_000_000);
    setWebuiDataStoreUrl(null);
    const probes = probeDeps();
    resolveWebuiDatabase();
    setWebuiDataStoreUrl(null);
    resolveWebuiDatabase();
    expect(probes).toHaveLength(2);
    probes[0].reject(new Error('old probe failed'));
    await flush();
    vi.setSystemTime(2_000_000 + 10_000);
    resolveWebuiDatabase();
    expect(probes).toHaveLength(2);
    probes[1].reject(new Error('new probe failed'));
    await flush();
  });

  it('drops a chooseNow answer that ends after a change of case', async () => {
    setWebuiDataStoreUrl(null);
    _resetWebuiChoice();
    const probes = probeDeps();
    const run = chooseNow();
    noteWebuiChild('gone');
    probes[0].reject(new Error('answer from before the change'));
    const { resolution } = await run;
    expect(resolution).toEqual({ refusal: 'answer from before the change' });
    expect(ownChoiceLast()).toEqual({ refusal: CHOOSING_REFUSAL });
  });
});

describe('a held report with no reason', () => {
  it('resolves to the entry with an empty held reason', () => {
    setWebuiDataStoreUrl({ url: URL, held: true });
    expect(resolveWebuiDatabase()).toEqual({ entry: URL, tag: null, held: { reason: '' } });
  });

  it('refuses the first write check with an empty reason', () => {
    setWebuiDataStoreUrl({ url: URL, held: true });
    expect(webuiFirstCheck()).toEqual({ refusal: '', held: true });
  });
});

describe('unreachableReason', () => {
  it('gives the refusal carried in the reader error', () => {
    expect(unreachableReason(new Error('data backend unreachable (the bot process is starting)'))).toBe('the bot process is starting');
  });

  it('gives null for another error', () => {
    expect(unreachableReason(new Error('x data backend unreachable ('))).toBeNull();
  });
});

describe('connectWithin', () => {
  it('names a slow database, not a busy pool, when a connection is idle', async () => {
    const pool = { connect: () => new Promise(() => {}), totalCount: 2, idleCount: 1 } as any;
    await expect(connectWithin(pool, 10, 'the pool', 2)).rejects.toThrow('the database did not take a connection within 0 s');
  });

  it('gives back a connection handed out after the bound', async () => {
    const client = fakeClient();
    const late = deferred<FakeClient>();
    const pool = { connect: () => late.promise, totalCount: 0, idleCount: 0 } as any;
    await expect(connectWithin(pool, 10, 'the pool', 2)).rejects.toThrow('within 0 s');
    late.resolve(client);
    await flush();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('leaves no timer behind once a connection is handed out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const client = fakeClient();
    const pool = { connect: () => Promise.resolve(client), totalCount: 0, idleCount: 0 } as any;
    expect(await connectWithin(pool, 1000, 'the pool', 2)).toBe(client);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the reader bounded query (holderOf)', () => {
  beforeEach(() => setWebuiDataStoreUrl({ url: URL }));

  it('bounds the hand-out by a bound under five seconds', async () => {
    await expect(within(new WebuiDataReader().holderOf('1', 30), 1000)).rejects.toThrow('the database did not take a connection within 0 s');
  });

  it('bounds the statement by the bound left', async () => {
    const client = fakeClient();
    useClient(client);
    expect(await new WebuiDataReader().holderOf('1', 30)).toEqual({ rows: [{ value: 1 }], url: URL });
    expect(client.query.mock.calls[0][0].query_timeout).toBeLessThanOrEqual(30);
    expect(client.release.mock.calls).toEqual([[undefined]]);
  });

  it('takes the hand-out time off the statement bound', async () => {
    const client = fakeClient();
    useClient(client, 40);
    await new WebuiDataReader().holderOf('1', 1000);
    const left = client.query.mock.calls[0][0].query_timeout;
    expect(left).toBeLessThan(1000);
    expect(left).toBeGreaterThan(500);
  });

  it('keeps the client of a statement that failed with a SQLSTATE', async () => {
    const failure = Object.assign(new Error('relation missing'), { code: '42P01' });
    const client = fakeClient(async () => { throw failure; });
    useClient(client);
    await expect(new WebuiDataReader().holderOf('1', 1000)).rejects.toBe(failure);
    expect(client.release.mock.calls).toEqual([[undefined]]);
  });

  it('destroys the client of a statement that failed without a SQLSTATE', async () => {
    const failure = new Error('Query read timeout');
    const client = fakeClient(async () => { throw failure; });
    useClient(client);
    await expect(new WebuiDataReader().holderOf('1', 1000)).rejects.toBe(failure);
    expect(client.release.mock.calls).toEqual([[true]]);
  });

  it('destroys the client and passes on a failure that is no object', async () => {
    const client = fakeClient(() => Promise.reject(undefined));
    useClient(client);
    let caught: unknown = 'nothing thrown';
    try {
      await new WebuiDataReader().holderOf('1', 1000);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeUndefined();
    expect(client.release.mock.calls).toEqual([[true]]);
  });
});

describe('the reader shared select', () => {
  beforeEach(() => setWebuiDataStoreUrl({ url: URL }));

  it('bounds the hand-out by a bound under five seconds', async () => {
    await expect(within(new WebuiDataReader().sharedSelect('SELECT 1', [], 30), 1000)).rejects.toThrow('the database did not take a connection within 0 s');
  });

  it('names the reader pool when every connection is in use', async () => {
    pg.totalCount = 2;
    pg.idleCount = 0;
    await expect(new WebuiDataReader().sharedSelect('SELECT 1', [], 10)).rejects.toThrow("every connection of the web UI's reader pool was in use for 0 s");
  });

  it('gives the statement the bound left and keeps the client', async () => {
    const client = fakeClient();
    useClient(client);
    expect(await new WebuiDataReader().sharedSelect('SELECT 1', [], 1000)).toEqual({ rows: [{ value: 1 }] });
    expect(client.query.mock.calls[0][0].query_timeout).toBeGreaterThan(900);
    expect(client.release.mock.calls).toEqual([[undefined]]);
  });

  it('takes the hand-out time off the statement bound', async () => {
    const client = fakeClient();
    useClient(client, 40);
    await new WebuiDataReader().sharedSelect('SELECT 1', [], 1000);
    const left = client.query.mock.calls[0][0].query_timeout;
    expect(left).toBeLessThan(1000);
    expect(left).toBeGreaterThan(500);
  });
});
