import fs from 'fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addToStoreList, deriveStatus, isAddressList, normalizeAddress, readStoreList, sameAddress, snapshotCounts, snapshotHashes,
  type Snapshot,
} from '../../src/bot/internalSetup/utils/dataMigration';
import { STORES, wipeRoot } from '../helpers/migrationRig';

// NB3: the status read, the address rules, the store list and the snapshot hashes and counts, as their answers show them.

const JOB = 'job-l5s1-0001';
const journal = (j: object) => ({ jobId: JOB, to: 'postgres', stage: 'copying', startedAt: 1, ...j }) as any;
const facts = (j: any, marker: object | null = null) => ({ ok: true, journal: j, marker, storesExist: false }) as any;
const status = (j: any, marker: object | null = null, managed = false, running: { jobId: string } | null = null) =>
  deriveStatus(facts(j, marker), { running, managed });

beforeEach(() => {
  wipeRoot();
});

describe('the status read', () => {
  it('reports running only for the job this process runs, as a successful answer', () => {
    const j = journal({});
    expect(status(j, null, false, { jobId: JOB }).body).toMatchObject({ success: true, job: { state: 'running' } });
    expect(status(j, null, false, { jobId: 'job-other-0001' }).body.job.state).toBe('interrupted');
  });

  it('answers success for a done result', () => {
    expect(status(journal({ result: 'done', stage: 'env' })).body).toMatchObject({ success: true, job: { state: 'done' } });
  });

  it('answers success for a matching marker: interrupted at env without the env, done when managed', () => {
    const j = journal({ stage: 'switching', storeId: 's' });
    const marker = { live: 'postgres', migration: JOB, storeId: 's', flippedAt: 1 };
    expect(status(j, marker).body).toEqual({
      success: true,
      job: expect.objectContaining({ state: 'interrupted', stage: 'env', error: 'The switch is made; run the migration again to finish the env' }),
    });
    expect(status(j, marker, true).body).toMatchObject({ success: true, job: { state: 'done' } });
  });

  it('answers success for a failed result and for a job stopped at its first checks', () => {
    expect(status(journal({ result: 'failed', error: 'boom' })).body).toMatchObject({ success: true, job: { state: 'failed', error: 'boom' } });
    expect(status(journal({ stage: 'checking' })).body).toMatchObject({
      success: true, job: { state: 'failed', stage: 'checking', error: 'The job stopped at its first checks; nothing was changed' },
    });
  });

  it('names what an interrupted job left: the old store before the switch, a rerun at the switch and the env', () => {
    expect(status(journal({ stage: 'copying' })).body).toMatchObject({
      success: true, job: { state: 'interrupted', error: 'The job stopped before it finished; the old store still serves' },
    });
    const rerun = 'The job stopped before it finished; run the migration again to finish it';
    expect(status(journal({ stage: 'switching' }), null, true).body.job).toMatchObject({ state: 'interrupted', stage: 'switching', error: rerun });
    expect(status(journal({ stage: 'env' }), null, true).body.job).toMatchObject({ state: 'interrupted', stage: 'env', error: rerun });
  });

  it('a marker that names the job but another backend is not a finished switch', () => {
    const j = journal({ stage: 'switching', storeId: 's' });
    expect(status(j, { live: 'file', migration: JOB, storeId: 's', flippedAt: 1 }, true).body.job.state).toBe('interrupted');
  });

  it('a marker with another store id than the journal is not a finished switch to Postgres', () => {
    const j = journal({ stage: 'switching', storeId: 's' });
    expect(status(j, { live: 'postgres', migration: JOB, storeId: 'other', flippedAt: 1 }, true).body.job.state).toBe('interrupted');
  });

  it('a move to JSON is finished when the marker names the job with no store id, whatever source store the journal names', () => {
    const j = journal({ to: 'file', stage: 'switching', storeId: 'src-1' });
    expect(status(j, { live: 'file', migration: JOB, storeId: null, flippedAt: 1 }, true).body.job.state).toBe('done');
  });

  it('shows the destination only for a move to Postgres', () => {
    const destination = { host: 'db.example', port: 5432, database: 'smdb' };
    expect(status(journal({ destination })).body.job.destination).toEqual(destination);
    expect('destination' in status(journal({ to: 'file', destination })).body.job).toBe(false);
  });

  it('shows envSwitched only when the journal holds it', () => {
    expect('envSwitched' in status(journal({})).body.job).toBe(false);
    expect(status(journal({ envSwitched: false })).body.job.envSwitched).toBe(false);
  });
});

