import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANSWER_BOUND_MS, PostgresBackend, type SharedStatement } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { type Answer, type Sent, scriptedBackend } from '../helpers/scriptedPg';

// A shared transaction's and the module fetch read's clients, their release and the outage they report, through the
// real PostgresBackend over scripted clients (NB6 C4, C6, D6).

const backends: PostgresBackend[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

function scripted(answer?: Answer) {
  const rigged = scriptedBackend(answer);
  backends.push(rigged.backend);
  return rigged;
}

function quiet() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

/** The errors the outage lines logged, in order. */
const outageErrors = (spy: ReturnType<typeof quiet>) =>
  spy.mock.calls.filter(call => /entering outage/.test(String(call[0]))).map(call => call[1]);

const serverError = (code: string, message = `server error ${code}`) => Object.assign(new Error(message), { code, severity: 'ERROR' });
const reset = (message: string) => Object.assign(new Error(message), { code: 'ECONNRESET' });

const valuesOf = (s: Sent): unknown[] => s.params ?? (typeof s.raw === 'string' ? [] : ((s.raw as { values?: unknown[] }).values ?? []));
const boundOf = (s: Sent) => (typeof s.raw === 'string' ? undefined : (s.raw as { query_timeout?: number }).query_timeout);
const releasesOf = (releases: Array<{ client: number; destroyed: boolean }>, client: number) => releases.filter(r => r.client === client);

const op = (id: string): SharedStatement => ({ text: 'INSERT INTO smdb_data.shared_ops (id) VALUES ($1)', values: [id] });
const CHECK = 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)';
const checkAtOnce: SharedStatement[] = [{ text: CHECK, values: [['u-1']] }];
const READ = 'SELECT bytes FROM smdb_data.shared_module_files WHERE module = $1';

describe('sharedTx: a COMMIT answered after this process stopped writing there', () => {
  it('answers unknown with the check it could not run as null, and gives its client back once', async () => {
    quiet();
    const holder = scripted(sql => {
      if (sql === 'COMMIT') holder.backend.latch({ kind: 'tie', generation: 4 });
      return undefined;
    });
    const outcome = await holder.backend.sharedTx({ check: null, statements: () => [op('u-1')], checkAtOnce });
    expect(outcome).toEqual({ kind: 'unknown', landedOn: expect.any(String), checked: null });
    expect(releasesOf(holder.releases, 1)).toHaveLength(1);
    expect(holder.connect).toHaveBeenCalledTimes(1);
  });

  it('after a move to another database, the check is not run there: checked is null', async () => {
    quiet();
    const holder = scripted(async (sql, _p, _c, client) => {
      if (sql === 'COMMIT' && client === 1) {
        holder.backend.latch({ kind: 'tie', generation: 4 });
        const moved = await holder.backend.useDatabase('postgres://nobody@127.0.0.1:9/other', {
          checkTarget: async () => null,
          claims: async () => true,
          settleRetires: async () => true,
          moved: () => undefined,
        });
        expect(moved).toBe(true);
        (holder.backend.getPool() as unknown as { connect: unknown }).connect = holder.connect;
      }
      if (sql.startsWith('SELECT id FROM smdb_data.shared_ops')) return { rows: [{ id: 'u-1' }], rowCount: 1 };
      return undefined;
    });
    const outcome = await holder.backend.sharedTx({ check: null, statements: () => [op('u-1')], checkAtOnce });
    expect(outcome).toMatchObject({ kind: 'unknown', checked: null });
    expect(holder.connect).toHaveBeenCalledTimes(1);
    expect(holder.sent.filter(s => s.client !== 1)).toEqual([]);
  });
});

describe('sharedTx: a COMMIT that failed', () => {
  it('answered with a serialization failure: rolled back and answered failed, never unknown', async () => {
    quiet();
    const { backend, sent, releases } = scripted(sql => (sql === 'COMMIT' ? serverError('40001') : undefined));
    const outcome = await backend.sharedTx({ check: null, statements: () => [op('op-1')] });
    expect(outcome).toMatchObject({ kind: 'failed', step: 'statements', code: '40001' });
    expect(sent.map(s => s.sql).slice(-2)).toEqual(['COMMIT', 'ROLLBACK']);
    expect(releases).toEqual([{ client: 1, destroyed: true }]);
  });

  it('cancelled by the server (57014): unknown, and the client is destroyed once', async () => {
    quiet();
    const { backend, releases } = scripted(sql => (sql === 'COMMIT' ? serverError('57014', 'canceling statement due to user request') : undefined));
    const outcome = await backend.sharedTx({ check: null, statements: () => [op('op-1')] });
    expect(outcome).toMatchObject({ kind: 'unknown', code: '57014' });
    expect(releases).toEqual([{ client: 1, destroyed: true }]);
  });

  it('its answer lost: unknown, the client destroyed once, and the outage logged with that error', async () => {
    const errors = quiet();
    const lost = reset('commit reset');
    const { backend, releases } = scripted(sql => (sql === 'COMMIT' ? lost : undefined));
    const outcome = await backend.sharedTx({ check: null, statements: () => [op('op-1')] });
    expect(outcome).toMatchObject({ kind: 'unknown', detail: 'commit reset' });
    expect(releases).toEqual([{ client: 1, destroyed: true }]);
    const logged = outageErrors(errors);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toBe(lost);
  });
});

