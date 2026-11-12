import fs from 'fs';
import path from 'path';
import { format } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCredentials } from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';
import { flushAll, saveDataTracked, setGuildWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, shaOf } from '../../src/bot/internalSetup/utils/sharedStore';
import type { ServiceOptions } from '../../src/bot/internalSetup/utils/dataMigration';
import { setBackendKind } from '../helpers/backendKind';
import { emptyStore, FakeDb, type Row } from '../helpers/fakePg';
import { FakeHost, JOURNAL, MARKER, PG_URL, freshJsonBot, readJson, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

const G1 = '880000000000000001';
const CFG = path.join(root, 'cfg', 'config.json');
const MODS = path.join(root, 'srcmods');
const CHANNEL = '990000000000000001';
const OTHER_CHANNEL = '990000000000000002';
const INSTALLED = { modules: { mod1: { name: 'mod1', version: '1.0.0', installedFrom: 'repo', installedAt: '2026-11-01T00:00:00.000Z' } } };
const SHARED_WAIT_TEXT = 'A change to the shared files is still being saved; run the migration once it ends';
const CHANNEL_WAIT_TEXT = 'An owner messages channel change is still being saved; run the migration once it ends';
const CHANNEL_DIFFERS = 'The owner messages channel in the copy differs from the source';
const CHANNEL_AGAIN_DIFFERS = 'The owner messages channel in the source read a second time differs from the source';

let lines: string[];

beforeEach(async () => {
  await flushAll();
  wipeRoot();
  setBackendKind(null);
  setGuildWriteGate(null);
  _resetRowQueue();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.DATA_BACKEND;
  delete process.env.FLEET_SHARD_COUNT;
  loadCredentials();
  lines = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { lines.push(format(...a)); });
});
afterEach(() => {
  vi.restoreAllMocks();
  setBackendKind(null);
  setGuildWriteGate(null);
  _resetRowQueue();
  delete process.env.DATA_BACKEND;
});

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function seedSource(): void {
  freshJsonBot();
  seedFile(`${G1}/m/a.json`, '{"g":1}');
  write(CFG, '{"prefix":"!"}');
  seedFile('global/m/a.json', '{"a":1}');
  seedFile('global/m/log.jsonl', '{"e":1}\n');
  seedFile('global/appstore/installed.json', JSON.stringify(INSTALLED));
  write(path.join(MODS, 'mod1', 'module.json'), '{"name":"mod1","version":"1.0.0"}');
  write(path.join(MODS, 'mod1', 'index.js'), 'module.exports = 1;');
}

type Tamper = (sql: string, rows: Row[]) => Row[];

/** A service whose job sessions pass each answer through tamper, so a test can stand in for a destination that answers otherwise. */
async function run(db: FakeDb, jobId: string, to: 'postgres' | 'file', extra: ServiceOptions = {}, host = new FakeHost(), tamper?: () => Tamper | null) {
  const connect = async (_url: string, app: string) => {
    const client = db.connect(app);
    const real = client.query.bind(client);
    client.query = async (text: string, params: any[] = []) => {
      const res = await real(text, params);
      const t = tamper?.();
      return t ? { ...res, rows: t(text.replace(/\s+/g, ' ').trim(), res.rows) } : res;
    };
    return client as any;
  };
  const service = serviceFor(db, host, { rootConfigPath: CFG, sourceModulesDir: MODS, ...(tamper ? { connect } : {}), ...extra });
  const answer = await service.post({ jobId, to });
  await service.idle();
  return { answer, job: service.status().body.job };
}

async function onPostgres(): Promise<FakeDb> {
  seedSource();
  const db = new FakeDb();
  const { job } = await run(db, 'job-ra51-src-01', 'postgres');
  expect(job, why(job)).toMatchObject({ state: 'done' });
  lines.length = 0;
  return db;
}

const stagingDir = () => {
  const names = fs.readdirSync(root).filter(n => n.startsWith('.migrate-'));
  expect(names).toHaveLength(1);
  return path.join(root, names[0]);
};

