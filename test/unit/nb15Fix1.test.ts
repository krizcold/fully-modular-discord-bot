import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// NB15 code review round 1, the fixes: the kept answer of a re-claimed action (L1), the exit's log words (L3), the
// read groups' can't-confirm line (L4), the watch's connecting state, its timer and its queue (L5, TEXT-B, RUN-A,
// LIVE-C), the holder's live state answered by the version the web panel has (LIVE-B), the notify probe (TEXT-C), a process with no web
// UI parent (TEXT-A), the empty host (L6), the exit read's transport check (L7), the member list's keep (LIST-A) and
// the owner prefix's case (T5).
import { GuildRequestSweep, keptAnswer, type PanelHooks, type SweepDeps } from '../../src/bot/internalSetup/fleet/guildRequests';
import { ANSWER_SQL, READ_ANSWERS_READ_BACK_SQL, READ_ANSWERS_SQL, REQUEST_CLAIM_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { ranTruthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { _resetPanelLive, _setNotifyDb, liveAnswer, liveVersionOf, noteLiveChange, notifyTick, registerInterest } from '../../src/bot/internalSetup/fleet/panelLive';
import { _resetPanelHandler, guildWebUiEnabled, setupPanelIPCHandlers } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { panelExitWords, remotePanelAnswer, type Outcome } from '../../src/webui/utils/guildRequests';
import { LIVE_REASONS, PanelLiveWatch, type FetchAnswer, type WatchDeps } from '../../src/webui/utils/panelLiveWatch';
import { MEMBER_NOTICES, _resetMemberLists, memberServerList, type MemberListDeps } from '../../src/webui/utils/memberGuilds';
import { transportOf } from '../../src/utils/databaseAddress';
import { readSourceText } from '../helpers/sourceText';

const G = String(1n << 22n);
const OWNER = { via: 'owner', userId: 'web-ui-owner' };
const NAME = 'BRAVO';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  _resetPanelLive();
});

