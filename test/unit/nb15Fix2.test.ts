import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// NB15 code review rounds 2 and 3, the fixes: the holder keeps no record of what it sent and answers its kept state
// while its version is above the version the asking web UI delivered to its page (LIVE-SENT, LIVE-B-regress, R3
// ruling); a reply that says nothing ran proves it only after claim_by passed on the insert's server (R2-1); a fetch
// sent before the latest LISTEN never makes a pair live (L5-residual).
import { GuildRequestSweep, type PanelHooks, type SweepDeps } from '../../src/bot/internalSetup/fleet/guildRequests';
import { ANSWER_SQL, ANSWER_READ_BACK_SQL, READ_ANSWERS_READ_BACK_SQL, READ_ANSWERS_SQL, REQUEST_CLAIM_SQL, REQUEST_INSERT_SQL, UNAPPLIED_REPLY } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { _resetPanelLive, liveAnswer, noteLiveChange, registerInterest } from '../../src/bot/internalSetup/fleet/panelLive';
import { planGuildRequest, runGuildRequest } from '../../src/webui/utils/guildRequests';
import { LIVE_REASONS, PanelLiveWatch, type FetchAnswer, type WatchDeps } from '../../src/webui/utils/panelLiveWatch';
import { BOT_DOWN, GUILD, fakeTime, nb7Rig, resetNb7, type Rig } from '../helpers/nb7Rig';

const G = GUILD;
const OWNER = { via: 'owner', userId: 'web-ui-owner' };
const NAME = 'BRAVO';

beforeEach(() => {
  fakeTime();
  _resetPanelLive();
});

afterEach(() => {
  _resetPanelLive();
  resetNb7();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LIVE-SENT: the kept state is answered by the version the asker has, never by a record of what was sent', () => {
  it('answering marks nothing: the same have gets the state again until the asker reports it has that version', () => {
    const since = registerInterest(G, 'p')!;
    noteLiveChange(G, 'p', { v: 1 });
    expect(liveAnswer(G, 'p', since, 0, since)).toMatchObject({ data: { v: 1 }, since, version: 1 });
    expect(liveAnswer(G, 'p', since, 0, since)).toMatchObject({ data: { v: 1 }, version: 1 });
    expect(liveAnswer(G, 'p', since, 1, since)).toEqual({ success: true, data: null, since, version: 1, notifying: null });
    noteLiveChange(G, 'p', { v: 2 });
    expect(liveAnswer(G, 'p', since, 1, since)).toMatchObject({ data: { v: 2 }, version: 2 });
  });

  it('a have of a lapsed interest counts as none on the new one', () => {
    const old = registerInterest(G, 'p')!;
    noteLiveChange(G, 'p', { v: 1 });
    vi.advanceTimersByTime(90_001);
    const since = registerInterest(G, 'p')!;
    expect(since).not.toBe(old);
    noteLiveChange(G, 'p', { v: 1 });
    expect(liveAnswer(G, 'p', since, 5, old)).toMatchObject({ data: { v: 1 }, version: 1 });
  });
});

interface Sent { text: string; values: any[] }

let ids = 0;
function row(over: Record<string, unknown> = {}) {
  return {
    id: `r${++ids}`, guild_id: G, shard_count: 2, shard_id: 1, op: 'panel:button',
    body: JSON.stringify({ panelId: 'p', buttonId: 'b', userId: 'web-ui-owner', actor: OWNER }),
    requested_by: 'ALPHA', left_ms: 30_000, ...over,
  };
}

function hooks(action: () => Promise<any>): PanelHooks {
  return {
    answerPanel: async (op, body) => (op === 'panel:live'
      ? liveAnswer(G, String(body.panelId), registerInterest(G, String(body.panelId)), Number(body.haveVersion ?? 0), (body.haveSince as number | undefined) ?? null)
      : action()),
    answerInvoke: async () => ({ success: true, ran: true, captured: [] }),
    maintenanceRefusal: () => null,
    getPanel: () => ({ panelScope: 'guild' }),
    getCommand: () => ({ devOnly: false }),
    guildWebUi: () => true,
    membership: () => ({ success: true, guilds: [] }),
    registerInterest: (g, p) => registerInterest(g, p),
  };
}

