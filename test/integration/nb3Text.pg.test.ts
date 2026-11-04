import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openJobSession, type PgSession } from '../../src/bot/internalSetup/utils/dataMigration';
import { jsonBot, realService, resetDatabase, schemas, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, seedFile, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

// NB3 decision 9: bytes are copied as they are.

let rig: PgRig;
const G = '242424242424242424';

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

async function run(url?: string) {
  const service = realService(new FakeHost());
  await service.post({ jobId: 'job-text-0001', to: 'postgres', ...(url ? { url } : {}) });
  await service.idle();
  return service.status().body.job;
}

describe('text', () => {
  it('invalid UTF-8 content refuses at reading, naming the file, before any statement to the destination', async () => {
    jsonBot();
    seedFile('100000000000000001/m/ok.json', '{}');
    seedFile(`${G}/m/bad.json`, Buffer.from([0x7b, 0xff, 0x7d]));
    const sent: string[] = [];
    const connect = async (url: string, app: string, kind: 'job' | 'probe'): Promise<PgSession> => {
      const session = await openJobSession(url, app, kind, 2000);
      const query = session.query.bind(session) as (...args: any[]) => any;
      (session as any).query = (text: any, ...rest: any[]) => { sent.push(typeof text === 'string' ? text : String(text?.text)); return query(text, ...rest); };
      return session;
    };
    const service = realService(new FakeHost(), { connect });
    await service.post({ jobId: 'job-text-0001', to: 'postgres' });
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading' });
    expect(job?.error, why(job)).toContain('bad.json');
    expect(sent.filter(q => /CREATE|INSERT|ALTER|pg_advisory_xact_lock/i.test(q))).toEqual([]);
    expect(await schemas(rig)).toEqual([]);
  });

  it('a BOM and CRLF survive', async () => {
    jsonBot();
    seedFile(`${G}/m/bom.json`, '﻿{"a":1}\r\n');
    const job = await run();
    expect(job?.state, why(job)).toBe('done');
    const { rows } = await rig.admin.query(`SELECT encode(convert_to(doc, 'UTF8'), 'hex') AS hex FROM smdb_data.guild_data`);
    expect(rows[0].hex).toBe(Buffer.from('﻿{"a":1}\r\n', 'utf8').toString('hex'));
  });

  it('U+0000 refuses on a move to Postgres', async () => {
    jsonBot();
    seedFile(`${G}/m/nul.json`, '{"a":"\u0000"}');
    const job = await run();
    expect(job?.state, why(job)).toBe('failed');
    expect(job?.error, why(job)).toMatch(/U\+0000/);
  });

  it('a database whose server_encoding is not UTF8 refuses', async () => {
    await rig.admin.query(`CREATE DATABASE latin TEMPLATE template0 ENCODING 'LATIN1' LC_COLLATE 'C' LC_CTYPE 'C'`).catch(() => undefined);
    jsonBot();
    seedFile(`${G}/m/a.json`, '{}');
    const u = new URL(rig.url);
    u.pathname = '/latin';
    useDatabaseUrl(u.toString());
    const job = await run();
    expect(job?.state, why(job)).toBe('failed');
    expect(job?.error, why(job)).toMatch(/UTF8/);
  });
});
