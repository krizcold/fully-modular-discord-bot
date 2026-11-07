import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { noteGuildDataServing, setGuildDataBackend, sweepGraveyard } from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';
import { type Answer, batchExistsAnswer, isBatch, isBatchExists, isBegin, isFenced, isGraveInsert, isLive, isLock, isMove, scriptedPg } from '../helpers/nb11ScriptedPg';

// NB14 test 3 (wip-redesign/sheets/NB14.md) and the check's rows 5 to 7: the replace's, the retire's and the sweep's
// statements over a scripted client that keeps pg's single active query.

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
  setGuildDataBackend(null);
  setBackendKind(null);
  for (const backend of backends.splice(0)) await backend.stop();
});

const brokenConnection = () => new Error('Connection terminated unexpectedly');
const monoIn = (ms: number) => process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
const isCommit = (s: string) => s === 'COMMIT';
const isTryLock = (s: string) => /pg_try_advisory_xact_lock\(hashtext\('smdb_data_graveyard'\)\)/.test(s);
const isSweep = (s: string) => /^DELETE FROM smdb_data\.guild_data_graveyard/.test(s);
const lines = (spy: unknown) => (spy as { mock: { calls: unknown[][] } }).mock.calls.map(c => c.map(String).join(' '));

function scripted(answer: (sql: string) => Answer, onConnect?: () => void) {
  const rig = scriptedPg(answer, onConnect);
  backends.push(rig.backend);
  return rig;
}

/** The happy path of a replace that moved 2 docs and 1 stream into batch 900 and copied 3 rows of batch 5 in. */
function happy(override: (sql: string) => Answer | null = () => null) {
  return (sql: string): Answer => {
    const own = override(sql);
    if (own !== null) return own;
    if (isFenced(sql)) return { rows: [], rowCount: 1 };
    if (isLock(sql)) return { rows: [{ pg_advisory_xact_lock_shared: '' }], rowCount: 1 };
    if (isBatch(sql)) return { rows: [{ retired_at: '5' }], rowCount: 1 };
    if (isBatchExists(sql)) return batchExistsAnswer(sql, true);
    if (isGraveInsert(sql)) return { rows: [{ at: '900', docs: '2', streams: '1', put: '3' }], rowCount: 1 };
    if (isLive(sql)) return { rows: [{ present: false }], rowCount: 1 };
    if (isMove(sql)) return { rows: [{ taken: '3', put: '3', reason: 'webui-operator-delete', used_at: '1000' }], rowCount: 1 };
    return undefined;
  };
}

const none = () => null;
const restore = (backend: PostgresBackend, replace: boolean, retiredAt: number | null = null) =>
  backend.restoreGuild('1', retiredAt, token, none, monoIn(40 * SECOND), replace);

