import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { decideMain } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { entryOf, probe, provision, setGeneration, sleep, startBot, waitFor } from '../helpers/nb5Pg';
import { POSTGRES_IMAGE } from '../helpers/postgres';

// NB5 section 8 [pg] test 3, and [pg] test 1's standby row: a primary and a streaming standby made by pg_basebackup -R
// in a second container on one docker network. The standby answers as a copy, a list of both chooses the primary, a
// promotion with no raised row ties (the watch steps after two passes), and a raise makes the promoted copy the main.

const STORE = 'store-nb5';
const C = '500000000000000001';
let network: StartedNetwork;
let primary: StartedPostgreSqlContainer;
let standby: StartedTestContainer;
let directP: Pool;
let directS: Pool;
let entryP: string;
let entryS: string;

beforeAll(async () => {
  network = await new Network().start();
  primary = await new PostgreSqlContainer(POSTGRES_IMAGE).withNetwork(network).withNetworkAliases('primary').start();
  await primary.exec(['sh', '-c', 'echo "host replication all all scram-sha-256" >> "$PGDATA/pg_hba.conf"']);
  directP = new Pool({ connectionString: entryOf(primary), max: 4 });
  await directP.query('SELECT pg_reload_conf()');
  entryP = entryOf(primary);
  await provision(entryP, directP, STORE);
  await setGeneration(directP, 'node-p', 1);
  const user = primary.getUsername();
  standby = await new GenericContainer(POSTGRES_IMAGE)
    .withNetwork(network)
    .withEnvironment({ PGPASSWORD: primary.getPassword(), POSTGRES_PASSWORD: primary.getPassword() })
    .withExposedPorts(5432)
    .withEntrypoint(['sh', '-c'])
    .withCommand([`until pg_basebackup -h primary -p 5432 -U ${user} -D "$PGDATA" -R -X stream; do sleep 1; done; exec docker-entrypoint.sh postgres`])
    .withWaitStrategy(Wait.forLogMessage(/ready to accept read[- ]only connections/))
    .withStartupTimeout(120_000)
    .start();
  const host = standby.getHost();
  const port = standby.getMappedPort(5432);
  entryS = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(primary.getPassword())}@${host}:${port}/${primary.getDatabase()}`;
  directS = new Pool({ connectionString: entryS, max: 4 });
}, 300_000);
afterAll(async () => {
  await directP?.end();
  await directS?.end();
  await standby?.stop();
  await primary?.stop();
  await network?.stop();
});

describe('a primary and its streaming standby', () => {
  it("the standby answers not writable, with the primary's generation row and its own started", async () => {
    const [p, s] = (await probe(entryP, entryS)) as any[];
    expect(s).toMatchObject({ kind: 'answered', inRecovery: true, generation: 1, machine: 'node-p', storeId: STORE });
    expect(s.started).not.toBe(p.started);
  });

  it('an owner_channel row upserted on the primary is read through the standby once replayed', async () => {
    await directP.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('owner_channel', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(C)]);
    await waitFor(async () => ((await probe(entryS))[0] as any).ownerChannel?.id === C, 30_000);
  });

  it('a list of [standby, primary] chooses the primary', async () => {
    const decision = decideMain(await probe(entryS, entryP), { kind: 'none' }, { markerStoreId: STORE, noticeCheckOff: false });
    expect(decision.outcome).toBe('chosen');
    if (decision.outcome === 'chosen') expect(decision.chosen.entry).toBe(entryP);
  });

  it('after pg_promote() with the row not raised: a pass ties, and the watch on the primary steps after two passes; a raise to 2 makes the copy the main', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bot = await startBot([entryP], STORE);
    try {
      await directS.query('SELECT pg_promote()');
      await waitFor(async () => ((await probe(entryS))[0] as any).inRecovery === false, 60_000);
      const tie = decideMain(await probe(entryP, entryS), { kind: 'none' }, { markerStoreId: STORE, noticeCheckOff: false });
      expect(tie.outcome).toBe('tie');
      bot.list = [entryP, entryS];
      await sleep(25_000);
      expect(bot.backend.latchReason()).toBeNull();
      await waitFor(() => bot.backend.latchReason() !== null, 60_000);
      expect(bot.backend.latchReason()).toContain("can't confirm that");
      await setGeneration(directS, 'node-s', 2);
      const raised = decideMain(await probe(entryP, entryS), { kind: 'none' }, { markerStoreId: STORE, noticeCheckOff: false });
      expect(raised.outcome).toBe('chosen');
      if (raised.outcome === 'chosen') {
        expect(raised.chosen.entry).toBe(entryS);
        expect(raised.logs.some(l => l.includes('so it is a replaced main'))).toBe(true);
      }
      // NB5F P4: the move's check of the promoted copy passes, and leaves no session and no scratch schema there.
      await waitFor(() => bot.moved.length === 1, 60_000);
      expect(bot.moved).toEqual([entryS]);
      bot.chooser.stop();
      await sleep(5_000);
      expect((await directS.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'smdb-move-check'`)).rows[0].n).toBe(0);
      expect((await directS.query(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'smdb\\_shape\\_%'`)).rows[0].n).toBe(0);
    } finally {
      await bot.stop();
      vi.restoreAllMocks();
    }
  }, 240_000);
});
