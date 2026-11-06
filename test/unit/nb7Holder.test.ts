import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GuildRequestSweep, type SweepDeps } from '../../src/bot/internalSetup/fleet/guildRequests';
import { ANSWER_READ_BACK_SQL, ANSWER_SQL, CLEANUP_SQL, REQUEST_CLAIM_SQL, UNANSWERED_BATCHES_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { answerGuildWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { readSourceText } from '../helpers/sourceText';

// NB7 decision 7 and 16: the holder's sweep claims the requests sent to this process, applies each through the IPC
// executor, writes its answer, answers the rows of a claim whose rows never reached it as unapplied, and cleans up.

type Sent = { text: string; values: unknown[]; boundMs: number };
type Answer = (s: Sent) => unknown;

const isClaim = (s: Sent) => s.text === REQUEST_CLAIM_SQL;
const isUnanswered = (s: Sent) => s.text === UNANSWERED_BATCHES_SQL;
const isAnswer = (s: Sent) => s.text === ANSWER_SQL;
const isReadBack = (s: Sent) => s.text === ANSWER_READ_BACK_SQL;
const isCleanup = (s: Sent) => s.text === CLEANUP_SQL;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', guild_id: '4194304', op: 'write', requested_by: 'ALPHA', left_ms: '20000',
  body: JSON.stringify({ module: 'm', filename: 'a.json', contentJson: '{"a":1}', expectSha: 'absent' }),
  ...over,
});

let ids = 0;
function sweep(answer: Answer, over: Partial<SweepDeps> = {}) {
  const sent: Sent[] = [];
  const applied: any[] = [];
  const deps: SweepDeps = {
    db: {
      query: async (text, values, boundMs) => {
        const s = { text, values, boundMs };
        sent.push(s);
        const a = await answer(s);
        if (a instanceof Error) throw a;
        return (a as any) ?? { rows: [], rowCount: 0 };
      },
    },
    processId: () => 'p-a',
    pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
    stoppedServing: () => false,
    isStopping: () => false,
    apply: async req => { applied.push(req); return { ok: true }; },
    newId: () => `b${++ids}`,
    hrtime: () => 1_000_000_000n,
    ...over,
  };
  return { s: new GuildRequestSweep(deps), sent, applied, deps };
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => {
  ids = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the claim', () => {
  it.each([
    ['no pairs', { pairs: () => [] }],
    ['stopped serving', { stoppedServing: () => true }],
    ['stopping', { isStopping: () => true }],
    ['no process id', { processId: () => null }],
  ] as const)('sends no claim with %s', async (_what, over) => {
    const { s, sent } = sweep(() => undefined, over as Partial<SweepDeps>);
    await s.pass();
    expect(sent.filter(isClaim)).toHaveLength(0);
  });

  it('carries the process id, a fresh batch id per statement, the pairs and the free places', async () => {
    const { s, sent } = sweep(() => undefined);
    await s.pass();
    await s.pass();
    const claims = sent.filter(isClaim);
    expect(claims).toHaveLength(2);
    expect(claims[0].values).toEqual(['p-a', 'b1', [2], [1], [9], 16]);
    expect(claims[1].values[1]).toBe('b2');
    expect(claims[0].boundMs).toBe(2000);
  });

  it('sends no claim with 16 applies running, and offers only the free places', async () => {
    const pending: Array<() => void> = [];
    const rows = Array.from({ length: 16 }, (_, i) => row({ id: `r${i}` }));
    let first = true;
    const { s, sent } = sweep(x => {
      if (isClaim(x) && first) { first = false; return { rows }; }
      if (isAnswer(x)) return { rows: [], rowCount: 1 };
      return undefined;
    }, { apply: () => new Promise(resolve => { pending.push(() => resolve({ ok: true })); }) });
    await s.pass();
    await flush();
    expect(s.running()).toBe(16);
    await s.pass();
    expect(sent.filter(isClaim)).toHaveLength(1);
    pending.splice(0, 3).forEach(done => done());
    await flush();
    await s.pass();
    expect(sent.filter(isClaim)[1].values[5]).toBe(3);
  });

  it('sets answerByMono from left_ms for a restore and a namespace delete', async () => {
    const { s, applied } = sweep(x => (isClaim(x) ? { rows: [row({ op: 'restore-graveyard', left_ms: '30000', body: JSON.stringify({ module: '', filename: '', contentJson: '{}' }) })] } : isAnswer(x) ? { rows: [], rowCount: 1 } : undefined));
    await s.pass();
    await flush();
    expect(applied[0]).toMatchObject({ guildId: '4194304', op: 'restore-graveyard', answerByMono: String(1_000_000_000n + 30_000_000_000n) });
  });

  it('a write carries the body fields to the executor', async () => {
    const { s, applied } = sweep(x => (isClaim(x) ? { rows: [row()] } : isAnswer(x) ? { rows: [], rowCount: 1 } : undefined));
    await s.pass();
    await flush();
    expect(applied[0]).toEqual({ guildId: '4194304', op: 'write', module: 'm', filename: 'a.json', contentJson: '{"a":1}', expectSha: 'absent' });
  });
});

