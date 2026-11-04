import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertAppend, insertDoc, provisionedStore, realService, resetDatabase, schemas, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, root, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

// NB3 decision 8: keys a Postgres source cannot place as files.

let rig: PgRig;
const G = '232323232323232323';
const CLEAN = '100000000000000001';

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
afterEach(() => { vi.restoreAllMocks(); });

/** Every path under a `.migrate-` folder that the job makes or opens for writing. */
function watchStaging(): string[] {
  const seen: string[] = [];
  const realOpen = fs.promises.open;
  const realMkdir = fs.promises.mkdir;
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags?: any, ...rest: any[]) => {
    if (String(p).includes('.migrate-') && flags !== undefined && flags !== 'r') seen.push(String(p));
    return (realOpen as any)(p, flags, ...rest);
  }) as any);
  vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (p: any, ...rest: any[]) => {
    if (String(p).includes('.migrate-')) seen.push(String(p));
    return (realMkdir as any)(p, ...rest);
  }) as any);
  return seen;
}

async function run() {
  const service = realService(new FakeHost());
  await service.post({ jobId: 'job-coll-0001', to: 'file' });
  await service.idle();
  return service.status().body.job;
}

const REFUSED: Array<[string, () => Promise<void>, RegExp]> = [
  ['a file and a folder of one name', async () => { await insertDoc(rig, G, 'm', 'a', '{}'); await insertDoc(rig, G, 'm', 'a/b.json', '{}'); }, /m\/a/],
  ['a key in both tables', async () => { await insertDoc(rig, G, 'm', 'x.json', '{}'); await insertAppend(rig, G, 'm', 'x.json', 'l\n'); }, /x\.json/],
  ['a stream not ending in .jsonl', async () => { await insertAppend(rig, G, 'm', 'log.txt', 'l\n'); }, /log\.txt/],
  ['a .jsonl document', async () => { await insertDoc(rig, G, 'm', 'doc.jsonl', '{}'); }, /doc\.jsonl/],
  ['a key ending in .tmp', async () => { await insertDoc(rig, G, 'm', 'x.json.tmp', '{}'); }, /x\.json\.tmp/],
  ['two keys differing only in letter case', async () => { await insertDoc(rig, G, 'm', 'Case.json', '{}'); await insertDoc(rig, G, 'm', 'case.json', '{}'); }, /case\.json/i],
];

describe('refused at reading before any write, naming the keys', () => {
  it.each(REFUSED)('%s', async (_name, seed, named) => {
    await provisionedStore(rig);
    await insertDoc(rig, CLEAN, 'm', 'ok.json', '{}');
    await seed();
    const staged = watchStaging();
    const job = await run();
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading' });
    expect(job?.error, why(job)).toMatch(named);
    expect(staged).toEqual([]);
    expect(fs.existsSync(path.join(root, G))).toBe(false);
    expect(fs.existsSync(path.join(root, CLEAN))).toBe(false);
    expect(await schemas(rig)).toEqual(['smdb_data']);
  });
});

describe('a non-canonical row beside its canonical twin', () => {
  it('the canonical row goes to its path, the other to shadow/, named in the answer', async () => {
    await provisionedStore(rig);
    await insertDoc(rig, G, 'mod', 'id.json', '{"module":true}');
    await insertDoc(rig, G, '', 'mod/id.json', '{"browser":true}');
    await insertDoc(rig, G, '', 'other/solo.json', '{"solo":true}');
    const job = await run();
    expect(job?.state, why(job)).toBe('done');
    expect(fs.readFileSync(path.join(root, G, 'mod', 'id.json'), 'utf-8')).toBe('{"module":true}');
    expect(fs.readFileSync(path.join(root, G, 'other', 'solo.json'), 'utf-8')).toBe('{"solo":true}');
    expect(job.shadow?.join('\n') ?? '').toContain('mod/id.json');
    const sup = fs.readdirSync(path.join(root, '_superseded'));
    const shadowDir = path.join(root, '_superseded', sup[0], 'shadow');
    const files = fs.readdirSync(shadowDir, { recursive: true }) as string[];
    const hit = files.map(f => path.join(shadowDir, f)).find(f => fs.statSync(f).isFile())!;
    expect(fs.readFileSync(hit, 'utf-8')).toBe('{"browser":true}');
  });
});
