import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { storeIdRefusal } from '../../src/bot/internalSetup/utils/dataBackends/storeShape';
import {
  boot, clientOn, ensureBotRole, hasSmdbData, makeTemplate, newDatabase, shapeSchemas, startNb16Rig, stopNb16Rig,
  storeSnapshot, urlOf, type Nb16Rig,
} from '../helpers/nb16Rig';
import { fixedChooser } from '../helpers/fixedDatabase';

// NB16 round 1 fixes on postgres:16-alpine: the fresh path whose version row a rule swallows (NB16-DL-1), a store
// that lost its store_id row while the marker records one (NB16-DL-2), and a boot that waits for another process's
// bootstrap lock (NB16-RUN-2).

let rig: Nb16Rig;
let logs: MockInstance;
let errors: MockInstance;
const T = 120_000;

beforeAll(async () => {
  rig = await startNb16Rig();
  await ensureBotRole(rig);
  await makeTemplate(rig);
}, 300_000);
afterAll(async () => { await stopNb16Rig(rig); });
beforeEach(() => {
  logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('NB16-DL-1: a rule that swallows the version row on a fresh database', () => {
  it('is refused as the schema the bot made, naming the rule, and nothing is committed', async () => {
    const pool = await newDatabase(rig, 'nb16_fix1_dl1', 'empty');
    await pool.query(`CREATE FUNCTION public.swallow_meta() RETURNS event_trigger LANGUAGE plpgsql AS $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF r.command_tag = 'CREATE TABLE' AND r.object_identity = 'smdb_data.meta' THEN
            EXECUTE 'CREATE RULE swallow AS ON INSERT TO smdb_data.meta DO INSTEAD NOTHING';
          END IF;
        END LOOP;
      END $$`);
    await pool.query(`CREATE EVENT TRIGGER swallow_meta ON ddl_command_end EXECUTE FUNCTION public.swallow_meta()`);
    const verdict = await boot(urlOf(rig, 'nb16_fix1_dl1')) as { state: string; reason?: string; fix?: string; found?: string };
    expect(verdict.state).toBe('shape');
    expect(verdict.reason!.startsWith("the schema this bot made in the database differed from this bot's schema and was rolled back")).toBe(true);
    expect(verdict.reason).toContain('smdb_data.meta has rule swallow (');
    expect(verdict.found).toBeUndefined();
    expect(await hasSmdbData(pool)).toBe(false);
    expect(await shapeSchemas(pool)).toEqual([]);
  }, T);
});

describe('NB16-DL-2: a store that lost its store_id row while the marker records one', () => {
  it('is refused with nothing written, and no new store id is made', async () => {
    const pool = await newDatabase(rig, 'nb16_fix1_dl2', 'store');
    await pool.query(`DELETE FROM smdb_data.meta WHERE key = 'store_id'`);
    const before = await storeSnapshot(pool);
    const refusal = storeIdRefusal('store-dl2');
    const backend = new PostgresBackend({ chooser: fixedChooser(urlOf(rig, 'nb16_fix1_dl2')), markerStoreId: () => 'store-dl2' });
    backend.start();
    try {
      expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    } finally {
      await backend.stop();
    }
    expect(await storeSnapshot(pool)).toEqual(before);
    expect((await pool.query(`SELECT 1 FROM smdb_data.meta WHERE key = 'store_id'`)).rows).toEqual([]);
    expect(errors.mock.calls.map(c => String(c[0]))).toContain(`[PostgresBackend] ${refusal.header}`);
  }, T);
});

describe('NB16-RUN-2: a boot waits for another holder of the bootstrap lock', () => {
  it('logs that it waits, then checks once the lock is free, past the 30 s statement_timeout', async () => {
    await newDatabase(rig, 'nb16_fix1_run2', 'store');
    const url = urlOf(rig, 'nb16_fix1_run2');
    const holder = await clientOn(url);
    const backend = new PostgresBackend({ chooser: fixedChooser(url) });
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext('smdb_data_bootstrap'))`);
      backend.start();
      const waiting = "[PostgresBackend] Waiting for the bootstrap lock, held by another bot process's schema check or a data migration";
      await vi.waitFor(() => { expect(logs.mock.calls.map(c => String(c[0]))).toContain(waiting); }, { timeout: 20_000, interval: 100 });
      await new Promise(resolve => setTimeout(resolve, 35_000));
      expect(backend.servesData()).toBe(false);
      await holder.query('COMMIT');
      expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
      expect(logs.mock.calls.map(c => String(c[0])).filter(l => l === waiting)).toHaveLength(1);
      const failed = vi.mocked(console.warn).mock.calls.map(c => String(c[0])).filter(l => /Bootstrap attempt/.test(l));
      expect(failed).toEqual([]);
    } finally {
      await backend.stop();
      await holder.end().catch(() => undefined);
    }
  }, T);
});
