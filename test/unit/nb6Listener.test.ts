import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processId } from '../../src/bot/internalSetup/fleet/processId';
import { _setListenClientFactory, channelsFor, startSharedListener, stopSharedListener, type ListenerDeps } from '../../src/bot/internalSetup/utils/sharedListener';
import { listenRig, type FakeListenClient } from '../helpers/nb6Listen';

// NB6 test 7 (wip-redesign/sheets/NB6.md: decision 10 as 29 amends it, rows 36 to 41 and 100 and 101 as round 1
// changes them, cell 448, C26 and C27; part 8): the listening connection of sharedListener.ts over a fake client that
// emits 'notification', 'error' and 'end', with fake timers. NB6 builds the connect-failure halves of rows 36 and 37;
// the 'unprotected' halves are NB15's (C27). Row 100's pass is in test 6 (nb6Reconcile.test.ts).

// NB15 decision 21: these entries check the server's certificate ('verified'), so both channels are heard.
const ENTRY_A = 'postgres://bot@db-a.example:5432/bot?sslmode=require';
const ENTRY_B = 'postgres://bot@db-b.example:5432/bot?sslmode=require';
const UNCHECKED = 'postgres://bot@db-c.example:5432/bot?sslmode=no-verify';
const LOOPBACK = 'postgres://bot@127.0.0.1:5432/bot';
const CANT = "[Shared] Can't listen for changes from other machines";
const AGAIN = '[Shared] Listening for changes from other machines again';

let rig: ReturnType<typeof listenRig>;
let lines: string[];
let entry: string;
let calls: { docs: string[]; connected: number; guild: number };
let changed: Array<() => void>;

function deps(): ListenerDeps {
  return {
    entry: () => entry,
    onDoc: key => { calls.docs.push(key); },
    onConnected: () => { calls.connected += 1; },
    onGuildRequest: () => { calls.guild += 1; },
    onDatabaseChanged: cb => { changed.push(cb); },
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  lines = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  }
  rig = listenRig();
  entry = ENTRY_A;
  calls = { docs: [], connected: 0, guild: 0 };
  changed = [];
  _setListenClientFactory(rig.factory as never);
});

