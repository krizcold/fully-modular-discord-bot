import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Hop } from '../helpers/hop';
import { freshDatabaseUrl, startPostgres } from '../helpers/postgres';
import { copyStore, provision, setGeneration } from '../helpers/nb5Pg';
import {
  BOT_ROLE, ackRows, block, botUrl, docOf, guildOn, holdShard, makeBotRole, running, sleep, startBotProcess, waitFor, writeOrder,
  type BotProcess,
} from '../helpers/nx5Pg';

// NX5 test 8 (sheets/NX5.md section 1, finding A, and section 4's invariant) as a regression on real Postgres: main M
// and copy C (copyStore stands in for streaming replication), processes A and B on M. B accepts a write for guild G
// one second before the order; the test runs the order (row, wait for the answers, block, end the sessions), copies M
// to C and raises C. Assert: G's document on C holds B's write. The characterization variant runs the same sequence
// without the order, with B's route to M held (helpers/hop.ts) from just after its write, and finds G's document on C
// without B's write: the rig reproduces the finding's held write. Fails today: B never answers, so the order variant
// times out on its wait.
//
// Not written here (reported in out/tests-notes.md): the sheet's later steps, B's address of C behind a relay held
// closed for 90 s, A's boot take of B's shards on C, and B's NB4 loss step with its drop line. They need the move
// machinery of NB5 (the chooser's retarget, moveClaims and onDeposed) driven across two module graphs, which a test
// writer cannot confirm without running it.

const MESSAGE = 'Moving the main database tonight.';
const COUNT = 2;
let container: StartedPostgreSqlContainer;
let admin: Pool;
let hop: Hop;
let hopPort: number;
const bots: BotProcess[] = [];
const pools: Pool[] = [];

beforeAll(async () => {
  container = await startPostgres();
  admin = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
  pools.push(admin);
  hop = new Hop({ host: container.getHost(), port: container.getPort() });
  hopPort = await hop.listen();
}, 180_000);
afterAll(async () => {
  for (const bot of bots) await bot.stop();
  await hop?.close();
  for (const pool of pools) await pool.end().catch(() => undefined);
  await container?.stop();
});
beforeEach(async () => {
  for (const bot of bots.splice(0)) await bot.stop();
  hop.restore();
});

async function database(prefix: string): Promise<{ pool: Pool; name: string }> {
  const url = await freshDatabaseUrl(container, prefix);
  const pool = new Pool({ connectionString: url, max: 4 });
  pools.push(pool);
  await provision(url, pool);
  await makeBotRole(pool);
  return { pool, name: new URL(url).pathname.slice(1) };
}

async function sequence(withOrder: boolean): Promise<unknown> {
  const M = await database('nx5m');
  const C = await database('nx5c');
  await setGeneration(M.pool, 'M', 1);
  await running(M.pool);
  const g = guildOn(1, COUNT);
  await holdShard(M.pool, 'p-A', 'A', 0, COUNT);
  await holdShard(M.pool, 'p-B', 'B', 1, COUNT);
  const a = await startBotProcess('A', botUrl(container.getHost(), container.getPort(), M.name), { shardId: 0, shardCount: COUNT, claim: 1 }, [guildOn(0, COUNT)]);
  bots.push(a);
  const b = await startBotProcess('B', botUrl('127.0.0.1', hopPort, M.name), { shardId: 1, shardCount: COUNT, claim: 1 }, [g]);
  bots.push(b);

  b.write(g, { from: 'B', note: 'accepted one second before the order' });
  if (!withOrder) hop.stall();
  await sleep(1_000);
  if (withOrder) {
    await writeOrder(M.pool, 'o-8', MESSAGE);
    await waitFor(async () => (await ackRows(M.pool, 'o-8')).filter(r => r.saved === true).length === 2, 21_000);
  }
  await block(admin, BOT_ROLE);
  await copyStore(M.pool, C.pool);
  await setGeneration(C.pool, 'C', 2);
  return docOf(C.pool, g);
}

describe('test 8: a planned move with a write in flight on a second process', () => {
  it('with the order, G\'s document on the new main holds B\'s write', async () => {
    expect(await sequence(true)).toEqual({ from: 'B', note: 'accepted one second before the order' });
  }, 240_000);

  it('characterization: without the order, B\'s held write is not on the new main', async () => {
    expect(await sequence(false)).toBeNull();
  }, 240_000);
});