describe('unanswered batches', () => {
  it('rows returned after the stop began start nothing; the next pass answers them unapplied, during the stop too', async () => {
    let stopping = false;
    const { s, sent, applied } = sweep(x => {
      if (isClaim(x)) { stopping = true; return { rows: [row()] }; }
      return { rows: [], rowCount: 1 };
    }, { isStopping: () => stopping });
    await s.pass();
    expect(applied).toHaveLength(0);
    expect(s.unanswered()).toEqual(['b1']);
    const firstPass = sent.filter(isUnanswered);
    expect(firstPass).toHaveLength(1);
    expect(firstPass[0].values).toEqual([['b1'], []]);
    await s.pass();
    expect(sent.filter(isClaim)).toHaveLength(1);
    expect(sent.filter(isUnanswered)).toHaveLength(2);
  });

  it('a claim with no answer adds its batch; the statement runs after the claim settled, on every pass, for 1 hour', async () => {
    let n = 0;
    const order: string[] = [];
    const { s, sent } = sweep(x => {
      if (!isCleanup(x)) order.push(isClaim(x) ? 'claim' : isUnanswered(x) ? 'unanswered' : 'other');
      if (isClaim(x) && n++ === 0) return new Error('Query read timeout');
      return undefined;
    });
    await s.pass();
    expect(s.unanswered()).toEqual(['b1']);
    expect(order).toEqual(['claim', 'unanswered']);
    await s.pass();
    expect(order.slice(2)).toEqual(['claim', 'unanswered']);
    expect(sent.filter(isUnanswered).every(x => JSON.stringify(x.values) === JSON.stringify([['b1'], []]))).toBe(true);
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    await s.pass();
    expect(s.unanswered()).toEqual([]);
  });

  it('57P01 and class 08 add the batch; another SQLSTATE takes nothing', async () => {
    const answers = [Object.assign(new Error('x'), { code: '57P01' }), Object.assign(new Error('y'), { code: '08006' }), Object.assign(new Error('z'), { code: '40001' })];
    const { s } = sweep(x => (isClaim(x) ? answers.shift() : undefined));
    await s.pass();
    await s.pass();
    await s.pass();
    expect(s.unanswered()).toEqual(['b1', 'b2']);
  });

  it('never names the batch of a claim that answered', async () => {
    const { s, sent } = sweep(x => (isClaim(x) ? { rows: [row()] } : { rows: [], rowCount: 1 }));
    await s.pass();
    await flush();
    await s.pass();
    expect(sent.filter(isUnanswered)).toHaveLength(0);
  });
});

describe('ruling 8 (NB7-R4-DL1, R4-T1, R4-1): the statement leaves out every request this process started', () => {
  it('a second claim of a started id loses its answer: the statement names its batch and leaves the id out', async () => {
    let claims = 0;
    const { s, sent, applied } = sweep(x => {
      if (isClaim(x)) return ++claims === 1 ? { rows: [row()] } : new Error('Query read timeout');
      return { rows: [], rowCount: 1 };
    });
    await s.pass();
    await flush();
    await s.pass();
    expect(applied).toHaveLength(1);
    expect(s.unanswered()).toEqual(['b2']);
    const statements = sent.filter(isUnanswered);
    expect(statements).toHaveLength(1);
    expect(statements[0].values).toEqual([['b2'], ['r1']]);
  });

  it('a second claim of a started id returns after the stop began: the id stays out, a new id does not', async () => {
    let stopping = false;
    let claims = 0;
    const { s, sent, applied } = sweep(x => {
      if (isClaim(x)) {
        if (++claims === 1) return { rows: [row()] };
        stopping = true;
        return { rows: [row(), row({ id: 'r2' })] };
      }
      return { rows: [], rowCount: 1 };
    }, { isStopping: () => stopping });
    await s.pass();
    await flush();
    await s.pass();
    expect(applied).toHaveLength(1);
    expect(sent.filter(isUnanswered).map(x => x.values)).toEqual([[['b2'], ['r1']]]);
  });

  it('an id started more than an hour ago is still left out', async () => {
    let claims = 0;
    const { s, sent } = sweep(x => {
      if (isClaim(x)) return ++claims === 1 ? { rows: [row()] } : new Error('Query read timeout');
      return { rows: [], rowCount: 1 };
    });
    await s.pass();
    await flush();
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    await s.pass();
    expect(sent.filter(isUnanswered).map(x => x.values)).toEqual([[['b2'], ['r1']]]);
  });
});

