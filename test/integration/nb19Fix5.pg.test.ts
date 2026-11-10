import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB19 round 5 fix DL-2: a rerun after an unmanaged migration's .env write whose folder chain failed writes the .env
// again with a chain of its own process before the status reads done, even though the .env already names the target.

const h = vi.hoisted(() => ({
  rule: null as null | ((call: { fn: string; dir: string; stack: string }) => { kind: 'sync' | 'open' | 'earlier'; errno: string } | null),
  flagged: null as null | { dir: string; errno: string },
  calls: [] as Array<{ fn: string; dir: string; stack: string }>,
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  const wrap = (fn: string, run: (dir: string) => any) => (dir: string) => {
    const at = path.resolve(dir);
    const stack = new Error().stack ?? '';
    h.calls.push({ fn, dir: at, stack });
    if (h.flagged) return { failed: true, kind: 'earlier', dir: h.flagged.dir, errno: h.flagged.errno, error: null };
    const hit = h.rule?.({ fn, dir: at, stack });
    if (hit) {
      if (hit.kind === 'sync') h.flagged = { dir: at, errno: hit.errno };
      return { failed: true, kind: hit.kind, dir: at, errno: hit.errno, error: null };
    }
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

import { jsonBot, realService, resetDatabase, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, root, seedFile, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';
import { readEnvFileDataBackend } from '../../src/utils/envLoader';

let rig: PgRig;
const G = '191919191919191919';
const envChain = ({ fn, stack }: { fn: string; stack: string }) => fn === 'syncFolderChainSync' && stack.includes('writeEnvDataBackend');
const journal = () => JSON.parse(fs.readFileSync(path.join(root, '.migration.json'), 'utf8'));

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

async function interruptedAtEnv(jobId: string) {
  jsonBot();
  seedFile(`${G}/m/a.json`, '{"a":1}');
  h.rule = call => (envChain(call) ? { kind: 'sync', errno: 'EIO' } : null);
  const job = (await run(jobId, 'postgres')).status().body.job;
  expect(job.state, why(job)).toBe('interrupted');
  expect(job.stage).toBe('env');
  expect(readEnvFileDataBackend()).toBe('postgres');
  expect(journal().unconfirmed).toBe(job.error);
  return job;
}

describe('DL-2: the rerun after an .env write whose chain failed', () => {
  it('in a new process: the .env is written and chained again before done, and unconfirmed is cleared', async () => {
    await interruptedAtEnv('job-nb19-f5-1');
    h.rule = null;
    h.flagged = null;
    const mark = h.calls.length;
    const again = await run('job-nb19-f5-2', 'postgres');
    const body = again.status().body;
    expect(body.job?.state ?? body.state, why(body)).toBe('done');
    expect(h.calls.slice(mark).some(envChain)).toBe(true);
    expect(journal().unconfirmed).toBeUndefined();
    expect(journal().result).toBe('done');
    expect(readEnvFileDataBackend()).toBe('postgres');
  });

  it('in the same process, the flag still set: the rerun ends interrupted and keeps unconfirmed', async () => {
    await interruptedAtEnv('job-nb19-f5-3');
    await run('job-nb19-f5-4', 'postgres');
    const kept = journal().unconfirmed;
    expect(typeof kept).toBe('string');
    const status = realService(new FakeHost()).status().body.job;
    expect(status.state).toBe('interrupted');
    expect(status.error).toBe(kept);
  });
});
