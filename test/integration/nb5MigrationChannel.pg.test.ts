import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { jsonBot, listStore, provisionedStore, realService, resetDatabase, schemas, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, root, seedFile, useDatabaseUrl, why } from '../helpers/migrationRig';
import { ownerChannelView, _resetOwnerChannel } from '../../src/webui/utils/ownerChannel';
import { _resetWebuiChoice, setWebuiDataStoreUrl } from '../../src/webui/utils/webuiDataReader';
import { setBackendKind } from '../helpers/backendKind';

// NB5 section 8 [pg] test 9 (decision 16, NB5-R6-OWNER-CHANNEL-MIGRATION), on NB3's pgMigrationRig: the owner channel
// setting carried by the data migration both ways, and over a destination store that NB3 renames aside.

const C = '500000000000000001';
const OTHER = '500000000000000009';
const G = '250000000000000001';
const channelFile = () => path.join(root, 'owner-channel.json');
let rig: PgRig;

beforeAll(async () => { rig = await startRig(); }, 180_000);
afterAll(async () => { await stopRig(rig); });
beforeEach(async () => {
  await resetDatabase(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  _resetOwnerChannel();
  _resetWebuiChoice();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  setWebuiDataStoreUrl(null);
  setBackendKind(null);
  vi.restoreAllMocks();
});

function seedJsonWithChannel(channel: string): void {
  jsonBot();
  seedFile(`${G}/m/a.json`, '{"a":1}');
  fs.writeFileSync(channelFile(), JSON.stringify({ channelId: channel }));
}

async function migrate(to: 'postgres' | 'file', jobId: string): Promise<any> {
  const service = realService(new FakeHost());
  await service.post({ jobId, to });
  await service.idle();
  return service.status().body.job;
}

const rowOf = async (schema: string) =>
  (await rig.admin.query(`SELECT value FROM "${schema}".meta WHERE key = 'owner_channel'`)).rows.map(r => r.value);

describe('decision 16: the owner channel across a real migration', () => {
  it('JSON with C to Postgres: owner_channel C in the new meta, read by GET after the switch; back to JSON: the file holds C and the renamed source keeps its row', async () => {
    seedJsonWithChannel(C);
    const there = await migrate('postgres', 'job-nb5-pg-0001');
    expect(there?.state, why(there)).toBe('done');
    expect(await rowOf('smdb_data')).toEqual([JSON.stringify(C)]);

    setBackendKind('postgres');
    setWebuiDataStoreUrl({ url: rig.url });
    expect(await ownerChannelView()).toMatchObject({ readable: true, channelId: C });
    setWebuiDataStoreUrl(null);
    setBackendKind(null);

    const back = await migrate('file', 'job-nb5-pg-0002');
    expect(back?.state, why(back)).toBe('done');
    expect(JSON.parse(fs.readFileSync(channelFile(), 'utf8'))).toEqual({ channelId: C });
    const aside = (await schemas(rig)).filter(n => n.startsWith('smdb_superseded_'));
    expect(aside).toHaveLength(1);
    expect(await rowOf(aside[0])).toEqual([JSON.stringify(C)]);
  });

  it('a destination that already held a store with another owner_channel (renamed aside by NB3) ends with C', async () => {
    const old = await provisionedStore(rig);
    await rig.admin.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('owner_channel', $1)`, [JSON.stringify(OTHER)]);
    seedJsonWithChannel(C);
    listStore(old);
    const job = await migrate('postgres', 'job-nb5-pg-0003');
    expect(job?.state, why(job)).toBe('done');
    expect(await rowOf('smdb_data')).toEqual([JSON.stringify(C)]);
    const aside = (await schemas(rig)).filter(n => n.startsWith('smdb_superseded_'));
    expect(aside).toHaveLength(1);
    expect(await rowOf(aside[0])).toEqual([JSON.stringify(OTHER)]);
  });
});
