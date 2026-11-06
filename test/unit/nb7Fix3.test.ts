import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetGuildRequests,
  _setGuildRequestDeps,
  endGuildRequests,
  remoteNoAnswerText,
  remoteRestoreNoAnswerCause,
  sendGuildChange,
  SERVER_IDENTITY_SQL,
  type RequestDb,
} from '../../src/webui/utils/guildRequests';
import { GuildRequestSweep, type SweepDb } from '../../src/bot/internalSetup/fleet/guildRequests';
import type { DataWriteReply } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import {
  ANSWER_READ_BACK_SQL,
  ANSWER_SQL,
  REQUEST_CLAIM_SQL,
  REQUEST_POLL_SQL,
  SETTLE_UPDATE_SQL,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { fakeBot, fakeTime, GUILD, heldRow, requestPlan, writeOf } from '../helpers/nb7Rig';
import { setBackendKind } from '../helpers/backendKind';

// NB7 code review round 3: a request claimed again after a failover is answered with its first apply's outcome
// (ruling 6, NB7-R3-DL1), the route's answer after the exit when the holder had answered (NB7-R2-1, NB7-R3-M1), and
// the server identity read from the server instance (NB7-R3-1).

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

describe('ruling 6 (NB7-R3-DL1): the same request returned by a second claim is not applied again', () => {
  const row = { id: 'r1', guild_id: GUILD, op: 'write', body: JSON.stringify({ module: 'm', filename: 'a.json', contentJson: '{"a":1}', expectSha: 'absent' }), requested_by: 'ALPHA', left_ms: '15000' };
  let claims: any[][];
  let answers: Array<{ batch: string; text: string }>;
  let applies: number;
  let finishApply: (reply: DataWriteReply) => void;
  let batchNo: number;

  function sweepOf(): GuildRequestSweep {
    const db: SweepDb = {
      query: async (text, values) => {
        if (text === REQUEST_CLAIM_SQL) return { rows: claims.shift() ?? [] };
        if (text === ANSWER_SQL) {
          answers.push({ batch: String(values[1]), text: String(values[2]) });
          return { rows: [], rowCount: 1 };
        }
        if (text === ANSWER_READ_BACK_SQL) return { rows: [] };
        return { rows: [], rowCount: 0 };
      },
    };
    return new GuildRequestSweep({
      db,
      processId: () => 'p-b',
      pairs: () => [{ shardCount: 2, shardId: 1, claim: 4 }],
      stoppedServing: () => false,
      isStopping: () => false,
      apply: () => {
        applies += 1;
        return new Promise<DataWriteReply>(resolve => { finishApply = resolve; });
      },
      newId: () => `b${++batchNo}`,
    });
  }

  beforeEach(() => {
    claims = [];
    answers = [];
    applies = 0;
    batchNo = 0;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('claimed again while its apply runs: one apply, and the later claim\'s batch gets the first apply\'s outcome', async () => {
    const sweep = sweepOf();
    claims = [[row], [row]];
    await sweep.pass();
    await sweep.pass();
    expect(applies).toBe(1);
    finishApply({ ok: true });
    await flush();
    expect(answers).toEqual([{ batch: 'b2', text: '{"ok":true}' }]);
    expect(applies).toBe(1);
  });

  it('claimed again after its answer was written: the later claim\'s batch gets the same answer, nothing is applied again', async () => {
    const sweep = sweepOf();
    claims = [[row]];
    await sweep.pass();
    finishApply({ ok: false, code: 'changed', error: 'This file changed' });
    await flush();
    claims = [[row]];
    await sweep.pass();
    await flush();
    expect(applies).toBe(1);
    const text = JSON.stringify({ ok: false, code: 'changed', error: 'This file changed' });
    expect(answers).toEqual([{ batch: 'b1', text }, { batch: 'b2', text }]);
  });

  it('another request id is applied as usual', async () => {
    const sweep = sweepOf();
    claims = [[row], [{ ...row, id: 'r2' }]];
    await sweep.pass();
    await sweep.pass();
    expect(applies).toBe(2);
  });
});

describe('NB7-R2-1 and NB7-R3-M1: after the exit, an answer the holder already gave is the route\'s answer', () => {
  type Deferred = { promise: Promise<any>; resolve: (v: any) => void };
  const deferred = (): Deferred => {
    let resolve!: (v: any) => void;
    const promise = new Promise<any>(r => { resolve = r; });
    return { promise, resolve };
  };
  const pollRow = (state: string, reply: string | null = null) => ({ rows: [{ state, reply, pickup_over: false, answer_over: false }] });
  let script: (sql: string) => unknown;

  beforeEach(() => {
    script = () => undefined;
    fakeTime();
    _resetGuildRequests();
    _setGuildRequestDeps({
      holderOf: async () => ({ rows: [heldRow()] }),
      readDoc: async () => null,
      currentUrl: () => 'postgres://current',
      requestDb: (): RequestDb => ({
        connect: async () => ({
          server: 'S1',
          query: (sql: string) => {
            const value = script(sql);
            return value instanceof Promise ? value : Promise.resolve(value ?? { rows: [], rowCount: 0 });
          },
          release: () => undefined,
        }),
        end: async () => undefined,
      }),
      nodeId: () => 'n-a',
      nodeName: () => 'ALPHA',
    });
    setBackendKind('postgres');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    _setGuildRequestDeps(null);
    _resetGuildRequests();
    setBackendKind(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function send() {
    const plan = await requestPlan('write');
    let value: any;
    void sendGuildChange(fakeBot().bot, plan, writeOf()).then(v => { value = v; });
    return async () => { await vi.advanceTimersByTimeAsync(1000); return value; };
  }

  it('the poll on the wire at the exit reads a done row: the holder\'s answer, not can\'t confirm', async () => {
    const gate = deferred();
    script = sql => (sql === REQUEST_POLL_SQL ? gate.promise : sql === SETTLE_UPDATE_SQL ? { rows: [] } : undefined);
    const result = await send();
    await vi.advanceTimersByTimeAsync(10);
    const exit = endGuildRequests();
    gate.resolve(pollRow('done', '{"ok":true}'));
    const reply = await result();
    await exit;
    expect(reply).toMatchObject({ ok: true, servedBy: 'BRAVO' });
    expect(reply.noAnswer).toBeUndefined();
  });

  it('the poll on the wire at the exit reads a done refusal: that refusal', async () => {
    const gate = deferred();
    script = sql => (sql === REQUEST_POLL_SQL ? gate.promise : sql === SETTLE_UPDATE_SQL ? { rows: [] } : undefined);
    const result = await send();
    await vi.advanceTimersByTimeAsync(10);
    const exit = endGuildRequests();
    gate.resolve(pollRow('done', '{"ok":false,"code":"changed","error":"This file changed"}'));
    const reply = await result();
    await exit;
    expect(reply).toMatchObject({ ok: false, code: 'changed', servedBy: 'BRAVO' });
    expect(reply.noAnswer).toBeUndefined();
  });

  it('the row was applying before the exit and the exit\'s read finds it done: the holder\'s answer', async () => {
    let exited = false;
    script = sql => {
      if (sql === REQUEST_POLL_SQL) return exited ? pollRow('done', '{"ok":true}') : pollRow('applying');
      if (sql === SETTLE_UPDATE_SQL) return { rows: [] };
      return undefined;
    };
    const result = await send();
    await vi.advanceTimersByTimeAsync(300);
    exited = true;
    const exit = endGuildRequests();
    const reply = await result();
    await exit;
    expect(reply).toMatchObject({ ok: true, servedBy: 'BRAVO' });
  });

  it('the row is still applying at the exit\'s read: can\'t confirm, worded for a panel that shut down', async () => {
    script = sql => (sql === REQUEST_POLL_SQL ? pollRow('applying') : sql === SETTLE_UPDATE_SQL ? { rows: [] } : undefined);
    const result = await send();
    await vi.advanceTimersByTimeAsync(300);
    const exit = endGuildRequests();
    const reply = await result();
    await exit;
    expect(reply).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'stopped', servedBy: 'BRAVO' });
  });

  it('the shutdown texts do not claim the holder\'s state', () => {
    expect(remoteNoAnswerText('stopped', 'BRAVO', 'write')).toBe("This web panel shut down before it read the answer from BRAVO; can't confirm whether the change was saved. Reload once the panel is back to check.");
    expect(remoteNoAnswerText('stopped', 'BRAVO', 'delete')).toBe("This web panel shut down before it read the answer from BRAVO; can't confirm whether the file was deleted. Reload once the panel is back to check.");
    expect(remoteNoAnswerText('timeout', 'BRAVO', 'write')).toBe("BRAVO did not answer in time; can't confirm whether the change was saved. Reload to check.");
    expect(remoteRestoreNoAnswerCause('stopped', 'BRAVO')).toBe('this web panel shut down before it read the answer from BRAVO');
  });
});

describe('NB7-R3-1: the server identity is read from the server instance', () => {
  it('uses the system identifier and the start time, not the connection\'s address', () => {
    expect(SERVER_IDENTITY_SQL).toMatch(/pg_control_system\(\)/);
    expect(SERVER_IDENTITY_SQL).toMatch(/pg_postmaster_start_time\(\)/);
    expect(SERVER_IDENTITY_SQL).not.toMatch(/inet_server_addr|inet_server_port/);
  });
});
