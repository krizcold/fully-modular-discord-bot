import os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB15 test 13 (decision 21, ruling 13) on the real pools over a scripted node-postgres: the sweep's pool the bot builds
// from its chosen entry, and the web UI's request pool, class each client at its connect. A statement that carries a
// body or an answer is refused, unsent, on a client whose peer is outside every attached subnet; the web UI's request
// pool sends no statement at all on such a client (not even the server identity) before the route answers
// insecure-transport. On a client inside an attached subnet both send.
const fake = vi.hoisted(() => ({ pools: [] as any[], remote: '100.64.0.1' }));

vi.mock('pg', async importOriginal => {
  const real = await importOriginal<typeof import('pg')>();
  const { EventEmitter: Emitter } = await import('events');
  class FakeClient extends Emitter {
    queries: string[] = [];
    connection: { stream: { remoteAddress: string } };
    constructor() {
      super();
      this.connection = { stream: { remoteAddress: fake.remote } };
    }
    async query(config: any) {
      this.queries.push(typeof config === 'string' ? config : config.text);
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
    async end() { /* nothing to close */ }
  }
  return { ...real, Pool: FakePool, default: { ...(real as any).default, Pool: FakePool } };
});

import { GuildRequestSweep, UnprotectedTransportError, _resetGuildRequestPool, _sweepDbForTests } from '../../src/bot/internalSetup/fleet/guildRequests';
import { ANSWER_SQL, CLEANUP_SQL, REQUEST_CLAIM_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { REQUEST_INSERT_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { SERVER_IDENTITY_SQL, _pgRequestDbForTests, _resetGuildRequests, _setGuildRequestDeps, planGuildRequest, runGuildRequest } from '../../src/webui/utils/guildRequests';
import { BOT_DOWN, heldRow } from '../helpers/nb7Rig';
import { setBackendKind } from '../helpers/backendKind';
import { setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';

const iface = (cidr: string, internal = false) => ({ address: cidr.split('/')[0], netmask: '', family: 'IPv4', mac: '', internal, cidr }) as any;
const ATTACHED = { lo: [iface('127.0.0.1/8', true)], eth0: [iface('172.18.0.5/16')] };
const ENTRY = 'postgres://u:pw@smdb-pg/x?sslmode=no-verify';

const sweepPool = () => fake.pools.find(p => p.options.application_name === 'smdb-guild-requests');
const sentOn = () => (sweepPool()?.clients ?? []).flatMap((c: any) => c.queries as string[]);

beforeEach(() => {
  fake.pools.length = 0;
  _resetGuildRequestPool();
  vi.spyOn(os, 'networkInterfaces').mockReturnValue(ATTACHED as any);
  setGuildDataBackend(Object.assign(Object.create(PostgresBackend.prototype), {
    chosenEntry: () => ENTRY,
    onDatabaseChanged: () => undefined,
    databaseEpoch: () => 1,
    refusalDetail: () => null,
  }));
});

afterEach(() => {
  _setGuildRequestDeps(null);
  _resetGuildRequests();
  _resetGuildRequestPool();
  setGuildDataBackend(null);
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe("the sweep's pool classes its clients (ruling 13)", () => {
  it("a peer outside every attached subnet: the claim and an answer are refused unsent; the cleanup is sent", async () => {
    fake.remote = '100.64.0.1';
    const db = _sweepDbForTests();
    await expect(db.query(REQUEST_CLAIM_SQL, [], 5000, 1, true)).rejects.toBeInstanceOf(UnprotectedTransportError);
    await expect(db.query(ANSWER_SQL, ['r', 'b', '{}'], 2000, 1, true)).rejects.toBeInstanceOf(UnprotectedTransportError);
    expect(sweepPool()).toBeDefined();
    expect(sweepPool().clients.length).toBeGreaterThan(0);
    expect(sentOn()).toEqual([]);
    await db.query(CLEANUP_SQL, [], 5000);
    expect(sentOn()).toEqual([CLEANUP_SQL]);
  });

  it('a peer inside an attached subnet: the claim is sent', async () => {
    fake.remote = '172.18.0.9';
    await _sweepDbForTests().query(REQUEST_CLAIM_SQL, [], 5000, 1, true);
    expect(sentOn()).toEqual([REQUEST_CLAIM_SQL]);
  });

  it("a sweep pass over the bot's own pool sends no claim to an unprotected peer", async () => {
    fake.remote = '100.64.0.1';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sweep = new GuildRequestSweep({
      db: _sweepDbForTests(), processId: () => 'p-a', pairs: () => [{ shardCount: 1, shardId: 0, claim: 1 }], stoppedServing: () => false,
      isStopping: () => false, apply: async () => ({ ok: true }), serving: () => true,
    });
    await sweep.pass();
    expect(sweepPool().clients.length).toBeGreaterThan(0);
    expect(sentOn()).not.toContain(REQUEST_CLAIM_SQL);
  });
});

describe("the web UI's request pool sends nothing on an unprotected client (decision 9 step 6)", () => {
  const requestPool = () => fake.pools.find(p => p.options.application_name === 'smdb-webui-requests');
  const sentOnRequests = () => (requestPool()?.clients ?? []).flatMap((c: any) => c.queries as string[]);

  async function route() {
    setBackendKind('postgres');
    _resetGuildRequests();
    _setGuildRequestDeps({
      holderOf: async () => ({ rows: [heldRow()] }),
      currentUrl: () => ENTRY,
      requestDb: (u: string) => _pgRequestDbForTests(u),
      nodeId: () => 'n-a',
      nodeName: () => 'ALPHA',
    });
    const plan = await planGuildRequest({ writerRoute: () => BOT_DOWN, isRunning: () => false } as any, String(1n << 22n), 'panel:button', 'owner');
    return runGuildRequest(plan, { panelId: 'p', buttonId: 'b', actor: { via: 'owner', userId: 'web-ui-owner' } }, async () => ({}));
  }

  it('a peer outside every attached subnet: the route answers 503 insecure-transport and the client was sent no statement', async () => {
    fake.remote = '100.64.0.1';
    const answer = await route();
    expect(answer).toMatchObject({ status: 503, reply: { code: 'insecure-transport' } });
    expect(requestPool()?.clients.length).toBeGreaterThan(0);
    expect(sentOnRequests()).toEqual([]);
  });

  it('a peer inside an attached subnet: the server identity, then the insert', async () => {
    fake.remote = '172.18.0.9';
    void route();
    for (let i = 0; i < 50 && !sentOnRequests().includes(REQUEST_INSERT_SQL); i++) await new Promise(r => setTimeout(r, 5));
    expect(sentOnRequests().slice(0, 2)).toEqual([SERVER_IDENTITY_SQL, REQUEST_INSERT_SQL]);
    _resetGuildRequests();
  });
});
