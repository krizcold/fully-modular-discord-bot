import fs from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { processId } from '../../src/bot/internalSetup/fleet/processId';
import { REQUEST_INSERT_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { _resetRowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, startSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { setBackendKind } from '../helpers/backendKind';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import { pause, until } from '../helpers/nb6Pg';
import { sha } from '../helpers/sharedRows';

// NB6 test 24 [pg] (wip-redesign/sheets/NB6.md rows 37, 38 and 41; decisions 10 and 29, C26, D's move of row 41 here;
// part 8): the real listener of sharedListener.ts on real Postgres. Another session's committed change reaches the
// mirror through its notification; after pg_terminate_backend of the 'smdb-shared-listen' session the listener
// reconnects within its 5 s retry and the pass on the connect applies a change committed while it was down; a request
// insert for this process asks the sweep for a pass.

const CATEGORY = 'nb6listen';
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const fileOf = (name: string) => dataPath('global', CATEGORY, name);
const GUILD = String(1n << 22n);

let rig: ClaimRig;
const sweeps: number[] = [];

async function otherWrites(key: string, body: string): Promise<void> {
  const client = await rig.direct.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `INSERT INTO smdb_data.shared_docs (key, body, sha, rev, updated_by) VALUES ($1, $2, $3, nextval('smdb_data.shared_rev_seq'), 'BRAVO/p-bravo')
       ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, sha = EXCLUDED.sha, rev = EXCLUDED.rev, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING rev`,
      [key, Buffer.from(body), sha(body)],
    );
    await client.query("SELECT pg_notify('smdb_shared', $1)", [JSON.stringify({ k: 'doc', key, sha: sha(body), rev: Number(res.rows[0].rev), by: 'p-bravo' })]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

const listening = async () => Number((await rig.direct.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'smdb-shared-listen'`)).rows[0].n);
const read = (name: string) => { try { return fs.readFileSync(fileOf(name), 'utf8'); } catch { return null; } };

beforeAll(async () => {
  rig = await startClaimRig();
}, 180_000);

afterAll(async () => {
  await rig?.stop();
});

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetRowQueue();
  _resetSharedMirror();
  setBackendKind('postgres');
  dm.setGuildDataBackend(rig.backend);
  fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  await rig.direct.query('DELETE FROM smdb_data.shared_docs');
  await rig.direct.query('DELETE FROM smdb_data.guild_requests');
  sweeps.length = 0;
  startSharedPass({ guildRequests: () => { sweeps.push(Date.now()); } });
  await until(async () => (await listening()) === 1);
});

afterEach(async () => {
  _resetSharedMirror();
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  vi.restoreAllMocks();
  await until(async () => (await listening()) === 0, 10_000);
});

describe('row 37: a connect', () => {
  it('LISTENs both channels, then a notified change reaches the mirror', async () => {
    expect(await listening()).toBe(1);
    await otherWrites(keyOf('a.json'), '{"a":1}');
    await until(() => read('a.json') === '{"a":1}', 5000);
    expect(sweeps.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe('row 38: the listening session is ended', () => {
  it('reconnects and the pass on the connect applies a change committed while it was down', async () => {
    await rig.direct.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'smdb-shared-listen'`);
    await otherWrites(keyOf('b.json'), '{"b":"while down"}');
    await until(async () => (await listening()) === 1, 15_000);
    await until(() => read('b.json') === '{"b":"while down"}', 15_000);
  }, 60_000);
});

describe('row 41: a request for this process', () => {
  it('the insert\'s notification asks the sweep for a pass; one for another process does not', async () => {
    await pause(200);
    const before = sweeps.length;
    const values = (forProcess: string) => [randomUUID(), GUILD, 2, 1, forProcess, 'write', JSON.stringify({ module: 'm', filename: 'a.json', contentJson: '{}' }), 'ALPHA', 5, 20];
    await rig.direct.query(REQUEST_INSERT_SQL, values('p-somebody-else'));
    await pause(500);
    expect(sweeps.length).toBe(before);
    await rig.direct.query(REQUEST_INSERT_SQL, values(processId()));
    await until(() => sweeps.length === before + 1, 5000);
  }, 60_000);
});
