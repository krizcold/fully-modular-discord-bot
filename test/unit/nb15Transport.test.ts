import { afterEach, describe, expect, it, vi } from 'vitest';

// NB15 test 13 (decision 21, gatekeeper rulings 4 and 13): transportOf classes a connected client from its parsed
// config and its socket's peer, with no lookup; the callers refuse to carry a request on an 'unprotected' client.
import { classifyPoolClients, keepTransportClass, pgConfig, transportClassOf, transportOf } from '../../src/utils/databaseAddress';
import { GuildRequestSweep, UnprotectedTransportError, gatedSweepDb, type SweepDeps } from '../../src/bot/internalSetup/fleet/guildRequests';
import { ANSWER_SQL, CLEANUP_BODIES_SQL, CLEANUP_SQL, REQUEST_CLAIM_SQL, UNANSWERED_BATCHES_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { fakeBot, nb7Rig, requestPlan, resetNb7, writeOf, isInsert } from '../helpers/nb7Rig';
import { sendGuildChange, runGuildRequest, planGuildRequest } from '../../src/webui/utils/guildRequests';
import { EventEmitter } from 'events';
import dns from 'dns';
import os from 'os';
import pg from 'pg';
import { GUILD } from '../helpers/nb7Rig';

type Ifaces = Parameters<typeof transportOf>[2];
const iface = (cidr: string, internal = false) => ({ address: cidr.split('/')[0], netmask: '', family: cidr.includes(':') ? 'IPv6' : 'IPv4', mac: '', internal, cidr }) as any;
const ATTACHED: Ifaces = { lo: [iface('127.0.0.1/8', true)], eth0: [iface('172.18.0.5/16')], eth1: [iface('192.168.48.2/20')] };
const peer = (remoteAddress: string | undefined) => ({ connection: { stream: { remoteAddress } } });

afterEach(() => {
  resetNb7();
  vi.useRealTimers();
});

describe('transportOf', () => {
  it.each([
    ['verify-full with sslrootcert', { host: 'db.example', ssl: { rejectUnauthorized: true, ca: 'x' } }, undefined, 'verified'],
    ['sslmode=require as pg-connection-string parses it', pgConfig('postgres://u@db.example/x?sslmode=require'), '203.0.113.9', 'verified'],
    ['no sslmode to a dotted host', pgConfig('postgres://u@db.example/x'), '203.0.113.9', 'unprotected'],
    ['no sslmode to an IP', pgConfig('postgres://u@203.0.113.9/x'), '203.0.113.9', 'unprotected'],
    ['sslmode=disable to a remote host', pgConfig('postgres://u@db.example/x?sslmode=disable'), '203.0.113.9', 'unprotected'],
    ['no-verify, a peer in an attached 172.18.0.0/16', pgConfig('postgres://u@smdb-pg/x?sslmode=no-verify'), '172.18.0.9', 'local'],
    ['no-verify, a peer in an attached 192.168.48.0/20', pgConfig('postgres://u@smdb-pg/x?sslmode=no-verify'), '192.168.50.3', 'local'],
    ['no-verify, a 172.20.x LAN address on no attached subnet', pgConfig('postgres://u@smdb-pg/x?sslmode=no-verify'), '172.20.1.4', 'unprotected'],
    ['no-verify, a tailnet address', pgConfig('postgres://u@smdb-pg/x?sslmode=no-verify'), '100.64.0.1', 'unprotected'],
    ['no-verify, an IPv4-mapped IPv6 peer read as IPv4', pgConfig('postgres://u@smdb-pg/x?sslmode=no-verify'), '::ffff:172.18.0.9', 'local'],
    ['no-verify, no peer known', pgConfig('postgres://u@smdb-pg/x?sslmode=no-verify'), undefined, 'unprotected'],
    ['localhost without ssl', pgConfig('postgres://u@localhost/x'), '127.0.0.1', 'local'],
    ['127.0.0.1 without ssl', pgConfig('postgres://u@127.0.0.1/x'), '127.0.0.1', 'local'],
    ['a Unix socket path', { host: '/var/run/postgresql' }, undefined, 'local'],
  ] as const)('%s', (_what, config, remote, cls) => {
    expect(transportOf(config as any, peer(remote), ATTACHED)).toBe(cls);
  });

  it('runs no lookup: a pool classes each new client at its connect by its peer, and a later connect classes again', () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue(ATTACHED as any);
    const lookups = [
      vi.spyOn(dns, 'lookup'), vi.spyOn(dns, 'resolve'), vi.spyOn(dns, 'resolve4'), vi.spyOn(dns, 'resolve6'),
      vi.spyOn(dns.promises, 'lookup'), vi.spyOn(dns.promises, 'resolve'), vi.spyOn(dns.promises, 'resolve4'), vi.spyOn(dns.promises, 'resolve6'),
    ];
    try {
      const pool = new EventEmitter();
      classifyPoolClients(pool as any, pgConfig('postgres://u@smdb-pg.invalid/x?sslmode=no-verify'));
      const first = peer('100.64.0.1');
      pool.emit('connect', first);
      expect(transportClassOf(first)).toBe('unprotected');
      const second = peer('172.18.0.9');
      pool.emit('connect', second);
      expect(transportClassOf(second)).toBe('local');
      expect(transportOf(pgConfig('postgres://u@db.invalid/x'), peer('127.0.0.1'), ATTACHED)).toBe('unprotected');
      for (const spy of lookups) expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('the sender (decision 9 step 6): an unprotected insert client sends nothing', () => {
  it("an NB7 write answers insecure-transport with NB7's text, no statement sent", async () => {
    const rig = nb7Rig();
    rig.transport[rig.url] = 'unprotected';
    const plan = await requestPlan('write');
    const reply = await sendGuildChange(fakeBot().bot, plan, writeOf());
    expect(reply).toMatchObject({ ok: false, code: 'insecure-transport', error: "This machine's database address does not check the database's certificate, so changes to servers other machines run are off; nothing was saved. Set sslmode=verify-full with sslrootcert in DATA_BACKEND_URL." });
    expect(rig.statements.filter(isInsert)).toHaveLength(0);
  });

  it("an NB15 op answers 503 insecure-transport with decision 12's texts", async () => {
    const rig = nb7Rig();
    rig.transport[rig.url] = 'unprotected';
    const bot = { writerRoute: () => ({ ok: false, status: 503, code: 'bot-down', error: 'the bot process is not running' }), isRunning: () => false } as any;
    for (const audience of ['owner', 'member'] as const) {
      const plan = await planGuildRequest(bot, '4194304', 'panel:button', audience);
      const answer = await runGuildRequest(plan, { panelId: 'p', buttonId: 'b', userId: '123456789012345678', actor: { via: audience, userId: '123456789012345678' } }, async () => ({}));
      expect(answer.status).toBe(503);
      expect(answer.reply.code).toBe('insecure-transport');
      expect(answer.reply.error).toBe(audience === 'owner'
        ? "This machine's database address does not check the database's certificate, so requests to other machines are off; nothing was run. Set sslmode=verify-full with sslrootcert in DATA_BACKEND_URL."
        : 'This server runs on another machine, and this web panel cannot send requests there safely; nothing was run.');
    }
    expect(rig.statements.filter(isInsert)).toHaveLength(0);
  });
});

describe('T13: the pool classes with the real interfaces and no lookup', () => {
  afterEach(() => { vi.restoreAllMocks(); delete process.env.PGHOST; });

  it('T13: a pool classes by the interfaces os.networkInterfaces() gives: a tailnet peer is unprotected, an attached one local', () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue(ATTACHED as any);
    const pool = new EventEmitter();
    classifyPoolClients(pool as any, pgConfig('postgres://u@smdb-pg/x?sslmode=no-verify'));
    const tailnet = peer('100.64.0.1');
    pool.emit('connect', tailnet);
    expect(transportClassOf(tailnet)).toBe('unprotected');
    const attached = peer('172.18.0.9');
    pool.emit('connect', attached);
    expect(transportClassOf(attached)).toBe('local');
  });

  it("T13: a node-postgres pool's connect that fails leaves its client with no class; a client that connects is classed", async () => {
    const made: object[] = [];
    class Recording extends pg.Client {
      constructor(config: pg.ClientConfig) {
        super(config);
        made.push(this);
      }
    }
    const pool = new pg.Pool({ host: '127.0.0.1', port: 1, user: 'u', database: 'x', connectionTimeoutMillis: 3000, Client: Recording as any });
    pool.on('error', () => undefined);
    classifyPoolClients(pool, pgConfig('postgres://u@127.0.0.1:1/x'));
    try {
      await expect(pool.connect()).rejects.toThrow();
      expect(made).toHaveLength(1);
      expect(transportClassOf(made[0])).toBeUndefined();
      const back = peer('127.0.0.1');
      pool.emit('connect', back as any);
      expect(transportClassOf(back)).toBe('local');
    } finally {
      await pool.end();
    }
  }, 15_000);

  it("T13: a host name that does not resolve fails the pool's connect within its bound, and its client is never classed", async () => {
    const made: object[] = [];
    class Recording extends pg.Client {
      constructor(config: pg.ClientConfig) {
        super(config);
        made.push(this);
      }
    }
    const pool = new pg.Pool({ host: 'smdb-pg.invalid', port: 5432, user: 'u', database: 'x', connectionTimeoutMillis: 3000, Client: Recording as any });
    pool.on('error', () => undefined);
    let connected = 0;
    pool.on('connect', () => { connected += 1; });
    classifyPoolClients(pool, pgConfig('postgres://u@smdb-pg.invalid:5432/x?sslmode=no-verify'));
    const began = Date.now();
    try {
      const error: any = await pool.connect().then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      // ENOTFOUND from a resolver that answered; EAI_AGAIN or the pool's own timeout when none answered.
      if (error.code !== undefined) expect(['ENOTFOUND', 'EAI_AGAIN']).toContain(error.code);
      else expect(error.message).toMatch(/timeout/);
      expect(Date.now() - began).toBeLessThanOrEqual(4000);
      expect(made).toHaveLength(1);
      expect(transportClassOf(made[0])).toBeUndefined();
      expect(connected).toBe(0);
    } finally {
      await pool.end();
    }
  }, 15_000);

  it("T13: through the sender, a restart gives a connection failure, then the request runs on a 'local' client, never insecure-transport", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const rig = nb7Rig();
    const down = { writerRoute: () => ({ ok: false, status: 503, code: 'bot-down', error: 'the bot process is not running' }), isRunning: () => false } as any;
    const OWNER = { via: 'owner', userId: 'web-ui-owner' };
    rig.connectFails[rig.url] = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const first = await runGuildRequest(await planGuildRequest(down, GUILD, 'panel:button', 'owner'), { panelId: 'p', buttonId: 'b', actor: OWNER }, async () => ({}));
    expect(first.reply.code).toBe('backend-unavailable');
    expect(first.reply.code).not.toBe('insecure-transport');
    rig.connectFails[rig.url] = undefined;
    rig.transport[rig.url] = 'local';
    rig.script[rig.url] = sql => (sql.startsWith('\nWITH r AS') ? { rows: [], rowCount: 1 } : sql.includes('WHERE id = $1') && !sql.includes('AND state') ? { rows: [{ state: 'done', reply: JSON.stringify({ success: true, data: {} }), pickup_over: true, answer_over: false }] } : undefined);
    let second: any;
    void runGuildRequest(await planGuildRequest(down, GUILD, 'panel:button', 'owner'), { panelId: 'p', buttonId: 'b', actor: OWNER }, async () => ({})).then(a => { second = a; });
    await vi.advanceTimersByTimeAsync(2000);
    expect(second?.reply).toMatchObject({ success: true, servedBy: 'BRAVO' });
  });

  it('T13 (NB15-L6): an empty host is classed by the host node-postgres uses: PGHOST, else the default socket', () => {
    process.env.PGHOST = 'db.example.net';
    expect(transportOf({ host: '' } as any, peer('203.0.113.9'), ATTACHED)).toBe('unprotected');
    expect(transportOf(pgConfig('postgres://u:pw@/smdb') as any, peer('203.0.113.9'), ATTACHED)).toBe('unprotected');
    delete process.env.PGHOST;
    expect(transportOf({ host: '' } as any, peer(undefined), ATTACHED)).toBe('local');
  });
});

describe('the holder (decision 8): a pass on an unprotected client sends no claim', () => {
  function unprotectedSweep() {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() };
    keepTransportClass(client, 'unprotected');
    const pool = { connect: async () => client };
    const gate = { epoch: () => 1, refusal: () => null, stopWhy: () => null };
    const db = gatedSweepDb(pool, gate);
    return { client, db };
  }

  it('refuses a statement that carries a body or an answer, unsent, and sends the others', async () => {
    const { client, db } = unprotectedSweep();
    await expect(db.query(ANSWER_SQL, ['r', 'b', '{}'], 2000, undefined, true)).rejects.toBeInstanceOf(UnprotectedTransportError);
    await db.query(CLEANUP_SQL, [], 5000);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('logs at the first such pass and again 10 minutes later, not between; the unanswered statement and the cleanup still run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client, db } = unprotectedSweep();
    const deps: SweepDeps = {
      db, processId: () => 'p-a', pairs: () => [{ shardCount: 1, shardId: 0, claim: 1 }], stoppedServing: () => false,
      isStopping: () => false, apply: async () => ({ ok: true }), serving: () => true, gate: { epoch: () => 1, refusal: () => null, stopWhy: () => null },
    };
    const sweep = new GuildRequestSweep(deps);
    (sweep as any).unansweredBatches.set('b0', { at: performance.now(), epoch: 1 });
    await sweep.pass();
    await sweep.cleanupTick();
    const sent = () => client.query.mock.calls.map((c: any[]) => c[0].text);
    expect(sent()).not.toContain(REQUEST_CLAIM_SQL);
    expect(sent()).toEqual(expect.arrayContaining([UNANSWERED_BATCHES_SQL, CLEANUP_BODIES_SQL, CLEANUP_SQL]));
    const lines = () => errors.mock.calls.filter(c => String(c[0]).startsWith("[GuildRequests] This bot's database address does not check")).length;
    expect(lines()).toBe(1);
    vi.advanceTimersByTime(5 * 60 * 1000);
    await sweep.pass();
    expect(lines()).toBe(1);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await sweep.pass();
    expect(lines()).toBe(2);
    errors.mockRestore();
  });
});
