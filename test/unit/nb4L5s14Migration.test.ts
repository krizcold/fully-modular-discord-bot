import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyStore, FakeDb, type Row } from '../helpers/fakePg';
import { FakeHost, PG_URL, freshJsonBot, seedFile, serviceFor, useDatabaseUrl, why, wipeRoot, writeJson, JOURNAL, STORES } from '../helpers/migrationRig';

// NB4 decision 25: the rename aside of a store this deployment served refuses while a bot process that may still
// save holds claims in it, naming each shard, its machine and when it was seen, under the longest takeover delay.

const G = '282828282828282828';
const OLD = 'store-old-1';

beforeEach(() => {
  wipeRoot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** FakeDb with the claims tables present: the live-claims read answers the given rows. */
function withClaims(db: FakeDb, live: Row[]) {
  return async (_url: string, app: string) => {
    const client = db.connect(app);
    const query = client.query.bind(client);
    (client as { query: unknown }).query = async (text: string, params?: any[]) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (/to_regclass\('smdb_data\.shard_claims'\)/.test(sql)) return { rows: [{ present: true }] };
      if (/FROM smdb_data\.shard_claims c JOIN smdb_data\.shard_nodes n/.test(sql)) return { rows: live.map(r => ({ ...r })) };
      return query(text, params);
    };
    return client;
  };
}

async function moveToPostgres(live: Row[]) {
  freshJsonBot();
  seedFile(`${G}/m/a.json`, '{"a":1}');
  writeJson(STORES, { storeIds: [OLD] });
  writeJson(JOURNAL, { jobId: 'job-dest-earlier', to: 'postgres', stage: 'committing', startedAt: 1, storeId: OLD });
  const db = new FakeDb();
  db.schemas.set('smdb_data', { ...emptyStore(OLD), data: [{ guild_id: '1', module: 'x', filename: 'y.json', doc: '{"keep":true}' }] });
  const service = serviceFor(db, new FakeHost(), { connect: withClaims(db, live) as never });
  await service.post({ jobId: `job-l5s14-${live.length}`, to: 'postgres' });
  await service.idle();
  return { job: service.status().body.job, db };
}

describe('the rename aside with live shard claims', () => {
  it('refuses, naming every shard, its machine and when it was seen, under the longest delay, and renames nothing', async () => {
    const { job, db } = await moveToPostgres([
      { shard_id: '0', node_name: 'Alpha', takeover_seconds: 30, seen_ago_s: 4 },
      { shard_id: 3, node_name: 'Beta', takeover_seconds: '60', seen_ago_s: '12' },
    ]);
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'copying' });
    expect(job.error).toBe(`Store ${OLD} has shard claims of bot processes seen in the last 60 s: shard 0 held by Alpha (seen 4 s ago), `
      + 'shard 3 held by Beta (seen 12 s ago); stop the bot on those machines (a clean stop releases its claims), then retry; it was not renamed');
    expect([...db.schemas.keys()]).toEqual(['smdb_data']);
    expect(db.schemas.get('smdb_data')!.storeId).toBe(OLD);
    expect(db.schemas.get('smdb_data')!.data).toEqual([{ guild_id: '1', module: 'x', filename: 'y.json', doc: '{"keep":true}' }]);
  });

  it('with the tables present and no live claim, renames the old store aside and copies', async () => {
    const { job, db } = await moveToPostgres([]);
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const aside = [...db.schemas.keys()].filter(k => k.startsWith('smdb_superseded_'));
    expect(aside).toHaveLength(1);
    expect(db.schemas.get(aside[0])!.storeId).toBe(OLD);
  });
});