function sweepOf(rows: any[], script: (s: Sent) => unknown, panel: PanelHooks): GuildRequestSweep {
  let claimed = false;
  let batch = 0;
  const deps: SweepDeps = {
    db: {
      query: async (text, values) => {
        if (text === REQUEST_CLAIM_SQL) {
          if (claimed) return { rows: [] };
          claimed = true;
          return { rows };
        }
        const answer = script({ text, values: values as any[] });
        if (answer instanceof Error) throw answer;
        return (answer as any) ?? { rows: [], rowCount: (values?.[0] as unknown[] | undefined)?.length ?? 1 };
      },
    },
    processId: () => 'p-b',
    pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
    stoppedServing: () => false,
    isStopping: () => false,
    apply: async () => ({ ok: true }),
    newId: () => `b${++batch}`,
    panel,
  };
  return new GuildRequestSweep(deps);
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); };
const refused = () => Object.assign(new Error('permission denied'), { code: '42501' });
const liveRow = (have: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => row({ op: 'panel:live', body: JSON.stringify({ panelId: 'p', actor: OWNER, ...have }), ...over });
/** The answers a sweep wrote for its read rows, by row id. */
const readAnswers = (sent: Sent[]) => {
  const out = new Map<string, any>();
  for (const s of sent.filter(x => x.text === READ_ANSWERS_SQL)) (s.values[0] as string[]).forEach((id, i) => out.set(id, JSON.parse((s.values[1] as string[])[i])));
  return out;
};

describe('LIVE-SENT through the sweep', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it("a confirmed write the web UI never read leaves the next fetch answered with the state", async () => {
    const since = registerInterest(G, 'p')!;
    noteLiveChange(G, 'p', { v: 1 });
    const sent: Sent[] = [];
    const first = liveRow({ haveVersion: 0, haveSince: since });
    await sweepOf([first], x => { sent.push(x); return undefined; }, hooks(async () => ({ success: true }))).pass();
    await flush();
    expect(readAnswers(sent).get(first.id)).toMatchObject({ success: true, data: { v: 1 }, version: 1 });
    // The web UI's read of that answer failed, so it still has version 0 and asks again with it.
    const second = liveRow({ haveVersion: 0, haveSince: since });
    await sweepOf([second], x => { sent.push(x); return undefined; }, hooks(async () => ({ success: true }))).pass();
    await flush();
    expect(readAnswers(sent).get(second.id)).toMatchObject({ success: true, data: { v: 1 }, version: 1 });
    const third = liveRow({ haveVersion: 1, haveSince: since });
    await sweepOf([third], x => { sent.push(x); return undefined; }, hooks(async () => ({ success: true }))).pass();
    await flush();
    expect(readAnswers(sent).get(third.id)).toEqual({ success: true, data: null, since, version: 1, notifying: null });
  });

  it('two web UIs with the same NODE_NAME both get the state', async () => {
    const since = registerInterest(G, 'p')!;
    noteLiveChange(G, 'p', { v: 1 });
    const sent: Sent[] = [];
    const alpha = liveRow({}, { requested_by: 'fullymodulardiscordbot' });
    const charlie = liveRow({}, { requested_by: 'fullymodulardiscordbot' });
    await sweepOf([alpha], x => { sent.push(x); return undefined; }, hooks(async () => ({ success: true }))).pass();
    await flush();
    await sweepOf([charlie], x => { sent.push(x); return undefined; }, hooks(async () => ({ success: true }))).pass();
    await flush();
    const answers = readAnswers(sent);
    expect(answers.get(alpha.id)).toMatchObject({ data: { v: 1 }, since, version: 1 });
    expect(answers.get(charlie.id)).toMatchObject({ data: { v: 1 }, since, version: 1 });
  });

  it("an owner action's view, its answer written or not, is the kept state: the next fetch with the old have gets that view", async () => {
    const since = registerInterest(G, 'p')!;
    noteLiveChange(G, 'p', { v: 1 });
    const ran = sweepOf([row()], () => undefined, hooks(async () => ({ success: true, data: { content: 'View' } })));
    await ran.pass();
    await flush();
    expect(liveAnswer(G, 'p', since, 1, since)).toMatchObject({ data: { content: 'View' }, version: 2 });
    const lost = sweepOf([row()], x => (x.text === ANSWER_SQL ? { rows: [], rowCount: 0 } : x.text === ANSWER_READ_BACK_SQL ? { rows: [{ reply: 'other' }] } : undefined), hooks(async () => ({ success: true, data: { content: 'Lost' } })));
    await lost.pass();
    await flush();
    expect(liveAnswer(G, 'p', since, 2, since)).toMatchObject({ data: { content: 'Lost' }, version: 3 });
  });
});

