import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakePools = vi.hoisted(() => [] as any[]);
const fakeServer = vi.hoisted(() => ({ script: (_text: string): unknown => undefined, identity: 'S1' }));

vi.mock('pg', async importOriginal => {
  const real = await importOriginal<typeof import('pg')>();
  const { EventEmitter: Emitter } = await import('events');
  class FakeClient extends Emitter {
    queries: string[] = [];
    released: unknown[] = [];
    async query(config: any) {
      const text = typeof config === 'string' ? config : config.text;
      this.queries.push(text);
      if (text.includes('pg_postmaster_start_time')) return { rows: [{ server: fakeServer.identity }] };
      const answer = fakeServer.script(text);
      if (answer instanceof Error) throw answer;
      return answer ?? { rows: [], rowCount: 0 };
    }
    release(destroy?: unknown) { this.released.push(destroy); }
  }
  class FakePool extends Emitter {
    clients: FakeClient[] = [];
    totalCount = 0;
    idleCount = 0;
    constructor(public options: any) {
      super();
      fakePools.push(this);
    }
    async connect() {
      const client = new FakeClient();
      this.clients.push(client);
      this.emit('connect', client);
      return client;
    }
    async end() { /* nothing to close */ }
  }
  return { ...real, Pool: FakePool, default: { ...(real as any).default, Pool: FakePool } };
});