afterEach(() => {
  _resetPanelLive();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Sent { text: string; values: any[]; carries?: boolean }

let ids = 0;
function row(over: Record<string, unknown> = {}) {
  return {
    id: `r${++ids}`, guild_id: G, shard_count: 2, shard_id: 1, op: 'panel:button',
    body: JSON.stringify({ panelId: 'p', buttonId: 'b', userId: 'web-ui-owner', actor: OWNER }),
    requested_by: 'ALPHA', left_ms: 30_000, ...over,
  };
}

function hooksWith(over: Partial<PanelHooks> = {}): PanelHooks & { bodies: any[] } {
  const bodies: any[] = [];
  return {
    bodies,
    answerPanel: async (_op, body) => { bodies.push(body); return { success: true, data: { content: 'View' } }; },
    answerInvoke: async () => ({ success: true, ran: true, captured: [] }),
    maintenanceRefusal: () => null,
    getPanel: () => ({ panelScope: 'guild' }),
    getCommand: () => ({ devOnly: false }),
    guildWebUi: () => true,
    membership: () => ({ success: true, guilds: [] }),
    registerInterest: () => 1234,
    ...over,
  };
}

function sweepOf(script: (s: Sent) => unknown, hooks: PanelHooks): { sweep: GuildRequestSweep; sent: Sent[] } {
  const sent: Sent[] = [];
  let batch = 0;
  const deps: SweepDeps = {
    db: {
      query: async (text, values, _boundMs, _at, carries) => {
        const s = { text, values, carries };
        sent.push(s);
        const answer = script(s);
        if (answer instanceof Error) throw answer;
        return (answer as any) ?? { rows: [], rowCount: (values?.[0] as unknown[] | undefined)?.length ?? 1 };
      },
    },
    processId: () => 'p-a',
    pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
    stoppedServing: () => false,
    isStopping: () => false,
    apply: async () => ({ ok: true }),
    newId: () => `b${++batch}`,
    panel: hooks,
  };
  return { sweep: new GuildRequestSweep(deps), sent };
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); };
const reply = (r: Record<string, unknown>): Outcome => ({ k: 'reply', reply: r });

describe('L1: an action claimed again answers its first outcome in its own words', () => {
  it('the kept answer keeps the error, cut to 2000 characters, and a command keeps capturedOmitted not-kept', () => {
    expect(keptAnswer({ success: false, ran: true, truth: 'deposed', partial: false, error: 'x'.repeat(5000), data: { big: 1 } })).toEqual({
      success: false, ran: true, truth: 'deposed', partial: false, error: `${'x'.repeat(1997)}...`, oversize: { bytes: 0, reason: 'not-kept' },
    });
    expect(keptAnswer({ success: true, ran: true, captured: [1, 2, 3] })).toEqual({ success: true, ran: true, capturedOmitted: { count: 3, bytes: 0, reason: 'not-kept' } });
  });

  it('a failed verdict claimed again is written with its ranTruthText, and the owner reads that it ran', async () => {
    const error = ranTruthText({ answer: 'deposed', partial: false });
    const hooks = hooksWith({ answerPanel: async () => ({ success: false, ran: true, truth: 'deposed', partial: false, error }) });
    const r = row();
    let pass = 0;
    const { sweep, sent } = sweepOf(s => (s.text === REQUEST_CLAIM_SQL ? (++pass <= 2 ? { rows: [r] } : { rows: [] }) : undefined), hooks);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await sweep.pass();
    await flush();
    await sweep.pass();
    await flush();
    const written = sent.filter(s => s.text === ANSWER_SQL).map(s => JSON.parse(s.values[2]));
    expect(written).toHaveLength(2);
    expect(written[1]).toMatchObject({ success: false, ran: true, truth: 'deposed', error });
    const answer = remotePanelAnswer('panel:button', reply(written[1]), 'owner', NAME);
    expect(answer.reply.error).toBe(`On BRAVO: the action ran, but another bot process took over this server's data, so its changes were not saved. Check the server before you run it again.`);
    expect(answer.reply.error).not.toMatch(/refused/);
  });

  it('a module throw claimed again keeps the thrown text', async () => {
    const hooks = hooksWith({ answerPanel: async () => { throw new Error('Cannot read properties of undefined'); } });
    const r = row();
    let pass = 0;
    const { sweep, sent } = sweepOf(s => (s.text === REQUEST_CLAIM_SQL ? (++pass <= 2 ? { rows: [r] } : { rows: [] }) : undefined), hooks);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await sweep.pass();
    await flush();
    await sweep.pass();
    await flush();
    const written = sent.filter(s => s.text === ANSWER_SQL).map(s => JSON.parse(s.values[2]));
    expect(written[1]).toMatchObject({ success: false, error: 'Cannot read properties of undefined' });
    expect(remotePanelAnswer('panel:button', reply(written[1]), 'owner', NAME).reply.error).toBe('On BRAVO: Cannot read properties of undefined');
  });

  it('the notes of a kept answer say it was not kept, and a pending one says not confirmed as saved', () => {
    const panel = remotePanelAnswer('panel:button', reply({ success: true, oversize: { bytes: 0, reason: 'not-kept' } }), 'owner', NAME);
    expect(panel.status).toBe(200);
    expect(panel.reply.note).toBe('On BRAVO: the panel action ran and its changes were saved; BRAVO took the request again after a database failover and did not run it twice, so the panel the first run returned is not kept to show here. Open the panel from the web panel on BRAVO.');
    const pending = remotePanelAnswer('panel:button', reply({ success: true, pending: true, oversize: { bytes: 300 * 1024, reason: 'too-large' } }), 'owner', NAME);
    expect(pending.reply.note).toBe('On BRAVO: the panel action ran, and its changes are not confirmed as saved yet; the panel it returned is 300 KiB, too large to show here. Open the panel from the web panel on BRAVO.');
    const command = remotePanelAnswer('command:invoke', reply({ success: true, ran: true, capturedOmitted: { count: 2, bytes: 0, reason: 'not-kept' } }), 'owner', NAME);
    expect(command.reply.note).toBe('On BRAVO: BRAVO took the command again after a database failover and did not run it twice; the command\'s 2 captured replies from the first run are not kept and are left out.');
  });

  it('a failure with no text is worded by what its fields prove', () => {
    expect(remotePanelAnswer('panel:button', reply({ success: false, ran: true }), 'owner', NAME).reply.error).toBe('On BRAVO: the action ran, but the bot gave no reason for its failure. Check the server before you run it again.');
    expect(remotePanelAnswer('panel:button', reply({ success: false }), 'owner', NAME).reply.error).toBe("On BRAVO: the bot answered that the panel action failed and gave no reason; can't confirm whether it ran. Check the server before you run it again.");
    expect(remotePanelAnswer('panel:button', reply({ success: false, ran: false }), 'member', NAME).reply.error).toBe('The bot refused the request; nothing was run.');
  });
});

describe('T5: the owner prefix keeps the case of a text the sheet does not word', () => {
  it("'Rate limit' stays capitalised; the holder's refusals and ranTruthText start lower case", () => {
    const limited = remotePanelAnswer('panel:button', reply({ success: false, ran: false, error: 'Rate limit exceeded. Please wait before trying again.' }), 'owner', NAME);
    expect(limited.reply.error).toBe('On BRAVO: Rate limit exceeded. Please wait before trying again.');
    expect(limited.reply.error).toContain('Rate limit');
    expect(remotePanelAnswer('panel:button', reply({ success: false, ran: false, code: 'invalid', error: 'The request for this server was malformed (x); nothing was run.' }), 'owner', NAME).reply.error)
      .toBe('On BRAVO: the request for this server was malformed (x); nothing was run.');
  });
});

describe('L3: the exit log words', () => {
  it.each([
    [{ success: true }, 'panel:button', 'ran'],
    [{ success: true, pending: true }, 'panel:button', 'ran, writes not confirmed as saved yet'],
    [{ success: false, ran: true, truth: 'pending', pending: true }, 'panel:button', 'ran, writes not confirmed as saved yet'],
    [{ success: false, ran: true, truth: 'held', pending: true }, 'panel:button', 'ran, writes not confirmed as saved yet'],
    [{ success: false, ran: true, truth: 'unavailable' }, 'panel:button', "ran; can't confirm whether its writes were saved"],
    [{ success: false, ran: true, truth: 'deposed' }, 'panel:button', 'ran, and its writes were not saved'],
    [{ success: false, ran: true, error: 'boom' }, 'command:invoke', 'ran and failed: boom'],
    [{ success: false, ran: false, code: 'not-allowed' }, 'panel:button', 'a refusal with code not-allowed'],
    [{ success: false, ran: false }, 'panel:button', 'a refusal with code none'],
    [{ success: false, error: 'boom' }, 'panel:button', "failed (boom); can't confirm whether it ran"],
    [{ success: true }, 'guild:channels', 'read'],
    [{ success: false, error: 'boom' }, 'guild:channels', 'failed: boom'],
  ] as const)('%j on %s logs "%s"', (r, op, words) => {
    expect(panelExitWords(r, op)).toBe(words);
  });
});

describe('L4: a read group whose attempt may have landed', () => {
  it("logs can't confirm, not 'Could not record', when the read-back also fails", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let attempt = 0;
    const { sweep } = sweepOf(s => {
      if (s.text === REQUEST_CLAIM_SQL) return attempt === 0 ? (attempt = 1, { rows: [row({ op: 'guild:channels', body: JSON.stringify({ actor: OWNER }) })] }) : { rows: [] };
      if (s.text === READ_ANSWERS_SQL) return ++attempt === 2 ? new Error('Query read timeout') : { rows: [], rowCount: 0 };
      if (s.text === READ_ANSWERS_READ_BACK_SQL) return new Error('Connection terminated unexpectedly');
      return undefined;
    }, hooksWith());
    await sweep.pass();
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    const lines = error.mock.calls.map(c => String(c[0]));
    expect(lines).toContain("[GuildRequests] Can't confirm whether the answers to 1 reads sent from other machines were recorded: an attempt that got no answer may have landed, and the read-back failed (Connection terminated unexpectedly); their senders read those answers or can't confirm");
    expect(lines.some(l => l.startsWith('[GuildRequests] Could not record'))).toBe(false);
  });

  it("keeps 'Could not record' when every attempt was refused", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let claimed = false;
    const { sweep } = sweepOf(s => {
      if (s.text === REQUEST_CLAIM_SQL) return claimed ? { rows: [] } : (claimed = true, { rows: [row({ op: 'guild:channels', body: JSON.stringify({ actor: OWNER }) })] });
      if (s.text === READ_ANSWERS_SQL || s.text === READ_ANSWERS_READ_BACK_SQL) return Object.assign(new Error('permission denied'), { code: '42501' });
      return undefined;
    }, hooksWith());
    await sweep.pass();
    await flush();
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(1000);
    await flush();
    const lines = error.mock.calls.map(c => String(c[0]));
    expect(lines.some(l => l.startsWith('[GuildRequests] Could not record the answers to 1 reads'))).toBe(true);
    expect(lines.some(l => l.includes("Can't confirm"))).toBe(false);
  });
});