describe('the apply and its answer', () => {
  it('the maintenance refusal is answered without the executor (answerGuildWrite, shared with the IPC listener)', async () => {
    setMaintenanceGate({ cause: 'hook', message: 'Back soon' });
    try {
      expect(await answerGuildWrite({ guildId: '4194304', module: 'm', filename: 'a.json', op: 'write', contentJson: '{}' })).toEqual({ ok: false, code: 'maintenance', error: 'Back soon' });
    } finally {
      setMaintenanceGate(null);
    }
    const src = readSourceText(__dirname, '../../src/bot/internalSetup/fleet/guildRequests.ts');
    expect(src).toMatch(/answerGuildWrite/);
  });

  it('a throw answers io-error', async () => {
    const { s, sent } = sweep(x => (isClaim(x) ? { rows: [row()] } : { rows: [], rowCount: 1 }), { apply: async () => { throw new Error('kaput'); } });
    await s.pass();
    await flush();
    const answer = sent.find(isAnswer)!;
    expect(answer.values).toEqual(['r1', 'b1', JSON.stringify({ ok: false, code: 'io-error', error: 'kaput' })]);
    expect(answer.boundMs).toBe(2000);
  });

  it('logs the written line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { s } = sweep(x => (isClaim(x) ? { rows: [row()] } : { rows: [], rowCount: 1 }));
    await s.pass();
    await flush();
    expect(log).toHaveBeenCalledWith('[GuildRequests] write of m/a.json for server 4194304, sent from ALPHA: saved');
  });

  it('retries every 1 s and stops at left_ms + 5 s with the can\'t-confirm line (NB5 H5: an attempt got no answer)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { s, sent } = sweep(x => (isClaim(x) ? { rows: [row({ left_ms: '3000' })] } : isAnswer(x) ? new Error('Connection terminated unexpectedly') : undefined), { apply: async () => ({ ok: true, pending: true }) });
    await s.pass();
    await vi.advanceTimersByTimeAsync(10_000);
    const tries = sent.filter(isAnswer).length;
    expect(tries).toBeGreaterThanOrEqual(7);
    expect(tries).toBeLessThanOrEqual(9);
    expect(error).toHaveBeenCalledWith('[GuildRequests] Can\'t confirm whether the answer to the write of server 4194304 sent from ALPHA was recorded: an attempt that got no answer may have landed, and no later attempt confirmed it (Connection terminated unexpectedly); its sender reads that answer or can\'t confirm. The answer was: accepted, not confirmed as saved yet');
  });

  it('0 rows reads back: its own reply logs the written line and stops', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const mine = JSON.stringify({ ok: true });
    const { s, sent } = sweep(x => (isClaim(x) ? { rows: [row()] } : isAnswer(x) ? { rows: [], rowCount: 0 } : isReadBack(x) ? { rows: [{ state: 'done', reply: mine }] } : undefined));
    await s.pass();
    await flush();
    expect(sent.filter(isAnswer)).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('[GuildRequests] write of m/a.json for server 4194304, sent from ALPHA: saved');
  });

  it.each([
    ['another reply', { rows: [{ state: 'done', reply: '{"ok":false,"code":"not-taken","unapplied":true}' }] }, '{"ok":false,"code":"not-taken","unapplied":true}'],
    ['none', { rows: [] }, 'none'],
  ])('0 rows reads back %s: the other-answer line', async (_what, back, shown) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { s } = sweep(x => (isClaim(x) ? { rows: [row()] } : isAnswer(x) ? { rows: [], rowCount: 0 } : isReadBack(x) ? back : undefined));
    await s.pass();
    await flush();
    expect(warn).toHaveBeenCalledWith(`[GuildRequests] The write of server 4194304 sent from ALPHA was applied (saved), but its row holds another answer (${shown}) or none; its sender may have read that answer or can't confirm`);
  });

  it('the stop step waits for finished applies\' answer writes and ends at 2 s', async () => {
    const gate: { release?: () => void } = {};
    const { s } = sweep(x => (isClaim(x) ? { rows: [row()] } : isAnswer(x) ? new Promise(resolve => { gate.release = () => resolve({ rows: [], rowCount: 1 }); }) : undefined));
    await s.pass();
    await flush();
    let ended = false;
    void s.stopStep().then(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    expect(ended).toBe(true);
    gate.release?.();
  });
});