describe("R2-1: a reply that says nothing ran is answered only once claim_by passed on the insert's server", () => {
  const URL1 = 'postgres://one';
  const down = { writerRoute: () => BOT_DOWN, isRunning: () => false } as any;
  let rig: Rig;
  let rows: Map<string, any>;

  function database(onInsert: (id: string) => void) {
    rig.script[URL1] = (sql, values) => {
      if (sql === REQUEST_INSERT_SQL) {
        const id = values[0] as string;
        rows.set(id, { state: 'pending', reply: null, pickup_over: false, answer_over: false });
        onInsert(id);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('WHERE id = $1') && !sql.includes('AND state')) {
        const r = rows.get(values[0] as string);
        return r ? { rows: [r] } : { rows: [] };
      }
      return undefined;
    };
  }

  async function start() {
    const plan = await planGuildRequest(down, GUILD, 'panel:button', 'owner');
    const started = performance.now();
    let value: any;
    let at = -1;
    void runGuildRequest(plan, { panelId: 'p', buttonId: 'b', userId: 'web-ui-owner', actor: OWNER }, async () => ({})).then(v => { value = v; at = performance.now() - started; });
    return { get value() { return value; }, get at() { return at; } };
  }

  beforeEach(() => {
    rig = nb7Rig();
    rig.server[URL1] = 's1';
    rows = new Map();
  });

  it("an 'unapplied' row read before claim_by is answered after claim_by passes, not before", async () => {
    let id = '';
    database(i => { id = i; rows.set(i, { state: 'done', reply: UNAPPLIED_REPLY, pickup_over: false, answer_over: false }); });
    const run = await start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(run.value).toBeUndefined();
    rows.get(id).pickup_over = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(run.value).toMatchObject({ status: 503, reply: { code: 'not-taken', error: 'BRAVO took the panel action but could not start it; nothing was run. Try again in a moment.' } });
    expect(run.at).toBeGreaterThanOrEqual(3000);
  });

  it('a failover that brings the row back to applying is followed to the run it answers', async () => {
    let id = '';
    database(i => { id = i; rows.set(i, { state: 'done', reply: UNAPPLIED_REPLY, pickup_over: false, answer_over: false }); });
    const run = await start();
    await vi.advanceTimersByTimeAsync(1000);
    rows.set(id, { state: 'applying', reply: null, pickup_over: false, answer_over: false });
    await vi.advanceTimersByTimeAsync(1000);
    rows.set(id, { state: 'done', reply: JSON.stringify({ success: true, data: { content: 'View' } }), pickup_over: true, answer_over: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(run.value).toMatchObject({ status: null, reply: { success: true } });
    expect(JSON.stringify(run.value)).not.toMatch(/nothing was run/);
  });

  it("the insert's server changed before claim_by passed: can't confirm, never nothing was run", async () => {
    database(i => { rows.set(i, { state: 'done', reply: UNAPPLIED_REPLY, pickup_over: false, answer_over: false }); });
    const run = await start();
    await vi.advanceTimersByTimeAsync(10);
    rig.server[URL1] = 's2';
    await vi.advanceTimersByTimeAsync(2000);
    expect(run.value).toMatchObject({ status: 503, reply: { code: 'no-answer', noAnswer: 'unsettled' } });
    expect(run.value.reply.error).not.toMatch(/nothing was run/);
  });

  it("a refusal (ran false) waits for claim_by too; a ran answer does not", async () => {
    let id = '';
    database(i => { id = i; rows.set(i, { state: 'done', reply: JSON.stringify({ success: false, ran: false, code: 'not-ready', error: 'x; nothing was run.' }), pickup_over: false, answer_over: false }); });
    const refusedRun = await start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(refusedRun.value).toBeUndefined();
    rows.get(id).pickup_over = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(refusedRun.value).toMatchObject({ status: 503 });

    database(i => { rows.set(i, { state: 'done', reply: JSON.stringify({ success: false, ran: true, truth: 'deposed', error: 'deposed' }), pickup_over: false, answer_over: false }); });
    const ranRun = await start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ranRun.value).toBeDefined();
  });
});

class FakeListen extends EventEmitter {
  readonly connection = { stream: { remoteAddress: '127.0.0.1', destroy: vi.fn() } };
  constructor(readonly config: any) { super(); }
  connect() { return Promise.resolve(); }
  query() { return Promise.resolve({ rows: [] }); }
  end() { return Promise.resolve(); }
}

describe('L5-residual: a fetch sent before the latest LISTEN never makes the pair live', () => {
  it('a fetch sent while the listener was down answers after the reconnect: not live until the next fetch answers', async () => {
    const clients: FakeListen[] = [];
    const fetches: Array<(a: FetchAnswer) => void> = [];
    const statuses: Array<{ live: boolean; reason: string | null }> = [];
    const deps: WatchDeps = {
      fetch: () => new Promise(done => { fetches.push(done); }),
      emitUpdate: () => undefined,
      emitStatus: data => statuses.push({ live: data.live, reason: data.reason }),
      entry: () => ({ entry: 'postgres://bot@localhost/bot' }),
      makeClient: config => { const c = new FakeListen(config); clients.push(c); return c as any; },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ok = (): FetchAnswer => ({ status: null, holderProcess: 'p-b', reply: { success: true, data: null, since: 5, notifying: true, servedBy: NAME } });
    const answerAll = async () => { while (fetches.length) { fetches.shift()!(ok()); await vi.advanceTimersByTimeAsync(0); } };
    const w = new PanelLiveWatch(deps);
    w.noteAnswer(G, 'p', 'p-b', 5);
    w.watch(G, 'p', 'web-ui-owner', NAME);
    await vi.advanceTimersByTimeAsync(0);
    await answerAll();
    expect(statuses.at(-1)).toEqual({ live: true, reason: null });
    clients[0].emit('error', new Error('Connection terminated unexpectedly'));
    w.watch(G, 'p', 'web-ui-owner', NAME);
    expect(fetches).toHaveLength(1);
    const gapFetch = fetches.shift()!;
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.listenerUp()).toBe(true);
    gapFetch(ok());
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toEqual({ live: false, reason: LIVE_REASONS.connecting });
    expect(fetches).toHaveLength(1);
    await answerAll();
    expect(statuses.at(-1)).toEqual({ live: true, reason: null });
    w.stop();
  });
});
