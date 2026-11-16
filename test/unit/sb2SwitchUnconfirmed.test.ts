import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  marker: null as null | ((real: (m: unknown) => void, m: unknown) => void),
  env: null as null | ((real: (v: string) => void, v: string) => void),
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/recognitionGuard', async orig => {
  const real = await orig<any>();
  return { ...real, writeMarkerStrict: (m: unknown) => (h.marker ? h.marker(real.writeMarkerStrict, m) : real.writeMarkerStrict(m)) };
});
vi.mock('../../src/utils/envLoader', async orig => {
  const real = await orig<any>();
  return { ...real, writeEnvDataBackend: (v: string) => (h.env ? h.env(real.writeEnvDataBackend, v) : real.writeEnvDataBackend(v)) };
});

import { FolderSyncError, type SyncKind } from '../../src/bot/internalSetup/utils/folderChain';
import { FakeDb } from '../helpers/fakePg';
import { ENV, FakeHost, JOURNAL, MARKER, PG_URL, freshJsonBot, readJson, root, seedFile, serviceFor, useDatabaseUrl, why, wipeRoot } from '../helpers/migrationRig';

// T15 (NB19 D5): the marker or DATA_BACKEND in /data/.env is written but its folder sync failed, so the switch is not
// confirmed; the journal keeps the text and the status read answers it.

const G = '820000000000000001';
const OPEN_TAIL = 'Run the migration again to confirm the switch.';
const RESTART_TAIL = 'Run the migration again after the restart to confirm the switch.';
const ENV_UNFINISHED = 'The switch is made; run the migration again to finish the env';
const logs: string[] = [];

const syncError = (file: string, kind: SyncKind, errno: string) => new FolderSyncError(file, { failed: true, kind, dir: path.resolve(root), errno, error: null });

beforeEach(() => {
  logs.length = 0;
  h.marker = null;
  h.env = null;
  wipeRoot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  const capture = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});
afterEach(() => {
  h.marker = null;
  h.env = null;
  vi.restoreAllMocks();
  wipeRoot();
});

async function runToPostgres(jobId: string): Promise<any> {
  freshJsonBot();
  seedFile(`${G}/mod/a.json`, '{"a":1}');
  const service = serviceFor(new FakeDb(), new FakeHost());
  const answer = await service.post({ jobId, to: 'postgres' });
  expect(answer.body.state, why(answer)).toBe('started');
  await service.idle();
  return service.status().body.job;
}

describe('the marker of S10 is written but its folder sync failed', () => {
  const cases: Array<[SyncKind, string, string]> = [['open', 'EMFILE', OPEN_TAIL], ['sync', 'EIO', RESTART_TAIL], ['earlier', 'EIO', RESTART_TAIL]];
  for (const [kind, errno, tail] of cases) {
    it(`a ${kind} failure leaves the job interrupted at switching with the T15 text, kept in the journal`, async () => {
      let thrown: FolderSyncError | null = null;
      h.marker = (real, m) => {
        real(m);
        thrown = syncError(MARKER, kind, errno);
        throw thrown;
      };
      const jobId = `job-sb2-mk-${kind}`;
      const job = await runToPostgres(jobId);
      expect(thrown).not.toBeNull();
      const text = `The marker of migration ${jobId} can't be confirmed as saved: ${thrown!.message} ${tail}`;
      expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'switching', error: text });
      const journal = readJson(JOURNAL);
      expect(journal).toMatchObject({ jobId, stage: 'switching', result: 'interrupted', error: text, unconfirmed: text });
      expect(fs.existsSync(ENV)).toBe(false);
      expect(logs.some(l => l.includes('is done'))).toBe(false);
    });
  }
});

describe('DATA_BACKEND of S11 is written but its folder sync failed', () => {
  for (const [kind, errno, tail] of [['open', 'ENFILE', OPEN_TAIL], ['sync', 'EIO', RESTART_TAIL]] as Array<[SyncKind, string, string]>) {
    it(`a ${kind} failure logs T7, answers the env as unfinished and keeps the T15 text in the journal`, async () => {
      let thrown: FolderSyncError | null = null;
      h.env = (real, v) => {
        real(v);
        thrown = syncError(ENV, kind, errno);
        throw thrown;
      };
      const jobId = `job-sb2-env-${kind}`;
      const job = await runToPostgres(jobId);
      expect(thrown).not.toBeNull();
      const unconfirmed = `DATA_BACKEND in /data/.env can't be confirmed as saved: ${thrown!.message} ${tail}`;
      expect(job, why(job)).toMatchObject({ state: 'interrupted', stage: 'env', error: unconfirmed });
      expect(readJson(JOURNAL)).toMatchObject({ jobId, stage: 'env', result: 'interrupted', error: ENV_UNFINISHED, unconfirmed });
      expect(logs).toContain(`[Migration] DATA_BACKEND in /data/.env can't be confirmed as saved: ${thrown!.message}`);
      expect(logs.some(l => l.includes('could not be written'))).toBe(false);
    });
  }
});
