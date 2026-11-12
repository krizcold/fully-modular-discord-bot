import os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  pools: [] as any[],
  endError: null as Error | null,
  hold: null as Promise<void> | null,
  holdText: '',
  serving: false,
}));

vi.mock('pg', async importOriginal => {
  const real = await importOriginal<typeof import('pg')>();
  const { EventEmitter: Emitter } = await import('events');
  class FakeClient extends Emitter {
    sent: Array<{ text: string; values: any[] }> = [];
    connection = { stream: { remoteAddress: '172.18.0.9' } };
    async query(config: any) {
      this.sent.push({ text: config.text, values: config.values });
      if (fake.hold && config.text === fake.holdText) await fake.hold;
      return { rows: [], rowCount: 0 };
    }
    release() { /* back to the pool */ }
  }
  class FakePool extends Emitter {
    clients: FakeClient[] = [];
    constructor(public options: any) {
      super();
      fake.pools.push(this);
    }
    async connect() {
      const client = new FakeClient();
      this.clients.push(client);
      this.emit('connect', client);
      return client;
    }
    async end() {
      if (fake.endError) throw fake.endError;
    }
  }
  return { ...real, Pool: FakePool, default: { ...(real as any).default, Pool: FakePool } };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataBackends/boot')>();
  return {
    ...real,
    getDataBootStatus: () => ({ ...real.getDataBootStatus(), state: fake.serving ? 'serving' : 'starting' }),
  };
});

import {
  _resetGuildRequestPool,
  _sweepDbForTests,
  guildRequestsStopStep,
  requestGuildRequestPass,
  startGuildRequestSweep,
} from '../../src/bot/internalSetup/fleet/guildRequests';
import { CLEANUP_BODIES_SQL, CLEANUP_SQL, REQUEST_CLAIM_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';

const iface = (cidr: string, internal = false) => ({ address: cidr.split('/')[0], netmask: '', family: 'IPv4', mac: '', internal, cidr }) as any;
const ATTACHED = { lo: [iface('127.0.0.1/8', true)], eth0: [iface('172.18.0.5/16')] };
const ENTRY = 'postgres://u:pw@smdb-pg/x?sslmode=no-verify';
const NEXT_ENTRY = 'postgres://u:pw@smdb-pg2/x?sslmode=no-verify';
const NOT_READ = "[GuildRequests] Changes sent from other machines' panels are not read: the bot process has not chosen its database yet";

let changed: Array<(next: string) => void>;

const sweepPools = () => fake.pools.filter(p => p.options.application_name === 'smdb-guild-requests');
const sent = () => sweepPools().flatMap(p => p.clients.flatMap((c: any) => c.sent as Array<{ text: string; values: any[] }>));
const sentTexts = () => sent().map(s => s.text);
const flush = () => new Promise(resolve => setImmediate(resolve));

async function until(check: () => boolean, boundMs = 1000): Promise<void> {
  const end = Date.now() + boundMs;
  while (!check()) {
    if (Date.now() > end) throw new Error('the condition did not hold in time');
    await flush();
  }
}

function useBackend(entry: string | null): void {
  setGuildDataBackend(Object.assign(Object.create(PostgresBackend.prototype), {
    chosenEntry: () => entry,
    onDatabaseChanged: (listener: (next: string) => void) => { changed.push(listener); },
    databaseEpoch: () => 1,
    refusalDetail: () => null,
  }));
}

const LEASE = {
  processId: 'p-a',
  shardCount: 2,
  leases: [{ shardId: 0, claim: 3 }, { shardId: 1, claim: null }],
} as any;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  fake.pools.length = 0;
  fake.endError = null;
  fake.hold = null;
  fake.serving = false;
  changed = [];
  _resetGuildRequestPool();
  vi.spyOn(os, 'networkInterfaces').mockReturnValue(ATTACHED as any);
});

afterEach(() => {
  _resetGuildRequestPool();
  vi.useRealTimers();
  setGuildDataBackend(null);
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('startGuildRequestSweep', () => {
  it('a bot on files starts no sweep and logs nothing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setBackendKind('file');
    setGuildDataBackend(null);
    startGuildRequestSweep(() => LEASE);
    requestGuildRequestPass();
    await flush();
    expect(log).not.toHaveBeenCalled();
    expect(sweepPools()).toHaveLength(0);
  });

  it('a Postgres bot with no chosen database logs that changes from other machines are not read', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setBackendKind('postgres');
    useBackend(null);
    startGuildRequestSweep(() => LEASE);
    expect(log.mock.calls).toEqual([[NOT_READ]]);
    expect(sweepPools()).toHaveLength(0);
  });

  it('a pass asked for at once claims only the shards whose claim is known', async () => {
    setBackendKind('postgres');
    useBackend(ENTRY);
    startGuildRequestSweep(() => LEASE);
    requestGuildRequestPass();
    await until(() => sentTexts().includes(REQUEST_CLAIM_SQL));
    const claim = sent().find(s => s.text === REQUEST_CLAIM_SQL)!;
    expect(claim.values.slice(0, 5)).toEqual(['p-a', claim.values[1], [2], [0], [3]]);
  });

  it('the stop step waits for the claim on the wire', async () => {
    let open!: () => void;
    fake.hold = new Promise<void>(resolve => { open = resolve; });
    fake.holdText = REQUEST_CLAIM_SQL;
    setBackendKind('postgres');
    useBackend(ENTRY);
    startGuildRequestSweep(() => LEASE);
    requestGuildRequestPass();
    await until(() => sentTexts().includes(REQUEST_CLAIM_SQL));
    let done = false;
    const stop = guildRequestsStopStep().then(() => { done = true; });
    await flush();
    await flush();
    expect(done).toBe(false);
    open();
    await stop;
    expect(done).toBe(true);
  });

  it('the cleanup runs only while the data layer serves', async () => {
    setBackendKind('postgres');
    useBackend(ENTRY);
    startGuildRequestSweep(() => null);
    vi.advanceTimersByTime(1000);
    await flush();
    await flush();
    expect(sentTexts()).not.toContain(CLEANUP_BODIES_SQL);
    fake.serving = true;
    vi.advanceTimersByTime(1000);
    await until(() => sentTexts().includes(CLEANUP_SQL));
    expect(sentTexts()).toEqual([CLEANUP_BODIES_SQL, CLEANUP_SQL]);
  });
});

describe("the sweep's pool", () => {
  it('a statement before the database is chosen fails as not sent', async () => {
    setBackendKind('postgres');
    useBackend(null);
    const failure = await _sweepDbForTests().query(CLEANUP_SQL, [], 5000).then(() => null, error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('the bot process has not chosen its database yet');
    expect(failure.notSent).toBe(true);
  });

  it("a move logs when the old pool's end fails", async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setBackendKind('postgres');
    useBackend(ENTRY);
    await _sweepDbForTests().query(CLEANUP_SQL, [], 5000);
    expect(changed).toHaveLength(1);
    fake.endError = new Error('end failed');
    changed[0](NEXT_ENTRY);
    await until(() => log.mock.calls.length > 0);
    expect(log.mock.calls).toEqual([['[GuildRequests] The pool of the database this process left did not end cleanly:', 'end failed']]);
    expect(sweepPools()).toHaveLength(2);
  });
});