describe('LIVE-B: the holder answers its kept state by the version the asking web panel has', () => {
  it('the kept state while its version is above haveVersion under the same since; data null with the version otherwise', () => {
    const since = registerInterest(G, 'p')!;
    expect(liveAnswer(G, 'p', since)).toEqual({ success: true, data: null, since, version: 0, notifying: null });
    noteLiveChange(G, 'p', { v: 1 });
    expect(liveAnswer(G, 'p', since)).toMatchObject({ data: { v: 1 }, since, version: 1 });
    expect(liveAnswer(G, 'p', since, 0, since)).toMatchObject({ data: { v: 1 }, version: 1 });
    expect(liveAnswer(G, 'p', since, 1, since)).toEqual({ success: true, data: null, since, version: 1, notifying: null });
    expect(liveAnswer(G, 'p', since, 1, since)).toMatchObject({ data: null, version: 1 });
    // A version of another interest is no version of this one.
    expect(liveAnswer(G, 'p', since, 1, since - 1)).toMatchObject({ data: { v: 1 }, version: 1 });
    noteLiveChange(G, 'p', { v: 2 });
    expect(liveAnswer(G, 'p', since, 1, since)).toMatchObject({ data: { v: 2 }, version: 2 });
  });

  it("R4 ruling (a): an owner action's view becomes the kept state under a new version, which its answer carries", async () => {
    const since = registerInterest(G, 'p')!;
    noteLiveChange(G, 'p', { page: 1 });
    const hooks = hooksWith({
      registerInterest: (g, p) => registerInterest(g, p),
      answerPanel: async () => { noteLiveChange(G, 'p', { page: 2 }); return { success: true, data: { content: 'View' } }; },
    });
    let pass = 0;
    const { sweep, sent } = sweepOf(s => (s.text === REQUEST_CLAIM_SQL ? (++pass === 1 ? { rows: [row()] } : { rows: [] }) : undefined), hooks);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await sweep.pass();
    await flush();
    const written = JSON.parse(sent.find(s => s.text === ANSWER_SQL)!.values[2]);
    expect(written).toMatchObject({ success: true, data: { content: 'View' }, liveSince: since, liveVersion: 3 });
    expect(liveVersionOf(G, 'p')).toBe(3);
    expect(liveAnswer(G, 'p', since, 3, since)).toEqual({ success: true, data: null, since, version: 3, notifying: null });
    expect(liveAnswer(G, 'p', since, 2, since), 'a page with the change before the action gets its view').toMatchObject({ data: { content: 'View' }, version: 3 });
    expect(liveAnswer(G, 'p', since, 0, null), "a new pair's first fetch gets the action's view").toMatchObject({ data: { content: 'View' }, version: 3 });
  });

  it.each([
    ['a modal over the panel', { success: true, data: { modal: { id: 'm' } } }],
    ['the return to the panel list', { success: true, data: { returnToPanelList: true } }],
    ['a refusal', { success: false, ran: false, error: 'no' }],
  ])("R4 ruling (a): %s keeps the kept state and its version; the answer carries liveVersion 0", async (_what, answer) => {
    const since = registerInterest(G, 'p')!;
    noteLiveChange(G, 'p', { page: 1 });
    const hooks = hooksWith({ registerInterest: (g, p) => registerInterest(g, p), answerPanel: async () => answer });
    let pass = 0;
    const { sweep, sent } = sweepOf(s => (s.text === REQUEST_CLAIM_SQL ? (++pass === 1 ? { rows: [row()] } : { rows: [] }) : undefined), hooks);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await sweep.pass();
    await flush();
    expect(JSON.parse(sent.find(s => s.text === ANSWER_SQL)!.values[2])).toMatchObject({ liveSince: since, liveVersion: 0 });
    expect(liveVersionOf(G, 'p')).toBe(1);
    expect(liveAnswer(G, 'p', since, 0, since)).toMatchObject({ data: { page: 1 }, version: 1 });
  });

  it.each([
    ['panel:button', { buttonId: 'b' }, 2],
    ['panel:dropdown', { dropdownId: 'd', values: ['x'] }, 2],
    ['panel:modal', { modalId: 'm', fields: {} }, 2],
    ['panel:execute', {}, 1],
  ] as const)("R5: %s; only a button, a select menu and a modal submit keep their view as the pair's state", async (op, extra, version) => {
    const since = registerInterest(G, 'p')!;
    noteLiveChange(G, 'p', { page: 1 });
    const hooks = hooksWith({
      registerInterest: (g, p) => registerInterest(g, p),
      answerPanel: async () => { if (op === 'panel:execute') noteLiveChange(G, 'p', { page: 2 }); return { success: true, data: { content: 'View' } }; },
    });
    const body = JSON.stringify({ panelId: 'p', userId: 'web-ui-owner', actor: OWNER, ...extra });
    let pass = 0;
    const { sweep, sent } = sweepOf(s => (s.text === REQUEST_CLAIM_SQL ? (++pass === 1 ? { rows: [row({ op, body })] } : { rows: [] }) : undefined), hooks);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await sweep.pass();
    await flush();
    expect(JSON.parse(sent.find(s => s.text === ANSWER_SQL)!.values[2])).toMatchObject({ success: true, liveSince: since, liveVersion: version });
    if (op === 'panel:execute') {
      expect(liveAnswer(G, 'p', since, 1, since), 'the kept state is not the opened view').toMatchObject({ data: { page: 2 }, version: 2 });
    } else {
      expect(liveAnswer(G, 'p', since, 1, since)).toMatchObject({ data: { content: 'View' }, version: 2 });
    }
  });

  it('R4 ruling (d): the kept answer of an action keeps liveSince and liveVersion', () => {
    expect(keptAnswer({ success: true, data: { content: 'View' }, liveSince: 7, liveVersion: 3 })).toEqual({
      success: true, oversize: { bytes: 0, reason: 'not-kept' }, liveSince: 7, liveVersion: 3,
    });
    expect(keptAnswer({ success: true, data: { content: 'View' }, liveSince: null, liveVersion: 0 })).toMatchObject({ liveSince: null, liveVersion: 0 });
    expect(keptAnswer({ success: true, data: { content: 'View' } })).not.toHaveProperty('liveSince');
  });

  it("the sweep hands a 'panel:live' row's haveVersion and haveSince to the panel and no asker; a bad version is refused", async () => {
    const hooks = hooksWith();
    let pass = 0;
    const live = (body: Record<string, unknown>) => row({ op: 'panel:live', body: JSON.stringify({ panelId: 'p', actor: OWNER, ...body }) });
    const bad = live({ haveVersion: -1 });
    const rows = [live({ haveVersion: 3, haveSince: 7 }), bad];
    const { sweep, sent } = sweepOf(s => (s.text === REQUEST_CLAIM_SQL ? (++pass === 1 ? { rows } : { rows: [] }) : undefined), hooks);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await sweep.pass();
    await flush();
    expect(hooks.bodies).toHaveLength(1);
    expect(hooks.bodies[0]).toMatchObject({ haveVersion: 3, haveSince: 7 });
    expect(hooks.bodies[0]).not.toHaveProperty('liveFor');
    const group = sent.find(s => s.text === READ_ANSWERS_SQL)!;
    const answer = JSON.parse(group.values[1][group.values[0].indexOf(bad.id)]);
    expect(answer).toMatchObject({ success: false, ran: false, code: 'invalid' });
  });
});

