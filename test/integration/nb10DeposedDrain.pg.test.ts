import fs from 'fs';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { beginStop, installStopHandler, saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { checkWriterLock, configureWriterLock, onDeposed, takeWriterLock, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { setBackendKind } from '../helpers/backendKind';
import { poolFor, startPostgres } from '../helpers/postgres';

// NB10 test 48 ([pg]): a deposed bot process drains its working set before its exit with code 75. A write accepted
// and not yet flushed when another process takes the lock lands in guild_data before the exit, and no file write is
// accepted after the deposition. The stop runs once per process, so the case with the database refusing writes is
// nb10DeposedDrainLeft.pg.test.ts.

let container: StartedPostgreSqlContainer;
let direct: Pool;
let backend: PostgresBackend;
const OTHER = 4848;
const token: FenceToken = { nodeId: 'node-a', claim: 1, processId: 'p-1', shardId: 0, shardCount: 1 };

beforeAll(async () => {
  container = await startPostgres();
  direct = poolFor(container);
  const user = encodeURIComponent(container.getUsername());
  const password = encodeURIComponent(container.getPassword());
  backend = new PostgresBackend({ url: `postgres://${user}:${password}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}` });
  backend.start();
  const until = Date.now() + 60_000;
  while (backend.connectionState().state !== 'ready' && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
  expect(backend.connectionState().state).toBe('ready');
  // NB4: a save lands only under its shard's claim row, held here by process p-1.
  await direct.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
    VALUES (1, 0, 1, 'p-1', 'node-a', 'node-a', 'node-a', 30000, 30000) ON CONFLICT DO NOTHING`);
});

afterAll(async () => {
  await backend?.stop();
  await direct?.end();
  await container?.stop();
});

async function stored(guildId: string): Promise<string | null> {
  const res = await direct.query('SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1 AND module = $2 AND filename = $3', [guildId, 'm', 'x.json']);
  return res.rows[0]?.doc ?? null;
}

async function lockedRead(guildId: string): Promise<string | null> {
  const client = await direct.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '500ms'");
    const res = await client.query('SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1 AND module = $2 AND filename = $3', [guildId, 'm', 'x.json']);
    return res.rows[0]?.doc ?? null;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('a deposed bot process', () => {
  it('lands a write still in its working set before it exits 75, and accepts no file write after the deposition', async () => {
    setBackendKind('postgres');
    const guildId = '484848484848484848';
    const live = new Set([process.pid, OTHER]);
    configureWriterLock('bot', { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
    expect(takeWriterLock().kind).toBe('taken');
    const ws = initWorkingSet(backend);
    expect(await ws.hydrate(guildId, token)).toBe('ready');

    let exited: { code: number | undefined; row: Promise<string | null> } | null = null;
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited = { code, row: stored(guildId) };
      return undefined as never;
    }) as typeof process.exit);
    installStopHandler();
    onDeposed(() => { void Promise.resolve().then(() => beginStop(true)); });

    // The flush is held behind a table lock, so the write is accepted and not landed when the deposition comes.
    const blocker: PoolClient = await direct.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE smdb_data.guild_data IN ACCESS EXCLUSIVE MODE');
    let released = false;
    try {
      const accepted = saveDataTracked('x.json', { guildId, category: 'm' }, { landed: 'in the drain' });
      expect(accepted.outcome).toBe('saved');
      // A plain read would wait behind the table lock for ever; a bounded one proves the table is still held, so the
      // write cannot have landed yet.
      await expect(lockedRead(guildId)).rejects.toMatchObject({ code: '55P03' });

      fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
      expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
      expect(saveDataTracked('after.json', { scope: 'global', category: 'nb10drain' }, { v: 1 })).toEqual({ outcome: 'refused', cause: 'writer-lost' });

      await new Promise(resolve => { setTimeout(resolve, 300); });
      await blocker.query('COMMIT');
      released = true;
    } finally {
      if (!released) await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    for (let i = 0; i < 600 && !exited; i++) await new Promise(resolve => { setTimeout(resolve, 100); });
    expect(exited).not.toBe(null);
    expect(exited!.code).toBe(75);
    expect(JSON.parse((await exited!.row)!)).toEqual({ landed: 'in the drain' });
    expect(fs.existsSync(writerLockPath())).toBe(true);
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid).toBe(OTHER);
    expect(fs.existsSync(`${process.env.DATA_DIR}/global/nb10drain/after.json`)).toBe(false);
  }, 120_000);
});