describe('ruling 6 (NB7-R3-DL1): a request claimed again after a failover behind the same URL', () => {
  it('a second claim of an id this process applied starts nothing and writes the first apply\'s answer under its own batch', async () => {
    const answers: unknown[][] = [];
    const { s, sent, applied } = sweep(x => {
      if (isClaim(x)) return { rows: [row()] };
      if (isAnswer(x)) { answers.push(x.values); return { rows: [], rowCount: 1 }; }
      return undefined;
    }, { apply: async req => { applied.push(req); return { ok: false, code: 'changed', which: 'target', error: 'refused' } as any; } });
    await s.pass();
    await flush();
    await s.pass();
    await flush();
    expect(applied).toHaveLength(1);
    const text = JSON.stringify({ ok: false, code: 'changed', which: 'target', error: 'refused' });
    expect(answers).toEqual([['r1', 'b1', text], ['r1', 'b2', text]]);
    expect(sent.filter(isUnanswered)).toHaveLength(0);
    expect(s.unanswered()).toEqual([]);
  });

  it('a second claim while the first apply runs starts nothing; the latest batch gets the first apply\'s answer once it ends', async () => {
    const answers: unknown[][] = [];
    const finish: Array<() => void> = [];
    let applies = 0;
    const { s, sent } = sweep(x => {
      if (isClaim(x)) return { rows: [row()] };
      if (isAnswer(x)) { answers.push(x.values); return { rows: [], rowCount: x.values[1] === 'b2' ? 1 : 0 }; }
      if (isReadBack(x)) return { rows: [{ state: 'applying', reply: null }] };
      return undefined;
    }, { apply: () => { applies += 1; return new Promise(resolve => { finish.push(() => resolve({ ok: true })); }); } });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await s.pass();
    await flush();
    await s.pass();
    await flush();
    expect(applies).toBe(1);
    expect(answers).toEqual([]);
    finish.shift()!();
    await flush();
    await flush();
    expect(applies).toBe(1);
    const text = JSON.stringify({ ok: true });
    expect(answers).toContainEqual(['r1', 'b2', text]);
    expect(answers.every(a => a[2] === text)).toBe(true);
    expect(sent.filter(isUnanswered)).toHaveLength(0);
  });

  it('another id in the same claim is applied as usual', async () => {
    let n = 0;
    const { s, applied } = sweep(x => {
      if (isClaim(x)) return { rows: n++ === 0 ? [row()] : [row(), row({ id: 'r2' })] };
      return { rows: [], rowCount: 1 };
    });
    await s.pass();
    await flush();
    await s.pass();
    await flush();
    expect(applied).toHaveLength(2);
  });
});

describe('the sweep\'s log and cleanup', () => {
  it('logs a failing claim once, again after 30 s, and the recovery at the next answer', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let failing = true;
    const { s } = sweep(x => (isClaim(x) && failing ? Object.assign(new Error('refused'), { code: '42501' }) : undefined));
    const line = "[GuildRequests] Cannot read the changes sent from other machines' panels (SQLSTATE 42501: refused); they are refused until this works";
    await s.pass();
    await s.pass();
    expect(error.mock.calls.filter(c => c[0] === line)).toHaveLength(1);
    vi.advanceTimersByTime(30_001);
    await s.pass();
    expect(error.mock.calls.filter(c => c[0] === line)).toHaveLength(2);
    failing = false;
    await s.pass();
    expect(log).toHaveBeenCalledWith("[GuildRequests] Reading the changes sent from other machines' panels works again");
  });

  it('cleans up every 60 s, also with no pairs', async () => {
    const { s, sent } = sweep(() => undefined, { pairs: () => [] });
    await s.pass();
    expect(sent.filter(isCleanup)).toHaveLength(1);
    expect(sent.filter(isCleanup)[0].boundMs).toBe(5000);
    await s.pass();
    expect(sent.filter(isCleanup)).toHaveLength(1);
    vi.advanceTimersByTime(60_001);
    await s.pass();
    expect(sent.filter(isCleanup)).toHaveLength(2);
  });

  it('starts at the guild report, on Postgres only', () => {
    const src = readSourceText(__dirname, '../../src/bot/internalSetup/clientInitializer.ts');
    const report = src.indexOf("reportWriterStage('guild');");
    const start = src.indexOf('startGuildRequestSweep(');
    expect(report).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(report);
    const sweepSrc = readSourceText(__dirname, '../../src/bot/internalSetup/fleet/guildRequests.ts');
    expect(sweepSrc).toMatch(/if \(sweep \|\| resolveDataBackend\(\) !== 'postgres'\) return;/);
  });
});