describe('TEXT-C: announcing is proved to work again with no pair marked', () => {
  it('a failed notify, the interest lapsing, a new interest: the next tick probes and answers notifying true', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let fail = true;
    const notify = vi.fn(async (_payloads: string[]) => { if (fail) throw new Error('Connection terminated unexpectedly'); });
    _setNotifyDb({ notify }, () => false);
    registerInterest(G, 'p');
    noteLiveChange(G, 'p', { v: 1 });
    await notifyTick();
    vi.advanceTimersByTime(90_001);
    fail = false;
    const since = registerInterest(G, 'q');
    expect(liveAnswer(G, 'q', since).notifying).toBe(false);
    await notifyTick();
    expect(notify.mock.calls.at(-1)![0]).toEqual([]);
    expect(liveAnswer(G, 'q', since).notifying).toBe(true);
  });
});

class FakeListen extends EventEmitter {
  queries: string[] = [];
  ended = false;
  readonly connection = { stream: { remoteAddress: '127.0.0.1', destroy: vi.fn() } };
  constructor(readonly config: any) { super(); }
  connect() { return Promise.resolve(); }
  query(text: string) { this.queries.push(text); return Promise.resolve({ rows: [] }); }
  end() { this.ended = true; return Promise.resolve(); }
}

describe('the web UI watch', () => {
  let clients: FakeListen[];
  let fetches: Array<{ p: string; done: (a: FetchAnswer) => void }>;
  let statuses: any[];

  function watcher(): PanelLiveWatch {
    clients = [];
    fetches = [];
    statuses = [];
    const deps: WatchDeps = {
      fetch: (_g, p) => new Promise(done => { fetches.push({ p, done }); }),
      emitUpdate: () => undefined,
      emitStatus: data => statuses.push({ live: data.live, reason: data.reason }),
      entry: () => ({ entry: 'postgres://bot@localhost/bot' }),
      makeClient: config => { const c = new FakeListen(config); clients.push(c); return c as any; },
    };
    return new PanelLiveWatch(deps);
  }
  const ok = (): FetchAnswer => ({ status: null, holderProcess: 'p-b', reply: { success: true, data: null, since: 5, notifying: true, servedBy: NAME } });
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const answerAll = async () => { while (fetches.length) fetches.shift()!.done(ok()); await settle(); };

  it('L5, TEXT-B: connecting until the listener listens and a fetch answered; a reconnect is connecting until its fetch', async () => {
    const w = watcher();
    w.noteAnswer(G, 'p', 'p-b', 5);
    expect(w.watch(G, 'p', 'web-ui-owner', NAME)).toEqual({ live: false, reason: LIVE_REASONS.connecting });
    await settle();
    expect(statuses.at(-1)).toEqual({ live: false, reason: LIVE_REASONS.connecting });
    await answerAll();
    await answerAll();
    expect(statuses.at(-1)).toEqual({ live: true, reason: null });
    clients[0].emit('error', new Error('Connection terminated unexpectedly'));
    expect(statuses.at(-1)).toEqual({ live: false, reason: LIVE_REASONS.unreachable });
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.listenerUp()).toBe(true);
    expect(statuses.at(-1)).toEqual({ live: false, reason: LIVE_REASONS.connecting });
    await answerAll();
    expect(statuses.at(-1)).toEqual({ live: true, reason: null });
  });

  it('RUN-A: a watch ends 90 s after its last call with no other call; its notification starts no fetch; the listener closes 60 s later', async () => {
    const w = watcher();
    w.noteAnswer(G, 'p', 'p-b', 5);
    w.watch(G, 'p', 'web-ui-owner', NAME);
    await settle();
    await answerAll();
    await answerAll();
    await vi.advanceTimersByTimeAsync(90_001);
    clients[0].emit('notification', { channel: 'smdb_panel_changed', payload: JSON.stringify({ g: G, p: 'p' }) });
    expect(fetches).toHaveLength(0);
    expect(w.listenerUp()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(w.listenerUp()).toBe(false);
    expect(clients[0].ended).toBe(true);
    expect(w.count()).toBe(0);
  });

});

