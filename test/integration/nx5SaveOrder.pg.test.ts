import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { poolFor, startPostgres } from '../helpers/postgres';
import { provision } from '../helpers/nb5Pg';
import {
  BOT_ROLE, ackRows, block, botUrl, docOf, guildOn, holdShard, makeBotRole, startBotProcess, waitFor, writeOrder,
  type BotProcess,
} from '../helpers/nx5Pg';

// NX5 test 7 (sheets/NX5.md decisions 2, 8 and 9) on real Postgres: two bot processes on one database, each holding a
// dirty guild; the manager's order SQL (copied in helpers/nx5Pg.ts until NM33 lands); both answer true within R plus
// 20 s; one statement reads each answer row and its guild's document together and finds both, never the answer
// alone; then NOLOGIN and pg_terminate_backend; both processes show the maintenance message and saveHeldWrites
// answers zero counts. Fails today: no process answers.

const MESSAGE = 'Moving the main database tonight.';
const COUNT = 2;
let container: StartedPostgreSqlContainer;
let direct: Pool;
let url: string;
const bots: BotProcess[] = [];

beforeAll(async () => {
  container = await startPostgres();
  direct = poolFor(container);
  const admin = `postgres://${encodeURIComponent(container.getUsername())}:${encodeURIComponent(container.getPassword())}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
  await provision(admin, direct);
  await makeBotRole(direct);
  url = botUrl(container.getHost(), container.getPort(), container.getDatabase());
}, 180_000);
afterAll(async () => {
  for (const bot of bots) await bot.stop();
  await direct?.end();
  await container?.stop();
});

describe('test 7: two bot processes answer the save order', () => {
  it('both save their dirty guild and answer true, each answer row read with its guild\'s document in one statement; after the block both hold nothing', async () => {
    const guilds = { a: guildOn(0, COUNT), b: guildOn(1, COUNT) };
    await holdShard(direct, 'p-A', 'A', 0, COUNT);
    await holdShard(direct, 'p-B', 'B', 1, COUNT);
    const a = await startBotProcess('A', url, { shardId: 0, shardCount: COUNT, claim: 1 }, [guilds.a]);
    bots.push(a);
    const b = await startBotProcess('B', url, { shardId: 1, shardCount: COUNT, claim: 1 }, [guilds.b]);
    bots.push(b);
    a.write(guilds.a, { from: 'A', at: 1 });
    b.write(guilds.b, { from: 'B', at: 1 });

    const started = Date.now();
    await writeOrder(direct, 'o-7', MESSAGE);
    await waitFor(async () => (await ackRows(direct, 'o-7')).filter(r => r.saved === true).length === 2, 1_000 + 20_000);
    expect(Date.now() - started).toBeLessThan(21_000);
    expect((await ackRows(direct, 'o-7')).map(r => [r.process_id, r.saved])).toEqual([['p-A', true], ['p-B', true]]);

    for (const [processId, guildId, from] of [['p-A', guilds.a, 'A'], ['p-B', guilds.b, 'B']] as const) {
      const { rows } = await direct.query(
        `SELECT (SELECT saved FROM smdb_manager.save_acks WHERE process_id = $1 AND order_id = 'o-7') AS saved,
                (SELECT doc FROM smdb_data.guild_data WHERE guild_id = $2 AND module = 'nx5' AND filename = 'x.json') AS doc`,
        [processId, guildId],
      );
      expect(rows[0].saved).toBe(true);
      expect(rows[0].doc).not.toBeNull();
      expect(JSON.parse(rows[0].doc)).toEqual({ from, at: 1 });
    }

    await block(direct, BOT_ROLE);
    for (const bot of [a, b]) {
      expect(bot.gate.maintenanceCause()).toBe('order');
      expect(bot.gate.maintenanceText()).toBe(MESSAGE);
      expect(await bot.dm.saveHeldWrites(2_000)).toMatchObject({ unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 });
    }
    expect(await docOf(direct, guilds.a)).toEqual({ from: 'A', at: 1 });
    expect(await docOf(direct, guilds.b)).toEqual({ from: 'B', at: 1 });
  }, 180_000);
});
