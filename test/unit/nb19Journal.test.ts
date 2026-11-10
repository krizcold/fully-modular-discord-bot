import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB19 rows 41, 42 and 51: the migration's journal and marker writes whose folder chain failed. The file holds the
// new bytes, and each text is T7 (or S12's done line), never "could not be written". The chain answer is set per
// write here and a 'sync' answer sets the flag as the real walk does; the walk itself is nb19FolderChain's.

const h = vi.hoisted(() => ({
  rule: null as null | ((call: { dir: string; stack: string }) => { kind: 'sync' | 'open' | 'earlier'; errno: string } | null),
  hits: 0,
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderChainSync: (dir: string) => {
      const at = path.resolve(dir);
      const hit = h.rule?.({ dir: at, stack: new Error().stack ?? '' });
      if (!hit) return real.syncFolderChainSync(dir);
      h.hits += 1;
      if (hit.kind === 'sync') real.noteFolderSyncFailure(at, hit.errno);
      return { failed: true, kind: hit.kind, dir: at, errno: hit.errno, error: null };
    },
  };
});

import { normalizeAddress } from '../../src/bot/internalSetup/utils/dataMigration';
import { syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { loadCredentials } from '../../src/utils/envLoader';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { ENV, FakeHost, JOURNAL, MARKER, PG_URL, freshJsonBot, readJson, root, serviceFor, useDatabaseUrl, wipeRoot, writeJson, why } from '../helpers/migrationRig';

const ROOT = path.resolve(root);
const T1 = (file: string) => {
  const { why: clause, next } = syncWords('sync', ROOT, 'EIO');
  return `${file} is written, but ${clause}, so can't confirm it is stored. ${next}`;
};
const EIO = { kind: 'sync' as const, errno: 'EIO' };
const onJournal = (match: (journal: any) => boolean) => ({ stack }: { stack: string }) => {
  if (!stack.includes('writeJournal')) return null;
  return match(readJson(JOURNAL)) ? EIO : null;
};

let errors: string[];
beforeEach(() => {
  wipeRoot();
  h.rule = null;
  h.hits = 0;
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
  loadCredentials();
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});
afterEach(() => {
  h.rule = null;
  vi.restoreAllMocks();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
});

const noWriteFailText = () => expect(errors.some(e => e.includes('could not be written'))).toBe(false);

describe('row 41: begin and the first marker', () => {
  it('begin\'s journal with a failed chain: failed at checking with T7, the journal holds the job, the lock is free', async () => {
    freshJsonBot();
    h.rule = onJournal(j => j.jobId === 'job-nb19-41-begin' && j.stage === 'checking');
    const host = new FakeHost();
    const service = serviceFor(new FakeDb(), host);
    const answer = await service.post({ jobId: 'job-nb19-41-begin', to: 'postgres' });
    expect(h.hits).toBe(1);
    expect(answer).toEqual({
      status: 200,
      body: {
        success: true, jobId: 'job-nb19-41-begin', to: 'postgres', state: 'failed', stage: 'checking',
        error: `The journal of migration job-nb19-41-begin can't be confirmed as saved, so nothing was started: ${T1(JOURNAL)}`,
      },
    });
    expect(readJson(JOURNAL)).toMatchObject({ jobId: 'job-nb19-41-begin', to: 'postgres', stage: 'checking' });
    expect(readJson(MARKER).live).toBe('file');
    expect(host.lock).toBeNull();
    expect(answer.body.error).not.toContain('could not be written');
  });

  it('the first marker with a failed chain: refused with T7, the marker names file, no journal', async () => {
    h.rule = ({ stack }) => (stack.includes('writeMarkerStrict') ? EIO : null);
    const host = new FakeHost();
    const answer = await serviceFor(new FakeDb(), host).post({ jobId: 'job-nb19-41-mark', to: 'postgres' });
    expect(h.hits).toBe(1);
    expect(answer).toEqual({
      status: 409,
      body: { success: false, error: `The backend marker can't be confirmed as saved, so nothing was started: ${T1(MARKER)}` },
    });
    expect(readJson(MARKER)).toMatchObject({ live: 'file', storeId: null });
    expect(fs.existsSync(JOURNAL)).toBe(false);
    expect(host.lock).toBeNull();
  });
});

describe('row 51: classify\'s earlier journal and finish()\'s done journal', () => {
  const OLD = 'job-nb19-51-old';

  it('the earlier journal marked failed with a failed chain: refused with T7, the journal holds failed', async () => {
    freshJsonBot();
    writeJson(JOURNAL, { jobId: OLD, to: 'postgres', stage: 'checking', result: 'interrupted', startedAt: 1, finishedAt: 2 });
    h.rule = onJournal(j => j.jobId === OLD && j.result === 'failed');
    const host = new FakeHost();
    const answer = await serviceFor(new FakeDb(), host).post({ jobId: 'job-nb19-51-new', to: 'postgres' });
    expect(h.hits).toBe(1);
    expect(answer).toEqual({
      status: 409,
      body: { success: false, error: `The earlier journal of migration ${OLD} can't be confirmed as saved, so nothing was started: ${T1(JOURNAL)}` },
    });
    expect(readJson(JOURNAL)).toMatchObject({ jobId: OLD, result: 'failed' });
    expect(host.lock).toBeNull();
    noWriteFailText();
  });

  it('finish()\'s done journal with a failed chain: the done line, the answer done, the journal holds done', async () => {
    freshJsonBot();
    writeJson(MARKER, { live: 'postgres', storeId: 'copy-nb19', flippedAt: 1, migration: OLD });
    writeJson(JOURNAL, {
      jobId: OLD, to: 'postgres', stage: 'switching', result: 'interrupted', startedAt: 1, finishedAt: 5, storeId: 'copy-nb19',
      destination: normalizeAddress(PG_URL), envSwitched: true,
    });
    fs.writeFileSync(ENV, 'DATA_BACKEND=postgres\n');
    h.rule = onJournal(j => j.jobId === OLD && j.result === 'done');
    const answer = await serviceFor(new FakeDb(), new FakeHost()).post({ jobId: 'job-nb19-51-fin', to: 'postgres' });
    expect(h.hits).toBe(1);
    expect(answer.body, why(answer)).toEqual({ success: true, jobId: OLD, to: 'postgres', state: 'done', stage: 'switching', envSwitched: true });
    expect(errors).toContain(`[Migration] Migration ${OLD} is done, but its journal can't be confirmed as saved: ${T1(JOURNAL)}`);
    expect(readJson(JOURNAL)).toMatchObject({ jobId: OLD, result: 'done' });
    noWriteFailText();
    expect(errors.some(e => e.includes('failed'))).toBe(false);
  });
});

describe('row 42: S12\'s done journal', () => {
  const G1 = '191900000000000421';

  it('a done journal with a failed chain: the done line, the job done, the journal holds done', async () => {
    const db = new FakeDb();
    writeJson(MARKER, { live: 'postgres', storeId: 'src-nb19-42', flippedAt: 1 });
    db.schemas.set('smdb_data', { ...emptyStore('src-nb19-42'), data: [{ guild_id: G1, module: 'm', filename: 'a.json', doc: '{"a":1}' }] });
    h.rule = onJournal(j => j.jobId === 'job-nb19-42-1' && j.result === 'done');
    const service = serviceFor(db, new FakeHost());
    const answer = await service.post({ jobId: 'job-nb19-42-1', to: 'file' });
    expect(answer.body.state, why(answer)).toBe('started');
    await service.idle();
    expect(h.hits).toBe(1);
    expect(errors).toContain(`[Migration] Migration job-nb19-42-1 is done, but its journal can't be confirmed as saved: ${T1(JOURNAL)}`);
    expect(readJson(JOURNAL)).toMatchObject({ jobId: 'job-nb19-42-1', result: 'done' });
    expect(service.status().body.job, why(service.status().body)).toMatchObject({ jobId: 'job-nb19-42-1', state: 'done' });
    expect(fs.readFileSync(path.join(root, G1, 'm', 'a.json'), 'utf8')).toBe('{"a":1}');
    noWriteFailText();
  });
});
