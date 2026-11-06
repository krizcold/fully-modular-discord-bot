import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlushOutcome, RetireOutcome } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { showEntry } from '../../src/utils/databaseAddress';
import { copyStore, entryOf, liveDocs, provision, setGeneration, sleep, startBot, waitFor, type BotRun } from '../helpers/nb5Pg';
import { startPostgres } from '../helpers/postgres';

// NB5 section 8 [pg] test 6 (F3, R2-RUN-2): a flush with a document and an appended line whose COMMIT reaches A and is
// held there while the latch rises; it answers only after useDatabase returned. A holds a COMMIT by waiting for a
// synchronous standby that does not exist (synchronous_standby_names set and reloaded), released by resetting it.
// Step (e) runs the real settleRetires against the target (nb5Pg's startBot).

const STORE = 'store-nb5';
const G = '880000000000000701';
const P = { nodeId: 'node-a', claim: 40, processId: 'p-a', shardId: 0, shardCount: 1 };
let a: StartedPostgreSqlContainer;
let w: StartedPostgreSqlContainer;
let directA: Pool;
let directW: Pool;
let entryA: string;
let entryW: string;
let bot: BotRun | null = null;

beforeAll(async () => {
  [a, w] = await Promise.all([startPostgres(), startPostgres()]);
  entryA = entryOf(a);
  entryW = entryOf(w);
  directA = new Pool({ connectionString: entryA, max: 4 });
  directW = new Pool({ connectionString: entryW, max: 4 });
}, 240_000);
afterAll(async () => {
  await directA?.end();
  await directW?.end();
  await Promise.all([a?.stop(), w?.stop()]);
});
beforeEach(async () => {
  await holdCommits(false);
  for (const pool of [directA, directW]) {
    await pool.query('DROP SCHEMA IF EXISTS smdb_data CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS smdb_manager CASCADE');
  }
  await provision(entryA, directA, STORE);
  await provision(entryW, directW, STORE);
  await setGeneration(directA, 'node-a', 1);
  await directA.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
    VALUES (1, 0, 40, 'p-a', 'node-a', 'node-a', 'node-a', 30000, 30000)`);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  await holdCommits(false);
  await bot?.stop();
  bot = null;
  vi.restoreAllMocks();
});

/** COMMITs on A wait for a synchronous standby that never answers while on; off releases every waiting one. */
async function holdCommits(on: boolean): Promise<void> {
  if (on) await directA.query(`ALTER SYSTEM SET synchronous_standby_names = 'nb5_never'`);
  else await directA.query('ALTER SYSTEM RESET synchronous_standby_names');
  await directA.query('SELECT pg_reload_conf()');
  await sleep(300);
}

/** A's generation raised on a session that does not wait for the standby, while A holds every other COMMIT. */
async function raiseAPastHold(generation: number): Promise<void> {
  const client = await directA.connect();
  try {
    await client.query('SET synchronous_commit = local');
    await setGeneration(client as unknown as Pool, 'node-a', generation);
  } finally {
    client.release();
  }
}

const lines = async (pool: Pool, guildId: string) =>
  (await pool.query(`SELECT chunk FROM smdb_data.guild_append WHERE guild_id = $1 ORDER BY seq`, [guildId])).rows.map(r => r.chunk).join('');

/**
 * G hydrated on A, then a document and a line whose COMMIT A holds while the latch rises and the move runs. 'w' moves
 * to W (copied from A at generation 2, given A's rows again after the commit when `wGivenTail`); 'tie-a' ties A with W
 * at generation 1 and then resolves the tie for A by raising A to 2. The first flush must answer through the late
 * COMMIT (`landedOn`), not through its own 40 s bound.
 */
async function heldFlush(mode: 'w' | 'tie-a', wGivenTail = false): Promise<void> {
  bot = await startBot([entryA], STORE);
  expect(await bot.ws.hydrate(G, P)).toBe('ready');
  if (mode === 'w') {
    await copyStore(directA, directW);
    await setGeneration(directW, 'node-w', 2);
  } else {
    await setGeneration(directW, 'node-w', 1);
  }
  const flushes = vi.spyOn(bot.backend, 'flushGuild');
  await holdCommits(true);
  bot.ws.save(G, 'm', 'doc.json', '"late"');
  expect(bot.ws.append(G, 'm', 'log.jsonl', 'line-1\n')).toBeTruthy();
  const flushing = bot.ws.flushAllDirty();
  await sleep(1_000);
  bot.list = [entryA, entryW];
  bot.chooser.confirmNow();
  // A tie latches on the second tied pass; asking on each poll starts it 5 s after the first instead of 30 s.
  await waitFor(() => {
    if (bot!.backend.latchReason() !== null) return true;
    if (mode === 'tie-a') bot!.chooser.confirmNow();
    return false;
  }, 30_000);
  if (mode === 'tie-a') await raiseAPastHold(2);
  await waitFor(() => bot!.moved.length === 1, 30_000);
  expect(bot.moved).toEqual([mode === 'w' ? entryW : entryA]);
  await holdCommits(false);
  await flushing;
  expect(await (flushes.mock.results[0].value as Promise<FlushOutcome>)).toMatchObject({ ok: false, reason: 'unavailable', commitUnanswered: true, landedOn: showEntry(entryA) });
  if (wGivenTail) {
    await copyStore(directA, directW);
    await setGeneration(directW, 'node-w', 2);
  }
}

describe('a COMMIT answered after the move', () => {
  it('W without the batch: the batch is checked by its flush id on W, the line is there once and the document by the re-save', async () => {
    await heldFlush('w');
    await waitFor(async () => {
      await bot!.ws.flushAllDirty().catch(() => undefined);
      return (await liveDocs(directW, G))['doc.json'] === '"late"' && bot!.ws.resaveGuilds().length === 0 && bot!.ws.dirtyGuildIds().length === 0;
    }, 90_000);
    expect(await lines(directW, G)).toBe('line-1\n');
  }, 240_000);

  it('W already holding the batch (given A\'s rows after the commit): the line is not sent again', async () => {
    await heldFlush('w', true);
    await waitFor(async () => {
      await bot!.ws.flushAllDirty().catch(() => undefined);
      return bot!.ws.resaveGuilds().length === 0 && bot!.ws.dirtyGuildIds().length === 0;
    }, 90_000);
    expect(await lines(directW, G)).toBe('line-1\n');
    expect((await liveDocs(directW, G))['doc.json']).toBe('"late"');
  }, 240_000);

  it('the tie resolved for A (A reopened): the batch is checked by its flush id on A, and the line is on A once and never on W', async () => {
    await heldFlush('tie-a');
    await waitFor(async () => {
      await bot!.ws.flushAllDirty().catch(() => undefined);
      return bot!.ws.resaveGuilds().length === 0 && bot!.ws.dirtyGuildIds().length === 0;
    }, 90_000);
    expect(await lines(directA, G)).toBe('line-1\n');
    expect((await liveDocs(directA, G))['doc.json']).toBe('"late"');
    expect(await lines(directW, G)).toBe('');
  }, 240_000);
});

describe('step (e) on a real target: retireReached reads BATCH_PRESENT on W', () => {
  /** G's retire landed on A; W given A's rows before it (no batch) or after it (the batch), then the move to W. */
  async function retireThenMove(wHoldsBatch: boolean): Promise<void> {
    bot = await startBot([entryA], STORE);
    expect(await bot.ws.hydrate(G, P)).toBe('ready');
    bot.ws.save(G, 'm', 'doc.json', '"retired"');
    await bot.ws.flushAllDirty();
    if (!wHoldsBatch) await copyStore(directA, directW);
    const retired: RetireOutcome = await bot.backend.retireGuild(G, 'test', P);
    expect(retired).toMatchObject({ ok: true, moved: 1 });
    if (wHoldsBatch) await copyStore(directA, directW);
    await setGeneration(directW, 'node-w', 2);
    bot.retires.push({ guildId: G, answer: Promise.resolve(retired) });
    bot.list = [entryA, entryW];
    bot.chooser.confirmNow();
    await waitFor(() => bot!.moved.length === 1, 60_000);
    expect(bot.retires).toEqual([]);
  }

  it('W holding the batch: the retire reached W, the set is dropped and the line logged', async () => {
    await retireThenMove(true);
    expect(bot!.reached).toEqual([G]);
    expect(bot!.ws.resaveGuilds()).toEqual([]);
    expect(vi.mocked(console.log).mock.calls.map(c => String(c[0]))).toContain(`[Data] Guild ${G}: its retire reached ${showEntry(entryW)}`);
  }, 240_000);

  it('W without the batch: the retire did not reach W, the guild is re-saved there and the repeat line logged', async () => {
    await retireThenMove(false);
    expect(bot!.reached).toEqual([]);
    expect(vi.mocked(console.warn).mock.calls.map(c => String(c[0]))).toContain(
      `[Data] Guild ${G}: its retire did not reach ${showEntry(entryW)}, so this process re-saves the guild's data there; repeat the retire once the bot runs on ${showEntry(entryW)}`);
  }, 240_000);
});
