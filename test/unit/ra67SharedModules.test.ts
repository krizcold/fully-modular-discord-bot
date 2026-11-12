import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import type { QueryResult } from 'pg';
import type { SharedReadOutcome, SharedStatement, SharedTxOutcome, SharedTxSpec } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { credentialsKeyOf, fetchModule, INSTALLED_KEY, moduleShaOf, publishModule, unpublishModule } from '../../src/bot/internalSetup/utils/sharedModules';
import { CHECKED_SQL, configureRowFlush, DELETE_SQL, deposeRows, NOTIFY_SQL, OP_SQL, reopenRows, UPSERT_SQL, type RowBackend } from '../../src/bot/internalSetup/utils/sharedStore';

const dirs: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  reopenRows();
  configureRowFlush({ backend: () => null });
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra67-'));
  dirs.push(dir);
  return dir;
}

function folder(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

const result = (rows: any[]): QueryResult => ({ rows, rowCount: rows.length, command: '', oid: 0, fields: [] });

function fakeBackend(answer: (st: SharedStatement) => any[]) {
  const sent: SharedStatement[] = [];
  let calls = 0;
  const backend: RowBackend = {
    async sharedTx<S>(spec: SharedTxSpec<S>): Promise<SharedTxOutcome<S>> {
      calls++;
      const built = spec.statements(null);
      if (built === 'landed') return { kind: 'landed' };
      if (!Array.isArray(built)) return { kind: 'stopped', value: built.stop };
      const run = (list: SharedStatement<S>[]): { stop: S } | undefined => {
        for (const st of list) {
          sent.push(st as SharedStatement);
          const next = st.next?.(result(answer(st as SharedStatement)));
          if (!next) continue;
          if (!Array.isArray(next)) return next;
          const stop = run(next);
          if (stop) return stop;
        }
        return undefined;
      };
      const stop = run(built);
      return stop ? { kind: 'stopped', value: stop.stop } : { kind: 'committed', results: [] };
    },
  };
  configureRowFlush({ backend: () => backend });
  return { sent, calls: () => calls };
}

const notices = (sent: SharedStatement[]) => sent.filter(s => s.text === NOTIFY_SQL).map(s => JSON.parse(String(s.values[0])));

const afterOp = (sent: SharedStatement[]) => sent.slice(sent.findIndex(s => s.text === OP_SQL) + 1);

describe('a deposed process', () => {
  it('refuses an uninstall writer-lost without opening a transaction', async () => {
    const { calls } = fakeBackend(() => []);
    deposeRows('another process');
    expect(await unpublishModule('m', '{}', 'absent')).toEqual({ kind: 'refused', cause: 'writer-lost' });
    expect(calls()).toBe(0);
  });

  it('refuses a publish writer-lost before it reads the folder', async () => {
    const { calls } = fakeBackend(() => []);
    deposeRows('another process');
    const missing = path.join(tempDir(), 'gone');
    expect(await publishModule('m', missing, '{}', 'absent', { operation: 'install' })).toEqual({ kind: 'refused', cause: 'writer-lost' });
    expect(calls()).toBe(0);
  });
});

describe('a publish whose folder cannot be read', () => {
  it('fails naming the folder and the read error', async () => {
    fakeBackend(() => []);
    const missing = path.join(tempDir(), 'gone');
    const answer = await publishModule('m', missing, '{}', 'absent', { operation: 'install' });
    expect(answer.kind).toBe('failed');
    const cause = (answer as { cause: string }).cause;
    expect(cause.startsWith(`could not read ${missing} (`)).toBe(true);
    expect(cause).toMatch(/ENOENT/);
    expect(cause.endsWith(')')).toBe(true);
  });
});

describe('a COMMIT answer lost with no detail and no landing answer', () => {
  it('ends unknown with the cause "no answer"', async () => {
    const backend: RowBackend = {
      async sharedTx<S>(): Promise<SharedTxOutcome<S>> {
        return { kind: 'unknown', checked: null };
      },
    };
    configureRowFlush({ backend: () => backend });
    expect(await unpublishModule('m', '{}', 'absent')).toEqual({ kind: 'unknown', cause: 'no answer' });
  });
});

describe('the notifications of a publish', () => {
  it('carry the module row rev and the installed.json rev the database returned', async () => {
    const { sent } = fakeBackend(st => {
      if (st.text === CHECKED_SQL) return [];
      if (st.text.startsWith('INSERT INTO smdb_data.shared_modules')) return [{ rev: 11 }];
      if (st.text === UPSERT_SQL) return [{ rev: 12 }];
      return [];
    });
    const answer = await publishModule('m', folder({ 'index.js': '1' }), '{}', 'absent', { operation: 'install' });
    expect(answer.kind).toBe('committed');
    const got = notices(sent);
    expect(got.map(n => [n.k, n.rev])).toEqual([['module', 11], ['doc', 12]]);
    expect(got[1].key).toBe(INSTALLED_KEY);
  });

  it('commits with rev 0 in the module notification when the upsert returns no row', async () => {
    const { sent } = fakeBackend(st => (st.text === UPSERT_SQL ? [{ rev: 5 }] : []));
    const answer = await publishModule('m', folder({ 'index.js': '1' }), '{}', 'absent', { operation: 'install' });
    expect(answer.kind).toBe('committed');
    expect(notices(sent).map(n => [n.k, n.rev])).toEqual([['module', 0], ['doc', 5]]);
  });
});

describe('the notifications of an uninstall', () => {
  it('names every deleted row and installed.json with the revs returned', async () => {
    const credentials = credentialsKeyOf('m');
    const { sent } = fakeBackend(st => {
      if (st.text.startsWith('DELETE FROM smdb_data.shared_modules')) return [{ rev: 21 }];
      if (st.text === DELETE_SQL) return [{ rev: 22 }];
      if (st.text === UPSERT_SQL) return [{ rev: 23 }];
      return [];
    });
    const answer = await unpublishModule('m', '{}', 'absent');
    expect(answer.kind).toBe('committed');
    expect(notices(sent)).toEqual([
      expect.objectContaining({ k: 'module', module: 'm', sha: 'absent', rev: 21 }),
      expect.objectContaining({ k: 'doc', key: credentials, sha: 'absent', rev: 22 }),
      expect.objectContaining({ k: 'doc', key: INSTALLED_KEY, rev: 23 }),
    ]);
  });

  it('sends only the installed.json notification when no module or credentials row existed', async () => {
    const { sent } = fakeBackend(st => (st.text === UPSERT_SQL ? [{ rev: 31 }] : []));
    const answer = await unpublishModule('m', '{}', 'absent');
    expect(answer.kind).toBe('committed');
    const tail = afterOp(sent);
    expect(tail).toHaveLength(1);
    expect(tail[0].text).toBe(NOTIFY_SQL);
    expect(JSON.parse(String(tail[0].values[0]))).toMatchObject({ k: 'doc', key: INSTALLED_KEY, rev: 31 });
  });

  it('notifies the credentials doc and not the module when only the credentials row existed', async () => {
    const { sent } = fakeBackend(st => (st.text === DELETE_SQL ? [{ rev: 41 }] : st.text === UPSERT_SQL ? [{ rev: 42 }] : []));
    await unpublishModule('m', '{}', 'absent');
    const tail = afterOp(sent);
    expect(tail.every(s => s.text === NOTIFY_SQL)).toBe(true);
    expect(notices(sent).map(n => [n.k, n.key ?? n.module, n.rev])).toEqual([['doc', credentialsKeyOf('m'), 41], ['doc', INSTALLED_KEY, 42]]);
  });

  it('notifies the module and not the credentials doc when only the module row existed', async () => {
    const { sent } = fakeBackend(st => (st.text.startsWith('DELETE FROM smdb_data.shared_modules') ? [{ rev: 51 }] : st.text === UPSERT_SQL ? [{ rev: 52 }] : []));
    await unpublishModule('m', '{}', 'absent');
    const tail = afterOp(sent);
    expect(tail.every(s => s.text === NOTIFY_SQL)).toBe(true);
    expect(notices(sent).map(n => [n.k, n.key ?? n.module, n.rev])).toEqual([['module', 'm', 51], ['doc', INSTALLED_KEY, 52]]);
  });
});

function readBackend(files: Array<{ rel: string; body: string }>) {
  const backend: RowBackend = {
    async sharedTx<S>(): Promise<SharedTxOutcome<S>> {
      throw new Error('no transaction in a fetch');
    },
    async sharedRead(text: string, values: unknown[]): Promise<SharedReadOutcome> {
      if (text.includes('octet_length')) return { kind: 'read', rows: files.map(f => ({ rel: f.rel, mode: 0o644, size: Buffer.byteLength(f.body) })) };
      const asked = values[1] as string[];
      return { kind: 'read', rows: files.filter(f => asked.includes(f.rel)).map(f => ({ rel: f.rel, bytes: Buffer.from(f.body) })) };
    },
  };
  configureRowFlush({ backend: () => backend });
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('a fetch of a file path that would not stay a plain path in the folder', () => {
  for (const rel of ['a//b.js', '/b.js', 'a/./b.js', './b.js', 'a/../b.js', 'a/b\0c.js']) {
    it(`refuses ${JSON.stringify(rel)} and writes nothing`, async () => {
      readBackend([{ rel: 'ok.js', body: 'fine' }, { rel, body: 'x' }]);
      const into = path.join(tempDir(), 'out');
      expect(await fetchModule('m', into)).toEqual({ ok: false, cause: `the database holds a file path that leaves m's folder: ${rel}` });
      expect(fs.existsSync(into)).toBe(false);
    });
  }

  it('refuses a backslash part on Windows', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    readBackend([{ rel: 'a\\b.js', body: 'x' }]);
    const into = path.join(tempDir(), 'out');
    expect(await fetchModule('m', into)).toEqual({ ok: false, cause: "the database holds a file path that leaves m's folder: a\\b.js" });
    expect(fs.existsSync(into)).toBe(false);
  });

  it('refuses a colon part on Windows', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    readBackend([{ rel: 'a:b.js', body: 'x' }]);
    const into = path.join(tempDir(), 'out');
    expect(await fetchModule('m', into)).toEqual({ ok: false, cause: "the database holds a file path that leaves m's folder: a:b.js" });
    expect(fs.existsSync(into)).toBe(false);
  });

  it('writes a backslash part elsewhere than Windows', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    readBackend([{ rel: 'a\\b.js', body: 'xyz' }]);
    const into = path.join(tempDir(), 'out');
    const answer = await fetchModule('m', into);
    Object.defineProperty(process, 'platform', platform);
    expect(answer).toEqual({ ok: true, sha: moduleShaOf([{ rel: 'a\\b.js', sha: sha256('xyz') }]), files: 1, bytes: 3 });
    expect(fs.readFileSync(path.resolve(into, 'a\\b.js'), 'utf8')).toBe('xyz');
  });

  it('writes a file whose parts are all plain', async () => {
    readBackend([{ rel: 'lib/a.b.js', body: 'ab' }]);
    const into = path.join(tempDir(), 'out');
    expect(await fetchModule('m', into)).toEqual({ ok: true, sha: moduleShaOf([{ rel: 'lib/a.b.js', sha: sha256('ab') }]), files: 1, bytes: 2 });
    expect(fs.readFileSync(path.join(into, 'lib', 'a.b.js'), 'utf8')).toBe('ab');
  });
});
