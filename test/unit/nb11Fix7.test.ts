import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { RESTORE_TEXTS } from '../../src/bot/internalSetup/utils/dataManager';
import { type Answer, batchExistsAnswer, isBatch, isBatchExists, isFenced, isGraveInsert, isLive, isMove, scriptedPg } from '../helpers/nb11ScriptedPg';

// NB11 fix round 7: class 58 or XX under the English severity ERROR is an answer (NB11-R7-T1, NB11-R7-data-1), and the
// outage line names a server error on a live session by its SQLSTATE, in a connection class too (NB11-R7-T2, NB11-R7-run-2).

const SECOND = 1000;
const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 };
const backends: PostgresBackend[] = [];
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

const monoIn = (ms: number) => process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
const serverError = (code: string, severity: string, message = `scripted ${severity}`) => Object.assign(new Error(message), { code, severity });
const isCommit = (s: string) => s === 'COMMIT';
const lines = (): string[] => error.mock.calls.map((c: unknown[]) => c.map(String).join(' '));

function scripted(answer: (sql: string) => Answer) {
  const rig = scriptedPg(answer);
  backends.push(rig.backend);
  return rig;
}

function happy(override: (sql: string) => Answer | null = () => null) {
  return (sql: string): Answer => {
    const own = override(sql);
    if (own !== null) return own;
    if (isFenced(sql)) return { rows: [], rowCount: 1 };
    if (isBatch(sql)) return { rows: [{ retired_at: '5' }], rowCount: 1 };
    if (isBatchExists(sql)) return batchExistsAnswer(sql, true);
    if (isLive(sql)) return { rows: [{ present: false }], rowCount: 1 };
    if (isMove(sql)) return { rows: [{ taken: '3', put: '3', reason: 'r' }], rowCount: 1 };
    return undefined;
  };
}

const restore = (backend: PostgresBackend) => backend.restoreGuild('1', null, token, () => null, monoIn(40 * SECOND));
const retire = (backend: PostgresBackend) => backend.retireGuild('1', 'test', token, monoIn(40 * SECOND));
const retireAnswers = (override: (sql: string) => Answer | null) => (sql: string): Answer => override(sql) ?? (isFenced(sql) ? { rows: [], rowCount: 1 } : undefined);

describe('an English ERROR in class 53, 58 or XX is an answer', () => {
  const answered = [
    ['ERROR XX000', () => serverError('XX000', 'ERROR', 'cache lookup failed for relation 1')],
    ['ERROR 58030', () => serverError('58030', 'ERROR', 'could not read block 12')],
    ['ERROR 53100', () => serverError('53100', 'ERROR', 'could not extend file "base/16384/16390": No space left on device')],
    ['ERROR 53200', () => serverError('53200', 'ERROR', 'out of memory')],
  ] as const;

  it.each(answered)('%s on the move: the restore is refused, no COMMIT, no outage, no connection line', async (_name, make) => {
    const { backend, statements } = scripted(happy(sql => (isMove(sql) ? make() : null)));
    const answer: any = await restore(backend);
    expect(answer).toMatchObject({ ok: false, reason: 'refused', code: make().code });
    expect(answer.detail).toContain(`SQLSTATE ${make().code}`);
    expect(statements()).not.toContain('COMMIT');
    expect(backend.connectionState().state).toBe('ready');
    expect(lines().some(line => line.includes('connection failed'))).toBe(false);
  });

  // NB5 D8 and G2: a COMMIT error is refused only when it shows a rollback, which class 53 and XX at ERROR do not.
  const onCommit: Record<string, 'refused' | 'unknown'> = { XX000: 'unknown', 58030: 'refused', 53100: 'unknown', 53200: 'unknown' };
  it.each(answered)('%s on COMMIT: the restore and the retire answer as D8 rules, the backend stays ready', async (_name, make) => {
    const restored = scripted(happy(sql => (isCommit(sql) ? make() : null)));
    expect(await restore(restored.backend)).toMatchObject({ ok: false, reason: onCommit[make().code] });
    expect(restored.backend.connectionState().state).toBe('ready');
    const retired = scripted(retireAnswers(sql => (isCommit(sql) ? make() : null)));
    expect(await retire(retired.backend)).toMatchObject({ ok: false, reason: onCommit[make().code] });
    expect(retired.backend.connectionState().state).toBe('ready');
  });

  it.each(answered)('%s before COMMIT on the retire: refused, no COMMIT', async (_name, make) => {
    const { backend, statements } = scripted(retireAnswers(sql => (isGraveInsert(sql) ? make() : null)));
    expect(await retire(backend)).toMatchObject({ ok: false, reason: 'refused' });
    expect(statements()).not.toContain('COMMIT');
    expect(backend.connectionState().state).toBe('ready');
  });

  it('a localized severity in class XX on COMMIT stays no answer: unknown', async () => {
    const { backend } = scripted(happy(sql => (isCommit(sql) ? serverError('XX000', 'FEHLER') : null)));
    expect(await restore(backend)).toEqual({ ok: false, reason: 'unknown', retiredAt: 5 });
  });
});