describe('the address rules', () => {
  it('spaces around one address do not make a list', () => {
    expect(isAddressList('postgres://bot@db.example:5432/smdb  ')).toBe(false);
    expect(isAddressList('  postgres://bot@db.example:5432/smdb')).toBe(false);
    expect(isAddressList('postgres://a/x postgres://b/x')).toBe(true);
  });

  it('the database name loses its leading and trailing slashes only', () => {
    expect(normalizeAddress('postgres://h//db').database).toBe('db');
    expect(normalizeAddress('postgres://h/db//').database).toBe('db');
    expect(normalizeAddress('postgres://h/db/').database).toBe('db');
    expect(normalizeAddress('postgres://h/a/b').database).toBe('a/b');
    expect(normalizeAddress('postgres:a/b').database).toBe('a/b');
  });

  it('two addresses are the same only with the same port and database', () => {
    const a = { host: 'h', port: 6000, database: 'db' };
    expect(sameAddress(a, { ...a })).toBe(true);
    expect(sameAddress(a, { ...a, port: 6001 })).toBe(false);
    expect(sameAddress(a, { ...a, database: 'other' })).toBe(false);
  });

  it('a trailing slash run on either side does not change the database; an inner slash does', () => {
    const a = { host: 'h', port: 5432, database: 'db' };
    expect(sameAddress({ ...a, database: 'db//' }, a)).toBe(true);
    expect(sameAddress(a, { ...a, database: 'db//' })).toBe(true);
    expect(sameAddress({ ...a, database: 'db/' }, a)).toBe(true);
    expect(sameAddress(a, { ...a, database: 'db/' })).toBe(true);
    expect(sameAddress({ ...a, database: 'a/b' }, { ...a, database: 'a/b' })).toBe(true);
  });
});

describe('the store list', () => {
  it('an unreadable list is named in the error', () => {
    fs.mkdirSync(STORES);
    expect(() => readStoreList()).toThrow(/\.stores\.json cannot be read: /);
    expect(() => addToStoreList('a')).toThrow(/\.stores\.json cannot be read: /);
  });

  it('a list that does not hold only strings is refused and named', () => {
    for (const value of [{ storeIds: 'x' }, { storeIds: ['a', 1] }, { storeIds: [1] }, {}]) {
      fs.writeFileSync(STORES, JSON.stringify(value));
      expect(() => readStoreList(), JSON.stringify(value)).toThrow(/\.stores\.json does not hold a list of store ids$/);
    }
  });
});

const buf = (s: string) => Buffer.from(s, 'utf8');

describe('the snapshot hashes and counts', () => {
  const snap = (): Snapshot => ({
    items: [
      { guildId: '1', grave: false, module: 'm', filename: 'f.json', kind: 'doc', bytes: buf('a') },
      { guildId: '1', grave: true, retiredAt: 5, module: 'm', filename: 'f.json', kind: 'doc', bytes: buf('b') },
      { guildId: '2', grave: true, retiredAt: 5, module: 'm', filename: 'f.json', kind: 'doc', bytes: buf('c') },
    ],
    graves: [], guilds: ['1'], leftOut: [],
    shadow: [
      { guildId: '1', module: 'M', filename: 'f.json', bytes: buf('d') },
      { guildId: '1', retiredAt: 5, module: 'M', filename: 'f.json', bytes: buf('e') },
      { guildId: '1', retiredAt: 6, module: 'M', filename: 'f.json', bytes: buf('f') },
    ],
  });

  it('every graveyard document of every guild gets its own hash', () => {
    expect(snapshotHashes(snap(), false).size).toBe(3);
  });

  it('shadow rows count by default and when asked, and every graveyard entry keeps its own', () => {
    expect(snapshotHashes(snap()).size).toBe(6);
    expect(snapshotHashes(snap(), true).size).toBe(6);
    expect(new Set(snapshotHashes(snap(), true).values()).size).toBe(6);
  });

  it('counts live documents and streams apart from the graveyard, and every byte', () => {
    const s: Snapshot = {
      items: [
        { guildId: '1', grave: false, module: 'm', filename: 'a.json', kind: 'doc', bytes: buf('123') },
        { guildId: '1', grave: false, module: 'm', filename: 'a.jsonl', kind: 'append', bytes: buf('12345') },
        { guildId: '1', grave: false, module: 'm', filename: 'b.jsonl', kind: 'append', bytes: buf('1') },
        { guildId: '1', grave: true, retiredAt: 5, module: 'm', filename: 'a.json', kind: 'doc', bytes: buf('1234567') },
        { guildId: '1', grave: true, retiredAt: 5, module: 'm', filename: 'b.json', kind: 'doc', bytes: buf('12') },
        { guildId: '1', grave: true, retiredAt: 5, module: 'm', filename: 'c.jsonl', kind: 'append', bytes: buf('1234') },
      ],
      graves: [{ guildId: '1', retiredAt: 5, reason: 'left' }], guilds: ['1'], leftOut: [], shadow: [],
    };
    expect(snapshotCounts(s)).toEqual({ documents: 1, appendFiles: 2, graveyardEntries: 1, bytes: 22 });
  });
});