import {
  _resetGuildRequests,
  _setGuildRequestDeps,
  endGuildRequests,
  NB7_TEXTS,
  remoteNoAnswerText,
  remoteRestoreNoAnswerCause,
  runHolderCheck,
  sendGuildChange,
  type RequestDb,
} from '../../src/webui/utils/guildRequests';
import { readServedGuild } from '../../src/webui/utils/servedRead';
import { GuildRequestSweep, notServedHereText, _setLookupDb } from '../../src/bot/internalSetup/fleet/guildRequests';
import {
  REQUEST_CLAIM_SQL,
  REQUEST_INSERT_SQL,
  REQUEST_POLL_SQL,
  SETTLE_INSERT_SQL,
  SETTLE_UPDATE_SQL,
  UNANSWERED_BATCHES_SQL,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { fakeBot, fakeTime, GUILD, heldRow, requestPlan, writeOf } from '../helpers/nb7Rig';
import { setBackendKind } from '../helpers/backendKind';

// NB7 code review round 1: the fixes for NB7-DL1 with NB7-RS-2 (a withdrawal counts only on the insert's server
// instance), NB7-RS-3 with NB7-M1 (one settle per request and a true exit line), NB7-M2 (the request goes to the
// database the holder check read), NB7-RS-4 and NB7-RS-5 (the local plan's read refusals), NB7-DL2 (the holder's stop
// answers unapplied batches) and NB7-RS-1 (both new pools keep an error listener on every client).

type Sent = { sql: string; server: string; url: string };
const HANG = Symbol('hang');

function answerOf(value: unknown, boundMs: number): Promise<any> {
  if (value === HANG) return new Promise((_, reject) => { setTimeout(() => reject(new Error('Query read timeout')), boundMs); });
  if (value instanceof Error) return Promise.reject(value);
  if (value instanceof Promise) return value;
  return Promise.resolve(value ?? { rows: [], rowCount: 0 });
}

const lost = () => new Error('Connection terminated unexpectedly');
const poll = (state: string, over: Record<string, unknown> = {}) => ({ rows: [{ state, reply: null, pickup_over: false, answer_over: false, ...over }] });

let server = 'S1';
let sent: Sent[] = [];
let script: (sql: string) => unknown = () => undefined;
let holderUrl: string | undefined;

function install(): void {
  _resetGuildRequests();
  _setGuildRequestDeps({
    holderOf: async () => ({ rows: [heldRow()], ...(holderUrl ? { url: holderUrl } : {}) }),
    readDoc: async () => null,
    currentUrl: () => 'postgres://current',
    requestDb: (url: string): RequestDb => ({
      connect: async () => {
        const at = server;
        return {
          server: at,
          query: (sql: string, _values: unknown[], boundMs: number) => {
            sent.push({ sql, server: at, url });
            return answerOf(script(sql), boundMs);
          },
          release: () => undefined,
        };
      },
      end: async () => undefined,
    }),
    nodeId: () => 'n-a',
    nodeName: () => 'ALPHA',
  });
  setBackendKind('postgres');
}

async function send() {
  const plan = await requestPlan('write');
  let value: any;
  void sendGuildChange(fakeBot().bot, plan, writeOf()).then(v => { value = v; });
  return { plan, result: async (ms = 120_000) => { await vi.advanceTimersByTimeAsync(ms); return value; } };
}

const count = (sql: string) => sent.filter(s => s.sql === sql).length;

beforeEach(() => {
  server = 'S1';
  sent = [];
  script = () => undefined;
  holderUrl = undefined;
  fakeTime();
  install();
});
afterEach(() => {
  _setGuildRequestDeps(null);
  _resetGuildRequests();
  setBackendKind(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('NB7-DL1 and NB7-RS-2: "nothing was saved" only with the row shown never claimed', () => {
  it('an insert with no answer, then a settle that inserts the row on another server instance: can\'t confirm', async () => {
    script = sql => {
      if (sql === REQUEST_INSERT_SQL) {
        server = 'S2';
        return lost();
      }
      if (sql === SETTLE_INSERT_SQL) return { rows: [{ state: 'expired' }] };
      return undefined;
    };
    const { result } = await send();
    const value = await result(5000);
    expect(value).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'unsettled', servedBy: 'BRAVO' });
    expect(count(SETTLE_INSERT_SQL)).toBe(1);
  });

  it('the same settle on the insert\'s server instance: withdrawn, nothing was saved', async () => {
    script = sql => (sql === REQUEST_INSERT_SQL ? lost() : sql === SETTLE_INSERT_SQL ? { rows: [{ state: 'expired' }] } : undefined);
    const { result } = await send();
    expect(await result(5000)).toMatchObject({ ok: false, code: 'backend-unavailable', error: NB7_TEXTS.withdrawn('BRAVO', 'saved') });
  });

  it('a settle that committed but lost its answer, a retry that finds no pending row, then \'expired\': the withdrawn text', async () => {
    let settles = 0;
    script = sql => {
      if (sql === REQUEST_INSERT_SQL) return lost();
      if (sql === SETTLE_INSERT_SQL) return ++settles === 1 ? lost() : { rows: [] };
      if (sql === REQUEST_POLL_SQL) return poll('expired');
      return undefined;
    };
    const { result } = await send();
    const value = await result(10_000);
    expect(value).toMatchObject({ ok: false, code: 'backend-unavailable', error: NB7_TEXTS.withdrawn('BRAVO', 'saved') });
    expect(value.error).not.toBe(NB7_TEXTS.notTaken('BRAVO', 'saved'));
  });

  it('the same, with \'expired\' read on another server instance: can\'t confirm', async () => {
    let settles = 0;
    script = sql => {
      if (sql === REQUEST_INSERT_SQL) return lost();
      if (sql === SETTLE_INSERT_SQL) {
        settles += 1;
        if (settles === 1) return lost();
        server = 'S2';
        return { rows: [] };
      }
      if (sql === REQUEST_POLL_SQL) return poll('expired');
      return undefined;
    };
    const { result } = await send();
    expect(await result(10_000)).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'unsettled' });
  });

  it('an acknowledged insert whose pending row is settled on another server instance: can\'t confirm', async () => {
    script = sql => {
      if (sql === REQUEST_POLL_SQL) {
        server = 'S2';
        return poll('pending', { pickup_over: true });
      }
      if (sql === SETTLE_UPDATE_SQL) return { rows: [{ state: 'expired' }] };
      return undefined;
    };
    const { result } = await send();
    expect(await result(2000)).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'unsettled' });
  });

  it('an acknowledged insert settled on its own server instance: not taken, nothing was saved', async () => {
    script = sql => (sql === REQUEST_POLL_SQL ? poll('pending', { pickup_over: true }) : sql === SETTLE_UPDATE_SQL ? { rows: [{ state: 'expired' }] } : undefined);
    const { result } = await send();
    expect(await result(2000)).toMatchObject({ ok: false, code: 'not-taken', error: NB7_TEXTS.notTaken('BRAVO', 'saved') });
  });

  it('the unsettled texts say can\'t confirm and how to check', () => {
    expect(remoteNoAnswerText('unsettled', 'BRAVO', 'write')).toBe("The database could not show that the change sent to BRAVO was withdrawn before BRAVO took it; can't confirm whether the change was saved. Reload to check.");
    expect(remoteNoAnswerText('unsettled', 'BRAVO', 'guild-delete')).toContain('`smdb graveyard list`');
    expect(remoteRestoreNoAnswerCause('unsettled', 'BRAVO')).toBe('the database could not show that the restore sent to BRAVO was withdrawn before BRAVO took it');
  });
});

