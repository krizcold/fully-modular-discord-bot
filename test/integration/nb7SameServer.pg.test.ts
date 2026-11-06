import net from 'net';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { provisionStoreInTransaction } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { _resetGuildRequests, _setGuildRequestDeps, NB7_TEXTS, planGuildChange, REQUESTS_APPLICATION_NAME, sendGuildChange } from '../../src/webui/utils/guildRequests';
import { setBackendKind } from '../helpers/backendKind';
import { heldRow } from '../helpers/nb7Rig';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import { startPostgres } from '../helpers/postgres';

// NB7 code review round 2 (NB7-R2-T3) on real Postgres: the sender's withdrawal counts as "nothing was saved" when its
// settle runs on a later connection to the server instance the insert reached, and counts as can't confirm when
// another server instance answers behind the same URL (a restart or a promoted standby).

const GUILD = String(1n << 22n);
const BOT_DOWN = { ok: false, status: 503, code: 'bot-down', error: 'the bot process is not running' };
const bot = { writerRoute: () => BOT_DOWN, writeGuildData: async () => BOT_DOWN, readGuildData: async () => BOT_DOWN } as any;
const pause = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms); });

/** One TCP address in front of a Postgres server; switching it drops every open connection, as a failover does. */
class Front {
  private readonly sockets = new Set<net.Socket>();
  private readonly server = net.createServer(client => this.accept(client));
  constructor(private target: { host: string; port: number }) {}

  listen(): Promise<number> {
    return new Promise(resolve => {
      this.server.listen(0, '127.0.0.1', () => resolve((this.server.address() as net.AddressInfo).port));
    });
  }

  switchTo(target: { host: string; port: number }): void {
    this.target = target;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise(resolve => { this.server.close(() => resolve()); });
  }

  private accept(client: net.Socket): void {
    const upstream = net.connect(this.target.port, this.target.host);
    for (const s of [client, upstream]) {
      this.sockets.add(s);
      s.on('error', () => undefined);
      s.on('close', () => {
        this.sockets.delete(s);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.pipe(client);
  }
}

let rig: ClaimRig;
let second: StartedPostgreSqlContainer | undefined;
let front: Front | undefined;

beforeAll(async () => {
  rig = await startClaimRig();
}, 180_000);

afterAll(async () => {
  _setGuildRequestDeps(null);
  _resetGuildRequests();
  await front?.close();
  await second?.stop();
  await rig?.stop();
});

beforeEach(async () => {
  setBackendKind('postgres');
  _resetGuildRequests();
  await rig.direct.query(`DELETE FROM smdb_data.guild_requests`);
});

function scriptDeps(url: string): void {
  _setGuildRequestDeps({
    holderOf: async () => ({ rows: [heldRow({ holder_process: 'p-nobody', node_process_id: 'p-nobody' })], url }),
    readDoc: async () => null,
    currentUrl: () => url,
    nodeId: () => 'n-a',
    nodeName: () => 'ALPHA',
  });
}

async function rowOn(query: (text: string, values: unknown[]) => Promise<{ rows: any[] }>, boundMs = 10_000): Promise<any> {
  const until = Date.now() + boundMs;
  for (;;) {
    const row = (await query(`SELECT id, state FROM smdb_data.guild_requests WHERE guild_id = $1`, [GUILD])).rows[0];
    if (row) return row;
    if (Date.now() > until) throw new Error(`no request row within ${boundMs} ms`);
    await pause(20);
  }
}

const requestPids = async () => (await rig.direct.query(`SELECT pid FROM pg_stat_activity WHERE application_name = $1`, [REQUESTS_APPLICATION_NAME])).rows.map(r => Number(r.pid));

describe('NB7-R2-T3: the settle proves a withdrawal by the server instance, not by the connection', () => {
  it('the insert\'s connection is gone and a new one settles the row on the same server: not taken, nothing was saved', async () => {
    scriptDeps(rig.url);
    const plan = await planGuildChange(bot, GUILD, 'write');
    expect(plan.kind).toBe('request');
    let done = false;
    const replyP = sendGuildChange(bot, plan, { guildId: GUILD, module: 'm', filename: 'a.json', op: 'write', contentJson: '{"a":1}' })
      .finally(() => { done = true; });
    const row = await rowOn((text, values) => rig.direct.query(text, values));
    expect(row.state).toBe('pending');
    const first = await requestPids();
    expect(first.length).toBeGreaterThan(0);
    await rig.direct.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1`, [REQUESTS_APPLICATION_NAME]);
    const later = new Set<number>();
    while (!done) {
      for (const pid of await requestPids()) if (!first.includes(pid)) later.add(pid);
      await pause(50);
    }
    const reply = await replyP;
    expect(later.size, 'the follow and the settle ran on a connection the insert did not use').toBeGreaterThan(0);
    expect(reply).toMatchObject({ ok: false, code: 'not-taken', servedBy: 'BRAVO', error: NB7_TEXTS.notTaken('BRAVO', 'saved') });
    const stored = (await rig.direct.query(`SELECT state, claim_batch, reply FROM smdb_data.guild_requests WHERE id = $1`, [row.id])).rows;
    expect(stored).toEqual([{ state: 'expired', claim_batch: null, reply: null }]);
  }, 60_000);

  it('another server instance answers behind the same URL with the row as shipped: the settle there proves nothing, can\'t confirm', async () => {
    second = await startPostgres();
    const b = new Client({ connectionString: second.getConnectionUri() });
    await b.connect();
    try {
      await b.query('BEGIN');
      await provisionStoreInTransaction(b);
      await b.query('COMMIT');
      const a = rig.container;
      front = new Front({ host: a.getHost(), port: a.getPort() });
      const port = await front.listen();
      expect([second.getUsername(), second.getPassword(), second.getDatabase()]).toEqual([a.getUsername(), a.getPassword(), a.getDatabase()]);
      const url = `postgres://${encodeURIComponent(a.getUsername())}:${encodeURIComponent(a.getPassword())}@127.0.0.1:${port}/${a.getDatabase()}`;
      scriptDeps(url);
      const plan = await planGuildChange(bot, GUILD, 'write');
      expect(plan.kind).toBe('request');
      const replyP = sendGuildChange(bot, plan, { guildId: GUILD, module: 'm', filename: 'a.json', op: 'write', contentJson: '{"a":1}' });
      const row = await rowOn((text, values) => rig.direct.query(text, values));
      const shipped = (await rig.direct.query(`SELECT row_to_json(r)::text AS j FROM smdb_data.guild_requests r WHERE id = $1`, [row.id])).rows[0].j;
      await b.query(`INSERT INTO smdb_data.guild_requests SELECT * FROM json_populate_record(NULL::smdb_data.guild_requests, $1::json)`, [shipped]);
      front.switchTo({ host: second.getHost(), port: second.getPort() });
      const reply = await replyP;
      expect(reply).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'unsettled', servedBy: 'BRAVO' });
      expect(String(reply.error ?? '')).not.toMatch(/nothing was/);
      expect((await b.query(`SELECT state FROM smdb_data.guild_requests WHERE id = $1`, [row.id])).rows).toEqual([{ state: 'expired' }]);
      expect((await rig.direct.query(`SELECT state FROM smdb_data.guild_requests WHERE id = $1`, [row.id])).rows).toEqual([{ state: 'pending' }]);
    } finally {
      await b.end();
    }
  }, 240_000);
});
