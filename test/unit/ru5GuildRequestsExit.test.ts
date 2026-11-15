import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetGuildRequests,
  _setGuildRequestDeps,
  endGuildRequests,
  guildRequestsExiting,
  NB7_TEXTS,
  runGuildRequest,
  sendGuildChange,
  sendMembership,
  type Plan,
  type PanelPlan,
  type RemoteHolder,
  type RequestConn,
  type RequestDb,
} from '../../src/webui/utils/guildRequests';
import {
  changeDeadlineMs,
  POLL_SET_SQL,
  REPLY_READ_SQL,
  REQUEST_INSERT_SQL,
  REQUEST_POLL_SQL,
  SETTLE_INSERT_SQL,
  SETTLE_UPDATE_SQL,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';

// The request route at the web UI's exit (decision 14): the route's answer once the exit settled or read its row, the
// exit's log line per request, and the bounds the exit's statements run under.

const GUILD = String(1n << 22n);
const HANG = Symbol('hang');
const HOLDER: RemoteHolder = { shardCount: 2, shardId: 1, processId: 'p-b', name: 'BRAVO', url: 'postgres://one' };

interface Script {
  poll?: () => unknown;
  settle?: () => unknown;
  read?: () => unknown;
  reply?: () => unknown;
}
interface Sent { sql: string; values: unknown[]; bound: number; afterExit: boolean }

let script: Script;
let statements: Sent[];
let exited: boolean;
let server: string;
let transport: 'verified' | 'unprotected';
let logs: { log: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> };

const row = (state: string, over: Record<string, unknown> = {}) => ({ state, pickup_over: false, answer_over: false, ...over });
const later = (ms: number, value: unknown) => new Promise(resolve => { setTimeout(() => resolve(value), ms); });

/** A statement's answer as the server gives it within the statement's bound (query_timeout). */
function answerOf(value: unknown, bound: number): Promise<any> {
  if (value instanceof Error) return Promise.reject(value);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Query read timeout')), bound);
    if (value === HANG) return;
    Promise.resolve(value ?? { rows: [], rowCount: 0 }).then(
      r => { clearTimeout(timer); resolve(r); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

function rowsOf(value: unknown): unknown {
  if (value instanceof Promise) return value.then(rowsOf);
  if (value instanceof Error || value === HANG) return value;
  return { rows: value ? [value] : [], rowCount: value ? 1 : 0 };
}

function handle(sql: string, values: unknown[]): unknown {
  if (sql === REQUEST_INSERT_SQL) return { rows: [], rowCount: 1 };
  if (sql === POLL_SET_SQL) {
    const r = script.poll?.();
    if (r && typeof r === 'object' && !(r instanceof Error) && !(r instanceof Promise)) return { rows: [{ id: (values[0] as string[])[0], ...r }], rowCount: 1 };
    return rowsOf(r);
  }
  if (sql === SETTLE_UPDATE_SQL || sql === SETTLE_INSERT_SQL) return script.settle ? script.settle() : { rows: [] };
  if (sql === REQUEST_POLL_SQL) return rowsOf(script.read?.());
  if (sql === REPLY_READ_SQL) return rowsOf(script.reply?.());
  return undefined;
}

const makeDb = (): RequestDb => ({
  connect: async (): Promise<RequestConn> => ({
    get server() { return server; },
    get transport() { return transport; },
    query: (sql: string, values: unknown[], bound: number) => {
      statements.push({ sql, values, bound, afterExit: exited });
      return answerOf(handle(sql, values), bound);
    },
    release: () => undefined,
  }),
  end: async () => undefined,
});

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function sendWrite(): { answer?: any } {
  const plan: Plan = { kind: 'request', op: 'write', deadline: performance.now() + changeDeadlineMs('write'), holder: HOLDER };
  const sent: { answer?: any } = {};
  void sendGuildChange({} as any, plan, { guildId: GUILD, module: 'm', filename: 'a.json', op: 'write', contentJson: '{"a":1}', expectSha: 'absent' } as any)
    .then(a => { sent.answer = a; });
  return sent;
}

function sendPanel(op: 'panel:execute'): { answer?: any } {
  const plan: PanelPlan = { kind: 'request', op, guildId: GUILD, audience: 'owner', deadline: performance.now() + changeDeadlineMs(op), holder: HOLDER };
  const sent: { answer?: any } = {};
  void runGuildRequest(plan, { panelId: 'p1' }, async () => ({})).then(a => { sent.answer = a; });
  return sent;
}

function sendRead(): { answer?: any } {
  const sent: { answer?: any } = {};
  void sendMembership(HOLDER, [GUILD], 'u1', performance.now() + changeDeadlineMs('guild:membership')).then(a => { sent.answer = a; });
  return sent;
}

function exit(): Promise<void> {
  exited = true;
  return endGuildRequests();
}

async function settleExit(done: Promise<void>, ms = 2500): Promise<void> {
  let ended = false;
  void done.then(() => { ended = true; });
  for (let i = 0; i < ms / 50 && !ended; i++) await vi.advanceTimersByTimeAsync(50);
  await done;
  await vi.advanceTimersByTimeAsync(300);
}

const logged = () => logs.log.mock.calls.map((c: unknown[]) => String(c[0]));
const errored = () => logs.error.mock.calls.map((c: unknown[]) => String(c[0]));
const exitReads = () => statements.filter(s => s.sql === REQUEST_POLL_SQL);
const settles = () => statements.filter(s => s.sql === SETTLE_UPDATE_SQL || s.sql === SETTLE_INSERT_SQL);

const unknownLine = (op: string, words: string) => `[Main] Exiting; can't confirm whether the ${op} of server ${GUILD} sent to BRAVO ${words}`;
const withdrewLine = (op: string, words: string) => `[Main] Exiting: withdrew the ${op} of server ${GUILD} sent to BRAVO; ${words}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  script = {};
  statements = [];
  exited = false;
  server = 'S1';
  transport = 'verified';
  _resetGuildRequests();
  const db = makeDb();
  _setGuildRequestDeps({ currentUrl: () => HOLDER.url, requestDb: () => db, nodeId: () => 'n-a', nodeName: () => 'ALPHA' });
  logs = {
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  _setGuildRequestDeps(null);
  _resetGuildRequests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the route\'s answer once the web UI exits (stopAnswer)', () => {
  it('the exit\'s own settle withdraws after the follow stopped: "withdrawn at exit", nothing was saved', async () => {
    let free!: (v: unknown) => void;
    script.poll = () => row('pending');
    script.settle = () => new Promise(resolve => { free = resolve; });
    const sent = sendWrite();
    await vi.advanceTimersByTimeAsync(300);
    const done = exit();
    await vi.advanceTimersByTimeAsync(300);
    expect(sent.answer).toBeUndefined();
    free({ rows: [{ state: 'expired', pickup_over: true }] });
    await settleExit(done);
    expect(sent.answer).toMatchObject({ ok: false, code: 'not-taken', error: NB7_TEXTS.withdrawnAtExit('BRAVO', 'saved') });
    expect(logged()).toContain(withdrewLine('write', 'nothing was saved'));
  });

  it('the exit reads the row done with the holder\'s ok after a poll failed: the holder\'s answer and its log line', async () => {
    script.poll = () => (exited ? new Error('connection lost') : row('applying'));
    script.read = () => later(300, row('done', { reply: '{"ok":true}' }));
    const sent = sendWrite();
    await vi.advanceTimersByTimeAsync(300);
    const done = exit();
    await settleExit(done);
    await vi.advanceTimersByTimeAsync(10);
    expect(sent.answer).toMatchObject({ ok: true, servedBy: 'BRAVO' });
    expect(sent.answer.noAnswer).toBeUndefined();
    expect(logged()).toContain(`[Main] Exiting: BRAVO answered the write of server ${GUILD}: saved`);
  });

  it('the exit reads a done "did not apply" before claim_by: can\'t confirm, logged as an error', async () => {
    script.poll = () => (exited ? new Error('connection lost') : row('applying'));
    script.read = () => row('done', { reply: '{"ok":false,"code":"not-taken","unapplied":true}' });
    const sent = sendWrite();
    await vi.advanceTimersByTimeAsync(300);
    const done = exit();
    await settleExit(done);
    await vi.advanceTimersByTimeAsync(10);
    expect(sent.answer).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'stopped' });
    expect(errored()).toEqual([unknownLine('write', 'was saved')]);
    expect(logged()).toEqual([]);
  });

  it('the exit reads the row expired after claim_by on the insert\'s server: nothing was saved', async () => {
    script.poll = () => (exited ? new Error('connection lost') : row('applying'));
    script.read = () => row('expired', { pickup_over: true });
    const sent = sendWrite();
    await vi.advanceTimersByTimeAsync(300);
    const done = exit();
    await settleExit(done);
    await vi.advanceTimersByTimeAsync(10);
    expect(sent.answer).toMatchObject({ ok: false, code: 'not-taken', error: NB7_TEXTS.withdrawnAtExit('BRAVO', 'saved') });
    expect(logged()).toEqual([withdrewLine('write', 'nothing was saved')]);
  });

  it('a hung exit settle still answers the route by the exit\'s 2 s', async () => {
    script.poll = () => row('pending');
    const sent = sendWrite();
    await vi.advanceTimersByTimeAsync(10_000);
    script.settle = () => HANG;
    script.read = () => row('pending');
    const done = exit();
    await settleExit(done);
    await vi.advanceTimersByTimeAsync(500);
    expect(sent.answer).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'stopped' });
  });

  it('a hung exit read still answers the route by the exit\'s 2 s', async () => {
    script.poll = () => row('pending');
    const sent = sendWrite();
    await vi.advanceTimersByTimeAsync(10_000);
    script.read = () => HANG;
    const done = exit();
    await settleExit(done);
    await vi.advanceTimersByTimeAsync(500);
    expect(sent.answer).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'stopped' });
  });

  it('an exit settle that answers in 500 ms withdraws within the exit\'s 2 s', async () => {
    script.poll = () => row('pending');
    script.settle = () => later(500, { rows: [{ state: 'expired', pickup_over: true }] });
    script.read = () => row('pending');
    const sent = sendWrite();
    await vi.advanceTimersByTimeAsync(300);
    const done = exit();
    await settleExit(done);
    await vi.advanceTimersByTimeAsync(10);
    expect(logged()).toEqual([withdrewLine('write', 'nothing was saved')]);
    expect(sent.answer).toMatchObject({ ok: false, code: 'not-taken', error: NB7_TEXTS.withdrawnAtExit('BRAVO', 'saved') });
  });
});

describe('the follow\'s end without an exit', () => {
  it('pending to the end and every settle failed: the answer could not be read (lost), not a timeout', async () => {
    script.poll = () => row('pending');
    script.settle = () => new Error('connection reset');
    const sent = sendWrite();
    for (let i = 0; i < 70 && !sent.answer; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(sent.answer).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'lost' });
  });
});

describe('the exit\'s statements', () => {
  it('no request followed: the exit ends at once and leaves no timer', async () => {
    await endGuildRequests();
    expect(guildRequestsExiting()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an exit settle that withdrew reads no row after it', async () => {
    script.poll = () => (exited ? new Error('connection lost') : row('pending'));
    script.settle = () => ({ rows: [{ state: 'expired', pickup_over: true }] });
    script.read = () => row('done', { reply: '{"ok":true}' });
    const sent = sendWrite();
    await vi.advanceTimersByTimeAsync(300);
    const done = exit();
    await settleExit(done);
    await vi.advanceTimersByTimeAsync(10);
    expect(exitReads()).toEqual([]);
    expect(logged()).toEqual([withdrewLine('write', 'nothing was saved')]);
    expect(sent.answer).toMatchObject({ code: 'not-taken', error: NB7_TEXTS.withdrawnAtExit('BRAVO', 'saved') });
  });

  it('an exit settle that withdrew on another server instance reads no row and can\'t confirm', async () => {
    script.poll = () => (exited ? new Error('connection lost') : row('pending'));
    script.settle = () => ({ rows: [{ state: 'expired', pickup_over: true }] });
    script.read = () => row('done', { reply: '{"ok":true}' });
    const sent = sendWrite();
    await vi.advanceTimersByTimeAsync(300);
    server = 'S2';
    const done = exit();
    await settleExit(done);
    await vi.advanceTimersByTimeAsync(10);
    expect(exitReads()).toEqual([]);
    expect(errored()).toEqual([unknownLine('write', 'was saved')]);
    expect(sent.answer).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'stopped' });
  });

  it('the exit\'s read carries an answer, so it is not sent on an unprotected connection', async () => {
    script.poll = () => (exited ? new Error('connection lost') : row('applying'));
    script.read = () => row('done', { reply: '{"ok":true}' });
    const sent = sendWrite();
    await vi.advanceTimersByTimeAsync(300);
    transport = 'unprotected';
    const done = exit();
    await settleExit(done);
    await vi.advanceTimersByTimeAsync(10);
    expect(exitReads()).toEqual([]);
    expect(sent.answer).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'stopped' });
    expect(errored()).toEqual([unknownLine('write', 'was saved')]);
  });

  it('the exit lands right after the route\'s own withdrawal: one settle, one "withdrew" line', async () => {
    let done: Promise<void> | null = null;
    let armed = false;
    script.poll = () => row('pending', { pickup_over: true });
    script.read = () => new Error('connection lost');
    script.settle = () => {
      if (armed) return { rows: [] };
      armed = true;
      return {
        rows: [{
          state: 'expired',
          get pickup_over() {
            queueMicrotask(async () => { await Promise.resolve(); done = exit(); });
            return true;
          },
        }],
      };
    };
    const sent = sendWrite();
    for (let i = 0; i < 20 && !done; i++) await vi.advanceTimersByTimeAsync(50);
    expect(done).not.toBeNull();
    await settleExit(done!);
    await vi.advanceTimersByTimeAsync(10);
    expect(settles()).toHaveLength(1);
    expect(logged()).toEqual([withdrewLine('write', 'nothing was saved')]);
    expect(errored()).toEqual([]);
    expect(sent.answer).toMatchObject({ ok: false, code: 'not-taken' });
  });
});

describe('the exit\'s log line for a change\'s done row', () => {
  async function exitWithDone(reply: string): Promise<{ answer?: any }> {
    script.poll = () => (exited ? new Error('connection lost') : row('applying'));
    script.read = () => row('done', { reply });
    const sent = sendWrite();
    await vi.advanceTimersByTimeAsync(300);
    const done = exit();
    await settleExit(done);
    await vi.advanceTimersByTimeAsync(10);
    return sent;
  }

  it('a reply that is not JSON: "an answer that could not be read"', async () => {
    await exitWithDone('not json');
    expect(logged()).toEqual([`[Main] Exiting: BRAVO answered the write of server ${GUILD}: an answer that could not be read`]);
  });

  it('a refusal: its code, never "saved"', async () => {
    await exitWithDone('{"ok":false,"code":"changed","error":"This file changed"}');
    expect(logged()).toEqual([`[Main] Exiting: BRAVO answered the write of server ${GUILD}: a refusal with code changed`]);
  });

  it('a JSON null reply: a refusal with code none, and the exit ends', async () => {
    const sent = await exitWithDone('null');
    expect(logged()).toEqual([`[Main] Exiting: BRAVO answered the write of server ${GUILD}: a refusal with code none`]);
    expect(sent.answer).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'lost' });
  });
});

describe('the exit\'s log words for NB15\'s ops', () => {
  it('a panel action still applying: "runs" and "can\'t confirm whether it ran"', async () => {
    script.poll = () => row('applying');
    script.read = () => row('applying');
    sendPanel('panel:execute');
    await vi.advanceTimersByTimeAsync(300);
    await settleExit(exit());
    expect(errored()).toEqual([`[Main] Exiting while BRAVO runs the panel:execute of server ${GUILD}; can't confirm whether it ran`]);
  });

  it('a panel action withdrawn at the exit: "nothing was run"', async () => {
    script.poll = () => row('pending');
    script.settle = () => ({ rows: [{ state: 'expired', pickup_over: true }] });
    const sent = sendPanel('panel:execute');
    await vi.advanceTimersByTimeAsync(300);
    await settleExit(exit());
    await vi.advanceTimersByTimeAsync(10);
    expect(logged()).toEqual([withdrewLine('panel:execute', 'nothing was run')]);
    expect(sent.answer?.reply).toMatchObject({ success: false, code: 'not-taken' });
  });

  it('a read withdrawn at the exit: "nothing was read"', async () => {
    script.poll = () => row('pending');
    script.settle = () => ({ rows: [{ state: 'expired', pickup_over: true }] });
    sendRead();
    await vi.advanceTimersByTimeAsync(300);
    await settleExit(exit());
    expect(logged()).toEqual([withdrewLine('guild:membership', 'nothing was read')]);
  });

  it('a read the exit could not settle or read: "can\'t confirm whether ... was read"', async () => {
    script.poll = () => row('pending');
    script.read = () => new Error('connection lost');
    sendRead();
    await vi.advanceTimersByTimeAsync(300);
    await settleExit(exit());
    expect(errored()).toEqual([unknownLine('guild:membership', 'was read')]);
  });
});