describe('NB7-RS-3 and NB7-M1: the exit sends one settle per request and logs what its row shows', () => {
  it('a route settle in flight is joined, not sent twice, and logged as withdrawn', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const gate: { release?: (v: unknown) => void } = {};
    script = sql => {
      if (sql === REQUEST_POLL_SQL) return poll('pending', { pickup_over: true });
      if (sql === SETTLE_UPDATE_SQL) return new Promise(resolve => { gate.release = resolve; });
      return undefined;
    };
    const { result } = await send();
    await vi.advanceTimersByTimeAsync(10);
    expect(count(SETTLE_UPDATE_SQL)).toBe(1);
    let ended = false;
    void endGuildRequests().then(() => { ended = true; });
    gate.release!({ rows: [{ state: 'expired' }] });
    await vi.advanceTimersByTimeAsync(10);
    expect(ended).toBe(true);
    expect(count(SETTLE_UPDATE_SQL)).toBe(1);
    expect(log).toHaveBeenCalledWith(`[Main] Exiting: withdrew the write of server ${GUILD} sent to BRAVO; nothing was saved`);
    expect(error).not.toHaveBeenCalled();
    expect(await result(10)).toMatchObject({ code: 'not-taken' });
  });

  it('a row already done is logged with its answer, never as applying', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let exited = false;
    script = sql => {
      if (sql === REQUEST_POLL_SQL) return exited ? poll('done', { reply: '{"ok":true}' }) : poll('pending');
      return undefined;
    };
    await send();
    await vi.advanceTimersByTimeAsync(10);
    exited = true;
    const exit = endGuildRequests();
    await vi.advanceTimersByTimeAsync(10);
    await exit;
    expect(log).toHaveBeenCalledWith(`[Main] Exiting: BRAVO answered the write of server ${GUILD}: saved`);
    expect(error).not.toHaveBeenCalled();
  });

  it('a row the route already withdrew is logged as withdrawn', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let exited = false;
    script = sql => (sql === REQUEST_POLL_SQL ? (exited ? poll('expired') : poll('pending')) : undefined);
    await send();
    await vi.advanceTimersByTimeAsync(10);
    exited = true;
    const exit = endGuildRequests();
    await vi.advanceTimersByTimeAsync(10);
    await exit;
    expect(log).toHaveBeenCalledWith(`[Main] Exiting: withdrew the write of server ${GUILD} sent to BRAVO; nothing was saved`);
    expect(error).not.toHaveBeenCalled();
  });

  it('a row applying keeps the applies line', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    script = sql => (sql === REQUEST_POLL_SQL ? poll('applying') : undefined);
    await send();
    await vi.advanceTimersByTimeAsync(10);
    const exit = endGuildRequests();
    await vi.advanceTimersByTimeAsync(10);
    await exit;
    expect(error).toHaveBeenCalledWith(`[Main] Exiting while BRAVO applies the write of server ${GUILD}; can't confirm whether it was saved`);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('a settle and read with no answer by 2 s log one can\'t confirm line', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let exited = false;
    script = sql => (exited ? HANG : sql === REQUEST_POLL_SQL ? poll('pending') : undefined);
    await send();
    await vi.advanceTimersByTimeAsync(10);
    exited = true;
    const exit = endGuildRequests();
    await vi.advanceTimersByTimeAsync(2100);
    await exit;
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(`[Main] Exiting; can't confirm whether the write of server ${GUILD} sent to BRAVO was saved`);
  });
});