describe('sharedTx: a statement that failed', () => {
  it('answered with an error: rolled back, answered failed, and the client destroyed', async () => {
    quiet();
    const { backend, sent, releases } = scripted(sql => (sql.startsWith('INSERT') ? serverError('23505') : undefined));
    const outcome = await backend.sharedTx({ check: null, statements: () => [op('op-1')] });
    expect(outcome).toMatchObject({ kind: 'failed', step: 'statements', code: '23505' });
    expect(sent.map(s => s.sql).slice(-1)).toEqual(['ROLLBACK']);
    expect(releases).toEqual([{ client: 1, destroyed: true }]);
  });

  it('with no answer: failed, nothing more sent, and the outage logged with that error', async () => {
    const errors = quiet();
    const lost = reset('insert reset');
    const { backend, sent, releases } = scripted(sql => (sql.startsWith('INSERT') ? lost : undefined));
    const outcome = await backend.sharedTx({ check: null, statements: () => [op('op-1')] });
    expect(outcome).toMatchObject({ kind: 'failed', step: 'statements', detail: 'insert reset' });
    expect(sent.map(s => s.sql).slice(-1)).toEqual([op('op-1').text]);
    expect(releases).toEqual([{ client: 1, destroyed: true }]);
    const logged = outageErrors(errors);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toBe(lost);
  });

  it('cancelled before its server bound, hours into the process: not at the bound', async () => {
    quiet();
    let now = 3 * 3_600_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { backend } = scripted(sql => {
      if (!sql.startsWith('INSERT')) return undefined;
      now += 500;
      return serverError('57014', 'canceling statement due to statement timeout');
    });
    const outcome = await backend.sharedTx({ check: null, statements: () => [op('op-1')] });
    expect(outcome).toMatchObject({ kind: 'failed', code: '57014', timeout: { elapsedMs: 500, atBound: false } });
  });
});

describe("sharedTx: a publish's landing check at once after a lost COMMIT", () => {
  it('runs on a second client under the 40 s answer bound, with no values on BEGIN, and gives that client back', async () => {
    quiet();
    const { backend, sent, releases } = scripted((sql, _p, _c, client) => {
      if (sql === 'COMMIT' && client === 1) return reset('commit reset');
      if (sql === CHECK) return { rows: [{ id: 'u-1' }], rowCount: 1 };
      return undefined;
    });
    const outcome = await backend.sharedTx({ check: null, statements: () => [op('u-1')], checkAtOnce });
    expect(outcome).toMatchObject({ kind: 'unknown', checked: [{ rows: [{ id: 'u-1' }] }] });
    const second = sent.filter(s => s.client === 2);
    expect(second.map(s => s.sql)).toEqual(['BEGIN; SET LOCAL statement_timeout = 30000', CHECK, 'ROLLBACK']);
    expect(second.map(valuesOf)).toEqual([[], [['u-1']], []]);
    for (const s of second.slice(0, 2)) {
      expect(boundOf(s)).toBeGreaterThanOrEqual(ANSWER_BOUND_MS - 5_000);
      expect(boundOf(s)).toBeLessThanOrEqual(ANSWER_BOUND_MS);
    }
    expect(releasesOf(releases, 2)).toEqual([{ client: 2, destroyed: false }]);
  });

  it('a check answered with an error: checked null and the second client destroyed', async () => {
    quiet();
    const { backend, releases } = scripted((sql, _p, _c, client) => {
      if (sql === 'COMMIT' && client === 1) return reset('commit reset');
      if (sql === CHECK) return serverError('42P01');
      return undefined;
    });
    const outcome = await backend.sharedTx({ check: null, statements: () => [op('u-1')], checkAtOnce });
    expect(outcome).toMatchObject({ kind: 'unknown', checked: null });
    expect(releasesOf(releases, 2)).toEqual([{ client: 2, destroyed: true }]);
  });

  it("a check with no answer: the outage is logged with the check's error, the first one seen", async () => {
    const errors = quiet();
    const checkLost = reset('check reset');
    const { backend } = scripted((sql, _p, _c, client) => {
      if (sql === 'COMMIT' && client === 1) return reset('commit reset');
      if (sql === CHECK) return checkLost;
      return undefined;
    });
    const outcome = await backend.sharedTx({ check: null, statements: () => [op('u-1')], checkAtOnce });
    expect(outcome).toMatchObject({ kind: 'unknown', detail: 'commit reset', checked: null });
    const logged = outageErrors(errors);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toBe(checkLost);
  });

  it("a check whose client could not connect: the outage is logged with the connect error, the first one seen", async () => {
    const errors = quiet();
    const refused = new Error('connect ECONNREFUSED 127.0.0.1:9');
    const { backend, connect } = scripted(sql => (sql === 'COMMIT' ? reset('commit reset') : undefined));
    let connects = 0;
    (backend.getPool() as unknown as { connect: unknown }).connect = async () => {
      connects += 1;
      if (connects === 2) throw refused;
      return connect();
    };
    const outcome = await backend.sharedTx({ check: null, statements: () => [op('u-1')], checkAtOnce });
    expect(outcome).toMatchObject({ kind: 'unknown', detail: 'commit reset', checked: null });
    expect(connects).toBe(2);
    const logged = outageErrors(errors);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toBe(refused);
  });
});

