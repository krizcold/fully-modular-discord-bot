import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _setListenClientFactory, startSharedListener, stopSharedListener, type ListenerDeps } from '../../src/bot/internalSetup/utils/sharedListener';

const LOCAL = 'postgres://bot@localhost:5432/bot';
const CANT = "[Shared] Can't listen for changes from other machines";

type ConnectPlan = 'ok' | 'hang' | Error;

interface Held { text: string; resolve: () => void }

class Fake extends EventEmitter {
  readonly queries: string[] = [];
  readonly held: Held[] = [];
  hold: (text: string) => boolean = () => false;
  ends = 0;
  destroys = 0;
  endFails = false;
  readonly connection = { stream: { destroy: () => { this.destroys += 1; } } };

  constructor(private readonly plan: ConnectPlan) {
    super();
  }

  connect(): Promise<void> {
    if (this.plan === 'hang') return new Promise(() => undefined);
    return this.plan === 'ok' ? Promise.resolve() : Promise.reject(this.plan);
  }

  query(text: string): Promise<unknown> {
    this.queries.push(text);
    if (!this.hold(text)) return Promise.resolve({ rows: [] });
    return new Promise(resolve => {
      this.held.push({ text, resolve: () => resolve({ rows: [] }) });
    });
  }

  end(): Promise<void> {
    this.ends += 1;
    return this.endFails ? Promise.reject(new Error('end failed')) : Promise.resolve();
  }
}

let clients: Fake[];
let connectPlan: ConnectPlan[];
let holdPlan: ((text: string) => boolean)[];
let factoryThrows: number;
let lines: string[];
let connected: number;
let moved: (() => void) | null;

function deps(entry: () => string | null): ListenerDeps {
  return {
    entry,
    onDoc: () => undefined,
    onConnected: () => { connected += 1; },
    onGuildRequest: () => undefined,
    onDatabaseChanged: cb => { moved = cb; },
  };
}

