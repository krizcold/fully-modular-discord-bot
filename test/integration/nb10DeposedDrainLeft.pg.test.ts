import fs from 'fs';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { beginStop, installStopHandler, saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { checkWriterLock, configureWriterLock, onDeposed, takeWriterLock, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { setBackendKind } from '../helpers/backendKind';
import { poolFor, startPostgres } from '../helpers/postgres';

// NB10 test 48 ([pg]), its second case: with the database refusing the drain's writes, a deposed bot process names
// the guild in the "Shutdown drain left" line before it exits with code 75.

let container: StartedPostgreSqlContainer;
let direct: Pool;
let backend: PostgresBackend;
const OTHER = 4949;
const token: FenceToken = { nodeId: 'node-a', claim: 1, processId: 'p-1', shardId: 0, shardCount: 1 };

beforeAll(async () => {
  container = await startPostgres();
  direct = poolFor(container);
  const user = encodeURIComponent(container.getUsername());
  const password = encodeURIComponent(container.getPassword());
  backend = new PostgresBackend(fixedDatabase(`postgres://${user}:${password}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`));
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

describe('a deposed bot process whose database refuses the drain', () => {
  it('names the guild in the Shutdown drain left line before it exits 75', async () => {
    setBackendKind('postgres');
    const guildId = '494949494949494949';
    const live = new Set([process.pid, OTHER]);
    configureWriterLock('bot', { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
    expect(takeWriterLock().kind).toBe('taken');
    const ws = initWorkingSet(backend);
    expect(await ws.hydrate(guildId, token)).toBe('ready');

    const order: string[] = [];
    const warns = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { order.push(args.map(String).join(' ')); });
    let code: number | undefined | null = null;
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { code = c; order.push(`exit ${c}`); return undefined as never; }) as typeof process.exit);
    installStopHandler();
    onDeposed(() => { void Promise.resolve().then(() => beginStop(true)); });

    // The table stays locked through the 30 s drain: the write never lands.
    const blocker: PoolClient = await direct.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE smdb_data.guild_data IN ACCESS EXCLUSIVE MODE');
    try {
      expect(saveDataTracked('x.json', { guildId, category: 'm' }, { never: 'landed' }).outcome).toBe('saved');
      fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'webui', at: Date.now() }));
      expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
      for (let i = 0; i < 900 && code === null; i++) await new Promise(resolve => { setTimeout(resolve, 100); });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(code).toBe(75);
    const left = order.findIndex(line => line.startsWith('[Data] Shutdown drain left 1 guild(s) with unflushed writes:') && line.includes(guildId));
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThan(order.indexOf('exit 75'));
    expect(warns).toHaveBeenCalled();
  }, 150_000);
});