describe('S6 to Postgres: the shared rows read back in SQL are checked against their stored sha', () => {
  it('a shared doc whose stored sha does not match its bytes fails at verifying with that cause', async () => {
    seedSource();
    const db = new FakeDb();
    let armed = false;
    const { job } = await run(db, 'job-ra51-doc-01', 'postgres', { fault: p => { if (p === 'S6') armed = true; } }, new FakeHost(),
      () => (armed ? (sql, rows) => (/^SELECT key, sha, encode\(sha256\(body\)/.test(sql) ? rows.map(r => (r.key === 'global/m/a.json' ? { ...r, sha: 'f'.repeat(64) } : r)) : rows) : null));
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying' });
    expect(job.error).toBe('The shared files read back from the destination differ from the source (global/m/a.json: its stored sha does not match its bytes); nothing was switched');
    expect(db.schemas.has('smdb_data')).toBe(false);
    expect(readJson(MARKER)).toMatchObject({ live: 'file' });
  });

  it('a module whose stored sha does not match its files fails at verifying with the module files text', async () => {
    seedSource();
    const db = new FakeDb();
    let armed = false;
    const { job } = await run(db, 'job-ra51-mod-01', 'postgres', { fault: p => { if (p === 'S6') armed = true; } }, new FakeHost(),
      () => (armed ? (sql, rows) => (sql === 'SELECT module, sha FROM smdb_data.shared_modules' ? rows.map(r => ({ ...r, sha: 'e'.repeat(64) })) : rows) : null));
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying' });
    expect(job.error).toBe('The module files read back from the destination differ from the source (mod1: its stored sha does not match its files); nothing was switched');
    expect(db.schemas.has('smdb_data')).toBe(false);
    expect(readJson(MARKER)).toMatchObject({ live: 'file' });
  });

  it('an owner channel row read back with another channel fails at verifying', async () => {
    seedSource();
    seedFile('owner-channel.json', JSON.stringify({ channelId: CHANNEL }));
    const db = new FakeDb();
    let armed = false;
    const { job } = await run(db, 'job-ra51-och-01', 'postgres', { fault: p => { if (p === 'S6') armed = true; } }, new FakeHost(),
      () => (armed ? (sql, rows) => (/^SELECT value FROM smdb_data\.meta WHERE key = 'owner_channel'/.test(sql) ? [{ value: JSON.stringify(OTHER_CHANNEL) }] : rows) : null));
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying', error: CHANNEL_DIFFERS });
    expect(db.schemas.has('smdb_data')).toBe(false);
  });
});

describe('S6 to JSON: the staged copy is read back', () => {
  it('a staged shared file changed after the copy fails at verifying and nothing is placed', async () => {
    const db = await onPostgres();
    const { job } = await run(db, 'job-ra51-stg-01', 'file', {
      fault: p => { if (p === 'S6') fs.writeFileSync(path.join(stagingDir(), 'global', 'm', 'a.json'), '{"a":2}'); },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying' });
    expect(job.error).toBe('The shared files read back from the destination differ from the source (global/m/a.json: its bytes differ); nothing was switched');
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres' });
    expect(fs.readFileSync(dataPath('global', 'm', 'a.json'), 'utf8')).toBe('{"a":1}');
  });

  it('a staged owner channel file naming another channel fails at verifying', async () => {
    const db = await onPostgres();
    db.schemas.get('smdb_data')!.ownerChannel = JSON.stringify(CHANNEL);
    const { job } = await run(db, 'job-ra51-stg-02', 'file', {
      fault: p => { if (p === 'S6') fs.writeFileSync(path.join(stagingDir(), 'owner-channel.json'), JSON.stringify({ channelId: OTHER_CHANNEL })); },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'verifying', error: CHANNEL_DIFFERS });
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres' });
  });
});

describe('S7: the source read a second time', () => {
  it('an owner channel file unreadable both times, for another cause the second time, fails at rereading', async () => {
    seedSource();
    seedFile('owner-channel.json', 'not json');
    const db = new FakeDb();
    const { job } = await run(db, 'job-ra51-rr-01', 'postgres', {
      fault: p => { if (p === 'S7') fs.writeFileSync(dataPath('owner-channel.json'), JSON.stringify({ channelId: 'x' })); },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading', error: CHANNEL_AGAIN_DIFFERS });
    expect(db.schemas.has('smdb_data')).toBe(false);
    expect(readJson(MARKER)).toMatchObject({ live: 'file' });
  });

  it('a Postgres source whose shared doc changes before the second read fails at rereading naming the doc', async () => {
    const db = await onPostgres();
    const { job } = await run(db, 'job-ra51-rr-02', 'file', {
      fault: p => {
        if (p !== 'S7') return;
        const doc = db.schemas.get('smdb_data')!.docs!.find(d => d.key === 'global/m/a.json')!;
        doc.body = Buffer.from('{"a":9}');
        doc.sha = shaOf(Buffer.from('{"a":9}'));
      },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading' });
    expect(job.error).toBe('The source read a second time differs from the source in 1 document(s): global/m/a.json');
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres' });
    expect(fs.readFileSync(dataPath('global', 'm', 'a.json'), 'utf8')).toBe('{"a":1}');
  });

  it('a Postgres source whose owner channel changes before the second read fails at rereading', async () => {
    const db = await onPostgres();
    db.schemas.get('smdb_data')!.ownerChannel = JSON.stringify(CHANNEL);
    const { job } = await run(db, 'job-ra51-rr-03', 'file', {
      fault: p => { if (p === 'S7') db.schemas.get('smdb_data')!.ownerChannel = JSON.stringify(OTHER_CHANNEL); },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading', error: CHANNEL_AGAIN_DIFFERS });
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres' });
  });
});

describe('S2: a database this deployment never served', () => {
  const foreign = 'The database already holds store foreign in schema smdb_data (1 documents, 0 streams, 0 graveyard rows, 0 ownership rows), which this deployment never served';
  const sharedRowsFail = (db: FakeDb) => {
    db.fail = sql => (/AS shared_rows$/.test(sql) ? Object.assign(new Error('permission denied for table shared_docs'), { code: '42501' }) : undefined);
  };

  it('with guild rows the shared rows are not counted, so a refused count of them does not change the refusal', async () => {
    seedSource();
    const db = new FakeDb();
    db.schemas.set('smdb_data', { ...emptyStore('foreign'), data: [{ guild_id: G1, module: 'm', filename: 'a.json', doc: '{}' }] });
    sharedRowsFail(db);
    const { job } = await run(db, 'job-ra51-s2-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: foreign });
  });

  it('with no guild rows and no shared tables it is called droppable without counting shared rows', async () => {
    seedSource();
    const db = new FakeDb();
    db.schemas.set('smdb_data', { ...emptyStore('foreign'), noShared: true });
    const { job } = await run(db, 'job-ra51-s2-02', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(job.error).toBe('The database already holds store foreign in schema smdb_data (0 documents, 0 streams, 0 graveyard rows, 0 ownership rows), which this deployment never served; the schema holds no guild rows, so it can be dropped');
  });
});

describe('S3: the drain', () => {
  it('a queued guild write and a queued global write that cannot be written are named as writes, not guild writes', async () => {
    seedSource();
    const guild = dataPath(G1, 'm', 'stuck.json');
    const global = dataPath('global', 'm', 'stuck.json');
    const real = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(((p: any, ...rest: any[]) => {
      const s = String(p);
      if ((s.startsWith(`${guild}.`) || s.startsWith(`${global}.`)) && s.endsWith('.tmp')) {
        return Promise.reject(Object.assign(new Error('ENOSPC: injected flush failure'), { code: 'ENOSPC' }));
      }
      return (real as any)(p, ...rest);
    }) as typeof fs.promises.open);
    try {
      saveDataTracked('stuck.json', { guildId: G1, category: 'm' }, { s: 1 });
      saveDataTracked('stuck.json', { scope: 'global', category: 'm' }, { s: 1 });
      const db = new FakeDb();
      const { job } = await run(db, 'job-ra51-drain-01', 'postgres');
      expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'draining' });
      expect(job.error).toMatch(/^Writes of the web UI are still queued and could not be written: /);
      expect(job.error).toContain(guild);
      expect(job.error).toContain(global);
      expect(db.schemas.has('smdb_data')).toBe(false);
    } finally {
      vi.mocked(fs.promises.open).mockRestore();
      await flushAll();
    }
  });

  it('a JSON bot with no credentials file logs no move of it', async () => {
    seedSource();
    const { job } = await run(new FakeDb(), 'job-ra51-aside-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(lines.filter(l => l.startsWith('[Migration] Moved '))).toEqual([]);
  });

  async function frozenWait(jobId: string, host: FakeHost, extra: ServiceOptions, clear: () => void) {
    let timer: NodeJS.Timeout | undefined;
    const { job } = await run(new FakeDb(), jobId, 'postgres', {
      ...extra,
      fault: p => {
        if (p !== 'S3') return;
        const now = Date.now();
        const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
        timer = setTimeout(() => { clear(); spy.mockRestore(); }, 20);
      },
    }, host);
    if (timer) await new Promise(resolve => setTimeout(resolve, 30));
    return job;
  }

  it('a wait of 0 ms for the shared writes refuses at its first look, at the moment the wait ends', async () => {
    seedSource();
    const host = new FakeHost();
    host.sharedMark = true;
    const job = await frozenWait('job-ra51-wait-01', host, { sharedWaitMs: 0 }, () => { host.sharedMark = false; });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'draining', error: SHARED_WAIT_TEXT });
  });

  it('a wait of 0 ms for an owner channel write refuses at its first look, at the moment the wait ends', async () => {
    seedSource();
    const host = new FakeHost();
    host.ownerChannelMark = true;
    const job = await frozenWait('job-ra51-wait-02', host, { ownerChannelWaitMs: 0 }, () => { host.ownerChannelMark = false; });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'draining', error: CHANNEL_WAIT_TEXT });
  });
});

describe('S5 and S12: notes, closed tails and the done line', () => {
  it('a move with nothing to note keeps no notes in the journal', async () => {
    seedSource();
    const { job } = await run(new FakeDb(), 'job-ra51-notes-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(job.notes).toBeUndefined();
    expect(readJson(JOURNAL).notes).toBeUndefined();
  });

  it('a stream with no newline at its end is named in a warning', async () => {
    seedSource();
    seedFile(`${G1}/log.jsonl`, '{"e":1}');
    const { job } = await run(new FakeDb(), 'job-ra51-tail-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(lines).toContain(`[Migration] The stream log.jsonl of guild ${G1} did not end in a newline; it was copied with one added, so its last line stays a line of its own`);
  });

  it('two notes in the done line are separated by "; "', async () => {
    seedSource();
    seedFile('owner-channel.json', 'not json');
    seedFile('owner-messages.json', '[]');
    const { job } = await run(new FakeDb(), 'job-ra51-notes-02', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(job.notes).toHaveLength(2);
    const done = lines.filter(l => l.startsWith('[Migration] Migration job-ra51-notes-02 (--to postgres) is done'));
    expect(done).toHaveLength(1);
    expect(done[0].endsWith(`; ${job.notes[0]}; ${job.notes[1]}`)).toBe(true);
  });
});
