import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';

// NB21 test 8.1, a characterization on postgres:16-alpine: what a role that is not a superuser sees of another
// role's backend in pg_stat_activity, and of its own when it runs under a default role.

let rig: PgRig;

function urlAs(role: string): string {
  const url = new URL(rig.url);
  url.username = role;
  url.password = 'pw';
  return url.toString();
}

async function sessionAs(role: string | null, app: string): Promise<Client> {
  const c = new Client({ connectionString: role === null ? rig.url : urlAs(role), application_name: app });
  await c.connect();
  return c;
}

const READ = `SELECT datname, pid, usesysid, usename, application_name, query, backend_type, backend_start, state, leader_pid FROM pg_stat_activity WHERE application_name = $1`;

beforeAll(async () => {
  rig = await startRig();
  for (const role of ['nb21_bot', 'nb21_other']) await rig.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw' NOSUPERUSER`);
  await rig.admin.query('CREATE ROLE nb21_owner NOLOGIN');
}, 180_000);
afterAll(async () => { await stopRig(rig); });

describe("another role's row as a role that is not a superuser sees it", () => {
  it('shows the database, pid, role and name, and hides the query, kind and start', async () => {
    const outside = await sessionAs('nb21_other', 'outside');
    const bot = await sessionAs('nb21_bot', 'nb21-reader');
    try {
      const { rows } = await bot.query(READ, ['outside']);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      for (const k of ['datname', 'pid', 'usesysid', 'usename', 'application_name']) expect(row[k], k).not.toBeNull();
      expect(row.usename).toBe('nb21_other');
      expect(row.query).toBe('<insufficient privilege>');
      const found = { backend_type: row.backend_type, backend_start: row.backend_start, state: row.state, leader_pid: row.leader_pid };
      expect(found, JSON.stringify(found)).toEqual({ backend_type: null, backend_start: null, state: null, leader_pid: null });

      const { rows: full } = await rig.admin.query(READ, ['outside']);
      expect(full[0].backend_type).toBe('client backend');
      expect(full[0].backend_start).not.toBeNull();
    } finally {
      await bot.end();
      await outside.end();
    }
  });

  it('a server process with no role has usesysid NULL', async () => {
    const { rows } = await rig.admin.query(`SELECT backend_type, usesysid FROM pg_stat_activity WHERE backend_type IN ('autovacuum launcher', 'autovacuum worker', 'checkpointer')`);
    expect(rows.some(r => r.backend_type === 'autovacuum launcher')).toBe(true);
    for (const r of rows) expect(r.usesysid, r.backend_type).toBeNull();
  });
});

describe('a default role the login role is not a member of (C19)', () => {
  it("hides the kind of the login role's own sessions", async () => {
    await rig.admin.query('GRANT nb21_owner TO nb21_bot');
    await rig.admin.query('ALTER ROLE nb21_bot SET role = nb21_owner');
    try {
      const a = await sessionAs('nb21_bot', 'nb21-own-a');
      const b = await sessionAs('nb21_bot', 'nb21-own-b');
      try {
        expect((await b.query('SELECT current_user AS cu, session_user AS su')).rows[0]).toEqual({ cu: 'nb21_owner', su: 'nb21_bot' });
        const { rows } = await b.query(READ, ['nb21-own-a']);
        expect(rows).toHaveLength(1);
        expect(rows[0].usename).toBe('nb21_bot');
        expect({ backend_type: rows[0].backend_type }, JSON.stringify(rows[0])).toEqual({ backend_type: null });
      } finally {
        await a.end();
        await b.end();
      }
    } finally {
      await rig.admin.query('ALTER ROLE nb21_bot RESET role');
      await rig.admin.query('REVOKE nb21_owner FROM nb21_bot');
    }
  });
});