const cantLines = () => lines.filter(l => l.startsWith(CANT));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
  lines = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  }
  clients = [];
  connectPlan = [];
  holdPlan = [];
  factoryThrows = 0;
  connected = 0;
  moved = null;
  _setListenClientFactory((() => {
    if (factoryThrows > 0) {
      factoryThrows -= 1;
      throw new Error('no client today');
    }
    const client = new Fake(connectPlan.shift() ?? 'ok');
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

describe('starting', () => {
  it('a second start opens no second connection', async () => {
    startSharedListener(deps(() => LOCAL));
    startSharedListener(deps(() => LOCAL));
    await vi.advanceTimersByTimeAsync(0);
    expect(clients).toHaveLength(1);
    expect(connected).toBe(1);
  });

  it('connects 5 s after the entry becomes known', async () => {
    let entry: string | null = null;
    startSharedListener(deps(() => entry));
    await vi.advanceTimersByTimeAsync(0);
    expect(clients).toHaveLength(0);
    entry = LOCAL;
    await vi.advanceTimersByTimeAsync(5000);
    expect(clients).toHaveLength(1);
    expect(connected).toBe(1);
  });

  it('logs a client that cannot be made and tries again in 5 s', async () => {
    factoryThrows = 1;
    startSharedListener(deps(() => LOCAL));
    await vi.advanceTimersByTimeAsync(0);
    expect(cantLines()).toHaveLength(1);
    expect(cantLines()[0]).toContain('no client today');
    await vi.advanceTimersByTimeAsync(5000);
    expect(clients).toHaveLength(1);
    expect(connected).toBe(1);
  });
});

describe('bounded waits', () => {
  it('leave only the check timer after a connect', async () => {
    startSharedListener(deps(() => LOCAL));
    await vi.advanceTimersByTimeAsync(0);
    expect(connected).toBe(1);
    expect(clients[0].queries).toEqual(['LISTEN smdb_shared', 'LISTEN smdb_guild_requests']);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('leave only the retry timer after a refused connect', async () => {
    connectPlan.push(new Error('refused'));
    startSharedListener(deps(() => LOCAL));
    await vi.advanceTimersByTimeAsync(0);
    expect(cantLines()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('client events', () => {
  it('an error is logged with its cause and the old client ended, then a new client connects', async () => {
    startSharedListener(deps(() => LOCAL));
    await vi.advanceTimersByTimeAsync(0);
    clients[0].emit('error', new Error('reset by peer'));
    expect(cantLines()).toHaveLength(1);
    expect(cantLines()[0]).toContain('(reset by peer)');
    expect(clients[0].ends).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(clients).toHaveLength(2);
    expect(connected).toBe(2);
  });

  it("an end is logged as 'the connection ended' and a new client connects", async () => {
    startSharedListener(deps(() => LOCAL));
    await vi.advanceTimersByTimeAsync(0);
    clients[0].emit('end');
    expect(cantLines()).toHaveLength(1);
    expect(cantLines()[0]).toContain('(the connection ended)');
    await vi.advanceTimersByTimeAsync(5000);
    expect(clients).toHaveLength(2);
    expect(connected).toBe(2);
  });

  it('a late end of a failed client leaves its successor alone', async () => {
    startSharedListener(deps(() => LOCAL));
    await vi.advanceTimersByTimeAsync(0);
    clients[0].emit('error', new Error('reset'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(clients).toHaveLength(2);
    clients[0].emit('end');
    expect(clients[1].ends).toBe(0);
    expect(cantLines()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(clients).toHaveLength(2);
    expect(connected).toBe(2);
  });

  it('a late error of the client before a database move leaves the new client alone', async () => {
    startSharedListener(deps(() => LOCAL));
    await vi.advanceTimersByTimeAsync(0);
    moved!();
    await vi.advanceTimersByTimeAsync(0);
    expect(clients).toHaveLength(2);
    expect(clients[0].ends).toBe(1);
    clients[0].emit('error', new Error('late'));
    expect(clients[1].ends).toBe(0);
    expect(cantLines()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(clients).toHaveLength(2);
  });

  it('logs the cause again when exactly 10 minutes have passed', async () => {
    connectPlan.push('ok', 'hang');
    startSharedListener(deps(() => LOCAL));
    await vi.advanceTimersByTimeAsync(0);
    const first = Date.now();
    clients[0].emit('error', new Error('one'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(clients).toHaveLength(2);
    vi.setSystemTime(first + 10 * 60 * 1000);
    clients[1].emit('error', new Error('two'));
    expect(cantLines()).toHaveLength(2);
    expect(cantLines()[1]).toContain('(two)');
  });
});

describe('a LISTEN that answers after a database move', () => {
  it('is followed by no further LISTEN on the old client', async () => {
    holdPlan.push(text => text === 'LISTEN smdb_shared');
    startSharedListener(deps(() => LOCAL));
    await vi.advanceTimersByTimeAsync(0);
    expect(clients[0].queries).toEqual(['LISTEN smdb_shared']);
    moved!();
    await vi.advanceTimersByTimeAsync(0);
    clients[0].held[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(clients[0].queries).toEqual(['LISTEN smdb_shared']);
    expect(connected).toBe(1);
  });
});

describe('stopping', () => {
  it('a clean end destroys nothing, also after 2 s', async () => {
    startSharedListener(deps(() => LOCAL));
    await vi.advanceTimersByTimeAsync(0);
    stopSharedListener();
    await vi.advanceTimersByTimeAsync(2500);
    expect(clients[0].ends).toBe(1);
    expect(clients[0].destroys).toBe(0);
  });

  it('a failed end destroys the socket at once and only once', async () => {
    startSharedListener(deps(() => LOCAL));
    await vi.advanceTimersByTimeAsync(0);
    clients[0].endFails = true;
    stopSharedListener();
    await vi.advanceTimersByTimeAsync(0);
    expect(clients[0].destroys).toBe(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(clients[0].destroys).toBe(1);
  });
});
