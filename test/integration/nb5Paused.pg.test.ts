import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Hop } from '../helpers/pgMigrationRig';
import { copyStore, entryOf, liveDocs, provision, setGeneration, sleep, startBot, waitFor, type BotRun } from '../helpers/nb5Pg';
import { startPostgres } from '../helpers/postgres';

// NB5 section 8 [pg] test 8 (NB5-RUN-2): a flush held at its fence on A, then A stops answering with its packets
// dropped (NB3's Hop stalled in front of A, which drops every byte both ways as `docker pause` does for the client),
// and the step to W: the flush is cut at once, useDatabase(W) completes, G lands on W, and the old pool's end does not
// wait for TCP keepalive.

const STORE = 'store-nb5';
const G = '880000000000000601';
const P = { nodeId: 'node-a', claim: 40, processId: 'p-a', shardId: 0, shardCount: 1 };
let a: StartedPostgreSqlContainer;
let w: StartedPostgreSqlContainer;
let directA: Pool;
let directW: Pool;
let hop: Hop;
let entryHop: string;
let entryW: string;
let bot: BotRun | null = null;

beforeAll(async () => {
  [a, w] = await Promise.all([startPostgres(), startPostgres()]);
  directA = new Pool({ connectionString: entryOf(a), max: 4 });
  directW = new Pool({ connectionString: entryOf(w), max: 4 });
  hop = new Hop({ host: a.getHost(), port: a.getPort() });
  const port = await hop.listen();
  entryHop = entryOf(a, { host: '127.0.0.1' }).replace(`:${a.getPort()}/`, `:${port}/`);
  entryW = entryOf(w);
  await provision(entryOf(a), directA, STORE);
  await provision(entryW, directW, STORE);
  await setGeneration(directA, 'node-a', 1);
  await directA.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
    VALUES (1, 0, 40, 'p-a', 'node-a', 'node-a', 'node-a', 30000, 30000)`);
}, 240_000);
afterAll(async () => {
  await bot?.stop();
  await hop?.close();
  await directA?.end();
  await directW?.end();
  await Promise.all([a?.stop(), w?.stop()]);
});

describe('a paused main', () => {
  it('the held flush is cut at the latch, the move completes, G lands on W, the old pool ends without waiting', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bot = await startBot([entryHop], STORE);
    expect(await bot.ws.hydrate(G, P)).toBe('ready');
    bot.ws.save(G, 'm', 'a.json', '"one"');
    await bot.ws.flushAllDirty();
    await copyStore(directA, directW);
    await setGeneration(directW, 'node-w', 2);

    const locker: PoolClient = await directA.connect();
    await locker.query('BEGIN');
    await locker.query('SELECT 1 FROM smdb_data.guild_ownership WHERE guild_id = $1 FOR UPDATE', [G]);
    bot.ws.save(G, 'm', 'a.json', '"two"');
    const flushing = bot.ws.flushAllDirty();
    await sleep(500);
    hop.stall();
    bot.list = [entryHop, entryW];

    await waitFor(() => bot!.backend.latchReason() !== null, 60_000);
    const latchedAt = Date.now();
    await flushing;
    expect(Date.now() - latchedAt).toBeLessThan(2_000);
    await waitFor(() => bot!.moved.length === 1, 60_000);
    expect(Date.now() - latchedAt).toBeLessThan(30_000);
    expect(bot.moved).toEqual([entryW]);
    await waitFor(async () => {
      await bot!.ws.flushAllDirty().catch(() => undefined);
      return (await liveDocs(directW, G))['a.json'] === '"two"';
    }, 60_000);
    await locker.query('ROLLBACK').catch(() => undefined);
    locker.release(true);
    hop.restore();
  }, 240_000);
});
