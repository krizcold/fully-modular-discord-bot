import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { type Answer, batchExistsAnswer, isBatch, isBatchExists, isBegin, isFenced, isGraveInsert, isLive, isMove, isOwnerInsert, isOwnerRead, scriptedPg } from '../helpers/nb11ScriptedPg';

// NB11 tests 3 (wip-redesign/sheets/NB11.md, decisions 5 to 10 and 20): the restore's and the retire's transactions
// over a scripted client that keeps pg's single active query. After a statement that timed out, a statement queued
// behind it is never sent and its promise never settles until the client is released with true.

const SECOND = 1000;
const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 };
const backends: PostgresBackend[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'hrtime', 'performance', 'Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

const sqlState = (code: string, message = 'scripted') => Object.assign(new Error(message), { code, severity: code.startsWith('57P') ? 'FATAL' : 'ERROR' });
const brokenConnection = () => new Error('Connection terminated unexpectedly');
const sessionEnded = (severity: 'PANIC' | 'FATAL', code: string) => Object.assign(new Error('could not fsync file "pg_wal/000000010000000000000001": Input/output error'), { code, severity });

function monoIn(ms: number): bigint {
  return process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
}

function scripted(answer: (sql: string) => Answer, onConnect?: () => void) {
  const rig = scriptedPg(answer, onConnect);
  backends.push(rig.backend);
  return rig;
}

/** The happy path's answers, with one statement's answer replaced. */
function happy(override: (sql: string) => Answer | null = () => null) {
  return (sql: string): Answer => {
    const own = override(sql);
    if (own !== null) return own;
    if (isFenced(sql)) return { rows: [], rowCount: 1 };
    if (isBatch(sql)) return { rows: [{ retired_at: '5' }], rowCount: 1 };
    if (isBatchExists(sql)) return batchExistsAnswer(sql, true);
    if (isLive(sql)) return { rows: [{ present: false }], rowCount: 1 };
    if (isMove(sql)) return { rows: [{ taken: '3', put: '3', reason: 'webui-operator-delete' }], rowCount: 1 };
    return undefined;
  };
}

const none = () => null;
const restore = (backend: PostgresBackend, deadline: bigint, retiredAt: number | null = null, beforeCommit: () => 'maintenance' | 'node-stopping' | 'out-of-time' | null = none) =>
  backend.restoreGuild('1', retiredAt, token, beforeCommit, deadline);

describe('restore: connection errors', () => {
  it.each([
    ['BEGIN', isBegin],
    ['the fenced update', isFenced],
    ['the batch choice', isBatch],
    ['the existence read of a given batch', isBatchExists, 5],
    ['the live check', isLive],
    ['the move', isMove],
  ] as const)('an error with no SQLSTATE on %s answers unavailable and notes the outage', async (_name, match, retiredAt: number | null = null) => {
    const { backend, statements, releases } = scripted(happy(sql => (match(sql) ? brokenConnection() : null)));
    const answer = await restore(backend, monoIn(40 * SECOND), retiredAt);
    expect(statements().filter(match)).toHaveLength(1);
    expect(answer).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(backend.connectionState().state).toBe('outage');
    expect(releases).toEqual([true]);
  });

  it.each([
    ['no SQLSTATE', brokenConnection()],
    ['08006', sqlState('08006')],
    ['57P01', sqlState('57P01')],
    ['PANIC 58030', sessionEnded('PANIC', '58030')],
    ['FATAL XX000', sessionEnded('FATAL', 'XX000')],
  ] as const)('an error on COMMIT with %s answers unknown', async (_name, error) => {
    const { backend, releases } = scripted(happy(sql => (sql === 'COMMIT' ? error : null)));
    expect(await restore(backend, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'unknown', retiredAt: 5 });
    expect(releases).toEqual([true]);
  });

  it.each([
    ['PANIC 58030', sessionEnded('PANIC', '58030')],
    ['FATAL XX000', sessionEnded('FATAL', 'XX000')],
  ] as const)('a %s on the move ended the session before COMMIT: unavailable, no COMMIT, the outage noted', async (_name, error) => {
    const { backend, statements, releases } = scripted(happy(sql => (isMove(sql) ? error : null)));
    expect(await restore(backend, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(statements()).not.toContain('COMMIT');
    expect(backend.connectionState().state).toBe('outage');
    expect(releases).toEqual([true]);
  });
});

describe('restore: a statement that never answers', () => {
  it.each([
    ['BEGIN', isBegin, 'unavailable'],
    ['the fenced update', isFenced, 'unavailable'],
    ['the batch choice', isBatch, 'unavailable'],
    ['the existence read of a given batch', isBatchExists, 'unavailable', 5],
    ['the live check', isLive, 'unavailable'],
    ['the move', isMove, 'unavailable'],
    ['COMMIT', (s: string) => s === 'COMMIT', 'unknown'],
  ] as const)('%s times out at the deadline: no ROLLBACK, release(true), %s, no outage', async (_name, match, reason, retiredAt: number | null = null) => {
    const { backend, statements, releases, queued } = scripted(happy(sql => (match(sql) ? 'hang' : null)));
    const answer = restore(backend, monoIn(40 * SECOND), retiredAt);
    let settled: unknown;
    void answer.then(value => { settled = value; });
    await vi.advanceTimersByTimeAsync(40 * SECOND);
    expect(settled).toMatchObject({ ok: false, reason });
    expect(statements()).not.toContain('ROLLBACK');
    expect(queued).toEqual([]);
    expect(releases).toEqual([true]);
    expect(backend.connectionState().state).toBe('ready');
  });

  it('a deposed fenced update whose owner read never answers answers deposed by the deadline, with no owner', async () => {
    const { backend, releases } = scripted(happy(sql => (isFenced(sql) || isOwnerInsert(sql) ? { rows: [], rowCount: 0 } : isOwnerRead(sql) ? 'hang' : null)));
    const answer = restore(backend, monoIn(40 * SECOND));
    let settled: any;
    void answer.then(value => { settled = value; });
    await vi.advanceTimersByTimeAsync(40 * SECOND);
    expect(settled).toEqual({ ok: false, reason: 'deposed' });
    expect(releases).toEqual([true]);
  });

  it('a live-rows ROLLBACK that never answers still answers live-rows by the deadline', async () => {
    const { backend, releases } = scripted(happy(sql => (isLive(sql) ? { rows: [{ present: true }], rowCount: 1 } : sql === 'ROLLBACK' ? 'hang' : null)));
    const answer = restore(backend, monoIn(40 * SECOND));
    let settled: any;
    void answer.then(value => { settled = value; });
    await vi.advanceTimersByTimeAsync(40 * SECOND);
    expect(settled).toEqual({ ok: false, reason: 'live-rows', retiredAt: 5 });
    expect(releases).toEqual([true]);
  });
});

describe('restore: a decided answer near the deadline keeps its answer', () => {
  it('live rows found with 0.5 s left: live-rows with the batch, no ROLLBACK, release(true)', async () => {
    const { backend, statements, releases } = scripted(happy(sql => {
      if (!isLive(sql)) return null;
      vi.advanceTimersByTime(39.5 * SECOND);
      return { rows: [{ present: true }], rowCount: 1 };
    }));
    expect(await restore(backend, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'live-rows', retiredAt: 5 });
    expect(statements()).not.toContain('ROLLBACK');
    expect(releases).toEqual([true]);
  });

  it('a move that took nothing with 0.5 s left: no-entry, no ROLLBACK', async () => {
    const { backend, statements, releases } = scripted(happy(sql => {
      if (!isMove(sql)) return null;
      vi.advanceTimersByTime(39.5 * SECOND);
      return { rows: [{ taken: '0', put: '0', reason: null }], rowCount: 1 };
    }));
    expect(await restore(backend, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'no-entry' });
    expect(statements()).not.toContain('ROLLBACK');
    expect(releases).toEqual([true]);
  });

  it('taken other than put with 0.5 s left: refused, no ROLLBACK', async () => {
    const { backend, statements } = scripted(happy(sql => {
      if (!isMove(sql)) return null;
      vi.advanceTimersByTime(39.5 * SECOND);
      return { rows: [{ taken: '3', put: '2', reason: 'r' }], rowCount: 1 };
    }));
    expect(await restore(backend, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'refused', detail: 'the batch holds 1 row(s) of an unknown kind' });
    expect(statements()).not.toContain('ROLLBACK');
  });

  it('a deposed fenced update with 0.5 s left: deposed with no owner, no owner read and no ROLLBACK', async () => {
    const { backend, statements, releases } = scripted(happy(sql => {
      if (isFenced(sql)) {
        vi.advanceTimersByTime(39.5 * SECOND);
        return { rows: [], rowCount: 0 };
      }
      return null;
    }));
    expect(await restore(backend, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'deposed' });
    expect(statements().filter(isOwnerRead)).toEqual([]);
    expect(statements()).not.toContain('ROLLBACK');
    expect(releases).toEqual([true]);
  });

  it('the retire\'s deposed path with 0.5 s left: deposed, no ROLLBACK', async () => {
    const { backend, statements, releases } = scripted(sql => {
      if (isFenced(sql)) {
        vi.advanceTimersByTime(39.5 * SECOND);
        return { rows: [], rowCount: 0 };
      }
      return undefined;
    });
    expect(await backend.retireGuild('1', 'test', token, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'deposed' });
    expect(statements()).not.toContain('ROLLBACK');
    expect(releases).toEqual([true]);
  });
});

describe('restore: the floors', () => {
  it('a connect that returns past the deadline sends nothing and answers out-of-time', async () => {
    const { backend, sent, releases } = scripted(happy(), () => { vi.advanceTimersByTime(41 * SECOND); });
    expect(await restore(backend, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'out-of-time' });
    expect(sent).toEqual([]);
    expect(releases).toHaveLength(1);
    expect(backend.connectionState().state).toBe('ready');
  });

  it('0.5 s left before the live check: nothing sent, release(true), out-of-time', async () => {
    const { backend, statements, releases } = scripted(happy(sql => {
      if (!isBatch(sql)) return null;
      vi.advanceTimersByTime(39.5 * SECOND);
      return { rows: [{ retired_at: '5' }], rowCount: 1 };
    }));
    expect(await restore(backend, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'out-of-time' });
    expect(statements().filter(isLive)).toEqual([]);
    expect(statements()).not.toContain('ROLLBACK');
    expect(releases).toEqual([true]);
  });

  it('0.5 s left after the fenced update with a given batch: no existence read sent, release(true), out-of-time', async () => {
    const { backend, statements, releases } = scripted(happy(sql => {
      if (!isFenced(sql)) return null;
      vi.advanceTimersByTime(39.5 * SECOND);
      return { rows: [], rowCount: 1 };
    }));
    expect(await restore(backend, monoIn(40 * SECOND), 5)).toMatchObject({ ok: false, reason: 'out-of-time' });
    expect(statements().filter(isBatchExists)).toEqual([]);
    expect(statements().filter(isBatch)).toEqual([]);
    expect(statements().filter(isLive)).toEqual([]);
    expect(statements()).not.toContain('ROLLBACK');
    expect(releases).toEqual([true]);
  });

  it('1.5 s left at beforeCommit: out-of-time and no COMMIT', async () => {
    const { backend, statements } = scripted(happy(sql => {
      if (!isMove(sql)) return null;
      vi.advanceTimersByTime(38.5 * SECOND);
      return { rows: [{ taken: '3', put: '3', reason: 'r' }], rowCount: 1 };
    }));
    expect(await restore(backend, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'out-of-time' });
    expect(statements()).not.toContain('COMMIT');
    expect(statements()).toContain('ROLLBACK');
  });

  it('past the deadline at beforeCommit: out-of-time, no ROLLBACK, no COMMIT, release(true)', async () => {
    const { backend, statements, releases } = scripted(happy(sql => {
      if (!isMove(sql)) return null;
      vi.advanceTimersByTime(40.5 * SECOND);
      return { rows: [{ taken: '3', put: '3', reason: 'r' }], rowCount: 1 };
    }));
    expect(await restore(backend, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'out-of-time' });
    expect(statements()).not.toContain('ROLLBACK');
    expect(statements()).not.toContain('COMMIT');
    expect(releases).toEqual([true]);
  });

  it('every statement carries the time left as its query_timeout', async () => {
    const { backend, sent } = scripted(happy());
    expect(await restore(backend, monoIn(40 * SECOND))).toMatchObject({ ok: true });
    for (const statement of sent) {
      expect(statement.timeout).toBeGreaterThan(39 * SECOND);
      expect(statement.timeout).toBeLessThanOrEqual(40 * SECOND);
    }
  });
});

describe('restore: errors the database answered', () => {
  it.each([
    ['23505 on the move', isMove, '23505'],
    ['40P01 on the move', isMove, '40P01'],
    ['57014 on the live check', isLive, '57014'],
    ['22P02 on the batch choice', isBatch, '22P02'],
    ['40001 answered to COMMIT', (s: string) => s === 'COMMIT', '40001'],
    ['an English ERROR XX000 on the move', isMove, 'XX000'],
    ['an English ERROR 58030 on the live check', isLive, '58030'],
  ] as const)('%s answers refused with the SQLSTATE and no outage', async (_name, match, code) => {
    const { backend, statements } = scripted(happy(sql => (match(sql) ? sqlState(code, 'scripted refusal') : null)));
    const answer: any = await restore(backend, monoIn(40 * SECOND));
    expect(answer).toMatchObject({ ok: false, reason: 'refused' });
    expect(answer.detail).toContain(`SQLSTATE ${code}`);
    expect(backend.connectionState().state).toBe('ready');
    if (!match('COMMIT')) expect(statements()).not.toContain('COMMIT');
    const logged = vi.mocked(console.error).mock.calls.map(call => String(call[0]));
    expect(logged.filter(line => line.includes('connection failed'))).toEqual([]);
  });
});

describe('restore: a COMMIT answered with an error that does not show a rollback (NB5 D8, G2)', () => {
  it('an English ERROR XX001 answered to COMMIT answers unknown with the batch, and no outage', async () => {
    const { backend } = scripted(happy(sql => (sql === 'COMMIT' ? sqlState('XX001', 'scripted refusal') : null)));
    expect(await restore(backend, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'unknown', retiredAt: 5 });
    expect(backend.connectionState().state).toBe('ready');
  });
});

describe('restore: the claim', () => {
  it.each([['null', null], ['0', 0], ['-1', -1], ['1.5', 1.5]] as const)('a claim of %s opens no connection and answers no-claim', async (_name, claim) => {
    const { backend, connect } = scripted(happy());
    const answer = await backend.restoreGuild('1', 5, { ...token, claim } as FenceToken, none, monoIn(40 * SECOND));
    expect(answer).toMatchObject({ ok: false, reason: 'no-claim' });
    expect(connect).not.toHaveBeenCalled();
    expect(backend.connectionState().state).toBe('ready');
  });
});

describe('restore: the statements', () => {
  it('runs the fenced update, the batch choice, the live check and one move whose source is the DELETE', async () => {
    const { backend, statements } = scripted(happy());
    expect(await restore(backend, monoIn(40 * SECOND))).toEqual({ ok: true, moved: 3, retiredAt: 5, reason: 'webui-operator-delete' });
    const sent = statements();
    expect(sent[0]).toBe('BEGIN');
    expect(isFenced(sent[1])).toBe(true);
    expect(isBatch(sent[2])).toBe(true);
    expect(isLive(sent[3])).toBe(true);
    expect(isMove(sent[4])).toBe(true);
    expect(sent[4]).toMatch(/DELETE FROM smdb_data\.guild_data_graveyard[\s\S]*RETURNING/);
    expect(sent[4]).not.toMatch(/ON CONFLICT/);
    expect(sent[5]).toBe('COMMIT');
    expect(sent.some(s => /SET retired_at = NULL/.test(s) && !isFenced(s))).toBe(false);
  });

  it('a given retiredAt reads that the batch exists under the row lock, before the live check, in place of the batch choice', async () => {
    const { backend, statements } = scripted(happy());
    expect(await restore(backend, monoIn(40 * SECOND), 9)).toMatchObject({ ok: true, retiredAt: 9 });
    const sent = statements();
    expect(sent.filter(isBatch)).toEqual([]);
    expect(sent.slice(0, 2).map(s => s === 'BEGIN' || isFenced(s))).toEqual([true, true]);
    expect(isBatchExists(sent[2])).toBe(true);
    expect(isLive(sent[3])).toBe(true);
    expect(isMove(sent[4])).toBe(true);
    expect(sent[5]).toBe('COMMIT');
  });

  it('a given retiredAt that names no batch, with live rows present, answers no-entry with a ROLLBACK, no live check and no COMMIT', async () => {
    const { backend, statements, releases } = scripted(happy(sql => (isBatchExists(sql) ? batchExistsAnswer(sql, false) : isLive(sql) ? { rows: [{ present: true }], rowCount: 1 } : null)));
    const answer = await restore(backend, monoIn(40 * SECOND), 1730000000001);
    expect(answer).toMatchObject({ ok: false, reason: 'no-entry' });
    expect(answer).not.toMatchObject({ reason: 'live-rows' });
    const sent = statements();
    expect(sent.filter(isBatchExists)).toHaveLength(1);
    expect(sent.filter(isLive)).toEqual([]);
    expect(sent.filter(isMove)).toEqual([]);
    expect(sent).toContain('ROLLBACK');
    expect(sent).not.toContain('COMMIT');
    expect(releases).toEqual([undefined]);
    expect(backend.connectionState().state).toBe('ready');
  });

  it('no batch answers no-entry with a ROLLBACK and no COMMIT', async () => {
    const { backend, statements } = scripted(happy(sql => (isBatch(sql) ? { rows: [{ retired_at: null }], rowCount: 1 } : null)));
    expect(await restore(backend, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'no-entry' });
    expect(statements()).toContain('ROLLBACK');
    expect(statements()).not.toContain('COMMIT');
  });

  it('taken 0 answers no-entry with a ROLLBACK and no COMMIT', async () => {
    const { backend, statements } = scripted(happy(sql => (isMove(sql) ? { rows: [{ taken: '0', put: '0', reason: null }], rowCount: 1 } : null)));
    expect(await restore(backend, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'no-entry' });
    expect(statements()).toContain('ROLLBACK');
    expect(statements()).not.toContain('COMMIT');
  });

  it('taken 3 and put 2 answers refused with a ROLLBACK', async () => {
    const { backend, statements } = scripted(happy(sql => (isMove(sql) ? { rows: [{ taken: '3', put: '2', reason: 'r' }], rowCount: 1 } : null)));
    expect(await restore(backend, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'refused' });
    expect(statements()).toContain('ROLLBACK');
    expect(statements()).not.toContain('COMMIT');
  });

  it('live rows answer live-rows with the chosen batch', async () => {
    const { backend, statements } = scripted(happy(sql => (isLive(sql) ? { rows: [{ present: true }], rowCount: 1 } : null)));
    expect(await restore(backend, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'live-rows', retiredAt: 5 });
    expect(statements().filter(isMove)).toEqual([]);
    expect(statements()).toContain('ROLLBACK');
  });

  it('beforeCommit refusing sends a ROLLBACK and no COMMIT', async () => {
    for (const stop of ['maintenance', 'node-stopping', 'out-of-time'] as const) {
      const { backend, statements } = scripted(happy());
      expect(await restore(backend, monoIn(40 * SECOND), null, () => stop)).toMatchObject({ ok: false, reason: stop });
      expect(statements()).toContain('ROLLBACK');
      expect(statements()).not.toContain('COMMIT');
    }
  });
});

describe('retire', () => {
  it('an error on COMMIT with no SQLSTATE answers unknown; one before COMMIT unavailable', async () => {
    const onCommit = scripted(sql => (isFenced(sql) ? { rows: [], rowCount: 1 } : sql === 'COMMIT' ? brokenConnection() : undefined));
    expect(await onCommit.backend.retireGuild('1', 'test', token, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'unknown' });
    const before = scripted(sql => (isFenced(sql) ? { rows: [], rowCount: 1 } : isGraveInsert(sql) ? brokenConnection() : undefined));
    const answer: any = await before.backend.retireGuild('1', 'test', token, monoIn(40 * SECOND));
    expect(answer).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(answer.timedOut).toBeUndefined();
  });

  it.each([
    ['PANIC 58030', () => sessionEnded('PANIC', '58030')],
    ['FATAL XX000', () => sessionEnded('FATAL', 'XX000')],
  ] as const)('a %s on COMMIT answers unknown; the same before COMMIT answers unavailable', async (_name, error) => {
    const onCommit = scripted(sql => (isFenced(sql) ? { rows: [], rowCount: 1 } : sql === 'COMMIT' ? error() : undefined));
    expect(await onCommit.backend.retireGuild('1', 'test', token, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'unknown' });
    expect(onCommit.releases).toEqual([true]);
    const before = scripted(sql => (isFenced(sql) ? { rows: [], rowCount: 1 } : isGraveInsert(sql) ? error() : undefined));
    expect(await before.backend.retireGuild('1', 'test', token, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(before.statements()).not.toContain('COMMIT');
    expect(before.releases).toEqual([true]);
  });

  it('an English ERROR XX000 on COMMIT does not show a rollback: unknown, no outage (NB5 D8, G2)', async () => {
    const { backend } = scripted(sql => (isFenced(sql) ? { rows: [], rowCount: 1 } : sql === 'COMMIT' ? sqlState('XX000', 'scripted refusal') : undefined));
    expect(await backend.retireGuild('1', 'test', token, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'unknown', moved: 0 });
    expect(backend.connectionState().state).toBe('ready');
  });

  it.each([
    ['58030', 'a graveyard insert', isGraveInsert],
  ] as const)('an English ERROR %s on %s is an answer: refused with the SQLSTATE, no outage', async (code, _where, match) => {
    const { backend } = scripted(sql => (isFenced(sql) ? { rows: [], rowCount: 1 } : match(sql) ? sqlState(code, 'scripted refusal') : undefined));
    const answer: any = await backend.retireGuild('1', 'test', token, monoIn(40 * SECOND));
    expect(answer).toMatchObject({ ok: false, reason: 'refused' });
    expect(answer.detail).toContain(`SQLSTATE ${code}`);
    expect(backend.connectionState().state).toBe('ready');
  });

  it.each([
    ['the fenced update', isFenced, 'unavailable'],
    ['a graveyard insert', isGraveInsert, 'unavailable'],
    ['COMMIT', (s: string) => s === 'COMMIT', 'unknown'],
  ] as const)('%s that never answers: no ROLLBACK, release(true), %s by the deadline', async (_name, match, reason) => {
    const { backend, statements, releases } = scripted(sql => (match(sql) ? 'hang' : isFenced(sql) ? { rows: [], rowCount: 1 } : undefined));
    const answer = backend.retireGuild('1', 'test', token, monoIn(40 * SECOND));
    let settled: any;
    void answer.then(value => { settled = value; });
    await vi.advanceTimersByTimeAsync(40 * SECOND);
    expect(settled).toMatchObject({ ok: false, reason });
    if (reason === 'unavailable') expect(settled.timedOut).toBe(true);
    expect(statements()).not.toContain('ROLLBACK');
    expect(releases).toEqual([true]);
  });

  it('the deposed path\'s ROLLBACK that never answers: deposed by the deadline', async () => {
    const { backend } = scripted(sql => (isFenced(sql) || isOwnerInsert(sql) ? { rows: [], rowCount: 0 } : sql === 'ROLLBACK' ? 'hang' : undefined));
    const answer = backend.retireGuild('1', 'test', token, monoIn(40 * SECOND));
    let settled: any;
    void answer.then(value => { settled = value; });
    await vi.advanceTimersByTimeAsync(40 * SECOND);
    expect(settled).toEqual({ ok: false, reason: 'deposed' });
  });

  it('less than 1 s before a statement or 2 s before COMMIT: out-of-time, nothing sent', async () => {
    const early = scripted(sql => {
      if (!isFenced(sql)) return undefined;
      vi.advanceTimersByTime(39.5 * SECOND);
      return { rows: [], rowCount: 1 };
    });
    expect(await early.backend.retireGuild('1', 'test', token, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'out-of-time' });
    expect(early.statements().filter(isGraveInsert)).toEqual([]);
    const late = scripted(sql => {
      if (isFenced(sql)) return { rows: [], rowCount: 1 };
      if (/SET retired_at = now\(\)/.test(sql)) vi.advanceTimersByTime(38.5 * SECOND);
      return undefined;
    });
    expect(await late.backend.retireGuild('1', 'test', token, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'out-of-time' });
    expect(late.statements()).not.toContain('COMMIT');
  });
});
