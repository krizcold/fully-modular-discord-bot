import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _setListenClientFactory, startSharedListener, stopSharedListener, type ListenerDeps } from '../../src/bot/internalSetup/utils/sharedListener';

const REMOTE = 'postgres://bot@db-a.example:5432/bot';
const LOCAL = 'postgres://bot@localhost:5432/bot';
const AGAIN = '[Shared] Listening for changes from other machines again';

interface Held { text: string; resolve: () => void; reject: (error: Error) => void }

class Fake extends EventEmitter {
  readonly queries: string[] = [];
  readonly held: Held[] = [];
  hold: (text: string) => boolean = () => false;
  readonly connection = { stream: { destroy: () => undefined } };

  constructor(private readonly connectError: Error | null) {
    super();
  }

  connect(): Promise<void> {
    return this.connectError ? Promise.reject(this.connectError) : Promise.resolve();
  }

  query(text: string): Promise<unknown> {
    this.queries.push(text);
    if (!this.hold(text)) return Promise.resolve({ rows: [] });
    return new Promise((resolve, reject) => {
      this.held.push({ text, resolve: () => resolve({ rows: [] }), reject });
    });
  }

  end(): Promise<void> {
    return Promise.resolve();
  }

  notify(channel: string, payload?: string): void {
    this.emit('notification', { channel, payload });
  }
}

let clients: Fake[];
let connectPlan: (Error | null)[];
let holdPlan: ((text: string) => boolean)[];
let lines: string[];
let calls: { docs: string[]; modules: string[]; connected: number };
let moved: (() => void) | null;

function deps(entry: string): ListenerDeps {
  return {
    entry: () => entry,
    onDoc: key => { calls.docs.push(key); },
    onModule: module => { calls.modules.push(module); },
    onConnected: () => { calls.connected += 1; },
    onGuildRequest: () => undefined,
    onDatabaseChanged: cb => { moved = cb; },
  };
}

const doc = (key: string) => JSON.stringify({ k: 'doc', key, by: 'p-other' });

beforeEach(() => {
  vi.useFakeTimers();
  lines = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  }
  clients = [];
  connectPlan = [];
  holdPlan = [];
  moved = null;
  calls = { docs: [], modules: [], connected: 0 };
  _setListenClientFactory((() => {
    const client = new Fake(connectPlan.shift() ?? null);
    client.hold = holdPlan.shift() ?? (() => false);
    clients.push(client);
    return client;
  }) as never);
});

afterEach(() => {
  stopSharedListener();
  _setListenClientFactory(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a client dropped while its LISTEN is waiting', () => {
  it('gets no further LISTEN once the waiting one answers', async () => {
    holdPlan.push(text => text === 'LISTEN smdb_shared');
    startSharedListener(deps(LOCAL));
    await vi.advanceTimersByTimeAsync(0);
    expect(clients[0].queries).toEqual(['LISTEN smdb_shared']);
    clients[0].emit('error', new Error('reset'));
    clients[0].held[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(clients[0].queries).toEqual(['LISTEN smdb_shared']);
    expect(calls.connected).toBe(0);
  });

  it('reports no connect when its last LISTEN answers late; the next client connects once', async () => {
    holdPlan.push(text => text.startsWith('LISTEN'));
    startSharedListener(deps(REMOTE));
    await vi.advanceTimersByTimeAsync(0);
    clients[0].emit('error', new Error('reset'));
    clients[0].held[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.connected).toBe(0);
    expect(lines).not.toContain(AGAIN);
    await vi.advanceTimersByTimeAsync(5000);
    expect(clients).toHaveLength(2);
    expect(calls.connected).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clients[0].queries).toEqual(['LISTEN smdb_shared']);
    expect(clients[1].queries).toEqual(['LISTEN smdb_shared', 'SELECT 1']);
  });
});

describe("the 'again' line", () => {
  it('shows once after a recovery, not at a later move to another database', async () => {
    connectPlan.push(new Error('refused'));
    startSharedListener(deps(REMOTE));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.connected).toBe(1);
    expect(lines.filter(l => l === AGAIN)).toHaveLength(1);
    moved!();
    await vi.advanceTimersByTimeAsync(0);
    expect(clients).toHaveLength(3);
    expect(calls.connected).toBe(2);
    expect(lines.filter(l => l === AGAIN)).toHaveLength(1);
  });
});

describe('a check answered after its client dropped', () => {
  it('leaves no timer behind once the listener stops', async () => {
    holdPlan.push(text => text === 'SELECT 1');
    startSharedListener(deps(REMOTE));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.connected).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clients[0].held.map(h => h.text)).toEqual(['SELECT 1']);
    clients[0].emit('error', new Error('reset'));
    clients[0].held[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.connected).toBe(2);
    stopSharedListener();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('notifications', () => {
  it('from a dropped client reach no handler; the new client is heard', async () => {
    startSharedListener(deps(REMOTE));
    await vi.advanceTimersByTimeAsync(0);
    clients[0].emit('error', new Error('reset'));
    clients[0].notify('smdb_shared', doc('stale'));
    expect(calls.docs).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    clients[1].notify('smdb_shared', doc('fresh'));
    expect(calls.docs).toEqual(['fresh']);
  });

  it('on another channel are ignored', async () => {
    startSharedListener(deps(REMOTE));
    await vi.advanceTimersByTimeAsync(0);
    clients[0].notify('smdb_other', doc('x'));
    expect(calls.docs).toEqual([]);
    clients[0].notify('smdb_shared', doc('y'));
    expect(calls.docs).toEqual(['y']);
  });

  it("with a 'null' payload are skipped without throwing", async () => {
    startSharedListener(deps(REMOTE));
    await vi.advanceTimersByTimeAsync(0);
    expect(() => clients[0].notify('smdb_shared', 'null')).not.toThrow();
    expect(calls).toEqual({ docs: [], modules: [], connected: 1 });
  });

  it('go to the handler their kind names, and an unknown kind to none', async () => {
    startSharedListener(deps(REMOTE));
    await vi.advanceTimersByTimeAsync(0);
    clients[0].notify('smdb_shared', JSON.stringify({ k: 'module', key: 'kx', module: 'm1', by: 'p-other' }));
    clients[0].notify('smdb_shared', JSON.stringify({ k: 'other', key: 'kx', module: 'm2', by: 'p-other' }));
    clients[0].notify('smdb_shared', JSON.stringify({ k: 'doc', key: 'k3', module: 'm3', by: 'p-other' }));
    expect(calls.docs).toEqual(['k3']);
    expect(calls.modules).toEqual(['m1']);
  });
});