afterEach(() => {
  stopSharedListener();
  _setListenClientFactory(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function connected(): Promise<FakeListenClient> {
  startSharedListener(deps());
  await settle();
  const client = rig.last();
  expect(client.queries).toEqual(['LISTEN smdb_shared', 'LISTEN smdb_guild_requests']);
  return client;
}

describe('row 37 and cell 448: a connect', () => {
  it('connects with the entry, smdb-shared-listen, a 5 s connect and keepAlive, LISTENs both channels, then the pass runs', async () => {
    const client = await connected();
    expect(client.config).toMatchObject({ host: 'db-a.example', application_name: 'smdb-shared-listen', connectionTimeoutMillis: 5000, keepAlive: true, keepAliveInitialDelayMillis: 30000 });
    expect(channelsFor(client as never)).toEqual(['smdb_shared', 'smdb_guild_requests']);
    expect(calls.connected).toBe(1);
    expect(lines).toEqual([]);
  });

  it('after a failure, the connect logs that it listens again', async () => {
    rig.plan.push(new Error('connect ECONNREFUSED'));
    startSharedListener(deps());
    await settle();
    expect(calls.connected).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.clients).toHaveLength(2);
    expect(calls.connected).toBe(1);
    expect(lines.filter(l => l === AGAIN)).toHaveLength(1);
  });
});

describe('row 36: connect fails', () => {
  it('retries every 5 s and logs the cause once, then again only after 10 minutes', async () => {
    for (let i = 0; i < 200; i++) rig.plan.push(new Error('connect ECONNREFUSED'));
    startSharedListener(deps());
    await settle();
    const cant = () => lines.filter(l => l.startsWith(CANT));
    expect(cant()).toEqual([`${CANT} (connect ECONNREFUSED); this machine takes them at its check every 60 seconds until it can`]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000 * 10);
    expect(rig.clients).toHaveLength(12);
    expect(cant()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(cant()).toHaveLength(2);
    expect(rig.clients.every(c => c.destroyed || c.ended)).toBe(true);
  });

  it('a LISTEN that fails drops the client and retries', async () => {
    rig.plan.push('ok');
    startSharedListener(deps());
    const first = rig.clients[0] ?? null;
    expect(first).not.toBeNull();
    first!.answer = text => (text === 'LISTEN smdb_guild_requests' ? new Error('permission denied') : undefined);
    await settle();
    expect(first!.destroyed).toBe(true);
    expect(calls.connected).toBe(0);
    expect(lines.filter(l => l.startsWith(CANT))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.clients).toHaveLength(2);
    expect(calls.connected).toBe(1);
  });

  it('a connect with no answer is given up after 5 s', async () => {
    rig.plan.push('hang');
    startSharedListener(deps());
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.clients[0].destroyed).toBe(true);
    expect(lines.filter(l => l.startsWith(CANT))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.connected).toBe(1);
  });
});

describe('row 38: the 30 s check', () => {
  it('sends SELECT 1 every 30 s while the connection lives', async () => {
    const client = await connected();
    await vi.advanceTimersByTimeAsync(30_000 * 3);
    expect(client.queries.filter(q => q === 'SELECT 1')).toHaveLength(3);
    expect(client.destroyed).toBe(false);
  });

  it('a check that does not answer within 5 s destroys the client; the reconnect runs the pass again', async () => {
    const client = await connected();
    client.answer = text => (text === 'SELECT 1' ? 'hang' : undefined);
    await vi.advanceTimersByTimeAsync(30_000 + 5000);
    expect(client.destroyed).toBe(true);
    expect(lines.filter(l => l.startsWith(CANT))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.clients).toHaveLength(2);
    expect(calls.connected).toBe(2);
  });

  it('a check that fails destroys the client', async () => {
    const client = await connected();
    client.answer = text => (text === 'SELECT 1' ? new Error('Connection terminated unexpectedly') : undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.destroyed).toBe(true);
    expect(lines.filter(l => l.startsWith(CANT))).toEqual([`${CANT} (Connection terminated unexpectedly); this machine takes them at its check every 60 seconds until it can`]);
  });
});

describe('row 39: the server ends the session', () => {
  it('an error and an end are retried every 5 s, a 28000 at the reconnect included, with one log', async () => {
    const client = await connected();
    rig.plan.push(Object.assign(new Error('the database system is in maintenance'), { code: '28000' }), 'ok');
    client.emit('error', new Error('terminating connection due to administrator command'));
    client.emit('end');
    await settle();
    expect(lines.filter(l => l.startsWith(CANT))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.clients).toHaveLength(2);
    expect(calls.connected).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.clients).toHaveLength(3);
    expect(calls.connected).toBe(2);
    expect(lines.filter(l => l.startsWith(CANT))).toHaveLength(1);
    expect(lines.filter(l => l === AGAIN)).toHaveLength(1);
  });
});

describe('row 40: onDatabaseChanged', () => {
  it('closes the client and opens one on the new entry, which runs the pass', async () => {
    const client = await connected();
    expect(changed).toHaveLength(1);
    entry = ENTRY_B;
    changed[0]();
    await settle();
    expect(client.destroyed || client.ended).toBe(true);
    expect(rig.clients).toHaveLength(2);
    expect(rig.last().config).toMatchObject({ host: 'db-b.example' });
    expect(rig.last().queries).toEqual(['LISTEN smdb_shared', 'LISTEN smdb_guild_requests']);
    expect(calls.connected).toBe(2);
  });
});

describe('rows 26, 30, 41 and 101: notifications', () => {
  const doc = (key: string, by: string) => JSON.stringify({ k: 'doc', key, sha: 'a'.repeat(64), rev: 7, by });

  it('another process applies its key (row 101: whatever its pid); this process\'s own is skipped (row 30)', async () => {
    const client = await connected();
    client.notify('smdb_shared', doc('global/m/a.json', processId()));
    client.notify('smdb_shared', doc('global/m/b.json', '00000000-0000-4000-8000-000000000001'));
    const near = `${processId().slice(0, 35)}${processId().endsWith('0') ? '1' : '0'}`;
    client.notify('smdb_shared', doc('config.json', near));
    expect(calls.docs).toEqual(['global/m/b.json', 'config.json']);
  });

  it('row 41: a guild request for this process asks the sweep for a pass; one for another process does not', async () => {
    const client = await connected();
    client.notify('smdb_guild_requests', '00000000-0000-4000-8000-000000000002');
    expect(calls.guild).toBe(0);
    client.notify('smdb_guild_requests', processId());
    expect(calls.guild).toBe(1);
  });

  it('a payload that is not the notice skips', async () => {
    const client = await connected();
    client.notify('smdb_shared', 'not json');
    client.notify('smdb_shared', JSON.stringify({ k: 'doc' }));
    expect(calls.docs).toEqual([]);
  });
});

describe("rows 36, 37 and 100, the 'unprotected' halves (NB15 decision 21, gatekeeper rulings 4 and 20)", () => {
  it('a no-verify connection outside every attached subnet LISTENs smdb_shared only, hears shared changes and runs the pass', async () => {
    entry = UNCHECKED;
    startSharedListener(deps());
    await settle();
    const client = rig.last();
    expect(client.queries).toEqual(['LISTEN smdb_shared']);
    expect(channelsFor(client as never)).toEqual(['smdb_shared']);
    expect(calls.connected).toBe(1);
    client.notify('smdb_shared', JSON.stringify({ k: 'doc', key: 'g/1/m/a.json', by: 'another' }));
    expect(calls.docs).toEqual(['g/1/m/a.json']);
    client.notify('smdb_guild_requests', processId());
    expect(calls.guild).toBe(0);
    expect(lines.some(l => l.startsWith(CANT))).toBe(false);
    expect(lines).toEqual([]);
  });

  it('a loopback connection is local: both channels', async () => {
    entry = LOOPBACK;
    startSharedListener(deps());
    await settle();
    expect(rig.last().queries).toEqual(['LISTEN smdb_shared', 'LISTEN smdb_guild_requests']);
  });

  it('a reconnect classes the new connection again', async () => {
    entry = UNCHECKED;
    startSharedListener(deps());
    await settle();
    expect(rig.last().queries).toEqual(['LISTEN smdb_shared']);
    entry = ENTRY_B;
    changed.forEach(cb => cb());
    await settle();
    expect(rig.last().queries).toEqual(['LISTEN smdb_shared', 'LISTEN smdb_guild_requests']);
  });
});

describe('the stop (C25)', () => {
  it('ends the client, destroys it after 2 s, and opens no other', async () => {
    const client = await connected();
    client.end = () => new Promise(() => { client.ended = true; });
    stopSharedListener();
    expect(client.ended).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.destroyed).toBe(true);
    client.emit('end');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rig.clients).toHaveLength(1);
    client.notify('smdb_shared', JSON.stringify({ k: 'doc', key: 'global/m/c.json', sha: 'b'.repeat(64), rev: 8, by: 'x' }));
    expect(calls.docs).toEqual([]);
    expect(lines).toEqual([]);
  });
});
