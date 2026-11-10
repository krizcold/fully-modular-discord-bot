import { describe, expect, it } from 'vitest';
import { countsAsOther, isJobSession } from '../../src/bot/internalSetup/utils/dataMigration';

// NB21 decisions 2 and 4: which backend on the database the session check counts, and which counted row is a
// migration's own session.

const JOB = 'job-nb21-rule-01';
const own = (app: string, kind: string | null = 'client backend') => ({ app, role: 'nb21_bot', own: true, kind });
const other = (app: string, kind: string | null = 'client backend', role = 'nb21_other') => ({ app, role, own: false, kind });

describe('countsAsOther', () => {
  it.each([
    ['an own client named other-bot', own('other-bot'), true],
    ['an own unnamed client', own(''), true],
    ['the own web UI reader', own('smdb-webui-reader'), false],
    ['the own panel listener', own('smdb-webui-listen'), false],
    ["the own job's session", own(`smdb-migrate:${JOB}`), false],
    ["an own session of another job", own('smdb-migrate:job-nb21-older'), true],
    ['an own walsender', own('', 'walsender'), true],
    ['an own logical replication worker', own('', 'logical replication worker'), true],
    ['an own pg_cron worker', own('pg_cron scheduler', 'pg_cron launcher'), true],
    ['an own walsender named as the reader', own('smdb-webui-reader', 'walsender'), true],
    ['an own parallel worker', own('other-bot', 'parallel worker'), false],
    ['an own row with a hidden kind', own('other-bot', null), true],
    ['an own reader with a hidden kind', own('smdb-webui-reader', null), true],
    ['a client of another role', other('psql'), true],
    ['a row of another role with a hidden kind', other('psql', null), true],
    ['a parallel worker of another role', other('psql', 'parallel worker'), false],
    ['another role named as the reader', other('smdb-webui-reader'), true],
    ['another role named as the listener', other('smdb-webui-listen'), true],
    ["another role named as the job's session", other(`smdb-migrate:${JOB}`), true],
    ['a session of a dropped role', other('psql', 'client backend', 'role 16384'), true],
  ])('%s: counts %s', (_name, row, counts) => {
    expect(countsAsOther(row, JOB)).toBe(counts);
  });
});

describe('isJobSession', () => {
  const app = `smdb-migrate:${JOB}`;
  it.each([
    ['an own client backend with the name', own(app), true],
    ['an own walsender with the name', own(app, 'walsender'), false],
    ['an own logical replication worker with the name', own(app, 'logical replication worker'), false],
    ['an own row with a hidden kind and the name', own(app, null), false],
    ["another role's client backend with the name", other(app), false],
    ['an own client backend of another job', own('smdb-migrate:job-nb21-older'), false],
  ])('%s: %s', (_name, row, is) => {
    expect(isJobSession(row, JOB)).toBe(is);
  });
});
