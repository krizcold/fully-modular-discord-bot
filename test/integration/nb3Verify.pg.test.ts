import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertDoc, jsonBot, provisionedStore, realService, resetDatabase, schemas, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, MARKER, readJson, root, seedFile, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

// NB3 decision 10: counts and checksums before COMMIT.

let rig: PgRig;
const G = '262626262626262626';

beforeAll(async () => { rig = await startRig(); }, 180_000);
afterAll(async () => { await stopRig(rig); });
beforeEach(async () => {
  wipeRoot();
  await resetDatabase(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

async function run(fault: (p: string) => void | Promise<void>, to: 'postgres' | 'file' = 'postgres') {
  const service = realService(new FakeHost(), { fault });
  await service.post({ jobId: 'job-verify-01', to });
  await service.idle();
  return service.status().body.job;
}

describe('verification', () => {
  it('a read-back mismatch leaves nothing in the database, naming the key', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{"a":1}');
    // The copy is uncommitted, so no other session can change it: a trigger armed when the job creates guild_data
    // changes each document's bytes as the job inserts it.
    await rig.admin.query(`CREATE OR REPLACE FUNCTION public.nb3_flip_doc() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.doc := NEW.doc || ' '; RETURN NEW; END $$`);
    await rig.admin.query(`CREATE OR REPLACE FUNCTION public.nb3_arm_flip() RETURNS event_trigger LANGUAGE plpgsql AS $$
      DECLARE obj record;
      BEGIN
        FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF obj.object_type = 'table' AND obj.object_identity = 'smdb_data.guild_data' THEN
            EXECUTE 'CREATE TRIGGER nb3_flip BEFORE INSERT ON smdb_data.guild_data FOR EACH ROW EXECUTE FUNCTION public.nb3_flip_doc()';
          END IF;
        END LOOP;
      END $$`);
    let armed = false;
    try {
      const job = await run(async p => {
        if (p !== 'S5') return;
        await rig.admin.query('DROP EVENT TRIGGER IF EXISTS nb3_arm_flip');
        await rig.admin.query(`CREATE EVENT TRIGGER nb3_arm_flip ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.nb3_arm_flip()`);
        armed = true;
      });
      expect(armed).toBe(true);
      expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying' });
      expect(job.error).toBe(`The copy in the database differs from the source in 1 document(s): ${G}/m/a.json`);
      expect(await schemas(rig)).toEqual([]);
      expect(readJson(MARKER).live).toBe('file');
    } finally {
      await rig.admin.query('DROP EVENT TRIGGER IF EXISTS nb3_arm_flip');
    }
  });

  it('a staged file whose bytes differ from the source fails at verifying, naming the key, with nothing placed', async () => {
    await provisionedStore(rig);
    await insertDoc(rig, G, 'm', 'a.json', '{"a":1}');
    let changed = 0;
    const job = await run(p => {
      if (p !== 'S6') return;
      for (const name of fs.readdirSync(root).filter(n => n.startsWith('.migrate-'))) {
        const staged = path.join(root, name, G, 'm', 'a.json');
        if (!fs.existsSync(staged)) continue;
        fs.writeFileSync(staged, '{"a":2}');
        changed += 1;
      }
    }, 'file');
    expect(changed).toBe(1);
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying' });
    expect(job.error).toBe(`The staged copy differs from the source in 1 document(s): ${G}/m/a.json`);
    expect(fs.readdirSync(root).filter(n => n.startsWith('.migrate-'))).toEqual([]);
    expect(fs.existsSync(path.join(root, G))).toBe(false);
    expect(await schemas(rig)).toEqual(['smdb_data']);
    expect(readJson(MARKER).live).toBe('postgres');
  });

  it('a JSON source changed between the reads leaves nothing in the database, naming the key', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{"a":1}');
    const job = await run(p => {
      if (p === 'S7') fs.writeFileSync(path.join(root, G, 'm', 'a.json'), '{"a":2}');
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading' });
    expect(job?.error, why(job)).toContain('a.json');
    expect(await schemas(rig)).toEqual([]);
  });
});
