import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SERVER_IDENTITY_SQL } from '../../src/webui/utils/guildRequests';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';

// NB7 code review round 3 (NB7-R3-1) on real Postgres: every connection to one server instance reads the same
// identity, whatever address, socket, role or time zone it came through.

let rig: ClaimRig;

beforeAll(async () => {
  rig = await startClaimRig();
}, 180_000);

afterAll(async () => {
  await rig?.stop();
});

async function identityAs(url: string, setup: string[] = []): Promise<string> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const sql of setup) await client.query(sql);
    return String((await client.query(SERVER_IDENTITY_SQL)).rows[0].server);
  } finally {
    await client.end();
  }
}

async function identityInside(args: string[]): Promise<string> {
  const c = rig.container;
  const run = await c.exec(['psql', ...args, '-U', c.getUsername(), '-d', c.getDatabase(), '-v', 'ON_ERROR_STOP=1', '-At', '-c', SERVER_IDENTITY_SQL]);
  expect(run.exitCode, run.output).toBe(0);
  return run.output.trim();
}

describe('NB7-R3-1: the server identity belongs to the server instance', () => {
  it('the mapped port, 127.0.0.1 inside the container and the unix socket read one identity', async () => {
    const outside = await identityAs(rig.url);
    expect(outside).toMatch(/^\d+ started \d/);
    expect(await identityInside(['-h', '127.0.0.1'])).toBe(outside);
    expect(await identityInside([])).toBe(outside);
  }, 60_000);

  it('another time zone and a role without superuser read the same identity', async () => {
    const outside = await identityAs(rig.url);
    expect(await identityAs(rig.url, [`SET TIME ZONE 'Pacific/Kiritimati'`])).toBe(outside);
    await rig.direct.query(`DROP ROLE IF EXISTS nb7_plain`);
    await rig.direct.query(`CREATE ROLE nb7_plain LOGIN PASSWORD 'plain' NOSUPERUSER`);
    try {
      const plain = new URL(rig.url);
      plain.username = 'nb7_plain';
      plain.password = 'plain';
      expect(await identityAs(plain.toString())).toBe(outside);
    } finally {
      await rig.direct.query(`DROP ROLE IF EXISTS nb7_plain`);
    }
  }, 60_000);
});
