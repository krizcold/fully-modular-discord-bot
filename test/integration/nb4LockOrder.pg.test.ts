import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

// NB4 decision 8 and invariant 2 (R2-LOCKCOPY): the production flush's first statement orders an old holder's save and
// a new holder's stamp on the guild's ownership row lock, in both orders, and through an insert not committed yet.
// A's save is PostgresBackend.flushGuild itself, on A's own backend, whose pool holds that flush's COMMIT until the
// test lets it go.

let rig: ClaimRig;
let aBackend: PostgresBackend;
let holdNext = false;
let atCommit: (() => void) | null = null;
let letCommit: (() => void) | null = null;

beforeAll(async () => {
  rig = await startClaimRig();
  aBackend = new PostgresBackend({ url: rig.url });
  aBackend.start();
  const until = Date.now() + 60_000;
  while (aBackend.connectionState().state !== 'ready' && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
  expect(aBackend.connectionState().state).toBe('ready');
  const pool = (aBackend as any).pool;
  const connect = pool.connect.bind(pool);
  pool.connect = async () => {
    const client = await connect();
    if (!client.heldCommitWrapped) {
      client.heldCommitWrapped = true;
      const query = client.query.bind(client);
      client.query = async (...args: any[]) => {
        const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        if (holdNext && typeof text === 'string' && text.trim().toUpperCase() === 'COMMIT') {
          holdNext = false;
          const go = new Promise<void>(resolve => { letCommit = resolve; });
          atCommit?.();
          await go;
        }
        return query(...args);
      };
    }
    return client;
  };
}, 180_000);
afterAll(async () => {
  await aBackend?.stop();
  await rig?.stop();
});
beforeEach(async () => { await rig.reset(); });

const A: FenceToken = { nodeId: 'n-a', claim: 10, processId: 'p-a', shardId: 0, shardCount: 1 };
const B: FenceToken = { nodeId: 'n-b', claim: 11, processId: 'p-b', shardId: 0, shardCount: 1 };
const setRow = (t: FenceToken) => rig.direct.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
  VALUES (1, 0, $1, $2, $3, $3, $3, 30000, 30000)
  ON CONFLICT (shard_count, shard_id) DO UPDATE SET claim = EXCLUDED.claim, holder_process = EXCLUDED.holder_process, holder_node = EXCLUDED.holder_node`, [t.claim, t.processId, t.nodeId]);
let guild = 700_000;

/** A's production flush, stopped right before its COMMIT: every statement before it has run and holds its locks. */
async function aSavesHeld(guildId: string, doc: string) {
  holdNext = true;
  const reached = new Promise<void>(resolve => { atCommit = resolve; });
  const flush = aBackend.flushGuild(guildId, { upserts: [{ key: { module: 'm', filename: 'x.json' }, doc }], deletes: [], appends: [] }, A);
  const early = flush.then(outcome => { throw new Error(`the flush ended before its COMMIT: ${JSON.stringify(outcome)}`); });
  early.catch(() => undefined);
  await Promise.race([reached, early]);
  return { commit: async () => { letCommit!(); expect(await flush).toEqual({ ok: true }); } };
}

describe('the save and the take on one guild row', () => {
  it('A\'s flush holds the row lock while B takes and hydrates: B reads A\'s write after A commits', async () => {
    const guildId = String(++guild);
    await setRow(A);
    expect((await rig.backend.hydrateGuild(guildId, A)).ok).toBe(true);
    const save = await aSavesHeld(guildId, '{"from":"a"}');
    await setRow(B);
    let hydrated = false;
    const hydrate = rig.backend.hydrateGuild(guildId, B).finally(() => { hydrated = true; });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(hydrated).toBe(false);
    await save.commit();
    expect(await hydrate).toMatchObject({ ok: true, docs: [{ doc: '{"from":"a"}' }] });
    expect((await rig.direct.query(`SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId])).rows).toEqual([{ doc: '{"from":"a"}' }]);
    expect((await rig.direct.query(`SELECT claim::int AS claim, node_id FROM smdb_data.guild_ownership WHERE guild_id = $1`, [guildId])).rows).toEqual([{ claim: 11, node_id: 'n-b' }]);
  });

  it('B stamps first: A\'s flush is refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const guildId = String(++guild);
    await setRow(A);
    expect((await rig.backend.hydrateGuild(guildId, A)).ok).toBe(true);
    await setRow(B);
    expect((await rig.backend.hydrateGuild(guildId, B)).ok).toBe(true);
    expect(await aBackend.flushGuild(guildId, { upserts: [{ key: { module: 'm', filename: 'x.json' }, doc: '{}' }], deletes: [], appends: [] }, A))
      .toMatchObject({ ok: false, reason: 'deposed' });
    expect((await rig.direct.query(`SELECT count(*)::int AS n FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId])).rows[0].n).toBe(0);
  });

  it('the guild has no ownership row: A\'s uncommitted insert, then B takes and hydrates; after A commits B is ok and reads A\'s write', async () => {
    const guildId = String(++guild);
    await setRow(A);
    const save = await aSavesHeld(guildId, '{"first":"a"}');
    await setRow(B);
    let hydrated = false;
    const hydrate = rig.backend.hydrateGuild(guildId, B).finally(() => { hydrated = true; });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(hydrated).toBe(false);
    await save.commit();
    expect(await hydrate).toMatchObject({ ok: true, docs: [{ doc: '{"first":"a"}' }] });
    expect((await rig.direct.query(`SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId])).rows).toEqual([{ doc: '{"first":"a"}' }]);
  });
});
