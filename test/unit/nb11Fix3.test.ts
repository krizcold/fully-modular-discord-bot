import { Client } from 'pg';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken, RestoreOutcome, RetireOutcome } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { initDataReadiness, type DataReadinessDriver } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { deleteGuildNamespace, setGuildDataBackend, setOwnerInfoProvider } from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore } from '../helpers/fakeStore';
import { freshGuild } from '../helpers/gateRig';
import { type Answer, batchExistsAnswer, isBatchExists, isBegin, isFenced, isGraveInsert, isLive, isMove, scriptedPg } from '../helpers/nb11ScriptedPg';
import { LEASED } from '../helpers/readinessRig';

// NB11 fix round 3: a retire that finds another holder says so (NB11-R3-run-1), and pg's own query_timeout error is
// the time-out on the restore and the retire, while a broken connection stays a connection failure.

const SECOND = 1000;
const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 };
const DELETE_DEPOSED = "another bot process now serves this server's data; nothing was removed";
const DELETE_TIMEOUT = 'the database did not finish the delete within its 40 s; nothing was removed; try again in a moment';
const monoIn = (ms: number) => process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));

let pgTimeout: Error;

beforeAll(async () => {
  // A client that never connects: its statement waits in pg's queue until pg's own query_timeout rejects it.
  const client = new Client({ connectionString: 'postgres://nobody@127.0.0.1:9/none' });
  const config = { text: 'SELECT 1', query_timeout: 20 } as unknown as string;
  pgTimeout = await client.query(config).then(() => { throw new Error('answered'); }, (error: Error) => error);
});

class RetireStore extends FakeStore {
  constructor(private readonly answer: RetireOutcome) { super(); }
  retireCalls = 0;
  override async retireGuild(): Promise<RetireOutcome> { this.retireCalls++; return this.answer; }
  override async restoreGuild(): Promise<RestoreOutcome> { return { ok: false, reason: 'no-entry' }; }
}

const drivers: DataReadinessDriver[] = [];
const backends: PostgresBackend[] = [];

function setup(store: FakeStore): WorkingSetManager {
  const ws = initWorkingSet(store);
  const driver = initDataReadiness(store, ws, { held: false });
  drivers.push(driver);
  driver.onLeaseChanged(LEASED);
  setGuildDataBackend(store);
  setOwnerInfoProvider(() => ({ nodeId: 'node-a', processId: 'process-a', shardCount: 1, claimOf: () => 7 }));
  setBackendKind('postgres');
  return ws;
}

function scripted(answer: (sql: string) => Answer) {
  const rig = scriptedPg(answer);
  backends.push(rig.backend);
  return rig;
}

function happy(fail: (sql: string) => boolean, error: () => Error) {
  return (sql: string): Answer => {
    if (fail(sql)) return error();
    if (isFenced(sql)) return { rows: [], rowCount: 1 };
    if (isBatchExists(sql)) return batchExistsAnswer(sql, true);
    if (isLive(sql)) return { rows: [{ present: false }], rowCount: 1 };
    if (isMove(sql)) return { rows: [{ taken: '1', put: '1', reason: 'test' }], rowCount: 1 };
    return undefined;
  };
}

const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' });
const reset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -104, syscall: 'read' });
const ended = () => new Error('Connection terminated unexpectedly');

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const driver of drivers.splice(0)) driver.stop();
  setGuildDataBackend(null);
  for (const backend of backends.splice(0)) await backend.stop();
});

describe('a retire that finds another holder', () => {
  it('answers not-owner with the deposed text and evicts the set', async () => {
    const store = new RetireStore({ ok: false, reason: 'deposed' });
    const ws = setup(store);
    const g = freshGuild();
    expect(await ws.hydrate(g, token)).toBe('ready');
    expect(await deleteGuildNamespace(g, 'test', 5 * SECOND)).toEqual({ ok: false, code: 'not-owner', error: DELETE_DEPOSED });
    expect(store.retireCalls).toBe(1);
    expect(ws.stateOf(g)).toBeNull();
  });
});

describe("pg's own query_timeout", () => {
  it('is the error pg gives for a statement past its query_timeout', () => {
    expect(pgTimeout).toBeInstanceOf(Error);
    expect(pgTimeout.message).toBe('Query read timeout');
  });

  it.each([
    ['BEGIN', isBegin],
    ['the fenced update', isFenced],
    ['the live check', isLive],
    ['the move', isMove],
  ] as const)('on %s of a restore answers the time-out and notes no outage', async (_name, match) => {
    const { backend, releases } = scripted(happy(match, () => pgTimeout));
    const answer = await backend.restoreGuild('1', 5, token, () => null, monoIn(40 * SECOND));
    expect(answer).toEqual({ ok: false, reason: 'unavailable', detail: "the database did not answer within the restore's 40 s", timedOut: true });
    expect(backend.connectionState().state).toBe('ready');
    expect(releases).toEqual([true]);
  });

  it.each([
    ['BEGIN', isBegin],
    ['the fenced update', isFenced],
    ['the graveyard insert', isGraveInsert],
  ] as const)('on %s of a retire answers the time-out and notes no outage', async (_name, match) => {
    const { backend, releases } = scripted(happy(match, () => pgTimeout));
    const answer = await backend.retireGuild('1', 'test', token, monoIn(40 * SECOND));
    expect(answer).toEqual({ ok: false, reason: 'unavailable', timedOut: true });
    expect(backend.connectionState().state).toBe('ready');
    expect(releases).toEqual([true]);
  });

  it('reaches the operator as the delete time-out text', async () => {
    const { backend } = scripted(happy(isGraveInsert, () => pgTimeout));
    const ws = setup(new FakeStore());
    setGuildDataBackend(backend);
    const g = freshGuild();
    expect(await ws.hydrate(g, token)).toBe('ready');
    expect(await deleteGuildNamespace(g, 'test', 5 * SECOND)).toEqual({ ok: false, code: 'backend-unavailable', error: DELETE_TIMEOUT });
  });
});

describe('a broken connection stays a connection failure', () => {
  it.each([
    ['EPIPE', epipe, 'write EPIPE'],
    ['a reset', reset, 'read ECONNRESET'],
    ['an ended connection', ended, 'Connection terminated unexpectedly'],
  ] as const)('%s on a restore answers unavailable with its detail and notes the outage', async (_name, error, detail) => {
    const { backend } = scripted(happy(isMove, error));
    const answer = await backend.restoreGuild('1', 5, token, () => null, monoIn(40 * SECOND));
    expect(answer).toEqual({ ok: false, reason: 'unavailable', detail });
    expect(backend.connectionState().state).toBe('outage');
  });

  it.each([
    ['EPIPE', epipe, 'write EPIPE'],
    ['a reset', reset, 'read ECONNRESET'],
    ['an ended connection', ended, 'Connection terminated unexpectedly'],
  ] as const)('%s on a retire answers unavailable with its detail and notes the outage', async (_name, error, detail) => {
    const { backend } = scripted(happy(isGraveInsert, error));
    const answer = await backend.retireGuild('1', 'test', token, monoIn(40 * SECOND));
    expect(answer).toEqual({ ok: false, reason: 'unavailable', detail });
    expect(backend.connectionState().state).toBe('outage');
  });
});