describe('LIVE-C: the fetch queue', () => {
  it('starts r once q ended, and never fetches q', async () => {
    const asked: string[] = [];
    const pending: Array<(a: FetchAnswer) => void> = [];
    const w = new PanelLiveWatch({
      fetch: (_g, p) => { asked.push(p); return new Promise(done => { pending.push(done); }); },
      emitUpdate: () => undefined,
      emitStatus: () => undefined,
      entry: () => ({ entry: 'postgres://bot@localhost/bot' }),
      makeClient: config => new FakeListen(config) as any,
    });
    for (let i = 0; i < 4; i++) w.watch(G, `p${i}`, 'web-ui-owner', NAME);
    w.watch(G, 'q', 'web-ui-owner', NAME);
    await vi.advanceTimersByTimeAsync(10_000);
    w.watch(G, 'r', 'web-ui-owner', NAME);
    await vi.advanceTimersByTimeAsync(80_001);
    const ok: FetchAnswer = { status: null, reply: { success: true, data: null, since: 5, notifying: true } };
    while (pending.length) { pending.shift()!(ok); await vi.advanceTimersByTimeAsync(0); }
    expect(asked).toContain('r');
    expect(asked).not.toContain('q');
    w.stop();
  });
});

describe('TEXT-A: a bot process with no web UI parent', () => {
  it('answers member rows member-panel-off, never not-ready', () => {
    _resetPanelHandler();
    const before = process.send;
    (process as any).send = undefined;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      setupPanelIPCHandlers();
    } finally {
      (process as any).send = before;
    }
    expect(guildWebUiEnabled()).toBe(false);
    _resetPanelHandler();
  });
});

