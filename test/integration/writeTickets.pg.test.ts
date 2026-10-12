import net from 'net';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { setRouteOverride } from '../../src/bot/internalSetup/utils/dataBackends/routeResolver';
import { initWorkingSet, WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { confirmWrite, saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { poolFor, startPostgres } from '../helpers/postgres';

// BT-1 against a real store (notes/BT.md, "BT-1 design sheet", Tests first):
// the connection is cut while a write's flush is on the wire, and its ticket
// answers held; once the store is reachable again, the same ticket answers ok.

/** A TCP hop in front of the container that can drop the traffic of every connection, and cut them all. */
class Hop {
  private readonly sockets = new Set<net.Socket>();
  private stalled = false;
  private cut = false;
  private readonly server = net.createServer(client => this.accept(client));

  constructor(private readonly target: { host: string; port: number }) {}

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve((this.server.address() as net.AddressInfo).port));
    });
  }

  /** Bytes in both directions are dropped, so a query sent now never reaches the store. */
  stall(): void {
    this.stalled = true;
  }

  /** Every open connection is destroyed, and new ones are refused until restore. */
  cutAll(): void {
    this.cut = true;
    for (const socket of this.sockets) socket.destroy();
  }

  restore(): void {
    this.stalled = false;
    this.cut = false;
  }

  close(): Promise<void> {
    this.cutAll();
    return new Promise(resolve => { this.server.close(() => resolve()); });
  }

  private accept(client: net.Socket): void {
    if (this.cut) {
      client.destroy();
      return;
    }
    const upstream = net.connect(this.target.port, this.target.host);
    for (const [from, to] of [[client, upstream], [upstream, client]] as const) {
      this.sockets.add(from);
      from.on('data', chunk => { if (!this.stalled) to.write(chunk); });
      from.on('close', () => {
        this.sockets.delete(from);
        to.destroy();
      });
      from.on('error', () => { /* the close that follows ends the other side */ });
    }
  }
}

let container: StartedPostgreSqlContainer;
let direct: Pool;
let hop: Hop;
let backend: PostgresBackend;

beforeAll(async () => {
  container = await startPostgres();
  direct = poolFor(container);
  hop = new Hop({ host: container.getHost(), port: container.getPort() });
  const port = await hop.listen();
  const user = encodeURIComponent(container.getUsername());
  const password = encodeURIComponent(container.getPassword());
  backend = new PostgresBackend({ url: `postgres://${user}:${password}@127.0.0.1:${port}/${container.getDatabase()}` });
  backend.start();
  const until = Date.now() + 60_000;
  while (!backend.healthy() && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
  expect(backend.healthy()).toBe(true);
});

afterAll(async () => {
  await backend?.stop();
  await hop?.close();
  await direct?.end();
  await container?.stop();
});

async function stored(guildId: string, filename: string): Promise<string | null> {
  const res = await direct.query(
    'SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1 AND module = $2 AND filename = $3',
    [guildId, 'm', filename]);
  return res.rows[0]?.doc ?? null;
}

describe('a write ticket against a real Postgres', () => {
  it('answers held when the connection is cut mid-flush, and ok once the store is reachable again', async () => {
    const guildId = '424242';
    const token: FenceToken = { nodeId: 'node-a', term: 1, epoch: 1, shardId: 0, shardCount: 1 };
    const ws = new WorkingSetManager(backend);
    try {
      expect(await ws.hydrate(guildId, token)).toBe('ready');
      expect(ws.save(guildId, 'm', 'a.json', '{"a":1}')).toBe('accepted');
      const ticket = ws.ticketFor(guildId);

      hop.stall();
      const cutMidFlush = ws.confirm(ticket, 15_000);
      await new Promise(resolve => { setTimeout(resolve, 500); });
      hop.cutAll();
      expect(await cutMidFlush).toBe('held');
      expect(await stored(guildId, 'a.json')).toBeNull();

      hop.restore();
      expect(await ws.confirm(ticket, 15_000)).toBe('ok');
      expect(await stored(guildId, 'a.json')).toBe('{"a":1}');
    } finally {
      ws.quiesce();
    }
  }, 60_000);

  it('answers the operator route held when the connection is cut mid-flush, and a repeat delete held while it stays cut; confirmWrite answers ok once the store is reachable again', async () => {
    const guildId = '424243';
    const token: FenceToken = { nodeId: 'node-a', term: 1, epoch: 1, shardId: 0, shardCount: 1 };
    const held = {
      ok: true,
      pending: true,
      note: 'it is not saved yet; this node retries while it serves this guild, and loses it if the bot stops, the guild moves or the node loses its database first',
    };
    const options = { guildId, category: 'm' };
    setRouteOverride(guildId, 'postgres');
    const ws = initWorkingSet(backend);
    try {
      expect(await ws.hydrate(guildId, token)).toBe('ready');
      const kept = saveDataTracked('b.json', options, { b: 1 });
      if (kept.outcome !== 'saved') throw new Error(`the write was not accepted: ${kept.outcome}`);
      expect(await confirmWrite(kept.ticket, 15_000)).toBe('ok');
      expect(await stored(guildId, 'b.json')).toBe(JSON.stringify({ b: 1 }, null, 2));

      hop.stall();
      const cutMidFlush = applyOperatorDataWrite({ guildId, module: 'm', filename: 'a.json', op: 'write', contentJson: '{"a":1}' });
      await new Promise(resolve => { setTimeout(resolve, 500); });
      hop.cutAll();
      expect(await cutMidFlush).toEqual(held);
      expect(await stored(guildId, 'a.json')).toBeNull();

      const remove = { guildId, module: 'm', filename: 'b.json', op: 'delete' as const };
      expect(await applyOperatorDataWrite(remove)).toEqual(held);
      expect(await applyOperatorDataWrite(remove)).toEqual(held);
      expect(await stored(guildId, 'b.json')).toBe(JSON.stringify({ b: 1 }, null, 2));

      hop.restore();
      const saved = saveDataTracked('c.json', options, { c: 1 });
      if (saved.outcome !== 'saved') throw new Error(`the write was not accepted: ${saved.outcome}`);
      expect(await confirmWrite(saved.ticket, 15_000)).toBe('ok');
      expect(await stored(guildId, 'c.json')).toBe(JSON.stringify({ c: 1 }, null, 2));
      expect(await stored(guildId, 'a.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
      expect(await stored(guildId, 'b.json')).toBeNull();
    } finally {
      ws.quiesce();
    }
  }, 90_000);
});
