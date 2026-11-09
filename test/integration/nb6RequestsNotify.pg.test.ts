import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { REQUEST_INSERT_SQL, SETTLE_INSERT_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';

// NB6 decision 17, C19 and D13 on real Postgres: the request insert notifies 'smdb_guild_requests' with its
// for_process at COMMIT (row 75), a rolled-back insert notifies nobody (row 76), and the settle insert sends no
// notification (cell 442, a guard row).

const CHANNEL = 'smdb_guild_requests';
const SENTINEL = 'nb6-sentinel';
const GUILD = String(1n << 22n);

let rig: ClaimRig;
let listener: Client;
const heard: Array<{ channel: string; payload: string | undefined }> = [];

const valuesOf = (forProcess: string) => [randomUUID(), GUILD, 2, 1, forProcess, 'write', JSON.stringify({ module: 'm', filename: 'a.json', contentJson: '{}' }), 'ALPHA'];

/** Every notification delivered before a sentinel sent after the statements under test. */
async function heardBefore(): Promise<Array<{ channel: string; payload: string | undefined }>> {
  await rig.direct.query(`SELECT pg_notify($1, $2)`, [CHANNEL, SENTINEL]);
  const until = Date.now() + 10_000;
  while (!heard.some(n => n.payload === SENTINEL) && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 20); });
  const at = heard.findIndex(n => n.payload === SENTINEL);
  expect(at).toBeGreaterThanOrEqual(0);
  return heard.slice(0, at);
}

beforeAll(async () => {
  rig = await startClaimRig();
  listener = new Client({ connectionString: rig.url });
  listener.on('error', () => undefined);
  await listener.connect();
  listener.on('notification', msg => { heard.push({ channel: msg.channel, payload: msg.payload }); });
  await listener.query(`LISTEN ${CHANNEL}`);
}, 180_000);

afterAll(async () => {
  await listener?.end().catch(() => undefined);
  await rig?.stop();
});

beforeEach(async () => {
  heard.length = 0;
  await rig.direct.query(`DELETE FROM smdb_data.guild_requests`);
});

describe('the request insert announces itself', () => {
  it('row 75: a committed insert notifies its for_process once, at COMMIT', async () => {
    const client = await rig.direct.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(REQUEST_INSERT_SQL, [...valuesOf('p-bravo'), 5, 20]);
      expect(res.rows).toHaveLength(1);
      expect(await heardBefore()).toEqual([]);
      heard.length = 0;
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await heardBefore()).toEqual([{ channel: CHANNEL, payload: 'p-bravo' }]);
    expect((await rig.direct.query(`SELECT state, for_process FROM smdb_data.guild_requests`)).rows).toEqual([{ state: 'pending', for_process: 'p-bravo' }]);
  });

  it('row 75: an insert sent alone commits and notifies once', async () => {
    await rig.direct.query(REQUEST_INSERT_SQL, [...valuesOf('p-charlie'), 5, 20]);
    expect(await heardBefore()).toEqual([{ channel: CHANNEL, payload: 'p-charlie' }]);
  });

  it('row 76: a rolled-back insert notifies nobody and leaves no row', async () => {
    const client = await rig.direct.connect();
    try {
      await client.query('BEGIN');
      await client.query(REQUEST_INSERT_SQL, [...valuesOf('p-bravo'), 5, 20]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await heardBefore()).toEqual([]);
    expect((await rig.direct.query(`SELECT count(*)::int AS n FROM smdb_data.guild_requests`)).rows[0].n).toBe(0);
  });

  it('cell 442 (guard): the settle insert, of a new id and of a pending row, sends no notification', async () => {
    const fresh = valuesOf('p-bravo');
    expect((await rig.direct.query(SETTLE_INSERT_SQL, fresh)).rows).toEqual([{ state: 'expired', pickup_over: true }]);
    const pending = valuesOf('p-bravo');
    await rig.direct.query(REQUEST_INSERT_SQL, [...pending, 5, 20]);
    expect(await heardBefore()).toEqual([{ channel: CHANNEL, payload: 'p-bravo' }]);
    heard.length = 0;
    expect((await rig.direct.query(SETTLE_INSERT_SQL, pending)).rows).toEqual([{ state: 'expired', pickup_over: false }]);
    expect(await heardBefore()).toEqual([]);
  });
});