describe('L6: an empty host is classed by the host node-postgres uses', () => {
  it('PGHOST of another machine is unprotected without ssl; no PGHOST is localhost', () => {
    const before = process.env.PGHOST;
    try {
      process.env.PGHOST = 'db.example.net';
      expect(transportOf({ host: '' } as any, null)).toBe('unprotected');
      expect(transportOf({ host: '', ssl: { rejectUnauthorized: true } } as any, null)).toBe('verified');
      delete process.env.PGHOST;
      expect(transportOf({ host: '' } as any, null)).toBe('local');
    } finally {
      if (before === undefined) delete process.env.PGHOST;
      else process.env.PGHOST = before;
    }
  });
});

describe('L7: the exit read of a followed request', () => {
  it('reads the row with the carries check', () => {
    const src = readSourceText(__dirname, '../../src/webui/utils/guildRequests.ts');
    expect(src).toContain('statement(req.db, REQUEST_POLL_SQL, [req.id], Math.max(1, end - performance.now()), true)');
    expect(src).not.toMatch(/statement\(req\.db, REQUEST_POLL_SQL, \[req\.id\], Math\.max\(1, end - performance\.now\(\)\)\)/);
  });
});

describe('LIST-A: a member answer is deleted when its keep ends', () => {
  afterEach(() => _resetMemberLists());

  it('after the 5 s keep of an answer with a notice, a busy call gets the busy notice, not the deleted answer', async () => {
    _resetMemberLists();
    const deps = (local: () => Promise<any>): MemberListDeps => ({
      localGuilds: local,
      holderMap: async () => ({ rows: [] }),
      currentUrl: () => null,
      nodeId: () => null,
      membership: async () => ({ k: 'no-answer', cause: 'timeout' }),
    });
    const first = await memberServerList('m1', ['1'], deps(async () => ({ success: true, guilds: [{ id: '1' }], incomplete: true })));
    expect(first.notice).toBe(MEMBER_NOTICES.connecting);
    await vi.advanceTimersByTimeAsync(5001);
    const hang = () => new Promise<any>(() => undefined);
    void memberServerList('m2', ['2'], deps(hang));
    void memberServerList('m3', ['3'], deps(hang));
    const again = await memberServerList('m1', ['1'], deps(async () => ({ success: true, guilds: [{ id: '1' }] })));
    expect(again.notice).toBe(MEMBER_NOTICES.busy);
  });
});