describe('the outage line of a flush', () => {
  const emptyBatch = { upserts: [], deletes: [], appends: [] } as any;

  it.each([
    ['53100', 'ERROR', 'could not extend file'],
    ['XX001', 'ERROR', 'invalid page in block 12'],
    ['58030', 'ERROR', 'could not read block 12'],
  ])('ERROR %s is an answer: no hold and no outage line (NB5 decision 13)', async (code, severity, message) => {
    const { backend } = scripted(sql => (isFenced(sql) ? serverError(code, severity, message) : undefined));
    expect(await backend.flushGuild('1', emptyBatch, token)).toMatchObject({ ok: false, reason: 'unavailable', code });
    expect(lines().some(line => line.includes('entering outage'))).toBe(false);
    expect(backend.connectionState().state).toBe('ready');
  });

  it.each([
    ['57P01', 'FATAL'],
    ['08006', 'ERROR'],
  ])('%s %s says the connection failed', async (code, severity) => {
    const { backend } = scripted(sql => (isFenced(sql) ? serverError(code, severity) : undefined));
    await backend.flushGuild('1', emptyBatch, token);
    expect(lines().some(line => line.startsWith('[PostgresBackend] Database connection failed; entering outage:'))).toBe(true);
  });
});

describe('class 53 under a severity other than ERROR is no answer (NB11-R8-run-1, NB11-R8-data-1)', () => {
  it.each([
    ['FEHLER 53100', () => serverError('53100', 'FEHLER', 'konnte Datei nicht erweitern')],
    ['FATAL 53300', () => serverError('53300', 'FATAL', 'sorry, too many clients already')],
  ])('%s on the move: unavailable, outage noted, no COMMIT', async (_name, make) => {
    const { backend, statements } = scripted(happy(sql => (isMove(sql) ? make() : null)));
    const answer: any = await restore(backend);
    expect(answer).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(answer.detail).toContain(`SQLSTATE ${make().code}`);
    expect(statements()).not.toContain('COMMIT');
    expect(backend.connectionState().state).not.toBe('ready');
  });

  it('FEHLER 53100 on COMMIT stays unknown', async () => {
    const { backend } = scripted(happy(sql => (isCommit(sql) ? serverError('53100', 'FEHLER') : null)));
    expect(await restore(backend)).toEqual({ ok: false, reason: 'unknown', retiredAt: 5 });
  });

  it('ERROR 53100 on the move is worded as refused with the SQLSTATE, never as no answer', async () => {
    const { backend } = scripted(happy(sql => (isMove(sql) ? serverError('53100', 'ERROR', 'could not extend file') : null)));
    const answer: any = await restore(backend);
    const reply = RESTORE_TEXTS.refused(answer.detail, answer.code);
    expect(reply).toContain('SQLSTATE 53100');
    expect(reply).toContain('nothing was restored');
    expect(reply).not.toContain('did not answer');
  });
});
