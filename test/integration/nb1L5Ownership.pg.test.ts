import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { poolFor, startPostgres } from '../helpers/postgres';

let container: StartedPostgreSqlContainer;
let direct: Pool;
let nodeA: PostgresBackend;
let nodeB: PostgresBackend;

async function readyBackend(): Promise<PostgresBackend> {
  const user = encodeURIComponent(container.getUsername());
  const password = encodeURIComponent(container.getPassword());
  const b = new PostgresBackend({ url: `postgres://${user}:${password}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}` });
  b.start();
  const until = Date.now() + 60_000;
  while (b.connectionState().state !== 'ready' && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
  expect(b.connectionState().state).toBe('ready');
  return b;
}

async function claimOf(b: PostgresBackend): Promise<number> {
  const answer = await b.takeClaim();
  if (answer.outcome !== 'claimed') throw new Error(`no claim taken: ${answer.outcome}`);
  return answer.claim;
}

beforeAll(async () => {
  container = await startPostgres();
  direct = poolFor(container);
  nodeA = await readyBackend();
  nodeB = await readyBackend();
}, 120_000);

afterAll(async () => {
  await nodeA?.stop();
  await nodeB?.stop();
  await direct?.end();
  await container?.stop();
});

const tokenOf = (nodeId: string, claim: number): FenceToken => ({ nodeId, claim, shardId: 0, shardCount: 1 });
const batchOf = (doc: string) => ({ upserts: [{ key: { module: 'm', filename: 'x.json' }, doc }], deletes: [], appends: [] });

async function stored(guildId: string): Promise<string | null> {
  const res = await direct.query(
    'SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1 AND module = $2 AND filename = $3',
    [guildId, 'm', 'x.json']);
  return res.rows[0]?.doc ?? null;
}

async function ownerRow(guildId: string): Promise<{ node_id: string; claim: string; retired: boolean } | undefined> {
  return (await direct.query(
    'SELECT node_id, claim, retired_at IS NOT NULL AS retired FROM smdb_data.guild_ownership WHERE guild_id = $1',
    [guildId])).rows[0];
}

describe('fenced calls on a guild whose ownership row already exists', () => {
  it('a second flush under the same token answers ok and replaces the stored document', async () => {
    const guildId = '626001';
    const a = tokenOf('node-a', await claimOf(nodeA));
    expect((await nodeA.hydrateGuild(guildId, a)).ok).toBe(true);
    expect(await nodeA.flushGuild(guildId, batchOf('{"n":1}'), a)).toEqual({ ok: true });
    expect(await nodeA.flushGuild(guildId, batchOf('{"n":2}'), a)).toEqual({ ok: true });
    expect(await stored(guildId)).toBe('{"n":2}');
    expect(await ownerRow(guildId)).toEqual({ node_id: 'node-a', claim: String(a.claim), retired: false });
  });

  it('a higher claim hydrates a guild another node owns and the row names it; the old owner\'s flush is deposed', async () => {
    const guildId = '626002';
    const a = tokenOf('node-a', await claimOf(nodeA));
    expect((await nodeA.hydrateGuild(guildId, a)).ok).toBe(true);
    expect(await nodeA.flushGuild(guildId, batchOf('{"from":"a"}'), a)).toEqual({ ok: true });

    const b = tokenOf('node-b', await claimOf(nodeB));
    expect(b.claim).toBeGreaterThan(a.claim!);
    const hydrated = await nodeB.hydrateGuild(guildId, b);
    expect(hydrated).toEqual({ ok: true, docs: [{ key: { module: 'm', filename: 'x.json' }, doc: '{"from":"a"}' }], appendKeys: [] });
    expect(await ownerRow(guildId)).toEqual({ node_id: 'node-b', claim: String(b.claim), retired: false });
    expect(await nodeB.flushGuild(guildId, batchOf('{"from":"b"}'), b)).toEqual({ ok: true });

    expect(await nodeA.flushGuild(guildId, batchOf('{"from":"a2"}'), a))
      .toEqual({ ok: false, reason: 'deposed', currentOwner: { nodeId: 'node-b', claim: b.claim } });
    expect(await stored(guildId)).toBe('{"from":"b"}');
    expect(await ownerRow(guildId)).toEqual({ node_id: 'node-b', claim: String(b.claim), retired: false });
  });

  it('a retired guild hydrated again by its owner, and then by a newer claim, is listed again with retired_at cleared', async () => {
    const guildId = '626003';
    const b = tokenOf('node-b', await claimOf(nodeB));
    expect((await nodeB.hydrateGuild(guildId, b)).ok).toBe(true);
    expect(await nodeB.flushGuild(guildId, batchOf('{"from":"b"}'), b)).toEqual({ ok: true });
    expect(await nodeB.retireGuild(guildId, 'test', b)).toEqual({ ok: true, moved: 1 });
    expect(await ownerRow(guildId)).toEqual({ node_id: 'node-b', claim: String(b.claim), retired: true });
    expect(await nodeB.listGuilds()).not.toContain(guildId);

    expect(await nodeB.hydrateGuild(guildId, b)).toEqual({ ok: true, docs: [], appendKeys: [] });
    expect(await ownerRow(guildId)).toEqual({ node_id: 'node-b', claim: String(b.claim), retired: false });
    expect(await nodeB.listGuilds()).toContain(guildId);

    expect(await nodeB.retireGuild(guildId, 'test', b)).toEqual({ ok: true, moved: 0 });
    const newer = tokenOf('node-a', await claimOf(nodeA));
    expect(await nodeA.hydrateGuild(guildId, newer)).toEqual({ ok: true, docs: [], appendKeys: [] });
    expect(await ownerRow(guildId)).toEqual({ node_id: 'node-a', claim: String(newer.claim), retired: false });
  });

  it('reclaimGuild keeps a row naming this node under a newer claim, loses to a higher claim, and claims an absent row', async () => {
    const guildId = '626004';
    const shardsOf = async (id: string) => (await direct.query(
      'SELECT shard_id, shard_count FROM smdb_data.guild_ownership WHERE guild_id = $1', [id])).rows[0];
    const c1 = tokenOf('node-a', await claimOf(nodeA));
    expect((await nodeA.hydrateGuild(guildId, c1)).ok).toBe(true);
    expect(await ownerRow(guildId)).toEqual({ node_id: 'node-a', claim: String(c1.claim), retired: false });

    const c2: FenceToken = { nodeId: 'node-a', claim: await claimOf(nodeA), shardId: 2, shardCount: 4 };
    expect(c2.claim).toBeGreaterThan(c1.claim!);
    expect(await nodeA.reclaimGuild(guildId, c2)).toBe('kept');
    expect(await ownerRow(guildId)).toEqual({ node_id: 'node-a', claim: String(c2.claim), retired: false });
    expect(await shardsOf(guildId)).toEqual({ shard_id: 2, shard_count: 4 });

    const c3 = tokenOf('node-b', await claimOf(nodeB));
    expect(c3.claim).toBeGreaterThan(c2.claim!);
    expect((await nodeB.hydrateGuild(guildId, c3)).ok).toBe(true);
    expect(await nodeA.reclaimGuild(guildId, c2)).toBe('lost');
    expect(await ownerRow(guildId)).toEqual({ node_id: 'node-b', claim: String(c3.claim), retired: false });

    const absent = '626005';
    expect(await ownerRow(absent)).toBeUndefined();
    expect(await nodeA.reclaimGuild(absent, c2)).toBe('kept');
    expect(await ownerRow(absent)).toEqual({ node_id: 'node-a', claim: String(c2.claim), retired: false });
  });
});