describe("sharedRead: the module fetch's read", () => {
  it('sends BEGIN and ROLLBACK with no values and gives its client back', async () => {
    quiet();
    const { backend, sent, releases } = scripted(sql => (sql === READ ? { rows: [{ bytes: 'b' }], rowCount: 1 } : undefined));
    expect(await backend.sharedRead(READ, ['mod'])).toEqual({ kind: 'read', rows: [{ bytes: 'b' }] });
    expect(sent.map(s => s.sql.split(';')[0])).toEqual(['BEGIN READ ONLY', READ, 'ROLLBACK']);
    expect(sent.map(valuesOf)).toEqual([[], ['mod'], []]);
    expect(releases).toEqual([{ client: 1, destroyed: false }]);
  });

  it('a ROLLBACK answered with an error: the rows are answered and the client destroyed', async () => {
    quiet();
    const { backend, releases } = scripted(sql => {
      if (sql === READ) return { rows: [{ bytes: 'b' }], rowCount: 1 };
      if (sql === 'ROLLBACK') return serverError('25P01');
      return undefined;
    });
    expect(await backend.sharedRead(READ, ['mod'])).toEqual({ kind: 'read', rows: [{ bytes: 'b' }] });
    expect(releases).toEqual([{ client: 1, destroyed: true }]);
  });

  it('a ROLLBACK with no answer: the rows are answered and the outage logged with that error', async () => {
    const errors = quiet();
    const lost = reset('rollback reset');
    const { backend, releases } = scripted(sql => {
      if (sql === READ) return { rows: [], rowCount: 0 };
      if (sql === 'ROLLBACK') return lost;
      return undefined;
    });
    expect(await backend.sharedRead(READ, ['mod'])).toEqual({ kind: 'read', rows: [] });
    expect(releases).toEqual([{ client: 1, destroyed: true }]);
    const logged = outageErrors(errors);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toBe(lost);
  });

  it('a SELECT answered with an error: failed, rolled back, and the client destroyed', async () => {
    quiet();
    const { backend, sent, releases } = scripted(sql => (sql === READ ? serverError('42P01') : undefined));
    expect(await backend.sharedRead(READ, ['mod'])).toMatchObject({ kind: 'failed', step: 'statements', code: '42P01' });
    expect(sent.map(s => s.sql).slice(-1)).toEqual(['ROLLBACK']);
    expect(releases).toEqual([{ client: 1, destroyed: true }]);
  });

  it('a client that could not connect: failed at connect and the outage logged with that error', async () => {
    const errors = quiet();
    const refused = new Error('connect ECONNREFUSED 127.0.0.1:9');
    const { backend } = scripted();
    (backend.getPool() as unknown as { connect: unknown }).connect = async () => { throw refused; };
    expect(await backend.sharedRead(READ, ['mod'])).toMatchObject({ kind: 'failed', step: 'connect', detail: refused.message });
    const logged = outageErrors(errors);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toBe(refused);
  });
});