describe('the statements in order', () => {
  it('a replace sends the shared lock, the fenced update, the batch choice, the move-out, the live check, the copy-in and COMMIT', async () => {
    const { backend, statements, params } = scripted(happy());
    expect(await restore(backend, true)).toEqual({
      ok: true, retiredAt: 5, reason: 'webui-operator-delete', copied: 3, usedAt: 1000,
      replaced: { retiredAt: 900, moved: 3, reason: 'replaced-by-restore-5' },
    });
    const sent = statements();
    expect(sent.map(s => (isBegin(s) ? 'begin' : isLock(s) ? 'lock' : isFenced(s) ? 'fenced' : isBatch(s) ? 'batch'
      : isGraveInsert(s) ? 'move-out' : isLive(s) ? 'live' : isMove(s) ? 'copy-in' : s))).toEqual(
      ['begin', 'lock', 'fenced', 'batch', 'move-out', 'live', 'copy-in', 'COMMIT']);
    expect(sent[1]).toMatch(/pg_advisory_xact_lock_shared\(hashtext\('smdb_data_graveyard'\)\)/);
    const moveOut = sent[4];
    expect(moveOut).toMatch(/DELETE FROM smdb_data\.guild_data WHERE guild_id = \$1 RETURNING/);
    expect(moveOut).toMatch(/DELETE FROM smdb_data\.guild_append WHERE guild_id = \$1 RETURNING/);
    expect(moveOut).toMatch(/max\(retired_at\)/);
    expect(moveOut).toMatch(/clock_timestamp\(\)/);
    expect(params[4]).toEqual(['1', 'replaced-by-restore-5']);
    const copyIn = sent[6];
    expect(copyIn).toMatch(/^WITH src AS \(\s*UPDATE smdb_data\.guild_data_graveyard\s+SET used_at/);
    expect(copyIn).not.toMatch(/DELETE/);
    expect(params[6]).toEqual(['1', 5]);
    for (const s of [moveOut, copyIn]) expect(s).not.toMatch(/ON CONFLICT/);
  });

  it('a plain restore sends the same without the move-out, and its ok has no replaced', async () => {
    const { backend, statements } = scripted(happy());
    expect(await restore(backend, false)).toEqual({ ok: true, retiredAt: 5, reason: 'webui-operator-delete', copied: 3, usedAt: 1000 });
    const sent = statements();
    expect(sent.filter(isGraveInsert)).toEqual([]);
    expect(isLock(sent[1])).toBe(true);
    expect(isFenced(sent[2])).toBe(true);
    expect(isBatch(sent[3])).toBe(true);
    expect(isLive(sent[4])).toBe(true);
    expect(isMove(sent[5])).toBe(true);
    expect(sent[6]).toBe('COMMIT');
  });

  it('a replace of a server with no data is a plain restore that answers replaced null', async () => {
    const { backend, statements } = scripted(happy(sql => (isGraveInsert(sql) ? { rows: [{ at: '900', docs: '0', streams: '0', put: '0' }], rowCount: 1 } : null)));
    expect(await restore(backend, true)).toMatchObject({ ok: true, retiredAt: 5, copied: 3, replaced: null });
    expect(statements()).toContain('COMMIT');
  });
});

describe('the batch and the counts', () => {
  it('a given retiredAt with no rows answers no-entry after the batch choice; the move-out is never sent', async () => {
    const { backend, statements } = scripted(happy(sql => (isBatchExists(sql) ? batchExistsAnswer(sql, false) : null)));
    expect(await restore(backend, true, 1730000000001)).toMatchObject({ ok: false, reason: 'no-entry' });
    expect(statements().filter(isGraveInsert)).toEqual([]);
    expect(statements().filter(isMove)).toEqual([]);
    expect(statements()).toContain('ROLLBACK');
  });

  it("the copy-in's taken 0 after a move-out that took rows: no-entry, ROLLBACK, no COMMIT", async () => {
    const { backend, statements } = scripted(happy(sql => (isMove(sql) ? { rows: [{ taken: '0', put: '0', reason: null, used_at: null }], rowCount: 1 } : null)));
    expect(await restore(backend, true)).toMatchObject({ ok: false, reason: 'no-entry' });
    expect(statements()).toContain('ROLLBACK');
    expect(statements()).not.toContain('COMMIT');
  });

  it("a live check that finds rows after the move-out: changed, ROLLBACK; without replace: live-rows with X", async () => {
    const live = happy(sql => (isLive(sql) ? { rows: [{ present: true }], rowCount: 1 } : null));
    const replaced = scripted(live);
    expect(await restore(replaced.backend, true)).toEqual({ ok: false, reason: 'changed' });
    expect(replaced.statements()).toContain('ROLLBACK');
    expect(replaced.statements().filter(isMove)).toEqual([]);
    expect(replaced.statements()).not.toContain('COMMIT');
    const plain = scripted(live);
    expect(await restore(plain.backend, false)).toEqual({ ok: false, reason: 'live-rows', retiredAt: 5 });
  });

  it("put other than its count: incomplete with the step, at the move-out and at the copy-in", async () => {
    const out = scripted(happy(sql => (isGraveInsert(sql) ? { rows: [{ at: '900', docs: '2', streams: '1', put: '2' }], rowCount: 1 } : null)));
    expect(await restore(out.backend, true)).toEqual({ ok: false, reason: 'incomplete', step: 'move-out', taken: 3, put: 2 });
    expect(out.statements().filter(isMove)).toEqual([]);
    expect(out.statements()).toContain('ROLLBACK');
    const into = scripted(happy(sql => (isMove(sql) ? { rows: [{ taken: '3', put: '2', reason: 'r', used_at: '1000' }], rowCount: 1 } : null)));
    expect(await restore(into.backend, true)).toEqual({ ok: false, reason: 'incomplete', step: 'copy-in', taken: 3, put: 2 });
    expect(into.statements()).toContain('ROLLBACK');
    expect(into.statements()).not.toContain('COMMIT');
  });
});

describe('a move-out or a COMMIT with no answer', () => {
  it('a connection error on the move-out: unavailable, no ROLLBACK, release(true)', async () => {
    const { backend, statements, releases } = scripted(happy(sql => (isGraveInsert(sql) ? brokenConnection() : null)));
    expect(await restore(backend, true)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(statements()).not.toContain('ROLLBACK');
    expect(releases).toEqual([true]);
  });

  it('a move-out that never answers: unavailable at the deadline, no ROLLBACK, release(true)', async () => {
    const { backend, statements, releases } = scripted(happy(sql => (isGraveInsert(sql) ? 'hang' : null)));
    let settled: unknown;
    void restore(backend, true).then(value => { settled = value; });
    await vi.advanceTimersByTimeAsync(40 * SECOND);
    expect(settled).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(statements()).not.toContain('ROLLBACK');
    expect(releases).toEqual([true]);
  });

  it("a COMMIT with no answer: unknown with replaced from the move-out's answer", async () => {
    const moved = scripted(happy(sql => (isCommit(sql) ? brokenConnection() : null)));
    expect(await restore(moved.backend, true)).toEqual({ ok: false, reason: 'unknown', retiredAt: 5, replaced: { retiredAt: 900, moved: 3, reason: 'replaced-by-restore-5' } });
    expect(moved.releases).toEqual([true]);
    const empty = scripted(happy(sql => (isCommit(sql) ? brokenConnection() : isGraveInsert(sql) ? { rows: [{ at: '900', docs: '0', streams: '0', put: '0' }], rowCount: 1 } : null)));
    expect(await restore(empty.backend, true)).toEqual({ ok: false, reason: 'unknown', retiredAt: 5, replaced: null });
    const plain = scripted(happy(sql => (isCommit(sql) ? brokenConnection() : null)));
    expect(await restore(plain.backend, false)).toEqual({ ok: false, reason: 'unknown', retiredAt: 5 });
  });
});

describe('the retire', () => {
  it('sends BEGIN, the fenced upsert, MOVE_OUT_SQL with the reason, the ownership update and COMMIT', async () => {
    const { backend, statements, params } = scripted(happy());
    expect(await backend.retireGuild('1', 'webui-operator-delete', token, monoIn(40 * SECOND))).toEqual({ ok: true, moved: 3, retiredAt: 900 });
    const sent = statements();
    expect(sent[0]).toBe('BEGIN');
    expect(isFenced(sent[1])).toBe(true);
    expect(isGraveInsert(sent[2])).toBe(true);
    expect(params[2]).toEqual(['1', 'webui-operator-delete']);
    expect(sent[3]).toMatch(/SET retired_at = now\(\)/);
    expect(sent[4]).toBe('COMMIT');
    expect(sent).toHaveLength(5);
  });

  it("answers the batch its statement wrote: at 777 is ok's retiredAt, and the unknown's when COMMIT is lost (C5)", async () => {
    vi.setSystemTime(1700000000000);
    const at = (sql: string) => (isGraveInsert(sql) ? { rows: [{ at: '777', docs: '1', streams: '0', put: '1' }], rowCount: 1 } : null);
    const ok = scripted(happy(at));
    expect(await ok.backend.retireGuild('1', 'r', token, monoIn(40 * SECOND))).toEqual({ ok: true, moved: 1, retiredAt: 777 });
    const lost = scripted(happy(sql => at(sql) ?? (isCommit(sql) ? brokenConnection() : null)));
    expect(await lost.backend.retireGuild('1', 'r', token, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'unknown', retiredAt: 777, moved: 1 });
  });

  it("put other than docs plus streams: incomplete, ROLLBACK, no COMMIT", async () => {
    const { backend, statements } = scripted(happy(sql => (isGraveInsert(sql) ? { rows: [{ at: '900', docs: '2', streams: '1', put: '1' }], rowCount: 1 } : null)));
    expect(await backend.retireGuild('1', 'r', token, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'incomplete' });
    expect(statements()).toContain('ROLLBACK');
    expect(statements()).not.toContain('COMMIT');
  });
});

describe('the re-save batch (C4)', () => {
  it('a replace-mode flush names its batch on the database\'s clock, with no value equal to the bot\'s clock', async () => {
    vi.setSystemTime(1700000000000);
    const { backend, statements, params } = scripted(sql => (/^INSERT INTO smdb_data\.guild_ownership/.test(sql) ? { rows: [], rowCount: 1 }
      : /^WITH batch AS/.test(sql) ? { rows: [{ moved: '0', retired_at: '5' }], rowCount: 1 } : undefined));
    const answer = await backend.flushGuild('1', { upserts: [], deletes: [], appends: [], replace: { docKeys: [], appendKeys: [], reason: 're-saved' } }, token);
    expect(answer).toEqual({ ok: true });
    const at = statements().findIndex(s => /^WITH batch AS/.test(s));
    expect(at).toBeGreaterThan(-1);
    expect(statements()[at]).toMatch(/clock_timestamp\(\)/);
    expect(params[at]).not.toContain(1700000000000);
    expect(params[at].map(String)).not.toContain('1700000000000');
  });
});

describe('the sweep', () => {
  const sweepAnswers = (override: (sql: string) => Answer | null = () => null) => (sql: string): Answer => {
    const own = override(sql);
    if (own !== null) return own;
    if (isTryLock(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (isSweep(sql)) return { rows: [], rowCount: 4 };
    return undefined;
  };

  it('sends the TTL against statement_timestamp(), with no clock_timestamp(), and reads used_at', async () => {
    const { backend, statements, params } = scripted(sweepAnswers());
    expect(await backend.sweepGraveyard(3_600_000)).toBe(4);
    const del = statements().findIndex(isSweep);
    expect(statements()[del]).toMatch(/statement_timestamp\(\)/);
    expect(statements()[del]).not.toMatch(/clock_timestamp\(\)/);
    expect(statements()[del]).toMatch(/used_at IS NULL OR used_at </);
    expect(params[del]).toEqual([3_600_000]);
  });

  it('runs BEGIN, the try lock, the DELETE and COMMIT on one lease, each with its query_timeout (C10)', async () => {
    const { backend, sent, connect, releases } = scripted(sweepAnswers());
    await backend.sweepGraveyard(1000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(sent.map(s => (isTryLock(s.sql) ? 'try' : isSweep(s.sql) ? 'delete' : s.sql))).toEqual(['BEGIN', 'try', 'delete', 'COMMIT']);
    expect(sent.map(s => s.timeout)).toEqual([5000, 5000, 35000, 5000]);
    expect(releases).toEqual([undefined]);
  });

  it('a held lock: ROLLBACK, no DELETE, and the skip line', async () => {
    const { backend, statements, releases } = scripted(sweepAnswers(sql => (isTryLock(sql) ? { rows: [{ locked: false }], rowCount: 1 } : null)));
    expect(await backend.sweepGraveyard(1000)).toBe(0);
    expect(statements().filter(isSweep)).toEqual([]);
    expect(statements()).toContain('ROLLBACK');
    expect(statements()).not.toContain('COMMIT');
    expect(releases).toEqual([undefined]);
    expect(lines(console.log).concat(lines(console.warn))).toContain("[Data] Graveyard row sweep skipped: the graveyard lock is held (a restore, or another process's sweep); the next sweep runs it");
  });

  const throughFacade = async (backend: PostgresBackend) => {
    noteGuildDataServing();
    setBackendKind('postgres');
    setGuildDataBackend(backend);
    await sweepGraveyard();
  };

  it.each([
    ['the DELETE', isSweep, 35],
    ['BEGIN', isBegin, 5],
  ] as const)('%s that never answers rejects at its bound; nothing more is sent, release(true), the failure logged', async (_name, match, seconds) => {
    const { backend, statements, releases } = scripted(sweepAnswers(sql => (match(sql) ? 'hang' : null)));
    const swept = throughFacade(backend);
    for (let i = 0; i < 500 && !statements().some(match); i++) await new Promise(resolve => { setImmediate(resolve); });
    await vi.advanceTimersByTimeAsync(seconds * SECOND - 1);
    expect(releases).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await swept;
    expect(statements()).not.toContain('ROLLBACK');
    expect(statements()).not.toContain('COMMIT');
    expect(releases).toEqual([true]);
    expect(lines(console.warn).some(line => line.startsWith('[Data] Graveyard row sweep failed:'))).toBe(true);
  });

  it('the latch raised after the try lock: no DELETE, release(true), the failure logged (C10)', async () => {
    const rig = scripted(sweepAnswers(sql => {
      if (!isTryLock(sql)) return null;
      rig.backend.latch({ kind: 'tie', generation: 2 });
      return { rows: [{ locked: true }], rowCount: 1 };
    }));
    await throughFacade(rig.backend);
    expect(rig.statements().filter(isSweep)).toEqual([]);
    expect(rig.releases).toEqual([true]);
    expect(lines(console.warn).some(line => line.startsWith('[Data] Graveyard row sweep failed:'))).toBe(true);
  });
});
