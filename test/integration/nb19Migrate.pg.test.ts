import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB19 decisions 5 and 8: the migration to JSON syncs every folder it stages and places, a failed folder sync fails
// the job with the source still serving, and a marker or .env write whose folder chain failed is never read as done.
// The folder answers are set per call here (the chain itself is nb19FolderChain.test.ts's), so the rows run on every
// platform.

const h = vi.hoisted(() => ({
  /** Answers a failed folder sync for the dirs or the writes it matches; null passes the call on (a rule may set flagged). */
  rule: null as null | ((call: { fn: string; dir: string; stack: string }) => { kind: 'sync' | 'open' | 'earlier'; errno: string } | null),
  /** Once set, every folder sync answers earlier, as the flag does in a real process. */
  flagged: null as null | { dir: string; errno: string },
  calls: [] as Array<{ fn: string; dir: string; stack: string }>,
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  const wrap = (fn: string, run: (dir: string) => any) => (dir: string) => {
    const at = path.resolve(dir);
    h.calls.push({ fn, dir: at, stack: new Error().stack ?? '' });
    if (h.flagged) return { failed: true, kind: 'earlier', dir: h.flagged.dir, errno: h.flagged.errno, error: null };
    const hit = h.rule?.({ fn, dir: at, stack: new Error().stack ?? '' });
    if (hit) {
      if (hit.kind === 'sync') h.flagged = { dir: at, errno: hit.errno };
      return { failed: true, kind: hit.kind, dir: at, errno: hit.errno, error: null };
    }
    const setByRule = h.flagged as { dir: string; errno: string } | null;
    if (setByRule) return { failed: true, kind: 'earlier', dir: setByRule.dir, errno: setByRule.errno, error: null };
    return run(dir);
  };
  return {
    ...real,
    syncFolder: wrap('syncFolder', real.syncFolder),
    syncFolderChain: wrap('syncFolderChain', real.syncFolderChain),
    syncFoldersUnder: wrap('syncFoldersUnder', real.syncFoldersUnder),
    syncFolderChainSync: wrap('syncFolderChainSync', real.syncFolderChainSync),
  };
});

import { insertDoc, jsonBot, provisionedStore, realService, resetDatabase, schemas, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, MARKER, root, seedFile, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';
import { providerCredentialsPath } from '../../src/utils/envLoader';

let rig: PgRig;
const G = '191919191919191919';

beforeAll(async () => { rig = await startRig(); }, 180_000);
afterAll(async () => { await stopRig(rig); });
beforeEach(async () => {
  h.rule = null;
  h.flagged = null;
  h.calls.length = 0;
  wipeRoot();
  await resetDatabase(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

async function run(jobId: string, to: 'file' | 'postgres') {
  const service = realService(new FakeHost());
  await service.post({ jobId, to });
  await service.idle();
  return service;
}
async function postgresBot(): Promise<void> {
  await provisionedStore(rig);
  await insertDoc(rig, G, 'm', 'a.json', '{"a":1}');
  await insertDoc(rig, G, 'm/sub', 'b.json', '{"b":1}');
}
const sourceServes = async () => expect(await schemas(rig)).toContain('smdb_data');

describe('rows 25 and 26: the migration to JSON fails on a folder sync with the source serving', () => {
  it('25: EIO on a staged folder: failed before placing, staging gone, smdb_data serves', async () => {
    await postgresBot();
    h.rule = ({ fn, dir }) => (fn === 'syncFoldersUnder' && path.basename(dir).startsWith('.migrate-') ? { kind: 'sync', errno: 'EIO' } : null);
    const service = await run('job-nb19-25-1', 'file');
    const job = service.status().body.job;
    expect(job.state, why(job)).toBe('failed');
    expect(job.error).toContain("the migration's folders can't be confirmed as stored: the disk did not confirm the sync of");
    expect(job.error).toContain('Check the disk, then restart the machine.');
    expect(fs.readdirSync(root).filter(n => n.startsWith('.migrate-'))).toEqual([]);
    expect(fs.existsSync(path.join(root, G))).toBe(false);
    await sourceServes();
  });

  it('26: EIO on a folder under /data/global after the renames: failed at placing, folders placed, smdb_data serves', async () => {
    await postgresBot();
    await rig.admin.query(
      `INSERT INTO smdb_data.shared_docs (key, body, sha, rev, updated_by) VALUES ($1, $2::bytea, encode(sha256($2::bytea), 'hex'), nextval('smdb_data.shared_rev_seq'), 'node-pg')`,
      ['global/m/x.json', Buffer.from('{"x":1}')],
    );
    const globalDir = path.join(root, 'global');
    h.rule = ({ fn, dir }) => (fn === 'syncFolderChain' && dir.startsWith(globalDir + path.sep) ? { kind: 'sync', errno: 'EIO' } : null);
    const service = await run('job-nb19-26-1', 'file');
    const job = service.status().body.job;
    expect(job.state, why(job)).toBe('failed');
    expect(job.stage).toBe('placing');
    expect(job.error).toContain("the migration's folders can't be confirmed as stored: the disk did not confirm the sync of");
    expect(h.flagged?.dir.startsWith(globalDir + path.sep)).toBe(true);
    expect(fs.existsSync(path.join(root, G, 'm', 'a.json'))).toBe(true);
    expect(fs.readFileSync(path.join(globalDir, 'm', 'x.json'), 'utf8')).toBe('{"x":1}');
    await sourceServes();
  });
});

describe('rows 27, 44 and 59: the folders the migration to JSON syncs', () => {
  const STALE = '202020202020202020';
  const credentials = () => providerCredentialsPath();
  async function withLeftovers(): Promise<void> {
    await postgresBot();
    seedFile(`${STALE}/m/old.json`, '{"old":1}');
    fs.mkdirSync(path.dirname(credentials()), { recursive: true });
    fs.writeFileSync(credentials(), '{"fake":{}}');
  }
  const chainDirs = () => h.calls.filter(c => c.fn === 'syncFolderChain').map(c => c.dir);

  it('27: with good syncs every staged folder, each rename parent and both credentials folders are synced', async () => {
    await withLeftovers();
    const service = await run('job-nb19-27-1', 'file');
    const job = service.status().body;
    expect(job.job?.state ?? job.state, why(job)).toBe('done');
    const under = h.calls.filter(c => c.fn === 'syncFoldersUnder').map(c => c.dir);
    expect(under.some(d => path.basename(d).startsWith('.migrate-'))).toBe(true);
    const staging = under.find(d => path.basename(d).startsWith('.migrate-'))!;
    const chains = chainDirs();
    expect(chains).toContain(path.resolve(root));
    expect(chains).toContain(staging);
    const superseded = chains.filter(d => d.split(path.sep).includes('_superseded'));
    expect(superseded.length, chains.join('\n')).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(superseded.find(d => fs.existsSync(path.join(d, STALE)))!, STALE, 'm', 'old.json'), 'utf8')).toBe('{"old":1}');
    const credTo = chains.find(d => d.split(path.sep).includes('_superseded') && d.endsWith(path.join('global', 'payment-providers')));
    expect(credTo, chains.join('\n')).toBeDefined();
    expect(JSON.parse(fs.readFileSync(path.join(credTo!, 'credentials.json'), 'utf8'))).toEqual({ fake: {} });
    expect(chains).toContain(path.resolve(path.dirname(credentials())));
    expect(fs.existsSync(credentials())).toBe(false);
    expect(fs.readFileSync(path.join(root, G, 'm', 'sub', 'b.json'), 'utf8')).toBe('{"b":1}');
  });

  it('44: EIO on the folder the credentials move into: the job fails at its stage and smdb_data serves', async () => {
    await withLeftovers();
    h.rule = ({ fn, dir, stack }) => (fn === 'syncFolderChain' && stack.includes('moveCredentialsAside') && dir.split(path.sep).includes('_superseded') ? { kind: 'sync', errno: 'EIO' } : null);
    const service = await run('job-nb19-44-1', 'file');
    const job = service.status().body.job;
    expect(job.state, why(job)).toBe('failed');
    expect(job.error).toContain("the migration's folders can't be confirmed as stored: the disk did not confirm the sync of");
    expect(h.calls.some(c => c.stack.includes('moveCredentialsAside'))).toBe(true);
    await sourceServes();
  });

  it('59: the flag set before the staged folder syncs: failed before placing with the earlier clause, nothing placed', async () => {
    await postgresBot();
    const x = path.resolve(root, 'nb19x');
    h.rule = ({ fn, dir }) => {
      if (fn === 'syncFoldersUnder' && path.basename(dir).startsWith('.migrate-') && !h.flagged) h.flagged = { dir: x, errno: 'EIO' };
      return null;
    };
    const service = await run('job-nb19-59-1', 'file');
    const job = service.status().body.job;
    expect(job.state, why(job)).toBe('failed');
    expect(job.error).toContain(`the migration's folders can't be confirmed as stored: no folder sync is trusted since the disk did not confirm the sync of ${x} (EIO) earlier in this process. Check the disk, then restart the machine.`);
    expect(h.calls.filter(c => c.fn === 'syncFoldersUnder' && path.basename(c.dir).startsWith('.migrate-'))).toHaveLength(1);
    expect(['checking', 'copying', 'verifying', 'rereading', 'committing']).toContain(job.stage);
    expect(fs.existsSync(path.join(root, G))).toBe(false);
    expect(fs.readdirSync(root).filter(n => n.startsWith('.migrate-'))).toEqual([]);
    await sourceServes();
  });
});

describe('rows 40, 48, 73 and 74: a marker or .env write whose folder chain failed', () => {
  const marker = ({ fn, stack }: { fn: string; stack: string }) => fn === 'syncFolderChainSync' && stack.includes('writeMarkerStrict');

  it('40: the marker write: interrupted at switching, the status says T15 and never done; a rerun in a new process finishes', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{"a":1}');
    h.rule = call => (marker(call) ? { kind: 'sync', errno: 'EIO' } : null);
    const first = await run('job-nb19-40-1', 'postgres');
    const job = first.status().body.job;
    expect(job.state, why(job)).toBe('interrupted');
    expect(job.stage).toBe('switching');
    expect(job.error).toMatch(/^The marker of migration job-nb19-40-1 can't be confirmed as saved: .* Run the migration again after the restart to confirm the switch\.$/);
    expect(JSON.parse(fs.readFileSync(path.join(root, '.migration.json'), 'utf8')).unconfirmed).toBe(job.error);
    expect(realService(new FakeHost()).status().body.job.state).toBe('interrupted');

    h.flagged = null;
    const order: string[] = [];
    h.rule = call => {
      if (marker(call)) order.push('marker');
      else if (call.fn === 'syncFolderChainSync' && call.stack.includes('writeJournal')) {
        order.push(`journal:${JSON.parse(fs.readFileSync(path.join(root, '.migration.json'), 'utf8')).result ?? ''}`);
      }
      return null;
    };
    const mark = h.calls.length;
    const again = await run('job-nb19-40-2', 'postgres');
    const done = again.status().body;
    expect(done.job?.state ?? done.state, why(done)).toBe('done');
    expect(JSON.parse(fs.readFileSync(path.join(root, '.migration.json'), 'utf8')).unconfirmed).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(MARKER, 'utf8')).migration).toBe('job-nb19-40-1');
    expect(h.calls.slice(mark).some(marker)).toBe(true);
    const markerAt = order.indexOf('marker');
    expect(markerAt).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('journal:done')).toBeGreaterThan(markerAt);
  });

  it('73: a rerun in the same process, the flag still set, ends interrupted and keeps unconfirmed', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{"a":1}');
    h.rule = call => (marker(call) ? { kind: 'sync', errno: 'EIO' } : null);
    const first = await run('job-nb19-73-1', 'postgres');
    const error = first.status().body.job.error;
    await run('job-nb19-73-2', 'postgres');
    const journal = JSON.parse(fs.readFileSync(path.join(root, '.migration.json'), 'utf8'));
    expect(journal.unconfirmed).toBe(error);
    const status = realService(new FakeHost()).status().body.job;
    expect(status.state).toBe('interrupted');
    expect(status.error).toBe(error);
  });

  it('74: an open error on the marker\'s folder: T15 asks for a rerun, not a restart', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{"a":1}');
    h.rule = call => (marker(call) ? { kind: 'open', errno: 'EMFILE' } : null);
    const job = (await run('job-nb19-74-1', 'postgres')).status().body.job;
    expect(job.state, why(job)).toBe('interrupted');
    expect(job.error.endsWith('Run the migration again to confirm the switch.')).toBe(true);
    expect(job.error).not.toContain('restart');
  });

  it('48: an unmanaged migration\'s .env write: interrupted at env, T7 logged, the status reads T15', async () => {
    jsonBot();
    seedFile(`${G}/m/a.json`, '{"a":1}');
    h.rule = ({ fn, stack }) => (fn === 'syncFolderChainSync' && stack.includes('writeEnvDataBackend') ? { kind: 'sync', errno: 'EIO' } : null);
    const job = (await run('job-nb19-48-1', 'postgres')).status().body.job;
    expect(job.state, why(job)).toBe('interrupted');
    expect(job.stage).toBe('env');
    expect(job.error).toMatch(/^DATA_BACKEND in \/data\/\.env can't be confirmed as saved: .* Run the migration again after the restart to confirm the switch\.$/);
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => String(c[0]));
    expect(logged.some(l => l.startsWith("[Migration] DATA_BACKEND in /data/.env can't be confirmed as saved: "))).toBe(true);
    expect(logged.some(l => l.includes('DATA_BACKEND in /data/.env could not be written'))).toBe(false);
  });
});
