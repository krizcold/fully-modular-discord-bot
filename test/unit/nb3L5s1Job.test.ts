import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jobSessionSettings, type PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { FakeDb } from '../helpers/fakePg';
import { FakeHost, JOURNAL, MARKER, PG_URL, freshJsonBot, readJson, seedFile, serviceFor, useDatabaseUrl } from '../helpers/migrationRig';

// NB3: a failure at any point is written to the journal; a setting is skipped only on the server's own refusal; a
// COMMIT error that is no server answer can't be confirmed; a source that changes between its two reads is refused.

const G = '313131313131313131';

beforeEach(() => {
  freshJsonBot();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('a throw at a fault point', () => {
  it('a thrown null is a failure written to the journal', async () => {
    const service = serviceFor(new FakeDb(), new FakeHost(), { fault: point => { if (point === 'S2') throw null; } });
    await service.post({ jobId: 'job-l5s1-death-01', to: 'postgres' });
    await service.idle();
    expect(readJson(JOURNAL)).toMatchObject({ result: 'failed', stage: 'checking', error: 'null' });
  });

  it('only an object marked as a death skips the journal; a marked function is a failure', async () => {
    const fn = Object.assign(() => undefined, { simulateDeath: true });
    const service = serviceFor(new FakeDb(), new FakeHost(), { fault: point => { if (point === 'S2') throw fn; } });
    await service.post({ jobId: 'job-l5s1-death-02', to: 'postgres' });
    await service.idle();
    expect(readJson(JOURNAL)).toMatchObject({ result: 'failed', stage: 'checking' });
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[Migration\] Migration job-l5s1-death-02 failed at checking: /));
  });
});

function settingsSession(onSet: () => unknown): PgSession {
  return {
    async query(text: string) {
      if (/current_setting/.test(text)) return { rows: [{ version: 140000, pid: 7, started: '123' }] };
      if (/^SET tcp_user_timeout/.test(text)) throw onSet();
      return { rows: [] };
    },
    async end() { /* nothing */ },
  };
}

describe('the session settings', () => {
  it('a server refusal of a setting is skipped', async () => {
    const refusal = Object.assign(new Error('unrecognized configuration parameter'), { code: '42704', severity: 'ERROR' });
    await expect(jobSessionSettings(settingsSession(() => refusal))).resolves.toMatchObject({ version: 140000, pid: 7 });
  });

  it('a thrown value that is not a server error ends the job, even one carrying a refusal code', async () => {
    const fn = Object.assign(() => undefined, { code: '42704', severity: 'ERROR' });
    await expect(jobSessionSettings(settingsSession(() => fn))).rejects.toBe(fn);
  });
});

describe('the COMMIT', () => {
  it("an error whose code is no SQLSTATE can't be confirmed and leaves the job interrupted at committing", async () => {
    seedFile(`${G}/mod/a.json`, '{}');
    const db = new FakeDb();
    db.fail = sql => (/^COMMIT/.test(sql) ? Object.assign(new Error('server closed the connection'), { code: 'x40001', severity: 'FATAL' }) : undefined);
    const service = serviceFor(db, new FakeHost());
    await service.post({ jobId: 'job-l5s1-commit-01', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ state: 'interrupted', stage: 'committing' });
    expect(readJson(JOURNAL)).toMatchObject({
      result: 'interrupted', stage: 'committing', error: "can't confirm whether the COMMIT landed: server closed the connection",
    });
  });
});

describe('the second read of a JSON source', () => {
  async function runWithChange(change: () => void): Promise<{ db: FakeDb; job: any }> {
    seedFile(`${G}/mod/a.json`, '{"a":1}');
    const db = new FakeDb();
    const service = serviceFor(db, new FakeHost(), { fault: point => { if (point === 'S7') change(); } });
    await service.post({ jobId: 'job-l5s1-reread-01', to: 'postgres' });
    await service.idle();
    return { db, job: service.status().body.job };
  }

  it('a document changed between the reads fails the job and nothing is switched', async () => {
    const { db, job } = await runWithChange(() => seedFile(`${G}/mod/a.json`, '{"a":2}'));
    expect(job).toMatchObject({ state: 'failed', stage: 'rereading', error: `The source read a second time differs from the source in 1 document(s): ${G}/mod/a.json` });
    expect(db.schemas.has('smdb_data')).toBe(false);
    expect(readJson(MARKER).live).toBe('file');
  });

  it('a document added between the reads fails the job and nothing is switched', async () => {
    const { db, job } = await runWithChange(() => seedFile(`${G}/mod/b.json`, '{}'));
    expect(job).toMatchObject({ state: 'failed', stage: 'rereading', error: `The source read a second time differs from the source in 1 document(s): ${G}/mod/b.json` });
    expect(db.schemas.has('smdb_data')).toBe(false);
    expect(readJson(MARKER).live).toBe('file');
    expect(fs.existsSync(`${process.env.DATA_DIR}/${G}/mod/a.json`)).toBe(true);
  });
});
