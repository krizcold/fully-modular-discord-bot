import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: any[]) => void;

const pgFake = vi.hoisted(() => ({
  handOut: null as null | ((pool: any) => Promise<any>),
}));

vi.mock('pg', async orig => {
  const real = await orig<any>();
  class Pool {
    totalCount = 0;
    idleCount = 0;
    private handlers: Record<string, Handler[]> = {};
    constructor(public options: any) {}
    on(event: string, fn: Handler) {
      (this.handlers[event] ??= []).push(fn);
      return this;
    }
    emit(event: string, ...args: any[]) {
      for (const fn of this.handlers[event] ?? []) fn(...args);
    }
    connect() {
      return pgFake.handOut!(this);
    }
    async end() { /* nothing to end */ }
  }
  return { ...real, Pool, default: { ...(real.default ?? real), Pool } };
});

import { SERVER_IDENTITY_SQL, _pgRequestDbForTests } from '../../src/webui/utils/guildRequests';

const LOCAL = 'postgresql://u:p@localhost:5432/d';

interface FakeClient {
  sent: any[];
  released: unknown[];
  emit(event: string, ...args: any[]): void;
}

function fakeClient(answer: (config: any) => Promise<any> = async () => ({ rows: [{ server: 'S1' }], rowCount: 1 })) {
  const handlers: Record<string, Handler[]> = {};
  const client: any = {
    connection: { stream: { remoteAddress: '127.0.0.1' } },
    sent: [] as any[],
    released: [] as unknown[],
    on(event: string, fn: Handler) {
      (handlers[event] ??= []).push(fn);
      return client;
    },
    emit(event: string, ...args: any[]) {
      for (const fn of handlers[event] ?? []) fn(...args);
    },
    query: async (config: any) => {
      client.sent.push(config);
      return answer(config);
    },
    release(destroy?: unknown) {
      client.released.push(destroy);
    },
  };
  return client as FakeClient;
}

/** Hands out the one client, firing the pool's connect event the first time only, as pg does for a new client. */
function handOutOnly(client: FakeClient): void {
  let fresh = true;
  pgFake.handOut = async pool => {
    if (fresh) {
      fresh = false;
      pool.emit('connect', client);
    }
    return client;
  };
}

beforeEach(() => { pgFake.handOut = null; });
afterEach(() => { vi.restoreAllMocks(); });

describe("the web UI's request pool", () => {
  it('a connection error on a client is logged with the pool named', async () => {
    const warns: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
    const client = fakeClient();
    handOutOnly(client);
    const db = _pgRequestDbForTests(LOCAL);
    const conn = await db.connect(4000);
    client.emit('error', new Error('connection reset'));
    expect(warns).toEqual(["[Postgres] Connection error on the web UI's request pool: connection reset"]);
    conn.release();
    await db.end();
  });

  it('a hand-out that waits on a full pool names the pool in its error', async () => {
    pgFake.handOut = pool => {
      pool.totalCount = 2;
      pool.idleCount = 0;
      return new Promise(() => undefined);
    };
    const db = _pgRequestDbForTests(LOCAL);
    await expect(db.connect(100)).rejects.toThrow("every connection of the web UI's request pool was in use for 0.1 s");
    await db.end();
  });

  it('reads the server identity once per client, and knows it on the next hand-out', async () => {
    const client = fakeClient();
    handOutOnly(client);
    const db = _pgRequestDbForTests(LOCAL);
    const first = await db.connect(4000);
    expect(first.transport).toBe('local');
    expect(first.server).toBe('S1');
    first.release();
    const second = await db.connect(4000);
    expect(second.server).toBe('S1');
    expect(client.sent.map(c => c.text)).toEqual([SERVER_IDENTITY_SQL]);
    second.release();
    await db.end();
  });

  it("the identity read at the connect gets the bound's time left", async () => {
    const client = fakeClient();
    handOutOnly(client);
    const db = _pgRequestDbForTests(LOCAL);
    vi.spyOn(performance, 'now').mockReturnValueOnce(50_000).mockReturnValueOnce(51_000);
    const conn = await db.connect(4000);
    vi.restoreAllMocks();
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0].text).toBe(SERVER_IDENTITY_SQL);
    expect(client.sent[0].query_timeout).toBe(3000);
    conn.release();
    await db.end();
  });

  it('an identity read that fails destroys the client and the connect fails with its error', async () => {
    const client = fakeClient(async () => { throw new Error('Query read timeout'); });
    handOutOnly(client);
    const db = _pgRequestDbForTests(LOCAL);
    await expect(db.connect(4000)).rejects.toThrow('Query read timeout');
    expect(client.released).toEqual([true]);
    await db.end();
  });

  it('a release gives the client back, and a release with destroy destroys it', async () => {
    const client = fakeClient();
    handOutOnly(client);
    const db = _pgRequestDbForTests(LOCAL);
    const kept = await db.connect(4000);
    kept.release();
    expect(client.released).toEqual([undefined]);
    const broken = await db.connect(4000);
    broken.release(true);
    expect(client.released).toEqual([undefined, true]);
    await db.end();
  });
});