describe('NB7-M2: the request goes to the database the holder check read', () => {
  it('the holder\'s url is the reader\'s, not a later read of the current URL', async () => {
    holderUrl = 'postgres://reader';
    const check = await runHolderCheck(GUILD);
    expect(check).toMatchObject({ kind: 'held', holder: { url: 'postgres://reader' } });
    script = sql => (sql === REQUEST_POLL_SQL ? poll('done', { reply: '{"ok":true}' }) : undefined);
    const { result } = await send();
    expect(await result(1000)).toMatchObject({ ok: true, servedBy: 'BRAVO' });
    expect(sent.every(s => s.url === 'postgres://reader')).toBe(true);
  });
});

describe('NB7-RS-4 and NB7-RS-5: a local plan\'s read', () => {
  const target = { guildId: GUILD, module: 'm', filename: 'a.json', path: '/data/x/m/a.json' };

  it.each(['bot-down', 'starting'])('a child read answering %s is the answer: no holder check, no database read', async code => {
    const holderOf = vi.fn(async () => ({ rows: [heldRow()] }));
    const readDoc = vi.fn(async () => '{}');
    _setGuildRequestDeps({ holderOf, readDoc, currentUrl: () => 'postgres://current', nodeId: () => 'n-a', nodeName: () => 'ALPHA' });
    const plan: any = { kind: 'local', op: 'write', deadline: performance.now() + 60_000 };
    const read = await readServedGuild(fakeBot({ read: () => ({ ok: false, code }) }).bot, target, { plan });
    expect(read).toMatchObject({ ok: false, status: 503 });
    expect(holderOf).not.toHaveBeenCalled();
    expect(readDoc).not.toHaveBeenCalled();
    expect(plan.kind).toBe('local');
  });

  it('a not-held read with no holder carries the code no-holder', async () => {
    _setGuildRequestDeps({
      holderOf: async () => ({ rows: [heldRow({ holder_process: null })] }),
      readDoc: async () => '{}',
      currentUrl: () => 'postgres://current',
      nodeId: () => 'n-a',
      nodeName: () => 'ALPHA',
    });
    const plan: any = { kind: 'local', op: 'write', deadline: performance.now() + 60_000 };
    const read = await readServedGuild(fakeBot({ read: () => ({ ok: false, code: 'not-held' }) }).bot, target, { plan });
    expect(read).toMatchObject({ ok: false, status: 503, code: 'no-holder' });
  });
});

