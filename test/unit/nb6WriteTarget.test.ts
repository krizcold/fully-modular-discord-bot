import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 68, part 3 (C22, C23, D7): the web UI's write checks exported by webuiDataReader.ts, each refusal and its
// held flag, and the main tag: the bot process's data:store report carries it from MainChooser.view(), and the web
// UI's resolution answers the report's tag or the own choice's. The route answers built on them are part 10's rows.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/recognitionGuard', async orig => ({
  ...(await orig<object>()),
  verifyStoreIdentity: () => new Promise(() => {}),
}));

import { BotManager } from '../../src/webui/botManager';
import {
  CHOOSING_REFUSAL, STARTING_REFUSAL, _resetWebuiChoice, _setWebuiChoiceDeps, chooseNow, resolveWebuiDatabase,
  setWebuiDataStoreUrl, webuiCommitCheck, webuiFirstCheck, webuiReportCount, webuiSecondCheck, webuiWriteTarget,
} from '../../src/webui/utils/webuiDataReader';
import { MainChooser, mainTagOf, type NoticeRead, type ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { _startPostgresRuntime } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { parseAddressList } from '../../src/utils/databaseAddress';
import { setBackendKind } from '../helpers/backendKind';
import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import { writeRawAtomicTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { readDocRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { _resetRowQueue, rowCommitOwed, rowQueue, rowTicketState, t39Cause, useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { webuiSessions } from '../helpers/nb6WebuiSession';
import { forks, forkLogin } from '../helpers/forkMock';

const A = 'postgres://bot:pw@a.example:5432/bot';
const W = 'postgres://bot:pw@w.example:5432/bot';
const DATE = '2026-11-05T12:00:00.000Z';
const OTHER_PICK = 'a check of the databases made now picks w.example:5432/bot, while the bot process uses a.example:5432/bot';
const COUNT_CHANGED = 'the bot process reported a change of its database during the check';

function answered(entry: string, generation: number, machine: string | null): ProbeAnswer {
  const [e] = parseAddressList(entry);
  return {
    kind: 'answered', address: e.shown, entry, inRecovery: false, readOnly: false, generation, machine, since: DATE,
    sysid: `sys-${entry}`, started: `start-${entry}`, storeId: 'store-1', ownerChannel: { kind: 'none' },
  } as ProbeAnswer;
}

const fake = {
  answers: [] as ProbeAnswer[],
  notice: { kind: 'none' } as NoticeRead,
  probes: 0,
  probeHook: null as null | (() => void),
};

describe('test 68 (part 3): the web UI checks and the resolution tag', () => {
  let manager: BotManager;

  beforeEach(() => {
    forks.children.length = 0;
    forks.exitCode = 0;
    forks.holdExit = false;
    forkLogin.on = true;
    Object.assign(fake, { answers: [answered(A, 1, 'M')], notice: { kind: 'none' }, probes: 0, probeHook: null });
    process.env.DISCORD_TOKEN = 'token';
    process.env.CLIENT_ID = '1';
    process.env.GUILD_ID = '2';
    _resetWebuiChoice();
    setWebuiDataStoreUrl(null);
    _setWebuiChoiceDeps({
      entries: () => parseAddressList(`${A},${W}`),
      probe: async () => { fake.probes++; fake.probeHook?.(); return fake.answers; },
      readNotice: async () => fake.notice,
      markerStoreId: () => 'store-1',
      noticeCheckOff: () => false,
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    manager = new BotManager();
  });
  afterEach(async () => {
    await manager.shutdown(true).catch(() => undefined);
    _setWebuiChoiceDeps(null);
    setWebuiDataStoreUrl(null);
    vi.restoreAllMocks();
  });

  /** A started child that sent one data:store message. */
  async function reporting(data: object): Promise<any> {
    await manager.start();
    const child = forks.children[0];
    child.emit('message', { type: 'data:store', data });
    return child;
  }

  async function primeOwnChoice(): Promise<void> {
    resolveWebuiDatabase();
    await vi.waitFor(() => expect(resolveWebuiDatabase()).not.toEqual({ refusal: CHOOSING_REFUSAL }));
  }

  describe('webuiFirstCheck', () => {
    it('a child that has not reported refuses as starting, not held', async () => {
      await manager.start();
      expect(webuiFirstCheck()).toEqual({ refusal: STARTING_REFUSAL, held: false });
    });

    it('a choosing report refuses with its reason, or the choosing words without one', async () => {
      const child = await reporting({ url: null, choosing: true, reason: 'R' });
      expect(webuiFirstCheck()).toEqual({ refusal: 'R', held: false });
      child.emit('message', { type: 'data:store', data: { url: null, choosing: true } });
      expect(webuiFirstCheck()).toEqual({ refusal: CHOOSING_REFUSAL, held: false });
    });

    it('a held report refuses with its reason and held true', async () => {
      await reporting({ url: A, held: true, reason: 'H' });
      expect(webuiFirstCheck()).toEqual({ refusal: 'H', held: true });
    });

    it('a plain report passes, whatever its entry, and starts no choice', async () => {
      await reporting({ url: W, tag: '2:N' });
      expect(webuiFirstCheck()).toBeNull();
      expect(fake.probes).toBe(0);
    });

    it("with no bot process the own choice's refusal refuses; its entry passes", async () => {
      expect(webuiFirstCheck()).toEqual({ refusal: CHOOSING_REFUSAL, held: false });
      await primeOwnChoice();
      expect(webuiFirstCheck()).toBeNull();
      fake.answers = [answered(A, 1, 'M'), answered(W, 1, 'N')];
      _resetWebuiChoice();
      await primeOwnChoice();
      const refusal = webuiFirstCheck();
      expect(refusal).toMatchObject({ held: false });
      expect(refusal!.refusal.startsWith('Two databases accept writes at main generation 1')).toBe(true);
    });

    it("a maintenance-boot child takes the own choice's refusal too", async () => {
      await manager.start();
      forks.children[0].emit('message', { type: 'maintenance:mode', data: { mode: 'login-refused', boot: true } });
      expect(webuiFirstCheck()).toEqual({ refusal: CHOOSING_REFUSAL, held: false });
      await primeOwnChoice();
      expect(webuiFirstCheck()).toBeNull();
    });
  });

  describe('webuiSecondCheck', () => {
    it("a refused choice refuses with the choice's refusal", async () => {
      await reporting({ url: A, tag: '1:M' });
      const count = webuiReportCount();
      expect(webuiSecondCheck({ refusal: 'X' }, count)).toEqual({ refusal: 'X', held: false });
    });

    it('a report on another entry refuses with both addresses', async () => {
      await reporting({ url: A, tag: '1:M' });
      fake.answers = [answered(A, 1, 'M'), answered(W, 2, 'N')];
      const { resolution, countAtStart } = await chooseNow();
      expect(webuiSecondCheck(resolution, countAtStart)).toEqual({ refusal: OTHER_PICK, held: false });
    });

    it('a held or choosing report on the chosen entry refuses as the first check does', async () => {
      const child = await reporting({ url: A, held: true, reason: 'H' });
      let choice = await chooseNow();
      expect(webuiSecondCheck(choice.resolution, choice.countAtStart)).toEqual({ refusal: 'H', held: true });
      child.emit('message', { type: 'data:store', data: { url: null, choosing: true, reason: 'R' } });
      choice = await chooseNow();
      expect(webuiSecondCheck(choice.resolution, choice.countAtStart)).toEqual({ refusal: 'R', held: false });
    });

    it('a report during the choice refuses with the count reason', async () => {
      const child = await reporting({ url: A, tag: '1:M' });
      fake.probeHook = () => child.emit('message', { type: 'data:store', data: { url: A, tag: '1:M' } });
      const { resolution, countAtStart } = await chooseNow();
      expect(webuiSecondCheck(resolution, countAtStart)).toEqual({ refusal: COUNT_CHANGED, held: false });
    });

    it("passes with the report's tag while a bot process reports, null when the report lacks one", async () => {
      const child = await reporting({ url: A, tag: '1:M' });
      let choice = await chooseNow();
      expect(webuiSecondCheck(choice.resolution, choice.countAtStart)).toEqual({ entry: A, tag: '1:M' });
      child.emit('message', { type: 'data:store', data: { url: A } });
      choice = await chooseNow();
      expect(webuiSecondCheck(choice.resolution, choice.countAtStart)).toEqual({ entry: A, tag: null });
    });

    it("passes with the own choice's generation and machine with no bot process; generation 0 is '0'", async () => {
      fake.answers = [answered(A, 3, 'M')];
      let choice = await chooseNow();
      expect(webuiSecondCheck(choice.resolution, choice.countAtStart)).toEqual({ entry: A, tag: '3:M' });
      fake.answers = [answered(W, 0, null)];
      choice = await chooseNow();
      expect(webuiSecondCheck(choice.resolution, choice.countAtStart)).toEqual({ entry: W, tag: '0' });
    });
  });

  describe('webuiCommitCheck', () => {
    it('answers synchronously: null while the report still names the entry and no report came', async () => {
      await reporting({ url: A, tag: '1:M' });
      const count = webuiReportCount();
      const answer = webuiCommitCheck(A, count);
      expect(answer).toBeNull();
    });

    it('refuses on any report after the count was read, even one naming the same entry', async () => {
      const child = await reporting({ url: A, tag: '1:M' });
      const count = webuiReportCount();
      child.emit('message', { type: 'data:store', data: { url: A, tag: '1:M' } });
      expect(webuiCommitCheck(A, count)).toEqual({ refusal: COUNT_CHANGED, held: false });
    });

    it('refuses a report on another entry, a held report and a choosing report', async () => {
      const child = await reporting({ url: W, tag: '2:N' });
      const count = webuiReportCount();
      expect(webuiCommitCheck(A, count)).toEqual({
        refusal: 'a check of the databases made now picks a.example:5432/bot, while the bot process uses w.example:5432/bot', held: false,
      });
      child.emit('message', { type: 'data:store', data: { url: A, held: true, reason: 'H' } });
      expect(webuiCommitCheck(A, webuiReportCount())).toEqual({ refusal: 'H', held: true });
      child.emit('message', { type: 'data:store', data: { url: null, choosing: true, reason: 'R' } });
      expect(webuiCommitCheck(A, webuiReportCount())).toEqual({ refusal: 'R', held: false });
    });

    it('with no bot process, a child that starts after the count was read refuses', async () => {
      const count = webuiReportCount();
      expect(webuiCommitCheck(A, count)).toBeNull();
      await manager.start();
      expect(webuiCommitCheck(A, count)).toEqual({ refusal: STARTING_REFUSAL, held: false });
    });
  });

  describe('webuiWriteTarget', () => {
    it('a first refusal answers before any choice is made', async () => {
      await reporting({ url: A, held: true, reason: 'H' });
      expect(await webuiWriteTarget()).toEqual({ refusal: 'H', held: true });
      expect(fake.probes).toBe(0);
    });

    it('answers the entry, its tag and the count the choice started at', async () => {
      await reporting({ url: A, tag: '1:M' });
      const before = webuiReportCount();
      expect(await webuiWriteTarget()).toEqual({ entry: A, tag: '1:M', countAtStart: before });
      expect(fake.probes).toBe(1);
    });

    it("a second refusal answers after the choice: the choice's refusal", async () => {
      await reporting({ url: A, tag: '1:M' });
      fake.answers = [answered(A, 1, 'M'), answered(W, 1, 'N')];
      const answer = await webuiWriteTarget();
      expect(answer).toMatchObject({ held: false });
      expect((answer as { refusal: string }).refusal.startsWith('Two databases accept writes at main generation 1')).toBe(true);
    });
  });

  describe("C23: the resolution's tag", () => {
    it("a report's tag is kept by the report and answered with the entry; a report without one answers null", async () => {
      const child = await reporting({ url: A, tag: '4:M' });
      expect(resolveWebuiDatabase()).toEqual({ entry: A, tag: '4:M' });
      child.emit('message', { type: 'data:store', data: { url: A, held: true, reason: 'H', tag: '4:M' } });
      expect(resolveWebuiDatabase()).toEqual({ entry: A, tag: '4:M', held: { reason: 'H' } });
      child.emit('message', { type: 'data:store', data: { url: A } });
      expect(resolveWebuiDatabase()).toEqual({ entry: A, tag: null });
    });

    it("the own choice answers its chosen generation and machine", async () => {
      fake.answers = [answered(A, 2, 'M')];
      await primeOwnChoice();
      expect(resolveWebuiDatabase()).toEqual({ entry: A, tag: '2:M' });
    });

    it("mainTagOf: '<generation>:<machine>', '0' at generation 0", () => {
      expect(mainTagOf(0, null)).toBe('0');
      expect(mainTagOf(0, 'M')).toBe('0');
      expect(mainTagOf(7, 'node-b')).toBe('7:node-b');
    });
  });
});

describe("test 68 (part 3): boot.ts's report carries the main tag", () => {
  const B = 'postgres://bot@127.0.0.1:1/bot';
  let sent: any[];
  let hadSend: typeof process.send;

  beforeEach(() => {
    sent = [];
    hadSend = process.send;
    process.send = ((message: any, callback?: () => void) => { sent.push(message); callback?.(); return true; }) as typeof process.send;
    setBackendKind('postgres');
    vi.stubEnv('DATA_BACKEND_URL', B);
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.send = hadSend;
    setBackendKind(null);
    setGuildDataBackend(null);
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const stores = () => sent.filter(m => m?.type === 'data:store').map(m => m.data);

  function runtime(answer: { current: ProbeAnswer }): { chooser: MainChooser; stop: () => Promise<void> } {
    const chooser = new MainChooser({
      entries: () => parseAddressList(B),
      probe: async () => [answer.current],
      readNotice: async () => ({ kind: 'none' }),
      sendWaitDm: async () => ({ ok: true }),
      markerStoreId: () => 'store-1',
      noticeCheckOff: () => false,
      nodeName: () => 'node-a',
      onWait: () => undefined,
    });
    const backend = _startPostgresRuntime(chooser);
    return { chooser, stop: async () => { chooser.stop(); await backend.stop?.(); } };
  }

  it('the choosing report has no tag; every report naming the chosen url carries the view\'s tag', async () => {
    const answer = { current: answered(B, 2, 'M') };
    const r = runtime(answer);
    try {
      await vi.waitFor(() => expect(stores().some(d => d.url === B)).toBe(true));
      const all = stores();
      expect(all[0]).toEqual({ url: null, choosing: true });
      for (const d of all.filter(x => x.url !== null)) expect(d.tag).toBe('2:M');
    } finally {
      await r.stop();
    }
  });

  it("generation 0 reports '0'", async () => {
    const answer = { current: answered(B, 0, null) };
    const r = runtime(answer);
    try {
      await vi.waitFor(() => expect(stores().some(d => d.url === B)).toBe(true));
      expect(stores().find(d => d.url === B).tag).toBe('0');
    } finally {
      await r.stop();
    }
  });

  it('a watch pass that reads a new generation and machine on the same url reports again with the new tag', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const answer = { current: answered(B, 2, 'M') };
    const r = runtime(answer);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stores().some(d => d.url === B && d.tag === '2:M')).toBe(true);
      answer.current = answered(B, 3, 'N');
      await vi.advanceTimersByTimeAsync(65_000);
      const last = stores().filter(d => d.url === B).at(-1);
      expect(last.tag).toBe('3:N');
      expect(stores().filter(d => d.tag === '3:N').length).toBeGreaterThanOrEqual(1);
    } finally {
      await r.stop();
    }
  });
});

describe('test 68 (part 10): a web UI row op on its own session, behind the checks', () => {
  const CATEGORY = 'nb6webuitarget';
  const KEY = `global/${CATEGORY}/t.json`;
  const FILE = dataPath('global', CATEGORY, 't.json');
  const OPS_READ = 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)';
  let manager: BotManager;
  let s: ReturnType<typeof webuiSessions>;
  /** Each step in order: a probe, a session's connect, a query's text. */
  let steps: string[];

  const op = () => rowQueue.entryOf(KEY);

  beforeEach(() => {
    forks.children.length = 0;
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    _resetRowQueue();
    fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
    fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
    setBackendKind('postgres');
    setGuildDataBackend(null);
    _resetWebuiChoice();
    setWebuiDataStoreUrl(null);
    steps = [];
    Object.assign(fake, { answers: [answered(A, 1, 'M')], notice: { kind: 'none' }, probes: 0, probeHook: null });
    _setWebuiChoiceDeps({
      entries: () => parseAddressList(A),
      probe: async () => { fake.probes++; steps.push('probe'); fake.probeHook?.(); return fake.answers; },
      readNotice: async () => fake.notice,
      markerStoreId: () => 'store-1',
      noticeCheckOff: () => false,
    });
    manager = new BotManager();
    s = webuiSessions();
    const session = s.session;
    useWebuiSessions({
      target: webuiWriteTarget,
      commitCheck: webuiCommitCheck,
      select: async () => ({ rows: [] }),
      tag: () => null,
      session: config => {
        steps.push('connect');
        const client = session(config as Record<string, unknown>);
        return { ...client, query: q => { steps.push(q.text); return client.query(q); } };
      },
    });
  });
  afterEach(async () => {
    useWebuiSessions(null);
    _resetRowQueue();
    await manager.shutdown(true).catch(() => undefined);
    _setWebuiChoiceDeps(null);
    setWebuiDataStoreUrl(null);
    setBackendKind(null);
    vi.restoreAllMocks();
  });

  async function primeOwnChoice(): Promise<void> {
    resolveWebuiDatabase();
    await vi.waitFor(() => expect(resolveWebuiDatabase()).not.toEqual({ refusal: CHOOSING_REFUSAL }));
    steps.length = 0;
  }

  it('cell 445: a first check that refuses opens no session; the op stays queued with T39 as its cause', async () => {
    expect(writeRawAtomicTracked(FILE, '{"a":1}')).toEqual({ accepted: true });
    await vi.waitFor(() => expect(op()?.triesFailed).toBeGreaterThanOrEqual(1));
    expect(s.sessions()).toBe(0);
    expect(op()?.state).toBe('queued');
    expect(op()?.cause).toBe(`the web panel cannot use the bot's main database now: ${CHOOSING_REFUSAL}`);
  });

  it("cell 445: a refused choice (the second check) opens no session; a held report's words are T39's held form", async () => {
    await primeOwnChoice();
    fake.answers = [];
    expect(writeRawAtomicTracked(FILE, '{"a":1}')).toEqual({ accepted: true });
    await vi.waitFor(() => expect(op()?.triesFailed).toBeGreaterThanOrEqual(1));
    expect(s.sessions()).toBe(0);
    expect(op()?.cause).toMatch(/^the web panel cannot use the bot's main database now: /);
    expect(t39Cause({ refusal: 'H', held: true })).toBe("the bot process is still confirming the bot's main database: H");
  });

  it('cell 457: the first check, the probe and the second check pass before the connect; BEGIN, the statements, then COMMIT', async () => {
    await primeOwnChoice();
    expect(writeRawAtomicTracked(FILE, '{"a":1}')).toEqual({ accepted: true });
    await vi.waitFor(() => expect(op()).toBeUndefined());
    expect(steps[0]).toBe('probe');
    expect(steps[1]).toBe('connect');
    expect(steps[2]).toMatch(/^BEGIN; SET LOCAL statement_timeout = \d+$/);
    expect(steps.at(-1)).toBe('COMMIT');
    expect(s.rows.docs.get(KEY)?.body.toString()).toBe('{"a":1}');
    expect(s.configs[0]).toMatchObject({ application_name: 'smdb-webui-shared', connectionTimeoutMillis: 5000, options: '-c idle_session_timeout=5000 -c idle_in_transaction_session_timeout=10000' });
    expect(s.ended).toEqual([1]);
  });

  it('cell 458: a report between the second check and the check before COMMIT rolls back; nothing is committed; the op stays queued', async () => {
    await primeOwnChoice();
    s.state.before = sql => { if (/^SELECT body, sha/.test(sql)) setWebuiDataStoreUrl(null); };
    expect(writeRawAtomicTracked(FILE, '{"a":1}')).toEqual({ accepted: true });
    await vi.waitFor(() => expect(op()?.triesFailed).toBeGreaterThanOrEqual(1));
    expect(s.sent.map(q => q.sql)).toContain('ROLLBACK');
    expect(s.sent.map(q => q.sql)).not.toContain('COMMIT');
    expect(s.rows.docs.has(KEY)).toBe(false);
    expect(op()?.state).toBe('queued');
    expect(op()?.unknown).toEqual([]);
    expect(op()?.cause).toBe(`the web panel cannot use the bot's main database now: ${COUNT_CHANGED}`);
  });

  it("cell 446: a report while COMMIT is on the wire leaves the attempt's id unknown; the next attempt checks it on the entry it answers then", async () => {
    await primeOwnChoice();
    let once = true;
    s.state.before = sql => { if (sql === 'COMMIT' && once) { once = false; setWebuiDataStoreUrl(null); } };
    expect(writeRawAtomicTracked(FILE, '{"a":1}')).toEqual({ accepted: true });
    await vi.waitFor(() => expect(op()?.unknown.length).toBe(1));
    const ticket = { kind: 'row', key: KEY, op: op()!, seq: 1 } as const;
    expect(rowCommitOwed(ticket)).toBe(true);
    await primeOwnChoice();
    await vi.waitFor(() => expect(rowTicketState(ticket)).toBe('landed'), { timeout: 5000 });
    const second = s.sent.filter(q => q.session === 2).map(q => q.sql);
    expect(second[0]).toBe('BEGIN; SET LOCAL statement_timeout = 30000');
    expect(second).toContain(OPS_READ);
    expect(second.at(-1)).toBe('ROLLBACK');
    expect(s.rows.history.filter(h => h.key === KEY)).toHaveLength(1);
  });

  it("cell 447: after a COMMIT the record entry's main is the own choice's tag", async () => {
    await primeOwnChoice();
    expect(writeRawAtomicTracked(FILE, '{"a":1}')).toEqual({ accepted: true });
    await vi.waitFor(() => expect(op()).toBeUndefined());
    const record = readDocRecord();
    expect(record.ok && record.record.docs[KEY]?.main).toBe('1:M');
    expect(fs.readFileSync(FILE, 'utf8')).toBe('{"a":1}');
  });
});
