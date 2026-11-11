import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonBot, realService, resetDatabase, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, root, seedFile, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

// NB26: on a real Postgres, the migration's upsert of NB23's owner-message rows sets updated_at to each key's posted
// time (the 90-day prune counts from it), and a round trip gives the file back with each key's first time.

let rig: PgRig;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const keysFile = () => path.join(root, 'owner-messages.json');

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

async function migrate(jobId: string, to: 'postgres' | 'file'): Promise<void> {
  const service = realService(new FakeHost());
  await service.post({ jobId, to });
  await service.idle();
  expect(service.status().body.job?.state, why(service.status().body.job)).toBe('done');
}

async function keyRows(): Promise<Record<string, { value: string; at: string }>> {
  const { rows } = await rig.admin.query(`SELECT key, value, updated_at FROM smdb_data.meta WHERE key LIKE 'owner-message:%' ORDER BY key`);
  return Object.fromEntries(rows.map(r => [r.key, { value: JSON.parse(r.value), at: new Date(r.updated_at).toISOString() }]));
}

describe('the owner-message keys across a migration', () => {
  it('JSON to Postgres writes each key with updated_at at its posted time, and the round trip keeps the first time', async () => {
    jsonBot();
    seedFile('250000000000000001/m/a.json', '{"a":1}');
    const a = ago(40);
    const b = ago(2);
    fs.writeFileSync(keysFile(), JSON.stringify({ keys: { a, b, old: ago(91) } }, null, 2));
    await migrate('job-nb26-pg-001', 'postgres');
    expect(await keyRows()).toEqual({ 'owner-message:a': { value: a, at: a }, 'owner-message:b': { value: b, at: b } });

    const pruned = await rig.admin.query(`SELECT count(*)::int AS n FROM smdb_data.meta WHERE key LIKE 'owner-message:%' AND updated_at < now() - interval '30 days'`);
    expect(pruned.rows[0].n).toBe(1);

    fs.writeFileSync(keysFile(), JSON.stringify({ keys: { a: ago(1) } }, null, 2));
    await migrate('job-nb26-pg-002', 'file');
    expect(JSON.parse(fs.readFileSync(keysFile(), 'utf8')).keys).toEqual({ a, b });

    await migrate('job-nb26-pg-003', 'postgres');
    expect(await keyRows()).toEqual({ 'owner-message:a': { value: a, at: a }, 'owner-message:b': { value: b, at: b } });
  }, 120_000);
});
