import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { confirmWrite, readGuildDocRaw, saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite, shaOfRaw } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { BotManager } from '../../src/webui/botManager';
import { configureWriterLock, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { setBackendKind } from '../helpers/backendKind';
import { poolFor, startPostgres } from '../helpers/postgres';
import fs from 'fs';

// NB10 test 18 ([pg]): a Postgres-routed guild's operator write carries the sha of the read it was built on; a stale
// sha answers changed and guild_data keeps the module's write; the current sha lands the operator's body; with no bot
// process the route answers bot-down and no row changes.

vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}) }) }));

let container: StartedPostgreSqlContainer;
let direct: Pool;
let backend: PostgresBackend;
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
  setBackendKind('postgres');
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

describe('the executor compare on a Postgres guild', () => {
  it('a stale expectSha answers changed and the module write stays; the current sha lands the operator body', async () => {
    setBackendKind('postgres');
    const guildId = '181818181818181818';
    const ws = initWorkingSet(backend);
    try {
      expect(await ws.hydrate(guildId, token)).toBe('ready');
      const first = saveDataTracked('x.json', { guildId, category: 'm' }, { count: 1 });
      if (first.outcome !== 'saved') throw new Error(`not accepted: ${first.outcome}`);
      expect(await confirmWrite(first.ticket, 15_000)).toBe('ok');
      const read = shaOfRaw(readGuildDocRaw(guildId, 'm', 'x.json'));
      const module = saveDataTracked('x.json', { guildId, category: 'm' }, { count: 2 });
      if (module.outcome !== 'saved') throw new Error(`not accepted: ${module.outcome}`);

      const stale = await applyOperatorDataWrite({ guildId, module: 'm', filename: 'x.json', op: 'write', contentJson: '{"count":1,"op":true}', expectSha: read });
      expect(stale).toMatchObject({ ok: false, code: 'changed' });
      expect(await confirmWrite(module.ticket, 15_000)).toBe('ok');
      expect(JSON.parse((await stored(guildId))!)).toEqual({ count: 2 });

      const current = shaOfRaw(readGuildDocRaw(guildId, 'm', 'x.json'));
      const reply = await applyOperatorDataWrite({ guildId, module: 'm', filename: 'x.json', op: 'write', contentJson: '{"count":2,"op":true}', expectSha: current });
      expect(reply).toEqual({ ok: true });
      expect(JSON.parse((await stored(guildId))!)).toEqual({ count: 2, op: true });
    } finally {
      ws.evict(guildId);
    }
  }, 90_000);

  it('with no bot process the route answers bot-down, takes no lock, and no row changes', async () => {
    setBackendKind('postgres');
    configureWriterLock('webui');
    const guildId = '181818181818181819';
    const before = await stored(guildId);
    const reply = await new BotManager().writeGuildData({ guildId, module: 'm', filename: 'x.json', op: 'write', contentJson: '{"a":1}', expectSha: 'absent' });
    expect(reply).toMatchObject({ ok: false, code: 'bot-down' });
    expect(await stored(guildId)).toBe(before);
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });
});