describe('NB7-DL2: the holder\'s stop answers a batch whose rows arrived after the stop began', () => {
  it('the unapplied statement is sent before the stop step ends', async () => {
    let stopping = false;
    const texts: Array<{ text: string; values: unknown[] }> = [];
    const gate: { release?: (v: unknown) => void } = {};
    const s = new GuildRequestSweep({
      db: {
        query: async (text, values) => {
          texts.push({ text, values });
          if (text === REQUEST_CLAIM_SQL) return new Promise(resolve => { gate.release = resolve; }) as any;
          return { rows: [], rowCount: 1 };
        },
      },
      processId: () => 'p-a',
      pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
      stoppedServing: () => false,
      isStopping: () => stopping,
      apply: async () => ({ ok: true }),
      newId: () => 'b1',
    });
    void s.pass();
    await vi.advanceTimersByTimeAsync(0);
    stopping = true;
    let ended = false;
    void s.stopStep().then(() => { ended = true; });
    gate.release!({ rows: [{ id: 'r1', guild_id: GUILD, op: 'write', body: '{}', requested_by: 'ALPHA', left_ms: '20000' }] });
    await vi.advanceTimersByTimeAsync(10);
    expect(ended).toBe(true);
    const unapplied = texts.filter(t => t.text === UNANSWERED_BATCHES_SQL);
    expect(unapplied.length).toBeGreaterThanOrEqual(1);
    expect(unapplied[0].values).toEqual([['b1'], []]);
  });
});

describe('NB7-RS-1: every client of the two new pools keeps an error listener', () => {
  afterEach(() => {
    fakePools.length = 0;
    fakeServer.script = () => undefined;
  });

  it('the web UI\'s request pool: a socket error on a client in use does not throw, and the insert follows the identity read', async () => {
    vi.useRealTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    _setGuildRequestDeps({
      holderOf: async () => ({ rows: [heldRow()], url: 'postgres://fake-requests' }),
      readDoc: async () => null,
      currentUrl: () => 'postgres://fake-requests',
      nodeId: () => 'n-a',
      nodeName: () => 'ALPHA',
    });
    fakeServer.script = text => (text === REQUEST_POLL_SQL ? poll('done', { reply: '{"ok":true}' }) : undefined);
    const plan = await requestPlan('write');
    const value = await sendGuildChange(fakeBot().bot, plan, writeOf());
    expect(value).toMatchObject({ ok: true, servedBy: 'BRAVO' });
    const pool = fakePools.find(p => p.options.application_name === 'smdb-webui-requests');
    expect(pool).toBeDefined();
    const first = pool.clients[0];
    expect(first.queries[0]).toContain('pg_postmaster_start_time');
    expect(first.queries[1]).toBe(REQUEST_INSERT_SQL);
    for (const client of pool.clients as EventEmitter[]) {
      expect(client.listenerCount('error')).toBeGreaterThan(0);
      expect(() => client.emit('error', new Error('read ECONNRESET'))).not.toThrow();
    }
  });

  it('the holder\'s sweep pool: a socket error on a client in use does not throw', async () => {
    vi.useRealTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const before = process.env.DATA_BACKEND_URL;
    process.env.DATA_BACKEND_URL = 'postgres://fake-sweep-database';
    // NB5 G9: the sweep's pool is built from the entry the bot process chose.
    const { PostgresBackend } = await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend');
    const { setGuildDataBackend } = await import('../../src/bot/internalSetup/utils/dataManager');
    setGuildDataBackend(Object.assign(Object.create(PostgresBackend.prototype), {
      chosenEntry: () => 'postgres://fake-sweep-database',
      onDatabaseChanged: () => undefined,
      databaseEpoch: () => 1,
      refusalDetail: () => null,
    }));
    try {
      _setLookupDb(null);
      fakeServer.script = () => ({ rows: [] });
      await notServedHereText(GUILD, 'panel');
      const pool = fakePools.find(p => p.options.application_name === 'smdb-guild-requests');
      expect(pool).toBeDefined();
      expect(pool.clients.length).toBeGreaterThan(0);
      for (const client of pool.clients as EventEmitter[]) {
        expect(client.listenerCount('error')).toBeGreaterThan(0);
        expect(() => client.emit('error', new Error('read ECONNRESET'))).not.toThrow();
      }
    } finally {
      setGuildDataBackend(null);
      if (before === undefined) delete process.env.DATA_BACKEND_URL;
      else process.env.DATA_BACKEND_URL = before;
    }
  });
});
